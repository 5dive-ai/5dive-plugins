// DIVE-5993: on a Claude Team/Enterprise login whose org has not switched
// channels on, Claude Code drops every inbound and logs why. The plugin reads
// that as `org_policy` (not the flag `refused`), never types the message into
// the session, and tells the owner ONCE what an admin switches on; the notice
// clears when the gate reads bound again.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionFromLog, makeRouteProbe, cacheDirName } from '../plugins/telegram/channelroute'
import {
  makeOrgPolicyNotifier,
  orgPolicyText,
  ORG_POLICY_JSON,
  ORG_POLICY_NOTIFIED_FILE,
  ORG_SETTINGS_URL,
  ORG_POLICY_FAQ_URL,
} from '../plugins/telegram/orgpolicy'

const MARKER = 'telegram channel: route-marker 4242.1760100000000'
const dbg = (debug: string) => JSON.stringify({ debug, timestamp: '2026-10-10T18:00:00.000Z', sessionId: 's', cwd: '/x' })
const stderrLine = (text: string) => JSON.stringify({ error: `Server stderr: ${text}\n`, timestamp: '2026-10-10T18:00:00.000Z' })
// Verbatim from the Claude Code 2.1.296 binary: `re(wo.name, \`Channel notifications skipped: ${Bn.reason}\`)`.
const ORG_OFF = dbg('Channel notifications skipped: channels not enabled by org policy (set channelsEnabled: true in managed settings)')
const ORG_LIST = dbg("Channel notifications skipped: plugin telegram@5dive-plugins is not on your org's approved channels list (set allowedChannelPlugins in managed settings)")
const REFUSED = dbg('Channel notifications skipped: channels feature is not currently available')
const REGISTERED = dbg('Channel notifications registered')
const NOT_IN_LIST = dbg('Channel notifications skipped: server plugin:telegram:telegram not in --channels list for this session')
const log = (...lines: string[]) => [stderrLine(`telegram channel: start: boot ok\n${MARKER}`), ...lines].join('\n') + '\n'

describe('the org policy is its own decision', () => {
  test('the org-policy line → org_policy; the flag line → still refused; a bound line → bound', () => {
    expect(decisionFromLog(log(ORG_OFF), MARKER)).toBe('org_policy')
    expect(decisionFromLog(log(REFUSED), MARKER)).toBe('refused')
    expect(decisionFromLog(log(REGISTERED), MARKER)).toBe('bound')
  })
  test("an org allowlist without this plugin is the org's choice too", () => {
    expect(decisionFromLog(log(ORG_LIST), MARKER)).toBe('org_policy')
  })
  test('other skips stay other', () => {
    expect(decisionFromLog(log(NOT_IN_LIST), MARKER)).toBe('other')
  })
  test('the admin flips it and the restarted gate re-logs: the last decision wins', () => {
    expect(decisionFromLog(log(ORG_OFF, REGISTERED), MARKER)).toBe('bound')
  })
})

describe('org_policy is never routed around', () => {
  let root: string
  let file: string
  const cwd = '/home/agent-ceo'
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dive5993-'))
    const dir = join(root, cacheDirName(cwd), 'mcp-logs-plugin-telegram-telegram')
    mkdirSync(dir, { recursive: true })
    file = join(dir, '2026-10-10T18-00-00-000Z.jsonl')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const probe = (asked: boolean) =>
    makeRouteProbe({
      marker: MARKER,
      bootPpid: 1,
      cacheRoot: root,
      bootMs: Date.now(),
      recheckMs: 0,
      findParent: () => ({ pid: 7, argv: asked ? ['claude', '--channels', 'plugin:telegram@5dive-plugins'] : ['claude'], cwd }),
    })
  test('asked + org policy → the notification (no typed copy), and the probe reports org_policy', () => {
    writeFileSync(file, log(ORG_OFF))
    const p = probe(true)
    expect(p.route()).toBe('mcp')
    expect(p.decision()).toBe('org_policy')
  })
  test('a session that never asked for telegram reports nothing to tell the owner about', () => {
    writeFileSync(file, log(ORG_OFF))
    expect(probe(false).decision()).toBe('unknown')
  })
})

describe('the owner is told once', () => {
  let dir: string
  let sent: string[]
  let logs: string[]
  let owners: string[]
  let failFor: Set<string>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dive5993-n-'))
    sent = []
    logs = []
    owners = ['111', '222']
    failFor = new Set()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const notifier = () =>
    makeOrgPolicyNotifier({
      dir,
      owners: () => owners,
      send: async chat => {
        if (failFor.has(chat)) throw new Error('Forbidden: bot was blocked by the user')
        sent.push(chat)
      },
      log: l => logs.push(l),
    })

  test('first detection messages every owner, later beats and a restarted plugin do not repeat it', async () => {
    const n = notifier()
    expect(await n('org_policy')).toBe('sent')
    expect(sent).toEqual(['111', '222'])
    expect(await n('org_policy')).toBe('none')
    expect(await notifier()('org_policy')).toBe('none')
    expect(sent).toEqual(['111', '222'])
  })
  test('the flag refusal, other and unknown never send it', async () => {
    const n = notifier()
    for (const d of ['refused', 'other', 'unknown', 'bound'] as const) expect(await n(d)).toBe('none')
    expect(sent).toEqual([])
  })
  test('bound clears the notice, so an org that switches channels off again is told again', async () => {
    const n = notifier()
    await n('org_policy')
    expect(existsSync(join(dir, ORG_POLICY_NOTIFIED_FILE))).toBe(true)
    expect(await n('bound')).toBe('cleared')
    expect(existsSync(join(dir, ORG_POLICY_NOTIFIED_FILE))).toBe(false)
    expect(await n('org_policy')).toBe('sent')
    expect(sent).toEqual(['111', '222', '111', '222'])
  })
  test('no owner reachable (never opened the bot): not marked, retried next beat', async () => {
    failFor = new Set(['111', '222'])
    const n = notifier()
    expect(await n('org_policy')).toBe('none')
    expect(existsSync(join(dir, ORG_POLICY_NOTIFIED_FILE))).toBe(false)
    failFor = new Set()
    expect(await n('org_policy')).toBe('sent')
  })
})

describe('the words', () => {
  test('names the agent, the claude.ai path and the FAQ JSON, escaped for HTML', () => {
    const t = orgPolicyText('Ceo <b>')
    expect(t).toContain("Ceo &lt;b&gt; can't hear your messages yet")
    expect(t).toContain('claude.ai → Organization settings → Claude Code → Managed settings')
    expect(t).toContain('then restart Ceo &lt;b&gt;')
    expect(t).toContain('<pre><code class="language-json">')
    const json = JSON.parse(ORG_POLICY_JSON)
    expect(json.channelsEnabled).toBe(true)
    expect(json.allowedChannelPlugins).toContainEqual({ plugin: 'telegram', marketplace: '5dive-plugins' })
    expect(json.allowedChannelPlugins).toContainEqual({ plugin: 'dashboard', marketplace: '5dive-plugins' })
    expect(ORG_SETTINGS_URL).toBe('https://claude.ai/admin-settings/claude-code')
    expect(ORG_POLICY_FAQ_URL).toContain('/docs/faq?q=channelsEnabled')
  })
  test('the FAQ JSON in this plugin matches the FAQ answer (the one source)', () => {
    // 5dive-frontend src/data/faqs.ts:137 lists exactly these four entries.
    const list = JSON.parse(ORG_POLICY_JSON).allowedChannelPlugins.map((e: { plugin: string; marketplace: string }) => `${e.plugin}@${e.marketplace}`)
    expect(list).toEqual(['dashboard@5dive-plugins', 'telegram@5dive-plugins', 'telegram@claude-plugins-official', 'discord@claude-plugins-official'])
  })
})

describe('server wiring', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
  test('the active poller re-reads the gate on a timer and hands the decision to the notifier', () => {
    expect(src).toContain('orgPolicyNotice(inboundRoute.decision())')
    expect(src).toMatch(/orgPolicyTimer \?\?= setInterval/)
  })
  test('the notice goes out as HTML with the claude.ai and FAQ buttons', () => {
    expect(src).toContain("parse_mode: 'HTML'")
    expect(src).toContain('.url(\'Open claude.ai\', ORG_SETTINGS_URL)')
  })
  test('the session injector still fires only on refused', () => {
    expect(src).toContain("if (route === 'inject')")
  })
})
