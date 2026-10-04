// DIVE-5502: context controls on the Codex dispatcher path — a control verb in
// the inbox compacts the live thread or starts a bounded new one, never reaches
// the model as a user turn, and every model call's token use is recorded.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  ChannelDispatcher,
  fmtTokens,
  handoffLine,
  type DispatchMessage,
  type DispatcherState,
  type RpcPort,
  type UsageSample,
} from '../plugins/telegram-codex/dispatcher-core.ts'

const tg = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })
const control = (id: string, op: 'compact' | 'new-session', source: 'telegram' | 'agent' = 'telegram'): DispatchMessage => ({
  id, text: op === 'compact' ? '/context compact' : '/clear', control: op, route: { source, chat_id: source === 'agent' ? '5dive-cli' : '42' },
})

function usage(threadId: string, turnId: string, input: number, cached: number, total: number, window = 258_000) {
  return {
    threadId, turnId,
    tokenUsage: {
      total: { totalTokens: total, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: input + 600, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
      modelContextWindow: window,
    },
  }
}

function harness(initial: DispatcherState | null = null) {
  let saved = initial ? structuredClone(initial) : null
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  const samples: UsageSample[] = []
  let nextThread = 1
  let nextTurn = 1
  const fail = { compact: false, threadStart: false }
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') {
        if (fail.threadStart && nextThread > 1) throw new Error('app-server busy')
        return { thread: { id: `thread-${nextThread++}` } }
      }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'turn/start') return { turn: { id: `turn-${nextTurn++}` } }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      if (method === 'thread/compact/start') {
        if (fail.compact) throw new Error('compaction unavailable')
        return {}
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    { load: () => saved ? structuredClone(saved) : null, save: s => { saved = structuredClone(s) } },
    {
      publish: async (route, text, meta) => { published.push({ route, text, meta }) },
      usage: s => { samples.push(s) },
    },
    '/workspace',
  )
  return { dispatcher, requests, published, samples, fail, persisted: () => saved! }
}

const turnStarts = (h: ReturnType<typeof harness>) => h.requests.filter(r => r.method === 'turn/start')
const inputTexts = (r: { params: Record<string, unknown> }) => (r.params.input as Array<{ text?: string }>).map(i => i.text ?? '')

afterEach(() => setSystemTime())

describe('Codex context controls (DIVE-5502)', () => {
  test('each model call is recorded once; a replayed snapshot or another thread is not a call', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('thread/tokenUsage/updated', usage('thread-1', 'turn-1', 145_871, 140_672, 146_471))
    await h.dispatcher.notification('thread/tokenUsage/updated', usage('thread-1', 'turn-1', 145_871, 140_672, 146_471))
    await h.dispatcher.notification('thread/tokenUsage/updated', usage('other-thread', 'turn-x', 9, 9, 9))
    await h.dispatcher.notification('thread/tokenUsage/updated', usage('thread-1', 'turn-1', 146_900, 146_000, 293_971))

    expect(h.samples.map(s => [s.input, s.cached, s.output, s.reasoning])).toEqual([
      [145_871, 140_672, 600, 100], [146_900, 146_000, 600, 100],
    ])
    const ctx = h.persisted().context!
    expect(ctx).toMatchObject({ threadId: 'thread-1', inContext: 147_500, window: 258_000, lastInput: 146_900, lastCached: 146_000, calls: 2 })
  })

  test('a fresh session saves a receipt, starts a new thread, and hands off recent asks exactly once', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1', 'fix the "login" bug'))
    await h.dispatcher.notification('thread/tokenUsage/updated', usage('thread-1', 'turn-1', 140_000, 135_000, 140_600))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    expect(await h.dispatcher.submit(control('c1', 'new-session'))).toBe('started')
    const s = h.persisted()
    expect(s.threadId).toBe('thread-2')
    expect(s.sessions).toEqual([expect.objectContaining({ threadId: 'thread-1', calls: 1, inContext: 140_600, reason: 'requested from telegram' })])
    expect(s.context).toBeUndefined()
    // The control itself never became a model turn.
    expect(turnStarts(h)).toHaveLength(1)
    expect(h.published.at(-1)!.text).toContain('🆕 Fresh session. The previous one carried ~141k tokens over 1 model call.')
    expect(h.published.at(-1)!.meta.kind).toBe('control')

    await h.dispatcher.submit(tg('m2', 'next thing'))
    const first = turnStarts(h).at(-1)!
    expect(first.params.threadId).toBe('thread-2')
    expect(inputTexts(first)[0]).toBe(handoffLine('thread-1', ["fix the 'login' bug"]))
    expect(inputTexts(first)[1]).toBe('next thing')
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-2', status: 'completed' } })
    await h.dispatcher.submit(tg('m3', 'and another'))
    expect(inputTexts(turnStarts(h).at(-1)!)).toEqual(['and another'])
  })

  test('a control arriving mid-turn waits for the turn boundary instead of steering it', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    expect(await h.dispatcher.submit(control('c1', 'new-session'))).toBe('queued')
    expect(await h.dispatcher.submit(tg('m2', 'after the reset'))).toBe('queued')
    expect(h.requests.some(r => r.method === 'turn/steer')).toBe(false)

    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    // The reset ran, then the queued message started on the NEW thread.
    expect(h.persisted().threadId).toBe('thread-2')
    const last = turnStarts(h).at(-1)!
    expect(last.params.threadId).toBe('thread-2')
    expect(inputTexts(last).at(-1)).toBe('after the reset')
    expect(h.persisted().active?.message.id).toBe('m2')
  })

  test('compaction holds the queue as a turn of its own and reports when it finishes', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('thread/tokenUsage/updated', usage('thread-1', 'turn-1', 145_000, 140_000, 145_600))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    expect(await h.dispatcher.submit(control('c1', 'compact'))).toBe('started')
    expect(h.requests.at(-1)).toEqual({ method: 'thread/compact/start', params: { threadId: 'thread-1' } })
    // A message during compaction is queued, not steered into the summary.
    expect(await h.dispatcher.submit(tg('m2', 'while compacting'))).toBe('queued')
    await h.dispatcher.notification('turn/started', { threadId: 'thread-1', turn: { id: 'compact-turn' } })
    expect(await h.dispatcher.submit(tg('m3', 'still compacting'))).toBe('queued')
    expect(h.requests.some(r => r.method === 'turn/steer')).toBe(false)

    await h.dispatcher.notification('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } })
    expect(h.published.at(-1)!.text).toBe('🗜 Session compacted. It carried ~146k tokens; the next reply shows the new size in /context.')
    expect(h.persisted().compacting).toBeUndefined()
    expect(h.persisted().threadId).toBe('thread-1')
    expect(inputTexts(turnStarts(h).at(-1)!)).toEqual(['while compacting'])
  })

  test('a refused compaction says so and does not hold the queue', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.fail.compact = true
    await h.dispatcher.submit(control('c1', 'compact'))
    expect(h.published.at(-1)).toMatchObject({ text: 'Could not compact this session: compaction unavailable', meta: { kind: 'error' } })
    expect(await h.dispatcher.submit(tg('m1'))).toBe('started')
  })

  test('a failed compaction turn is reported as a compaction failure', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(control('c1', 'compact'))
    await h.dispatcher.notification('turn/started', { threadId: 'thread-1', turn: { id: 'compact-turn' } })
    await h.dispatcher.notification('turn/completed', { turn: { id: 'compact-turn', status: 'failed', error: { message: '401 Unauthorized' } } })
    expect(h.published.at(-1)!.text).toBe('Could not compact this session: 401 Unauthorized')
    expect(await h.dispatcher.submit(tg('m1'))).toBe('started')
  })

  test('a compaction whose turn never starts releases the queue in order after two minutes', async () => {
    setSystemTime(new Date('2026-10-04T10:00:00Z'))
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(control('c1', 'compact'))
    expect(await h.dispatcher.submit(tg('m1'))).toBe('queued')
    setSystemTime(new Date('2026-10-04T10:02:01Z'))
    // m1 waited longer, so it starts; m2 queues behind its turn.
    expect(await h.dispatcher.submit(tg('m2'))).toBe('queued')
    expect(turnStarts(h).map(r => r.params.clientUserMessageId)).toEqual(['m1'])
    expect(h.persisted().pending.map(m => m.id)).toEqual(['m2'])
    await h.dispatcher.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    expect(turnStarts(h).map(r => r.params.clientUserMessageId)).toEqual(['m1', 'm2'])
  })

  test('a /clear queued behind a lost compaction still runs before the next message', async () => {
    setSystemTime(new Date('2026-10-04T10:00:00Z'))
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(control('c1', 'compact'))
    expect(await h.dispatcher.submit(control('c2', 'new-session'))).toBe('queued')
    setSystemTime(new Date('2026-10-04T10:02:01Z'))
    expect(await h.dispatcher.submit(tg('x', 'do X'))).toBe('started')
    const [x] = turnStarts(h)
    expect(x!.params.clientUserMessageId).toBe('x')
    expect(x!.params.threadId).toBe('thread-2')
    expect(h.persisted().sessions!.map(r => r.threadId)).toEqual(['thread-1'])
    expect(h.persisted().pending).toEqual([])
  })

  test('the clock releases a lost compaction with no new inbound', async () => {
    setSystemTime(new Date('2026-10-04T10:00:00Z'))
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(control('c1', 'compact'))
    expect(await h.dispatcher.submit(tg('m1'))).toBe('queued')
    setSystemTime(new Date('2026-10-04T10:01:00Z'))
    await h.dispatcher.tick()
    expect(turnStarts(h)).toEqual([])
    setSystemTime(new Date('2026-10-04T10:10:00Z'))
    await h.dispatcher.tick()
    expect(turnStarts(h).map(r => r.params.clientUserMessageId)).toEqual(['m1'])
    expect(h.persisted().compacting).toBeUndefined()
    expect(h.persisted().pending).toEqual([])
  })

  test('a new session that cannot start keeps the current thread', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.fail.threadStart = true
    await h.dispatcher.submit(control('c1', 'new-session'))
    expect(h.persisted().threadId).toBe('thread-1')
    expect(h.persisted().sessions ?? []).toEqual([])
    expect(h.published.at(-1)!.text).toBe('Could not start a new session: app-server busy. Still on the current one.')
  })

  test('a 5dive task boundary (agent source) resets with a task reason', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(control('c1', 'new-session', 'agent'))
    expect(h.persisted().sessions![0]!.reason).toBe('a new task (5dive)')
    expect(h.published.at(-1)!.route.source).toBe('agent')
  })

  test('a restart drops a compaction that had not started', async () => {
    const h = harness({ seen: [], pending: [], threadId: 'thread-9', compacting: { message: control('c1', 'compact'), at: new Date().toISOString() } })
    await h.dispatcher.initialize()
    expect(h.persisted().compacting).toBeUndefined()
    expect(await h.dispatcher.submit(tg('m1'))).toBe('started')
  })

  test('token counts read at chat width', () => {
    expect([fmtTokens(850), fmtTokens(1234), fmtTokens(145_871), fmtTokens(1_200_000)]).toEqual(['850', '1.2k', '146k', '1.2M'])
  })
})
