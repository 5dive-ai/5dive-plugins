// DIVE-6549: a web voice note's reply, fast enough to feel like a conversation.
//
// Measured on exact-swallow (2026-10-19), three plugin-side costs:
//   - every inbound waited for the 15 s inbox sweep (the watch never fired);
//   - every live-delivered message came back from /pending after its TTL and
//     was pushed into the session again, a fresh model turn each time;
//   - answering a voice note took three model rounds (reply, 5dive-speak,
//     reply again with the file).
// The process arms drive the REAL adapter through the root-relay stand-in,
// the path every standard seat takes (DIVE-5894).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deliveredLive,
  liveKey,
  loadLiveDeliveries,
  recordLiveDelivery,
  saveLiveDeliveries,
  LIVE_RETENTION_MS,
} from '../plugins/dashboard/livedelivery.ts'
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

describe('livedelivery.ts', () => {
  test('a message is keyed by its chat and ts; a missing half is no key', () => {
    expect(liveKey('33', '2026-10-19T13:21:21.000Z')).toBe('33 2026-10-19T13:21:21.000Z')
    expect(liveKey('33', '')).toBeNull()
    expect(liveKey(undefined, '2026-10-19T13:21:21.000Z')).toBeNull()
    expect(deliveredLive({}, null)).toBe(false)
  })

  test('a record is kept for a day, then dropped; it round-trips through its file', () => {
    const state = {}
    recordLiveDelivery(state, 'a', 1_000)
    expect(deliveredLive(state, 'a')).toBe(true)
    expect(deliveredLive(state, 'b')).toBe(false)
    recordLiveDelivery(state, 'b', 1_000 + LIVE_RETENTION_MS + 1)
    expect(deliveredLive(state, 'a')).toBe(false)
    expect(deliveredLive(state, 'b')).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'dash-live-'))
    try {
      const file = join(dir, 'delivered-live.json')
      saveLiveDeliveries(file, state)
      expect(loadLiveDeliveries(file)).toEqual(state)
      writeFileSync(file, '[1,2]')
      expect(loadLiveDeliveries(file)).toEqual({})
      expect(loadLiveDeliveries(join(dir, 'missing.json'))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

// A stand-in 5dive-speak: records its argv, writes an OGG and prints its path,
// or exits with `code` the way the real one does.
function writeSpeak(dir: string, code = 0): string {
  const file = join(dir, '5dive-speak')
  const out = join(dir, 'speak-out.ogg')
  writeFileSync(file, code === 0
    ? `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'speak.args'))}\nprintf 'OggS' > ${JSON.stringify(out)}\necho ${JSON.stringify(out)}\n`
    : `#!/usr/bin/env bash\necho "5dive-speak: voice replies are switched off on this server by its owner." >&2\nexit ${code}\n`)
  chmodSync(file, 0o755)
  return file
}

function drop(dir: string, name: string, body: object): void {
  const inbox = join(dir, 'state', 'agent-inbox')
  writeFileSync(join(inbox, `.tmp-${name}`), JSON.stringify(body))
  renameSync(join(inbox, `.tmp-${name}`), join(inbox, `${name}.json`))
}

describe('the dashboard adapter, made faster for voice notes (DIVE-6549)', () => {
  test('with the watch dead, a drop still reaches the session within about a second', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-sweep-'))
    const a = startAdapter(dir)
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      // Replace the watched dir: the watch now sits on a dead inode, so only the
      // sweep can see the new dir's files.
      const inbox = join(dir, 'state', 'agent-inbox')
      rmSync(inbox, { recursive: true, force: true })
      mkdirSync(inbox, { recursive: true })
      await Bun.sleep(200)
      const sent = Date.now()
      drop(dir, '1-a', { text: '[voice note] are we on for friday', chat_id: '33', ts: '2026-10-19T13:21:21.000Z' })
      expect(await waitFor(() => a.delivered.length >= 1, 5_000)).toBe(true)
      expect(a.delivered[0].at - sent).toBeLessThan(2_000)
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a message the drop delivered is acked, not pushed again, when /pending offers it after its TTL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-live-'))
    const a = startAdapter(dir)
    const ts = '2026-10-19T13:21:21.000Z'
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      drop(dir, '1-b', { text: '[voice note] are we on for friday', chat_id: '33', ts })
      expect(await waitFor(() => a.delivered.length >= 1, 5_000)).toBe(true)
      await waitFor(() => existsSync(join(dir, 'state', 'delivered-live.json')), 2_000)
      // The control plane's re-offer: same chat and ts, under the row's id. Plus
      // a message the drop never carried, which must still be pushed.
      writeFileSync(join(dir, 'queue.json'), JSON.stringify([
        { id: 304, text: '[voice note] are we on for friday', chat_id: '33', ts },
        { id: 305, text: 'missed while offline', chat_id: '33', ts: '2026-10-19T13:22:00.000Z' },
      ]))
      writeFileSync(join(dir, 'state', 'collect-now', 'nudge'), '')
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'ack'), 8_000)).toBe(true)
      const ack = ops(dir).find(o => o[0] === 'ack')!
      expect(ack.slice(1).sort()).toEqual(['304', '305'])
      expect(a.delivered.map(d => d.content)).toEqual(['[voice note] are we on for friday', 'missed while offline'])
      const life = readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8')
      expect(life).toContain('pending message id=304 was delivered live; acked, not pushed again')
      expect(life).toMatch(/drop 1-b\.json delivered via=(watch|sweep)/)
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('reply with voice: true sends the text, then the spoken note as an MP3, in one call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-speak-'))
    const a = startAdapter(dir, { DASHBOARD_SPEAK: writeSpeak(dir) })
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: '-Yes, Friday at ten.', voice: true } } })
      expect(await waitFor(() => a.results.length >= 1, 8_000)).toBe(true)
      const events = ops(dir).filter(o => o[0] === 'event')
      expect(events.length).toBe(2)
      expect(events[0]).toEqual(['event', '33', '-Yes, Friday at ten.'])
      expect(events[1][2]).toBe(VOICE_ONLY_BODY)
      expect(events[1][3]).toStartWith(join(dir, 'outbox') + '/theo-')
      expect(events[1][3]).toEndWith('.mp3')
      // The text is spoken as text, even when it starts with a dash.
      expect(readFileSync(join(dir, 'speak.args'), 'utf8')).toBe('--\n-Yes, Friday at ten.\n')
      expect(a.results[0]).toContain('voice note sent')
      expect(existsSync(join(dir, 'speak-out.ogg'))).toBe(false)
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('voice off on the box: the text goes alone and the agent is told not to mention voice; no flag, no speech', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-speak-off-'))
    const a = startAdapter(dir, { DASHBOARD_SPEAK: writeSpeak(dir, 3) })
    try {
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'Friday at ten.', voice: true } } })
      // Each reply spawns its own relay process, so send the second only after the first has landed.
      expect(await waitFor(() => a.results.length >= 1, 8_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'typed answer' } } })
      expect(await waitFor(() => a.results.length >= 2, 8_000)).toBe(true)
      const events = ops(dir).filter(o => o[0] === 'event')
      expect(events).toEqual([['event', '33', 'Friday at ten.'], ['event', '33', 'typed answer']])
      expect(a.results.join('\n')).toContain('voice replies are switched off')
      expect(a.results.join('\n')).not.toContain('VOICE NOTE NOT SENT')
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
