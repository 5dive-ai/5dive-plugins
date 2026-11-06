// DIVE-7748 — a weekly wall's reset is a DATE, and it is the one `--wall` gets.
//
// teal-fox 2026-11-04 (sig eb0828bff50e): a seat's turn ended on `You've hit
// your weekly limit · resets Nov 9, 5am (Europe/Nicosia)` (2026-11-09T03:00Z),
// and the StopFailure hook ran `agent rotation rotate <seat> --wall=1793842800`
// (2026-11-05T01:40Z). Two defects, both in the shared hook lib:
//   - parseResetEpoch had no date handling: `resets Nov 9, 5am` read as the next
//     5am, under a day out.
//   - resolveResetEpoch stopped at the first clock time anywhere in the
//     transcript window, and in a session full of 5-hour `resets 10:40pm` lines
//     that was not the wall the turn ended on.
// Every arm pins the clock (setSystemTime), so on the pre-fix tree they fail for
// the reason above and not because of today's date.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseResetEpoch } from '../plugins/telegram/hooks/lib/time.ts'
import { resolveResetEpoch } from '../plugins/telegram/hooks/lib/failure.ts'
import { readEntries } from '../plugins/telegram/hooks/lib/transcript.ts'

const NOW = Date.parse('2026-11-04T20:50:00Z')
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const WEEKLY = "You've hit your weekly limit · resets Nov 9, 5am (Europe/Nicosia)"
const WEEKLY_RESET = at('2026-11-09T03:00:00Z') // 05:00 in Nicosia (EET, UTC+2)

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

describe('parseResetEpoch reads a dated reset as that date', () => {
  test('criterion 1: the weekly wall line → 2026-11-09 05:00 Europe/Nicosia (03:00Z)', () => {
    expect(parseResetEpoch(WEEKLY, NOW)).toBe(WEEKLY_RESET)
    expect(parseResetEpoch(WEEKLY)).toBe(WEEKLY_RESET) // the hook's call: no now passed
  })

  test('other printed shapes: minutes, full month name, "at", 24h clock, UTC', () => {
    expect(parseResetEpoch('resets Nov 9, 4:30pm (UTC)', NOW)).toBe(at('2026-11-09T16:30:00Z'))
    expect(parseResetEpoch('resets November 6, 12am (UTC)', NOW)).toBe(at('2026-11-06T00:00:00Z'))
    expect(parseResetEpoch('resets Nov 10 at 17:00 (UTC)', NOW)).toBe(at('2026-11-10T17:00:00Z'))
  })

  test('a dated reset wins over the `continuing automatically at` clock beside it', () => {
    const banner = `${WEEKLY}\n  continuing automatically at 5am`
    expect(parseResetEpoch(banner, NOW)).toBe(WEEKLY_RESET)
  })

  test('criterion 3: `resets Jan 2` read in late December lands in the next year', () => {
    const dec30 = Date.parse('2026-12-30T10:00:00Z')
    setSystemTime(new Date(dec30))
    expect(parseResetEpoch("You've hit your weekly limit · resets Jan 2, 4pm (UTC)", dec30)).toBe(at('2027-01-02T16:00:00Z'))
  })

  test('a date that is not a wall in force is unknown (null), never a months-long park or the next clock', () => {
    // Past (yesterday) — the clock path would have read "tomorrow 9am".
    expect(parseResetEpoch('resets Nov 3, 9am (UTC)', NOW)).toBe(null)
    // More than 8 days out — a stale or quoted line, not this wall.
    expect(parseResetEpoch('resets Mar 1, 9am (UTC)', NOW)).toBe(null)
    // A day the month does not have.
    expect(parseResetEpoch('resets Feb 30, 9am (UTC)', NOW)).toBe(null)
  })

  test('criterion 5: a bare 5-hour clock still parses exactly as before', () => {
    // 10:40pm Nicosia is 20:40Z; at 20:50Z that has passed → tomorrow.
    expect(parseResetEpoch('resets 10:40pm (Europe/Nicosia)', NOW)).toBe(at('2026-11-05T20:40:00Z'))
    expect(parseResetEpoch("You've hit your limit · resets 10:40pm (UTC)", NOW)).toBe(at('2026-11-04T22:40:00Z'))
    expect(parseResetEpoch('resets 9am (UTC)', NOW)).toBe(at('2026-11-05T09:00:00Z'))
    expect(parseResetEpoch('resets at 21:00 UTC', NOW)).toBe(at('2026-11-04T21:00:00Z'))
    expect(parseResetEpoch('try again in 2h 30m', NOW)).toBe(at('2026-11-04T23:20:00Z'))
    expect(parseResetEpoch('1793842800', NOW)).toBe(1793842800)
  })

  test('a late-evening clock east of UTC lands today, not a day late', () => {
    // 11pm Nicosia = 21:00Z, ten minutes from now. The old clock-only offset
    // read 01:00 at the 23:00Z candidate as a +22h drift → 2026-11-05T21:00Z.
    expect(parseResetEpoch('resets 11pm (Europe/Nicosia)', NOW)).toBe(at('2026-11-04T21:00:00Z'))
  })
})

// ── resolveResetEpoch: the value stopfailure-notify passes as `--wall` ─────────
// (stopfailure-notify.ts: `resolved.resetEpoch` → tryRotate(resetEpoch) →
// wallRotate(…, `--wall=${resetEpoch}`); dive6121-wall-rotate pins that route.)

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dive7748-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const line = (e: unknown) => JSON.stringify(e) + '\n'
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })
const said = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const wall = (text: string) =>
  line({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text }] } })
// The seat's own prose about earlier 5-hour walls — the shape that filled the
// teal-fox transcript (`resets 12:40pm` / `resets 10:40pm`, hundreds of times).
const fiveHourProse = (n: number) =>
  Array.from({ length: n }, (_, i) => said(`Moved off the walled account; it resets ${i % 2 ? '12:40pm' : '10:40pm'} (Europe/Nicosia).`)).join('')

function transcript(body: string): string {
  const p = join(dir, 'session.jsonl')
  writeFileSync(p, body)
  return p
}
const resolve = async (path: string, opts: { msg?: string; pane?: string } = {}) =>
  (await resolveResetEpoch({ transcript_path: path }, opts.msg ?? 'rate_limit', opts.pane ?? '', true, readEntries(path))).resetEpoch

describe('criterion 2: --wall is the reset of the wall the turn ended on', () => {
  test('a tagged weekly wall after earlier 5-hour walls and 5-hour prose → the weekly reset', async () => {
    const p = transcript(
      prompt('earlier turn') + wall("You've hit your limit · resets 10:40pm (Europe/Nicosia)") +
      prompt('next turn') + fiveHourProse(20) + prompt('the turn that walls') + wall(WEEKLY),
    )
    expect(await resolve(p)).toBe(WEEKLY_RESET)
  })

  test('an untagged weekly wall line after 5-hour prose → the weekly reset', async () => {
    const p = transcript(prompt('go') + fiveHourProse(20) + said(WEEKLY))
    expect(await resolve(p)).toBe(WEEKLY_RESET)
  })

  test('the wall line is not written yet at the first read: wait for it, never take an earlier 5-hour clock', async () => {
    // The flush race: the hook fires before Claude Code has written its wall
    // entry. Pre-fix, the first read found `resets 10:40pm` in the seat's prose
    // and stopped there — a 5-hour reset on a weekly wall.
    const p = transcript(prompt('go') + fiveHourProse(20))
    const late = setTimeout(() => appendFileSync(p, wall(WEEKLY)), 700)
    try {
      expect(await resolve(p)).toBe(WEEKLY_RESET)
    } finally {
      clearTimeout(late)
    }
    expect(readFileSync(p, 'utf8')).toContain('weekly limit')
  })

  test('the payload message carrying the weekly wall beats a 5-hour clock in the transcript', async () => {
    const p = transcript(prompt('go') + fiveHourProse(6))
    expect(await resolve(p, { msg: WEEKLY })).toBe(WEEKLY_RESET)
  })

  test('the pane is read for the dated form too', async () => {
    const p = transcript(prompt('go') + said('working on it'))
    expect(await resolve(p, { pane: `  ⎿  ${WEEKLY}\n  /upgrade to increase your usage limit.` })).toBe(WEEKLY_RESET)
  })

  test('no wall line anywhere: a bare 5-hour clock in the window is still the last resort', async () => {
    const p = transcript(prompt('go') + said('Limit hit, it resets 10:40pm (UTC).'))
    expect(await resolve(p)).toBe(at('2026-11-04T22:40:00Z'))
  })

  test('a 5-hour wall still resolves to its own clock', async () => {
    const p = transcript(prompt('go') + fiveHourProse(4) + wall("You've hit your limit · resets 2am (UTC)"))
    expect(await resolve(p)).toBe(at('2026-11-05T02:00:00Z'))
  })
})
