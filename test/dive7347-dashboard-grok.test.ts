// DIVE-7347: the web chat on a Grok seat. The dashboard server runs its Codex
// adapter shape and grokdispatch.ts plays the dispatcher: the message is typed
// into Grok's pane, the answer read back from ~/.grok/sessions/*/*/updates.jsonl.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GrokTurns, NO_ANSWER_TEXT, NOT_TAKEN_TEXT, SIGNED_OUT_TEXT, WEB_CHAT_HEADER,
  parseUpdateLine, promptFor, signedOut, type GrokUpdate, type OutboxReply,
} from '../plugins/dashboard/grokdispatch.ts'

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

// The record shape the `agent ask` reader's test uses (DIVE-7340).
const line = (kind: string, text: string) =>
  JSON.stringify({ sessionId: '0b8f6e1c', update: { sessionUpdate: kind, content: { type: 'text', text } } })
const upd = (kind: string, text = '') => parseUpdateLine(line(kind, text))!

function rig() {
  let now = 0
  const out: OutboxReply[] = []
  const turns = new GrokTurns(r => out.push(r), () => now, {
    segmentQuietMs: 4_000, acceptMs: 120_000, noAnswerMs: 180_000, followIdleMs: 600_000, looseMatchMs: 30_000,
  })
  return { turns, out, advance: (ms: number) => { now += ms; turns.tick() }, feed: (u: GrokUpdate) => turns.feed(u) }
}
const route = { source: 'dashboard' as const, chat_id: 'dashboard' }

describe('reading a Grok session update', () => {
  test('finds the update at any depth and joins text content', () => {
    expect(upd('agent_message_chunk', 'Hi')).toMatchObject({ kind: 'agent_message_chunk', text: 'Hi' })
    const deep = parseUpdateLine(JSON.stringify({ jsonrpc: '2.0', params: { update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'a' }, { type: 'image' }, 'b'] } } }))
    expect(deep).toMatchObject({ kind: 'agent_message_chunk', text: 'ab' })
    expect(parseUpdateLine('{"sessionUpdate": "agent_mes')).toBeNull()   // a half-written line
    expect(parseUpdateLine('{"other":1}')).toBeNull()
  })

  test("Grok's sign-in screen is recognised", () => {
    expect(signedOut('Sign in to Grok\nOpen this URL in your browser to approve:\nhttps://x')).toBe(true)
    expect(signedOut('Approve in your browser to finish signing in.\nWaiting for approval...')).toBe(true)
    expect(signedOut('> Ask Grok anything\nWorked for 2.3s')).toBe(false)
  })

  test('the typed prompt names the web chat and carries the message', () => {
    const p = promptFor({ text: '  what is the time\nin Tokyo ' })
    expect(p.prompt).toBe(`${WEB_CHAT_HEADER}\nwhat is the time\nin Tokyo`)
    expect(p.needle).toBe('what is the time in Tokyo')
    const v = promptFor({ text: '[voice note]', image_path: '/home/claude/chat-uploads/x/n.webm' }, true)
    expect(v.prompt).toContain('[Voice note: /home/claude/chat-uploads/x/n.webm. Run 5dive-transcribe /home/claude/chat-uploads/x/n.webm')
  })
})

describe('turning Grok updates into web-chat replies', () => {
  test("Grok's answer after our message is the reply, and text from before it is not", () => {
    const r = rig()
    r.feed(upd('user_message_chunk', 'an earlier Telegram turn'))
    r.feed(upd('agent_message_chunk', 'not for the web chat'))
    r.turns.expect('m1', 'hello there', { ...route, voice: true })
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nhello there`))
    r.feed(upd('agent_message_chunk', 'Hi! '))
    r.feed(upd('agent_message_chunk', 'How can I help?'))
    r.advance(4_000)
    expect(r.out).toEqual([{ source: 'dashboard', chat_id: 'dashboard', voice: true, text: 'Hi! How can I help?', kind: 'message' }])
  })

  // DIVE-7351: the live arm's voice question got two voice notes, the narration
  // before a tool call and then the answer.
  test('narration before a tool call is not sent: one voice question gets one spoken answer', () => {
    const r = rig()
    r.turns.expect('m1', 'what is seventeen times three', { ...route, voice: true })
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nwhat is seventeen times three`))
    r.feed(upd('agent_message_chunk', "I'll transcribe the voice note and answer from what it says."))
    r.feed(upd('agent_thought_chunk', 'run it'))   // a record between the text and its tool call
    r.feed(upd('tool_call', '5dive-transcribe'))
    r.advance(6_000)
    expect(r.out).toEqual([])
    r.feed(upd('tool_call_update', 'done'))
    r.feed(upd('agent_message_chunk', 'Fifty-one'))
    r.advance(4_000)
    r.advance(30_000)
    expect(r.out).toEqual([{ source: 'dashboard', chat_id: 'dashboard', voice: true, text: 'Fifty-one', kind: 'message' }])
  })

  test('held text is sent when the turn ends on it, and only the first message is spoken', () => {
    const r = rig()
    r.turns.expect('m1', 'save this', { ...route, voice: true })
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nsave this`))
    r.feed(upd('agent_message_chunk', 'Saved it.'))
    r.feed(parseUpdateLine(JSON.stringify({ update: { sessionUpdate: 'tool_call', status: 'pending', title: 'memory write' } }))!)
    r.advance(15_000)
    expect(r.out).toEqual([])   // the tool still runs
    r.feed(parseUpdateLine(JSON.stringify({ update: { sessionUpdate: 'tool_call_update', status: 'completed' } }))!)
    r.advance(9_000)
    expect(r.out).toEqual([])
    r.advance(2_000)
    expect(r.out).toEqual([{ ...route, voice: true, text: 'Saved it.', kind: 'message' }])
    r.feed(upd('agent_message_chunk', 'Anything else?'))
    r.advance(5_000)
    expect(r.out[1]).toEqual({ ...route, text: 'Anything else?', kind: 'message' })
  })

  test('held text before the Telegram listen call is the answer', () => {
    const r = rig()
    r.turns.expect('m1', 'hi', route)
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nhi`))
    r.feed(upd('agent_message_chunk', 'Hello!'))
    r.feed(upd('tool_call', 'telegram__wait_for_message'))
    expect(r.out.map(o => o.text)).toEqual(['Hello!'])
    expect(r.turns.busy()).toBe(false)
  })

  test('a streamed answer with no following record is sent once it goes quiet', () => {
    const r = rig()
    r.turns.expect('m1', 'ping', route)
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nping`))
    r.feed(upd('agent_message_chunk', 'pong'))
    r.advance(3_000)
    expect(r.out).toEqual([])
    r.advance(1_500)
    expect(r.out.map(o => o.text)).toEqual(['pong'])
  })

  test('a message Grok takes and never answers ends in a visible notice, not silence', () => {
    const r = rig()
    r.turns.expect('m1', 'do the thing', route)
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\ndo the thing`))
    r.feed(upd('tool_call', 'telegram reply'))
    r.advance(180_000)
    expect(r.out).toEqual([{ ...route, text: NO_ANSWER_TEXT, kind: 'error' }])
    r.advance(600_000)
    expect(r.out).toHaveLength(1)   // one notice, not one per tick
  })

  test('a message Grok never takes ends in a visible notice', () => {
    const r = rig()
    r.turns.expect('m1', 'are you there', route)
    r.advance(119_000)
    expect(r.out).toEqual([])
    r.advance(1_000)
    expect(r.out).toEqual([{ ...route, text: NOT_TAKEN_TEXT, kind: 'error' }])
    expect(r.turns.busy()).toBe(false)
  })

  test("the Telegram bridge's re-arm kick and its listen call end the web-chat turn", () => {
    const r = rig()
    r.turns.expect('m1', 'first', route)
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nfirst`))
    r.feed(upd('agent_message_chunk', 'answer one'))
    r.feed(upd('tool_call', 'telegram__wait_for_message'))
    r.feed(upd('agent_message_chunk', 'a Telegram answer'))
    r.advance(10_000)
    expect(r.out.map(o => o.text)).toEqual(['answer one'])
    expect(r.turns.busy()).toBe(false)

    r.turns.expect('m2', 'second', route)
    r.advance(40_000)   // past the loose-match window
    r.feed(upd('user_message_chunk', 'A Telegram message is waiting: call wait_for_message now'))
    r.feed(upd('agent_message_chunk', 'kick answer'))
    r.advance(5_000)
    expect(r.out.map(o => o.text)).toEqual(['answer one'])
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\nsecond`))
    r.feed(upd('agent_message_chunk', 'answer two'))
    r.advance(5_000)
    expect(r.out.map(o => o.text)).toEqual(['answer one', 'answer two'])
  })

  test('two queued messages are answered in order, each to its own chat', () => {
    const r = rig()
    r.turns.expect('m1', 'one', { source: 'dashboard', chat_id: 'a' })
    r.turns.expect('m2', 'two', { source: 'dashboard', chat_id: 'b' })
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\none`))
    r.feed(upd('agent_message_chunk', 'reply one'))
    r.feed(upd('user_message_chunk', `${WEB_CHAT_HEADER}\ntwo`))
    r.feed(upd('agent_message_chunk', 'reply two'))
    r.advance(5_000)
    expect(r.out.map(o => [o.chat_id, o.text])).toEqual([['a', 'reply one'], ['b', 'reply two']])
  })
})

// A stand-in for tmux + Grok: capture-pane prints the pane file; paste-buffer
// "types" the buffer; Enter makes "Grok" write the user turn and its answer into
// a session file, the way Grok writes updates.jsonl.
function fakeGrok(root: string) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const tmux = join(bin, 'tmux')
  writeFileSync(tmux, `#!/usr/bin/env python3
import json, os, sys, time
root = ${JSON.stringify(root)}
a = sys.argv[1:]
open(os.path.join(root, 'tmux.log'), 'a').write(json.dumps(a) + '\\n')
buf, typed = os.path.join(root, 'buf'), os.path.join(root, 'typed')
if a[0] == 'capture-pane':
    p = os.path.join(root, 'pane')
    sys.stdout.write(open(p).read() if os.path.exists(p) else '> Ask Grok anything')
elif a[0] == 'set-buffer':
    open(buf, 'w').write(a[a.index('--') + 1])
elif a[0] == 'paste-buffer':
    open(typed, 'a').write(open(buf).read())
elif a[0] == 'send-keys' and a[-1] == 'Enter':
    if not os.path.exists(typed):
        sys.exit(0)
    text = open(typed).read(); os.unlink(typed)
    d = os.path.join(root, 'sessions', '-home-agent-grokdash', 'sess1')
    os.makedirs(d, exist_ok=True)
    def rec(k, t):
        return json.dumps({'sessionId': 'sess1', 'update': {'sessionUpdate': k, 'content': {'type': 'text', 'text': t}}}) + '\\n'
    with open(os.path.join(d, 'updates.jsonl'), 'a') as f:
        f.write(rec('user_message_chunk', text)); f.flush()
        if not os.path.exists(os.path.join(root, 'silent')):
            ask = text.split('\\n', 1)[1] if '\\n' in text else text
            f.write(rec('agent_message_chunk', 'Grok says: ')); f.flush()
            time.sleep(0.05)
            f.write(rec('agent_message_chunk', ask.upper())); f.flush()
        f.write(json.dumps({'sessionId': 'sess1', 'update': {'sessionUpdate': 'available_commands_update'}}) + '\\n')
`)
  chmodSync(tmux, 0o755)
  return bin
}

describe('Grok web chat end to end', () => {
  test("a typed message gets Grok's answer, a voice note gets it spoken, and a silent Grok gets a notice", async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-dashboard-'))
    const dashboardState = join(root, '.claude', 'channels', 'dashboard')
    const dispatcherState = join(root, '.grok', 'channels', 'dashboard-dispatcher')
    const sharedOutbox = join(root, 'downloads')
    mkdirSync(sharedOutbox, { recursive: true })
    const speakLog = join(root, 'speak.log')
    const speak = join(root, '5dive-speak')
    writeFileSync(speak, `#!/usr/bin/env bash\nprintf '%s\\n' "$2" >> ${JSON.stringify(speakLog)}\n`
      + `out=${JSON.stringify(root)}/speak-$RANDOM.ogg\nprintf 'OggS' > "$out"\necho "$out"\n`)
    chmodSync(speak, 0o755)
    const bin = fakeGrok(root)

    let pending: any[] = [{ id: 81, text: 'what is two plus two', from: 'owner', chat_id: 'dashboard' }]
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
    // The argv flag is what ~/.grok/config.toml passes (5dive-agent-start).
    const child = Bun.spawn(['bun', SERVER, '--runtime=grok'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_DISPATCHER_STATE_DIR: dispatcherState,
        DASHBOARD_GROK_SESSIONS: join(root, 'sessions'),
        DASHBOARD_GROK_TIMINGS: JSON.stringify({ segmentQuietMs: 300, noAnswerMs: 1_500, acceptMs: 3_000, followIdleMs: 2_000 }),
        DASHBOARD_DISPATCHER_SWEEP_MS: '200',
        DASHBOARD_INBOX_SWEEP_MS: '200',
        DASHBOARD_STATE_DIR: dashboardState,
        DASHBOARD_OUTBOX: sharedOutbox,
        DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
        DASHBOARD_SPEAK: speak,
        DASHBOARD_FFMPEG: '/bin/false',
        DASHBOARD_FFPROBE: '/bin/false',
        CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
        USER: 'agent-grokdash',
      },
      // Grok holds the MCP stdio open for as long as the session runs.
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    // 1. A typed message: Grok's own answer, text only, in the chat it came from.
    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({ agent: 'grokdash', body: 'Grok says: WHAT IS TWO PLUS TWO', metadata: { chat_id: 'dashboard' } })
    expect(outbound[0].metadata.files).toBeUndefined()
    const log = readFileSync(join(root, 'tmux.log'), 'utf8')
    expect(log).toContain('"paste-buffer", "-p", "-d"')
    expect(log).toContain('"agent-grokdash"')

    // 2. A voice note: the answer is sent, then spoken as a voice file.
    const inbox = join(dashboardState, 'agent-inbox')
    writeFileSync(join(inbox, '.v.tmp'), JSON.stringify({ text: '[voice note] good morning', chat_id: 'dashboard' }))
    require('node:fs').renameSync(join(inbox, '.v.tmp'), join(inbox, 'v.json'))
    await waitFor(() => outbound.length === 3)
    expect(outbound[1].body).toBe('Grok says: [VOICE NOTE] GOOD MORNING')
    expect(readFileSync(speakLog, 'utf8').trim()).toBe('Grok says: [VOICE NOTE] GOOD MORNING')
    expect(outbound[2].metadata.files[0]).toMatch(/\.ogg$/)

    // 3. Grok takes a message and writes nothing: a visible notice, not silence.
    writeFileSync(join(root, 'silent'), '')
    writeFileSync(join(inbox, '.s.tmp'), JSON.stringify({ text: 'hello?', chat_id: 'dashboard' }))
    require('node:fs').renameSync(join(inbox, '.s.tmp'), join(inbox, 's.json'))
    await waitFor(() => outbound.length === 4)
    expect(outbound[3].body).toBe(NO_ANSWER_TEXT)

    // 4. Grok on its sign-in screen: nothing is typed, the chat says why.
    writeFileSync(join(root, 'pane'), 'Sign in to Grok\nOpen this URL in your browser to approve:\nhttps://accounts.x.ai/device')
    const typedBefore = readFileSync(join(root, 'tmux.log'), 'utf8').split('\n').filter(l => l.includes('paste-buffer')).length
    writeFileSync(join(inbox, '.o.tmp'), JSON.stringify({ text: 'still there?', chat_id: 'dashboard' }))
    require('node:fs').renameSync(join(inbox, '.o.tmp'), join(inbox, 'o.json'))
    await waitFor(() => outbound.length === 5)
    expect(outbound[4].body).toBe(SIGNED_OUT_TEXT)
    expect(readFileSync(join(root, 'tmux.log'), 'utf8').split('\n').filter(l => l.includes('paste-buffer')).length).toBe(typedBefore)
    expect(existsSync(join(dispatcherState, 'outbox', 'dashboard'))).toBe(true)
  }, 30_000)
})
