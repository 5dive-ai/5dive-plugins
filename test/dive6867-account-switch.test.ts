// DIVE-6867: on Telegram /account, a switch that worked said "❌ Couldn't
// switch", quoting the CLI's progress lines, and the picker sometimes took ~10s
// to open. The pure half (what a rejected switch means, the reason the owner
// reads, the picker's read cache) is driven directly; the wiring in server.ts is
// read as text, because importing the server long-polls Telegram.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCOUNT_SWITCH_TIMEOUT_MS, accountSwitchNext, plainSwitchReason,
  accountSwitchFailedText, accountSwitchUnfinishedText,
} from '../plugins/telegram/seatpriv'
import { createSwrRead } from '../plugins/telegram/readcache'

const SERVER = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
function body(startMarker: string, endMarker: string): string {
  const i = SERVER.indexOf(startMarker)
  expect(i).toBeGreaterThan(-1)
  const j = SERVER.indexOf(endMarker, i + startMarker.length)
  expect(j).toBeGreaterThan(i)
  return SERVER.slice(i, j)
}

// The rejection olivia's bot got on 2026-10-24 12:20Z: execFile killed
// `sudo -n 5dive agent set-account olivia chemmonitor` at its 5s budget, after
// these two progress lines and before the restart step.
const KILLED_MIDWAY = Object.assign(new Error('Command failed: sudo -n 5dive agent set-account olivia chemmonitor'), {
  killed: true, signal: 'SIGTERM', code: null,
  stderr: '==> Rewriting /var/lib/5dive/agents.d/olivia.env\n==> Re-pointing /var/lib/5dive/agents.d/olivia-auth.env\n',
})
// Killed (or exited non-zero) only after the CLI had scheduled the restart.
const AFTER_RESTART = Object.assign(new Error('Command failed'), {
  killed: true, signal: 'SIGTERM',
  stderr: '==> Rewriting /var/lib/5dive/agents.d/olivia.env\n==> Re-pointing /var/lib/5dive/agents.d/olivia-auth.env\n==> Restarting agent to apply (deferred ~1s)\n',
})
// A real refusal, as the CLI's fail() prints it.
const NOT_CONFIGURED = Object.assign(new Error('Command failed: sudo -n 5dive agent set-account olivia ghost'), {
  code: 3,
  stderr: "==> Rewriting /var/lib/5dive/agents.d/olivia.env\nerror: auth profile 'ghost' not configured\n",
})

describe('a rejected switch is checked before anyone is told it failed', () => {
  test("olivia's case: the account moved, the run was killed before the restart — run it again", () => {
    expect(accountSwitchNext(KILLED_MIDWAY, 'chemmonitor', 'chemmonitor')).toBe('retry')
  })
  test('the account moved and the restart was already scheduled — it worked, say ✅', () => {
    expect(accountSwitchNext(AFTER_RESTART, 'chemmonitor', 'chemmonitor')).toBe('done')
  })
  test('the account did not move — a real failure', () => {
    expect(accountSwitchNext(NOT_CONFIGURED, 'konst', 'ghost')).toBe('failed')
    expect(accountSwitchNext(KILLED_MIDWAY, 'konst', 'chemmonitor')).toBe('failed')
  })
  test('an unreadable registry is never read as success', () => {
    expect(accountSwitchNext(AFTER_RESTART, null, 'chemmonitor')).toBe('failed')
    expect(accountSwitchNext(AFTER_RESTART, null, 'default')).toBe('failed')
  })
})

describe('the reason the owner reads is plain', () => {
  test('never the progress lines, a file path or the sudo command', () => {
    for (const err of [KILLED_MIDWAY, AFTER_RESTART, NOT_CONFIGURED]) {
      const r = plainSwitchReason(err)
      expect(r).not.toContain('==>')
      expect(r).not.toContain('/var/lib')
      expect(r).not.toContain('sudo')
      expect(accountSwitchFailedText('x', false, r)).not.toContain('==>')
    }
  })
  test("the CLI's own error line is the reason", () => {
    expect(plainSwitchReason(NOT_CONFIGURED)).toBe("auth profile 'ghost' not configured")
  })
  test('a kill or timeout says so in words', () => {
    expect(plainSwitchReason(KILLED_MIDWAY)).toBe('it took too long and was stopped')
    expect(plainSwitchReason({ code: 'ETIMEDOUT' })).toBe('it took too long and was stopped')
  })
  test('anything else is "unknown error", not raw output', () => {
    expect(plainSwitchReason(new Error('Command failed: sudo -n 5dive agent set-account a b'))).toBe('unknown error')
    expect(plainSwitchReason({ stderr: 'warn: something\n==> Rewriting /x\n' })).toBe('unknown error')
    expect(plainSwitchReason(undefined)).toBe('unknown error')
  })
  test('a switch that moved but would not finish says how to finish it', () => {
    const t = accountSwitchUnfinishedText('chemmonitor', 'it took too long and was stopped')
    expect(t).toStartWith('❌')
    expect(t).toContain('/account')
    expect(t).not.toContain('still on its current account')
  })
})

describe('server.ts wiring', () => {
  const apply = body('async function applyAccount(', '\nfunction applyEffort(')
  test('set-account gets one long budget, never the 5s that killed it', () => {
    expect(ACCOUNT_SWITCH_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
    expect(apply).toContain('timeout: ACCOUNT_SWITCH_TIMEOUT_MS')
    expect(apply).not.toMatch(/timeout:\s*(standard \? \d+ : )?\d+/)
  })
  test('a rejection re-reads the registry and goes through accountSwitchNext', () => {
    expect(apply).toContain('read5diveAgentList()')
    expect(apply).toContain('accountSwitchNext(err, boundNow, name)')
  })
  test('the failure text carries plainSwitchReason, not stderr or err.message', () => {
    expect(apply).toContain('plainSwitchReason(err)')
    expect(apply).not.toContain('err.stderr')
    expect(apply).not.toContain('err.message')
  })
  test('a sudo refusal still says who can switch', () => {
    expect(apply).toContain('accountSwitchFailedText(name, true, \'\', lang)')
  })
  test('the picker reads through the cache, and the boot warms it', () => {
    const menu = body('async function buildAccountMenu(', '\nasync function buildRotationMenu(')
    expect(menu).toContain('menuReads.agents.get()')
    expect(menu).toContain('menuReads.accounts.get()')
    expect(menu).toContain('menuReads.usage.get()')
    expect(menu).toContain('menuRotation(me)')
    expect(menu).not.toMatch(/read5dive(AgentList|AccountList|AccountUsage|Rotation)\(/)
    const start = body('onStart: info => {', 'BotFather menu reflects')
    expect(start).toContain('buildAccountMenu(me)')
  })
  test('/account shows the last menu at once and edits it when the reads land (DIVE-6985)', () => {
    expect(SERVER).toContain('const MENU_STALE_MS = Number.POSITIVE_INFINITY')
    const cmd = body('  account: async ctx => {', '\n  },\n')
    expect(cmd).toContain('accountMenuFollowUp(me, lang, sent.chat.id, sent.message_id, menu)')
    const follow = body('async function accountMenuFollowUp(', '\n}\n')
    expect(follow).toContain('await menuSettled(me)')
    expect(follow).toContain('render(next) === render(shown)')
    expect(follow).toContain('!MENU_FOLLOW_UPS.has(key)')
    const settled = body('async function menuSettled(', '\n}\n')
    for (const r of ['agents', 'accounts', 'usage']) expect(settled).toContain(`menuReads.${r}.settle()`)
    expect(settled).toContain('menuReads.rotation.get(me)?.settle()')
  })
  test('a tap on the picker cancels its pending follow-up edit', () => {
    const tap = body("bot.on('callback_query:data', async ctx => {", 'const access = loadAccess()')
    expect(tap).toContain('MENU_FOLLOW_UPS.delete(`${tapped.chat.id}:${tapped.message_id}`)')
  })
  test('a rotation write clears the picker cache', () => {
    const w = body('async function write5diveRotation(', '\n}\n')
    expect(w).toContain('menuReads.rotation.get(me)?.clear()')
  })
})

describe('the picker read cache', () => {
  function rig() {
    let t = 0
    let calls = 0
    let next: unknown = 'v1'
    const r = createSwrRead(async () => { calls++; return next }, { freshMs: 30, maxStaleMs: 600, now: () => t })
    return { r, tick: (ms: number) => { t += ms }, calls: () => calls, set: (v: unknown) => { next = v } }
  }
  test('a fresh value is served without a read', async () => {
    const x = rig()
    expect(await x.r.get()).toBe('v1')
    x.tick(10)
    expect(await x.r.get()).toBe('v1')
    expect(x.calls()).toBe(1)
  })
  test('a stale value is served at once and refreshed behind it', async () => {
    const x = rig()
    await x.r.get()
    x.set('v2'); x.tick(100)
    expect(await x.r.get()).toBe('v1')
    await Promise.resolve(); await Promise.resolve()
    expect(x.calls()).toBe(2)
    expect(await x.r.get()).toBe('v2')
  })
  test('past maxStale it waits for a fresh read', async () => {
    const x = rig()
    await x.r.get()
    x.set('v2'); x.tick(1000)
    expect(await x.r.get()).toBe('v2')
  })
  test('a failed read (null) is never cached', async () => {
    const x = rig()
    x.set(null)
    expect(await x.r.get()).toBe(null)
    x.set('v1')
    expect(await x.r.get()).toBe('v1')
    expect(x.calls()).toBe(2)
  })
  test('concurrent gets share one read', async () => {
    const x = rig()
    await Promise.all([x.r.get(), x.r.get(), x.r.get()])
    expect(x.calls()).toBe(1)
  })
  test('settle() is false with nothing in flight, true once a background re-read lands (DIVE-6985)', async () => {
    const x = rig()
    expect(await x.r.settle()).toBe(false)
    await x.r.get()
    expect(await x.r.settle()).toBe(false)
    x.set('v2'); x.tick(100)
    expect(await x.r.get()).toBe('v1')
    expect(await x.r.settle()).toBe(true)
    expect(await x.r.get()).toBe('v2')
  })
  test('settle() never rejects when the re-read throws', async () => {
    let t = 0
    let calls = 0
    const r = createSwrRead(async () => { if (++calls > 1) throw new Error('cli down'); return 'v1' }, { freshMs: 30, maxStaleMs: Number.POSITIVE_INFINITY, now: () => t })
    await r.get()
    t += 100
    expect(await r.get()).toBe('v1')
    expect(await r.settle()).toBe(true)
    expect(await r.get()).toBe('v1')
  })
  test('with no age limit, a value days old is still served at once (DIVE-6985)', async () => {
    let t = 0
    let calls = 0
    const r = createSwrRead(async () => `v${++calls}`, { freshMs: 30, maxStaleMs: Number.POSITIVE_INFINITY, now: () => t })
    expect(await r.get()).toBe('v1')
    t += 3 * 24 * 3_600_000
    expect(await r.get()).toBe('v1')
    expect(await r.settle()).toBe(true)
    expect(await r.get()).toBe('v2')
  })
  test('clear() makes the next get read again, and a read in flight does not land after it', async () => {
    let release!: (v: string) => void
    let calls = 0
    const r = createSwrRead(() => { calls++; return calls === 1 ? new Promise<string>(res => { release = res }) : Promise.resolve('new') }, { freshMs: 1e9, maxStaleMs: 1e9, now: () => 0 })
    const first = r.get()
    r.clear()
    release('old')
    expect(await first).toBe('old')
    expect(await r.get()).toBe('new')
    expect(calls).toBe(2)
  })
})
