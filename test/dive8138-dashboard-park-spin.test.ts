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

import { describe, test, expect } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { makeSeatGuard, passwdName } from '../plugins/dashboard/seatguard.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000
const WINDOW_MS = 8_000
// Pre-fix this window saw one poll per relay round trip (~10/s); paced it is a
// handful. The bound is loose on purpose: it separates a spin from a pace.
const MAX_HELD_POLLS = 15

function setup(retry: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-8138-'))
  mkdirSync(join(dir, 'outbox'))
  mkdirSync(join(dir, 'state', 'collect-now'), { recursive: true })
  writeFileSync(join(dir, 'state', 'pending-redelivery.json'), JSON.stringify(retry))
  writeFileSync(join(dir, 'chat-only'), 'API=http://x\nLINKED_AT=0\n')
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=tok-8138\n')
  chmodSync(envFile, 0o000)
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
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(dir, 'uploads'),
      DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'chat-only'),
      DASHBOARD_LONGPOLL_BACKOFF_MS: '200',
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', relay]),
      USER: 'agent-tap',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dive8138-test', version: '0' } } }) + '\n')
  proc.stdin.flush()
  return proc
}

type Op = { op: string[]; t: number }
function ops(dir: string): Op[] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Op)
}
const held = (o: Op[]) => o.filter(x => x.op[0] === 'pending' && x.op[1] === '25')
const acks = (o: Op[]) => o.filter(x => x.op[0] === 'ack')

async function run(retry: Record<string, unknown>) {
  const { dir, envFile, relay } = setup(retry)
  const proc = startAdapter(dir, envFile, relay)
  try {
    await Bun.sleep(BOOT_MS + WINDOW_MS)
    const all = ops(dir)
    const pushed = existsSync(join(dir, 'state', 'lifecycle.log'))
      ? readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8').split('\n').filter(l => l.includes('id=77 pushed')).length
      : 0
    return { held: held(all).length, acks: acks(all), pushed }
  } finally {
    proc.kill()
    await proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('DIVE-8138: owed rows the box will not push pace the long poll', () => {
  test('a parked row is acked, never pushed, and the long poll paces', async () => {
    const r = await run({ '77': { attempts: 3, lastAttemptAt: Date.now(), lastSeenAt: Date.now(), parkedLogged: true } })
    console.log(`parked: held polls ${r.held} in ${WINDOW_MS} ms, acks ${r.acks.length}`)
    expect(r.held).toBeGreaterThanOrEqual(1)
    expect(r.held).toBeLessThanOrEqual(MAX_HELD_POLLS)
    expect(r.pushed).toBe(0)
    expect(r.acks.length).toBeGreaterThanOrEqual(1)
    expect(r.acks.every(a => a.op.slice(1).join(',') === '77')).toBe(true)
  }, 30_000)

  test('a row in backoff is neither pushed nor acked, and the long poll paces', async () => {
    const r = await run({ '77': { attempts: 1, lastAttemptAt: Date.now(), lastSeenAt: Date.now() } })
    console.log(`backoff: held polls ${r.held} in ${WINDOW_MS} ms, acks ${r.acks.length}`)
    expect(r.held).toBeGreaterThanOrEqual(1)
    expect(r.held).toBeLessThanOrEqual(MAX_HELD_POLLS)
    expect(r.pushed).toBe(0)
    expect(r.acks).toHaveLength(0)
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
    const proc = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        USER: me,
        DASHBOARD_STATE_DIR: join(dir, 'state'),
        DASHBOARD_OUTBOX: join(dir, 'outbox'),
        DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'no-chat-only'),
        DASHBOARD_API_BASE: 'http://127.0.0.1:9',
        DASHBOARD_PASSWD_FILE: passwd,
        DASHBOARD_SEAT_CHECK_MS: '200',
        CONNECTORD_TOKEN: 'tok-8138',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let exited = false
    void proc.exited.then(() => { exited = true })
    try {
      // Control: while the seat is in passwd the process stays up.
      await Bun.sleep(2_000)
      expect(exited).toBe(false)
      writeFileSync(passwd, 'root:x:0:0:root:/root:/bin/bash\n')
      const deadline = Date.now() + 5_000
      while (!exited && Date.now() < deadline) await Bun.sleep(50)
      expect(exited).toBe(true)
      const log = readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8')
      expect(log).toContain('is no longer on this box')
    } finally {
      if (!exited) proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
