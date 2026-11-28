// DIVE-9477: at a usage limit, ONE «Switch to <account>» button, and only when the box holds another account
// of the same AI with room left. The tap moves the agent once through the /account switch path.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  pickSwitchAccount, readSwitchAccount, switchLabel, switchCallbackData, parseSwitchCallback,
  armSwitchResume, disarmSwitchResume, newestSessionId, resumeMarkerPath, SWITCH_FRESH_S,
} from '../plugins/telegram/hooks/lib/limit-switch'

const NOW = 1_800_000_000
const room = (five: number, seven: number | null = 10, asOf = NOW - 60) => ({
  fiveHour: { pct: five, resetsAt: NOW + 3600 }, sevenDay: seven === null ? null : { pct: seven, resetsAt: NOW + 86400 }, asOf,
})
const ACCOUNTS = [
  { name: 'main', types: ['claude'] },
  { name: 'spare', types: ['claude'] },
  { name: 'gpt', types: ['codex'] },
]
const pick = (usage: any[], accounts: any[] | null = ACCOUNTS, active: string | null = 'main') =>
  pickSwitchAccount({ active, type: 'claude', accounts, usage, nowSec: NOW })

test('a second Claude account with room is offered', () => {
  expect(pick([{ name: 'main', usage: room(100) }, { name: 'spare', usage: room(12) }])).toBe('spare')
})

test('no second account: no button', () => {
  expect(pick([{ name: 'main', usage: room(100) }], [{ name: 'main', types: ['claude'] }])).toBeNull()
})

test('the other account holds no sign-in for this AI: no button', () => {
  expect(pick([{ name: 'main', usage: room(100) }, { name: 'gpt', usage: room(1) }])).toBeNull()
})

test('the other account is at its limit too (5h or 7d): no button', () => {
  expect(pick([{ name: 'spare', usage: room(95) }])).toBeNull()
  expect(pick([{ name: 'spare', usage: room(10, 93) }])).toBeNull()
  expect(pick([{ name: 'spare', usage: room(10, null) }])).toBe('spare')
})

test('no reading, a failed poll, a missing 5h window or a stale reading: no button', () => {
  expect(pick([{ name: 'spare', usage: null }])).toBeNull()
  expect(pick([{ name: 'spare', usage: { ...room(5), pollError: 'http 401' } }])).toBeNull()
  expect(pick([{ name: 'spare', usage: { ...room(5), fiveHour: null } }])).toBeNull()
  expect(pick([{ name: 'spare', usage: room(5, 5, NOW - SWITCH_FRESH_S - 1) }])).toBeNull()
})

test('unknown current account or unreadable lists: no button', () => {
  const u = [{ name: 'spare', usage: room(5) }]
  expect(pick(u, ACCOUNTS, null)).toBeNull()
  expect(pick(u, null)).toBeNull()
  expect(pickSwitchAccount({ active: 'main', type: 'claude', accounts: ACCOUNTS, usage: null, nowSec: NOW })).toBeNull()
  // An older CLI whose list carries no types: never guessed.
  expect(pick(u, [{ name: 'main' }, { name: 'spare' }])).toBeNull()
})

test('of several, the one with the most room; the current one never', () => {
  const accounts = [...ACCOUNTS, { name: 'third', types: ['claude', 'codex'] }]
  expect(pick([{ name: 'main', usage: room(1) }, { name: 'spare', usage: room(40) }, { name: 'third', usage: room(7) }], accounts)).toBe('third')
})

test('the button: words and a callback the server parses back to the account, nothing else', () => {
  expect(switchLabel('spare')).toBe('Switch to spare')
  expect(switchLabel('spare', 'ru')).toBe('Перейти на spare')
  const data = switchCallbackData('a'.repeat(32))
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  expect(parseSwitchCallback(switchCallbackData('spare'))).toBe('spare')
  for (const bad of ['account:spare', 'lsw:', 'lsw:Spare', 'lsw:spare;rm', 'lsw:../x', 'lsw:' + 'a'.repeat(33)]) {
    expect(parseSwitchCallback(bad)).toBeNull()
  }
})

const envelope = (data: unknown) => ({ ok: true, data })

test('the hook read: list and usage side by side, then the pick', async () => {
  const asked: string[][] = []
  const got = await readSwitchAccount({
    active: 'main', type: 'claude', budgetMs: 1000, nowSec: NOW,
    read: async args => {
      asked.push(args)
      return args.includes('list') ? envelope(ACCOUNTS) : envelope([{ name: 'spare', usage: room(3) }])
    },
  })
  expect(got).toBe('spare')
  expect(asked).toEqual([['--json', 'account', 'list'], ['--json', 'account', 'usage']])
})

test('the hook read: a read slower than the budget is no button, on time', async () => {
  const t0 = Date.now()
  const got = await readSwitchAccount({
    active: 'main', type: 'claude', budgetMs: 150, nowSec: NOW,
    read: args => new Promise(res => setTimeout(() => res(args.includes('list') ? envelope(ACCOUNTS) : envelope([{ name: 'spare', usage: room(3) }])), 2000)),
  })
  expect(got).toBeNull()
  expect(Date.now() - t0).toBeLessThan(1000)
})

test('the hook read: a failed or refused read is no button', async () => {
  for (const read of [async () => null, async () => ({ ok: false, error: 'must run as root' }), async () => { throw new Error('boom') }]) {
    expect(await readSwitchAccount({ active: 'main', type: 'claude', budgetMs: 500, nowSec: NOW, read: read as any })).toBeNull()
  }
})

test('the tap arms the resume 5dive-agent-start reads, on the newest conversation; a failed switch disarms it', () => {
  const home = mkdtempSync(join(tmpdir(), 'lsw-'))
  expect(armSwitchResume(home)).toBeNull() // no conversation yet: switch on a fresh start
  const proj = join(home, '.claude', 'projects', '-home-x')
  mkdirSync(join(proj, 'sub'), { recursive: true })
  const old = '11111111-1111-1111-1111-111111111111'
  const cur = '22222222-2222-2222-2222-222222222222'
  writeFileSync(join(proj, `${old}.jsonl`), '')
  writeFileSync(join(proj, `${cur}.jsonl`), '')
  writeFileSync(join(proj, 'sub', '33333333-3333-3333-3333-333333333333.jsonl'), '') // a subagent's, deeper
  utimesSync(join(proj, `${old}.jsonl`), new Date(1000), new Date(1000))
  expect(newestSessionId(home)).toBe(cur)
  const marker = armSwitchResume(home)
  expect(marker).toBe(resumeMarkerPath(home))
  // The shape 5dive-agent-start validates: a UUID line, then a prompt in its safe charset.
  const [id, prompt] = readFileSync(marker!, 'utf8').split('\n')
  expect(id).toMatch(/^[0-9a-fA-F-]{36}$/)
  expect(id).toBe(cur)
  expect(prompt).toMatch(/^[A-Za-z0-9 ._-]{1,200}$/)
  disarmSwitchResume(marker)
  expect(existsSync(marker!)).toBe(false)
})

// The wiring, read from the source: the button is added only from an offer, so without one the notice and
// its markup are what they were; and the tap goes through the /account switch (applyAccount → set-account).
const HOOK = readFileSync(join(import.meta.dir, '../plugins/telegram/hooks/stopfailure-notify.ts'), 'utf8')
const SERVER = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')

test('hook: the only new markup is the offer, on a usage limit to the caller, never on a partner box', () => {
  const at = HOOK.indexOf('DIVE-9477')
  expect(at).toBeGreaterThan(0)
  const block = HOOK.slice(at, HOOK.indexOf('const results = await Promise.all', at))
  expect(block).toContain("isRateLimit && !LITE && demoFingerprint === null && routeKind === 'caller' && markup === undefined")
  expect(block).toContain('if (other) markup = { inline_keyboard: [[{ text: switchLabel(other), callback_data: switchCallbackData(other) }]] }')
  expect((block.match(/markup = /g) ?? []).length).toBe(1)
  // The notice text is built before and never touched here.
  expect(block).not.toMatch(/\btext\s*=/)
})

test('server: lsw:<account> runs the /account switch once, with the resume armed and disarmed on failure', () => {
  const at = SERVER.indexOf('const limitSwitch = parseSwitchCallback(data)')
  expect(at).toBeGreaterThan(0)
  const block = SERVER.slice(at, SERVER.indexOf('\n  }', at))
  expect(block).toContain('armSwitchResume()')
  expect(block).toContain('applyAccount(limitSwitch, chatId')
  expect(block).toContain('if (!ok) disarmSwitchResume(marker)')
  expect(block).toContain('if (!r.after) disarmSwitchResume(marker)')
  expect(block).not.toContain('rotation')
  // applyAccount's switch is still the one set-account call.
  expect(SERVER).toContain("sudo5dive(['5dive', 'agent', 'set-account', me, name]")
})
