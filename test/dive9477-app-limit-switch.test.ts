// DIVE-9477, the app half: at a usage limit, the web-chat notice carries «Switch to <account>» (with «Wait for
// reset», since the app's buttons are a question of 2 to 10 options) only when another account of this AI has
// room. With no such account the notice is byte-for-byte what it was. The server answers the tap: the existing
// set-account, once, and never types the tap into the session that is at its limit.
// Drives the REAL dashboard StopFailure hook with an isolated HOME and a fake `5dive` on PATH.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  LIMIT_OFFER_MAX_MS, limitOfferDir, limitOfferExpiry, limitSwitchText, runLimitSwitch, takeLimitOffer, writeLimitOffer,
  type LimitOffer, type SwitchExec,
} from '../plugins/dashboard/hooks/lib/dashboard-chat.ts'
import { readSwitchAccount, waitLabel } from '../plugins/dashboard/hooks/lib/limit-switch.ts'
import { sharedFiles } from '../generator/sync-dashboard-hooks.ts'

const ROOT = join(import.meta.dir, '..', 'plugins')
const HOOK = join(ROOT, 'dashboard', 'hooks', 'stopfailure-notify.ts')
const SERVER_SRC = readFileSync(join(ROOT, 'dashboard', 'server.ts'), 'utf8')

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dash-lsw-')) })
afterEach(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const inbound = (text: string, chat = '33') => ({
  type: 'user',
  message: { role: 'user', content: `<channel source="plugin:dashboard:dashboard" chat_id="${chat}" user="owner" ts="2026-11-28T02:00:00Z">${text}</channel>` },
})
function transcript(entries: unknown[]): string {
  const p = join(home, 'transcript.jsonl')
  writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return p
}

// A fake `5dive`: this seat runs on `main`; `spare` is another Claude account at `sparePct` on 5h.
// `accounts` = 1 leaves the box with one account only. Every call is logged.
function fake5dive(o: { accounts: 1 | 2; sparePct?: number }): string {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const list = o.accounts === 2
    ? '[{"name":"main","types":["claude"]},{"name":"spare","types":["claude"]}]'
    : '[{"name":"main","types":["claude"]}]'
  const usage = [{ name: 'main', usage: { fiveHour: { pct: 100 }, sevenDay: { pct: 40 }, asOf: 'NOW' } }]
  if (o.accounts === 2) usage.push({ name: 'spare', usage: { fiveHour: { pct: o.sparePct ?? 12 }, sevenDay: { pct: 20 }, asOf: 'NOW' } })
  writeFileSync(join(bin, 'usage.json'), JSON.stringify({ ok: true, data: usage }).replace(/"NOW"/g, 'NOW'))
  writeFileSync(join(bin, '5dive'), `#!/bin/sh
echo "$@" >> ${home}/5dive.log
case "$*" in
  "--json account list") echo '{"ok":true,"data":${list}}' ;;
  "--json account usage") sed "s/NOW/$(date +%s)/g" ${bin}/usage.json ;;
  "--json agent rotation get tap") echo '{"ok":true,"data":{"active":"main","enabled":false}}' ;;
  *) echo '{"ok":false}'; exit 1 ;;
esac
`)
  chmodSync(join(bin, '5dive'), 0o755)
  return bin
}

function fire(payload: Record<string, unknown>, bin: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home, USER: 'agent-tap', TMUX: '', PATH: `${bin}:${process.env.PATH}`,
    DASHBOARD_RESUME_BUN: '/bin/true',
  }
  delete env.CLAUDE_CONFIG_DIR
  delete env.DASHBOARD_STATE_DIR
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}
const state = () => join(home, '.claude', 'channels', 'dashboard')
const notices = () => {
  const d = join(state(), 'notice-outbox')
  return (existsSync(d) ? readdirSync(d).filter(n => n.endsWith('.json')) : []).map(n => JSON.parse(readFileSync(join(d, n), 'utf8')))
}
const offers = () => {
  const d = join(state(), 'limit-switch')
  return (existsSync(d) ? readdirSync(d).filter(n => n.endsWith('.json')) : []).map(n => JSON.parse(readFileSync(join(d, n), 'utf8')) as LimitOffer)
}
const limit = (tp: string) => ({
  message: 'Claude usage limit reached', reason: 'usage_limit', stopReason: 'rate_limit',
  resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 + 10 * 60 + 20, transcript_path: tp,
})
const TODAY = "I've hit my usage limit — back in about 2 h 10 min. I'll pick your message up then."

describe('the app notice', () => {
  test('no second account: the notice is exactly today\'s — same words, no buttons, no offer', () => {
    const r = fire(limit(transcript([inbound('book the friday flight')])), fake5dive({ accounts: 1 }))
    expect(r.code).toBe(0)
    expect(notices()).toEqual([{ source: 'dashboard', chat_id: '33', text: TODAY }])
    expect(offers()).toEqual([])
    expect(r.stderr).toContain('switch offer: none')
  })

  test('the other account is at its limit too: today\'s notice', () => {
    fire(limit(transcript([inbound('hi')])), fake5dive({ accounts: 2, sparePct: 95 }))
    expect(notices()).toEqual([{ source: 'dashboard', chat_id: '33', text: TODAY }])
    expect(offers()).toEqual([])
  })

  test('a second Claude account with room: the same words, plus «Switch to spare» and «Wait for reset»', () => {
    fire(limit(transcript([inbound('book the friday flight')])), fake5dive({ accounts: 2 }))
    const n = notices()
    expect(n.length).toBe(1)
    expect(n[0].text).toBe(TODAY)
    expect(n[0].chat_id).toBe('33')
    expect(n[0].question.options).toEqual([{ label: 'Switch to spare' }, { label: 'Wait for reset' }])
    const o = offers()
    expect(o.length).toBe(1)
    expect(o[0]).toMatchObject({ id: n[0].question.id, chatId: '33', account: 'spare', lang: 'en', labels: ['Switch to spare', 'Wait for reset'] })
    // Lives until the limit lifts.
    expect(Math.abs(o[0].expiresAt - limit('x').resetsAt * 1000)).toBeLessThan(5_000)
  })

  test('the notice in Russian gets Russian buttons', () => {
    fire(limit(transcript([inbound('забронируй рейс на пятницу')])), fake5dive({ accounts: 2 }))
    expect(notices()[0].question.options.map((o: { label: string }) => o.label)).toEqual(['Перейти на spare', waitLabel('ru')])
  })

  test('the question passes the server\'s own parser (2 to 10 options), so the relay draws it', async () => {
    fire(limit(transcript([inbound('hi')])), fake5dive({ accounts: 2 }))
    const { parseQuestion } = await import('../plugins/dashboard/question.ts')
    expect(parseQuestion(notices()[0].question)).not.toBeNull()
  })

  test('limit-switch.ts is in the dashboard\'s shared copy list', () => {
    expect(sharedFiles()).toContain('lib/limit-switch.ts')
  })
})

describe('the hook read with only the agent name', () => {
  test('reads the agent\'s account in the same budget, then picks', async () => {
    const seen: string[] = []
    const read = async (args: string[]) => {
      seen.push(args.join(' '))
      if (args.includes('rotation')) return { ok: true, data: { active: 'main' } }
      if (args.includes('list')) return { ok: true, data: [{ name: 'main', types: ['claude'] }, { name: 'spare', types: ['claude'] }] }
      return { ok: true, data: [{ name: 'spare', usage: { fiveHour: { pct: 5 }, sevenDay: { pct: 5 }, asOf: 1000 } }] }
    }
    expect(await readSwitchAccount({ agent: 'tap', type: 'claude', read, budgetMs: 1000, nowSec: 1000 })).toBe('spare')
    expect(seen).toContain('--json agent rotation get tap')
    // Unknown current account: no offer.
    const noRot = async (args: string[]) => (args.includes('rotation') ? { ok: false } : read(args))
    expect(await readSwitchAccount({ agent: 'tap', type: 'claude', read: noRot, budgetMs: 1000, nowSec: 1000 })).toBeNull()
    expect(await readSwitchAccount({ agent: 'Bad Name', type: 'claude', read, budgetMs: 1000, nowSec: 1000 })).toBeNull()
  })
})

describe('the tap (server)', () => {
  const env = () => ({ ...process.env, DASHBOARD_STATE_DIR: join(home, 'state') }) as NodeJS.ProcessEnv
  const offer = (o: Partial<LimitOffer> = {}): LimitOffer => ({
    id: 'lsw-1', chatId: '33', account: 'spare', lang: 'en', labels: ['Switch to spare', 'Wait for reset'], expiresAt: Date.now() + 60_000, ...o,
  })

  test('the switch label is a switch, once; a second tap is nothing', () => {
    writeLimitOffer(offer(), env())
    expect(takeLimitOffer('33', 'Switch to spare', Date.now(), env())).toMatchObject({ action: 'switch', offer: { account: 'spare' } })
    expect(takeLimitOffer('33', 'Switch to spare', Date.now(), env())).toBeNull()
  })

  test('«Wait for reset», or "2" typed under an older relay\'s numbered text, is a wait; "1" is a switch', () => {
    writeLimitOffer(offer(), env())
    expect(takeLimitOffer('33', 'Wait for reset', Date.now(), env())?.action).toBe('wait')
    writeLimitOffer(offer(), env())
    expect(takeLimitOffer('33', '2', Date.now(), env())?.action).toBe('wait')
    writeLimitOffer(offer(), env())
    expect(takeLimitOffer('33', '1', Date.now(), env())?.action).toBe('switch')
  })

  test('anything else goes on to the session, and the offer stays; another chat never takes it; an expired one is gone', () => {
    writeLimitOffer(offer(), env())
    expect(takeLimitOffer('33', 'also book a hotel', Date.now(), env())).toBeNull()
    expect(takeLimitOffer('44', 'Switch to spare', Date.now(), env())).toBeNull()
    expect(takeLimitOffer('33', 'Switch to spare', Date.now() + 120_000, env())).toBeNull()
    expect(readdirSync(limitOfferDir(env()))).toEqual([])
  })

  test('the offer lives until the reset, 6 h at most', () => {
    const now = 1_800_000_000_000
    expect(limitOfferExpiry(now / 1000 + 3600, now)).toBe(now + 3600_000)
    expect(limitOfferExpiry(now / 1000 + 9 * 3600, now)).toBe(now + LIMIT_OFFER_MAX_MS)
    expect(limitOfferExpiry(null, now)).toBe(now + LIMIT_OFFER_MAX_MS)
  })

  // A recording exec: set-account answers as told; rotation get reports `active`.
  function exec(o: { sudo: boolean; plain: boolean; active?: string }) {
    const calls: string[] = []
    const run: SwitchExec = async (cmd, args) => {
      const line = [cmd, ...args].join(' ')
      calls.push(line)
      if (args.includes('rotation')) return { ok: true, stdout: JSON.stringify({ ok: true, data: { active: o.active ?? 'main' } }), stderr: '' }
      const ok = cmd === 'sudo' ? o.sudo : o.plain
      return { ok, stdout: '', stderr: ok ? '' : 'error: not allowed for this seat' }
    }
    return { run, calls, setAccount: () => calls.filter(c => c.includes('set-account')) }
  }

  test('the switch is the existing set-account, as root first', async () => {
    const e = exec({ sudo: true, plain: false })
    expect(await runLimitSwitch('tap', 'spare', e.run)).toEqual({ ok: true, detail: '' })
    expect(e.setAccount()).toEqual(['sudo -n 5dive agent set-account tap spare'])
  })

  test('a standard seat: root refused, the seat\'s own call does it', async () => {
    const e = exec({ sudo: false, plain: true })
    expect((await runLimitSwitch('tap', 'spare', e.run)).ok).toBe(true)
    expect(e.setAccount()).toEqual(['sudo -n 5dive agent set-account tap spare', '5dive agent set-account tap spare'])
  })

  test('a failed call that in fact landed is a success, and is not run twice', async () => {
    const e = exec({ sudo: false, plain: false, active: 'spare' })
    expect((await runLimitSwitch('tap', 'spare', e.run)).ok).toBe(true)
    expect(e.setAccount().length).toBe(1)
  })

  test('both refused: not switched, with the reason', async () => {
    const e = exec({ sudo: false, plain: false })
    expect(await runLimitSwitch('tap', 'spare', e.run)).toEqual({ ok: false, detail: 'error: not allowed for this seat' })
    expect(limitSwitchText('failed', 'spare', 'en', 'x')).toContain("I'm still on my current account")
  })

  test('a bad name never reaches the CLI', async () => {
    const e = exec({ sudo: true, plain: true })
    expect((await runLimitSwitch('tap', 'Spare; rm', e.run)).ok).toBe(false)
    expect(e.calls).toEqual([])
  })

  test('server wiring: the tap is answered before the session sees it; resume armed first, removed on failure', () => {
    const deliver = SERVER_SRC.slice(SERVER_SRC.indexOf('async function deliverInbound'))
    const iOffer = deliver.indexOf('answerLimitOffer(chatId, text)')
    expect(iOffer).toBeGreaterThan(0)
    expect(iOffer).toBeLessThan(deliver.indexOf('answerPendingQuestion(chatId, text)'))
    expect(iOffer).toBeLessThan(deliver.indexOf('deliverToSession(text, meta)'))
    const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function answerLimitOffer'), SERVER_SRC.indexOf('// --- DIVE-6715: "working'))
    expect(fn.indexOf('armSwitchResume()')).toBeLessThan(fn.indexOf('runLimitSwitch('))
    expect(fn).toMatch(/if \(!r\.ok\) disarmSwitchResume\(marker\)/)
    // No rotation verb anywhere on this path.
    expect(fn).not.toMatch(/rotation (set|rotate)/)
  })
})
