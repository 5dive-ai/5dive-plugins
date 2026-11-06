// DIVE-7811: the chat reply cap (DIVE-6862) for every harness, not just Claude
// Code. One arm per harness: an over-cap reply goes back to the model with the
// cut-it message, and the shorter rewrite is what the chat gets.
//
//   codex      dispatcher-core.ts: the over-cap answer is held, the next turn
//              is the cut-it message, the rewrite is published (Telegram and web).
//   grok       grokdispatch.ts: the long answer is held, the cut-it message is
//              typed into Grok's pane, the rewrite reaches the outbox.
//   openclaw   openclawdispatch.ts: a second gateway turn in the same session.
//   hermes     hermes/adapter.py: the final answer is held, the cut-it message
//              is the agent's next message, the rewrite reaches the outbox.
//   agy        its web chat answers through the dashboard reply tool (already
//              capped, DIVE-6862); its Telegram reply tool, like codex's and
//              grok's, now refuses an over-cap reply with the same error.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cutItPrompt, countReplyWords, replyTooLong, REPLY_CUT_TRIES, REPLY_TOO_LONG_RE } from '../plugins/telegram/replycap.ts'
import { ChannelDispatcher, type DispatchMessage, type RpcPort } from '../plugins/telegram-codex/dispatcher-core.ts'
import { GrokTurns, startGrokDispatcher, type OutboxReply } from '../plugins/dashboard/grokdispatch.ts'
import { startOpenclawDispatcher } from '../plugins/dashboard/openclawdispatch.ts'

const ROOT = join(import.meta.dir, '..')
const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ')
const LONG = words(95, 'long')
const SHORT = 'Short answer: it works.'
const CUT_RE = /your last reply was not sent\. too long: \d+ words; cut to 60/

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d }
const waitFor = async (ok: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(20) }
}
const readOutbox = (dir: string): Array<Record<string, unknown>> => {
  try { return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch { return [] }
}

describe('replycap.ts: one rule, five copies', () => {
  test('every plugin copy is byte-identical', () => {
    const want = readFileSync(join(ROOT, 'plugins/telegram/replycap.ts'), 'utf8')
    for (const p of ['dashboard', 'telegram-codex', 'telegram-grok', 'telegram-agy']) {
      expect(readFileSync(join(ROOT, `plugins/${p}/replycap.ts`), 'utf8')).toBe(want)
    }
  })
  test('the cut-it message carries the refusal the stop hooks know, and says only the rewrite is sent', () => {
    const p = cutItPrompt(replyTooLong(LONG)!)
    expect(REPLY_TOO_LONG_RE.test(p)).toBe(true)
    expect(p).toMatch(CUT_RE)
    expect(p).toContain('Only the new version reaches the chat.')
    expect(REPLY_CUT_TRIES).toBe(2)
  })
  test('telegram-codex ships replycap.ts in its package files', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'plugins/telegram-codex/package.json'), 'utf8')).files).toContain('replycap.ts')
  })
})

// ── codex ─────────────────────────────────────────────────────────────────
function codex() {
  const requests: Array<{ method: string; params: any }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  let saved: any = null
  let next = 1
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: `turn-${next++}` } }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      throw new Error(`unexpected ${method}`)
    },
  }
  const d = new ChannelDispatcher(rpc, { load: () => saved, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) } }, '/workspace')
  const answer = async (turn: string, text: string, phase = 'final_answer', status = 'completed') => {
    await d.notification('item/completed', { turnId: turn, item: { id: `${turn}-i`, type: 'agentMessage', text, phase } })
    await d.notification('turn/completed', { turn: { id: turn, status } })
  }
  const turnInputs = () => requests.filter(r => r.method === 'turn/start').map(r => r.params.input.at(-1).text as string)
  const messages = () => published.filter(p => p.meta.kind === 'message')
  return { d, answer, turnInputs, messages, published }
}

describe('codex: an over-cap answer is rewritten, the chat gets the rewrite', () => {
  for (const source of ['telegram', 'dashboard'] as const) {
    test(`${source}: held, the next turn is the cut-it message, only the short version is published`, async () => {
      const h = codex()
      await h.d.initialize()
      const msg: DispatchMessage = { id: 'm1', text: 'how did it go?', route: { source, chat_id: source === 'telegram' ? '42' : 'dashboard' } }
      await h.d.submit(msg)
      await h.answer('turn-1', LONG)
      expect(h.messages()).toEqual([])
      const inputs = h.turnInputs()
      expect(inputs).toHaveLength(2)
      expect(inputs[1]).toMatch(CUT_RE)
      await h.answer('turn-2', SHORT)
      expect(h.messages().map(m => m.text)).toEqual([SHORT])
      expect(h.messages()[0].route).toEqual(msg.route)
      // The rewrite turn opens no second Telegram ack.
      expect(h.published.filter(p => p.meta.kind === 'progress' && p.meta.turnId === 'turn-2')).toEqual([])
    })
  }
  test('after two rewrites the last version goes as written, never silence', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'q', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await h.answer('turn-1', LONG)
    await h.answer('turn-2', LONG)
    await h.answer('turn-3', LONG + ' still')
    expect(h.turnInputs()).toHaveLength(3)
    expect(h.messages().map(m => m.text)).toEqual([LONG + ' still'])
  })
  test('a failed turn sends the held answer as written', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'q', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await h.answer('turn-1', LONG, 'final_answer', 'failed')
    expect(h.turnInputs()).toHaveLength(1)
    expect(h.messages().map(m => m.text)).toEqual([LONG])
  })
  test('agent-to-agent turns and an under-cap answer are not touched; FIVEDIVE_REPLY_MAX_WORDS=0 turns it off', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'a1', text: 'q', route: { source: 'agent', chat_id: 'main' } })
    await h.answer('turn-1', LONG)
    await h.d.submit({ id: 'm2', text: 'q', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await h.answer('turn-2', SHORT)
    const was = process.env.FIVEDIVE_REPLY_MAX_WORDS
    process.env.FIVEDIVE_REPLY_MAX_WORDS = '0'
    try {
      await h.d.submit({ id: 'm3', text: 'q', route: { source: 'dashboard', chat_id: 'dashboard' } })
      await h.answer('turn-3', LONG)
    } finally { if (was === undefined) delete process.env.FIVEDIVE_REPLY_MAX_WORDS; else process.env.FIVEDIVE_REPLY_MAX_WORDS = was }
    expect(h.turnInputs()).toHaveLength(3)
    expect(h.messages().map(m => m.text)).toEqual([LONG, SHORT, LONG])
  })
  test('a message arriving during a rewrite waits for it instead of steering into it', async () => {
    const h = codex()
    await h.d.initialize()
    const route = { source: 'dashboard' as const, chat_id: 'dashboard' }
    await h.d.submit({ id: 'm1', text: 'q', route })
    await h.answer('turn-1', LONG)
    expect(await h.d.submit({ id: 'm2', text: 'next question', route })).toBe('queued')
    await h.answer('turn-2', SHORT)
    expect(h.turnInputs().at(-1)).toBe('next question')
  })
})

// ── grok ──────────────────────────────────────────────────────────────────
const route = { source: 'dashboard' as const, chat_id: 'dashboard' }
const upd = (kind: string, text = '', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ params: { update: { sessionUpdate: kind, content: { type: 'text', text }, ...extra } } })

describe('grok: an over-cap answer is typed back to Grok, the chat gets the rewrite', () => {
  test('GrokTurns: held, onCut asks for rewrite 1 with the long text as fallback; the rewrite is emitted', () => {
    const out: OutboxReply[] = []
    const cuts: Array<{ prompt: string; cut: number; fallback: string }> = []
    let t = 0
    const turns = new GrokTurns(r => out.push(r), () => t, undefined, (_r, prompt, cut, fallback) => cuts.push({ prompt, cut, fallback }))
    turns.expect('m1', 'how did it go?', route)
    turns.feed({ kind: 'user_message_chunk', text: 'how did it go?', raw: '' })
    turns.feed({ kind: 'agent_message_chunk', text: LONG, raw: '' })
    turns.feed({ kind: 'tool_call', text: '', raw: 'wait_for_message' })
    expect(out).toEqual([])
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toMatchObject({ cut: 1, fallback: LONG })
    expect(cuts[0].prompt).toMatch(CUT_RE)
    turns.expect('cut', cuts[0].prompt.slice(0, 80), route, { cut: 1, fallback: LONG })
    turns.feed({ kind: 'user_message_chunk', text: cuts[0].prompt, raw: '' })
    turns.feed({ kind: 'agent_message_chunk', text: SHORT, raw: '' })
    turns.feed({ kind: 'tool_call', text: '', raw: 'wait_for_message' })
    expect(out).toEqual([{ ...route, text: SHORT, kind: 'message' }])
  })
  test('GrokTurns: a rewrite Grok never takes sends the long answer, not a notice', () => {
    const out: OutboxReply[] = []
    let t = 0
    const turns = new GrokTurns(r => out.push(r), () => t, undefined, () => {})
    turns.expect('cut', 'never typed', route, { cut: 1, fallback: LONG })
    t = 200_000
    turns.tick()
    expect(out).toEqual([{ ...route, text: LONG, kind: 'message' }])
  })
  test('dispatcher: the cut-it message is typed into the pane and only the rewrite reaches the outbox', async () => {
    const root = tmp('grok7811-')
    const inbox = join(root, 'inbox'), outbox = join(root, 'outbox'), sessions = join(root, 'sessions')
    const file = join(sessions, 'cwd', 'sess', 'updates.jsonl')
    mkdirSync(join(sessions, 'cwd', 'sess'), { recursive: true })
    writeFileSync(file, '')
    const typed: string[] = []
    const d = startGrokDispatcher({
      inboxDir: inbox, outboxDir: outbox, sessionsRoot: sessions, pollMs: 20, log: () => {},
      pane: {
        capture: async () => '',
        async submit(prompt) {
          typed.push(prompt)
          const answer = CUT_RE.test(prompt) ? SHORT : LONG
          appendFileSync(file, [upd('user_message_chunk', prompt), upd('agent_message_chunk', answer), upd('tool_call', '', { title: 'wait_for_message' })].join('\n') + '\n')
        },
      },
    })
    cleanups.push(() => d.stop())
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, '1.json'), JSON.stringify({ id: 'm1', text: 'how did it go?', route: { chat_id: 'dashboard' } }))
    await waitFor(() => readOutbox(outbox).length >= 1)
    await Bun.sleep(100)
    expect(typed).toHaveLength(2)
    expect(typed[1]).toMatch(CUT_RE)
    expect(readOutbox(outbox)).toEqual([{ ...route, text: SHORT, kind: 'message' }])
  })
})

// ── openclaw ──────────────────────────────────────────────────────────────
describe('openclaw: an over-cap answer gets a second turn in the same session', () => {
  const ok = (text: string) => ({ stdout: JSON.stringify({ status: 'ok', runId: 'r', result: { payloads: [{ text }] } }), stderr: '', code: 0 })
  test('the rewrite is what the chat gets', async () => {
    const root = tmp('oc7811-')
    const prompts: string[] = []
    const d = startOpenclawDispatcher({
      inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'), log: () => {},
      run: async p => { prompts.push(p); return ok(CUT_RE.test(p) ? SHORT : LONG) },
    })
    cleanups.push(() => d.stop())
    writeFileSync(join(root, 'inbox', '1.json'), JSON.stringify({ id: 'm1', text: 'how did it go?', route: { chat_id: 'dashboard' } }))
    await waitFor(() => readOutbox(join(root, 'outbox')).length >= 1)
    await d.idle()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatch(CUT_RE)
    expect(readOutbox(join(root, 'outbox'))).toEqual([{ ...route, text: SHORT, kind: 'message' }])
  })
  test('a rewrite that fails leaves the long answer to go as written; two long rewrites stop there', async () => {
    const root = tmp('oc7811b-')
    let n = 0
    const d = startOpenclawDispatcher({
      inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'), log: () => {},
      run: async () => (n++ === 0 ? ok(LONG) : { stdout: '', stderr: 'boom', code: 1 }),
    })
    cleanups.push(() => d.stop())
    writeFileSync(join(root, 'inbox', '1.json'), JSON.stringify({ id: 'm1', text: 'q', route: { chat_id: 'dashboard' } }))
    await waitFor(() => readOutbox(join(root, 'outbox')).length >= 1)
    expect(readOutbox(join(root, 'outbox'))[0].text).toBe(LONG)

    const root2 = tmp('oc7811c-')
    const prompts: string[] = []
    const d2 = startOpenclawDispatcher({
      inboxDir: join(root2, 'inbox'), outboxDir: join(root2, 'outbox'), log: () => {},
      run: async p => { prompts.push(p); return ok(LONG + ` v${prompts.length}`) },
    })
    cleanups.push(() => d2.stop())
    writeFileSync(join(root2, 'inbox', '1.json'), JSON.stringify({ id: 'm1', text: 'q', route: { chat_id: 'dashboard' } }))
    await waitFor(() => readOutbox(join(root2, 'outbox')).length >= 1)
    expect(prompts).toHaveLength(1 + REPLY_CUT_TRIES)
    expect(readOutbox(join(root2, 'outbox'))[0].text).toBe(LONG + ' v3')
  })
})

// ── hermes ────────────────────────────────────────────────────────────────
const HERMES_STUB = `
import sys, types, enum, dataclasses, asyncio, json, os, importlib.util
from typing import Any, List, Optional
cfg = types.ModuleType('gateway.config'); base = types.ModuleType('gateway.platforms.base')
class Platform(str):
    pass
@dataclasses.dataclass
class PlatformConfig:
    enabled: bool = True
    extra: dict = dataclasses.field(default_factory=dict)
class MessageType(enum.Enum):
    TEXT='text'; PHOTO='photo'; VOICE='voice'; DOCUMENT='document'
@dataclasses.dataclass
class SendResult:
    success: bool; message_id: Optional[str] = None; error: Optional[str] = None
@dataclasses.dataclass
class MessageEvent:
    text: str; message_type: Any = None; source: Any = None; message_id: Any = None; raw_message: Any = None
    timestamp: Any = None; media_urls: List[str] = dataclasses.field(default_factory=list); media_types: List[str] = dataclasses.field(default_factory=list)
class BasePlatformAdapter:
    def __init__(self, config, platform): self.config = config; self.platform = platform; self._running = False; self.name = 'fivedive'; self._active_sessions = {}
    def _mark_connected(self): self._running = True
    def _mark_disconnected(self): self._running = False
    def build_source(self, **kw): return types.SimpleNamespace(**kw)
cfg.Platform = Platform; cfg.PlatformConfig = PlatformConfig
for n in ('MessageType','SendResult','MessageEvent','BasePlatformAdapter'): setattr(base, n, globals()[n])
sys.modules.update({'gateway': types.ModuleType('gateway'), 'gateway.platforms': types.ModuleType('gateway.platforms'), 'gateway.config': cfg, 'gateway.platforms.base': base})
spec = importlib.util.spec_from_file_location('fivedive', sys.argv[1] + '/__init__.py', submodule_search_locations=[sys.argv[1]])
mod = importlib.util.module_from_spec(spec); sys.modules['fivedive'] = mod; spec.loader.exec_module(mod)
from fivedive import adapter as A
cases = json.loads(sys.argv[2])
spool = sys.argv[3]
out = {'parity': [[A.count_reply_words(c), A.reply_too_long(c), A.cut_it_prompt(A.reply_too_long(c) or 'x')] for c in cases]}
ad = A.FiveDiveAdapter(PlatformConfig(extra={'spool_dir': spool}))
heard = []
LONG = ' '.join(['long'] * 95)
async def model(ev):
    # The gateway: the session is busy while the agent answers, then the
    # final answer goes out through send() marked notify, then a progress line
    # (not notify) that the cap must leave alone.
    heard.append(ev.text)
    ad._active_sessions['k'] = True
    answer = 'Short answer: it works.' if 'not sent' in ev.text else LONG
    if ev.text == 'progress':
        await ad.send(ev.source.chat_id, LONG)
    else:
        await ad.send(ev.source.chat_id, answer, metadata={'notify': True})
    del ad._active_sessions['k']
ad.handle_message = model
async def main():
    await ad._on_message({'id': '1', 'text': 'how did it go?', 'route': {'source': 'dashboard', 'chat_id': 'dashboard', 'voice': True}})
    for _ in range(100):
        if len(heard) >= 2 and not ad._cut_tasks: break
        await asyncio.sleep(0.02)
    await ad._on_message({'id': '2', 'text': 'progress', 'route': {'source': 'dashboard', 'chat_id': 'dashboard'}})
asyncio.run(main())
out['heard'] = heard
print(json.dumps(out))
`

describe('hermes: an over-cap final answer goes back to the agent, the chat gets the rewrite', () => {
  const CASES = [LONG, SHORT, 'see https://example.com/a?b=c — done', '```\n' + words(200) + '\n```\nok', '```\nunclosed ' + words(80), '- • — ' + words(70), words(71), 'été 3½ 東京 ' + words(68)]
  test('the Python port counts and refuses exactly like replycap.ts, and the loop sends only the rewrite', async () => {
    const root = tmp('hermes7811-')
    const spool = join(root, 'spool')
    writeFileSync(join(root, 'stub.py'), HERMES_STUB)
    const py = Bun.spawn(['python3', join(root, 'stub.py'), join(ROOT, 'plugins/dashboard/hermes'), JSON.stringify(CASES), spool], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', FIVEDIVE_REPLY_MAX_WORDS: '' }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr] = [await new Response(py.stdout).text(), await new Response(py.stderr).text()]
    expect(await py.exited, stderr).toBe(0)
    const got = JSON.parse(stdout)
    expect(got.parity).toEqual(CASES.map(c => [countReplyWords(c), replyTooLong(c, 70), cutItPrompt(replyTooLong(c, 70) ?? 'x')]))
    expect(got.heard).toHaveLength(3)
    expect(got.heard[1]).toMatch(CUT_RE)
    const sent = readOutbox(join(spool, 'outbox', 'dashboard'))
    // The rewrite is the one reply (spoken: the voice note's answer), and a
    // progress line (not the final answer) is never capped.
    expect(sent).toEqual([
      { source: 'dashboard', chat_id: 'dashboard', text: SHORT, voice: true },
      { source: 'dashboard', chat_id: 'dashboard', text: LONG },
    ])
  }, 20_000)
})

// ── the Telegram reply tools of codex, grok and agy ───────────────────────
describe('telegram-codex / telegram-grok / telegram-agy: reply and edit_message refuse an over-cap text', () => {
  for (const p of ['telegram-codex', 'telegram-grok', 'telegram-agy']) {
    const src = readFileSync(join(ROOT, `plugins/${p}/server.ts`), 'utf8')
    test(`${p}: the refusal comes before anything is sent or the reply stamp is touched`, () => {
      expect(src).toContain("import { replyTooLong } from './replycap.ts'")
      const reply = src.slice(src.indexOf("case 'reply': {"))
      const cap = reply.indexOf('const tooLong = replyTooLong(text)')
      expect(cap).toBeGreaterThan(0)
      expect(reply.slice(cap)).toMatch(/^const tooLong = replyTooLong\(text\)\n\s+if \(tooLong\) throw new Error\(tooLong\)/)
      expect(cap).toBeLessThan(reply.indexOf('assertAllowedChat('))
      expect(cap).toBeLessThan(reply.indexOf('LAST_REPLY_FILE'))
      const edit = src.slice(src.indexOf("case 'edit_message': {"))
      const ecap = edit.indexOf('const editTooLong = replyTooLong(String(args.text))')
      expect(ecap).toBeGreaterThan(0)
      expect(ecap).toBeLessThan(edit.indexOf('editMessageText'))
    })
  }
  test('agy web chat: agy answers through the dashboard reply tool, which is capped in its MCP handler', () => {
    const src = readFileSync(join(ROOT, 'plugins/dashboard/server.ts'), 'utf8')
    const h = src.slice(src.indexOf('mcp.setRequestHandler(CallToolRequestSchema'))
    expect(h.indexOf('const tooLong = replyTooLong(args.text)')).toBeGreaterThan(0)
    expect(h.indexOf('const tooLong = replyTooLong(args.text)')).toBeLessThan(h.indexOf('agyBridge?.watch.replied'))
  })
})
