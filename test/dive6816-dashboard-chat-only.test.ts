// DIVE-6816: the dashboard chat on a chat-only self-hosted box.
//
// A box linked as chat only runs no file server and takes no inbound call, so
// with the marker (/etc/5dive/chat-only, DASHBOARD_CHAT_ONLY_MARKER here) the
// adapter must:
//   * hold a long poll on /pending (wait=25) in a loop, and stop it on a 401;
//   * fetch an upload a message names but the box does not have, BEFORE the
//     session sees the message;
//   * post every reply file in the outbox (a voice note's OGG and MP3 too)
//     BEFORE the reply, which keeps the same metadata.files;
// and, without the marker, do none of it (the box behaves as before).
// Both the direct path (token readable) and the root relay are driven, as REAL
// server.ts processes against a stub control plane / relay stand-in.

import { describe, test, expect } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOwnUpload, runLongPoll, type PollOutcome } from '../plugins/dashboard/chatonly.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000
const TOKEN = 'tok-chat-only-abcdef'

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

function script(dir: string, name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

type Seen = { delivered: Array<{ text: string; meta: Record<string, string>; fileThere: boolean }>; results: string[] }

function startAdapter(dir: string, env: Record<string, string | undefined>) {
  const seen: Seen = { delivered: [], results: [] }
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(dir, 'uploads'),
      DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'chat-only'),
      DASHBOARD_LONGPOLL_BACKOFF_MS: '50',
      DASHBOARD_FFMPEG: script(dir, 'ffmpeg', `printf 'ID3mp3' > "\${@: -1}"`),
      DASHBOARD_FFPROBE: script(dir, 'ffprobe', 'echo 3.2'),
      CONNECTORD_TOKEN: undefined as unknown as string,
      USER: 'agent-tap',
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'chat-only-test', version: '0' } } })
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
            const meta = (msg.params?.meta ?? {}) as Record<string, string>
            const p = meta.image_path ?? meta.audio_path
            seen.delivered.push({ text: String(msg.params?.content ?? ''), meta, fileThere: !!p && existsSync(p) })
          }
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (msg.id === 7) seen.results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  const reply = (args: Record<string, unknown>) =>
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reply', arguments: args } })
  return { proc, seen, reply }
}

// A stub control plane that HOLDS a pending poll with wait>0 (up to 2 s here),
// serves held uploads and records every call in order.
function startApi(uploads: Record<string, string>) {
  const log: Array<{ route: string; query: string; body?: string }> = []
  let queue: Array<Record<string, unknown>> = []
  let wake: (() => void) | null = null
  let rejecting = false
  const api = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url)
      if (rejecting || req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        log.push({ route: `401 ${url.pathname}`, query: url.search })
        return new Response('unauthorized', { status: 401 })
      }
      if (url.pathname === '/server/messages/pending') {
        log.push({ route: 'pending', query: url.search })
        const wait = Number(url.searchParams.get('wait') ?? 0)
        if (wait > 0 && queue.length === 0) {
          await new Promise<void>(r => { wake = r; setTimeout(r, 2_000) })
          wake = null
        }
        return Response.json({ pending: queue })
      }
      if (url.pathname === '/server/messages/pending/ack') {
        const body = (await req.json()) as { ids: number[] }
        queue = queue.filter(m => !body.ids.includes(m.id as number))
        log.push({ route: 'ack', query: '' })
        return Response.json({ ok: true, acked: body.ids.length })
      }
      if (url.pathname === '/server/messages/event') {
        const body = await req.text()
        log.push({ route: 'event', query: '', body })
        return Response.json({ id: 41 })
      }
      if (url.pathname === '/server/selfhost/files') {
        const p = url.searchParams.get('path') ?? ''
        if (req.method === 'GET') {
          log.push({ route: 'files GET', query: p })
          return p in uploads ? new Response(uploads[p]) : Response.json({ error: 'not held' }, { status: 404 })
        }
        const body = new TextDecoder().decode(await req.arrayBuffer())
        log.push({ route: 'files POST', query: p, body })
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    api, log,
    enqueue: (m: Record<string, unknown>) => { queue.push(m); wake?.() },
    reject: () => { rejecting = true },
  }
}

function setup(marker: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-chat-only-'))
  mkdirSync(join(dir, 'outbox'))
  if (marker) writeFileSync(join(dir, 'chat-only'), 'API=http://x\nLINKED_AT=0\n')
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, `CONNECTORD_TOKEN=${TOKEN}\n`)
  writeFileSync(join(dir, 'report.txt'), 'the report')
  writeFileSync(join(dir, 'note.ogg'), 'OggS-voice')
  const photo = join(dir, 'uploads', 'tap', '1760000000000-photo.png')
  return { dir, envFile, photo }
}

describe('chatonly.ts helpers (DIVE-6816)', () => {
  test('isOwnUpload: one file directly in this agent\'s uploads dir, nothing else', () => {
    const root = '/home/claude/chat-uploads'
    expect(isOwnUpload('tap', root, `${root}/tap/1760000000000-a.png`)).toBe(true)
    expect(isOwnUpload('tap', `${root}/`, `${root}/tap/1760000000000-voice.webm`)).toBe(true)
    for (const bad of [`${root}/other/1-a.png`, `${root}/tap/../other/1-a.png`, `${root}/tap/sub/a.png`,
      `${root}/tap/.bashrc`, `${root}/tap/`, `${root}/tap-evil/a.png`, '/etc/passwd', 42, null]) {
      expect(isOwnUpload('tap', root, bad)).toBe(false)
    }
  })

  test('runLongPoll: back to back on ok, backs off on errors and fast empties, stops on auth', async () => {
    const slept: number[] = []
    const plan: PollOutcome[] = ['ok', 'ok', 'error', 'error', 'error', 'ok', 'empty-fast', 'empty-fast', 'empty-fast', 'busy', 'auth', 'ok']
    let i = 0
    const why = await runLongPoll({
      poll: async () => plan[i++],
      active: () => true,
      sleep: async ms => { slept.push(ms) },
      baseBackoffMs: 10,
      maxBackoffMs: 30,
    })
    expect(why).toBe('auth')
    expect(i).toBe(11)
    // errors 10, 20, 30 (capped); one fast empty free, then 10, 20; busy 250
    expect(slept).toEqual([10, 20, 30, 10, 20, 250])
  })

  test('runLongPoll: a thrown poll is an error, and the loop ends when the box is no longer chat-only', async () => {
    let n = 0
    const slept: number[] = []
    const why = await runLongPoll({
      poll: async () => { n++; throw new Error('boom') },
      active: () => n < 3,
      sleep: async ms => { slept.push(ms) },
      baseBackoffMs: 5,
      maxBackoffMs: 1_000,
    })
    expect(why).toBe('off')
    expect(slept).toEqual([5, 10, 20])
  })
})

describe('dashboard adapter on a chat-only box, direct path (DIVE-6816)', () => {
  test('marker ON: long poll, upload fetched before the message, reply files posted before the reply, 401 stops the loop', async () => {
    const { dir, envFile, photo } = setup(true)
    const s = startApi({ [photo]: 'PNG-bytes' })
    const a = startAdapter(dir, { DASHBOARD_API_BASE: `http://127.0.0.1:${s.api.port}`, CONNECTORD_ENV_FILE: envFile })
    try {
      expect(await waitFor(() => s.log.some(l => l.route === 'pending' && l.query.includes('wait=25')), BOOT_MS + 5_000)).toBe(true)
      s.enqueue({ id: 5, text: 'look at this', chat_id: 'dashboard', image_path: photo })
      expect(await waitFor(() => a.seen.delivered.length > 0, 8_000)).toBe(true)
      expect(a.seen.delivered[0].meta.image_path).toBe(photo)
      expect(a.seen.delivered[0].fileThere).toBe(true)
      expect(readFileSync(photo, 'utf8')).toBe('PNG-bytes')
      expect(s.log.filter(l => l.route === 'files GET').map(l => l.query)).toEqual([photo])
      // The hold: a quiet box is not hammered (<= ~1 poll per 2 s hold here).
      const before = s.log.filter(l => l.route === 'pending').length
      await Bun.sleep(3_000)
      expect(s.log.filter(l => l.route === 'pending').length - before).toBeLessThanOrEqual(3)

      a.reply({ chat_id: 'dashboard', text: 'here', files: [join(dir, 'report.txt'), join(dir, 'note.ogg')] })
      expect(await waitFor(() => a.seen.results.length > 0, 8_000)).toBe(true)
      expect(a.seen.results[0]).toContain('sent (id: 41)')
      const posts = s.log.filter(l => l.route === 'files POST')
      const evIdx = s.log.findIndex(l => l.route === 'event')
      const files = (JSON.parse(s.log[evIdx].body!) as { metadata: { files: string[] } }).metadata.files
      // the reply's files: the report copy and the voice note's MP3 (length in its name)
      expect(files.length).toBe(2)
      expect(files[0]).toMatch(new RegExp(`^${join(dir, 'outbox')}/tap-\\d+-report\\.txt$`))
      expect(files[1]).toMatch(/\/tap-\d+-note\.len-3\.2s\.mp3$/)
      // posted: both of those AND the OGG copy, each before the reply
      const posted = posts.map(p => p.query)
      expect(posted).toEqual(expect.arrayContaining([...files, files[1].replace('.len-3.2s.mp3', '.ogg')]))
      expect(posted.length).toBe(3)
      expect(posts.find(p => p.query === files[0])!.body).toBe('the report')
      expect(Math.max(...posts.map(p => s.log.indexOf(p)))).toBeLessThan(evIdx)

      // Unlinked in the app: the box token is refused, the loop stops.
      s.reject()
      expect(await waitFor(() => readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8').includes('long poll off (the API refused the box token)'), 6_000)).toBe(true)
      const after = s.log.length
      await Bun.sleep(1_500)
      expect(s.log.length).toBe(after)
      expect(a.proc.exitCode).toBeNull()
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  test('marker OFF: plain poll, no fetch, no file posts (the box behaves as before)', async () => {
    const { dir, envFile, photo } = setup(false)
    const s = startApi({ [photo]: 'PNG-bytes' })
    s.enqueue({ id: 6, text: 'look at this', chat_id: 'dashboard', image_path: photo })
    const a = startAdapter(dir, { DASHBOARD_API_BASE: `http://127.0.0.1:${s.api.port}`, CONNECTORD_ENV_FILE: envFile })
    try {
      expect(await waitFor(() => a.seen.delivered.length > 0, BOOT_MS + 5_000)).toBe(true)
      expect(a.seen.delivered[0].meta.image_path).toBe(photo)
      expect(a.seen.delivered[0].fileThere).toBe(false)
      a.reply({ chat_id: 'dashboard', text: 'here', files: [join(dir, 'report.txt'), join(dir, 'note.ogg')] })
      expect(await waitFor(() => a.seen.results.length > 0, 8_000)).toBe(true)
      expect(a.seen.results[0]).toContain('sent (id: 41)')
      await Bun.sleep(1_000)
      const pendings = s.log.filter(l => l.route === 'pending')
      expect(pendings.length).toBe(1)
      expect(pendings[0].query).not.toContain('wait')
      expect(s.log.some(l => l.route.startsWith('files'))).toBe(false)
      expect(existsSync(photo)).toBe(false)
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// The relay stand-in: records each op; `pending 25` holds briefly; `fetch`
// writes the file as root would; `put` answers ok.
function writeRelay(dir: string, photo: string): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(dir + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') {
  let q = []
  try { q = JSON.parse(readFileSync(dir + '/queue.json', 'utf8')) } catch {}
  if (op[1] && q.length === 0) await Bun.sleep(1000)
  process.stdout.write('200\\n' + JSON.stringify({ pending: q }))
} else if (op[0] === 'ack') {
  const ids = op.slice(1).map(Number)
  let q = []
  try { q = JSON.parse(readFileSync(dir + '/queue.json', 'utf8')) } catch {}
  writeFileSync(dir + '/queue.json', JSON.stringify(q.filter(m => !ids.includes(m.id))))
  process.stdout.write('200\\n' + JSON.stringify({ ok: true, acked: ids.length }))
} else if (op[0] === 'event') process.stdout.write('200\\n{"id":41}')
else if (op[0] === 'fetch') {
  if (op[1] !== ${JSON.stringify(photo)}) { process.stdout.write('404\\n{}'); process.exit(0) }
  mkdirSync(dirname(op[1]), { recursive: true })
  writeFileSync(op[1], 'PNG-by-root')
  process.stdout.write('200\\n{"ok":true}')
} else if (op[0] === 'put') process.stdout.write('200\\n{"ok":true}')
else { process.stderr.write('unknown op\\n'); process.exit(1) }
`)
  return file
}

function ops(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('dashboard adapter on a chat-only box, root relay (DIVE-6816)', () => {
  for (const marker of [true, false]) {
    test(`standard seat, marker ${marker ? 'ON' : 'OFF'}: ${marker ? 'pending 25, fetch, put' : 'only the old ops'}`, async () => {
      const { dir, envFile, photo } = setup(marker)
      chmodSync(envFile, 0o000)
      writeFileSync(join(dir, 'queue.json'), JSON.stringify([{ id: 9, text: 'voice!', chat_id: 'dashboard', image_path: photo }]))
      const a = startAdapter(dir, {
        DASHBOARD_API_BASE: 'http://127.0.0.1:9',
        CONNECTORD_ENV_FILE: envFile,
        DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', writeRelay(dir, photo)]),
      })
      try {
        expect(await waitFor(() => a.seen.delivered.length > 0, BOOT_MS + 8_000)).toBe(true)
        expect(a.seen.delivered[0].fileThere).toBe(marker)
        a.reply({ chat_id: 'dashboard', text: 'here', files: [join(dir, 'report.txt')] })
        expect(await waitFor(() => a.seen.results.length > 0, 8_000)).toBe(true)
        if (marker) expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending' && o[1] === '25'), 5_000)).toBe(true)
        else await Bun.sleep(1_500)
        const seen = ops(dir)
        const ev = seen.findIndex(o => o[0] === 'event')
        const sent = seen[ev].slice(3)
        expect(sent.length).toBe(1)
        if (marker) {
          expect(seen).toContainEqual(['fetch', photo])
          expect(seen).toContainEqual(['put', sent[0]])
          expect(seen.findIndex(o => o[0] === 'put')).toBeLessThan(ev)
          expect(readFileSync(photo, 'utf8')).toBe('PNG-by-root')
        } else {
          expect(seen.some(o => o[0] === 'fetch' || o[0] === 'put')).toBe(false)
          expect(seen.filter(o => o[0] === 'pending')).toEqual([['pending']])
        }
        expect(JSON.stringify(seen)).not.toContain(TOKEN)
      } finally {
        a.proc.kill()
        await a.proc.exited
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)
  }
})
