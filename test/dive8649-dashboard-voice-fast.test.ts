// DIVE-8649: lodar's test version of faster voice answers, behind a per-box
// labs file that is absent everywhere else (voicefast.ts).
//
// Pure arms: the switch's parse, the clock, the timing line (timings only).
// Process arms drive the REAL adapter through the root-relay stand-in:
//   - no labs file: the same two posts as before, and nothing logged;
//   - `fast`: the speech starts BEFORE the text is posted, not after;
//   - `fast` and the text fails: no voice note goes, and its file is removed;
//   - `timing`: one line per voice reply, timed from the voice note's hand-over.
// it2 (the API path, a Bun.serve stand-in that keeps each post's metadata):
//   - `split`: the text, then the first sentence's note, then the rest's, each
//     tagged { turn, n, of }; a one-sentence reply is one untagged note;
//   - `loaded`: the reply tool is listed with anthropic/alwaysLoad; off: no _meta.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VOICE_TURN_MAX_MS,
  appendVoiceTiming,
  makeVoiceClock,
  readVoiceLabs,
  splitFirstSentence,
  voiceTimingLine,
} from '../plugins/dashboard/voicefast.ts'
import { VOICE_ONLY_BODY } from '../plugins/dashboard/voicenote.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('voicefast.ts', () => {
  test('the labs file: missing is off; known words on; comments and unknown words ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'labs-'))
    try {
      const f = join(dir, 'labs')
      expect([...readVoiceLabs(f)]).toEqual([])
      writeFileSync(f, '')
      expect([...readVoiceLabs(f)]).toEqual([])
      writeFileSync(f, '# fast\ntiming\n')
      expect([...readVoiceLabs(f)]).toEqual(['timing'])
      writeFileSync(f, 'timing, fast  # DIVE-8649 lodar only\nturbo\n')
      expect([...readVoiceLabs(f)].sort()).toEqual(['fast', 'timing'])
      writeFileSync(f, 'timing split loaded\n')
      expect([...readVoiceLabs(f)].sort()).toEqual(['loaded', 'split', 'timing'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the clock gives a chat its hand-over time once, and not when stale', () => {
    const c = makeVoiceClock()
    c.heard('33', 1_000)
    expect(c.take('34', 2_000)).toBeNull()
    expect(c.take('33', 2_000)).toBe(1_000)
    expect(c.take('33', 2_000)).toBeNull()
    c.heard('33', 1_000)
    expect(c.take('33', 1_000 + VOICE_TURN_MAX_MS + 1)).toBeNull()
  })

  test('the timing line holds durations and the chat id only', () => {
    const line = voiceTimingLine({ chat: '33', fast: true, heardAt: 1_000, replyAt: 4_000, textAt: 4_300, speakAt: 4_000, spokeAt: 5_500, sentAt: 5_900 },
      new Date('2026-11-17T12:00:00Z'))
    expect(JSON.parse(line)).toEqual({
      at: '2026-11-17T12:00:00.000Z', chat: '33', fast: true,
      agent_ms: 3_000, text_ms: 300, speak_ms: 1_500, after_text_ms: 1_200, voice_ms: 400, box_ms: 4_900, reply_ms: 1_900, ok: true,
    })
    const unsent = JSON.parse(voiceTimingLine({ chat: '33', fast: false, heardAt: null, replyAt: 4_000, textAt: 4_300, speakAt: 4_300, spokeAt: 5_500, sentAt: null }))
    expect(unsent.agent_ms).toBeNull()
    expect(unsent.box_ms).toBeNull()
    expect(unsent.ok).toBe(false)
  })

  test('split: the first sentence and the rest; too short a first piece runs on; one sentence is not split', () => {
    expect(splitFirstSentence('Yes, Friday at ten works. I have put it in the calendar and told Anna.'))
      .toEqual(['Yes, Friday at ten works.', 'I have put it in the calendar and told Anna.'])
    // Russian must split the same way.
    expect(splitFirstSentence('Да, в пятницу в десять подходит. Я уже добавил это в календарь.'))
      .toEqual(['Да, в пятницу в десять подходит.', 'Я уже добавил это в календарь.'])
    expect(splitFirstSentence('Ok. Sure! The meeting is on Friday at ten. Anna is coming too.'))
      .toEqual(['Ok. Sure! The meeting is on Friday at ten.', 'Anna is coming too.'])
    expect(splitFirstSentence('Here is the plan for Friday\nAnna comes at ten, Bob at noon.'))
      .toEqual(['Here is the plan for Friday', 'Anna comes at ten, Bob at noon.'])
    expect(splitFirstSentence('Friday at ten works for me.')).toBeNull()
    expect(splitFirstSentence('Friday at ten works for me. Bye.')).toBeNull()
    expect(splitFirstSentence('The price is 3.5 euros per month for that.')).toBeNull()
    expect(splitFirstSentence('x'.repeat(300) + '. And then the rest of it.')).toBeNull()
  })

  test('a split reply logs its parts and when the first one went', () => {
    const t = JSON.parse(voiceTimingLine({ chat: '33', fast: true, heardAt: 1_000, replyAt: 4_000, textAt: 4_300, speakAt: 4_000, spokeAt: 4_800, sentAt: 6_000, firstSentAt: 4_900, parts: 2 }))
    expect(t.parts).toBe(2)
    expect(t.first_ms).toBe(900)
    expect(t.first_box_ms).toBe(3_900)
    expect('parts' in JSON.parse(voiceTimingLine({ chat: '33', fast: true, heardAt: null, replyAt: 0, textAt: 0, speakAt: 0, spokeAt: 0, sentAt: 0 }))).toBe(false)
  })

  test('the log keeps the newest lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-'))
    try {
      const f = join(dir, 'sub', 'voice-timing.log')
      for (let i = 0; i < 25; i++) appendVoiceTiming(f, `{"n":${i}}`, 5)
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
      expect(lines.length).toBeLessThanOrEqual(10)
      expect(lines.at(-1)).toBe('{"n":24}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The root-relay stand-in. A text event waits delayMs before it answers, so a
// speech started before it is visible; `event` answers 500 when failText is set.
// holdForSpeechMs: the text post stays in flight until the speak-start mark
// appears, so "speech starts while the text is being posted" is an order set by
// that event, not by a timer. The ceiling only bounds a sequential adapter,
// which never starts the speech while the text is held: it waits the ceiling
// out, posts the text, then speaks, and the order check fails. Keep it far
// above any runner's start-up (DIVE-9203: 5 s was not, on a slow runner).
// speakDelayMs: the stand-in 5dive-speak waits this long before its mark,
// as a slow runner's process start does.
type RelayOpts = { delayMs?: number; failText?: boolean; holdForSpeechMs?: number; speakDelayMs?: number }
const SPEECH_HOLD_MS = 20_000
function writeRelay(dir: string, opts: RelayOpts = {}): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
if (op[0] === 'event' && op[2] !== ${JSON.stringify(VOICE_ONLY_BODY)}) {
  appendFileSync(dir + '/marks.log', 'text-start ' + Date.now() + '\\n')
  const holdUntil = Date.now() + ${opts.holdForSpeechMs ?? 0}
  while (Date.now() < holdUntil) {
    let m = ''
    try { m = readFileSync(dir + '/marks.log', 'utf8') } catch {}
    if (m.includes('speak-start ')) break
    await Bun.sleep(10)
  }
  await Bun.sleep(${opts.delayMs ?? 0})
  if (${opts.failText ? 'true' : 'false'}) { appendFileSync(dir + '/ops.log', JSON.stringify(['failed', ...op]) + '\\n'); process.stdout.write('500\\n{"error":"down"}'); process.exit(0) }
  appendFileSync(dir + '/marks.log', 'text-done ' + Date.now() + '\\n')
}
appendFileSync(dir + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') process.stdout.write('200\\n{"pending":[]}')
else if (op[0] === 'ack') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'event') process.stdout.write('200\\n{"id":41}')
else { process.stderr.write('unknown op\\n'); process.exit(1) }
`)
  return file
}

function ops(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function marks(dir: string): Record<string, number> {
  const p = join(dir, 'marks.log')
  const out: Record<string, number> = {}
  if (!existsSync(p)) return out
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    const [k, v] = l.split(' ')
    out[k] ??= Number(v)
  }
  return out
}

// A stand-in 5dive-speak that marks when it started and takes 300 ms.
function writeSpeak(dir: string, startDelayMs = 0): string {
  const file = join(dir, '5dive-speak')
  const out = join(dir, 'speak-out.ogg')
  writeFileSync(file, `#!/usr/bin/env bash
${startDelayMs > 0 ? `sleep ${startDelayMs / 1000}\n` : ''}echo "speak-start $(date +%s%3N)" >> ${JSON.stringify(join(dir, 'marks.log'))}
sleep 0.3
printf 'OggS' > ${JSON.stringify(out)}
echo ${JSON.stringify(out)}
`)
  chmodSync(file, 0o755)
  return file
}

function writeFfmpeg(dir: string): string {
  const file = join(dir, 'ffmpeg')
  writeFileSync(file, `#!/usr/bin/env bash\nprintf 'ID3' > "\${@: -1}"\n`)
  chmodSync(file, 0o755)
  return file
}

function startAdapter(dir: string, relay: string, labs: string | null, speakDelayMs = 0) {
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const labsFile = join(dir, 'labs')
  if (labs !== null) writeFileSync(labsFile, labs)
  const delivered: string[] = []
  const results: string[] = []
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_FFMPEG: writeFfmpeg(dir),
      DASHBOARD_SPEAK: writeSpeak(dir, speakDelayMs),
      DASHBOARD_VOICE_LABS: labsFile,
      DASHBOARD_REPLY_RETRY_MS: '0',
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', relay]),
      USER: 'agent-theo',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fast-test', version: '0' } } })
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
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method === 'notifications/claude/channel') delivered.push(String(msg.params?.content ?? ''))
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (typeof msg.id === 'number' && msg.id >= 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  const reply = (text: string) => send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'reply', arguments: { chat_id: '33', text, voice: true } } })
  return { proc, delivered, results, send, reply }
}

const timingFile = (dir: string) => join(dir, 'state', 'voice-timing.log')

async function run(labs: string | null, opts: RelayOpts = {}, body?: (dir: string, a: ReturnType<typeof startAdapter>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-fast-'))
  const a = startAdapter(dir, writeRelay(dir, opts), labs, opts.speakDelayMs)
  try {
    expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
    await body?.(dir, a)
  } finally {
    a.proc.kill()
    await a.proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the test version, on and off (DIVE-8649)', () => {
  test('no labs file: text, then speech, then the voice note, as before; nothing is logged', async () => {
    await run(null, { delayMs: 400 }, async (dir, a) => {
      a.reply('Friday at ten.')
      expect(await waitFor(() => a.results.length >= 1, 10_000)).toBe(true)
      const events = ops(dir).filter(o => o[0] === 'event')
      expect(events.map(e => e[2])).toEqual(['Friday at ten.', VOICE_ONLY_BODY])
      const m = marks(dir)
      expect(m['speak-start']).toBeGreaterThanOrEqual(m['text-done'])
      expect(existsSync(timingFile(dir))).toBe(false)
    })
  }, 30_000)

  // One body, two runners: a quick speech start, and one that starts 7 s late
  // (past the old 5 s hold, which red-failed this arm on slow CI runners).
  const fastArm = (speakDelayMs: number) => run('fast\n', { delayMs: 400, holdForSpeechMs: SPEECH_HOLD_MS, speakDelayMs }, async (dir, a) => {
    a.reply('Friday at ten.')
    expect(await waitFor(() => a.results.length >= 1, SPEECH_HOLD_MS + 10_000)).toBe(true)
    const events = ops(dir).filter(o => o[0] === 'event')
    expect(events.map(e => e[2])).toEqual(['Friday at ten.', VOICE_ONLY_BODY])
    expect(events[1][3]).toEndWith('.mp3')
    const m = marks(dir)
    expect(m['speak-start']).toBeLessThan(m['text-done'])
    expect(a.results[0]).toContain('voice note sent')
    expect(existsSync(join(dir, 'speak-out.ogg'))).toBe(false)
    const t = JSON.parse(readFileSync(timingFile(dir), 'utf8').trim())
    expect(t.fast).toBe(true)
    expect(t.ok).toBe(true)
    expect(readFileSync(timingFile(dir), 'utf8')).not.toContain('Friday')
  })

  test('fast: the speech starts while the text is still being posted, and the same two posts go', () => fastArm(0), 60_000)

  test('fast, on a slow runner: a speech that starts 7 s late still starts before the text is done', () => fastArm(7_000), 60_000)

  test('fast, and the text is refused: no voice note is posted and the early speech file is removed', async () => {
    await run('fast\n', { failText: true }, async (dir, a) => {
      a.reply('Friday at ten.')
      expect(await waitFor(() => a.results.length >= 1, 10_000)).toBe(true)
      await Bun.sleep(600)
      expect(ops(dir).filter(o => o[0] === 'event')).toEqual([])
      expect(existsSync(join(dir, 'speak-out.ogg'))).toBe(false)
    })
  }, 30_000)

  test('timing: a voice note handed to the agent starts the clock; the reply logs every stage', async () => {
    await run('timing\n', {}, async (dir, a) => {
      const inbox = join(dir, 'state', 'agent-inbox')
      writeFileSync(join(inbox, '.tmp-v'), JSON.stringify({ text: '[voice note] are we on for friday', chat_id: '33', ts: '2026-11-17T12:00:00.000Z' }))
      renameSync(join(inbox, '.tmp-v'), join(inbox, '1-v.json'))
      expect(await waitFor(() => a.delivered.length >= 1, 5_000)).toBe(true)
      await Bun.sleep(200)
      a.reply('Yes, Friday at ten.')
      expect(await waitFor(() => a.results.length >= 1, 10_000)).toBe(true)
      const m = marks(dir)
      expect(m['speak-start']).toBeGreaterThanOrEqual(m['text-done'])
      const t = JSON.parse(readFileSync(timingFile(dir), 'utf8').trim())
      expect(t.fast).toBe(false)
      expect(t.ok).toBe(true)
      expect(t.agent_ms).toBeGreaterThanOrEqual(150)
      expect(t.speak_ms).toBeGreaterThanOrEqual(250)
      expect(t.box_ms).toBeGreaterThanOrEqual(t.agent_ms + t.speak_ms)
    })
  }, 30_000)
})

// --- it2: the API path keeps each post's metadata ----------------------------

const API_TOKEN = 'tok-voice-fast-abcdef'

// A stand-in 5dive-speak that writes a new file per call, named after its text's first word.
function writeSpeakEach(dir: string): string {
  const file = join(dir, '5dive-speak')
  writeFileSync(file, `#!/usr/bin/env bash
w=$(printf '%s' "$2" | tr -cd 'A-Za-z' | head -c 12)
out=${JSON.stringify(dir)}/speak-$w-$RANDOM.ogg
echo "speak $w $(date +%s%3N)" >> ${JSON.stringify(join(dir, 'speaks.log'))}
sleep 0.3
printf 'OggS' > "$out"
echo "$out"
`)
  chmodSync(file, 0o755)
  return file
}

type Posted = { agent: string; body: string; metadata: Record<string, unknown> }

async function runApi(labs: string | null, body: (dir: string, a: { posted: Posted[]; results: string[]; tools: unknown[]; reply: (text: string) => void }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-fast-api-'))
  const posted: Posted[] = []
  let pendingAsked = false
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get('authorization') !== `Bearer ${API_TOKEN}`) return new Response('unauthorized', { status: 401 })
      if (url.pathname === '/server/messages/pending') { pendingAsked = true; return Response.json({ pending: [] }) }
      if (url.pathname === '/server/messages/pending/ack') return Response.json({ ok: true, acked: 0 })
      if (url.pathname === '/server/messages/event') {
        const b = (await req.json()) as Posted
        // The text takes a while to post, so a part made before it lands would show up first.
        if (b.body !== VOICE_ONLY_BODY) await Bun.sleep(400)
        posted.push(b)
        return Response.json({ id: 100 + posted.length })
      }
      return new Response('not found', { status: 404 })
    },
  })
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const labsFile = join(dir, 'labs')
  if (labs !== null) writeFileSync(labsFile, labs)
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(dir, 'uploads'),
      DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'no-chat-only'),
      DASHBOARD_CHAT_E2E_DIR: join(dir, 'box'),
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      DASHBOARD_FFMPEG: writeFfmpeg(dir),
      DASHBOARD_SPEAK: writeSpeakEach(dir),
      DASHBOARD_VOICE_LABS: labsFile,
      DASHBOARD_REPLY_RETRY_MS: '0',
      CONNECTORD_TOKEN: API_TOKEN,
      USER: 'agent-theo',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const results: string[] = []
  const tools: unknown[] = []
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fast-api-test', version: '0' } } })
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
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) }
          if (msg.id === 2) tools.push(...(msg.result?.tools ?? []))
          if (typeof msg.id === 'number' && msg.id >= 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  const reply = (text: string) => send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: '33', text, voice: true } } })
  try {
    expect(await waitFor(() => pendingAsked && tools.length > 0, BOOT_MS + 8_000)).toBe(true)
    await body(dir, { posted, results, tools, reply })
  } finally {
    proc.kill()
    await proc.exited
    api.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

const speaks = (dir: string) => existsSync(join(dir, 'speaks.log')) ? readFileSync(join(dir, 'speaks.log'), 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')) : []

describe('the test version, it2: first sentence first, and the tool always loaded (DIVE-8649)', () => {
  test('split: text, then the first sentence, then the rest, each part tagged with one turn; no file left', async () => {
    await runApi('split\n', async (dir, a) => {
      a.reply('Yes, Friday at ten works. I have put it in the calendar and told Anna.')
      expect(await waitFor(() => a.results.length >= 1, 15_000)).toBe(true)
      expect(a.results[0]).toContain('voice note sent in 2 parts')
      expect(a.posted.map(p => p.body)).toEqual(['Yes, Friday at ten works. I have put it in the calendar and told Anna.', VOICE_ONLY_BODY, VOICE_ONLY_BODY])
      const tags = a.posted.map(p => p.metadata.voice_part as { turn: string; n: number; of: number } | undefined)
      expect(tags[0]).toBeUndefined()
      expect(tags[1]).toMatchObject({ n: 1, of: 2 })
      expect(tags[2]).toMatchObject({ n: 2, of: 2, turn: tags[1]!.turn })
      // Each part was spoken from its own text, the first sentence first, and the first began before the text was posted.
      expect(speaks(dir).map(s => s[1])).toEqual(['YesFridayatt', 'Ihaveputitin'])
      expect((a.posted[1].metadata.files as string[])[0]).toEndWith('.mp3')
      expect(readFileSync(join(dir, 'state', 'voice-timing.log'), 'utf8')).not.toContain('Friday')
      const t = JSON.parse(readFileSync(join(dir, 'state', 'voice-timing.log'), 'utf8').trim())
      expect(t.parts).toBe(2)
      expect(t.first_ms).toBeLessThan(t.reply_ms)
      expect(require('node:fs').readdirSync(dir).filter((f: string) => f.endsWith('.ogg'))).toEqual([])
    })
  }, 40_000)

  test('split, one sentence: one voice note with no part tag, started early', async () => {
    await runApi('split\n', async (dir, a) => {
      a.reply('Friday at ten works for me.')
      expect(await waitFor(() => a.results.length >= 1, 15_000)).toBe(true)
      expect(a.posted.map(p => p.body)).toEqual(['Friday at ten works for me.', VOICE_ONLY_BODY])
      expect(a.posted.every(p => !('voice_part' in p.metadata))).toBe(true)
      expect(speaks(dir).length).toBe(1)
    })
  }, 40_000)

  test('no labs file: one untagged voice note on the API path too, and the tool has no _meta', async () => {
    await runApi(null, async (_dir, a) => {
      expect((a.tools[0] as { name: string; _meta?: unknown }).name).toBe('reply')
      expect('_meta' in (a.tools[0] as object)).toBe(false)
      a.reply('Yes, Friday at ten works. I have put it in the calendar and told Anna.')
      expect(await waitFor(() => a.results.length >= 1, 15_000)).toBe(true)
      expect(a.posted.map(p => p.body)).toEqual(['Yes, Friday at ten works. I have put it in the calendar and told Anna.', VOICE_ONLY_BODY])
      expect(a.posted.every(p => !('voice_part' in p.metadata))).toBe(true)
    })
  }, 40_000)

  test('loaded: the reply tool is listed always-loaded', async () => {
    await runApi('loaded\n', async (_dir, a) => {
      expect(a.tools[0]).toMatchObject({ name: 'reply', _meta: { 'anthropic/alwaysLoad': true } })
    })
  }, 40_000)
})
