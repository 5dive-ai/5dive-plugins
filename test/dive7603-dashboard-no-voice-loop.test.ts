import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { replyTool, voicePlan, voiceSkippedNote, voiceFailedOnce, VOICE_COOLDOWN_MS } from '../plugins/dashboard/voicereply.ts'

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

function startAdapter(dir: string, env: Record<string, string> = {}) {
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const delivered: Array<{ content: string; meta: Record<string, string>; at: number }> = []
  const results: string[] = []
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_FFMPEG: writeFfmpeg(dir),
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', writeRelay(dir)]),
      USER: 'agent-theo',
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'speed-test', version: '0' } } })
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
            delivered.push({ content: String(msg.params?.content ?? ''), meta: msg.params?.meta ?? {}, at: Date.now() })
          }
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (typeof msg.id === 'number' && msg.id >= 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  return { proc, delivered, results, send }
}

function writeFfmpeg(dir: string): string {
  const file = join(dir, 'ffmpeg')
  writeFileSync(file, `#!/usr/bin/env bash\nprintf 'ID3' > "\${@: -1}"\n`)
  chmodSync(file, 0o755)
  return file
}


// DIVE-7603 (DIVE-7578 run 6): with no voice add-on, qwen3:8b answered each
// failed voice note with another voice reply: 9 "voice note failed" messages in
// 11 minutes. Voice is offered only where it can be made, and a failure never
// invites a retry.

// A stand-in 5dive-speak that fails the way a broken engine does (exit 1).
function writeBrokenSpeak(dir: string): string {
  const file = join(dir, '5dive-speak')
  writeFileSync(file, `#!/usr/bin/env bash\necho x >> ${JSON.stringify(join(dir, 'speak.calls'))}\necho "5dive-speak: engine crashed" >&2\nexit 1\n`)
  chmodSync(file, 0o755)
  return file
}

describe('voicereply.ts', () => {
  test('no voice on the box: the tool has no voice field and never mentions it', () => {
    const t = replyTool(false)
    expect(Object.keys(t.inputSchema.properties)).toEqual(['chat_id', 'text', 'files'])
    expect(t.description).not.toMatch(/voice:/)
    const v = replyTool(true)
    expect(Object.keys(v.inputSchema.properties)).toContain('voice')
    expect(v.description).toContain('Set voice: true')
  })

  test('voice is tried only when 5dive-speak exists and no failure is fresh', () => {
    expect(voicePlan(false, 0, 1_000)).toBe('absent')
    expect(voicePlan(true, 0, 1_000)).toBe('speak')
    expect(voicePlan(true, 1_000, 1_000 + VOICE_COOLDOWN_MS - 1)).toBe('cooling')
    expect(voicePlan(true, 1_000, 1_000 + VOICE_COOLDOWN_MS)).toBe('speak')
  })

  test('no line the agent is told invites another voice try', () => {
    for (const s of [voiceSkippedNote('absent'), voiceSkippedNote('cooling'), voiceFailedOnce('boom')]) {
      expect(s).not.toContain('did not work this time')
      expect(s).toMatch(/do not (set|try) voice again|do not reply again/)
    }
    expect(voiceFailedOnce('boom')).toContain('text only')
  })
})

describe('the dashboard adapter on a box without voice (DIVE-7603)', () => {
  test('tools/list offers no voice when 5dive-speak is missing; a voice: true reply sends text only, no speech', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-novoice-'))
    const a = startAdapter(dir, { DASHBOARD_SPEAK: join(dir, 'no-such-5dive-speak') })
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })
      expect(await waitFor(() => a.results.length >= 1, 8_000)).toBe(true)
      const tools = JSON.parse(a.results[0]).tools
      expect(tools.map((t: { name: string }) => t.name)).toEqual(['reply'])
      expect(Object.keys(tools[0].inputSchema.properties)).not.toContain('voice')
      a.send({ jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'Friday at ten.', voice: true } } })
      expect(await waitFor(() => a.results.length >= 2, 8_000)).toBe(true)
      expect(ops(dir).filter(o => o[0] === 'event')).toEqual([['event', '33', 'Friday at ten.']])
      expect(a.results[1]).toContain('makes no voice notes')
      expect(a.results[1]).not.toContain('VOICE NOTE NOT SENT')
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a broken engine is tried once: the next voice reply is skipped, so no loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-voicefail-'))
    const a = startAdapter(dir, { DASHBOARD_SPEAK: writeBrokenSpeak(dir) })
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'Friday at ten.', voice: true } } })
      expect(await waitFor(() => a.results.length >= 1, 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'The voice reply did not work.', voice: true } } })
      expect(await waitFor(() => a.results.length >= 2, 8_000)).toBe(true)
      expect(a.results[0]).toContain('VOICE NOTE NOT SENT (5dive-speak: engine crashed)')
      expect(a.results[0]).toContain('text only')
      expect(a.results[1]).toContain('voice skipped')
      expect(readFileSync(join(dir, 'speak.calls'), 'utf8').trim().split('\n').length).toBe(1)
      expect(ops(dir).filter(o => o[0] === 'event').length).toBe(2)
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
