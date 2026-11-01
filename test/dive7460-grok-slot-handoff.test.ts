// DIVE-7460: a Grok TUI re-spawned its Telegram MCP server without closing the
// old one. The old server kept the getUpdates slot (fresh heartbeat, parent
// alive, stdin never EOF), the new one parked in acquireSlot() forever, and the
// TUI's wait_for_message went to the new one: the seat was deaf with every
// process "running" (chill-gorge, seat dude, 2026-11-01).
//
// Two layers:
//   1. slot-handoff.ts decisions, pure (no deps).
//   2. The incident, live: two REAL server.ts under ONE parent, both stdins held
//      open, against a stand-in Bot API. The second must own bot.pid within
//      ~10s of its first tool call and hand the agent the message the first one
//      had queued; the first must stay alive (killing it makes the TUI re-spawn
//      it) and take the slot back when the second dies.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseProcStat, sessionParent, siblingYounger, type ProcStat,
  writeHandoffRequest, readHandoffRequest, HANDOFF_REQUEST_TTL_MS,
  writeHandoffQueue, takeHandoffQueue,
} from '../plugins/telegram-grok/slot-handoff.ts'

const PLUGIN = join(import.meta.dir, '..', 'plugins', 'telegram-grok')

// ── 1. pure decisions ──────────────────────────────────────────────────────

describe('slot-handoff decisions', () => {
  test('parses /proc/<pid>/stat, comm with spaces and parens', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i))
    fields[0] = 'S'; fields[1] = '77'; fields[19] = '123456'
    const st = parseProcStat(`4242 (bun (x) y) ${fields.join(' ')}`)
    expect(st).toEqual({ pid: 4242, comm: 'bun (x) y', ppid: 77, startTicks: 123456 })
    expect(parseProcStat('garbage')).toBeNull()
  })

  test('the real /proc line of this process parses to our own ppid', () => {
    if (!existsSync('/proc/self/stat')) return
    const st = parseProcStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
    expect(st?.pid).toBe(process.pid)
    expect(st?.ppid).toBe(process.ppid)
  })

  // A fake process table: tui(100) → bun-run(200) → server(300); tui(100) → server(301);
  // other-tui(500) → server(501).
  const table: Record<number, ProcStat> = {
    100: { pid: 100, comm: 'grok', ppid: 1, startTicks: 10 },
    200: { pid: 200, comm: 'bun', ppid: 100, startTicks: 20 },
    300: { pid: 300, comm: 'bun', ppid: 200, startTicks: 21 },
    301: { pid: 301, comm: 'bun', ppid: 100, startTicks: 90 },
    500: { pid: 500, comm: 'grok', ppid: 1, startTicks: 30 },
    501: { pid: 501, comm: 'bun', ppid: 500, startTicks: 95 },
  }
  const read = (pid: number) => table[pid] ?? null

  test('a bun run wrapper is looked through to the TUI', () => {
    expect(sessionParent(300, read)).toBe(100)
    expect(sessionParent(301, read)).toBe(100)
    expect(sessionParent(501, read)).toBe(500)
    expect(sessionParent(999, read)).toBe(0)
  })

  test('only a YOUNGER server of the SAME session may take the slot', () => {
    expect(siblingYounger(301, 300, read)).toBe(true)    // the incident
    expect(siblingYounger(300, 301, read)).toBe(false)   // one-way: no ping-pong
    expect(siblingYounger(501, 300, read)).toBe(false)   // another session (`grok mcp list`): DIVE-818 holds
    expect(siblingYounger(301, 301, read)).toBe(false)
    expect(siblingYounger(301, 999, read)).toBe(false)   // unknown incumbent: fail closed
  })

  test('a request ages out; the queue appends and is taken once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive7460-'))
    writeHandoffRequest(dir, 4242, 1_000)
    expect(readHandoffRequest(dir, 1_000 + 5)).toEqual({ pid: 4242, at: 1_000 })
    expect(readHandoffRequest(dir, 1_000 + HANDOFF_REQUEST_TTL_MS + 1)).toBeNull()
    writeHandoffQueue(dir, [{ text: 'a' }])
    writeHandoffQueue(dir, [{ text: 'b' }])
    expect(takeHandoffQueue<{ text: string }>(dir).map(m => m.text)).toEqual(['a', 'b'])
    expect(takeHandoffQueue(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── 2. the incident, live ───────────────────────────────────────────────────

// A stand-in Bot API: enough of getMe/getUpdates for grammy, ok:true for the rest.
type Update = { update_id: number; message: any }
function fakeBotApi() {
  const updates: Update[] = []
  let nextId = 1
  let confirmed = 0   // highest offset any getUpdates has asked for
  const waiting = new Set<() => void>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      let body: any = {}
      try { body = await req.json() } catch {}
      const ok = (result: unknown) => Response.json({ ok: true, result })
      if (method === 'getMe') return ok({ id: 9, is_bot: true, first_name: 'fake', username: 'fake_7460_bot' })
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0)
        confirmed = Math.max(confirmed, offset)
        // Like Telegram: an offset confirms every update below it, for every client.
        const ready = () => updates.filter(u => u.update_id >= Math.max(offset, confirmed))
        const timeoutMs = Math.min(5, Number(body.timeout ?? 0)) * 1000
        if (ready().length === 0 && timeoutMs > 0) {
          await new Promise<void>(res => {
            const wake = () => { waiting.delete(wake); clearTimeout(t); res() }
            const t = setTimeout(wake, timeoutMs)
            waiting.add(wake)
            req.signal.addEventListener('abort', wake)
          })
        }
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
      for (const w of [...waiting]) w()
      return update_id
    },
    consumed: (id: number) => confirmed > id,
    stop: () => server.stop(true),
  }
}

// One server.ts with its stdin held open by us — exactly the TUI's grip.
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
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dive7460', version: '0' } })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  async waitForMessage(seconds: number): Promise<string> {
    const r = await this.request('tools/call', { name: 'wait_for_message', arguments: { timeout_seconds: seconds } }, (seconds + 10) * 1000)
    return (r.result?.content ?? []).map((c: any) => c.text).join('\n')
  }
  get pid() { return this.proc.pid }
  alive() { try { process.kill(this.pid, 0); return true } catch { return false } }
}

async function until(what: string, cond: () => boolean, ms: number): Promise<number> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for: ${what}`)
    await Bun.sleep(100)
  }
  return Date.now() - t0
}

// The plugin's runtime deps. CI has none installed (DIVE-3752), so stage a copy
// and install it; a dev box with the plugin's node_modules already present reuses them.
function stagePlugin(root: string): string | null {
  const dir = join(root, 'plugin')
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(PLUGIN)) {
    if (f.endsWith('.ts') || f === 'package.json' || f === 'bun.lock') cpSync(join(PLUGIN, f), join(dir, f))
  }
  const local = process.env.DIVE7460_NODE_MODULES ?? join(PLUGIN, 'node_modules')
  if (existsSync(join(local, 'grammy'))) {
    Bun.spawnSync(['ln', '-s', local, join(dir, 'node_modules')])
    return dir
  }
  const r = Bun.spawnSync([process.execPath, 'install', '--production'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 && existsSync(join(dir, 'node_modules', 'grammy')) ? dir : null
}

describe('two server.ts under one parent (live)', () => {
  let root = ''
  let dir: string | null = null
  let api: ReturnType<typeof fakeBotApi>
  let env: Record<string, string>
  const servers: McpServer[] = []
  const pidFile = () => { try { return parseInt(readFileSync(join(env.TELEGRAM_STATE_DIR, 'bot.pid'), 'utf8'), 10) } catch { return 0 } }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dive7460-live-'))
    dir = stagePlugin(root)
    api = fakeBotApi()
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: ['42'], groups: {}, pending: {} }))
    env = {
      TELEGRAM_BOT_TOKEN: '7460:fake', TELEGRAM_API_ROOT: api.root, TELEGRAM_STATE_DIR: state,
      GROK_HOME: join(root, 'grok-home'), TELEGRAM_REARM_DISABLED: '1', TELEGRAM_STALL_ALERT_DISABLED: '1',
    }
  }, 120_000)
  afterAll(() => {
    for (const s of servers) try { s.proc.kill('SIGKILL') } catch {}
    api?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('the newer sibling takes the slot and the queued message', async () => {
    // A runner that cannot fetch the deps must not read as a pass.
    expect(dir).not.toBeNull()
    const first = new McpServer(dir!, env); servers.push(first)
    await first.init()
    await until('first server owns bot.pid', () => pidFile() === first.pid, 15_000)

    // The TUI re-spawns its server WITHOUT closing the first one's stdin.
    const second = new McpServer(dir!, env); servers.push(second)
    await second.init()

    // A message lands while the TUI is between calls: the first (slot holder) queues it.
    const id1 = api.push('so?')
    await until('first server polled the message', () => api.consumed(id1), 15_000)

    // DIVE-818 still holds: with no tool call the parked newcomer must not take
    // the slot (a transient enumeration spawn never makes one).
    await Bun.sleep(4_000)
    expect(pidFile()).toBe(first.pid)

    // The TUI talks to the NEW server. Within ~10s it owns the slot and hands
    // the agent the message the OLD one had queued.
    const t0 = Date.now()
    const got = second.waitForMessage(30)
    const took = await until('second server owns bot.pid', () => pidFile() === second.pid, 12_000)
    const text = await got
    expect(text).toContain('so?')
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(took).toBeLessThan(12_000)
    expect(first.alive()).toBe(true)   // stepped down, not killed
    expect(first.stderr).toContain('handing the poll slot to newer sibling')

    // The new slot holder really polls: the next message reaches it.
    const next = second.waitForMessage(30)
    api.push('second')
    expect(await next).toContain('second')

    // And the step-down is not a loss of redundancy: if the newer one dies, the
    // older one takes the slot back.
    second.proc.kill('SIGTERM')
    await until('first server reclaims bot.pid', () => pidFile() === first.pid, 20_000)
    expect(first.stderr).toContain('polling again')
  }, 120_000)
})
