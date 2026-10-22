// What kind of StopFailure this is, and when a usage limit lifts. Lifted out of
// stopfailure-notify.ts (DIVE-6714) so the dashboard plugin's StopFailure hook
// reads a failure exactly the way this one does: it runs a byte-identical copy
// of this file (plugins/dashboard/hooks/SHARED.txt), so the two channels cannot
// disagree about whether an agent hit its limit or a server blip.

import { readEntries, findRateLimitText } from './transcript'
import { parseResetEpoch } from './time'
import { isTermsWall } from './terms'
import type { HookPayload, TranscriptEntry } from './types'

export type FailureKind = {
  /** A 429 that says it is NOT a usage limit ("temporarily limiting requests"). */
  isTransientRateLimit: boolean
  /** A real 5h/7d usage limit (the caller may still reclassify a burst). */
  isRateLimit: boolean
  /** DIVE-6678: Claude wants its updated terms accepted. Not a limit, not a blip. */
  isTermsNotAccepted: boolean
  /** Overloaded / 5xx (or the transient 429 above): self-clears on retry. */
  isTransientApiError: boolean
}

// A transient server-side 429 ("Server is temporarily limiting requests · Rate
// limited") is explicitly NOT a usage limit — but its text literally contains
// the substring "usage limit" (in the phrase "not your usage limit"), so the
// naive usage-limit regex would match it and report a bogus "usage limit hit —
// couldn't read the reset time" (there's no reset epoch on a transient
// throttle). The transient phrasing is detected first and excluded.
//
// Transient API error (NOT a usage limit): claude exhausted its built-in
// retries on an Overloaded / 5xx response, aborted the turn, and dropped back
// to an idle prompt — no "Stop and wait" menu, no reset epoch. Matched on the
// API status line in the pane ("API Error: Overloaded", "API Error: 529 …") and
// the raw payload ("overloaded_error" etc).
export function classifyFailure(payload: HookPayload, raw: string, pane: string): FailureKind {
  const isTransientRateLimit = /not your usage limit|temporarily limiting requests/i.test(raw)
  const isTermsNotAccepted = isTermsWall(payload, pane)
  const isRateLimit = !isTermsNotAccepted && !isTransientRateLimit && /rate_limit|usage.limit/i.test(raw)
  const isTransientApiError =
    !isRateLimit &&
    !isTermsNotAccepted &&
    (isTransientRateLimit ||
      /overloaded|API Error:\s*(?:5(?:0[234]|29))\b|"type":\s*"(?:overloaded|api)_error"/i.test(`${raw}\n${pane}`))
  return { isTransientRateLimit, isRateLimit, isTermsNotAccepted, isTransientApiError }
}

/** The payload's own text fields, joined — the hook's one-line `msg`. */
export function failureMessage(payload: HookPayload): string {
  return [payload.message, payload.reason, typeof payload.error === 'string' ? payload.error : undefined, payload.stopReason]
    .filter(Boolean)
    .join(' | ') || 'no details'
}

// Resolve an unlock/reset epoch. Order: payload → transcript → message text → pane.
//
// Not the pane first: when claude shows the "Stop and wait" menu, the pane
// switches to the alternate screen and the preceding "resets Xpm (TZ)" line
// disappears from `tmux capture-pane`. The transcript captures that line as a
// structured synthetic message (error="rate_limit", isApiErrorMessage=true).
//
// The synthetic rate-limit entry is written ~concurrently with the hook firing,
// so the first read can miss it (flush race). findRateLimitText is bounded to
// recent entries, so a miss returns null rather than reusing a stale earlier
// episode's reset line — so a usage limit re-reads the transcript a few times
// over ~2s. Other failures don't retry (no extra latency). Returns the entries
// as last read, which the caller routes on.
export async function resolveResetEpoch(
  payload: HookPayload,
  msg: string,
  pane: string,
  isRateLimit: boolean,
  entries: TranscriptEntry[],
): Promise<{ resetEpoch: number | null; entries: TranscriptEntry[] }> {
  let resetEpoch: number | null = null
  const resetRaw =
    (payload.resetsAt as number | string | undefined) ??
    (payload.reset_at as number | string | undefined) ??
    (payload.resetAt as number | string | undefined) ??
    (typeof payload.error === 'object' && payload.error?.resetsAt) ??
    payload.rateLimit?.resetsAt
  if (resetRaw !== undefined && resetRaw !== null) resetEpoch = parseResetEpoch(String(resetRaw))

  const transcriptPath = payload.transcript_path
  if (resetEpoch === null && transcriptPath) {
    const tries = isRateLimit ? 5 : 1
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 500))
        entries = readEntries(transcriptPath)
      }
      const transcriptResetText = findRateLimitText(entries)
      if (transcriptResetText) {
        const e = parseResetEpoch(transcriptResetText)
        if (e !== null) {
          resetEpoch = e
          break
        }
      }
    }
  }
  if (resetEpoch === null) resetEpoch = parseResetEpoch(msg)
  if (resetEpoch === null && pane) {
    const line = pane.split('\n').find(l => /resets?\s+\d/i.test(l))
    if (line) resetEpoch = parseResetEpoch(line)
  }
  return { resetEpoch, entries }
}
