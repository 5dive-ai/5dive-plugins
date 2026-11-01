// DIVE-7443: voice mode inside an encrypted self-host chat.
//
// The app uploads each clip as a sealed voice note (an envelope naming a
// sealed audio blob) and asks this box to hear it on the agent's long poll.
// The box opens it, hears it with the local engine, and answers the API with
// the words SEALED to the approved devices: ciphertext, "" for no words, or
// null. The note the app then sends carries the words, so the box hands the
// session the words and never opens the audio again.
//
// Negative controls: no engine → no `hear=1`; a plaintext clip, or one sealed
// by a device the box does not know, is never heard (null).
// Driven as a REAL server.ts process against a stub control plane and the
// root verb's stand-in (lib/chat-e2e-box-stub.ts).

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as E from '../plugins/dashboard/e2e.ts'
import { makeChatE2E, parseEnvelope } from '../plugins/dashboard/chate2e.ts'
import { initBox, makeBoxStub } from './lib/chat-e2e-box-stub.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const STUB = join(import.meta.dir, 'lib', 'chat-e2e-box-stub.ts')
const TOKEN = 'tok-e2e-voice-abcdef'
const CONV = '42'

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

async function device() {
  const kp = await E.newIdentity()
  return { kp, raw: await E.exportPublic(kp.publicKey) }
}

async function world(engine: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-e2e-voice-'))
  for (const d of ['box', 'state', 'outbox', 'uploads/olivia']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'chat-only'), 'API=http://x\nLINKED_AT=0\n')
  const phone = await device(), laptop = await device(), stranger = await device()
  const boxPub = await E.importPublic(await initBox(join(dir, 'box'), { 'dev-phone': phone.raw, 'dev-laptop': laptop.raw }))
  // The stand-in engine: a clip that says NOISE has no words; else words.
  const bin = join(dir, '5dive-transcribe')
  if (engine) {
    writeFileSync(bin, `#!/usr/bin/env bash\n[[ "$1" == -- ]] || exit 9\nc=$(cat "$2"); [[ "$c" == *NOISE* ]] && exit 0\nprintf '  what is\\n on   today  \\n'\n`)
    chmodSync(bin, 0o755)
  }
  const recipients = [{ id: 'box', pub: boxPub }, { id: 'dev-laptop', pub: laptop.kp.publicKey }]
  let n = 0
  // What the app uploads: the audio as a blob, and the note's envelope naming it.
  const note = async (audio: string, text = '[voice note]', from = phone, sender = 'dev-phone') => {
    const m = `c-${++n}`
    const blob = join(dir, 'uploads', 'olivia', `17615500000${String(n).padStart(2, '0')}-b${n}.e2e`)
    const env = await E.seal({ senderId: sender, senderPriv: from.kp.privateKey, recipients, conv: CONV, msgId: `${m}#f0`, dir: 'in', plaintext: audio })
    const body = async (t: string) => JSON.stringify(await E.seal({
      senderId: sender, senderPriv: from.kp.privateKey, recipients, conv: CONV, msgId: m, dir: 'in',
      plaintext: JSON.stringify({ t: 'msg', text: t, files: [{ path: blob, name: 'voice-note.wav', size: audio.length }] }),
    }))
    return { m, blob, blobText: JSON.stringify(env), body: await body(text), withWords: body }
  }
  const read = async (body: string, who = laptop, id = 'dev-laptop') =>
    JSON.parse(await E.openText({ env: parseEnvelope(body)!, myId: id, myPriv: who.kp.privateKey, senderPub: boxPub, expect: { conv: CONV, dir: 'out' } }))
  return { dir, bin, phone, laptop, stranger, note, read }
}

function startApi(uploads: Record<string, string>) {
  const polls: string[] = []
  const fetched: string[] = []
  const heard: Array<{ agent: string; id: string; text: string | null }> = []
  const queue: Array<Record<string, unknown>> = []
  let jobs: Array<{ id: string; path: string }> = []
  let wake: (() => void) | null = null
  const api = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 })
      if (url.pathname === '/server/messages/pending') {
        polls.push(url.search)
        const hears = url.searchParams.get('hear') === '1'
        const wait = Number(url.searchParams.get('wait') ?? 0)
        if (wait > 0 && !(hears && jobs.length) && queue.length === 0) {
          await new Promise<void>(r => { wake = r; setTimeout(r, 2_000) })
          wake = null
        }
        const hear = hears ? jobs : []
        if (hears) jobs = []
        return Response.json({ pending: queue.splice(0), ...(hear.length ? { hear } : {}) })
      }
      if (url.pathname === '/server/messages/pending/ack') return Response.json({ ok: true })
      if (url.pathname === '/server/selfhost/files' && req.method === 'GET') {
        const p = url.searchParams.get('path') ?? ''
        fetched.push(p)
        return p in uploads ? new Response(uploads[p]) : Response.json({ error: 'not held' }, { status: 404 })
      }
      if (url.pathname === '/server/selfhost/heard') {
        heard.push((await req.json()) as (typeof heard)[number])
        return Response.json({ ok: true })
      }
      if (url.pathname === '/server/messages/event' || url.pathname === '/server/messages/status') return Response.json({ id: 1 })
      return new Response('not found', { status: 404 })
    },
  })
  return {
    api, polls, fetched, heard,
    ask: (j: { id: string; path: string }) => { jobs.push(j); wake?.() },
    offer: (m: Record<string, unknown>) => { queue.push(m); wake?.() },
  }
}

function startAdapter(w: Awaited<ReturnType<typeof world>>, port: number) {
  const envFile = join(w.dir, 'connectord.env')
  writeFileSync(envFile, `CONNECTORD_TOKEN=${TOKEN}\n`)
  const delivered: Array<{ content: string; meta: Record<string, unknown> }> = []
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(w.dir, 'state'),
      DASHBOARD_OUTBOX: join(w.dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(w.dir, 'uploads'),
      DASHBOARD_CHAT_ONLY_MARKER: join(w.dir, 'chat-only'),
      DASHBOARD_CHAT_E2E_DIR: join(w.dir, 'box'),
      DASHBOARD_E2E_ARGV: JSON.stringify(['bun', STUB, join(w.dir, 'box')]),
      DASHBOARD_TRANSCRIBE: w.bin,
      DASHBOARD_LONGPOLL_BACKOFF_MS: '50',
      DASHBOARD_API_BASE: `http://127.0.0.1:${port}`,
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      USER: 'agent-olivia',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-voice-test', version: '0' } } })
  void (async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
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
          if (msg.method === 'notifications/claude/channel') delivered.push({ content: String(msg.params?.content ?? ''), meta: msg.params?.meta ?? {} })
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        } catch {}
      }
    }
  })()
  return { proc, delivered }
}

describe('box side: a voice note it already heard carries its words (DIVE-7443)', () => {
  test('V1 "[voice note] <words>": the words, its audio not opened; a bare "[voice note]": the audio opens', async () => {
    const w = await world(true)
    const box = makeBoxStub(join(w.dir, 'box'))
    const fetched: string[] = []
    const e2e = makeChatE2E({ call: box.call, stateDir: join(w.dir, 'state'), agent: 'olivia', uploadsDir: join(w.dir, 'uploads'), fetchFile: async p => { fetched.push(p) } })
    try {
      const a = await w.note('speech')
      writeFileSync(a.blob, a.blobText)
      const heard = await e2e.admit(await a.withWords('[voice note] what is on today'), CONV) as { kind: string; text: string; files: string[] }
      expect(heard).toMatchObject({ kind: 'deliver', text: '[voice note] what is on today', files: [] })
      expect(fetched).toEqual([])
      const b = await w.note('speech')
      writeFileSync(b.blob, b.blobText)
      const unheard = await e2e.admit(b.body, CONV) as { kind: string; text: string; files: string[] }
      expect(unheard.kind).toBe('deliver')
      expect(unheard.text).toBe('[voice note]')
      expect(unheard.files).toHaveLength(1)
      expect(readFileSync(unheard.files[0], 'utf8')).toBe('speech')
    } finally {
      rmSync(w.dir, { recursive: true, force: true })
    }
  })
})

describe('dashboard adapter hears voice mode in an encrypted chat, real server.ts (DIVE-7443)', () => {
  test('H1-H4 says hear=1, hears the sealed clip, answers sealed words / "" / null, then the note reaches the session as words', async () => {
    const w = await world(true)
    const speech = await w.note('speech')
    const noise = await w.note('NOISE')
    const stray = await w.note('speech', '[voice note]', w.stranger, 'dev-stranger')
    const plain = join(w.dir, 'uploads', 'olivia', '1761550000099-voice.wav')
    const hearPath = (n: number) => join(w.dir, 'uploads', 'olivia', `17615500001${n}0-h${n}.e2e`)
    const s = startApi({
      [hearPath(1)]: speech.body, [speech.blob]: speech.blobText,
      [hearPath(2)]: noise.body, [noise.blob]: noise.blobText,
      [hearPath(3)]: stray.body, [stray.blob]: stray.blobText,
      [plain]: 'speech',
    })
    const a = startAdapter(w, s.api.port)
    try {
      // H1: an encrypted chat-only box with an engine says it hears.
      expect(await waitFor(() => s.polls.some(q => q.includes('wait=25') && q.includes('hear=1')), 15_000)).toBe(true)

      // H2: the sealed clip is heard; the API gets the words sealed, never in the clear.
      s.ask({ id: 'j1', path: hearPath(1) })
      expect(await waitFor(() => s.heard.length === 1, 10_000)).toBe(true)
      const sealed = s.heard[0]
      expect(sealed.id).toBe('j1')
      expect(typeof sealed.text).toBe('string')
      expect(JSON.stringify(sealed)).not.toContain('today')
      expect(parseEnvelope(sealed.text)).not.toBeNull()
      expect(await w.read(sealed.text!)).toMatchObject({ t: 'msg', text: 'what is on today' })
      expect(await w.read(sealed.text!, w.phone, 'dev-phone')).toMatchObject({ text: 'what is on today' })
      // Neither the opened audio nor the fetched envelope stays on the box.
      expect(existsSync(hearPath(1))).toBe(false)
      const opened = join(w.dir, 'state', 'e2e-files')
      expect(existsSync(opened) ? readdirSync(opened) : []).toEqual([])

      // H3: noise answers ""; a plaintext clip and a stranger's clip are never heard.
      s.ask({ id: 'j2', path: hearPath(2) })
      s.ask({ id: 'j3', path: hearPath(3) })
      s.ask({ id: 'j4', path: plain })
      expect(await waitFor(() => s.heard.length === 4, 10_000)).toBe(true)
      expect(s.heard.find(h => h.id === 'j2')!.text).toBe('')
      expect(s.heard.find(h => h.id === 'j3')!.text).toBe(null)
      expect(s.heard.find(h => h.id === 'j4')!.text).toBe(null)
      await Bun.sleep(300)
      expect(a.delivered).toEqual([])
      const log = readFileSync(join(w.dir, 'state', 'lifecycle.log'), 'utf8')
      expect(log).toContain('hands-free: heard')
      expect(log).toContain('words, sealed')
      expect(log).not.toContain('what is on today')

      // H4: the note the app sends carries the words; the session reads them as a voice note.
      const before = s.fetched.length
      s.offer({ id: 7, text: await speech.withWords('[voice note] what is on today'), chat_id: CONV, ts: '2026-11-01T01:00:00Z' })
      expect(await waitFor(() => a.delivered.length === 1, 10_000)).toBe(true)
      expect(a.delivered[0].content).toBe('[voice note] what is on today')
      expect(a.delivered[0].meta.audio_path).toBeUndefined()
      expect(s.fetched.slice(before)).not.toContain(speech.blob)
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(w.dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('negative control: no engine on the encrypted box, so it never says hear=1', async () => {
    const w = await world(false)
    const s = startApi({})
    const a = startAdapter(w, s.api.port)
    try {
      expect(await waitFor(() => s.polls.filter(q => q.includes('wait=25')).length >= 2, 15_000)).toBe(true)
      expect(s.polls.some(q => q.includes('hear=1'))).toBe(false)
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(w.dir, { recursive: true, force: true })
    }
  }, 30_000)
})
