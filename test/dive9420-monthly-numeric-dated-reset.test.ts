// DIVE-9420 — a Qwen monthly quota prints a NUMERIC date, and it is read as one.
//
// teal-fox 2026-11-27 (sig e4defe98903d): a seat's turn ended on `API Error:
// Request rejected (429) · Your token-plan 1-month quota has been exhausted. The
// quota will reset at 12-12 16:00:00 UTC.` The hook resolved 1795795200
// (2026-11-27T16:00Z): no dated arm knew `MM-DD`, so the clock path took `16:00`
// as today, and the seat was scheduled to resume 15 days early. The bare
// sentence was worse: the engine's loose Date.parse read it as 2001-12-12. And a
// reset that far out sat past both 8-day bounds (the parser's and planWait's),
// so a fixed parser alone would have turned the 16:00 resume into a poke loop.
// Every arm pins the clock, so on the pre-fix tree they fail for those reasons.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as tgTime from '../plugins/telegram/hooks/lib/time.ts'
import * as dashTime from '../plugins/dashboard/hooks/lib/time.ts'
import * as tgRetry from '../plugins/telegram/hooks/lib/resume-retry.ts'
import * as dashRetry from '../plugins/dashboard/hooks/lib/resume-retry.ts'
import { resolveResetEpoch } from '../plugins/telegram/hooks/lib/failure.ts'

const NOW = Date.parse('2026-11-27T00:57:00Z')
const NOW_S = Math.floor(NOW / 1000)
const D = 86400
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const QWEN =
  'API Error: Request rejected (429) · Your token-plan 1-month quota has been exhausted. The quota will reset at 12-12 16:00:00 UTC.'
const QWEN_BARE = 'The quota will reset at 12-12 16:00:00 UTC.'
const QWEN_RESET = at('2026-12-12T16:00:00Z')

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

// Each arm runs against BOTH copies (telegram + dashboard), so a copy that
// missed the fix fails here and not only on the drift check.
for (const [name, time, retry] of [
  ['telegram', tgTime, tgRetry],
  ['dashboard', dashTime, dashRetry],
] as const) {
  describe(`${name}: a numeric dated monthly reset is that date`, () => {
    test('accept 1: the full 429 line → 2026-12-12T16:00Z, not 16:00 today', () => {
      expect(time.parseResetEpoch(QWEN, NOW)).toBe(QWEN_RESET)
      expect(time.parseResetEpoch(QWEN)).toBe(QWEN_RESET) // the hook's call: no now passed
    })
    test('accept 1: the bare sentence → the same epoch, not 2001', () => {
      expect(time.parseResetEpoch(QWEN_BARE, NOW)).toBe(QWEN_RESET)
    })
    test('accept 2: a monthly line 20 days out → that epoch, and planWait waits', () => {
      const line = 'Your token-plan 1-month quota has been exhausted. The quota will reset at 12-17 09:30 UTC.'
      const want = at('2026-12-17T09:30:00Z')
      expect(want - NOW_S).toBeGreaterThan(20 * D - D) // ~20 days
      expect(time.parseResetEpoch(line, NOW)).toBe(want)
      expect(time.isMonthlyQuota(line)).toBe(true)
      expect(retry.planWait(want, NOW_S, undefined, true)).toEqual({ kind: 'wait', sec: want - NOW_S + 30 })
      // The month-name form also takes the widened bound on a monthly line.
      expect(time.parseResetEpoch('monthly limit reached · resets Dec 12, 4pm (UTC)', NOW)).toBe(QWEN_RESET)
    })
    test('accept 2: a monthly reset is never `untrusted` (that path pokes `continue`)', () => {
      expect(retry.planWait(QWEN_RESET, NOW_S, undefined, true).kind).toBe('wait')
      expect(retry.planWait(NOW_S + 40 * D, NOW_S, undefined, true)).toEqual({ kind: 'blind' })
      expect(retry.planWait(NOW_S - 5, NOW_S, undefined, true)).toEqual({ kind: 'blind' })
      // Not monthly: DIVE-8374's window unchanged.
      expect(retry.planWait(QWEN_RESET, NOW_S)).toEqual({ kind: 'untrusted', delta: QWEN_RESET - NOW_S })
      expect(retry.MAX_RESET_WAIT_SEC).toBe(8 * D)
    })
    test('which lines take the monthly bound', () => {
      expect(time.takesMonthlyBound(QWEN)).toBe(true)
      expect(time.takesMonthlyBound(QWEN_BARE)).toBe(true)
      expect(time.takesMonthlyBound('monthly limit reached · resets Dec 12, 4pm (UTC)')).toBe(true)
      expect(time.takesMonthlyBound('Weekly limit reached · resets at 12-12 16:00 UTC')).toBe(false)
      expect(time.takesMonthlyBound('5-hour limit reached · reset at 12-12 16:00:00 UTC')).toBe(false)
      expect(time.takesMonthlyBound("You've hit your weekly limit · resets Nov 9, 5am (Europe/Nicosia)")).toBe(false)
      expect(time.takesMonthlyBound('resets Dec 12, 4pm (UTC)')).toBe(false)
      expect(time.takesMonthlyBound('resets at 21:00 UTC')).toBe(false)
    })
    test('accept 3: a weekly / 5h line with a numeric date > 8 days out → null', () => {
      expect(time.parseResetEpoch('Weekly limit reached · resets at 12-12 16:00 UTC', NOW)).toBe(null)
      expect(time.parseResetEpoch('5-hour limit reached · reset at 12-12 16:00:00 UTC', NOW)).toBe(null)
      expect(time.parseResetEpoch('resets Dec 12, 4pm (UTC)', NOW)).toBe(null)
      // …but inside 8 days a numeric date still reads, monthly or not.
      expect(time.parseResetEpoch('reset at 12-01 16:00 UTC', NOW)).toBe(at('2026-12-01T16:00:00Z'))
    })
    test('accept 4: the forms that already worked return exactly what they did', () => {
      const pin = Date.parse('2026-11-04T20:50:00Z')
      expect(time.parseResetEpoch('resets 4pm (UTC)', pin)).toBe(at('2026-11-05T16:00:00Z'))
      expect(time.parseResetEpoch('resets at 21:00 UTC', pin)).toBe(at('2026-11-04T21:00:00Z'))
      expect(time.parseResetEpoch('resets Nov 9, 5am (Europe/Nicosia)', pin)).toBe(at('2026-11-09T03:00:00Z'))
      expect(time.parseResetEpoch('1793842800', pin)).toBe(1793842800)
      expect(time.parseResetEpoch('1793842800123', pin)).toBe(1793842800)
      expect(time.parseResetEpoch('2026-12-12T16:00:00Z', pin)).toBe(QWEN_RESET)
    })
    test('accept 5: an ambiguous 07-08 with both readings inside the bound → null', () => {
      const jul7 = Date.parse('2026-07-07T00:00:00Z')
      const line = 'Your 1-month quota has been exhausted. The quota will reset at 07-08 16:00:00 UTC.'
      // Jul 8 is 1.7 days out and Aug 7 31.7: both inside 32 days.
      expect(time.parseResetEpoch(line, jul7)).toBe(null)
      // The bare numeric sentence takes the monthly bound too → still null.
      expect(time.parseResetEpoch('The quota will reset at 07-08 16:00:00 UTC.', jul7)).toBe(null)
      // Only one reading inside (a weekly line, 8-day bound) → that one.
      expect(time.parseResetEpoch('Weekly limit · reset at 07-08 16:00:00 UTC.', jul7)).toBe(at('2026-07-08T16:00:00Z'))
      // One number over 12 is not ambiguous: day-month is the only reading.
      expect(time.parseResetEpoch('The quota will reset at 13-12 16:00 UTC.', NOW)).toBe(at('2026-12-13T16:00:00Z'))
      expect(time.parseResetEpoch('The quota will reset at 29-11 16:00 UTC.', NOW)).toBe(at('2026-11-29T16:00:00Z'))
    })
  })
}

describe('accept 6: both copies carry the fix', () => {
  test('telegram and dashboard time.ts / resume-retry.ts are byte-identical', () => {
    const root = join(import.meta.dir, '..', 'plugins')
    for (const f of ['hooks/lib/time.ts', 'hooks/lib/resume-retry.ts', 'hooks/lib/failure.ts', 'hooks/resume-after-reset.ts']) {
      expect(readFileSync(join(root, 'dashboard', f)).equals(readFileSync(join(root, 'telegram', f)))).toBe(true)
    }
  })
})

describe('resolveResetEpoch tells the hook the reset is monthly', () => {
  test('the Qwen 429 message → the dated epoch and monthly=true', async () => {
    const r = await resolveResetEpoch({}, QWEN, '', true, [])
    expect(r.resetEpoch).toBe(QWEN_RESET)
    expect(r.monthly).toBe(true)
  })
  test('the bare sentence → the dated epoch and monthly=true', async () => {
    const r = await resolveResetEpoch({}, QWEN_BARE, '', true, [])
    expect(r.resetEpoch).toBe(QWEN_RESET)
    expect(r.monthly).toBe(true)
  })
  test('a 5-hour wall → monthly=false', async () => {
    const r = await resolveResetEpoch({}, "You've hit your limit · resets 4pm (UTC)", '', true, [])
    expect(r.resetEpoch).toBe(at('2026-11-27T16:00:00Z'))
    expect(r.monthly).toBe(false)
  })
})
