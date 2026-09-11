// DIVE-4276: a reaction or an edit counts as contact — the silence watchdog
// must stop nagging a seat that has already acknowledged.
//
// THE BUG (measured on main 2026-09-11 04:39-04:40Z, telegram 0.5.50): the seat
// reacted 👍 to an acknowledgement-only inbound, which is exactly what the house
// rules ask for ("never reply to an acknowledgement"). The very next PostToolUse
// fired "You've gone 275s and 11 tool calls without sending a Telegram
// message ... Send a fresh reply". Cause: the watchdog's clock was lastReplyAt,
// and ONLY the `reply` tool stamped it — `react` stamped nothing and
// `edit_message` stamped lastReplyAt, which is the opposite error (it marked a
// newer, still-unanswered inbound as answered).
//
// The fix splits the two meanings. This suite locks BOTH halves:
//   1. BEHAVIOR — decideNag() reads lastContactAt for the clock and lastReplyAt
//      for "is the newest inbound answered", including the negative arm (real
//      silence still fires) and the back-compat arm (old state files).
//   2. WIRING — server.ts's react/edit_message handlers actually call the right
//      marker, so a refactor that reverts to the single stamp reds CI even if
//      decideNag is fine. Static parse: importing the server long-polls Telegram.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideNag } from '../plugins/telegram/hooks/lib/silence-decision'
import type { SilenceState } from '../plugins/telegram/hooks/lib/types'

const FIRST_FIRE = 60
const NOW = 10_000
// Well past both thresholds, so any arm that stays quiet does so because of the
// contact stamp and not because the clock had not run out.
const SILENT_FOR = 275
const CALLS = 11
// After ANY contact the server resets toolCallsSinceReply, so the hook's next
// read counts from 1. A fresh-contact arm that passed CALLS=11 would be an
// impossible state — and the count trigger (>=5) would fire on it regardless of
// the clock, hiding what the arm means to show.
const CALLS_AFTER_CONTACT = 1

const inbound = (at: number): Partial<SilenceState> => ({ lastInboundAt: at })

describe('decideNag: the clock runs on CONTACT, not on replies alone', () => {
  test('reply resets the clock (baseline — never regressed, locked anyway)', () => {
    const d = decideNag(
      { ...inbound(NOW - 300), lastReplyAt: NOW - 5, lastContactAt: NOW - 5, lastReminderAt: NOW - 200 },
      NOW, FIRST_FIRE, 1,
    )
    expect(d.shouldFire).toBe(false)
    expect(d.sinceContact).toBe(5)
  })

  test('THE BUG: react on the latest inbound → no nag (reply+contact stamped)', () => {
    const d = decideNag(
      { ...inbound(NOW - 300), lastReplyAt: NOW - 5, lastContactAt: NOW - 5, lastReminderAt: NOW - 200 },
      NOW, FIRST_FIRE, CALLS_AFTER_CONTACT,
    )
    expect(d.shouldFire).toBe(false)
    expect(d.unansweredInbound).toBe(false)
  })

  test('edit_message resets the CLOCK ONLY — quiet, but the inbound stays unanswered', () => {
    // Inbound arrived AFTER the last reply; an edit of an older message cannot
    // have answered it, so unansweredInbound must survive the edit.
    const d = decideNag(
      { lastInboundAt: NOW - 100, lastReplyAt: NOW - 400, lastContactAt: NOW - 5, lastReminderAt: NOW - 200 },
      NOW, FIRST_FIRE, CALLS_AFTER_CONTACT,
    )
    expect(d.shouldFire).toBe(false)
    expect(d.unansweredInbound).toBe(true)
  })

  test('NEGATIVE ARM: inbound then nothing at all still fires after the threshold', () => {
    const d = decideNag(inbound(NOW - SILENT_FOR), NOW, FIRST_FIRE, CALLS)
    expect(d.shouldFire).toBe(true)
    expect(d.sinceContact).toBe(SILENT_FOR)
    expect(d.unansweredInbound).toBe(true)
  })

  test('NEGATIVE ARM: contact that is itself stale still fires', () => {
    const d = decideNag(
      { ...inbound(NOW - 600), lastContactAt: NOW - SILENT_FOR, lastReplyAt: NOW - 600 },
      NOW, FIRST_FIRE, CALLS,
    )
    expect(d.shouldFire).toBe(true)
  })

  test('a mutation that drops lastContactAt from the clock reds this arm', () => {
    // Same state as the react arm, minus the contact stamp: proves the quiet
    // above comes from lastContactAt and not from some other branch.
    const d = decideNag(
      { ...inbound(NOW - 300), lastReplyAt: NOW - 400, lastReminderAt: NOW - 350 },
      NOW, FIRST_FIRE, CALLS_AFTER_CONTACT,
    )
    expect(d.shouldFire).toBe(true)
  })

  test('back-compat: pre-DIVE-4276 state (lastReplyAt, no lastContactAt) reads as contact', () => {
    const d = decideNag(
      { ...inbound(NOW - 300), lastReplyAt: NOW - 5, lastReminderAt: NOW - 200 },
      NOW, FIRST_FIRE, CALLS_AFTER_CONTACT,
    )
    expect(d.shouldFire).toBe(false)
    expect(d.lastContact).toBe(NOW - 5)
  })

  test('THE RACE (bug 2): a sibling hook that re-reads after the stamp lands stays quiet', () => {
    // The sibling read pre-reply state (11 calls, contact 275s ago) and would
    // fire; the re-read sees the reply's stamp and its counter reset.
    const stale: SilenceState = { ...inbound(NOW - 400), lastContactAt: NOW - SILENT_FOR, toolCallsSinceReply: CALLS - 1 }
    expect(decideNag(stale, NOW, FIRST_FIRE, CALLS).shouldFire).toBe(true)
    const settled: SilenceState = { ...inbound(NOW - 400), lastReplyAt: NOW, lastContactAt: NOW, toolCallsSinceReply: 0 }
    expect(decideNag(settled, NOW, FIRST_FIRE, (settled.toolCallsSinceReply ?? 0) + 1).shouldFire).toBe(false)
  })

  test('out of conversation (no inbound in the last hour) never fires', () => {
    expect(decideNag(inbound(NOW - 4000), NOW, FIRST_FIRE, CALLS).shouldFire).toBe(false)
    expect(decideNag({}, NOW, FIRST_FIRE, CALLS).shouldFire).toBe(false)
  })
})

describe('WIRING: the server stamps the right one at each site', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'),
    'utf8',
  )
  const caseBody = (name: string): string => {
    const start = src.indexOf(`case '${name}': {`)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf("      case '", start + 10))
  }

  test('react stamps contact, and the reply stamp only on the latest inbound', () => {
    const body = caseBody('react')
    expect(body).toContain('isLatestInbound(')
    expect(body).toContain('markReplySent()')
    expect(body).toContain('markContact()')
  })

  test('edit_message stamps contact only — never the reply stamp', () => {
    const body = caseBody('edit_message')
    expect(body).toContain('markContact()')
    expect(body).not.toContain('markReplySent()')
  })

  test('reply still stamps the reply, and markReplySent stamps both clocks', () => {
    expect(caseBody('reply')).toContain('markReplySent()')
    const fn = src.slice(src.indexOf('function markReplySent'), src.indexOf('function isLatestInbound'))
    expect(fn).toContain('lastReplyAt: now')
    expect(fn).toContain('lastContactAt: now')
  })

  test('the watchdog reads the shared decision, not its own inline clock', () => {
    const hook = readFileSync(
      join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'silence-watchdog.ts'),
      'utf8',
    )
    expect(hook).toContain('decideNag(')
    // and it re-reads before emitting, so the parallel-batch race is closed
    expect(hook).toMatch(/if \(shouldFire\) \{\n\s*fresh = loadSilence\(\)/)
    expect(hook).not.toMatch(/const\s+sinceReply\s*=\s*0/)
  })
})
