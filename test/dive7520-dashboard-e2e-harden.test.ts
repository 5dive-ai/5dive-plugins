// DIVE-7520: the box side of two fixes from the outside review.
//
//   * PIN: once a seat has seen encrypted chat on, a missing key dir is not
//     "off" but unknown (fail closed: nothing delivered, nothing sent in the
//     clear), and root saying "not on" is unknown too. Only the owner's
//     `sudo 5dive chat e2e disable` at the server (the root-owned `.off` mark)
//     turns it off.
//   * A LOST LIST: a device's approval changes the list, and posting the new
//     list fails. The message is NOT acked; the API offers it again, root
//     answers the retry with the same list (it applies nothing twice), and the
//     list is posted. Real server.ts against a fake API whose event post fails once.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as E from '../plugins/dashboard/e2e.ts'
import { E2EUnknown, makeE2EGate, parseEnvelope } from '../plugins/dashboard/chate2e.ts'
import { initBox } from './lib/chat-e2e-box-stub.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const STUB = join(import.meta.dir, 'lib', 'chat-e2e-box-stub.ts')
const TOKEN = 'tok-chat-e2e-7520'
const dec = new TextDecoder()

describe('pinned on (DIVE-7520)', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'dash-7520-'))
    const dir = join(root, 'chat-e2e')
    return { root, dir, pin: { file: join(root, 'e2e-pinned'), offMark: `${dir}.off` } }
  }
  const rootSays = (exit: number | null) => async () => {
    if (exit === null) return { on: true }
    throw new Error(`chat-e2e state failed (exit ${exit}): encrypted chat is not on on this server.`)
  }

  test('P1 never on: a missing dir is off, and nothing is pinned', async () => {
    const { dir, pin } = setup()
    expect(await makeE2EGate(dir, rootSays(4), 1000, Date.now, pin)()).toBe(false)
    expect(existsSync(pin.file)).toBe(false)
  })

  test('P2 seen on, then the dir is gone: unknown (throws), never off', async () => {
    const { dir, pin } = setup()
    mkdirSync(dir)
    const gate = makeE2EGate(dir, rootSays(4), 1000, Date.now, pin)
    expect(await gate()).toBe(true)
    expect(existsSync(pin.file)).toBe(true)
    rmSync(dir, { recursive: true })
    await expect(gate()).rejects.toBeInstanceOf(E2EUnknown)
    // A new process (a restart) still holds the pin.
    await expect(makeE2EGate(dir, rootSays(4), 1000, Date.now, pin)()).rejects.toBeInstanceOf(E2EUnknown)
  })

  test('P3 the owner turned it off at the server (the .off mark): off, and the pin goes', async () => {
    const { dir, pin } = setup()
    mkdirSync(dir)
    const gate = makeE2EGate(dir, rootSays(4), 1000, Date.now, pin)
    expect(await gate()).toBe(true)
    rmSync(dir, { recursive: true })
    writeFileSync(pin.offMark, 'off\n')
    expect(await gate()).toBe(false)
    expect(existsSync(pin.file)).toBe(false)
  })

  test('P4 without a pin the old rule holds: a missing dir is off (the control)', async () => {
    const { dir } = setup()
    mkdirSync(dir)
    const gate = makeE2EGate(dir, rootSays(4), 1000)
    expect(await gate()).toBe(true)
    rmSync(dir, { recursive: true })
    expect(await gate()).toBe(false)
  })

  test('P5 server.ts wires the pin into its gate', () => {
    const src = readFileSync(SERVER, 'utf8')
    expect(src).toMatch(/makeE2EGate\(E2E_DIR, e2eCall, undefined, undefined, \{ file: join\(STATE_DIR, 'e2e-pinned'\), offMark: /)
  })
})

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('a lost device list is posted again (DIVE-7520)', () => {
  test('S1 the post fails: not acked, offered again, root applies nothing twice, the list goes out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-7520-s1-'))
    for (const d of ['box', 'state', 'outbox', 'uploads/tap']) mkdirSync(join(dir, d), { recursive: true })
    const phone = await E.newIdentity(), tablet = await E.newIdentity()
    const phoneRaw = await E.exportPublic(phone.publicKey), tabletRaw = await E.exportPublic(tablet.publicKey)
    const boxRaw = await initBox(join(dir, 'box'), { 'dev-phone': phoneRaw })
    const boxPub = await E.importPublic(boxRaw)
    const approve = JSON.stringify(await E.seal({
      senderId: 'dev-phone', senderPriv: phone.privateKey, recipients: [{ id: 'box', pub: boxPub }],
      conv: 'dashboard', msgId: 'c-7520', dir: 'in', plaintext: JSON.stringify({ t: 'approve', device: 'dev-tablet', pub: tabletRaw, rev: 0 }),
    }))
    const queue: Array<Record<string, unknown>> = [{ id: 1, text: approve, chat_id: 'dashboard', ts: '2026-11-02T00:00:01Z' }]
    const events: Array<{ body: string }> = []
    const acked: number[] = []
    let failEvents = 1
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
          if (failEvents-- > 0) return new Response('down', { status: 503 })
          events.push((await req.json()) as { body: string })
          return Response.json({ id: 90 + events.length })
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
        DASHBOARD_CHAT_E2E_DIR: join(dir, 'box'),
        DASHBOARD_E2E_ARGV: JSON.stringify(['bun', STUB, join(dir, 'box')]),
        DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
        DASHBOARD_REDELIVERY_BACKOFF_MS: '0',
        CONNECTORD_TOKEN: TOKEN,
        USER: 'agent-tap',
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '0' } } })
    void (async () => {
      const reader = proc.stdout.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) return; if (dec.decode(value).includes('"id":1')) send({ jsonrpc: '2.0', method: 'notifications/initialized' }) }
    })()
    const log = () => { try { return readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8') } catch { return '' } }
    try {
      expect(await waitFor(() => log().includes('posting it failed (offered again)'), 15_000)).toBe(true)
      expect(acked).toEqual([])
      // The API still holds it and offers it again.
      queue.push({ id: 1, text: approve, chat_id: 'dashboard', ts: '2026-11-02T00:00:01Z' })
      writeFileSync(join(dir, 'state', 'collect-now', 'nudge'), String(Date.now()))
      expect(await waitFor(() => acked.includes(1) && events.length === 1, 15_000)).toBe(true)
      const list = JSON.parse(await E.openText({ env: parseEnvelope(events[0].body)!, myId: 'dev-phone', myPriv: phone.privateKey, senderPub: boxPub, expect: { conv: 'dashboard', dir: 'out' } }))
      expect(list).toMatchObject({ t: 'roster', n: 1 })
      expect(list.devices.map((d: { id: string }) => d.id).sort()).toEqual(['dev-phone', 'dev-tablet'])
      // Applied once: the retry did not bump the revision again.
      expect(JSON.parse(readFileSync(join(dir, 'box', 'roster.json'), 'utf8')).n).toBe(1)
    } finally {
      proc.kill()
      api.stop(true)
    }
  }, 45_000)
})
