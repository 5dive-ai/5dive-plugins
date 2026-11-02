// DIVE-7503: an encrypted chat on a 5dive (hosted) server, from a STANDARD seat.
//
// A standard seat cannot read the box token, so every control-plane call crosses
// the root relay (`5dive _dashboard_relay`, played here by a stand-in that logs
// each op). The server is not chat-only: its file server hands reply files out
// of the outbox, so nothing is `put`. A REAL server.ts process:
//   R1 the sealed inbound reaches the session; the reply, its file and the
//      "working" line leave only through `event-e2e` / `status-e2e`, as
//      envelopes a device opens; no plain `event`/`status`, no `put`, no plain
//      copy left in the outbox; and a hands-free clip in the poll answer is not
//      heard, even with the engine on the box.
//   R2 a relay from before DIVE-7502 (no e2e ops): the reply is refused with a
//      sentence the agent can act on, nothing goes out in the clear, and the
//      outbox is left empty.

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as E from '../plugins/dashboard/e2e.ts'
import { parseEnvelope } from '../plugins/dashboard/chate2e.ts'
import { initBox } from './lib/chat-e2e-box-stub.ts'
import { tmpdir } from 'node:os'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const STUB = join(import.meta.dir, 'lib', 'chat-e2e-box-stub.ts')
const dec = new TextDecoder()

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

// The relay stand-in: NUL-separated ops on stdin, one JSON line per op in
// ops.log (each file named by event-e2e is copied in as it was handed over),
// "<status>\n<body>" on stdout. `old`: a relay from before the e2e ops.
function writeRelay(dir: string, old: boolean): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
const files = op[0] === 'event-e2e' ? op.slice(3).map(f => { try { return readFileSync(f, 'utf8') } catch { return null } }) : []
appendFileSync(dir + '/ops.log', JSON.stringify({ op, files }) + '\\n')
const ok = (b) => process.stdout.write('200\\n' + JSON.stringify(b))
if (op[0] === 'ping') ok({ ok: true })
else if (op[0] === 'pending') {
  let q = { pending: [] }
  try { q = JSON.parse(readFileSync(dir + '/queue.json', 'utf8')) } catch {}
  writeFileSync(dir + '/queue.json', JSON.stringify({ pending: [] }))
  ok(q)
} else if (op[0] === 'ack') ok({ ok: true, acked: op.length - 1 })
else if (${!old} && (op[0] === 'event-e2e' || op[0] === 'status-e2e')) ok({ id: 77 })
else if (op[0] === 'event' || op[0] === 'status') ok({ id: 66 })
else {
  process.stderr.write('_dashboard_relay allows only ping, pending, ack, event, status, ask, fetch or put.\\n')
  process.exit(2)
}
`)
  return file
}

type Op = { op: string[]; files: Array<string | null> }
function ops(dir: string): Op[] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function world(old: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-relay-e2e-'))
  for (const d of ['box', 'state', 'outbox', 'uploads/tap']) mkdirSync(join(dir, d), { recursive: true })
  const phone = await E.newIdentity()
  const boxRaw = await initBox(join(dir, 'box'), { 'dev-phone': await E.exportPublic(phone.publicKey) })
  const boxPub = await E.importPublic(boxRaw)
  const relay = writeRelay(dir, old)
  // A token file that is THERE and unreadable: the standard seat's view.
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  // The voice add-on's engine IS on this box: hands-free must stay off anyway.
  const transcribe = join(dir, '5dive-transcribe')
  writeFileSync(transcribe, '#!/bin/sh\necho "words the box should never hear"\n')
  chmodSync(transcribe, 0o755)
  const sealIn = (text: string, m: string) => E.seal({
    senderId: 'dev-phone', senderPriv: phone.privateKey, recipients: [{ id: 'box', pub: boxPub }],
    conv: 'dashboard', msgId: m, dir: 'in', plaintext: JSON.stringify({ t: 'msg', text }),
  }).then(env => JSON.stringify(env))
  const open = async (body: string) =>
    E.openText({ env: parseEnvelope(body)!, myId: 'dev-phone', myPriv: phone.privateKey, senderPub: boxPub, expect: { conv: 'dashboard', dir: 'out' } })
  return { dir, relay, envFile, transcribe, sealIn, open }
}

function start(w: Awaited<ReturnType<typeof world>>) {
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(w.dir, 'state'),
      DASHBOARD_OUTBOX: join(w.dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(w.dir, 'uploads'),
      // A 5dive server: not chat-only.
      DASHBOARD_CHAT_ONLY_MARKER: join(w.dir, 'no-chat-only'),
      DASHBOARD_CHAT_E2E_DIR: join(w.dir, 'box'),
      DASHBOARD_E2E_ARGV: JSON.stringify(['bun', STUB, join(w.dir, 'box')]),
      DASHBOARD_TRANSCRIBE: w.transcribe,
      // An API the seat must NOT reach: everything goes through the relay.
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      CONNECTORD_ENV_FILE: w.envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', w.relay]),
      USER: 'agent-tap',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const delivered: string[] = []
  const results = new Map<number, { text: string; isError: boolean }>()
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-e2e-test', version: '0' } } })
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
          if (typeof msg.id === 'number' && msg.id > 1) {
            results.set(msg.id, { text: String(msg.result?.content?.[0]?.text ?? msg.error?.message ?? ''), isError: !!(msg.result?.isError || msg.error) })
          }
        } catch {}
      }
    }
  })()
  const reply = (id: number, args: Record<string, unknown>) =>
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'reply', arguments: args } })
  return { proc, delivered, results, reply }
}

describe('encrypted chat from a standard seat on a 5dive server (DIVE-7503)', () => {
  test('R1 inbound opens; reply, file and status leave only as envelopes through the e2e relay ops; hands-free stays off', async () => {
    const w = await world(false)
    const clip = join(w.dir, 'uploads', 'tap', '1761300000000-clip.webm')
    writeFileSync(clip, 'sealed clip bytes')
    writeFileSync(join(w.dir, 'queue.json'), JSON.stringify({
      pending: [{ id: 1, text: await w.sealIn('hosted hello', 'c-r1'), chat_id: 'dashboard', ts: '2026-11-02T00:00:01Z' }],
      hear: [{ id: 'h-1', path: clip }],
    }))
    const s = start(w)
    try {
      // The boot drain runs 5 s in.
      expect(await waitFor(() => s.delivered.length >= 1, 15_000)).toBe(true)
      expect(s.delivered).toEqual(['hosted hello'])
      expect(await waitFor(() => ops(w.dir).some(o => o.op[0] === 'ack'), 5_000)).toBe(true)

      // The "working" step the status hook writes.
      writeFileSync(join(w.dir, 'state', 'status-label.json'), JSON.stringify({ at: Date.now(), label: 'Reading the zebra file' }))
      const report = join(w.dir, 'report.txt')
      writeFileSync(report, 'zebra secret report')
      s.reply(7, { chat_id: 'dashboard', text: 'the answer is fortytwo', files: [report] })
      expect(await waitFor(() => s.results.has(7), 15_000)).toBe(true)
      expect(s.results.get(7)).toMatchObject({ isError: false })
      expect(s.results.get(7)!.text).toContain('sent encrypted')
      expect(await waitFor(() => ops(w.dir).some(o => o.op[0] === 'status-e2e' && o.op.length === 4), 5_000)).toBe(true)

      const all = ops(w.dir)
      const kinds = all.map(o => o.op[0])
      // Nothing in the clear, and nothing posted: the box's file server serves the blob.
      expect(kinds).not.toContain('event')
      expect(kinds).not.toContain('status')
      expect(kinds).not.toContain('put')
      expect(JSON.stringify(all)).not.toContain('fortytwo')
      expect(JSON.stringify(all)).not.toContain('zebra')

      const sent = all.filter(o => o.op[0] === 'event-e2e')
      expect(sent.length).toBe(1)
      const [, chat, body, ...files] = sent[0].op
      expect(chat).toBe('dashboard')
      const inner = JSON.parse(await w.open(body))
      expect(inner).toMatchObject({ t: 'msg', text: 'the answer is fortytwo' })
      expect(inner.files).toHaveLength(1)
      expect(inner.files[0]).toMatchObject({ name: 'report.txt', path: files[0] })
      // The blob the relay was handed: this seat's, in the outbox, one envelope.
      expect(files).toHaveLength(1)
      expect(files[0].startsWith(join(w.dir, 'outbox', 'tap-'))).toBe(true)
      expect(files[0].endsWith('.e2e')).toBe(true)
      expect(await w.open(sent[0].files[0]!)).toBe('zebra secret report')
      // No plaintext copy left beside it.
      expect(readdirSync(join(w.dir, 'outbox'))).toEqual([files[0].split('/').pop()])

      const status = all.filter(o => o.op[0] === 'status-e2e' && o.op.length === 4)
      expect(JSON.parse(await w.open(status[0].op[3]))).toMatchObject({ t: 'status', label: 'Reading the zebra file' })

      // Hands-free: the clip in the poll answer was not heard (no `heard` call, the
      // relay's empty op) and is still there, though the engine is on the box.
      await Bun.sleep(500)
      expect(ops(w.dir).filter(o => o.op.length === 0)).toEqual([])
      expect(existsSync(clip)).toBe(true)
    } finally {
      s.proc.kill()
    }
  }, 45_000)

  test('R2 a relay with no e2e ops: the reply is refused, nothing goes in the clear, the outbox is empty', async () => {
    const w = await world(true)
    const s = start(w)
    try {
      const report = join(w.dir, 'report.txt')
      writeFileSync(report, 'zebra secret report')
      s.reply(8, { chat_id: 'dashboard', text: 'the answer is fortytwo', files: [report] })
      expect(await waitFor(() => s.results.has(8), 15_000)).toBe(true)
      const r = s.results.get(8)!
      expect(r.isError).toBe(true)
      expect(r.text).toContain('cannot send encrypted replies yet')
      expect(r.text).toContain('sudo 5dive self-update')
      expect(r.text).toContain('not sent unencrypted')
      const all = ops(w.dir)
      expect(all.map(o => o.op[0])).toContain('event-e2e')
      expect(all.map(o => o.op[0])).not.toContain('event')
      expect(JSON.stringify(all)).not.toContain('fortytwo')
      expect(readdirSync(join(w.dir, 'outbox'))).toEqual([])
    } finally {
      s.proc.kill()
    }
  }, 30_000)
})
