// DIVE-8138: a parked chat row must not spin the long poll, and a dashboard
// process must stop when its agent is no longer on the box.
//
// Live (server 589, 11-06..11-09): agent claudey made 560k polls a day. Every
// row the API offered was parked or in backoff, so drainPendingOnce pushed and
// acked nothing yet returned 'ok', runLongPoll asked again at once, and the API
// answered at once because the row was still owed. The same process outlived
// claudey's removal by three days.
//
// Arms 1-2 drive a REAL server.ts on a chat-only box against a relay stand-in
// that answers `pending 25` AT ONCE with one owed row, forever — the worst case,
// an API that keeps offering it whatever the box acks. Arm 3 drives a real
// server.ts whose passwd entry disappears.

//
// Every spawn gets an EXPLICIT env (PATH plus the seams below, HOME and TMPDIR
// inside the scratch dir) — never a spread of the runner's env, so a DASHBOARD_*,
// CONNECTORD_* or USER value in the grading shell cannot steer server.ts down
// another path. Any red prints the child's exit code and stderr tail.

import { describe, test, expect, beforeAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { makeSeatGuard, passwdName } from '../plugins/dashboard/seatguard.ts'

const PLUGIN = join(import.meta.dir, '..', 'plugins', 'dashboard')
const SERVER = join(PLUGIN, 'server.ts')
const BUN = process.execPath

// A clean checkout (the computed grade, CI) has no plugin deps, and server.ts
// then dies at its first import — which read as "never polled" and "exited while
// the seat was present". Install them from the plugin's own lockfile first.
beforeAll(() => {
  if (existsSync(join(PLUGIN, 'node_modules', '@modelcontextprotocol', 'sdk'))) return
  const r = Bun.spawnSync([BUN, 'install', '--frozen-lockfile', '--production', '--no-summary'],
    { cwd: PLUGIN, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`bun install in plugins/dashboard failed (exit ${r.exitCode}): ${r.stderr.toString().slice(-1000)}`)
}, 120_000)

/** Spawn a real server.ts with exactly `env` (+ PATH), capturing stderr and the exit. */
function spawnServer(env: Record<string, string>) {
  const proc = Bun.spawn([BUN, SERVER], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let err = ''
  const dec = new TextDecoder()
  void (async () => { for await (const c of proc.stderr) err += dec.decode(c, { stream: true }) })().catch(() => {})
  void (async () => { for await (const _ of proc.stdout) { /* drain */ } })().catch(() => {})
  let code: number | null = null
  void proc.exited.then(c => { code = c })
  return {
    proc,
    exited: () => code !== null,
    why: () => `server.ts ${code === null ? 'still running' : `exited code=${code} signal=${proc.signalCode ?? '-'}`}\n` +
      `--- server.ts stderr (tail) ---\n${err.slice(-3000) || '(empty)'}\n--- end stderr ---`,
  }
}

/** Run `fn`; on a failed assert print why the child behaved as it did, then rethrow. */
async function explained<T>(why: () => string, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { console.error(why()); throw e }
}
const BOOT_MS = 5_000
const WINDOW_MS = 8_000
// Pre-fix this window saw one poll per relay round trip (~10/s); paced it is a
// handful. The bound is loose on purpose: it separates a spin from a pace.
const MAX_HELD_POLLS = 15

function setup(retry: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-8138-'))
  mkdirSync(join(dir, 'outbox'))
  mkdirSync(join(dir, 'home'))
  mkdirSync(join(dir, 'tmp'))
  mkdirSync(join(dir, 'state', 'collect-now'), { recursive: true })
  writeFileSync(join(dir, 'state', 'pending-redelivery.json'), JSON.stringify(retry))
  writeFileSync(join(dir, 'chat-only'), 'API=http://x\nLINKED_AT=0\n')
  // The token file is THERE and unreadable — for every uid, root included: a
  // directory stats fine and cannot be read as a file. (It was a chmod-000
  // file, which a root or CAP_DAC_OVERRIDE runner reads, skipping the relay.)
  const envFile = join(dir, 'connectord.env')
  mkdirSync(envFile)
  const relay = join(dir, 'relay.ts')
  writeFileSync(relay, `
import { appendFileSync } from 'node:fs'
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(${JSON.stringify(join(dir, 'ops.log'))}, JSON.stringify({ op, t: Date.now() }) + '\\n')
if (op[0] === 'pending') process.stdout.write('200\\n' + JSON.stringify({ pending: [{ id: 77, text: 'owed forever', chat_id: '1', ts: '2026-11-06T09:00:00.000Z' }] }))
else if (op[0] === 'ack') process.stdout.write('200\\n' + JSON.stringify({ acked: op.length - 1 }))
else process.stdout.write('200\\n{"ok":true}')
`)
  return { dir, envFile, relay }
}

function startAdapter(dir: string, envFile: string, relay: string) {
  const s = spawnServer({
    HOME: join(dir, 'home'),
    TMPDIR: join(dir, 'tmp'),
    USER: 'agent-tap',
    DASHBOARD_STATE_DIR: join(dir, 'state'),
    DASHBOARD_OUTBOX: join(dir, 'outbox'),
    DASHBOARD_CHAT_UPLOADS: join(dir, 'uploads'),
    DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'chat-only'),
    DASHBOARD_LONGPOLL_BACKOFF_MS: '200',
    DASHBOARD_API_BASE: 'http://127.0.0.1:9',
    DASHBOARD_PASSWD_FILE: join(dir, 'no-passwd'),
    CONNECTORD_ENV_FILE: envFile,
    DASHBOARD_RELAY_ARGV: JSON.stringify([BUN, relay]),
  })
  s.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dive8138-test', version: '0' } } }) + '\n')
  s.proc.stdin.flush()
  return s
}

type Op = { op: string[]; t: number }
function ops(dir: string): Op[] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Op)
}
const held = (o: Op[]) => o.filter(x => x.op[0] === 'pending' && x.op[1] === '25')
const acks = (o: Op[]) => o.filter(x => x.op[0] === 'ack')

async function run(retry: Record<string, unknown>, check: (r: { held: number; acks: Op[]; pushed: number }) => void) {
  const { dir, envFile, relay } = setup(retry)
  const s = startAdapter(dir, envFile, relay)
  try {
    await Bun.sleep(BOOT_MS + WINDOW_MS)
    const all = ops(dir)
    const pushed = existsSync(join(dir, 'state', 'lifecycle.log'))
      ? readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8').split('\n').filter(l => l.includes('id=77 pushed')).length
      : 0
    const r = { held: held(all).length, acks: acks(all), pushed }
    await explained(s.why, () => {
      expect(s.exited()).toBe(false)
      check(r)
    })
    return r
  } finally {
    s.proc.kill()
    await s.proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('DIVE-8138: owed rows the box will not push pace the long poll', () => {
  test('a parked row is acked, never pushed, and the long poll paces', async () => {
    await run({ '77': { attempts: 3, lastAttemptAt: Date.now(), lastSeenAt: Date.now(), parkedLogged: true } }, r => {
      console.log(`parked: held polls ${r.held} in ${WINDOW_MS} ms, acks ${r.acks.length}`)
      expect(r.held).toBeGreaterThanOrEqual(1)
      expect(r.held).toBeLessThanOrEqual(MAX_HELD_POLLS)
      expect(r.pushed).toBe(0)
      expect(r.acks.length).toBeGreaterThanOrEqual(1)
      expect(r.acks.every(a => a.op.slice(1).join(',') === '77')).toBe(true)
    })
  }, 30_000)

  test('a row in backoff is neither pushed nor acked, and the long poll paces', async () => {
    await run({ '77': { attempts: 1, lastAttemptAt: Date.now(), lastSeenAt: Date.now() } }, r => {
      console.log(`backoff: held polls ${r.held} in ${WINDOW_MS} ms, acks ${r.acks.length}`)
      expect(r.held).toBeGreaterThanOrEqual(1)
      expect(r.held).toBeLessThanOrEqual(MAX_HELD_POLLS)
      expect(r.pushed).toBe(0)
      expect(r.acks).toHaveLength(0)
    })
  }, 30_000)
})

describe('DIVE-8138: the seat guard', () => {
  const pw = (name: string, uid: number) => `root:x:0:0:root:/root:/bin/bash\n${name}:x:${uid}:${uid}::/home/${name}:/bin/bash\n`

  test('passwdName reads the name for a uid, null when none has it', () => {
    expect(passwdName(pw('agent-claudey', 1042), 1042)).toBe('agent-claudey')
    expect(passwdName(pw('agent-claudey', 1042), 1043)).toBeNull()
    expect(passwdName('', 1042)).toBeNull()
  })

  test('arms only when the boot read proves this uid IS the seat', () => {
    expect(makeSeatGuard({ user: 'agent-dev', uid: 1042, read: () => pw('agent-dev', 1042) }).armed).toBe(true)
    // A test faking USER under another uid, or an unreadable passwd: never armed, never fires.
    const fake = makeSeatGuard({ user: 'agent-dev', uid: 1042, read: () => pw('runner', 1042) })
    expect(fake.armed).toBe(false)
    expect(fake.check()).toBe('unknown')
    expect(makeSeatGuard({ user: 'agent-dev', uid: 1042, read: () => null }).armed).toBe(false)
  })

  test('gone needs two straight reads; unreadable is unknown; a recycled uid is gone', () => {
    let text: string | null = pw('agent-claudey', 1042)
    const g = makeSeatGuard({ user: 'agent-claudey', uid: 1042, read: () => text })
    expect(g.check()).toBe('ok')
    text = pw('root2', 7)                     // deleted
    expect(g.check()).toBe('unknown')
    text = pw('agent-claudey', 1042)          // a read that raced a rewrite
    expect(g.check()).toBe('ok')
    text = null                               // unreadable never counts
    expect(g.check()).toBe('unknown')
    expect(g.check()).toBe('unknown')
    text = pw('agent-claude', 1042)           // uid recycled to a new seat
    expect(g.check()).toBe('unknown')
    expect(g.check()).toBe('gone')
    expect(g.seen()).toBe('agent-claude')
  })

  test('a real server.ts stops once its seat leaves passwd, and not before', async () => {
    const me = userInfo().username
    const uid = process.getuid!()
    const dir = mkdtempSync(join(tmpdir(), 'dash-8138-seat-'))
    const passwd = join(dir, 'passwd')
    writeFileSync(passwd, pw(me, uid))
    mkdirSync(join(dir, 'state'), { recursive: true })
    mkdirSync(join(dir, 'home'))
    mkdirSync(join(dir, 'tmp'))
    const s = spawnServer({
      HOME: join(dir, 'home'),
      TMPDIR: join(dir, 'tmp'),
      USER: me,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'no-chat-only'),
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_PASSWD_FILE: passwd,
      DASHBOARD_SEAT_CHECK_MS: '200',
      CONNECTORD_ENV_FILE: join(dir, 'no-connectord.env'),
      CONNECTORD_TOKEN: 'tok-8138',
    })
    try {
      await explained(s.why, async () => {
        // Control: while the seat is in passwd the process stays up.
        await Bun.sleep(2_000)
        expect(s.exited()).toBe(false)
        writeFileSync(passwd, 'root:x:0:0:root:/root:/bin/bash\n')
        const deadline = Date.now() + 5_000
        while (!s.exited() && Date.now() < deadline) await Bun.sleep(50)
        expect(s.exited()).toBe(true)
        const log = readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8')
        expect(log).toContain('is no longer on this box')
      })
    } finally {
      if (!s.exited()) s.proc.kill()
      await s.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
