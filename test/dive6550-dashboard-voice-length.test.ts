// DIVE-6550: opening a web chat downloaded every agent voice note through the
// box only to show its length (Sentry N+1 on /tg/chat/:slug). The adapter now
// measures the note it sends and puts the length in the file's name, the one
// field the root relay passes to the web (it builds the metadata itself).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioSeconds, lengthFromName, withLengthName, VOICE_ONLY_BODY, type Probe } from '../plugins/dashboard/voicenote.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('voicenote.ts: the length in the name', () => {
  test('the length goes before the extension, to a tenth, once; the web reads it back', () => {
    const p = '/home/claude/chat-downloads/theo-1760-speak-out.mp3'
    const named = withLengthName(p, 12.43)
    expect(named).toBe('/home/claude/chat-downloads/theo-1760-speak-out.len-12.4s.mp3')
    expect(lengthFromName(named)).toBe(12.4)
    expect(withLengthName(named, 3)).toBe(named)
    expect(withLengthName(p, 0)).toBe(p)
    expect(withLengthName(p, NaN)).toBe(p)
    expect(withLengthName('/home/claude/chat-downloads/noext', 4)).toBe('/home/claude/chat-downloads/noext')
    expect(lengthFromName(p)).toBeNull()
    expect(lengthFromName('/x/a.len-0s.mp3')).toBeNull()
  })

  test('ffprobe says the length; a failure or garbage is no length', async () => {
    const seen: string[][] = []
    const ok: Probe = async (bin, args) => { seen.push([bin, ...args]); return '7.250000\n' }
    expect(await audioSeconds('/o/a.mp3', ok, '/usr/bin/ffprobe')).toBe(7.25)
    expect(seen[0][0]).toBe('/usr/bin/ffprobe')
    expect(seen[0].at(-1)).toBe('/o/a.mp3')
    expect(await audioSeconds('/o/a.mp3', async () => 'N/A\n')).toBeNull()
    expect(await audioSeconds('/o/a.mp3', async () => { throw new Error('ENOENT') })).toBeNull()
  })

  test('the real ffprobe reads a real file', async () => {
    if (!existsSync('/usr/bin/ffmpeg') || !existsSync('/usr/bin/ffprobe')) return
    const dir = mkdtempSync(join(tmpdir(), 'dash-len-real-'))
    try {
      const wav = join(dir, 'tone.wav')
      await promisify(execFile)('/usr/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=2.5', wav])
      const probe: Probe = async (bin, args, t) => (await promisify(execFile)(bin, args, { timeout: t })).stdout
      expect(await audioSeconds(wav, probe, '/usr/bin/ffprobe')).toBeCloseTo(2.5, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function writeRelay(dir: string): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync } from 'node:fs'
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(${JSON.stringify(dir)} + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') process.stdout.write('200\\n{"pending":[]}')
else if (op[0] === 'ack') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'event') process.stdout.write('200\\n{"id":41}')
else process.exit(1)
`)
  return file
}

function script(dir: string, name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function events(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((o: string[]) => o[0] === 'event')
}

async function voiceReply(probe: string | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dash-len-'))
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const ogg = join(dir, 'speak-out.ogg')
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_FFMPEG: script(dir, 'ffmpeg', `printf 'ID3' > "\${@: -1}"`),
      DASHBOARD_FFPROBE: probe === null ? join(dir, 'no-ffprobe') : script(dir, 'ffprobe', `echo ${probe}`),
      DASHBOARD_SPEAK: script(dir, '5dive-speak', `printf 'OggS' > ${JSON.stringify(ogg)}\necho ${JSON.stringify(ogg)}`),
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', writeRelay(dir)]),
      USER: 'agent-theo',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const results: string[] = []
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
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
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (msg.id === 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'len-test', version: '0' } } })
    expect(await waitFor(() => existsSync(join(dir, 'ops.log')), 13_000)).toBe(true)
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'reply', arguments: { chat_id: '33', text: 'Friday at ten.', voice: true } } })
    expect(await waitFor(() => results.length >= 1, 8_000)).toBe(true)
    const ev = events(dir)
    expect(ev.length).toBe(2)
    expect(ev[1][2]).toBe(VOICE_ONLY_BODY)
    const file = ev[1][3]
    expect(file).toStartWith(join(dir, 'outbox') + '/theo-')
    // The file the reply names is the one on disk: the web downloads it by that path.
    expect(existsSync(file)).toBe(true)
    return file
  } finally {
    proc.kill()
    await proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the adapter names its voice note with its length (DIVE-6550)', () => {
  test('a voice reply goes as an MP3 whose name carries its length', async () => {
    const file = await voiceReply('12.43')
    expect(file).toEndWith('.len-12.4s.mp3')
    expect(lengthFromName(file)).toBe(12.4)
  }, 30_000)

  test('no ffprobe on the box: the note still goes, with no length in its name', async () => {
    const file = await voiceReply(null)
    expect(file).toEndWith('.mp3')
    expect(lengthFromName(file)).toBeNull()
  }, 30_000)
})
