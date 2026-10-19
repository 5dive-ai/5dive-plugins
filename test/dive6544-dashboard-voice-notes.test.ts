// DIVE-6544: voice notes in the web chat, both ways, through the dashboard channel.
//
// Inbound: a note the box could not hear arrives with its audio path in the one
// attachment field the control plane forwards (image_path). It must reach the
// session as a voice note (attachment_kind="voice", audio_path), never as an
// image for the agent to Read. Outbound: 5dive-speak's OGG goes to the web as an
// MP3 a browser plays, and a voice note may go with no text.
//
// The process arms drive the REAL adapter through the root-relay stand-in, the
// path every standard seat takes (DIVE-5894), with a stand-in ffmpeg.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboundAttachment, isAudioPath, replyBody, webPlayable, VOICE_ONLY_BODY } from '../plugins/dashboard/voicenote.ts'

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

describe('voicenote.ts', () => {
  test('an audio path is a voice note; anything else stays an image_path', () => {
    expect(inboundAttachment('/home/claude/chat-uploads/theo/1-voice.webm')).toEqual({
      attachment_kind: 'voice', audio_path: '/home/claude/chat-uploads/theo/1-voice.webm',
    })
    expect(inboundAttachment('/x/note.M4A')).toEqual({ attachment_kind: 'voice', audio_path: '/x/note.M4A' })
    expect(inboundAttachment('/x/shot.png')).toEqual({ image_path: '/x/shot.png' })
    expect(inboundAttachment('relative.webm')).toEqual({})
    expect(inboundAttachment(undefined)).toEqual({})
    expect(isAudioPath('/x/report.pdf')).toBe(false)
  })

  test('a reply body: the text, else a stand-in for files sent alone, else a refusal', () => {
    expect(replyBody('hi', [])).toBe('hi')
    expect(replyBody('  ', ['/o/a.mp3'])).toBe(VOICE_ONLY_BODY)
    expect(replyBody('', ['/o/a.mp3', '/o/r.pdf'])).toBe('📎')
    expect(() => replyBody(' ', [])).toThrow('text is required')
  })

  test('an OGG becomes an MP3 beside it; a failed conversion keeps the OGG; other files are untouched', async () => {
    const calls: string[][] = []
    const ok = async (bin: string, args: string[]) => { calls.push([bin, ...args]) }
    expect(await webPlayable('/o/theo-1-reply.ogg', ok, '/usr/bin/ffmpeg')).toBe('/o/theo-1-reply.mp3')
    expect(calls[0][0]).toBe('/usr/bin/ffmpeg')
    expect(calls[0]).toContain('/o/theo-1-reply.ogg')
    expect(calls[0].at(-1)).toBe('/o/theo-1-reply.mp3')
    const bad = async () => { throw new Error('ffmpeg: not found') }
    expect(await webPlayable('/o/a.oga', bad)).toBe('/o/a.oga')
    expect(await webPlayable('/o/a.mp3', bad)).toBe('/o/a.mp3')
    expect(await webPlayable('/o/r.pdf', bad)).toBe('/o/r.pdf')
  })
})

function writeRelay(dir: string): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(dir + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') {
  let q = []
  try { q = JSON.parse(readFileSync(dir + '/queue.json', 'utf8')) } catch {}
  process.stdout.write('200\\n' + JSON.stringify({ pending: q }))
} else if (op[0] === 'ack') {
  const ids = op.slice(1).map(Number)
  writeFileSync(dir + '/queue.json', '[]')
  process.stdout.write('200\\n' + JSON.stringify({ ok: true, acked: ids.length }))
} else if (op[0] === 'event') process.stdout.write('200\\n{"id":41}')
else { process.stderr.write('unknown op\\n'); process.exit(1) }
`)
  return file
}

function ops(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function startAdapter(dir: string, ffmpeg: string) {
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const delivered: Array<{ content: string; meta: Record<string, string> }> = []
  const results: string[] = []
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_FFMPEG: ffmpeg,
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', writeRelay(dir)]),
      USER: 'agent-theo',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'voice-test', version: '0' } } })
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
          if (msg.method === 'notifications/claude/channel') {
            delivered.push({ content: String(msg.params?.content ?? ''), meta: msg.params?.meta ?? {} })
          }
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (typeof msg.id === 'number' && msg.id >= 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  return { proc, delivered, results, send }
}

// A stand-in ffmpeg: writes the last argument (the output) and records the call.
function writeFfmpeg(dir: string, works: boolean): string {
  const file = join(dir, 'ffmpeg')
  writeFileSync(file, works
    ? `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(join(dir, 'ffmpeg.log'))}\nprintf 'ID3' > "\${@: -1}"\n`
    : `#!/usr/bin/env bash\necho "Unknown encoder 'libmp3lame'" >&2\nexit 1\n`)
  chmodSync(file, 0o755)
  return file
}

describe('the dashboard adapter and voice notes (DIVE-6544)', () => {
  test('an unheard note arrives as a voice note with audio_path; a typed one with a picture keeps image_path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-voice-in-'))
    writeFileSync(join(dir, 'queue.json'), JSON.stringify([
      { id: 21, text: '[voice note] (not heard on the box)', chat_id: '33', image_path: '/home/claude/chat-uploads/theo/1-voice.webm' },
      { id: 22, text: 'see this', chat_id: '33', image_path: '/home/claude/chat-uploads/theo/2-shot.png' },
    ]))
    const a = startAdapter(dir, writeFfmpeg(dir, true))
    try {
      expect(await waitFor(() => a.delivered.length >= 2, BOOT_MS + 8_000)).toBe(true)
      const voice = a.delivered.find(d => d.content.startsWith('[voice note]'))!
      expect(voice.meta.attachment_kind).toBe('voice')
      expect(voice.meta.audio_path).toBe('/home/claude/chat-uploads/theo/1-voice.webm')
      expect(voice.meta.image_path).toBeUndefined()
      const pic = a.delivered.find(d => d.content === 'see this')!
      expect(pic.meta.image_path).toBe('/home/claude/chat-uploads/theo/2-shot.png')
      expect(pic.meta.attachment_kind).toBeUndefined()
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a voice reply with no text goes as an MP3 with the voice stand-in body; text-only replies are unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-voice-out-'))
    const ogg = join(dir, 'speak-1.ogg')
    writeFileSync(ogg, 'OggS')
    const a = startAdapter(dir, writeFfmpeg(dir, true))
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'Booked for Friday.' } } })
      a.send({ jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', files: [ogg] } } })
      expect(await waitFor(() => a.results.length >= 2, 8_000)).toBe(true)
      const events = ops(dir).filter(o => o[0] === 'event')
      expect(events).toContainEqual(['event', '33', 'Booked for Friday.'])
      const voice = events.find(e => e[2] === VOICE_ONLY_BODY)!
      expect(voice).toBeDefined()
      expect(voice.length).toBe(4)
      expect(voice[3]).toStartWith(join(dir, 'outbox') + '/theo-')
      expect(voice[3]).toEndWith('.mp3')
      expect(existsSync(voice[3])).toBe(true)
      expect(readFileSync(join(dir, 'ffmpeg.log'), 'utf8')).toContain('libmp3lame')
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('no MP3 encoder: the OGG still goes; and a reply with neither text nor files is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-voice-noenc-'))
    const ogg = join(dir, 'speak-2.ogg')
    writeFileSync(ogg, 'OggS')
    const a = startAdapter(dir, writeFfmpeg(dir, false))
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: '', files: [ogg] } } })
      expect(await waitFor(() => a.results.length >= 1, 8_000)).toBe(true)
      const voice = ops(dir).find(o => o[0] === 'event')!
      expect(voice[2]).toBe(VOICE_ONLY_BODY)
      expect(voice[3]).toEndWith('.ogg')
      a.send({ jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: '  ' } } })
      expect(await waitFor(() => a.results.length >= 2, 8_000)).toBe(true)
      expect(a.results[1]).toContain('text is required')
      expect(ops(dir).filter(o => o[0] === 'event').length).toBe(1)
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
