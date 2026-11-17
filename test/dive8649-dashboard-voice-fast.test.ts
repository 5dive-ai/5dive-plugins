// DIVE-8649: lodar's test version of faster voice answers, behind a per-box
// labs file that is absent everywhere else (voicefast.ts).
//
// Pure arms: the switch's parse, the clock, the timing line (timings only).
// Process arms drive the REAL adapter through the root-relay stand-in:
//   - no labs file: the same two posts as before, and nothing logged;
//   - `fast`: the speech starts BEFORE the text is posted, not after;
//   - `fast` and the text fails: no voice note goes, and its file is removed;
//   - `timing`: one line per voice reply, timed from the voice note's hand-over.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VOICE_TURN_MAX_MS,
  appendVoiceTiming,
  makeVoiceClock,
  readVoiceLabs,
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

// The root-relay stand-in. A text event waits EVENT_DELAY_MS before it answers,
// so a speech started before it is visible; `event` answers 500 when FAIL_TEXT is set.
function writeRelay(dir: string, opts: { delayMs?: number; failText?: boolean } = {}): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
if (op[0] === 'event' && op[2] !== ${JSON.stringify(VOICE_ONLY_BODY)}) {
  appendFileSync(dir + '/marks.log', 'text-start ' + Date.now() + '\\n')
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
function writeSpeak(dir: string): string {
  const file = join(dir, '5dive-speak')
  const out = join(dir, 'speak-out.ogg')
  writeFileSync(file, `#!/usr/bin/env bash
echo "speak-start $(date +%s%3N)" >> ${JSON.stringify(join(dir, 'marks.log'))}
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

function startAdapter(dir: string, relay: string, labs: string | null) {
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
      DASHBOARD_SPEAK: writeSpeak(dir),
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

async function run(labs: string | null, opts: { delayMs?: number; failText?: boolean } = {}, body?: (dir: string, a: ReturnType<typeof startAdapter>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-fast-'))
  const a = startAdapter(dir, writeRelay(dir, opts), labs)
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

  test('fast: the speech starts while the text is still being posted, and the same two posts go', async () => {
    await run('fast\n', { delayMs: 400 }, async (dir, a) => {
      a.reply('Friday at ten.')
      expect(await waitFor(() => a.results.length >= 1, 10_000)).toBe(true)
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
  }, 30_000)

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
