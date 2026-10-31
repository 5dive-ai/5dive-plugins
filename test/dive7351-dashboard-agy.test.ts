// DIVE-7351: the web chat on an Antigravity (agy) seat. agy spawns the dashboard
// server from ~/.gemini/config/mcp_config.json with --runtime=antigravity; the
// server types each message into agy's pane (agydispatch.ts) and agy answers
// with the server's reply tool.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGY_NO_ANSWER_TEXT, AGY_SIGNED_OUT_TEXT, AgyWatch, agyPromptFor, agySignedOut,
} from '../plugins/dashboard/agydispatch.ts'
import type { OutboxReply } from '../plugins/dashboard/grokdispatch.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  expect(predicate()).toBe(true)
}

function drop(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(body))
  renameSync(join(dir, `.${name}.tmp`), join(dir, `${name}.json`))
}

const route = { source: 'dashboard' as const, chat_id: 'dashboard' }

describe('what is typed into agy', () => {
  test('a typed message names the reply tool and its chat, and carries the text', () => {
    const p = agyPromptFor({ text: '  what is 17 times 3 ', route: { chat_id: '91' } })
    expect(p).toBe('[5dive web chat: answer with the dashboard reply tool, chat_id "91". Do not use a Telegram tool for it.]\nwhat is 17 times 3')
  })

  test('a voice note asks for one spoken reply and says how to hear it', () => {
    const p = agyPromptFor({ text: '[voice note]', image_path: '/home/claude/chat-uploads/x/n.webm', route: { chat_id: '91', voice: true } }, true)
    expect(p).toContain('ONE call of the dashboard reply tool, chat_id "91", voice: true')
    expect(p).toContain('[Voice note: /home/claude/chat-uploads/x/n.webm. Run 5dive-transcribe /home/claude/chat-uploads/x/n.webm')
    expect(agyPromptFor({ text: 'see', image_path: '/tmp/a.png' })).toContain('[Attached file: /tmp/a.png]')
  })

  test("agy's sign-in wait is recognised, its chat screen is not", () => {
    expect(agySignedOut('Waiting for authentication (timeout 60s)...')).toBe(true)
    expect(agySignedOut('Sign in with Google\nOpen this link in your browser')).toBe(true)
    expect(agySignedOut('> Type your message\nGemini 3.6 Flash - high')).toBe(false)
  })
})

describe('watching for the answer', () => {
  function rig() {
    let now = 0
    const out: OutboxReply[] = []
    const w = new AgyWatch(r => out.push(r), () => now, { idleMs: 180_000, maxMs: 900_000 })
    return { w, out, advance: (ms: number) => { now += ms; w.tick() } }
  }

  test('a reply to the chat clears its message: no notice', () => {
    const r = rig()
    r.w.sent('m1', route)
    r.advance(60_000)
    r.w.replied('dashboard')
    r.advance(900_000)
    expect(r.out).toEqual([])
    expect(r.w.busy()).toBe(false)
  })

  test('a message agy works on and never answers ends in a visible notice, not silence', () => {
    const r = rig()
    r.w.sent('m1', route)
    r.w.pane('working.')
    for (let i = 0; i < 10; i++) { r.advance(60_000); r.w.pane(`working${'.'.repeat(i)}`) }
    expect(r.out).toEqual([])      // ten minutes, the pane still moving
    r.advance(179_000)
    expect(r.out).toEqual([])
    r.advance(1_000)
    expect(r.out).toEqual([{ ...route, text: AGY_NO_ANSWER_TEXT, kind: 'error' }])
    r.advance(900_000)
    expect(r.out).toHaveLength(1)
  })

  test('a busy pane does not hold a message forever', () => {
    const r = rig()
    r.w.sent('m1', { source: 'dashboard', chat_id: 'a' })
    for (let i = 0; i < 15; i++) { r.advance(60_000); r.w.pane(`spinner ${i}`) }
    expect(r.out).toEqual([{ source: 'dashboard', chat_id: 'a', text: AGY_NO_ANSWER_TEXT, kind: 'error' }])
  })

  test('each reply clears the message of its own chat', () => {
    const r = rig()
    r.w.sent('m1', { source: 'dashboard', chat_id: 'a' })
    r.w.sent('m2', { source: 'dashboard', chat_id: 'b' })
    r.w.replied('b')
    r.advance(180_000)
    expect(r.out.map(o => o.chat_id)).toEqual(['a'])
  })
})

// A stand-in for tmux: capture-pane prints the pane file, paste-buffer "types"
// into a file the test reads, the way the message would land in agy's input.
function fakeTmux(root: string) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const tmux = join(bin, 'tmux')
  writeFileSync(tmux, `#!/usr/bin/env python3
import json, os, sys
root = ${JSON.stringify(root)}
a = sys.argv[1:]
open(os.path.join(root, 'tmux.log'), 'a').write(json.dumps(a) + '\\n')
buf = os.path.join(root, 'buf')
if a[0] == 'capture-pane':
    p = os.path.join(root, 'pane')
    sys.stdout.write(open(p).read() if os.path.exists(p) else '> Type your message')
elif a[0] == 'set-buffer':
    open(buf, 'w').write(a[a.index('--') + 1])
elif a[0] == 'paste-buffer':
    open(os.path.join(root, 'typed.log'), 'a').write(json.dumps(open(buf).read()) + '\\n')
`)
  chmodSync(tmux, 0o755)
  return bin
}

describe('Antigravity web chat end to end', () => {
  test("a typed message reaches agy's pane and its reply-tool answer reaches the chat; a voice answer is spoken once; silence and sign-in get notices", async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-dashboard-'))
    const dashboardState = join(root, '.claude', 'channels', 'dashboard')
    const dispatcherState = join(root, '.gemini', 'channels', 'dashboard-dispatcher')
    const sharedOutbox = join(root, 'downloads')
    mkdirSync(sharedOutbox, { recursive: true })
    const speakLog = join(root, 'speak.log')
    const speak = join(root, '5dive-speak')
    writeFileSync(speak, `#!/usr/bin/env bash\nprintf '%s\\n' "$2" >> ${JSON.stringify(speakLog)}\n`
      + `out=${JSON.stringify(root)}/speak-$RANDOM.ogg\nprintf 'OggS' > "$out"\necho "$out"\n`)
    chmodSync(speak, 0o755)
    const bin = fakeTmux(root)

    let pending: any[] = [{ id: 81, text: 'what is two plus two', from: 'owner', chat_id: '91' }]
    const outbound: any[] = []
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') return Response.json({ pending })
        if (url.pathname === '/server/messages/pending/ack') {
          const body = await req.json() as { ids: number[] }
          pending = pending.filter(m => !body.ids.includes(m.id))
          return Response.json({ ok: true, acked: body.ids.length })
        }
        if (url.pathname === '/server/messages/event') {
          outbound.push(await req.json())
          return Response.json({ id: 200 + outbound.length })
        }
        return new Response('not found', { status: 404 })
      },
    })
    // The argv flag is what ~/.gemini/config/mcp_config.json passes (5dive-agent-start).
    const child = Bun.spawn(['bun', SERVER, '--runtime=antigravity'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_DISPATCHER_STATE_DIR: dispatcherState,
        DASHBOARD_AGY_TIMINGS: JSON.stringify({ idleMs: 1_200, maxMs: 5_000 }),
        DASHBOARD_AGY_POLL_MS: '100',
        DASHBOARD_DISPATCHER_SWEEP_MS: '200',
        DASHBOARD_INBOX_SWEEP_MS: '200',
        DASHBOARD_STATE_DIR: dashboardState,
        DASHBOARD_OUTBOX: sharedOutbox,
        DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
        DASHBOARD_SPEAK: speak,
        DASHBOARD_FFMPEG: '/bin/false',
        DASHBOARD_FFPROBE: '/bin/false',
        CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
        USER: 'agent-agydash',
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    // agy's side of the MCP stdio: initialize, list tools, call reply.
    const results = new Map<number, any>()
    const send = (m: unknown) => { child.stdin.write(JSON.stringify(m) + '\n'); child.stdin.flush() }
    void (async () => {
      const reader = child.stdout.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) {
          try { const m = JSON.parse(l); if (typeof m.id === 'number') results.set(m.id, m.result ?? m.error) } catch {}
        }
      }
    })()
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agy', version: '1.1.7' } } })
    await waitFor(() => results.has(1))
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(String(results.get(1).instructions)).toContain('[5dive web chat')
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await waitFor(() => results.has(2))
    expect(results.get(2).tools.map((t: any) => t.name)).toEqual(['reply'])

    const typed = () => { try { return readFileSync(join(root, 'typed.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string) } catch { return [] } }
    const reply = (id: number, args: Record<string, unknown>) =>
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'reply', arguments: args } })

    // 1. A typed message is typed into agy's pane, with the chat to answer.
    await waitFor(() => typed().length === 1)
    expect(typed()[0]).toContain('chat_id "91"')
    expect(typed()[0]).toContain('what is two plus two')
    expect(readFileSync(join(root, 'tmux.log'), 'utf8')).toContain('"agent-agydash"')
    reply(10, { chat_id: '91', text: 'Four.' })
    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({ agent: 'agydash', body: 'Four.', metadata: { chat_id: '91' } })

    // 2. A voice note: agy's one voice reply is sent, then spoken as one voice file.
    const inbox = join(dashboardState, 'agent-inbox')
    drop(inbox, 'v', { text: '[voice note] what is seventeen times three', chat_id: '91' })
    await waitFor(() => typed().length === 2)
    expect(typed()[1]).toContain('voice: true')
    reply(11, { chat_id: '91', text: 'Fifty-one.', voice: true })
    await waitFor(() => outbound.length === 3)
    expect(outbound[1].body).toBe('Fifty-one.')
    expect(outbound[2].metadata.files[0]).toMatch(/\.ogg$/)
    expect(readFileSync(speakLog, 'utf8').trim().split('\n')).toEqual(['Fifty-one.'])

    // Answered messages get no notice, even after the idle window.
    await Bun.sleep(1_800)
    expect(outbound).toHaveLength(3)

    // 3. agy takes a message and never replies: a visible notice, not silence.
    drop(inbox, 's', { text: 'hello?', chat_id: '91' })
    await waitFor(() => outbound.length === 4)
    expect(outbound[3]).toMatchObject({ body: AGY_NO_ANSWER_TEXT, metadata: { chat_id: '91' } })

    // 4. agy waiting for its Google sign-in: nothing is typed, the chat says why.
    writeFileSync(join(root, 'pane'), 'Waiting for authentication (timeout 60s)...')
    const before = typed().length
    drop(inbox, 'o', { text: 'still there?', chat_id: '91' })
    await waitFor(() => outbound.length === 5)
    expect(outbound[4].body).toBe(AGY_SIGNED_OUT_TEXT)
    expect(typed()).toHaveLength(before)
  }, 30_000)
})
