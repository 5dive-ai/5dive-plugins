// DIVE-8414 (box reports 958/960): a Codex lead woken by a teammate's
// `agent send` wrote "here are your 3 headlines" and the owner got nothing.
// The turn's route is `source: "agent"`, the host's publish() returned early
// for it, and the thread's instructions told the model every answer is routed
// back to the originating channel. Now a teammate turn is told what it is, and
// a message carrying a `[[5dive-to-owner]]` line goes to the owner's chat with
// its files. Without the line nothing is forwarded (worker-lead chatter).
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChannelDispatcher, DEVELOPER_INSTRUCTIONS, OWNER_DIRECTIVE, ownerChatIds, parseOutboundMessage, teammateLine,
  type DispatchMessage, type DispatchRoute, type DispatcherState, type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'

const agent = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'agent', chat_id: '5dive-cli' } })
const tg = (id: string, chat = '42'): DispatchMessage => ({ id, text: id, route: { source: 'telegram', chat_id: chat } })

function harness(opts: { owner?: () => DispatchRoute | undefined; initial?: DispatcherState | null } = {}) {
  let saved: DispatcherState | null = opts.initial ? structuredClone(opts.initial) : null
  const requests: Array<{ method: string; params: Record<string, any> }> = []
  const published: Array<{ route: DispatchRoute; text: string; meta: any }> = []
  let n = 1
  const rpc: RpcPort = {
    async request(method, params: Record<string, any>) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'turn/start') return { turn: { id: `turn-${n++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  const d = new ChannelDispatcher(rpc,
    { load: () => saved ? structuredClone(saved) : null, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) }, ...(opts.owner ? { ownerRoute: opts.owner } : {}) },
    '/workspace')
  async function answer(turnId: string, text: string) {
    await d.notification('item/completed', { turnId, item: { type: 'agentMessage', id: `${turnId}-m`, text, phase: 'final_answer' } })
    await d.notification('turn/completed', { turn: { id: turnId, status: 'completed' } })
  }
  const inputs = (i: number) => (requests.filter(r => r.method === 'turn/start')[i]!.params.input as Array<{ text?: string }>).map(x => x.text ?? '')
  return { d, requests, published, answer, inputs, persisted: () => saved }
}

const RESULT = `Here are the 3 headlines.\n${OWNER_DIRECTIVE}\n[[5dive-attachment:/tmp/headlines.md]]`

describe('DIVE-8414: a teammate turn can reach the owner', () => {
  test('the directive is removed from the text on every route and marks the message', () => {
    expect(parseOutboundMessage(RESULT)).toEqual({ text: 'Here are the 3 headlines.', files: ['/tmp/headlines.md'], toOwner: true })
    expect(parseOutboundMessage('  [[5dive-to-owner]]  \nhi')).toMatchObject({ text: 'hi', toOwner: true })
    // Inline, it is just text: only a line of its own is the directive.
    expect(parseOutboundMessage('say [[5dive-to-owner]] inline')).toEqual({ text: 'say [[5dive-to-owner]] inline', files: [] })
  })

  test('a teammate turn is told it is one; a chat turn is not', async () => {
    const h = harness()
    await h.d.initialize()
    await h.d.submit(tg('m1'))
    await h.answer('turn-1', 'ok')
    await h.d.submit(agent('a1', 'result: 3 headlines'))
    expect(h.inputs(0).some(t => t.includes('[5dive teammate]'))).toBe(false)
    expect(h.inputs(1)).toEqual([teammateLine(), 'result: 3 headlines'])
    expect(teammateLine()).toContain(OWNER_DIRECTIVE)
  })

  test('the thread no longer promises that every answer is routed back', async () => {
    const h = harness()
    await h.d.initialize()
    const instructions = h.requests.find(r => r.method === 'thread/start')!.params.developerInstructions
    expect(instructions).toBe(DEVELOPER_INSTRUCTIONS)
    expect(instructions).not.toContain('routes those messages back to the originating channel')
    expect(instructions).toContain(OWNER_DIRECTIVE)
  })

  test('with the directive the message goes to the paired owner, notifying, files and all', async () => {
    const h = harness({ owner: () => ({ source: 'telegram', chat_id: '777' }) })
    await h.d.initialize()
    await h.d.submit(agent('a1'))
    await h.answer('turn-1', RESULT)
    const toOwner = h.published.filter(p => p.route.source === 'telegram')
    expect(toOwner).toHaveLength(1)
    expect(toOwner[0]!.route).toEqual({ source: 'telegram', chat_id: '777' })
    expect(toOwner[0]!.meta).toMatchObject({ kind: 'message', notify: true, toOwner: true })
    expect(parseOutboundMessage(toOwner[0]!.text).files).toEqual(['/tmp/headlines.md'])
    // The teammate's copy still goes to the agent route (the host prints it).
    expect(h.published.filter(p => p.route.source === 'agent')).toHaveLength(1)
  })

  test('without the directive nothing reaches the owner', async () => {
    const h = harness({ owner: () => ({ source: 'telegram', chat_id: '777' }) })
    await h.d.initialize()
    await h.d.submit(agent('a1'))
    await h.answer('turn-1', 'Got it, working on the next one.\n[[5dive-attachment:/tmp/notes.md]]')
    expect(h.published.map(p => p.route.source)).toEqual(['agent'])
  })

  test('a chat turn with the directive is unchanged: one message, to its own chat', async () => {
    const h = harness({ owner: () => ({ source: 'telegram', chat_id: '777' }) })
    await h.d.initialize()
    await h.d.submit(tg('m1', '42'))
    await h.answer('turn-1', RESULT)
    const messages = h.published.filter(p => p.meta.kind === 'message')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.route).toEqual({ source: 'telegram', chat_id: '42' })
  })

  test('no paired owner: the last private Telegram chat served, kept across a restart; never a group', async () => {
    const h = harness()
    await h.d.initialize()
    await h.d.submit(tg('m1', '42'))
    await h.answer('turn-1', 'hi')
    await h.d.submit(tg('m2', '-1001234'))
    await h.answer('turn-2', 'hi group')
    expect(h.persisted()?.lastChats).toEqual({ telegram: { source: 'telegram', chat_id: '42' } })
    // A fresh dispatcher on the saved state (a restart) still knows the chat.
    const again = harness({ initial: h.persisted() })
    await again.d.initialize()
    await again.d.submit(agent('a1'))
    await again.answer('turn-1', RESULT)
    expect(again.published.filter(p => p.meta.toOwner).map(p => p.route)).toEqual([{ source: 'telegram', chat_id: '42' }])
  })

  test('a paired owner wins over the last chat; the dashboard is the last fallback', async () => {
    const paired = harness({ owner: () => ({ source: 'telegram', chat_id: '777' }), initial: { seen: [], pending: [], lastChats: { telegram: { source: 'telegram', chat_id: '42' } } } })
    expect(paired.d.ownerRoute()).toEqual({ source: 'telegram', chat_id: '777' })
    const dash = harness({ initial: { seen: [], pending: [], lastChats: { dashboard: { source: 'dashboard', chat_id: 'dashboard' } } } })
    expect(dash.d.ownerRoute()).toEqual({ source: 'dashboard', chat_id: 'dashboard' })
    // An owner lookup that throws is not fatal: the fallback answers.
    const broken = harness({ owner: () => { throw new Error('EACCES') }, initial: { seen: [], pending: [], lastChats: { telegram: { source: 'telegram', chat_id: '42' } } } })
    expect(broken.d.ownerRoute()).toEqual({ source: 'telegram', chat_id: '42' })
  })

  test('no owner anywhere: the teammate copy is marked unreachable, nothing else is written', async () => {
    const h = harness()
    await h.d.initialize()
    await h.d.submit(agent('a1'))
    await h.answer('turn-1', RESULT)
    expect(h.published).toHaveLength(1)
    expect(h.published[0]!.meta).toMatchObject({ ownerUnreachable: true })
  })

  test('the owner reading matches the Claude plugin: owners within allowFrom, private chats only', () => {
    expect(ownerChatIds({ owners: ['777'], allowFrom: ['777', '888'] })).toEqual(['777'])
    expect(ownerChatIds({ allowFrom: ['888', '-100'] })).toEqual(['888'])
    expect(ownerChatIds({ owners: ['999'], allowFrom: ['888'] })).toEqual([])
    expect(ownerChatIds({})).toEqual([])
  })
})

// The real entrypoint against a fake app-server: `agent send` lands in the
// inbox exactly as the CLI writes it, and the owner's message must appear as an
// outbox/telegram file the Telegram adapter would send.
describe('DIVE-8414: dispatcher.ts writes the owner outbox file', () => {
  async function run(answerText: string, access: object | null) {
    const dir = mkdtempSync(join(tmpdir(), 'dive8414-'))
    const stateDir = join(dir, 'state')
    const tgDir = join(dir, 'telegram')
    mkdirSync(tgDir, { recursive: true })
    if (access) writeFileSync(join(tgDir, 'access.json'), JSON.stringify(access))
    const fakeCodex = join(dir, 'fake-codex.ts')
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0) }
import { createInterface } from 'node:readline'
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line)
  if (r.id == null) return
  if (r.method === 'thread/start') return out({ id: r.id, result: { thread: { id: 'thread-8414' } } })
  if (r.method === 'turn/start') {
    out({ id: r.id, result: { turn: { id: 'turn-1' } } })
    setTimeout(() => {
      out({ method: 'item/completed', params: { turnId: 'turn-1', item: { type: 'agentMessage', id: 'i1', phase: 'final_answer', text: ${JSON.stringify(answerText)} } } })
      out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    }, 50)
    return
  }
  out({ id: r.id, result: {} })
})
`)
    chmodSync(fakeCodex, 0o755)
    const env: Record<string, string | undefined> = {
      ...process.env,
      CODEX_BIN: fakeCodex,
      // Telegram declared, so the paired owner is looked up. With no token the
      // adapter exits at once (before reading the outbox) and is not respawned
      // inside the test's window.
      CODEX_DISPATCHER_CHANNELS: 'telegram',
      CODEX_DISPATCHER_ADAPTER_RESPAWN_MS: '600000',
      CODEX_DISPATCHER_STATE_DIR: stateDir,
      CODEX_DISPATCHER_WORKDIR: dir,
      TELEGRAM_STATE_DIR: tgDir,
    }
    delete env.TELEGRAM_BOT_TOKEN
    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'dispatcher.ts')], {
      cwd: dir, env, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    })
    try {
      const inbox = join(stateDir, 'inbox')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !existsSync(join(stateDir, 'health.json'))) await Bun.sleep(50)
      // The CLI's own shape (cmd_agent_runtime.sh _agent_dispatch_inbox_send).
      writeFileSync(join(inbox, '5dive-1.json'), JSON.stringify({
        id: '5dive-1', text: 'result: 3 headlines in /tmp/headlines.md', route: { source: 'agent', chat_id: '5dive-cli' }, received_at: new Date().toISOString(),
      }))
      let health: any = null
      while (Date.now() < deadline) {
        try { health = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8')) } catch {}
        if (health?.lastOutboundAt && !health?.active) break
        await Bun.sleep(50)
      }
      await Bun.sleep(200)
      const outDir = join(stateDir, 'outbox', 'telegram')
      return readdirSync(outDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(outDir, f), 'utf8')))
    } finally {
      child.kill('SIGTERM')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('an agent turn whose answer carries the directive writes the owner file with its files', async () => {
    const files = await run(RESULT, { owners: ['777'], allowFrom: ['777'] })
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ source: 'telegram', chat_id: '777', text: 'Here are the 3 headlines.', files: ['/tmp/headlines.md'], notify: true, toOwner: true })
  }, 20_000)

  test('the same answer without the directive writes no owner file', async () => {
    const files = await run('Here are the 3 headlines.\n[[5dive-attachment:/tmp/headlines.md]]', { owners: ['777'], allowFrom: ['777'] })
    expect(files).toEqual([])
  }, 20_000)
})
