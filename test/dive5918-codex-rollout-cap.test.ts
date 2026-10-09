// DIVE-5918: a 1.06 GB rollout OOM-killed the Codex dispatcher on every boot,
// because `thread/resume` loads it whole. Over the cap, boot rotates to a fresh
// thread instead (receipt + handoff + one message to the person), and a turn
// boundary rotates earlier so the boot path never meets one.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChannelDispatcher,
  ROLLOUT_RESUME_CAP_BYTES,
  ROLLOUT_ROTATE_BYTES,
  type DispatchMessage,
  type DispatcherState,
  type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'
import { rolloutSizer } from '../plugins/telegram-codex/rollout.ts'

const MB = 1024 * 1024
const OLD = '01a07f70-0000-7000-8000-000000000001'
const tg = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A sessions tree holding one rollout of `bytes` (sparse: no real disk). */
function sessions(threadId: string, bytes: number): string {
  const root = mkdtempSync(join(tmpdir(), 'dive5918-'))
  dirs.push(root)
  const day = join(root, '2026', '09', '08')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(root, '2026', '09', '08', 'rollout-2026-09-08T01-00-00-other.jsonl'), '{}\n')
  const file = join(day, `rollout-2026-09-08T01-02-03-${threadId}.jsonl`)
  writeFileSync(file, '')
  truncateSync(file, bytes)
  return root
}

function harness(initial: DispatcherState | null, sizeOf: (id: string) => number | null) {
  let saved = initial ? structuredClone(initial) : null
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  let nextThread = 1
  let nextTurn = 1
  const fail = { threadStart: false }
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') {
        if (fail.threadStart) throw new Error('app-server busy')
        return { thread: { id: `thread-${nextThread++}` } }
      }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'turn/start') return { turn: { id: `turn-${nextTurn++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    { load: () => saved ? structuredClone(saved) : null, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) } },
    '/workspace',
    undefined,
    sizeOf,
  )
  return { dispatcher, requests, published, fail, persisted: () => saved! }
}

const seated = (extra: Partial<DispatcherState> = {}): DispatcherState => ({
  seen: [], pending: [], threadId: OLD, recent: ['fix the login bug'],
  context: { threadId: OLD, calls: 40, inContext: 150_000 } as any, ...extra,
})
const methods = (h: { requests: Array<{ method: string }> }) => h.requests.map(r => r.method)
const inputTexts = (r: { params: Record<string, unknown> }) => (r.params.input as Array<{ text?: string }>).map(i => i.text ?? '')

describe('rollout size cap (DIVE-5918)', () => {
  test('the caps are the measured ones: boot 200 MB, turn boundary 100 MB', () => {
    expect(ROLLOUT_RESUME_CAP_BYTES).toBe(200 * MB)
    expect(ROLLOUT_ROTATE_BYTES).toBe(100 * MB)
  })

  test('a 300 MB rollout: boot starts a fresh thread, writes the receipt, never calls thread/resume', async () => {
    const h = harness(seated(), rolloutSizer(sessions(OLD, 300 * MB)))
    await h.dispatcher.initialize()
    expect(methods(h)).toEqual(['thread/start'])
    const s = h.persisted()
    expect(s.threadId).toBe('thread-1')
    expect(s.context).toBeUndefined()
    expect(s.sessions).toEqual([expect.objectContaining({
      threadId: OLD, reason: 'rollout too large to resume (300 MB)', calls: 40, inContext: 150_000,
    })])
    expect(s.handoff).toContain(`the previous thread (${OLD}) is saved`)
    expect(s.handoff).toContain('"fix the login bug"')
    expect(s.recovery).toBeUndefined()
  })

  test('negative control: a 10 MB rollout still resumes, nothing rotates', async () => {
    const h = harness(seated(), rolloutSizer(sessions(OLD, 10 * MB)))
    await h.dispatcher.initialize()
    expect(methods(h)).toEqual(['thread/resume'])
    expect(h.persisted().threadId).toBe(OLD)
    expect(h.persisted().sessions).toBeUndefined()
    expect(h.persisted().notice).toBeUndefined()
  })

  test('a rollout that cannot be found resumes as before', async () => {
    const h = harness(seated(), rolloutSizer(sessions('someone-else', 300 * MB)))
    await h.dispatcher.initialize()
    expect(methods(h)).toEqual(['thread/resume'])
  })

  test('the reason reaches the person on the route: exactly one message, then not again', async () => {
    const h = harness(seated(), rolloutSizer(sessions(OLD, 300 * MB)))
    await h.dispatcher.initialize()
    expect(h.published).toEqual([])
    await h.dispatcher.submit(tg('m1', 'what next?'))
    const notices = h.published.filter(p => /too large to reopen/.test(p.text))
    expect(notices).toHaveLength(1)
    expect(notices[0].route).toEqual({ source: 'telegram', chat_id: '42' })
    expect(notices[0].text).toContain('300 MB')
    expect(notices[0].text).toContain(OLD.slice(0, 8))
    // The handoff rode the first turn on the new thread.
    const first = h.requests.find(r => r.method === 'turn/start')!
    expect(first.params.threadId).toBe('thread-1')
    expect(inputTexts(first).some(t => t.includes('[5dive new session]'))).toBe(true)
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await h.dispatcher.submit(tg('m2'))
    expect(h.published.filter(p => /too large to reopen/.test(p.text))).toHaveLength(1)
    expect(h.persisted().notice).toBeUndefined()
  })

  test('an agent-sourced turn does not swallow the notice; the next chat turn gets it', async () => {
    const h = harness(seated(), rolloutSizer(sessions(OLD, 300 * MB)))
    await h.dispatcher.initialize()
    await h.dispatcher.submit({ id: 'a1', text: 'task', route: { source: 'agent', chat_id: '5dive-cli' } })
    expect(h.published.filter(p => /too large/.test(p.text))).toHaveLength(0)
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await h.dispatcher.submit(tg('m1'))
    expect(h.published.filter(p => /too large/.test(p.text))).toHaveLength(1)
  })

  test('a turn cut off by the OOM hears why on its own chat at boot', async () => {
    const active = { turnId: 't0', routeKey: 'telegram:42', route: { source: 'telegram' as const, chat_id: '42' }, message: tg('m0') }
    const h = harness(seated({ active }), rolloutSizer(sessions(OLD, 300 * MB)))
    await h.dispatcher.initialize()
    expect(methods(h)).toEqual(['thread/start'])
    expect(h.published.filter(p => /too large to reopen/.test(p.text))).toHaveLength(1)
    expect(h.persisted().notice).toBeUndefined()
  })

  test('turn boundary: past 100 MB the thread rotates before the next turn', async () => {
    let size = 50 * MB
    const h = harness(null, () => size)
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1', 'build the thing'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.persisted().threadId).toBe('thread-1')
    await h.dispatcher.submit(tg('m2'))
    size = 120 * MB
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-2', status: 'completed' } })
    const s = h.persisted()
    expect(s.threadId).toBe('thread-2')
    expect(s.sessions?.at(-1)).toEqual(expect.objectContaining({ threadId: 'thread-1', reason: 'rollout too large to resume (120 MB)' }))
    expect(h.published.filter(p => /too large to reopen/.test(p.text))).toHaveLength(1)
    expect(s.notice).toBeUndefined()
    size = 1 * MB
    await h.dispatcher.submit(tg('m3'))
    const third = h.requests.filter(r => r.method === 'turn/start')[2]
    expect(third.params.threadId).toBe('thread-2')
    expect(inputTexts(third).some(t => t.includes('[5dive new session]'))).toBe(true)
  })

  test('turn boundary: a failed thread/start keeps the old thread and says nothing', async () => {
    const h = harness(null, () => 120 * MB)
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    h.fail.threadStart = true
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    const s = h.persisted()
    expect(s.threadId).toBe('thread-1')
    expect(s.sessions ?? []).toEqual([])
    expect(s.handoff).toBeUndefined()
    expect(s.notice).toBeUndefined()
    expect(h.published.filter(p => /too large/.test(p.text))).toHaveLength(0)
  })
})
