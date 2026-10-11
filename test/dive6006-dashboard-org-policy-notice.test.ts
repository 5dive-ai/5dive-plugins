// DIVE-6006: the dashboard plugin gets the Telegram plugin's DIVE-5993 notice.
// On a Claude Team/Enterprise login whose org keeps channels off, Claude Code
// drops every web-chat message and the chat never answers. The plugin does not
// type around the org's choice (DIVE-6000 leaves org_policy alone); it posts ONE
// message into the web chat saying why and where an admin switches it on.
//
// Two layers: (1) the notifier and its words, next to Telegram's; (2) the REAL
// server process under a fake `claude` parent: org policy → exactly one notice
// posted to the chat the owner wrote in, none on the second inbound; bound /
// refused / any other skip / no decision → no notice.
//
// No live arm: no test org has a Team/Enterprise plan with channels off, so the
// gate line is the verbatim Claude Code 2.1.296 string, appended to the plugin's
// own MCP log the way Claude Code writes it.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, symlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as dash from '../plugins/dashboard/channelroute'
import {
  makeOrgPolicyNotifier,
  orgPolicyText,
  ORG_POLICY_NOTIFIED_FILE,
  ORG_SETTINGS_URL,
  ORG_POLICY_FAQ_URL,
} from '../plugins/dashboard/orgpolicy'
import * as tg from '../plugins/telegram/orgpolicy'

const MARKER = 'dashboard channel: route-marker 4242.1760150000000'
const dbg = (debug: string) => JSON.stringify({ debug, timestamp: '2026-10-11T05:00:00.000Z', sessionId: 's', cwd: '/x' })
const REGISTERED = dbg('Channel notifications registered')
const REFUSED = dbg('Channel notifications skipped: channels feature is not currently available')
const ORG_POLICY = dbg('Channel notifications skipped: channels not enabled by org policy (set channelsEnabled: true in managed settings)')
const ALLOWLIST = dbg("Channel notifications skipped: plugin dashboard@5dive-plugins is not on your org's approved channels list (set allowedChannelPlugins in managed settings)")
const NOT_IN_LIST = dbg('Channel notifications skipped: server plugin:dashboard:dashboard not in --channels list for this session')

describe('the notice is posted once', () => {
  let dir: string
  let sent: string[]
  let logs: string[]
  let fail: boolean
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dive6006-n-'))
    sent = []
    logs = []
    fail = false
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const notifier = () =>
    makeOrgPolicyNotifier({
      dir,
      send: async chat => {
        if (fail) throw new Error('dashboard reply failed: control plane returned 503')
        sent.push(chat)
      },
      log: l => logs.push(l),
    })

  test('first org_policy inbound posts to that chat; later inbounds and a restarted plugin do not', async () => {
    const n = notifier()
    expect(await n('org_policy', 'dashboard')).toBe('sent')
    expect(sent).toEqual(['dashboard'])
    expect(await n('org_policy', 'dashboard')).toBe('none')
    expect(await notifier()('org_policy', 'dashboard')).toBe('none')
    expect(sent).toEqual(['dashboard'])
  })
  test('refused, other, unknown and bound never post it', async () => {
    const n = notifier()
    for (const d of ['refused', 'other', 'unknown', 'bound'] as const) expect(await n(d, 'dashboard')).toBe('none')
    expect(sent).toEqual([])
  })
  test('bound clears it, so an org that switches channels off again is told again', async () => {
    const n = notifier()
    await n('org_policy', 'dashboard')
    expect(existsSync(join(dir, ORG_POLICY_NOTIFIED_FILE))).toBe(true)
    expect(await n('bound', 'dashboard')).toBe('cleared')
    expect(existsSync(join(dir, ORG_POLICY_NOTIFIED_FILE))).toBe(false)
    expect(await n('org_policy', 'dashboard')).toBe('sent')
    expect(sent).toEqual(['dashboard', 'dashboard'])
  })
  test('a post the control plane refuses is not marked, so the next inbound tries again', async () => {
    fail = true
    const n = notifier()
    expect(await n('org_policy', 'dashboard')).toBe('none')
    expect(existsSync(join(dir, ORG_POLICY_NOTIFIED_FILE))).toBe(false)
    expect(logs.join('\n')).toContain('not sent: dashboard reply failed')
    fail = false
    expect(await n('org_policy', 'dashboard')).toBe('sent')
  })
})

describe('the words', () => {
  test('plain English for the owner: why, where an admin turns it on, the FAQ link', () => {
    const t = orgPolicyText()
    expect(t).toContain("I can't hear your messages here yet")
    expect(t).toContain("Your company's Claude plan has agent chat turned off")
    expect(t).toContain('claude.ai → Organization settings → Claude Code → Managed settings')
    expect(t).toContain(`Step by step: ${ORG_POLICY_FAQ_URL}`)
    // The admin's JSON lives in the FAQ, not in the owner's chat.
    expect(t).not.toContain('channelsEnabled":')
    expect(t).not.toContain('<')
  })
  test('the same targets as the Telegram notice', () => {
    expect(ORG_SETTINGS_URL).toBe(tg.ORG_SETTINGS_URL)
    expect(ORG_POLICY_FAQ_URL).toBe(tg.ORG_POLICY_FAQ_URL)
    expect(ORG_POLICY_NOTIFIED_FILE).toBe(tg.ORG_POLICY_NOTIFIED_FILE)
    expect(JSON.parse(tg.ORG_POLICY_JSON).allowedChannelPlugins).toContainEqual({ plugin: 'dashboard', marketplace: '5dive-plugins' })
  })
})

// ---- the real server process ------------------------------------------------

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const hasTmux = spawnSync('tmux', ['-V']).status === 0

type Event = { agent: string; body: string; metadata: { chat_id?: string } }
type Run = { events: Event[]; notifications: number; typed: string; acked: number[]; lifecycle: string }

// Boots plugins/dashboard/server.ts the way a seat does (see the DIVE-6000 test):
// parent argv[0] `claude` asking for `--channels plugin:dashboard@…`, stderr into
// Claude Code's per-server MCP log, a real tmux pane. `decision` is what Claude
// Code "logs" after our marker ('' = no decision yet). Two inbounds: the pending
// row 77, then a drop-file in agent-inbox once 77 is acked. Every POST to the
// control plane's /server/messages/event is what the web chat would show.
async function runServer(decision: string): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), 'dash6006-'))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  const state = join(root, 'state')
  mkdirSync(cwd, { recursive: true })
  const logDir = join(home, '.cache', 'claude-cli-nodejs', dash.cacheDirName(cwd), 'mcp-logs-plugin-dashboard-dashboard')
  mkdirSync(logDir, { recursive: true })
  const mcpLog = join(logDir, '2026-10-11T05-00-00-000Z.jsonl')
  writeFileSync(mcpLog, '')
  const fakeClaude = join(root, 'claude')
  symlinkSync('/bin/sh', fakeClaude)
  const sock = join(root, 'tmux.sock')
  const typedFile = join(root, 'typed')
  expect(spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'seat', `stty -echo; cat > ${typedFile}`]).status).toBe(0)

  const acked: number[] = []
  const events: Event[] = []
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') {
        return Response.json({ pending: acked.includes(77) ? [] : [{ id: 77, text: 'hello?', chat_id: 'chat-owner-1', from: 'owner', ts: '2026-10-11T05:30:00.000Z' }] })
      }
      if (url.pathname === '/server/messages/pending/ack') {
        const { ids } = (await req.json()) as { ids: number[] }
        acked.push(...ids)
        return Response.json({ ok: true, acked: ids.length })
      }
      if (url.pathname === '/server/messages/event' && req.method === 'POST') {
        events.push((await req.json()) as Event)
        return Response.json({ id: events.length })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const proc = Bun.spawn([fakeClaude, '-c', 'bun "$0" 2>>"$1"; :', SERVER, mcpLog, '--channels', 'plugin:dashboard@5dive-plugins'], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USER: 'agent-dev',
      TMUX: `${sock},1,0`,
      TMUX_PANE: 'seat:0',
      DASHBOARD_STATE_DIR: state,
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
      CONNECTORD_ENV_FILE: join(root, 'no-such-env'),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  let notifications = 0
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dive6006', version: '0' } } })}\n`)
  proc.stdin.flush()
  void (async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const m = JSON.parse(line)
          if (m.id === 1) {
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
            proc.stdin.flush()
          }
          if (m.method === 'notifications/claude/channel') notifications++
        } catch {}
      }
    }
  })()

  const waitFor = async (p: () => boolean, ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end && !p()) await Bun.sleep(50)
    return p()
  }
  const typed = () => (existsSync(typedFile) ? readFileSync(typedFile, 'utf8') : '')
  const delivered = () => notifications + typed().split('\n').filter(Boolean).length
  try {
    await waitFor(() => readFileSync(mcpLog, 'utf8').includes('dashboard channel: route-marker '), 3_000)
    if (decision) appendFileSync(mcpLog, decision + '\n')
    // First inbound: the pending row, drained 5s after connect (no decision → a
    // bounded ~10s wait for one).
    await waitFor(() => acked.length > 0 && delivered() >= 1, 20_000)
    await Bun.sleep(1_000)
    // Second inbound: a web-chat drop-file, picked up live.
    const inbox = join(state, 'agent-inbox')
    writeFileSync(join(inbox, '.second.tmp'), JSON.stringify({ text: 'still there?', chat_id: 'chat-owner-1', from: 'owner' }))
    renameSync(join(inbox, '.second.tmp'), join(inbox, 'second.json'))
    await waitFor(() => delivered() >= 2, 15_000)
    await Bun.sleep(1_500)
    return {
      events: [...events],
      notifications,
      typed: typed(),
      acked: [...acked],
      lifecycle: existsSync(join(state, 'lifecycle.log')) ? readFileSync(join(state, 'lifecycle.log'), 'utf8') : '',
    }
  } finally {
    proc.kill()
    api.stop(true)
    spawnSync('tmux', ['-S', sock, 'kill-server'])
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!hasTmux)('the real plugin process', () => {
  for (const [name, line] of [['org policy', ORG_POLICY], ['an org allowlist without this plugin', ALLOWLIST]] as const) {
    test(`${name} → exactly one notice, in the owner's chat, none on the second inbound`, async () => {
      const r = await runServer(line)
      expect(r.acked).toEqual([77])
      // Both messages still go to the session as notifications, never typed.
      expect(r.notifications).toBe(2)
      expect(r.typed).toBe('')
      expect(r.events.length).toBe(1)
      expect(r.events[0]!.agent).toBe('dev')
      expect(r.events[0]!.metadata.chat_id).toBe('chat-owner-1')
      expect(r.events[0]!.body).toBe(orgPolicyText())
      expect(r.lifecycle).toContain('channels off by org policy; told the owner in chat chat-owner-1')
    }, 60_000)
  }

  for (const [name, line] of [['bound', REGISTERED], ['refused', REFUSED], ['an unknown skip', NOT_IN_LIST], ['no decision', '']] as const) {
    test(`${name} → no notice`, async () => {
      const r = await runServer(line)
      expect(r.acked).toEqual([77])
      expect(r.notifications + r.typed.split('\n').filter(Boolean).length).toBe(2)
      expect(r.events).toEqual([])
    }, 60_000)
  }
})
