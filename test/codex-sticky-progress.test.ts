// DIVE-5504 item 7: one acknowledgement per Codex turn on Telegram, edited
// silently with progress, and one notification per turn (its last answer).
// Before 0.5.29 the dispatcher path showed "typing…" and then sent every
// message the model wrote, each one a phone notification.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ChannelDispatcher, PROGRESS_MIN_MS, progressStatus, type DispatchMessage, type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'
import { ACK_DELAY_MS, ProgressAcks, ackText } from '../plugins/telegram-codex/progress.ts'

const tg = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })

function harness() {
  const published: Array<{ route: any; text: string; meta: any }> = []
  let turn = 1
  const rpc: RpcPort = {
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: `turn-${turn++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  let saved: any = null
  const dispatcher = new ChannelDispatcher(rpc, { load: () => saved, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) } }, '/w')
  return { dispatcher, published }
}
const msg = (turnId: string, id: string, text: string, phase?: string) =>
  ({ turnId, item: { id, type: 'agentMessage', text, ...(phase ? { phase } : {}) } })

describe('dispatcher: which messages notify', () => {
  test('commentary is silent, the final answer notifies, and progress is reported per step', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'Looking at the tests.', 'commentary'))
    // a step inside the throttle window is counted but not sent; one after it is sent
    await h.dispatcher.notification('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', command: 'npm test' } })
    await new Promise(r => setTimeout(r, PROGRESS_MIN_MS + 50))
    await h.dispatcher.notification('item/started', { turnId: 'turn-1', item: { type: 'fileChange', changes: [{}, {}] } })
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b', 'Fixed: two files.', 'final_answer'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    expect(h.published.map(p => [p.meta.kind, p.text, p.meta.notify])).toEqual([
      ['progress', 'starting', undefined],
      ['message', 'Looking at the tests.', false],
      ['progress', 'editing 2 files', undefined],
      ['message', 'Fixed: two files.', true],
      ['progress-done', expect.stringMatching(/^✅ Done in \d+s · 2 steps$/), undefined],
    ])
    expect(h.published.filter(p => p.meta.kind === 'message' && p.meta.notify !== false)).toHaveLength(1)
  }, 10_000)

  test('unknown phase: each message is held until the next shows it was not the last; only the last notifies', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'one'))
    expect(h.published.filter(p => p.meta.kind === 'message')).toEqual([])
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b', 'two'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.published.filter(p => p.meta.kind === 'message').map(p => [p.text, p.meta.notify])).toEqual([['one', false], ['two', true]])
  })

  test('a failed turn: the held message goes silently and the error is the notification', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'partial'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'quota' } } })
    expect(h.published.map(p => [p.meta.kind, p.text, p.meta.notify])).toEqual([
      ['progress', 'starting', undefined],
      ['message', 'partial', false],
      ['progress-done', expect.stringMatching(/^⚠️ Stopped after \d+s$/), undefined],
      ['error', 'Codex could not complete this turn: quota', undefined],
    ])
  })

  test('NEGATIVE: a dashboard turn gets no progress and keeps plain replies', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit({ id: 'd1', text: 'hi', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await h.dispatcher.notification('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', command: 'ls' } })
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'hello'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.published.map(p => [p.meta.kind, p.text, p.meta.notify])).toEqual([['message', 'hello', undefined]])
  })

  test('progressStatus names a step briefly and ignores non-steps', () => {
    expect(progressStatus({ type: 'commandExecution', command: 'npm   test' })).toBe('running `npm test`')
    expect(progressStatus({ type: 'webSearch', query: 'bun fs.watch' })).toBe('searching the web for "bun fs.watch"')
    expect(progressStatus({ type: 'mcpToolCall', server: 'gh', tool: 'pr_view' })).toBe('using gh.pr_view')
    expect(progressStatus({ type: 'reasoning' })).toBeNull()
    expect(progressStatus({ type: 'agentMessage' })).toBeNull()
  })
})

describe('adapter: one silent ack per turn', () => {
  function io() {
    let now = 0
    const timers: Array<{ at: number; fn: () => void }> = []
    const sent: Array<{ chat: string; text: string }> = []
    const edits: Array<{ id: number; text: string }> = []
    return {
      sent, edits,
      advance(ms: number) { now += ms; for (const t of timers.splice(0)) { if (t.at <= now) t.fn(); else timers.push(t) } },
      io: {
        send: async (chat: string, _t: string | undefined, text: string) => { sent.push({ chat, text }); return 900 + sent.length },
        edit: async (_c: string, id: number, text: string) => { edits.push({ id, text }) },
        now: () => now,
        later: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }) },
      },
    }
  }
  const flush = () => new Promise(r => setTimeout(r, 0))

  test('a quick turn shows no ack at all', async () => {
    const x = io(); const acks = new ProgressAcks(x.io)
    acks.progress('42:t1', '42', undefined, 'starting')
    x.advance(ACK_DELAY_MS - 1000)
    acks.done('42:t1', '✅ Done in 7s')
    x.advance(5000); await flush()
    expect(x.sent).toEqual([]); expect(x.edits).toEqual([])
  })

  test('a long turn: ONE ack after the delay, edited with progress, closed with the summary', async () => {
    const x = io(); const acks = new ProgressAcks(x.io)
    acks.progress('42:t1', '42', undefined, 'starting')
    x.advance(ACK_DELAY_MS); await flush()
    expect(x.sent).toEqual([{ chat: '42', text: '⏳ Working on it · 8s' }])
    acks.progress('42:t1', '42', undefined, 'running `npm test`'); await flush()
    acks.progress('42:t1', '42', undefined, 'editing 2 files'); await flush()
    acks.done('42:t1', '✅ Done in 40s · 2 steps'); await flush()
    expect(x.sent).toHaveLength(1)
    expect(x.edits.map(e => e.text)).toEqual(['⏳ Working on it · running `npm test` · 8s', '⏳ Working on it · editing 2 files · 8s', '✅ Done in 40s · 2 steps'])
    expect(new Set(x.edits.map(e => e.id))).toEqual(new Set([901]))
    expect(acks.has('42:t1')).toBe(false)
  })

  test('ackText', () => {
    expect(ackText('starting', 61_000)).toBe('⏳ Working on it · 1m 01s')
  })

  test('wiring: progress events never become chat messages; silent messages carry disable_notification', () => {
    const s = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'server.ts'), 'utf8')
    expect(s).toMatch(/if \(obj\.kind === 'progress' \|\| obj\.kind === 'progress-done'\) \{[\s\S]{0,200}unlinkSync\(full\)/)
    expect(s).toContain("const silent = obj.notify === false ? { disable_notification: true } : {}")
    expect(s).toMatch(/disable_notification: true, \.\.\.\(threadId/)
  })
})
