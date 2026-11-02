// DIVE-7565 — a Grok seat out of its weekly plan says so in plain words, once,
// and never advises /restart; the "Help improve Grok" box is answered Opt out
// or dismissed, never Opt in.
//
// The fixture is what reached an owner on 2026-11-02 (chill-gorge, seat dude,
// 5dive 0.110.0) plus what main read off that pane. plan-limit.ts is pure, so it
// is exercised for real; the server/hook wiring is checked statically, like
// dive3786-honest-stall-cause.test.ts (importing a server long-polls Telegram).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  PLAN_ON, planUsedUp, planUsedUpText, planResetHint, claimPlanNotice, clearPlanNotice,
  PLAN_NOTICE_FILE, PLAN_NOTICE_TTL_MS, optInBoxShowing, optOutSelected,
} from '../plugins/telegram-grok/plan-limit.ts'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const src = (fork: string, file = 'server.ts') => readFileSync(join(PLUGINS, fork, file), 'utf8')

const RELAY_LINE = 'API error (status 402 Payment Required): Grok Build usage balance exhausted'
const PANE = [
  '⚠️ grok: API error (status 402 Payment Required): Grok Build usage balance exhausted',
  'Could not open a browser. Open this URL manually: https://grok.com/supergrok?referrer=grok-build',
  '╭──────────────────────────────────────────────╮',
  '│ Help improve Grok                            │',
  '│ Off by default. Opt-in to allow SpaceXAI to  │',
  '│ retain coding data, e.g., prompts, traces.   │',
  '│ [Opt out] [Opt in]                           │',
  '╰──────────────────────────────────────────────╯',
  'Weekly limit left: 0% · Grok 4.7 (high)',
  'Tab:next answer │ Esc:scrollback │ Shift+x:dismiss',
].join('\n')
const MODAL_ONLY = [
  '╭──────────────────────────────────────────────╮',
  '│ Help improve Grok                            │',
  '│ Off by default. Opt-in to allow SpaceXAI to  │',
  '│ [Opt out] [Opt in]                           │',
  '╰──────────────────────────────────────────────╯',
  'Weekly limit left: 64% · Grok 4.7 (high)',
  'Tab:next answer │ Esc:scrollback │ Shift+x:dismiss',
].join('\n')

describe('the plan-used-up classifier, on the real pane', () => {
  test('is on for Grok', () => expect(PLAN_ON).toBe(true))

  test('the chill-gorge pane is plan-used-up', () => expect(planUsedUp(PANE)).toBe(true))

  test('each of Grok\'s three phrasings alone is enough', () => {
    expect(planUsedUp('Grok Build usage balance exhausted')).toBe(true)
    expect(planUsedUp('API error (status 402 Payment Required)')).toBe(true)
    expect(planUsedUp('Weekly limit left: 0% · Grok 4.7 (high)')).toBe(true)
  })

  test('a plan with some left is not used up', () => {
    expect(planUsedUp(MODAL_ONLY)).toBe(false)
    expect(planUsedUp('Weekly limit left: 10% · Grok 4.7')).toBe(false)
    expect(planUsedUp('Weekly limit left: 0.5%')).toBe(false)
  })

  test('the owner line is plain words, names the agent and grok.com, and never says /restart', () => {
    const t = planUsedUpText('dude', PANE)
    expect(t).toBe("Dude has used up this week's Grok plan, so it can't answer until the limit resets. To keep going now, upgrade the plan at grok.com.")
    expect(t).not.toMatch(/restart|402|API|status|error/i)
  })

  test('a reset time is added only when the screen shows one', () => {
    expect(planResetHint(PANE)).toBeNull()
    const t = planUsedUpText('dude', PANE + '\nWeekly limit resets in 2d 4h │ Grok 4.7')
    expect(t).toContain('Resets in 2d 4h.')
  })
})

describe('the notice goes out once per limit hit', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'dive7565-'))

  test('first claim wins, every later 402 is quiet', () => {
    const d = dir()
    expect(claimPlanNotice(d)).toBe(true)
    expect(claimPlanNotice(d)).toBe(false)
    expect(claimPlanNotice(d)).toBe(false)
    rmSync(d, { recursive: true })
  })

  test('answering again clears it, so the next hit is told', () => {
    const d = dir()
    expect(claimPlanNotice(d)).toBe(true)
    clearPlanNotice(d)
    expect(existsSync(join(d, PLAN_NOTICE_FILE))).toBe(false)
    expect(claimPlanNotice(d)).toBe(true)
    rmSync(d, { recursive: true })
  })

  test('a marker older than a week belongs to an earlier hit', () => {
    const d = dir()
    expect(claimPlanNotice(d)).toBe(true)
    const old = (Date.now() - PLAN_NOTICE_TTL_MS - 60_000) / 1000
    utimesSync(join(d, PLAN_NOTICE_FILE), old, old)
    expect(claimPlanNotice(d)).toBe(true)
    rmSync(d, { recursive: true })
  })
})

describe('the "Help improve Grok" box', () => {
  test('is seen on the chill-gorge pane and on a pane with only the box', () => {
    expect(optInBoxShowing(PANE)).toBe(true)
    expect(optInBoxShowing(MODAL_ONLY)).toBe(true)
  })

  test('a pane with only the box is not a used-up plan', () => {
    expect(planUsedUp(MODAL_ONLY)).toBe(false)
  })

  test('is not seen on a normal pane', () => {
    expect(optInBoxShowing('Weekly limit left: 64% · Grok 4.7 (high)\n> ')).toBe(false)
  })

  const E = '\x1b['
  test('Enter only when Opt out is the highlighted answer', () => {
    expect(optOutSelected(`│ ${E}7m[Opt out]${E}0m [Opt in] │`)).toBe(true)
    expect(optOutSelected(`│ ${E}1;48;5;24m[Opt out]${E}0m ${E}2m[Opt in]${E}0m │`)).toBe(true)
  })

  test('Opt in highlighted, nothing highlighted, or no box: never true', () => {
    expect(optOutSelected(`│ [Opt out] ${E}7m[Opt in]${E}0m │`)).toBe(false)
    expect(optOutSelected('│ [Opt out] [Opt in] │')).toBeNull()
    expect(optOutSelected(`│ ${E}7m[Opt out] [Opt in]${E}0m │`)).toBeNull()
    expect(optOutSelected('> type here')).toBeNull()
  })
})

describe('wiring (static)', () => {
  const grok = src('telegram-grok')
  const relay = src('telegram-grok', 'hooks/notification-relay.ts')
  const fnBody = (s: string, name: string) => {
    const i = s.indexOf(`function ${name}(`)
    expect(i).toBeGreaterThan(-1)
    return s.slice(i, s.indexOf('\n}\n', i))
  }

  test('the stall classifier checks the plan before the generic quota and unknown branches', () => {
    const d = fnBody(grok, 'detectStallCause')
    const plan = d.indexOf('planUsedUp(tail)')
    expect(plan).toBeGreaterThan(-1)
    expect(plan).toBeLessThan(d.indexOf('quota reached'))
    expect(plan).toBeLessThan(d.indexOf('cause unknown'))
  })

  test('the stall alert for a used-up plan is the plain line, claimed once, with no /restart', () => {
    const a = fnBody(grok, 'sendStallAlert')
    expect(a).toMatch(/plan \? planUsedUpText\(name, _lastPane\)/)
    expect(a).toMatch(/const notify = !plan \|\| claimPlanNotice\(STATE_DIR\)/)
    expect(a).toMatch(/for \(const id of notify \? owners : \[\]\)/)
  })

  test('the stall auto-reply says it in plain words too', () => {
    expect(fnBody(grok, 'enqueueInbound')).toMatch(/cause === PLAN_USED_UP_CAUSE \? planUsedUpText\(agentName\(\), _lastPane\)/)
  })

  test('recovery clears the marker', () => {
    expect(fnBody(grok, 'clearStallAlert')).toMatch(/clearPlanNotice\(STATE_DIR\)/)
  })

  test('the 402 relay sends the plain line once and is otherwise quiet', () => {
    expect(relay).toMatch(/if \(planUsedUp\(text\)\) \{\n  if \(!claimPlanNotice\(STATE_DIR\)\) exitContinue\(\)/)
    expect(relay).toMatch(/body = planUsedUpText\(/)
  })

  test('the box is answered with Enter only when Opt out is selected, else dismissed', () => {
    const b = fnBody(grok, 'answerOptInBox')
    expect(b).toMatch(/optOutSelected\(styled\) === true \? 'Enter' : 'X'/)
    expect(grok).toMatch(/\nstartOptInWatch\(\)\n/)
  })

  test('no other runtime acts on Grok\'s words (agy is rendered with it off)', () => {
    expect(src('telegram-agy', 'plan-limit.ts')).toMatch(/export const PLAN_ON = false/)
    expect(src('telegram-codex')).not.toMatch(/planUsedUp/)
  })
})

describe('the relay hook, run for real', () => {
  // Telegram is never reached: no TELEGRAM_BOT_TOKEN means the hook exits before
  // sending, so this checks the claim ordering is after the token/recipient checks.
  test('a 402 with no bot token does not burn the once-per-hit claim', () => {
    const d = mkdtempSync(join(tmpdir(), 'dive7565-hook-'))
    const r = spawnSync('bun', [join(PLUGINS, 'telegram-grok', 'hooks', 'notification-relay.ts')], {
      input: JSON.stringify({ message: RELAY_LINE }),
      env: { PATH: process.env.PATH ?? '', HOME: d, TELEGRAM_STATE_DIR: d, FIVE_LOCAL_ONLY_FILE: join(d, 'absent') },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"continue":true')
    expect(existsSync(join(d, PLAN_NOTICE_FILE))).toBe(false)
    rmSync(d, { recursive: true })
  })
})
