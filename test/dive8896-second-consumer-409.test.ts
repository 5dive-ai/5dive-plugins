// DIVE-8896: an agy seat (fresh-boar, report 1250) missed five owner messages in
// a row while its bridge "ran". The likely cause is a SECOND getUpdates consumer
// on the token: Telegram answers the older poll with 409 and hands the updates
// to the other one. The DIVE-7460 handoff only covers a sibling under the SAME
// session parent; this rival shares nothing with the bridge.
//
// Live: one real telegram-agy server.ts (stdin held open, like the TUI) against
// a stand-in Bot API with Telegram's conflict rule, plus a rival poller that is
// NOT a child of the bridge's parent (this test process, like a stray
// `telegram-discover` or another box's bridge). While the rival polls, the
// bridge must log the 409 in plain words and write bot.conflict. When the rival
// stops, the bridge must say how long it was deaf, drop bot.conflict, and hand
// the agent the message that arrived during the conflict (the rival never
// confirmed it, so it must not be lost).
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = join(import.meta.dir, '..', 'plugins', 'telegram-agy')

type Update = { update_id: number; message: any }
// Telegram's rule: one getUpdates at a time per token. A new poll ends the one
// already waiting with 409 "terminated by other getUpdates request".
function fakeBotApi() {
  const updates: Update[] = []
  let nextId = 1
  let confirmed = 0
  let waiting: ((conflict: boolean) => void) | null = null
  const wakers = new Set<() => void>()
  let conflicts = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      let body: any = {}
      try { body = await req.json() } catch {}
      const ok = (result: unknown) => Response.json({ ok: true, result })
      if (method === 'getMe') return ok({ id: 9, is_bot: true, first_name: 'fake', username: 'fake_8896_bot' })
      if (method === 'getUpdates') {
        if (waiting) { conflicts++; waiting(true) }
        const offset = Number(body.offset ?? 0)
        confirmed = Math.max(confirmed, offset)
        const ready = () => updates.filter(u => u.update_id >= Math.max(offset, confirmed))
        const timeoutMs = Math.min(3, Number(body.timeout ?? 0)) * 1000
        let lost = false
        if (ready().length === 0 && timeoutMs > 0) {
          lost = await new Promise<boolean>(res => {
            const done = (conflict: boolean) => { if (waiting === done) waiting = null; wakers.delete(wake); clearTimeout(t); res(conflict) }
            const wake = () => done(false)
            const t = setTimeout(wake, timeoutMs)
            waiting = done
            wakers.add(wake)
            req.signal.addEventListener('abort', wake)
          })
        }
        if (lost) return Response.json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }, { status: 409 })
        return ok(ready().slice(0, Number(body.limit ?? 100)))
      }
      if (method === 'sendMessage') return ok({ message_id: 1, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text })
      return ok(true)
    },
  })
  return {
    root: `http://127.0.0.1:${server.port}`,
    push(text: string) {
      const update_id = nextId++
      updates.push({ update_id, message: {
        message_id: 100 + update_id, date: Math.floor(Date.now() / 1000), text,
        chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Owner', username: 'owner' },
      } })
      for (const w of [...wakers]) w()
      return update_id
    },
    consumed: (id: number) => confirmed > id,
    conflicts: () => conflicts,
    stop: () => server.stop(true),
  }
}

// A getUpdates consumer outside the bridge's session: it polls back to back and
// never passes an offset, so it confirms nothing (a discover-style peek).
function rivalPoller(root: string) {
  let running = true
  const loop = (async () => {
    while (running) {
      try {
        await fetch(`${root}/bot8896:fake/getUpdates`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 3 }),
        })
      } catch {}
    }
  })()
  return { stop: async () => { running = false; await loop } }
}

class McpServer {
  proc: ReturnType<typeof Bun.spawn>
  private buf = ''
  private nextId = 1
  private pending = new Map<number, (r: any) => void>()
  stderr = ''
  constructor(dir: string, env: Record<string, string>) {
    this.proc = Bun.spawn([process.execPath, join(dir, 'server.ts')], {
      cwd: dir, env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, chunk => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1)
        try { const m = JSON.parse(line); if (m.id != null) this.pending.get(m.id)?.(m) } catch {}
      }
    })
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, c => { this.stderr += c })
  }
  private async pump(s: ReadableStream<Uint8Array>, on: (c: string) => void) {
    const dec = new TextDecoder()
    for await (const c of s) on(dec.decode(c))
  }
  private send(msg: object) { (this.proc.stdin as any).write(JSON.stringify(msg) + '\n'); (this.proc.stdin as any).flush?.() }
  request(method: string, params: object, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out\n${this.stderr}`)), timeoutMs)
      this.pending.set(id, m => { clearTimeout(t); res(m) })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dive8896', version: '0' } })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  async waitForMessage(seconds: number): Promise<string> {
    const r = await this.request('tools/call', { name: 'wait_for_message', arguments: { timeout_seconds: seconds } }, (seconds + 10) * 1000)
    return (r.result?.content ?? []).map((c: any) => c.text).join('\n')
  }
  get pid() { return this.proc.pid }
}

async function until(what: string, cond: () => boolean, ms: number, why = () => ''): Promise<number> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for: ${what}\n${why()}`)
    await Bun.sleep(100)
  }
  return Date.now() - t0
}

// CI has no plugin deps installed: stage a copy and install it (as DIVE-7460 does).
function stagePlugin(root: string): string | null {
  const dir = join(root, 'plugin')
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(PLUGIN)) {
    if (f.endsWith('.ts') || f === 'package.json' || f === 'bun.lock') cpSync(join(PLUGIN, f), join(dir, f))
  }
  const local = process.env.DIVE8896_NODE_MODULES ?? join(PLUGIN, 'node_modules')
  if (existsSync(join(local, 'grammy'))) {
    Bun.spawnSync(['ln', '-s', local, join(dir, 'node_modules')])
    return dir
  }
  const r = Bun.spawnSync([process.execPath, 'install', '--production'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 && existsSync(join(dir, 'node_modules', 'grammy')) ? dir : null
}

describe('a second getUpdates consumer outside the session (live)', () => {
  let root = ''
  let dir: string | null = null
  let api: ReturnType<typeof fakeBotApi>
  let state = ''
  let bridge: McpServer | null = null

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dive8896-live-'))
    dir = stagePlugin(root)
    api = fakeBotApi()
    state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: ['42'], groups: {}, pending: {} }))
  }, 120_000)
  afterAll(() => {
    try { bridge?.proc.kill('SIGKILL') } catch {}
    api?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('the 409 is logged and recorded while the rival polls; nothing it left unconfirmed is lost', async () => {
    expect(dir).not.toBeNull() // a runner that cannot fetch the deps must not read as a pass
    bridge = new McpServer(dir!, {
      TELEGRAM_BOT_TOKEN: '8896:fake', TELEGRAM_API_ROOT: api.root, TELEGRAM_STATE_DIR: state,
      ANTIGRAVITY_HOME: join(root, 'agy-home'), TELEGRAM_REARM_DISABLED: '1', TELEGRAM_STALL_ALERT_DISABLED: '1',
    })
    const b = bridge
    await b.init()
    const conflictFile = join(state, 'bot.conflict')

    // Healthy first: the bridge polls and delivers.
    const first = b.waitForMessage(30)
    api.push('before')
    expect(await first).toContain('before')

    // The rival starts. The bridge must say so, not go quietly deaf.
    const rival = rivalPoller(api.root)
    await until('bridge logs the 409 in plain words',
      () => b.stderr.includes('409 Conflict, another process is polling this bot token'), 20_000, () => b.stderr)
    expect(b.stderr).toMatch(/getUpdates 409: (other local pollers on this box|no other poller on this box)/)
    expect(existsSync(conflictFile)).toBe(true)
    const rec = JSON.parse(readFileSync(conflictFile, 'utf8'))
    expect(rec.since).toBeGreaterThan(0)
    expect(rec.count).toBeGreaterThanOrEqual(1)

    // An owner message lands mid-conflict.
    const during = api.push('during the conflict')
    await Bun.sleep(4_000)
    await rival.stop()
    expect(api.conflicts()).toBeGreaterThan(0)

    // Rival gone: the bridge recovers, says how long it was deaf, drops the file,
    // and the agent gets the message the rival never confirmed.
    const got = await b.waitForMessage(30)
    expect(got).toContain('during the conflict')
    expect(api.consumed(during)).toBe(true)
    await until('bridge logs the 409 cleared', () => /getUpdates 409 cleared: this bridge could not receive messages for \d+s/.test(b.stderr), 20_000, () => b.stderr)
    await until('bot.conflict removed', () => !existsSync(conflictFile), 10_000)

    // And it keeps polling.
    const next = b.waitForMessage(30)
    api.push('after')
    expect(await next).toContain('after')
  }, 120_000)
})
