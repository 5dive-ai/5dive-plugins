// DIVE-6715: the web chat gave less than Telegram for the same agent. These
// drive the REAL dashboard hooks (and the real server for the send side) with an
// isolated state dir and a recording stand-in for the root relay:
//   1. a reply the agent wrote in its session without the reply tool reaches the chat;
//   2. AskUserQuestion becomes buttons in the chat and the person's tap is the answer;
//   3. the chat shows "working: <step>" from the first message to the end of the turn.
// (4, the phone push, is the api's: src/lib/chat-reply-push.test.ts in 5dive-api.)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveAnswer } from '../plugins/dashboard/hooks/lib/dashboard-chat.ts'
import { newestInboundSource } from '../plugins/telegram/hooks/lib/transcript.ts'
import { makeWorkStatus } from '../plugins/dashboard/workstatus.ts'
import { numberedText, parseQuestion } from '../plugins/dashboard/question.ts'

const ROOT = join(import.meta.dir, '..', 'plugins')
const HOOKS = join(ROOT, 'dashboard', 'hooks')
const SERVER = join(ROOT, 'dashboard', 'server.ts')

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dash-6715-')) })
afterEach(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const dashIn = (text: string, chat = '41') => ({
  type: 'user',
  message: { role: 'user', content: `<channel source="plugin:dashboard:dashboard" chat_id="${chat}" user="owner" ts="2026-10-22T03:00:00Z">${text}</channel>` },
})
const tgIn = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="111" message_id="5" user="owner" ts="2026-10-22T03:00:00Z">${text}</channel>` },
})
const said = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const ran = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
})
const dashReply = () => ran('mcp__plugin_dashboard_dashboard__reply', { chat_id: '41', text: 'done' })

function transcript(entries: unknown[]): string {
  const p = join(home, 'transcript.jsonl')
  writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return p
}
const state = () => join(home, 'state')
const outbox = () => {
  const d = join(state(), 'notice-outbox')
  return existsSync(d) ? readdirSync(d).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(d, n), 'utf8'))) : []
}

function runHook(name: string, payload: unknown, env: Record<string, string> = {}): { stdout: string; stderr: string } {
  const r = spawnSync('bun', [join(HOOKS, name)], {
    input: JSON.stringify(payload),
    env: { ...process.env, DASHBOARD_STATE_DIR: state(), HOME: home, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  })
  return { stdout: r.stdout, stderr: r.stderr }
}

// ---------------------------------------------------------------------------
describe('1. a reply written in the session reaches the web chat', () => {
  test('text after a web-chat message with no reply tool is sent to that chat', () => {
    const t = transcript([dashIn('what is the weather?'), said('Sunny, 21°C.')])
    const r = runHook('stop-reply-relay.ts', { transcript_path: t })
    expect(r.stdout).toBe('')
    expect(outbox()).toEqual([{ source: 'dashboard', chat_id: '41', text: 'Sunny, 21°C.' }])
  })

  test('a turn that used the reply tool relays nothing (the loose text is narration)', () => {
    runHook('stop-reply-relay.ts', { transcript_path: transcript([dashIn('hi'), said('Let me check.'), dashReply(), said('Replied.')]) })
    expect(outbox()).toEqual([])
  })

  test('a Telegram turn and an older web-chat message are not the web chat’s', () => {
    runHook('stop-reply-relay.ts', { transcript_path: transcript([dashIn('old'), dashReply(), tgIn('hello'), said('Hi there')]) })
    expect(outbox()).toEqual([])
  })

  test('nothing said and nothing run: the Stop is blocked once, never on re-entry or on "thanks"', () => {
    const t = transcript([dashIn('please send the report')])
    expect(JSON.parse(runHook('stop-reply-relay.ts', { transcript_path: t }).stdout).decision).toBe('block')
    expect(runHook('stop-reply-relay.ts', { transcript_path: t, stop_hook_active: true }).stdout).toBe('')
    expect(runHook('stop-reply-relay.ts', { transcript_path: transcript([dashIn('thanks!')]) }).stdout).toBe('')
    expect(outbox()).toEqual([])
  })

  test('every Stop stamps the end of the turn for the live status', () => {
    runHook('stop-reply-relay.ts', { transcript_path: transcript([tgIn('x')]) })
    expect(Number(readFileSync(join(state(), 'turn-ended'), 'utf8'))).toBeGreaterThan(Date.now() - 10_000)
  })
})

// ---------------------------------------------------------------------------
const ASK = {
  questions: [{
    question: 'Which plan should I book?',
    header: 'Plan',
    multiSelect: false,
    options: [
      { label: 'Basic', description: '$5 a month' },
      { label: 'Pro', description: '$20 a month' },
      { label: 'Skip for now' },
    ],
  }],
}

describe('2. AskUserQuestion becomes buttons in the web chat', () => {
  test('the question is posted with its buttons, and the answer the server writes comes back as the result', async () => {
    const t = transcript([dashIn('book me a plan')])
    const proc = Bun.spawn(['bun', join(HOOKS, 'pretool-question.ts')], {
      env: { ...process.env, DASHBOARD_STATE_DIR: state(), HOME: home, DASHBOARD_QUESTION_POLL_MS: '50' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    proc.stdin.write(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: ASK, transcript_path: t }))
    proc.stdin.end()
    const qdir = join(state(), 'questions')
    const deadline = Date.now() + 10_000
    let req: string | undefined
    while (Date.now() < deadline && !(req = existsSync(qdir) ? readdirSync(qdir).find(n => n.endsWith('.req.json')) : undefined)) await Bun.sleep(25)
    expect(req).toBeDefined()
    const posted = outbox()
    expect(posted).toHaveLength(1)
    expect(posted[0].chat_id).toBe('41')
    expect(posted[0].text).toBe('Plan\nWhich plan should I book?')
    expect(posted[0].question.options).toEqual([
      { label: 'Basic', description: '$5 a month' },
      { label: 'Pro', description: '$20 a month' },
      { label: 'Skip for now' },
    ])
    const pending = JSON.parse(readFileSync(join(qdir, req!), 'utf8'))
    expect(pending.id).toBe(posted[0].question.id)
    writeFileSync(join(qdir, `${pending.id}.ans.json`), JSON.stringify(resolveAnswer(pending, 'Pro')))
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason
    expect(reason).toContain('The user selected: "Pro" ($20 a month)')
    expect(reason).toContain('Answered in the dashboard chat')
    expect(readdirSync(qdir)).toEqual([])
  }, 20_000)

  test('a Telegram turn is left to Telegram’s hook: no decision, nothing posted', () => {
    const r = runHook('pretool-question.ts', { tool_name: 'AskUserQuestion', tool_input: ASK, transcript_path: transcript([dashIn('a'), tgIn('b')]) })
    expect(r.stdout).toBe('')
    expect(outbox()).toEqual([])
  })

  test('a shape buttons cannot carry is denied with "ask in a reply"', () => {
    const multi = { questions: [ASK.questions[0], ASK.questions[0]] }
    const r = runHook('pretool-question.ts', { tool_name: 'AskUserQuestion', tool_input: multi, transcript_path: transcript([dashIn('a')]) })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('mcp__plugin_dashboard_dashboard__reply')
  })

  test('Telegram’s hook stands aside when the web chat spoke last, and keeps its own path otherwise', () => {
    const tg = join(ROOT, 'telegram', 'hooks', 'pretool-question.ts')
    const run = (entries: unknown[]) => spawnSync('bun', [tg], {
      input: JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: ASK, transcript_path: transcript(entries) }),
      env: { ...process.env, HOME: home, TELEGRAM_STATE_DIR: join(home, 'tg'), TELEGRAM_BOT_TOKEN: '' },
      encoding: 'utf8',
    }).stdout
    expect(run([tgIn('a'), dashIn('b')])).toBe('')
    // No Telegram token here, so its own path is the numbered-message deny, as before.
    expect(run([dashIn('a'), tgIn('b')])).toContain('permissionDecision')
  })

  test('the newest message decides, and a tag quoted inside an a2a envelope does not count', () => {
    expect(newestInboundSource([tgIn('a'), dashIn('b')] as never)).toBe('dashboard')
    expect(newestInboundSource([dashIn('a'), tgIn('b')] as never)).toBe('telegram')
    expect(newestInboundSource([dashIn('a'), tgIn('b')] as never, 1)).toBe('telegram')
    expect(newestInboundSource([dashIn('a')] as never, 1)).toBe(null)
    const quoted = { type: 'user', message: { content: '[5dive-msg from=x id=1] look: <channel source="plugin:dashboard:dashboard" chat_id="9">' } }
    expect(newestInboundSource([tgIn('a'), quoted] as never)).toBe('telegram')
  })

  test('a tap, a typed number and the person’s own words each answer', () => {
    const q = { labels: ['Basic', 'Pro'], answers: ['The user selected: "Basic"', 'The user selected: "Pro"'] }
    expect(resolveAnswer(q, ' pro ')).toEqual({ idx: 1, answer: 'The user selected: "Pro"' })
    expect(resolveAnswer(q, '1')).toEqual({ idx: 0, answer: 'The user selected: "Basic"' })
    expect(resolveAnswer(q, 'neither, call me')).toEqual({ idx: -1, answer: 'The user did not pick an option and wrote instead: "neither, call me"' })
  })

  test('only a question the buttons can carry is sent as one; the fallback numbers it', () => {
    expect(parseQuestion({ id: 'q1', options: [{ label: 'A' }] })).toBe(null)
    expect(parseQuestion({ id: 'bad id', options: [{ label: 'A' }, { label: 'B' }] })).toBe(null)
    const q = parseQuestion({ id: 'q1', options: [{ label: 'A', description: 'first' }, { label: 'B' }] })!
    expect(q).toEqual({ id: 'q1', options: [{ label: 'A', description: 'first' }, { label: 'B' }] })
    expect(numberedText('Pick one', q)).toBe('Pick one\n\n1. A — first\n2. B')
  })
})

// ---------------------------------------------------------------------------
describe('3. "working: <step>" from the first message to the end of the turn', () => {
  function rig() {
    let now = 1_000_000
    const posts: Array<[string, boolean, string | null]> = []
    const ws = makeWorkStatus({ post: async (c, a, l) => { posts.push([c, a, l]) }, now: () => now })
    return { ws, posts, at: () => now, step: (ms: number) => { now += ms } }
  }

  test('a web-chat message turns it on, a step names it, the end of the turn turns it off', () => {
    const { ws, posts, at, step } = rig()
    ws.inbound('41')
    step(3_000); ws.label('Running the tests', at())
    step(10_000); ws.ended(at())
    expect(posts).toEqual([['41', true, null], ['41', true, 'Running the tests'], ['41', false, null]])
  })

  test('steps closer than 2 s are held and the newest one is flushed', () => {
    const { ws, posts, at, step } = rig()
    ws.inbound('41')
    step(500); ws.label('Reading files', at())
    step(500); ws.label('Editing files', at())
    step(1_100); ws.tick()
    expect(posts).toEqual([['41', true, null], ['41', true, 'Editing files']])
  })

  test('a step or an end from before the message (another turn) changes nothing', () => {
    const { ws, posts, at, step } = rig()
    const before = at()
    step(1_000); ws.inbound('41')
    step(3_000); ws.label('Old step', before); ws.ended(before)
    expect(posts).toEqual([['41', true, null]])
    expect(ws.active()).toBe('41')
  })

  test('with no web-chat message in flight nothing is posted at all', () => {
    const { ws, posts, at } = rig()
    ws.label('Running a command', at()); ws.ended(at()); ws.tick()
    expect(posts).toEqual([])
  })

  test('a long step is re-sent every minute, and a turn silent past the ceiling ends', () => {
    const { ws, posts, at, step } = rig()
    ws.inbound('41')
    step(3_000); ws.label('Building', at())
    step(61_000); ws.tick()
    expect(posts.at(-1)).toEqual(['41', true, 'Building'])
    step(31 * 60_000); ws.tick()
    expect(posts.at(-1)).toEqual(['41', false, null])
    expect(ws.active()).toBe(null)
  })

  test('the status-label hook writes the step, and the reply tool is not a step', () => {
    runHook('status-label.ts', { tool_name: 'Bash', tool_input: { description: 'Run the unit tests', command: 'bun test' } })
    expect(JSON.parse(readFileSync(join(state(), 'status-label.json'), 'utf8')).label).toBe('Run the unit tests')
    rmSync(join(state(), 'status-label.json'))
    runHook('status-label.ts', { tool_name: 'mcp__plugin_dashboard_dashboard__reply', tool_input: { text: 'x' } })
    expect(existsSync(join(state(), 'status-label.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The server, through a recording stand-in for the root relay (DIVE-5894), the
// path a standard seat takes.
describe('the server sends buttons, takes the tap as the answer, and forwards the status', () => {
  async function withServer(opts: { refuseAsk?: boolean }, body: (s: { dir: string; st: string; ops: () => string[][]; stdout: () => string }) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'dash-6715-srv-'))
    const relay = join(dir, 'relay.ts')
    writeFileSync(relay, `import { appendFileSync } from 'node:fs'
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(${JSON.stringify(dir)} + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') process.stdout.write('200\\n{"pending":[]}')
else if (op[0] === 'ask' && ${opts.refuseAsk ? 'true' : 'false'}) { process.stderr.write('_dashboard_relay allows only ping, pending, ack or event.'); process.exit(2) }
else process.stdout.write('200\\n{"id":7}')
`)
    const envFile = join(dir, 'connectord.env')
    writeFileSync(envFile, 'CONNECTORD_TOKEN=x\n')
    chmodSync(envFile, 0o000)
    const st = join(dir, 'state')
    mkdirSync(join(st, 'notice-outbox'), { recursive: true })
    mkdirSync(join(st, 'agent-inbox'), { recursive: true })
    const proc = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        DASHBOARD_STATE_DIR: st,
        DASHBOARD_API_BASE: 'http://127.0.0.1:9',
        DASHBOARD_OUTBOX: join(dir, 'outbox'),
        CONNECTORD_ENV_FILE: envFile,
        CONNECTORD_TOKEN: undefined as unknown as string,
        DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', relay]),
        USER: 'agent-tap',
        TMUX: '', TMUX_PANE: '',
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n')
    proc.stdin.flush()
    let out = ''
    void (async () => { for await (const c of proc.stdout as unknown as AsyncIterable<Uint8Array>) out += new TextDecoder().decode(c) })()
    const ops = () => (existsSync(join(dir, 'ops.log')) ? readFileSync(join(dir, 'ops.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    try {
      await body({ dir, st, ops, stdout: () => out })
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const until = async (ok: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline && !ok()) await Bun.sleep(100)
    return ok()
  }
  const question = { id: 'q1-1', options: [{ label: 'Basic', description: '$5' }, { label: 'Pro' }] }

  test('a question in the outbox goes out with its buttons (the relay’s ask op)', async () => {
    await withServer({}, async ({ st, ops }) => {
      writeFileSync(join(st, 'notice-outbox', 'q.json'), JSON.stringify({ source: 'dashboard', chat_id: '41', text: 'Which plan?', question }))
      expect(await until(() => ops().some(o => o[0] === 'ask'))).toBe(true)
      expect(ops().find(o => o[0] === 'ask')).toEqual(['ask', '41', 'Which plan?', 'q1-1', 'Basic', '$5', 'Pro', ''])
    })
  }, 30_000)

  test('a relay without the ask op still delivers the question, as numbered lines', async () => {
    await withServer({ refuseAsk: true }, async ({ st, ops }) => {
      writeFileSync(join(st, 'notice-outbox', 'q.json'), JSON.stringify({ source: 'dashboard', chat_id: '41', text: 'Which plan?', question }))
      expect(await until(() => ops().some(o => o[0] === 'event'))).toBe(true)
      expect(ops().find(o => o[0] === 'event')).toEqual(['event', '41', 'Which plan?\n\n1. Basic — $5\n2. Pro'])
    })
  }, 30_000)

  test('the person’s tap answers the waiting question and is not typed into the session', async () => {
    await withServer({}, async ({ st, stdout }) => {
      mkdirSync(join(st, 'questions'), { recursive: true })
      writeFileSync(join(st, 'questions', 'q1-1.req.json'), JSON.stringify({
        id: 'q1-1', chatId: '41', labels: ['Basic', 'Pro'], answers: ['The user selected: "Basic" ($5)', 'The user selected: "Pro"'], createdAt: Date.now(),
      }))
      await Bun.sleep(5_500) // the server's start-up head start before it reads the inbox
      writeFileSync(join(st, 'agent-inbox', 'm1.json'), JSON.stringify({ text: 'Pro', chat_id: '41', ts: new Date().toISOString() }))
      const ans = join(st, 'questions', 'q1-1.ans.json')
      expect(await until(() => existsSync(ans))).toBe(true)
      expect(JSON.parse(readFileSync(ans, 'utf8'))).toEqual({ idx: 1, answer: 'The user selected: "Pro"' })
      await Bun.sleep(500)
      expect(stdout()).not.toContain('notifications/claude/channel')
    })
  }, 30_000)

  test('a web-chat message turns "working" on, a step is forwarded, the end of the turn turns it off', async () => {
    await withServer({}, async ({ st, ops, stdout }) => {
      await Bun.sleep(5_500)
      writeFileSync(join(st, 'agent-inbox', 'm1.json'), JSON.stringify({ text: 'run the tests', chat_id: '41', ts: new Date().toISOString() }))
      expect(await until(() => ops().some(o => o[0] === 'status'))).toBe(true)
      // The control for the tap arm above: an ordinary message IS typed into the session.
      expect(stdout()).toContain('notifications/claude/channel')
      expect(ops().filter(o => o[0] === 'status')[0]).toEqual(['status', '41', '1'])
      await Bun.sleep(2_100)
      writeFileSync(join(st, 'status-label.json'), JSON.stringify({ at: Date.now(), label: 'Running the tests' }))
      expect(await until(() => ops().some(o => o[0] === 'status' && o[3] === 'Running the tests'))).toBe(true)
      writeFileSync(join(st, 'turn-ended'), String(Date.now()))
      expect(await until(() => ops().some(o => o[0] === 'status' && o[2] === '0'))).toBe(true)
    })
  }, 40_000)
})
