// DIVE-8462: a Codex hire on a ChatGPT plan without Sol failed every turn with
// "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT
// account." (a partner's box, 2026-11-14). The dispatcher now catches that refusal,
// switches the seat to the first model the account's own list allows, says so
// once, and answers the same message on it.
import { describe, expect, test } from 'bun:test'
import {
  ChannelDispatcher,
  MAX_PLAN_RETRIES,
  planRefusedModel,
  type DispatchMessage,
  type DispatcherState,
  type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'

// The exact text the client's chat showed after "Codex could not complete this turn: ".
const REFUSAL = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
const refusalOf = (model: string) => REFUSAL.replace('gpt-6.1-sol', model)

const telegram = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })

type Opts = {
  configured?: { model?: string; effort?: string }
  models?: Array<{ model: string; hidden?: boolean; isDefault?: boolean }> | 'throws'
  writeStatus?: string | 'throws'
  state?: DispatcherState
}

function harness(opts: Opts = {}) {
  let saved: DispatcherState | null = opts.state ?? { threadId: 'thread-1', seen: [], pending: [] }
  const requests: Array<{ method: string; params: any }> = []
  const published: Array<{ text: string; meta: any }> = []
  const configToml: Record<string, unknown> = { ...(opts.configured?.model ? { model: opts.configured.model } : {}) }
  let n = 1
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/resume') return { thread: { id: params.threadId }, model: params.model }
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: `turn-${n++}` } }
      if (method === 'model/list') {
        if (opts.models === 'throws') throw new Error('model/list unsupported')
        return { data: (opts.models ?? []).map(m => ({ id: m.model, displayName: m.model, hidden: false, isDefault: false, ...m })), nextCursor: null }
      }
      if (method === 'config/value/write') {
        if (opts.writeStatus === 'throws') throw new Error('read-only config')
        configToml[params.keyPath] = params.value
        return { status: opts.writeStatus ?? 'ok' }
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    { load: () => structuredClone(saved), save: s => { saved = structuredClone(s) } },
    { publish: async (_route, text, meta) => { published.push({ text, meta }) } },
    '/workspace',
    opts.configured ? async () => opts.configured! : undefined,
  )
  const turns = () => requests.filter(r => r.method === 'turn/start')
  const fail = (turnId: string, message = REFUSAL) =>
    dispatcher.notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'failed', error: { message } } })
  const answer = async (turnId: string, text: string) => {
    await dispatcher.notification('item/completed', { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: `i-${turnId}`, text, phase: 'final_answer' } })
    await dispatcher.notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
  }
  return { dispatcher, requests, published, turns, fail, answer, configToml, persisted: () => saved }
}

const PLUS_PLAN = [
  { model: 'gpt-6.1-sol' }, // listed, but this plan refuses it
  { model: 'gpt-6-astra', hidden: true },
  { model: 'gpt-6.1-terra' },
  { model: 'gpt-6-luna' },
]

describe('DIVE-8462: a ChatGPT plan that refuses the seat model', () => {
  test('reads the refused model out of the exact error string, and nothing else', () => {
    expect(planRefusedModel(REFUSAL)).toBe('gpt-6.1-sol')
    expect(planRefusedModel(`{"detail":"${REFUSAL}"}`)).toBe('gpt-6.1-sol')
    expect(planRefusedModel("You've hit your usage limit. Upgrade to Pro")).toBeNull()
    expect(planRefusedModel('quota')).toBeNull()
  })

  test('the first message is answered: refusal → switch to an allowed model → same message answered on it', async () => {
    const h = harness({ configured: { model: 'gpt-6.1-sol' }, models: PLUS_PLAN })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1', 'hi there'))
    expect(h.turns()[0]!.params).toMatchObject({ model: 'gpt-6.1-sol' })

    await h.fail('turn-1')

    // The refused model and the hidden one are skipped; the switch is written
    // to config.toml so a restart keeps it.
    expect(h.requests.some(r => r.method === 'model/list')).toBe(true)
    expect(h.requests.find(r => r.method === 'config/value/write')!.params)
      .toEqual({ keyPath: 'model', value: 'gpt-6.1-terra', mergeStrategy: 'replace' })
    expect(h.configToml.model).toBe('gpt-6.1-terra')
    expect(h.dispatcher.configuredModel().model).toBe('gpt-6.1-terra')

    // The same message runs again, on the new model.
    expect(h.turns()).toHaveLength(2)
    expect(h.turns()[1]!.params).toMatchObject({ model: 'gpt-6.1-terra', clientUserMessageId: 'tg-1' })
    expect(JSON.stringify(h.turns()[1]!.params.input)).toContain('hi there')

    // Said once, plainly; the refusal never reaches the chat as an error.
    const texts = h.published.map(p => p.text)
    expect(texts.filter(t => t.includes('now uses gpt-6.1-terra'))).toHaveLength(1)
    expect(texts.some(t => t.startsWith('Codex could not complete this turn'))).toBe(false)
    expect(h.persisted()?.refusedModels).toEqual(['gpt-6.1-sol'])

    await h.answer('turn-2', 'Hi! How can I help?')
    expect(h.published.some(p => p.text === 'Hi! How can I help?' && p.meta.kind === 'message')).toBe(true)
    expect(h.persisted()?.threadModel).toMatchObject({ model: 'gpt-6.1-terra', from: 'turn/start' })

    // The next message goes straight to the new model: no second switch, no note.
    await h.dispatcher.submit(telegram('tg-2'))
    expect(h.turns()[2]!.params).toMatchObject({ model: 'gpt-6.1-terra' })
    expect(h.requests.filter(r => r.method === 'model/list')).toHaveLength(1)
  })

  test('pre-fix control: without a model list the client sees the exact refusal, unchanged', async () => {
    const h = harness({ configured: { model: 'gpt-6.1-sol' }, models: 'throws' })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.fail('turn-1')
    expect(h.published.at(-1)).toMatchObject({ text: `Codex could not complete this turn: ${REFUSAL}`, meta: { kind: 'error' } })
    expect(h.turns()).toHaveLength(1)
  })

  test('a fallback the plan also refuses moves on down the list; after the cap the error goes out', async () => {
    const h = harness({ configured: { model: 'gpt-6.1-sol' }, models: PLUS_PLAN })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.fail('turn-1')
    expect(h.turns()[1]!.params.model).toBe('gpt-6.1-terra')
    await h.fail('turn-2', refusalOf('gpt-6.1-terra'))
    expect(h.turns()[2]!.params.model).toBe('gpt-6-luna')
    expect(h.persisted()?.refusedModels).toEqual(['gpt-6.1-sol', 'gpt-6.1-terra'])
    await h.fail('turn-3', refusalOf('gpt-6-luna'))
    // Nothing left in the list: the refusal is reported as before, no loop.
    expect(h.turns()).toHaveLength(3)
    expect(h.published.at(-1)).toMatchObject({ text: `Codex could not complete this turn: ${refusalOf('gpt-6-luna')}`, meta: { kind: 'error' } })
    expect(MAX_PLAN_RETRIES).toBeGreaterThanOrEqual(2)
  })

  test('retries per message are capped even when the list never runs out', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ model: `m-${i}` }))
    const h = harness({ configured: { model: 'gpt-6.1-sol' }, models: many })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.fail('turn-1')
    for (let i = 0; i < MAX_PLAN_RETRIES; i++) await h.fail(`turn-${i + 2}`, refusalOf(`m-${i}`))
    expect(h.turns()).toHaveLength(MAX_PLAN_RETRIES + 1)
    expect(h.published.at(-1)!.meta.kind).toBe('error')
  })

  test('any other failure is reported exactly as before and never asks for models', async () => {
    const h = harness({ configured: { model: 'gpt-6.1-sol' }, models: PLUS_PLAN })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.fail('turn-1', "You've hit your usage limit. Upgrade to Pro")
    expect(h.requests.some(r => r.method === 'model/list' || r.method === 'config/value/write')).toBe(false)
    expect(h.published.at(-1)).toMatchObject({ text: "Codex could not complete this turn: You've hit your usage limit. Upgrade to Pro" })
  })

  test('a config that cannot be written still answers, and says the switch lasts until a restart', async () => {
    const h = harness({ configured: { model: 'gpt-6.1-sol' }, models: PLUS_PLAN, writeStatus: 'throws' })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.fail('turn-1')
    expect(h.turns()[1]!.params.model).toBe('gpt-6.1-terra')
    expect(h.published.some(p => p.text.includes('(until this agent restarts)'))).toBe(true)
  })

  test('an already-pinned seat restarting with a refused model in its saved state skips it', async () => {
    // the stuck seat's case after the update: config still says Sol, the state already
    // knows the plan refused it from an earlier switch whose write was lost.
    const h = harness({
      configured: { model: 'gpt-6.1-sol' }, models: PLUS_PLAN,
      state: { threadId: 'thread-1', seen: [], pending: [], refusedModels: ['gpt-6.1-terra'] },
    })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.fail('turn-1')
    expect(h.turns()[1]!.params.model).toBe('gpt-6-luna')
  })
})
