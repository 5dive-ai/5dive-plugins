// DIVE-7559 — the plugins honour local-only mode.
//
// /etc/5dive/local-only (root 0644, EXISTS = ON) is the one switch every 5dive
// component reads (DIVE-7556; the CLI writes it, DIVE-7557). While it is on,
// nothing may leave the office network. Each arm below drives the SHIPPED code
// with the flag file pointed at a temp path (FIVE_LOCAL_ONLY_FILE, the CLI's own
// seam) and counts what actually went out, with a flag-absent control beside it
// so a green is not vacuous:
//
//   S  the start scripts skip `bun install` when the flag is on AND node_modules
//      is there (an offline box starts); every other case installs as before
//   H  every hook that called api.telegram.org or openrouter.ai sends nothing
//   D  the dashboard adapter reads its control-plane base from /etc/5dive/api-base
//
// Addresses: documentation ranges and .lan names only (fixture rule).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const P = (...p: string[]) => join(REPO, 'plugins', ...p)
const TMP = mkdtempSync(join(tmpdir(), 'dive7559-'))
const FLAG = join(TMP, 'local-only')
const NO_FLAG = join(TMP, 'no-such-flag')
writeFileSync(FLAG, '')

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

// ── S. the start scripts ────────────────────────────────────────────────────

const SHIPPED_START = 'test -f /etc/5dive/local-only -a -d node_modules || bun install --no-summary; bun start.ts'

// Run a start script under the launcher's own shell (`bun run --shell=bun`, as
// .mcp.json does) in a scratch plugin dir. The two COMMANDS are swapped for
// markers; the operators and the test are the shipped bytes. The flag path is
// swapped for a temp one (the bun shell has no ${VAR:-default}, so the shipped
// path is a literal).
function runStart(start: string, opts: { flag: boolean; nodeModules: boolean }): { installed: boolean; started: boolean } {
  const dir = mkdtempSync(join(TMP, 'start-'))
  if (opts.nodeModules) mkdirSync(join(dir, 'node_modules'))
  const script = start
    .replaceAll('/etc/5dive/local-only', opts.flag ? FLAG : NO_FLAG)
    .replace('bun install --no-summary', 'touch INSTALLED')
    .replace('bun start.ts', 'touch STARTED')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: script } }))
  const r = Bun.spawnSync(['bun', 'run', '--cwd', dir, '--shell=bun', '--silent', 'start'], { stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode).toBe(0)
  return { installed: existsSync(join(dir, 'INSTALLED')), started: existsSync(join(dir, 'STARTED')) }
}

// The CLI's install-time patch (5dive src/lib/agent_setup.sh, DIVE-3754): split
// on && || ;, drop every `bun install` segment, rejoin with "; ".
function cliStrip(start: string): string {
  const segs = start.split(/&&|\|\||;/).map(s => s.trim()).filter(Boolean)
  return segs.filter(s => !/^bun\s+install\b/.test(s)).join('; ')
}

describe('S: start skips the package download only when local-only is on and the deps are there', () => {
  for (const p of ['dashboard', 'telegram', 'buzz']) {
    const start = (JSON.parse(readFileSync(P(p, 'package.json'), 'utf8')) as { scripts: { start: string } }).scripts.start
    test(`${p}: ships the exact start script`, () => {
      expect(start).toBe(SHIPPED_START)
    })
    test(`${p}: local-only on + node_modules present → no install, server starts`, () => {
      expect(runStart(start, { flag: true, nodeModules: true })).toEqual({ installed: false, started: true })
    })
    test(`${p}: local-only on + no node_modules → installs (nothing to start without deps), then starts`, () => {
      expect(runStart(start, { flag: true, nodeModules: false })).toEqual({ installed: true, started: true })
    })
    test(`${p}: flag absent → installs as before, with or without node_modules (control)`, () => {
      expect(runStart(start, { flag: false, nodeModules: true })).toEqual({ installed: true, started: true })
      expect(runStart(start, { flag: false, nodeModules: false })).toEqual({ installed: true, started: true })
    })
    test(`${p}: the CLI's install-time strip still leaves a script that only starts`, () => {
      const stripped = cliStrip(start)
      expect(stripped).toBe('test -f /etc/5dive/local-only -a -d node_modules; bun start.ts')
      for (const flag of [true, false]) {
        expect(runStart(stripped, { flag, nodeModules: true })).toEqual({ installed: false, started: true })
      }
    })
  }
})

// ── H. hooks: nothing reaches Telegram or OpenRouter ────────────────────────

// Every outbound HTTPS call from a spawned hook goes through this "proxy"
// (HTTPS_PROXY): it records the CONNECT line and hangs up, so a call that would
// have left the box is counted and never completes.
let proxy: Server
let proxyPort = 0
const connects: string[] = []
beforeAll(async () => {
  proxy = createServer(s => {
    s.once('data', d => { connects.push(String(d).split('\r\n')[0] ?? ''); s.destroy() })
    s.on('error', () => {})
  })
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()))
  proxyPort = (proxy.address() as { port: number }).port
})
afterAll(() => { proxy?.close() })

async function runHook(file: string, env: Record<string, string>, stdin = ''): Promise<{ code: number; out: string; connects: string[] }> {
  const before = connects.length
  const proc = Bun.spawn(['bun', file], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: TMP, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, ...env },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  await Bun.sleep(50) // the proxy's 'data' callback may land a tick after the child exits
  return { code, out, connects: connects.slice(before) }
}

// A paired state dir the fork hooks read: token, one owner, and stamps that put
// each hook on its send path.
function forkState(): string {
  const dir = mkdtempSync(join(TMP, 'fork-'))
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:FAKE\n')
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['1234567890'] }))
  const now = Date.now()
  writeFileSync(join(dir, 'last-reply.stamp'), String(now - 3_600_000))
  writeFileSync(join(dir, 'last-inbound.stamp'), String(now))   // notify-stop: an unanswered inbound
  writeFileSync(join(dir, 'silence-tool-count'), '3')           // written after the last reply
  return dir
}

const FORKS = [
  { dir: 'telegram-grok', prefix: 'GROK' },
  { dir: 'telegram-agy', prefix: 'AGY' },
  { dir: 'telegram-codex', prefix: 'CODEX' },
] as const
const FORK_HOOKS = ['notify-stop.ts', 'notification-relay.ts', 'silence-watchdog.ts'] as const

describe('H: the agy / codex / grok notice hooks are silent under local-only', () => {
  for (const f of FORKS) {
    const cases = [
      { hook: 'notify-stop.ts', env: {}, stdin: '' },
      { hook: 'notification-relay.ts', env: {}, stdin: JSON.stringify({ message: 'error: the model failed' }) },
      { hook: 'silence-watchdog.ts', env: { [`${f.prefix}_SILENCE_WATCHDOG_ENABLED`]: '1', [`${f.prefix}_SILENCE_WATCHDOG_MS`]: '10000' }, stdin: '{}' },
    ]
    for (const c of cases) {
      test(`${f.dir}/${c.hook}: flag absent reaches api.telegram.org (control); flag on sends nothing`, async () => {
        const file = P(f.dir, 'hooks', c.hook)
        const off = await runHook(file, { TELEGRAM_STATE_DIR: forkState(), FIVE_LOCAL_ONLY_FILE: NO_FLAG, ...c.env }, c.stdin)
        expect(off.connects).toEqual(['CONNECT api.telegram.org:443 HTTP/1.1'])
        const on = await runHook(file, { TELEGRAM_STATE_DIR: forkState(), FIVE_LOCAL_ONLY_FILE: FLAG, ...c.env }, c.stdin)
        expect(on.code).toBe(0)
        expect(on.connects).toEqual([])
      })
    }
  }
})

describe('H: the telegram plugin hooks (and their dashboard copies)', () => {
  // A local Bot API stub, reached through the TELEGRAM_API_BASE seam that
  // lib/telegram.ts already has: counts every sendMessage that arrives.
  let hits = 0
  let srv: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { hits++; return Response.json({ ok: true, result: {} }) } })
  })
  afterAll(() => { srv?.stop(true) })

  for (const plugin of ['telegram', 'dashboard']) {
    test(`${plugin}/hooks/lib/telegram.ts sendMessage: one send with the flag absent, none with it on`, async () => {
      const state = mkdtempSync(join(TMP, 'tg-'))
      writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: ['1234567890'] }))
      const env: Record<string, string> = { TELEGRAM_BOT_TOKEN: '123:FAKE', TELEGRAM_STATE_DIR: state, TELEGRAM_API_BASE: `http://127.0.0.1:${srv.port}` }
      const saved: Record<string, string | undefined> = {}
      for (const k of [...Object.keys(env), 'FIVE_LOCAL_ONLY_FILE']) saved[k] = process.env[k]
      Object.assign(process.env, env)
      try {
        const { sendMessage } = await import(P(plugin, 'hooks', 'lib', 'telegram.ts'))
        hits = 0
        process.env.FIVE_LOCAL_ONLY_FILE = NO_FLAG
        expect(await sendMessage('1234567890', 'hello')).toBe(true)
        expect(hits).toBe(1)
        process.env.FIVE_LOCAL_ONLY_FILE = FLAG
        expect(await sendMessage('1234567890', 'hello')).toBe(false)
        expect(hits).toBe(1)
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    })

    test(`${plugin}/hooks/lib/lite.ts readAllowance never asks openrouter.ai under local-only`, async () => {
      const { readAllowance } = await import(P(plugin, 'hooks', 'lib', 'lite.ts'))
      let calls = 0
      const spy = (async () => { calls++; return Response.json({ data: { limit: null } }) }) as unknown as typeof fetch
      const env = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-test' }
      expect(await readAllowance({ ...env, FIVE_LOCAL_ONLY_FILE: NO_FLAG }, spy)).toEqual({ kind: 'uncapped' })
      expect(calls).toBe(1)
      expect(await readAllowance({ ...env, FIVE_LOCAL_ONLY_FILE: FLAG }, spy)).toEqual({ kind: 'unknown' })
      expect(calls).toBe(1)
    })
  }

  test('telegram/hooks/lib/demo-key.ts readDemoKey never asks openrouter.ai under local-only', async () => {
    const { readDemoKey, DEMO_ACCOUNT } = await import(P('telegram', 'hooks', 'lib', 'demo-key.ts'))
    let calls = 0
    const spy = (async () => { calls++; return Response.json({ data: { limit: 5, limit_remaining: 4 } }) }) as unknown as typeof fetch
    const env = { AGENT_AUTH_PROFILE: DEMO_ACCOUNT, ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-test' }
    await readDemoKey({}, { ...env, FIVE_LOCAL_ONLY_FILE: NO_FLAG }, spy)
    expect(calls).toBe(1)
    const on = await readDemoKey({}, { ...env, FIVE_LOCAL_ONLY_FILE: FLAG }, spy)
    expect(calls).toBe(1)
    expect(on.kind).toBe('unknown')
  })

  test('telegram/hooks/pretool-question.ts stands aside under local-only (no deny telling the agent to use Telegram)', async () => {
    const file = P('telegram', 'hooks', 'pretool-question.ts')
    const state = mkdtempSync(join(TMP, 'pq-'))
    const payload = JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} })
    const off = await runHook(file, { TELEGRAM_STATE_DIR: state, FIVE_LOCAL_ONLY_FILE: NO_FLAG }, payload)
    expect(off.out).toContain('Telegram') // control: the legacy deny
    const on = await runHook(file, { TELEGRAM_STATE_DIR: state, FIVE_LOCAL_ONLY_FILE: FLAG }, payload)
    expect(on.code).toBe(0)
    expect(on.out).toBe('')
    expect(on.connects).toEqual([])
  })

  test('every hardcoded api.telegram.org call in a hook file sits behind a local-only check', () => {
    const files = [
      ...FORKS.flatMap(f => FORK_HOOKS.map(h => P(f.dir, 'hooks', h))),
      P('telegram', 'hooks', 'pretool-question.ts'),
      P('telegram', 'hooks', 'context-nudge.ts'),
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const call = src.search(/fetch\(`https:\/\/api\.telegram\.org/)
      expect(call).toBeGreaterThan(0)
      const gates = [src.indexOf("existsSync(process.env.FIVE_LOCAL_ONLY_FILE ?? '/etc/5dive/local-only')"), src.indexOf('if (localOnly()) ')].filter(i => i > 0)
      expect(gates.length).toBeGreaterThan(0)
      expect(Math.min(...gates)).toBeLessThan(call)
    }
  })
})

// ── D. the dashboard adapter's control-plane base ───────────────────────────

describe('D: dashboard reads /etc/5dive/api-base', () => {
  test('order: DASHBOARD_API_BASE > the file > https://api.5dive.com', async () => {
    const { resolveApiBase, readApiBaseFile } = await import(P('dashboard', 'apibase.ts'))
    const file = join(TMP, 'api-base')
    const missing = join(TMP, 'no-api-base')
    expect(resolveApiBase({ DASHBOARD_API_BASE_FILE: missing })).toBe('https://api.5dive.com')
    writeFileSync(file, 'https://192.0.2.20:8443/\n')
    expect(resolveApiBase({ DASHBOARD_API_BASE_FILE: file })).toBe('https://192.0.2.20:8443')
    expect(resolveApiBase({ DASHBOARD_API_BASE_FILE: file, DASHBOARD_API_BASE: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9')
    writeFileSync(file, '# office chat server\n\nhttp://office-box.lan:7000\n')
    expect(readApiBaseFile(file)).toBe('http://office-box.lan:7000')
    for (const junk of ['', '\n', 'not a url\n', 'ftp://x\n', 'https://a b\n']) {
      writeFileSync(file, junk)
      expect(resolveApiBase({ DASHBOARD_API_BASE_FILE: file })).toBe('https://api.5dive.com')
    }
  })

  test('server.ts takes API_BASE from the resolver, after its .env is loaded', () => {
    const src = readFileSync(P('dashboard', 'server.ts'), 'utf8')
    expect(src).toContain('const API_BASE = resolveApiBase()')
    expect(src).not.toContain("process.env.DASHBOARD_API_BASE ?? 'https://api.5dive.com'")
    expect(src.indexOf('const API_BASE = resolveApiBase()')).toBeGreaterThan(src.indexOf('readFileSync(ENV_FILE'))
  })
})
