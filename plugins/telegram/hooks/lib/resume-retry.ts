// DIVE-4628: Phase 3's retry loop, lifted out of resume-after-reset.ts so it
// can be graded without waiting out real back-offs.
//
// It was a `while (elapsed < 6h)` around `attemptResume()` with a fixed 300s
// sleep — time-bounded only. When the resume VERIFICATION is broken (it polled
// a transcript the session had rotated away from, so the answer was always
// "did not pick up"), a time-only bound is 72 `continue` injections into a live
// seat, each one a fresh assistant turn with the seat's whole context re-sent.
// Seven of them landed on olivia before a human noticed.
//
// So the bound is now BOTH: attempts and time, whichever trips first, and the
// caller is told WHICH — the paired human reading "couldn't auto-resume" needs
// to know if we ran out of tries or out of clock.

import { MONTHLY_MAX_AHEAD_S } from './time'

export type RetryDeps = {
  // One resume attempt: type the prompt and watch for a confirmed pick-up.
  attempt: () => Promise<boolean>
  // A reset time just learned from the live pane, as seconds from now, or null.
  // Honoured instead of the back-off when it is inside the trusted window.
  learnedWaitSec: () => number | null
  sleep: (ms: number) => Promise<void>
  nowSec: () => number
  log: (msg: string) => void
}

export type RetryLimits = {
  maxRetrySec: number
  maxAttempts: number
  intervalSec: number
  intervalMaxSec: number
  maxWaitSec: number
}

export type RetryOutcome = {
  resumed: boolean
  attempts: number
  // '' while resumed; otherwise which bound ended it.
  giveUp: '' | 'attempts' | 'time'
}

// Doubling back-off, so the attempt cap costs almost no REACH: 6 attempts at
// 5/10/20/40/60m span ~2.3h, against the old fixed 5m which spent 72 injections
// to cover 6h. Far fewer wake-ups, nearly the same window.
export function backoffSec(attempt: number, limits: RetryLimits): number {
  return Math.min(limits.intervalSec * 2 ** (attempt - 1), limits.intervalMaxSec)
}

export async function retryResume(deps: RetryDeps, limits: RetryLimits): Promise<RetryOutcome> {
  const start = deps.nowSec()
  let attempts = 0
  while (deps.nowSec() - start < limits.maxRetrySec) {
    attempts++
    if (await deps.attempt()) {
      deps.log(`phase3 resume confirmed on attempt ${attempts}`)
      return { resumed: true, attempts, giveUp: '' }
    }
    // The cap is checked AFTER the miss and BEFORE the sleep on purpose: the
    // last attempt must not make the human wait out one more hour of back-off
    // before the "I gave up" ping goes out.
    if (attempts >= limits.maxAttempts) {
      deps.log(`phase3 giving up after ${attempts} attempts (cap ${limits.maxAttempts})`)
      return { resumed: false, attempts, giveUp: 'attempts' }
    }
    // Still limited. If the live pane revealed a parseable reset time, wait
    // precisely for it; otherwise back off and try again.
    const learned = deps.learnedWaitSec()
    if (learned !== null && learned > 0 && learned <= limits.maxWaitSec) {
      deps.log(`phase3 still limited; learned reset, sleeping ${learned + 30}s`)
      await deps.sleep((learned + 30) * 1000)
    } else {
      const wait = backoffSec(attempts, limits)
      deps.log(`phase3 attempt ${attempts}/${limits.maxAttempts} still limited; retrying in ${wait}s`)
      await deps.sleep(wait * 1000)
    }
  }
  deps.log(`phase3 giving up after ${Math.round(limits.maxRetrySec / 3600)}h of retries`)
  return { resumed: false, attempts, giveUp: 'time' }
}

// DIVE-8374: Phase 2's decision — wait for the printed reset, or not — lifted
// out of resume-after-reset.ts so the window can be graded without a real wait.
//
// The window was 30h, sized for the 5-hour wall plus a weekly cap that resets
// within a day. A weekly wall prints a DATE up to 7 days out (`resets Nov 17,
// 8am`), and every such epoch over 30h away was called untrustworthy: the helper
// skipped the wait and typed `continue` at 5, 10, 20… minutes into a wall that
// had days left (Anton, 2026-11-13). Eight days is the same bound the parser
// already puts on a dated reset (DATED_MAX_AHEAD_S in lib/time.ts): anything
// further out is a stale or mis-parsed line, not this wall.
export const MAX_RESET_WAIT_SEC = 8 * 86400
// DIVE-9420: a monthly quota (Qwen's `token-plan 1-month quota … reset at 12-12
// 16:00:00 UTC`) resets up to a month out. The parser accepts such a date only
// on a line that names a monthly quota (MONTHLY_MAX_AHEAD_S in lib/time.ts), and
// the hook tells the helper so; the wait trusts the same bound.
export const MONTHLY_RESET_WAIT_SEC = MONTHLY_MAX_AHEAD_S

export type WaitPlan =
  // A reset in the trusted window: sleep this long (reset + 30s buffer), then resume.
  | { kind: 'wait'; sec: number }
  // An epoch we were given but do not trust (past, or beyond the window).
  | { kind: 'untrusted'; delta: number }
  // No epoch at all: the DIVE-122 blind park-hold.
  | { kind: 'blind' }

// `monthly`: the reset came from a line naming a monthly quota. Its window is a
// month, and a monthly reset outside it goes to the blind park-hold, never to
// `untrusted`: that path types `continue` at 5, 10, 20… minutes into a wall with
// weeks left (DIVE-8374's shape).
export function planWait(
  resetEpoch: number,
  nowSec: number,
  maxWaitSec: number = MAX_RESET_WAIT_SEC,
  monthly: boolean = false,
): WaitPlan {
  if (!(resetEpoch > 0)) return { kind: 'blind' }
  const delta = resetEpoch - nowSec
  const window = monthly ? Math.max(maxWaitSec, MONTHLY_RESET_WAIT_SEC) : maxWaitSec
  if (delta > 0 && delta <= window) return { kind: 'wait', sec: delta + 30 }
  if (monthly) return { kind: 'blind' }
  return { kind: 'untrusted', delta }
}
