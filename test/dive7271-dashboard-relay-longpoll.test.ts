// DIVE-7271: a standard (relay) seat on a chat-only box must hold its long
// poll, not livelock into plain polls.
//
// Every relay call costs a sudo round trip (~160 ms for a ping, more for a
// pending fetch). On 0.5.12 a long poll that found a drain running set `rerun`
// and retried 250 ms later; the drain then started a PLAIN rerun, the retry
// landed inside it and set `rerun` again, so the long poll never ran and plain
// polls went out back to back (~2/s per seat). Four such seats 429'd the whole
// box off the API's 60/min limit (DIVE-7269).
//
// Driven as a REAL server.ts process against a relay stand-in that answers
// every op after 400 ms and holds `pending 25` for 3 s when nothing is queued.

import { describe, test, expect } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000
const RELAY_MS = 400

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-7271-'))
  mkdirSync(join(dir, 'outbox'))
  mkdirSync(join(dir, 'state', 'collect-now'), { recursive: true })
  writeFileSync(join(dir, 'chat-only'), 'API=http://x\nLINKED_AT=0\n')
  // The seat cannot read the box token, so every call goes through the relay.
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=tok-7271\n')
  chmodSync(envFile, 0o000)
  const relay = join(dir, 'relay.ts')
  writeFileSync(relay, `
import { appendFileSync } from 'node:fs'
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
const t0 = Date.now()
await Bun.sleep(${RELAY_MS})
if (op[0] === 'pending' && op[1]) await Bun.sleep(3000)
appendFileSync(${JSON.stringify(join(dir, 'ops.log'))}, JSON.stringify({ op, t0, t1: Date.now() }) + '\\n')
if (op[0] === 'pending') process.stdout.write('200\\n{"pending":[]}')
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
      DASHBOARD_LONGPOLL_BACKOFF_MS: '50',
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
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dive7271-test', version: '0' } } }) + '\n')
  proc.stdin.flush()
  return proc
}

type Op = { op: string[]; t0: number; t1: number }
function pendings(dir: string): Op[] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Op).filter(o => o.op[0] === 'pending')
}
const plain = (ops: Op[]) => ops.filter(o => o.op.length === 1)
const held = (ops: Op[]) => ops.filter(o => o.op[1] === '25')

describe('dashboard on a chat-only box, slow root relay (DIVE-7271)', () => {
  test('boot + 10 s: the long poll holds (>= 1 pending 25) and plain polls stay <= 3', async () => {
    const { dir, envFile, relay } = setup()
    const proc = startAdapter(dir, envFile, relay)
    try {
      await Bun.sleep(BOOT_MS + 10_000)
      const ops = pendings(dir)
      console.log(`plain pending: ${plain(ops).length}, pending 25: ${held(ops).length}`)
      expect(held(ops).length).toBeGreaterThanOrEqual(1)
      expect(plain(ops).length).toBeLessThanOrEqual(3)
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('negative control: collect-now nudges during a held poll bring exactly one extra plain drain', async () => {
    const { dir, envFile, relay } = setup()
    const proc = startAdapter(dir, envFile, relay)
    try {
      const deadline = Date.now() + BOOT_MS + 8_000
      // Wait for the first held poll to be on the wire (its relay call started).
      while (Date.now() < deadline && !existsSync(join(dir, 'state', 'pending-drain.lock'))) await Bun.sleep(25)
      while (Date.now() < deadline && plain(pendings(dir)).length < 1) await Bun.sleep(25)
      await Bun.sleep(RELAY_MS + 200)
      const before = plain(pendings(dir)).length
      expect(before).toBe(1)
      // Three nudges inside the hold, as shelld writes them: one fixed path.
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dir, 'state', 'collect-now', 'nudge'), `${Date.now()}\n`)
        await Bun.sleep(400)
      }
      await Bun.sleep(4_500)
      const ops = pendings(dir)
      expect(plain(ops).length).toBe(before + 1)
      // The extra plain drain ran after the held poll it arrived during.
      const extra = plain(ops)[before]
      expect(held(ops).some(h => h.t1 <= extra.t0)).toBe(true)
      expect(held(ops).length).toBeGreaterThanOrEqual(1)
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
