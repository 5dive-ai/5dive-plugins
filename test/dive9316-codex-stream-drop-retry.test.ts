// DIVE-9316 (box report 1450): a Codex turn cut off by "responses stream
// disconnected" was final and silent. The dispatcher said "Codex could not
// complete this turn" (dropped for a teammate/heartbeat turn), cleared it and
// moved on; the row stayed in progress and the seat idled until the reaper
// took it 20+ minutes later. Now a transient failure re-runs the same message
// (bounded), and the failure is recorded for health.json.
import { describe, expect, test } from 'bun:test'
import {
  ChannelDispatcher,
  MAX_DROP_RETRIES,
  transientTurnError,
  type DispatchMessage,
  type DispatcherState,
  type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'

// The text a cut-off turn carries (codex app-server, turn.error.message).
const DROP = 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)'

const agent = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'agent' } })
const telegram = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })

function harness() {
  let saved: DispatcherState | null = { threadId: 'thread-1', seen: [], pending: [] }
  const requests: Array<{ method: string; params: any }> = []
  const published: Array<{ text: string; meta: any }> = []
  let n = 1
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: `turn-${n++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    { load: () => structuredClone(saved), save: s => { saved = structuredClone(s) } },
    { publish: async (_route, text, meta) => { published.push({ text, meta }) } },
    '/workspace',
  )
  const turns = () => requests.filter(r => r.method === 'turn/start')
  const fail = (turnId: string, error: Record<string, unknown> = { message: DROP }) =>
    dispatcher.notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'failed', error } })
  const say = (turnId: string, text: string, phase = 'final_answer') =>
    dispatcher.notification('item/completed', { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: `i-${turnId}`, text, phase } })
  const complete = (turnId: string) =>
    dispatcher.notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
  const errors = () => published.filter(p => p.meta.kind === 'error')
  return { dispatcher, requests, published, turns, fail, say, complete, errors, persisted: () => saved }
}

describe('DIVE-9316: a turn cut off by a dropped stream', () => {
  test('transient errors are told apart from refusals', () => {
    expect(transientTurnError({ message: DROP })).toBe(true)
    expect(transientTurnError({ message: 'unexpected status 503 Service Unavailable' })).toBe(true)
    expect(transientTurnError({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } })).toBe(true)
    expect(transientTurnError({ message: 'x', codexErrorInfo: 'internalServerError' })).toBe(true)
    // Typed info wins over a text that looks transient.
    expect(transientTurnError({ message: 'stream disconnected', codexErrorInfo: 'usageLimitExceeded' })).toBe(false)
    expect(transientTurnError({ message: "You've hit your usage limit. Upgrade to Pro" })).toBe(false)
    expect(transientTurnError({ message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." })).toBe(false)
    expect(transientTurnError({ message: 'context window exceeded' })).toBe(false)
    expect(transientTurnError(undefined)).toBe(false)
  })

  test('a heartbeat turn is re-run once with a continue preface, then a success clears the record', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(agent('hb-1', '/goal DIVE-1 do the work'))
    await h.fail('turn-1')

    expect(h.turns()).toHaveLength(2)
    const rerun = h.turns()[1]!.params
    expect(rerun.clientUserMessageId).toBe('hb-1')
    const input = JSON.stringify(rerun.input)
    expect(input).toContain('/goal DIVE-1 do the work')
    expect(input).toContain('cut off by a dropped connection')
    expect(input).toContain(`retry 1/${MAX_DROP_RETRIES}`)
    expect(h.errors()).toHaveLength(0)
    expect(h.persisted()?.lastTurnError).toMatchObject({ source: 'agent', messageId: 'hb-1', transient: true, retrying: true, attempt: 0 })
    expect(h.persisted()?.active?.message.dropRetry).toBe(1)

    await h.say('turn-2', 'done')
    await h.complete('turn-2')
    expect(h.turns()).toHaveLength(2)
    expect(h.persisted()?.lastTurnError).toBeUndefined()
    expect(h.persisted()?.active).toBeUndefined()
  })

  test('bounded: after MAX_DROP_RETRIES re-runs the error goes out and the record says it was dropped', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(agent('hb-1'))
    for (let i = 1; i <= MAX_DROP_RETRIES; i++) await h.fail(`turn-${i}`)
    expect(h.turns()).toHaveLength(MAX_DROP_RETRIES + 1)
    await h.fail(`turn-${MAX_DROP_RETRIES + 1}`)
    expect(h.turns()).toHaveLength(MAX_DROP_RETRIES + 1)
    expect(h.errors()).toHaveLength(1)
    expect(h.errors()[0]!.text).toBe(`Codex could not complete this turn: ${DROP}`)
    expect(h.persisted()?.lastTurnError).toMatchObject({ messageId: 'hb-1', transient: true, retrying: false, attempt: MAX_DROP_RETRIES })
    expect(h.persisted()?.active).toBeUndefined()
    expect(h.persisted()?.pending).toHaveLength(0)
  })

  test('a non-transient failure is not re-run, and is still recorded', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(agent('hb-1'))
    await h.fail('turn-1', { message: "You've hit your usage limit." })
    expect(h.turns()).toHaveLength(1)
    expect(h.errors()).toHaveLength(1)
    expect(h.persisted()?.lastTurnError).toMatchObject({ transient: false, retrying: false })
  })

  test('a turn that already sent its final answer is never re-run (no double answer)', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(agent('hb-1'))
    await h.say('turn-1', 'here is the result')
    await h.fail('turn-1')
    expect(h.turns()).toHaveLength(1)
    expect(h.persisted()?.lastTurnError).toMatchObject({ retrying: false })
  })

  test('a chat turn retries too: the ack says it, the chat gets no error, the next message waits behind the re-run', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1', 'first'))
    await h.dispatcher.submit({ ...telegram('web-2', 'second'), route: { source: 'web', chat_id: 'w' } })
    await h.fail('turn-1')
    expect(h.turns()).toHaveLength(2)
    expect(h.turns()[1]!.params.clientUserMessageId).toBe('tg-1')
    expect(h.errors()).toHaveLength(0)
    expect(h.persisted()?.pending.map(m => m.id)).toEqual(['web-2'])
  })
})
