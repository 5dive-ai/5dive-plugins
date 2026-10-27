// DIVE-7098: hands-free voice on a chat-only self-hosted box.
//
// The API hands a clip to hear on this agent's long poll (`hear: [{id, path}]`,
// only to a poll that said `hear=1`). The adapter must fetch the clip, hear it
// with the local engine, post the words to /server/selfhost/heard, and put
// NOTHING in front of the session: noise answers "" and costs no model turn.
// Negative controls: no engine on the box → no `hear=1`; a job outside this
// agent's uploads dir is never fetched or heard; an engine failure answers null.
// Driven as a REAL server.ts process against a stub control plane.

import { describe, test, expect } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hearJobs, hearText } from '../plugins/dashboard/chatonly.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000
const TOKEN = 'tok-hands-free-abcdef'

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

function startAdapter(dir: string, env: Record<string, string | undefined>) {
  const delivered: string[] = []
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_CHAT_UPLOADS: join(dir, 'uploads'),
      DASHBOARD_CHAT_ONLY_MARKER: join(dir, 'chat-only'),
      DASHBOARD_LONGPOLL_BACKOFF_MS: '50',
      CONNECTORD_TOKEN: undefined as unknown as string,
      USER: 'agent-olivia',
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hands-free-test', version: '0' } } })
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
          if (msg.method === 'notifications/claude/channel') delivered.push(String(msg.params?.content ?? ''))
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        } catch {}
      }
    }
  })()
  return { proc, delivered }
}

// A stub control plane: holds a wait>0 poll up to 2 s, hands each queued hear
// job once (only to a hear=1 poll, as the API does), serves held uploads.
function startApi(uploads: Record<string, string>) {
  const polls: string[] = []
  const fetched: string[] = []
  const heard: Array<{ agent: string; id: string; text: string | null }> = []
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
        if (wait > 0 && !(hears && jobs.length)) {
          await new Promise<void>(r => { wake = r; setTimeout(r, 2_000) })
          wake = null
        }
        const hear = hears ? jobs : []
        if (hears) jobs = []
        return Response.json({ pending: [], ...(hear.length ? { hear } : {}) })
      }
      if (url.pathname === '/server/selfhost/files' && req.method === 'GET') {
        const p = url.searchParams.get('path') ?? ''
        fetched.push(p)
        return p in uploads ? new Response(uploads[p]) : Response.json({ error: 'not held' }, { status: 404 })
      }
      if (url.pathname === '/server/selfhost/heard') {
        heard.push((await req.json()) as (typeof heard)[number])
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { api, polls, fetched, heard, ask: (j: { id: string; path: string }) => { jobs.push(j); wake?.() } }
}

function setup(engine: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-hands-free-'))
  mkdirSync(join(dir, 'outbox'))
  writeFileSync(join(dir, 'chat-only'), 'API=http://x\nLINKED_AT=0\n')
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, `CONNECTORD_TOKEN=${TOKEN}\n`)
  // The stand-in engine: a clip that says NOISE has no words; FAIL fails; else words.
  const bin = join(dir, '5dive-transcribe')
  if (engine) script(dir, '5dive-transcribe', `[[ "$1" == -- ]] || exit 9
c=$(cat "$2"); [[ "$c" == *FAIL* ]] && exit 2; [[ "$c" == *NOISE* ]] && exit 0
printf '  what is\\n on   today  \\n'`)
  const clip = (n: number) => join(dir, 'uploads', 'olivia', `176155000000${n}-voice.wav`)
  return { dir, envFile, bin, clip }
}

describe('chatonly.ts hearing helpers (DIVE-7098)', () => {
  test('hearJobs: well-formed jobs in this agent\'s own uploads dir only', () => {
    const root = '/home/claude/chat-uploads'
    const ok = `${root}/olivia/1761550000000-voice.wav`
    expect(hearJobs([{ id: 'a1', path: ok }], 'olivia', root)).toEqual([{ id: 'a1', path: ok }])
    for (const bad of [
      { id: 'a', path: `${root}/theo/1761550000000-voice.wav` },
      { id: 'a', path: `${root}/olivia/../theo/1-voice.wav` },
      { id: 'a', path: '/etc/shadow' },
      { id: '', path: ok },
      { id: 'x'.repeat(65), path: ok },
      { id: 7, path: ok },
      null,
    ]) expect(hearJobs([bad], 'olivia', root)).toEqual([])
    expect(hearJobs(undefined, 'olivia', root)).toEqual([])
    expect(hearJobs({ id: 'a1', path: ok }, 'olivia', root)).toEqual([])
  })

  test('hearText: words folded, "" for none, null when the engine fails or throws', async () => {
    expect(await hearText('/p', async () => ({ code: 0, out: '  hi\n  there ' }), 'bin')).toBe('hi there')
    expect(await hearText('/p', async () => ({ code: 0, out: '\n' }), 'bin')).toBe('')
    expect(await hearText('/p', async () => ({ code: 1, out: 'hi' }), 'bin')).toBe(null)
    expect(await hearText('/p', async () => { throw new Error('gone') }, 'bin')).toBe(null)
    let args: string[] = []
    await hearText('/p', async (_b, a) => { args = a; return { code: 0, out: '' } }, 'bin')
    expect(args).toEqual(['--', '/p'])
  })
})

describe('dashboard adapter hears hands-free clips on a chat-only box (DIVE-7098)', () => {
  test('engine present: says hear=1, fetches and hears each clip, answers words / "" / null, delivers nothing', async () => {
    const { dir, envFile, bin, clip } = setup(true)
    const s = startApi({ [clip(1)]: 'speech', [clip(2)]: 'NOISE', [clip(3)]: 'FAIL' })
    const a = startAdapter(dir, { DASHBOARD_API_BASE: `http://127.0.0.1:${s.api.port}`, CONNECTORD_ENV_FILE: envFile, DASHBOARD_TRANSCRIBE: bin })
    try {
      expect(await waitFor(() => s.polls.some(q => q.includes('wait=25') && q.includes('hear=1')), BOOT_MS + 5_000)).toBe(true)
      s.ask({ id: 'j1', path: clip(1) })
      expect(await waitFor(() => s.heard.length === 1, 6_000)).toBe(true)
      expect(s.heard[0]).toEqual({ agent: 'olivia', id: 'j1', text: 'what is on today' })
      expect(readFileSync(clip(1), 'utf8')).toBe('speech')
      s.ask({ id: 'j2', path: clip(2) })
      s.ask({ id: 'j3', path: clip(3) })
      // A job for another agent's upload: dropped before any fetch.
      s.ask({ id: 'j4', path: join(dir, 'uploads', 'theo', '1761550000004-voice.wav') })
      expect(await waitFor(() => s.heard.length === 3, 6_000)).toBe(true)
      expect(s.heard.find(h => h.id === 'j2')!.text).toBe('')
      expect(s.heard.find(h => h.id === 'j3')!.text).toBe(null)
      expect(s.heard.some(h => h.id === 'j4')).toBe(false)
      expect(s.fetched.every(p => p.includes('/olivia/'))).toBe(true)
      // Not a single clip reached the session: no model turn.
      await Bun.sleep(300)
      expect(a.delivered).toEqual([])
      const log = readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8')
      expect(log).toContain('hands-free: heard')
      expect(log).not.toContain('what is on today')
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a clip the API no longer holds: answered null (the app says it did not send), never heard', async () => {
    const { dir, envFile, bin, clip } = setup(true)
    const s = startApi({})
    const a = startAdapter(dir, { DASHBOARD_API_BASE: `http://127.0.0.1:${s.api.port}`, CONNECTORD_ENV_FILE: envFile, DASHBOARD_TRANSCRIBE: bin })
    try {
      expect(await waitFor(() => s.polls.some(q => q.includes('hear=1')), BOOT_MS + 5_000)).toBe(true)
      s.ask({ id: 'gone', path: clip(5) })
      expect(await waitFor(() => s.heard.length === 1, 6_000)).toBe(true)
      expect(s.heard[0].text).toBe(null)
      expect(existsSync(clip(5))).toBe(false)
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('no engine on the box (no voice add-on): never says hear=1, so the API never hands it a clip', async () => {
    const { dir, envFile, bin } = setup(false)
    const s = startApi({})
    const a = startAdapter(dir, { DASHBOARD_API_BASE: `http://127.0.0.1:${s.api.port}`, CONNECTORD_ENV_FILE: envFile, DASHBOARD_TRANSCRIBE: bin })
    try {
      expect(await waitFor(() => s.polls.filter(q => q.includes('wait=25')).length >= 2, BOOT_MS + 8_000)).toBe(true)
      expect(s.polls.some(q => q.includes('hear=1'))).toBe(false)
    } finally {
      a.proc.kill()
      await a.proc.exited
      s.api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
