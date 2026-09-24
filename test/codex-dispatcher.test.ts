import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChannelDispatcher,
  parseOutboundMessage,
  type DispatchMessage,
  type DispatcherState,
  recoveryLine,
  type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'
import { writeDispatcherInbox } from '../plugins/dashboard/dispatcher-inbox.ts'

const telegram = (id: string, text = id): DispatchMessage => ({
  id,
  text,
  route: { source: 'telegram', chat_id: '42' },
})

function harness(initial: DispatcherState | null = null) {
  let saved = initial ? structuredClone(initial) : null
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  let nextTurn = 1
  let failTurnStart = false
  let failResume = false
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'thread/resume') {
        if (failResume) throw new Error('thread not found')
        return { thread: { id: params.threadId } }
      }
      if (method === 'turn/start') {
        if (failTurnStart) throw new Error('app-server unavailable')
        return { turn: { id: `turn-${nextTurn++}` } }
      }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    {
      load: () => saved ? structuredClone(saved) : null,
      save: state => { saved = structuredClone(state) },
    },
    {
      publish: async (route, text, meta) => { published.push({ route, text, meta }) },
    },
    '/workspace',
  )
  return {
    dispatcher,
    requests,
    published,
    setFailTurnStart(value: boolean) { failTurnStart = value },
    setFailResume(value: boolean) { failResume = value },
    persisted: () => saved,
  }
}

describe('Codex app-server channel dispatcher', () => {
  test('extracts absolute attachment directives without leaking them into chat text', () => {
    expect(parseOutboundMessage('Report attached.\n[[5dive-attachment:/tmp/report.pdf]]')).toEqual({
      text: 'Report attached.', files: ['/tmp/report.pdf'],
    })
    expect(parseOutboundMessage('keep [[5dive-attachment:relative.txt]] inline')).toEqual({
      text: 'keep [[5dive-attachment:relative.txt]] inline', files: [],
    })
  })

  test('idle inbound starts a turn without model-owned polling', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    expect(await h.dispatcher.submit(telegram('tg-1', 'hello'))).toBe('started')

    expect(h.requests.map(r => r.method)).toEqual(['thread/start', 'turn/start'])
    expect(h.requests[1]?.params).toMatchObject({
      threadId: 'thread-1',
      clientUserMessageId: 'tg-1',
      turnTrigger: '5dive:telegram',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    })
    expect(h.requests[0]?.params).not.toHaveProperty('approvalPolicy')
    expect(h.requests[0]?.params).not.toHaveProperty('sandbox')
  })

  test('same-route input steers an active turn and another route waits', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    expect(await h.dispatcher.submit(telegram('tg-2'))).toBe('steered')
    expect(await h.dispatcher.submit({
      id: 'dash-1', text: 'dashboard', route: { source: 'dashboard', chat_id: 'dashboard' },
    })).toBe('queued')

    expect(h.requests[2]?.method).toBe('turn/steer')
    expect(h.requests[2]?.params).toMatchObject({ expectedTurnId: 'turn-1', clientUserMessageId: 'tg-2' })
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.requests.at(-1)).toMatchObject({ method: 'turn/start', params: { clientUserMessageId: 'dash-1' } })
  })

  test('streamed agent messages return only to the active source route', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.dispatcher.notification('item/agentMessage/delta', {
      turnId: 'turn-1', itemId: 'item-1', delta: 'hello ',
    })
    await h.dispatcher.notification('item/agentMessage/delta', {
      turnId: 'turn-1', itemId: 'item-1', delta: 'there',
    })
    await h.dispatcher.notification('item/completed', {
      turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage' },
    })

    expect(h.published).toEqual([{
      route: { source: 'telegram', chat_id: '42' },
      text: 'hello there',
      meta: { turnId: 'turn-1', itemId: 'item-1', kind: 'message' },
    }])
  })

  const interruptedState = (): DispatcherState => ({
    threadId: 'thread-old',
    seen: ['tg-active'],
    active: {
      turnId: 'turn-old', routeKey: 'telegram:42:', route: telegram('tg-active').route,
      message: telegram('tg-active', 'summarise the incident'),
    },
    pending: [{ id: 'dash-1', text: 'next', route: { source: 'dashboard', chat_id: 'dashboard' } }],
  })

  test('restart resumes the thread, reports the interrupted turn, and drains queued work', async () => {
    const h = harness(interruptedState())
    await h.dispatcher.initialize()

    expect(h.requests.map(r => r.method)).toEqual(['thread/resume', 'turn/start'])
    expect(h.published[0]?.text).toMatch(/before the previous turn completed/i)
    expect(h.dispatcher.snapshot().active?.message.id).toBe('dash-1')
  })

  test('a clean stop and a crash are different sentences in the chat', async () => {
    const crashed = harness(interruptedState())
    await crashed.dispatcher.initialize()
    expect(crashed.published[0]?.text).toMatch(/stopped unexpectedly \(crash, kill, or host reboot\)/i)

    const clean = harness({ ...interruptedState(), cleanExit: true })
    await clean.dispatcher.initialize()
    expect(clean.published[0]?.text).toMatch(/^The local Codex dispatcher restarted before/)
    expect(clean.published[0]?.text).not.toMatch(/unexpectedly/i)
    // The flag must not survive its own boot, or every later crash reads clean.
    expect(clean.dispatcher.snapshot().cleanExit).toBeUndefined()
  })

  test('markCleanShutdown persists the intent before the process exits', () => {
    const h = harness({ threadId: 'thread-old', seen: [], pending: [] })
    h.dispatcher.markCleanShutdown()
    expect(h.persisted()?.cleanExit).toBe(true)
  })

  test('recovery context rides the next turn instead of replaying the lost one', async () => {
    const h = harness(interruptedState())
    await h.dispatcher.initialize()

    const started = h.requests.filter(r => r.method === 'turn/start')
    // Exactly one turn — the queued dashboard message. The interrupted message
    // is NOT resubmitted, which is what "without duplicating turns" means.
    expect(started).toHaveLength(1)
    expect(started[0]?.params.clientUserMessageId).toBe('dash-1')
    const input = started[0]?.params.input as Array<{ type: string; text?: string }>
    expect(input).toHaveLength(2)
    expect(input[0]?.text).toMatch(/^\[5dive recovery\] /)
    expect(input[0]?.text).toContain('summarise the incident')
    expect(input[1]?.text).toBe('next')
    // Consumed once: the turn after it carries the user's text alone.
    expect(h.dispatcher.snapshot().recovery).toBeUndefined()
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await h.dispatcher.submit(telegram('tg-later', 'and now?'))
    expect((h.requests.at(-1)?.params.input as unknown[])).toHaveLength(1)
  })

  test('a stale thread starts a fresh one and says so in the recovery context', async () => {
    const h = harness({ threadId: 'thread-gone', seen: [], pending: [] })
    h.setFailResume(true)
    await h.dispatcher.initialize()

    expect(h.requests.map(r => r.method)).toEqual(['thread/resume', 'thread/start'])
    expect(h.dispatcher.snapshot().threadId).toBe('thread-1')
    const recovery = h.dispatcher.snapshot().recovery!
    expect(recovery.kind).toBe('thread-lost')
    expect(recovery.detail).toContain('thread not found')
    // Nothing to tell a channel about: no turn was in flight to interrupt.
    expect(h.published).toEqual([])

    await h.dispatcher.submit(telegram('tg-1', 'still there?'))
    const input = h.requests.at(-1)?.params.input as Array<{ text?: string }>
    expect(input[0]?.text).toContain('none of the earlier conversation is in context')
  })

  test('the interrupted-turn notice is sent once, not on every later restart', async () => {
    // No pending work: after the first boot nothing is in flight, so a second
    // boot has no interrupted turn of its OWN to report.
    let saved: DispatcherState | null = { ...interruptedState(), pending: [] }
    const published: string[] = []
    const build = () => {
      const rpc: RpcPort = {
        async request(method, params) {
          if (method === 'thread/resume') return { thread: { id: (params as any).threadId } }
          if (method === 'turn/start') return { turn: { id: 'turn-x' } }
          throw new Error(`unexpected ${method}`)
        },
      }
      return new ChannelDispatcher(
        rpc,
        { load: () => saved ? structuredClone(saved) : null, save: s => { saved = structuredClone(s) } },
        { publish: async (_r, text) => { published.push(text) } },
        '/workspace',
      )
    }
    await build().initialize()
    expect(published).toHaveLength(1)
    // Second boot, no new work: the row was cleared and persisted by the first.
    await build().initialize()
    expect(published).toHaveLength(1)
  })

  test('the recovery line is one line and never replays the lost message verbatim', () => {
    const line = recoveryLine({ kind: 'interrupted', at: '2026-09-13T00:00:00.000Z', detail: 'the turn you were running was cut off' })
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toMatch(/do not replay the interrupted work/i)
  })

  test('duplicate delivery ids never start or steer twice', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    expect(await h.dispatcher.submit(telegram('tg-1'))).toBe('duplicate')
    expect(h.requests.filter(r => r.method.startsWith('turn/'))).toHaveLength(1)
  })

  test('dispatcher failure leaves input retryable', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.setFailTurnStart(true)
    await expect(h.dispatcher.submit(telegram('tg-retry'))).rejects.toThrow('app-server unavailable')
    expect(h.dispatcher.snapshot().seen).not.toContain('tg-retry')
    expect(h.dispatcher.snapshot().active).toBeUndefined()

    h.setFailTurnStart(false)
    expect(await h.dispatcher.submit(telegram('tg-retry'))).toBe('started')
  })

  test('dashboard adapter reports a synchronous spool failure as a rejection', async () => {
    let renamed = false
    const delivery = writeDispatcherInbox('/tmp/inbox.tmp', '/tmp/inbox.json', { text: 'hello' }, {
      write() { throw new Error('disk full') },
      rename() { renamed = true },
    })

    await expect(delivery).rejects.toThrow('disk full')
    expect(renamed).toBe(false)
  })

  test('dispatcher-mode boot writes a lifecycle start record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3960-lifecycle-'))
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex.ts')
    // DIVE-3969: the dispatcher asks `codex --version` before it starts
    // anything, so the fake answers it the way a supported Codex does.
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0) }
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id == null) return
  const result = request.method === 'thread/start'
    ? { thread: { id: 'thread-lifecycle-test' } }
    : {}
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
`)
    chmodSync(fakeCodex, 0o755)

    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'dispatcher.ts')], {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_BIN: fakeCodex,
        CODEX_DISPATCHER_CHANNELS: '',
        CODEX_DISPATCHER_STATE_DIR: stateDir,
        CODEX_DISPATCHER_WORKDIR: dir,
      },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      const record = join(stateDir, 'lifecycle.log')
      const deadline = Date.now() + 10_000
      let body = ''
      while (Date.now() < deadline) {
        try { body = readFileSync(record, 'utf8') } catch {}
        if (body.includes('\tstart\tcodex-dispatcher\t')) break
        await Bun.sleep(50)
      }
      expect(body).toContain('\tstart\tcodex-dispatcher\t')
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGTERM')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  // ── DIVE-4924: the seat's model applies to the EXISTING conversation ─────
  //
  // The fake app-server below is sticky the way the real one is: a resumed
  // thread keeps the model its rollout was saved with unless the resume or the
  // turn names another. `turnContext` is the analogue of the rollout's
  // `turn_context` — the model a turn ACTUALLY ran on — and it is the only thing
  // these tests believe. `configured` is the analogue of `agent info`, which
  // reads config.toml and was already saying Astra while the thread ran Sol.
  function stickyHarness(opts: { saved?: string; configured?: { model?: string; effort?: string } | 'throws' }) {
    const threadModel = new Map<string, { model: string; effort: string }>([
      ['thread-old', { model: opts.saved ?? 'gpt-6-sol', effort: 'high' }],
    ])
    const turnContext: Array<{ model: string; effort: string }> = []
    const requests: Array<{ method: string; params: Record<string, any> }> = []
    let n = 1
    const rpc: RpcPort = {
      async request(method, params: Record<string, any>) {
        requests.push({ method, params })
        if (method === 'thread/resume') {
          const t = threadModel.get(params.threadId)!
          if (params.model) t.model = params.model
          if (params.config?.model_reasoning_effort) t.effort = params.config.model_reasoning_effort
          return { thread: { id: params.threadId }, model: t.model, reasoningEffort: t.effort }
        }
        if (method === 'turn/start') {
          const t = threadModel.get(params.threadId)!
          if (params.model) t.model = params.model
          if (params.effort) t.effort = params.effort
          turnContext.push({ ...t })
          return { turn: { id: `turn-${n++}` } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    let saved: DispatcherState | null = { threadId: 'thread-old', seen: [], pending: [] }
    const configured = opts.configured
    const dispatcher = new ChannelDispatcher(
      rpc,
      { load: () => structuredClone(saved), save: s => { saved = structuredClone(s) } },
      { publish: async () => {} },
      '/workspace',
      configured === undefined ? undefined
        : async () => { if (configured === 'throws') throw new Error('config/read unsupported'); return configured },
    )
    return { dispatcher, requests, turnContext, persisted: () => saved }
  }

  test('a config switch to Astra makes the next reply in the SAME thread run on Astra', async () => {
    const h = stickyHarness({ configured: { model: 'gpt-6-astra', effort: 'high' } })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-astra', 'same question again'))

    // History kept: the saved thread was resumed, never replaced.
    expect(h.requests.map(r => r.method)).toEqual(['thread/resume', 'turn/start'])
    expect(h.persisted()?.threadId).toBe('thread-old')
    // The turn itself — not the config — ran on Astra.
    expect(h.turnContext).toEqual([{ model: 'gpt-6-astra', effort: 'high' }])
    expect(h.requests[0]!.params).toMatchObject({ threadId: 'thread-old', model: 'gpt-6-astra' })
    expect(h.requests[1]!.params).toMatchObject({ model: 'gpt-6-astra', effort: 'high' })
  })

  test('the pre-fix shape (no configured model) reproduces the sticky Sol reply', async () => {
    // Control: the same fake with the reading switched off is exactly the
    // reported failure — config says Astra somewhere, the turn runs Sol.
    const h = stickyHarness({})
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-sol'))
    expect(h.turnContext).toEqual([{ model: 'gpt-6-sol', effort: 'high' }])
    expect(h.requests[0]!.params).toEqual({ threadId: 'thread-old' })
  })

  test('the thread model is reported from the app-server, not from config', async () => {
    const h = stickyHarness({ configured: { model: 'gpt-6-astra' } })
    await h.dispatcher.initialize()
    expect(h.dispatcher.configuredModel()).toEqual({ model: 'gpt-6-astra' })
    expect(h.persisted()?.threadModel).toMatchObject({ model: 'gpt-6-astra', effort: 'high', from: 'thread/resume' })

    // A refused override is not reported as a switch: the app-server's own
    // later word wins over what the dispatcher asked for.
    await h.dispatcher.notification('thread/settings/updated', {
      threadId: 'thread-old', threadSettings: { model: 'gpt-6-sol', effort: 'medium' },
    })
    expect(h.persisted()?.threadModel).toMatchObject({ model: 'gpt-6-sol', effort: 'medium', from: 'thread/settings/updated' })
    await h.dispatcher.notification('model/rerouted', { threadId: 'thread-old', turnId: 't', fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra' })
    expect(h.persisted()?.threadModel).toMatchObject({ model: 'gpt-6-astra', effort: 'medium', from: 'model/rerouted' })
    // Another thread's settings never overwrite this one's.
    await h.dispatcher.notification('thread/settings/updated', { threadId: 'other', threadSettings: { model: 'x' } })
    expect(h.persisted()?.threadModel?.model).toBe('gpt-6-astra')
    // An accepted turn override is recorded: the turn ran on it.
    await h.dispatcher.submit(telegram('tg-turn'))
    expect(h.turnContext.at(-1)?.model).toBe('gpt-6-astra')
    expect(h.persisted()?.threadModel).toMatchObject({ model: 'gpt-6-astra', from: 'turn/start' })
  })

  test('an unreadable config leaves the thread model alone instead of guessing', async () => {
    const h = stickyHarness({ configured: 'throws' })
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-x'))
    expect(h.requests[0]!.params).toEqual({ threadId: 'thread-old' })
    expect(h.requests[1]!.params.model).toBeUndefined()
    expect(h.turnContext).toEqual([{ model: 'gpt-6-sol', effort: 'high' }])
  })

  test('/model and a hand edit take the same road: dispatcher boot reads config/read and resumes with it', async () => {
    // `/model` is `agent config set model=…` + `_self_restart`; a hand edit of
    // config.toml + `_self_restart` is the same two facts. Both land here: a
    // fresh dispatcher process against a saved thread. So this drives the real
    // entrypoint against a fake app-server whose config names Astra.
    const dir = mkdtempSync(join(tmpdir(), 'dive4924-boot-'))
    const stateDir = join(dir, 'state')
    const log = join(dir, 'requests.jsonl')
    const fakeCodex = join(dir, 'fake-codex.ts')
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
// DIVE-3969's startup handshake refuses a Codex that cannot name its version.
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.3'); process.exit(0) }
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id == null) return
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n')
  let result = {}
  if (request.method === 'config/read') result = { config: { model: 'gpt-6-astra', model_reasoning_effort: 'high' }, origins: {}, layers: null }
  if (request.method === 'thread/resume') result = { thread: { id: request.params.threadId }, model: request.params.model ?? 'gpt-6-sol', reasoningEffort: 'high' }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
`)
    chmodSync(fakeCodex, 0o755)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ threadId: 'thread-old', seen: [], pending: [] }))

    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'dispatcher.ts')], {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_BIN: fakeCodex,
        CODEX_DISPATCHER_CHANNELS: '',
        CODEX_DISPATCHER_STATE_DIR: stateDir,
        CODEX_DISPATCHER_WORKDIR: dir,
      },
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    })
    try {
      const deadline = Date.now() + 10_000
      let health: any = null
      while (Date.now() < deadline) {
        try { health = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8')) } catch {}
        if (health?.threadModel) break
        await Bun.sleep(50)
      }
      const reqs = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      const methods = reqs.map((r: any) => r.method)
      expect(methods.indexOf('config/read')).toBeGreaterThan(methods.indexOf('initialize'))
      expect(methods.indexOf('config/read')).toBeLessThan(methods.indexOf('thread/resume'))
      expect(reqs.find((r: any) => r.method === 'thread/resume').params).toEqual({
        threadId: 'thread-old', model: 'gpt-6-astra', config: { model_reasoning_effort: 'high' },
      })
      expect(health).toMatchObject({ threadId: 'thread-old', threadModel: 'gpt-6-astra', threadEffort: 'high', configuredModel: 'gpt-6-astra' })
    } finally {
      child.kill('SIGTERM')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test('package entrypoint makes dispatcher primary and retains MCP fallback', async () => {
    const pkg = await Bun.file(new URL('../plugins/telegram-codex/package.json', import.meta.url)).json()
    const entry = await Bun.file(new URL('../plugins/telegram-codex/dispatcher.ts', import.meta.url)).text()
    expect(pkg.scripts.start).toBe('bun dispatcher.ts')
    expect(pkg.scripts['start:mcp-fallback']).toBe('bun server.ts')
    expect(pkg.files).toContain('dispatcher-core.ts')
    expect(pkg.files).toContain('lifecycle.ts')
    expect(entry).toContain("'-c', 'mcp_servers={}'")
    expect(entry).not.toContain('mcp_servers.telegram.enabled')
  })
})
