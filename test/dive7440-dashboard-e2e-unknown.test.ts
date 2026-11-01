// DIVE-7440: the seat cannot see whether encrypted chat is on (0.111.0's enable
// left /etc/5dive at 0700, so stat of /etc/5dive/chat-e2e is EACCES).
//
//   * e2eState reads EACCES as unknown, never off; only "no such dir" is off;
//   * makeE2EGate asks root then: answers / exit 3 / refused -> on, exit 4 -> off,
//     anything else throws (fail closed); root's answer is cached;
//   * a REAL server.ts whose key dir sits under a parent it cannot cross:
//     - root can tell (the box is on): the encrypted message reaches the
//       session opened, and the reply goes out sealed;
//     - nobody can tell (root verb broken): the message is not delivered and
//       not acked, and the reply is refused, never sent in the clear.

import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as E from '../plugins/dashboard/e2e.ts'
import { E2EUnknown, E2E_UNKNOWN_TEXT, e2eState, makeE2EGate, parseEnvelope } from '../plugins/dashboard/chate2e.ts'
import { initBox } from './lib/chat-e2e-box-stub.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const STUB = join(import.meta.dir, 'lib', 'chat-e2e-box-stub.ts')
const TOKEN = 'tok-chat-e2e-7440'
const dec = new TextDecoder()
const isRoot = process.getuid?.() === 0
const locked: string[] = []
afterAll(() => { for (const d of locked) try { chmodSync(d, 0o755) } catch {} })

/** <tmp>/locked/chat-e2e behind a parent this process cannot cross (the 0700 /etc/5dive, as a seat sees it). */
function lockedDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dash-7440-'))
  const parent = join(root, 'locked')
  mkdirSync(join(parent, 'chat-e2e'), { recursive: true })
  chmodSync(parent, 0o000)
  locked.push(parent)
  return join(parent, 'chat-e2e')
}

describe('what the seat can see (DIVE-7440)', () => {
  test('U1 only "no such dir" is off; a dir is on; a parent it cannot cross is unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'dash-7440-'))
    expect(e2eState(join(root, 'nope'))).toBe('off')
    writeFileSync(join(root, 'file'), 'x')
    expect(e2eState(join(root, 'file', 'chat-e2e'))).toBe('off')
    mkdirSync(join(root, 'on'))
    expect(e2eState(join(root, 'on'))).toBe('on')
    if (!isRoot) expect(e2eState(lockedDir())).toBe('unknown')
  })

  test('U2 unknown asks root: answers/exit 3/refused -> on, exit 4 -> off, else throws; cached for the ttl', async () => {
    if (isRoot) return
    const dir = lockedDir()
    let t = 0, calls = 0
    const gate = (fail: string | null) => makeE2EGate(dir, async () => { calls++; if (fail) throw new Error(fail); return { on: true } }, 1000, () => t)
    expect(await gate(null)()).toBe(true)
    expect(await gate('chat-e2e state failed (exit 3): unknown op state')()).toBe(true)
    expect(await gate('chat-e2e state refused: unknown op state')()).toBe(true)
    expect(await gate('chat-e2e state failed (exit 4): encrypted chat is not on on this server.')()).toBe(false)
    await expect(gate('chat-e2e state failed (exit 1): sudo: a password is required')()).rejects.toBeInstanceOf(E2EUnknown)
    calls = 0
    const g = gate(null)
    await g(); await g(); expect(calls).toBe(1)
    t = 2000; await g(); expect(calls).toBe(2)
  })

  test('U3 a dir the seat CAN see never asks root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dash-7440-'))
    let calls = 0
    const call = async () => { calls++; return {} }
    expect(await makeE2EGate(join(root, 'nope'), call)()).toBe(false)
    mkdirSync(join(root, 'on'))
    expect(await makeE2EGate(join(root, 'on'), call)()).toBe(true)
    expect(calls).toBe(0)
  })
})

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (pred()) return true; await Bun.sleep(25) }
  return pred()
}

/** A real server.ts whose key dir it cannot see; `argv` is its root verb. */
async function serverWorld(argvFor: (box: string) => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-7440-srv-'))
  for (const d of ['box', 'state', 'outbox', 'uploads/tap']) mkdirSync(join(dir, d), { recursive: true })
  const phone = { kp: await E.newIdentity() }
  const boxRaw = await initBox(join(dir, 'box'), { 'dev-phone': await E.exportPublic(phone.kp.publicKey) })
  const boxPub = await E.importPublic(boxRaw)
  const sealed = JSON.stringify(await E.seal({
    senderId: 'dev-phone', senderPriv: phone.kp.privateKey, recipients: [{ id: 'box', pub: boxPub }],
    conv: 'dashboard', msgId: 'c-7440', dir: 'in', plaintext: JSON.stringify({ t: 'msg', text: 'are you there' }),
  }))
  const queue: Array<Record<string, unknown>> = [{ id: 1, text: sealed, chat_id: 'dashboard', ts: '2026-11-01T00:40:13Z' }]
  const events: Array<{ body: string; metadata: Record<string, unknown> }> = []
  const acked: number[] = []
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 })
      if (url.pathname === '/server/messages/pending') return Response.json({ pending: queue.splice(0) })
      if (url.pathname === '/server/messages/pending/ack') {
        const b = (await req.json()) as { ids: number[] }
        acked.push(...b.ids)
        return Response.json({ ok: true, acked: b.ids.length })
      }
      if (url.pathname === '/server/messages/event') {
        events.push((await req.json()) as (typeof events)[number])
        return Response.json({ id: 70 + events.length })
      }
      return new Response('not found', { status: 404 })
    },
  })
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(dir, 'uploads'),
      DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'no-chat-only'),
      DASHBOARD_CHAT_E2E_DIR: lockedDir(),
      DASHBOARD_E2E_ARGV: JSON.stringify(argvFor(join(dir, 'box'))),
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      CONNECTORD_TOKEN: TOKEN,
      USER: 'agent-tap',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const delivered: string[] = []
  const results: string[] = []
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '0' } } })
  void (async () => {
    const reader = proc.stdout.getReader()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const msg = JSON.parse(line)
          if (msg.method === 'notifications/claude/channel') delivered.push(String(msg.params?.content ?? ''))
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (msg.id === 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  const reply = (text: string) => send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: 'dashboard', text } } })
  const read = async (body: string) =>
    JSON.parse(await E.openText({ env: parseEnvelope(body)!, myId: 'dev-phone', myPriv: phone.kp.privateKey, senderPub: boxPub, expect: { conv: 'dashboard', dir: 'out' } }))
  const stop = () => { proc.kill(); api.stop(true) }
  return { dir, events, acked, delivered, results, reply, read, stop }
}

describe('dashboard adapter that cannot see the key dir, real server.ts (DIVE-7440)', () => {
  test('S1 root can tell (on): the encrypted message reaches the session opened, the reply is sealed, no 409 shape', async () => {
    if (isRoot) return
    const w = await serverWorld(box => ['bun', STUB, box])
    try {
      expect(await waitFor(() => w.acked.includes(1), 15_000)).toBe(true)
      expect(w.delivered).toEqual(['are you there'])
      w.reply('yes, here: fortytwo')
      expect(await waitFor(() => w.results.length === 1, 10_000)).toBe(true)
      expect(w.results[0]).toContain('sent encrypted')
      const sent = w.events.at(-1)!
      expect(JSON.stringify(sent)).not.toContain('fortytwo')
      expect(sent.metadata).toMatchObject({ e2e: { v: 1 } })
      expect(await w.read(sent.body)).toMatchObject({ t: 'msg', text: 'yes, here: fortytwo' })
    } finally { w.stop() }
  }, 40_000)

  test('S2 nobody can tell: the envelope is held (not delivered, not acked), the reply is refused, never sent in the clear', async () => {
    if (isRoot) return
    const w = await serverWorld(() => ['false'])
    try {
      // The boot drain runs 5 s in; the person is told once.
      expect(await waitFor(() => w.events.some(e => e.body === E2E_UNKNOWN_TEXT), 15_000)).toBe(true)
      expect(w.delivered).toEqual([])
      expect(w.acked).toEqual([])
      w.reply('yes, here: fortytwo')
      expect(await waitFor(() => w.results.length === 1, 10_000)).toBe(true)
      expect(w.results[0]).toContain('not sent')
      expect(w.results[0]).not.toContain('sent encrypted')
      expect(JSON.stringify(w.events)).not.toContain('fortytwo')
      const { readFileSync } = await import('node:fs')
      expect(readFileSync(join(w.dir, 'state', 'lifecycle.log'), 'utf8')).toContain('encrypted chat: pending message id=1 held, not delivered')
    } finally { w.stop() }
  }, 40_000)
})
