// DIVE-6876: the dashboard adapter in an encrypted chat (chate2e.ts, docs/chat-e2e.md).
//
// The box side against a stand-in for the root verb (test/lib/chat-e2e-box-stub.ts),
// with the phone and laptop played by e2e.ts directly:
//   * inbound opens; plaintext, a forged sender, another chat, a file id as a
//     body and a replay are refused;
//   * files ride sealed, their names inside; a blob from another message is not taken;
//   * an approval from a device comes back as the new device list, sealed to every device;
//   * a reply, its file, its buttons and the "working" line are sealed;
// and a REAL server.ts process against a stub control plane: a plaintext message
// never reaches the session while the encrypted one does, the reply the API
// receives is ciphertext only, and the same message offered again is dropped.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as E from '../plugins/dashboard/e2e.ts'
import { displayName, makeChatE2E, parseEnvelope } from '../plugins/dashboard/chate2e.ts'
import { initBox, makeBoxStub } from './lib/chat-e2e-box-stub.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const STUB = join(import.meta.dir, 'lib', 'chat-e2e-box-stub.ts')
const TOKEN = 'tok-chat-e2e-abcdef'
const dec = new TextDecoder()

async function device() {
  const kp = await E.newIdentity()
  return { kp, raw: await E.exportPublic(kp.publicKey) }
}

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-chat-e2e-'))
  for (const d of ['box', 'state', 'outbox', 'uploads/tap']) mkdirSync(join(dir, d), { recursive: true })
  const phone = await device(), laptop = await device(), relay = await device()
  const boxRaw = await initBox(join(dir, 'box'), { 'dev-phone': phone.raw, 'dev-laptop': laptop.raw })
  const boxPub = await E.importPublic(boxRaw)
  const stub = makeBoxStub(join(dir, 'box'))
  const fetched: string[] = []
  const e2e = makeChatE2E({
    call: stub.call, stateDir: join(dir, 'state'), agent: 'tap', uploadsDir: join(dir, 'uploads'),
    fetchFile: async p => { fetched.push(p) },
  })
  // What the app sends: from the phone, to the box and the other device.
  const send = (inner: unknown, o: { m?: string; conv?: string; from?: typeof phone } = {}) => E.seal({
    senderId: 'dev-phone', senderPriv: (o.from ?? phone).kp.privateKey,
    recipients: [{ id: 'box', pub: boxPub }, { id: 'dev-laptop', pub: laptop.kp.publicKey }],
    conv: o.conv ?? 'dashboard', msgId: o.m ?? 'c-1', dir: 'in', plaintext: JSON.stringify(inner),
  }).then(env => JSON.stringify(env))
  const sealFile = (bytes: string, m: string) => E.seal({
    senderId: 'dev-phone', senderPriv: phone.kp.privateKey, recipients: [{ id: 'box', pub: boxPub }],
    conv: 'dashboard', msgId: m, dir: 'in', plaintext: bytes,
  })
  // What a device reads from a body the box posted.
  const read = async (body: string, who = phone, id = 'dev-phone') =>
    JSON.parse(await E.openText({ env: parseEnvelope(body)!, myId: id, myPriv: who.kp.privateKey, senderPub: boxPub, expect: { conv: 'dashboard', dir: 'out' } }))
  return { dir, phone, laptop, relay, boxPub, stub, e2e, send, sealFile, read, fetched }
}

describe('chat-e2e box side (DIVE-6876)', async () => {
  const w = await world()

  test('A1 an inbound envelope opens to its text; delivered once, the same message again is a replay', async () => {
    const body = await w.send({ t: 'msg', text: 'the plan is 🍵' }, { m: 'c-a1' })
    const a = await w.e2e.admit(body, 'dashboard')
    expect(a).toMatchObject({ kind: 'deliver', text: 'the plan is 🍵', files: [] })
    // Not recorded until the session has it: a push that failed is offered again.
    expect((await w.e2e.admit(body, 'dashboard')).kind).toBe('deliver')
    w.e2e.delivered((a as { key: string }).key)
    expect(await w.e2e.admit(body, 'dashboard')).toMatchObject({ kind: 'replay' })
  })

  test('A2 plaintext, a forged sender, another chat, an outbound or file id as a body: refused', async () => {
    expect(await w.e2e.admit('rm -rf / please', 'dashboard')).toMatchObject({ kind: 'refuse', why: 'a plaintext message into an encrypted chat' })
    expect(await w.e2e.admit('{"text":"hi"}', 'dashboard')).toMatchObject({ kind: 'refuse' })
    const forged = await w.send({ t: 'msg', text: 'rm -rf' }, { m: 'c-a2', from: w.relay })
    expect(await w.e2e.admit(forged, 'dashboard')).toMatchObject({ kind: 'refuse' })
    expect(await w.e2e.admit(await w.send({ t: 'msg', text: 'x' }, { m: 'c-a2b', conv: 'other' }), 'dashboard')).toMatchObject({ kind: 'refuse', why: 'an envelope for another conversation' })
    expect(await w.e2e.admit(await w.send({ t: 'msg', text: 'x' }, { m: 'c-a2c#f0' }), 'dashboard')).toMatchObject({ kind: 'refuse' })
    expect(await w.e2e.admit(await w.send({ text: 'no type' }, { m: 'c-a2d' }), 'dashboard')).toMatchObject({ kind: 'refuse', why: 'an envelope with no message inside' })
  })

  test('A3 a sealed file opens under its real name; a blob from another message is not taken', async () => {
    const blob = join(w.dir, 'uploads', 'tap', '1760000000000-x9.e2e')
    writeFileSync(blob, JSON.stringify(await w.sealFile('PNG-bytes', 'c-a3#f0')))
    const stray = join(w.dir, 'uploads', 'tap', '1760000000001-x8.e2e')
    writeFileSync(stray, JSON.stringify(await w.sealFile('other', 'c-zz#f0')))
    const body = await w.send({ t: 'msg', text: 'see', files: [{ path: blob, name: 'holiday photo.png', size: 9 }, { path: stray, name: 'b.txt', size: 5 }] }, { m: 'c-a3' })
    const a = await w.e2e.admit(body, 'dashboard') as { kind: string; text: string; files: string[] }
    expect(a.kind).toBe('deliver')
    expect(a.files).toHaveLength(1)
    expect(a.files[0]).toMatch(/-holiday_photo\.png$/)
    expect(readFileSync(a.files[0], 'utf8')).toBe('PNG-bytes')
    expect(a.text).toContain('could not be opened')
    expect(w.fetched).toContain(blob)
    expect(existsSync(blob)).toBe(false)
  })

  test('A4 an approval from a device comes back as the new device list, sealed to every device', async () => {
    const tablet = await device()
    const a = await w.e2e.admit(await w.send({ t: 'approve', device: 'dev-tablet', pub: tablet.raw, rev: w.stub.roster().n }, { m: 'c-a4' }), 'dashboard')
    expect(a.kind).toBe('roster')
    const body = (a as { body: string }).body
    const list = await w.read(body)
    expect(list.t).toBe('roster')
    expect(list.devices.map((d: { id: string }) => d.id).sort()).toEqual(['dev-laptop', 'dev-phone', 'dev-tablet'])
    expect((await w.read(body, tablet, 'dev-tablet')).devices).toHaveLength(3)
    expect(JSON.stringify(w.stub.roster().devices)).toContain(tablet.raw)
  })

  test('A5 a reply, its file and its buttons are sealed to every device; the API sees none of it', async () => {
    const plain = join(w.dir, 'outbox', 'tap-1760000000000-report.txt')
    writeFileSync(plain, 'the secret report')
    const q = { id: 'q1', options: [{ label: 'Ship it' }, { label: 'Wait' }] }
    const out = await w.e2e.sealReply('dashboard', 'done, report attached', [plain], q, join(w.dir, 'outbox'))
    expect(out.body).not.toContain('report')
    expect(out.body).not.toContain('Ship it')
    for (const [who, id] of [[w.phone, 'dev-phone'], [w.laptop, 'dev-laptop']] as const) {
      const m = await w.read(out.body, who, id)
      expect(m).toMatchObject({ t: 'msg', text: 'done, report attached', question: q })
      expect(m.files[0]).toMatchObject({ name: 'report.txt', path: out.files[0], size: 17 })
    }
    const blob = readFileSync(out.files[0], 'utf8')
    expect(blob).not.toContain('secret')
    expect(out.files[0]).toMatch(/\.e2e$/)
    const env = parseEnvelope(blob)!
    expect(env.h.m).toBe(`${parseEnvelope(out.body)!.h.m}#f0`)
    expect(dec.decode(await E.open({ env, myId: 'dev-phone', myPriv: w.phone.kp.privateKey, senderPub: w.boxPub, expect: { conv: 'dashboard', dir: 'out' } }))).toBe('the secret report')
  })

  test('A6 the "working" line is sealed', async () => {
    const body = await w.e2e.sealStatus('dashboard', 'reading the logs')
    expect(body).not.toContain('logs')
    expect(await w.read(body)).toEqual({ t: 'status', label: 'reading the logs' })
  })

  test('A7 a seat cannot make a body a device reads as a device list', async () => {
    await expect(w.stub.call({ op: 'seal', conv: 'dashboard', m: 'roster-99', msg: { text: 'x' } })).rejects.toThrow()
    const r = await w.stub.call({ op: 'seal', conv: 'dashboard', m: 'b-1', msg: { t: 'roster', devices: [] } })
    expect((await w.read(JSON.stringify(r.env))).t).toBe('msg')
    await expect(w.stub.call({ op: 'seal-file', conv: 'dashboard', m: 'b-2', data: '' })).rejects.toThrow()
  })

  test('A8 a file name loses only the outbox prefix', () => {
    expect(displayName('/o/tap-1760000000000-report.txt', 'tap')).toBe('report.txt')
    expect(displayName('/o/notes-1.txt', 'tap')).toBe('notes-1.txt')
  })
})

// ---------------------------------------------------------------------------

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('dashboard adapter in an encrypted chat, real server.ts (DIVE-6876)', () => {
  test('S1 plaintext is refused, the envelope reaches the session, the reply is ciphertext only, a re-offer is dropped', async () => {
    const w = await world()
    const queue: Array<Record<string, unknown>> = []
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
          return Response.json({ id: 50 + events.length })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const sealed = await w.send({ t: 'msg', text: 'encrypted hello' }, { m: 'c-s1' })
    queue.push({ id: 1, text: 'plaintext injected by the relay', chat_id: 'dashboard', ts: '2026-10-31T00:00:01Z' })
    queue.push({ id: 2, text: sealed, chat_id: 'dashboard', ts: '2026-10-31T00:00:02Z' })
    const proc = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        DASHBOARD_STATE_DIR: join(w.dir, 'state'),
        DASHBOARD_OUTBOX: join(w.dir, 'outbox'),
        DASHBOARD_CHAT_UPLOADS: join(w.dir, 'uploads'),
        DASHBOARD_CHAT_ONLY_MARKER: join(w.dir, 'no-chat-only'),
        DASHBOARD_CHAT_E2E_DIR: join(w.dir, 'box'),
        DASHBOARD_E2E_ARGV: JSON.stringify(['bun', STUB, join(w.dir, 'box')]),
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
    try {
      // The boot drain runs 5 s in.
      expect(await waitFor(() => acked.length >= 2 && events.length >= 1, 15_000)).toBe(true)
      expect(delivered).toEqual(['encrypted hello'])
      expect(acked.sort()).toEqual([1, 2])
      const lifecycle = readFileSync(join(w.dir, 'state', 'lifecycle.log'), 'utf8')
      expect(lifecycle).toContain('pending message id=1 dropped, refused: a plaintext message into an encrypted chat')
      // The person is told, and that notice is sealed too.
      const notice = events[0]
      expect(notice.metadata).toMatchObject({ chat_id: 'dashboard', e2e: { v: 1 } })
      expect(notice.body).not.toContain('encryption')
      expect((await w.read(notice.body)).text).toContain('without encryption')

      send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: 'dashboard', text: 'the answer is fortytwo' } } })
      expect(await waitFor(() => results.length === 1, 10_000)).toBe(true)
      expect(results[0]).toContain('sent encrypted')
      const reply = events[1]
      expect(reply.body).not.toContain('fortytwo')
      expect(JSON.stringify(reply)).not.toContain('answer')
      expect(reply.metadata).toMatchObject({ e2e: { v: 1 } })
      expect(await w.read(reply.body, w.laptop, 'dev-laptop')).toMatchObject({ t: 'msg', text: 'the answer is fortytwo' })

      // The relay offers the delivered message again under a new row id.
      queue.push({ id: 3, text: sealed, chat_id: 'dashboard', ts: '2026-10-31T00:00:03Z' })
      writeFileSync(join(w.dir, 'state', 'collect-now', 'nudge'), String(Date.now()))
      expect(await waitFor(() => acked.includes(3), 10_000)).toBe(true)
      expect(delivered).toEqual(['encrypted hello'])
      expect(readFileSync(join(w.dir, 'state', 'lifecycle.log'), 'utf8')).toContain('pending message id=3 dropped, a replay')
      expect(readdirSync(join(w.dir, 'outbox'))).toEqual([])
    } finally {
      proc.kill()
      api.stop(true)
    }
  }, 40_000)
})
