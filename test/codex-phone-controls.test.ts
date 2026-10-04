// DIVE-5502 (item 2): /effort, /usage and /account on the Codex dispatcher
// path. These controls never touch the thread, so they run the moment they
// arrive, even mid-turn: never queued behind the active turn, never steered
// into it. /usage keeps OpenAI's own percentages and this session's token
// counts apart, and never turns tokens into a quota percentage (audit item 5).
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_OPS,
  ChannelDispatcher,
  IMMEDIATE_CONTROLS,
  accountReport,
  usageReport,
  windowName,
  type DispatchMessage,
  type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'

const tg = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })
const ctl = (id: string, control: DispatchMessage['control'], effort?: string): DispatchMessage => ({
  id, text: `/${control}`, control, ...(effort !== undefined ? { effort } : {}), route: { source: 'telegram', chat_id: '42' },
})

const NOW = Date.parse('2026-10-04T10:00:00Z')
const SEC = (ms: number) => Math.floor((NOW + ms) / 1000)
const H = 3_600_000

const PLUS_READ = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: SEC(2 * H + 10 * 60_000) },
    secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: SEC(2 * 24 * H + 3 * H) },
    credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
}

function harness(configured: { model?: string; effort?: string } = { effort: 'medium' }) {
  let saved: any = null
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  let nextTurn = 1
  const answer: {
    write: unknown | Error
    rateLimits: unknown | Error
    account: unknown | Error
    threadModel?: { model: string; reasoningEffort: string }
  } = {
    write: { status: 'ok', version: 'v2', filePath: '/home/agent/.codex/config.toml', overriddenMetadata: null },
    rateLimits: PLUS_READ,
    account: { account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
  }
  const reply = (v: unknown) => { if (v instanceof Error) throw v; return v }
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, ...(answer.threadModel ?? {}) }
      if (method === 'turn/start') return { turn: { id: `turn-${nextTurn++}` } }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      if (method === 'thread/compact/start') return {}
      if (method === 'config/value/write') return reply(answer.write)
      if (method === 'account/rateLimits/read') return reply(answer.rateLimits)
      if (method === 'account/read') return reply(answer.account)
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    { load: () => saved ? structuredClone(saved) : null, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) } },
    '/workspace',
    async () => configured,
  )
  return { dispatcher, requests, published, answer, persisted: () => saved }
}

const turnStarts = (h: ReturnType<typeof harness>) => h.requests.filter(r => r.method === 'turn/start')
const writes = (h: ReturnType<typeof harness>) => h.requests.filter(r => r.method === 'config/value/write')
const sessionBlock = (text: string) => text.slice(text.indexOf('This session (token counts, not quota):'))

afterEach(() => setSystemTime())

describe('Codex phone controls: /effort, /usage, /account (DIVE-5502)', () => {
  test('the three verbs are advertised and run immediately', () => {
    for (const op of ['set-effort', 'usage', 'account'] as const) {
      expect(CONTROL_OPS).toContain(op)
      expect(IMMEDIATE_CONTROLS).toContain(op)
    }
    // The thread-touching verbs still wait for the turn boundary.
    expect(IMMEDIATE_CONTROLS).not.toContain('compact')
    expect(IMMEDIATE_CONTROLS).not.toContain('new-session')
  })

  test('set-effort mid-turn runs at once, never steers or queues, and the NEXT turn uses it', async () => {
    const h = harness()
    h.answer.threadModel = { model: 'gpt-5.5', reasoningEffort: 'medium' }
    await h.dispatcher.initialize()
    expect(await h.dispatcher.submit(tg('m1'))).toBe('started')
    expect(turnStarts(h)[0]!.params.effort).toBe('medium')

    expect(await h.dispatcher.submit(ctl('e1', 'set-effort', 'high'))).toBe('ran')
    expect(writes(h).map(r => r.params)).toEqual([{ keyPath: 'model_reasoning_effort', value: 'high', mergeStrategy: 'replace' }])
    expect(h.requests.some(r => r.method === 'turn/steer')).toBe(false)
    expect(h.persisted().pending).toEqual([])
    expect(h.persisted().active.message.id).toBe('m1')
    expect(h.published.at(-1)).toMatchObject({
      text: '🧠 Effort now high. It applies from the next turn; the running turn keeps medium.',
      meta: { kind: 'control' },
    })
    expect(h.dispatcher.configuredModel().effort).toBe('high')

    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await h.dispatcher.submit(tg('m2'))
    expect(turnStarts(h).at(-1)!.params.effort).toBe('high')
    // The conversation's effort follows the accepted turn override.
    expect(h.persisted().threadModel).toMatchObject({ model: 'gpt-5.5', effort: 'high', from: 'turn/start' })
  })

  test('set-effort is not held behind a compaction or a queued reset either', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    expect(await h.dispatcher.submit(ctl('c1', 'new-session'))).toBe('queued')
    expect(await h.dispatcher.submit(ctl('e1', 'set-effort', 'low'))).toBe('ran')
    expect(await h.dispatcher.submit(ctl('u1', 'usage'))).toBe('ran')
    expect(h.persisted().pending.map((m: DispatchMessage) => m.id)).toEqual(['c1'])
    expect(writes(h)).toHaveLength(1)
  })

  test('set-effort when idle says it applies from the next turn', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(ctl('e1', 'set-effort', 'low'))
    expect(h.published.at(-1)!.text).toBe('🧠 Effort now low, from the next turn.')
    await h.dispatcher.submit(tg('m1'))
    expect(turnStarts(h).at(-1)!.params.effort).toBe('low')
  })

  test('an invalid level is refused and nothing is written', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(ctl('e1', 'set-effort', 'extreme'))
    await h.dispatcher.submit(ctl('e2', 'set-effort'))
    expect(writes(h)).toHaveLength(0)
    expect(h.published.at(-2)).toMatchObject({
      text: 'Unknown effort "extreme". Pick one of: minimal, low, medium, high, xhigh.', meta: { kind: 'error' },
    })
    await h.dispatcher.submit(tg('m1'))
    expect(turnStarts(h).at(-1)!.params.effort).toBe('medium')
  })

  test('a failed or unconfirmed config write leaves the effort unchanged', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.answer.write = new Error('config.toml is read-only')
    await h.dispatcher.submit(ctl('e1', 'set-effort', 'xhigh'))
    expect(h.published.at(-1)).toMatchObject({
      text: 'Could not change effort: config.toml is read-only. Still medium.', meta: { kind: 'error' },
    })
    h.answer.write = {}
    await h.dispatcher.submit(ctl('e2', 'set-effort', 'xhigh'))
    expect(h.published.at(-1)!.text).toBe('Could not change effort: Codex did not confirm the config write. Still medium.')
    expect(h.dispatcher.configuredModel().effort).toBe('medium')
    await h.dispatcher.submit(tg('m1'))
    expect(turnStarts(h).at(-1)!.params.effort).toBe('medium')
  })

  test('a write another config layer overrides says a restart goes back', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.answer.write = { status: 'okOverridden', version: 'v3', filePath: '/x', overriddenMetadata: { message: 'profile', overridingLayer: {}, effectiveValue: 'low' } }
    await h.dispatcher.submit(ctl('e1', 'set-effort', 'high'))
    expect(h.published.at(-1)!.text).toBe('🧠 Effort now high, from the next turn. Another config layer sets low, so a restart goes back to it.')
  })

  test('usage labels the provider windows and keeps token counts apart', async () => {
    setSystemTime(new Date(NOW))
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 146_471 },
        last: { totalTokens: 146_471, inputTokens: 145_871, cachedInputTokens: 140_672, outputTokens: 600, reasoningOutputTokens: 100 },
        modelContextWindow: 258_000,
      },
    })
    // Mid-turn, like set-effort.
    expect(await h.dispatcher.submit(ctl('u1', 'usage'))).toBe('ran')
    const text = h.published.at(-1)!.text
    expect(text).toBe([
      '📊 Usage',
      '',
      'Provider-reported (OpenAI):',
      'plan: plus',
      '5h: 23% used · resets 12:10 UTC (in 2h 10m)',
      'weekly: 41% used · resets Tue 6 Oct 13:00 UTC (in 2d 3h)',
      'credits: 12.50',
      '',
      'This session (token counts, not quota):',
      'last call: 146k in, 141k cached, 600 out',
      'model calls: 1 · in context ~146k',
    ].join('\n'))
    // Every percentage is one OpenAI reported; none is derived from tokens.
    expect(text.match(/%/g)).toHaveLength(2)
    expect(sessionBlock(text)).not.toContain('%')
    expect(h.dispatcher.rateLimits()).toMatchObject({ from: 'read', buckets: [{ limitId: 'codex', planType: 'plus' }] })
  })

  test('a multi-bucket read names each bucket', () => {
    setSystemTime(new Date(NOW))
    const text = usageReport({
      buckets: [
        { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: 'pro' },
        { limitId: 'codex_other', limitName: null, primary: { usedPercent: 90, windowDurationMins: 1440, resetsAt: null }, secondary: null, rateLimitReachedType: 'rate_limit_reached' },
      ],
      now: NOW,
    })
    expect(text).toContain('plan: pro\nCodex:\n5h: 5% used\ncodex_other:\n1d: 90% used\n⚠️ limit reached (rate limit reached)')
    expect(sessionBlock(text)).toBe('This session (token counts, not quota):\nno model call on this session yet')
  })

  test('windows are named by length, not slot', () => {
    expect([windowName(300, 'primary'), windowName(10080, 'secondary'), windowName(1440, 'p'), windowName(120, 'p'), windowName(45, 'p'), windowName(null, 'primary')])
      .toEqual(['5h', 'weekly', '1d', '2h', '45m', 'primary'])
  })

  test('usage errors are said plainly, and the session block still shows', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.answer.rateLimits = new Error('codex account authentication required to read rate limits')
    await h.dispatcher.submit(ctl('u1', 'usage'))
    expect(h.published.at(-1)!.meta.kind).toBe('error')
    expect(h.published.at(-1)!.text).toContain('not available: Codex is not signed in with a ChatGPT plan, so OpenAI reports no plan limits.')
    expect(h.published.at(-1)!.text).toContain('This session (token counts, not quota):\nno model call on this session yet')
    expect(h.published.at(-1)!.text).not.toContain('%')

    h.answer.rateLimits = new Error('backend timed out')
    await h.dispatcher.submit(ctl('u2', 'usage'))
    expect(h.published.at(-1)!.text).toContain('could not read it (backend timed out).')
  })

  test('a failed read shows the last provider report, marked with its time', async () => {
    setSystemTime(new Date(NOW))
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.notification('account/rateLimits/updated', { rateLimits: PLUS_READ.rateLimits })
    // Sparse update: nulls never clear what was seen.
    await h.dispatcher.notification('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: null, credits: null },
    })
    const rec = h.dispatcher.rateLimits()!
    expect(rec.from).toBe('updated')
    expect(rec.buckets[0]).toMatchObject({ planType: 'plus', primary: { usedPercent: 30 }, secondary: { usedPercent: 41 } })

    h.answer.rateLimits = new Error('backend timed out')
    await h.dispatcher.submit(ctl('u1', 'usage'))
    expect(h.published.at(-1)!.text).toContain('could not read it (backend timed out).\nlast report, 10:00 UTC:\nplan: plus\n5h: 30% used')
  })

  test('account renders ChatGPT, API key, not signed in, and a read error', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    expect(await h.dispatcher.submit(ctl('a1', 'account'))).toBe('ran')
    expect(h.published.at(-1)).toMatchObject({ text: '👤 Codex sign-in: ChatGPT, owner@example.com (plan: plus).', meta: { kind: 'control' } })
    h.answer.account = { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
    await h.dispatcher.submit(ctl('a2', 'account'))
    expect(h.published.at(-1)!.text).toBe('🔑 Codex sign-in: an OpenAI API key (billed per token, no plan limits).')
    h.answer.account = { account: null, requiresOpenaiAuth: true }
    await h.dispatcher.submit(ctl('a3', 'account'))
    expect(h.published.at(-1)!.text).toBe('⚠️ Codex sign-in: not signed in.')
    h.answer.account = new Error('app-server busy')
    await h.dispatcher.submit(ctl('a4', 'account'))
    expect(h.published.at(-1)).toMatchObject({ text: 'Codex sign-in: could not read it (app-server busy).', meta: { kind: 'error' } })
    expect(accountReport({ account: { type: 'chatgpt', email: null, planType: 'team' } })).toBe('👤 Codex sign-in: ChatGPT (plan: team).')
    expect(h.requests.some(r => r.method === 'turn/start')).toBe(false)
  })

  test('a redelivered control runs once', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    expect(await h.dispatcher.submit(ctl('e1', 'set-effort', 'high'))).toBe('ran')
    expect(await h.dispatcher.submit(ctl('e1', 'set-effort', 'high'))).toBe('duplicate')
    expect(writes(h)).toHaveLength(1)
  })

  test('the real entrypoint refuses a bad effort at the inbox and advertises the verbs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5502-phone-'))
    const stateDir = join(dir, 'state')
    const log = join(dir, 'requests.jsonl')
    const fakeCodex = join(dir, 'fake-codex.ts')
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.3'); process.exit(0) }
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id == null) return
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n')
  let result = {}
  if (request.method === 'config/read') result = { config: { model_reasoning_effort: 'medium' } }
  if (request.method === 'thread/start') result = { thread: { id: 'thread-1' } }
  if (request.method === 'config/value/write') result = { status: 'ok', version: 'v1', filePath: '/x', overriddenMetadata: null }
  if (request.method === 'account/rateLimits/read') result = ${JSON.stringify(PLUS_READ)}
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
`)
    chmodSync(fakeCodex, 0o755)
    const inbox = join(stateDir, 'inbox')
    mkdirSync(inbox, { recursive: true })
    const route = { source: 'telegram', chat_id: '42' }
    const drop = (name: string, body: Record<string, unknown>) =>
      writeFileSync(join(inbox, name), JSON.stringify({ id: name, text: '/x', route, ...body }))
    drop('1-bad-level.json', { control: 'set-effort', effort: 'extreme' })
    drop('2-stray-effort.json', { control: 'usage', effort: 'high' })
    drop('3-good.json', { control: 'set-effort', effort: 'high' })
    drop('4-usage.json', { control: 'usage' })

    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'dispatcher.ts')], {
      cwd: dir,
      env: { ...process.env, CODEX_BIN: fakeCodex, CODEX_DISPATCHER_CHANNELS: '', CODEX_DISPATCHER_STATE_DIR: stateDir, CODEX_DISPATCHER_WORKDIR: dir },
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    })
    try {
      const outbox = join(stateDir, 'outbox', 'telegram')
      const deadline = Date.now() + 10_000
      let health: any = null
      while (Date.now() < deadline) {
        try { health = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8')) } catch {}
        if (health?.rateLimits && readdirSync(inbox).filter(f => f.endsWith('.json')).length === 0) break
        await Bun.sleep(50)
      }
      const reqs = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(reqs.filter((r: any) => r.method === 'config/value/write').map((r: any) => r.params.value)).toEqual(['high'])
      expect(reqs.filter((r: any) => r.method === 'account/rateLimits/read')).toHaveLength(1)
      // Both refused files are gone, not retried.
      expect(existsSync(join(inbox, '1-bad-level.json'))).toBe(false)
      expect(existsSync(join(inbox, '2-stray-effort.json'))).toBe(false)
      expect(health.controls).toEqual(['compact', 'new-session', 'set-effort', 'usage', 'account'])
      expect(health.rateLimits).toMatchObject({ from: 'read', buckets: [{ limitId: 'codex' }] })
      const texts = readdirSync(outbox).map(f => JSON.parse(readFileSync(join(outbox, f), 'utf8')).text as string)
      expect(texts).toContain('🧠 Effort now high, from the next turn.')
      expect(texts.some(t => t.startsWith('📊 Usage'))).toBe(true)
    } finally {
      child.kill('SIGTERM')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
