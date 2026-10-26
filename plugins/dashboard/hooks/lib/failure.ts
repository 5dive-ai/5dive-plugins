// What kind of StopFailure this is, and when a usage limit lifts. Lifted out of
// stopfailure-notify.ts (DIVE-6714) so the dashboard plugin's StopFailure hook
// reads a failure exactly the way this one does: it runs a byte-identical copy
// of this file (plugins/dashboard/hooks/SHARED.txt), so the two channels cannot
// disagree about whether an agent hit its limit or a server blip.

import { readEntries, findRateLimitText } from './transcript'
import { parseResetEpoch } from './time'
import { isTermsWall } from './terms'
import type { HookPayload, TranscriptEntry } from './types'
import type { Lang } from './lite'

export type FailureKind = {
  /** A 429 that says it is NOT a usage limit ("temporarily limiting requests"). */
  isTransientRateLimit: boolean
  /** A real 5h/7d usage limit (the caller may still reclassify a burst). */
  isRateLimit: boolean
  /** DIVE-6678: Claude wants its updated terms accepted. Not a limit, not a blip. */
  isTermsNotAccepted: boolean
  /** Overloaded / 5xx (or the transient 429 above): self-clears on retry. */
  isTransientApiError: boolean
  /** DIVE-6979: the AI account has no money left (402). Nothing lifts it but a top-up. */
  isOutOfCredit: boolean
}

// DIVE-6979: an exhausted balance. The OpenRouter texts seen live (DIVE-6833):
// "API Error: 402 This request requires at least $0.50 in balance" and "... would
// exceed your available credits given your current in-flight requests"; also its
// "requires more credits" 402, Anthropic's "credit balance is too low", and
// Claude Code's own billing_error. It has no reset time and retrying cannot clear
// it, so it is never read as a usage limit or a blip, even when the same payload
// also says rate_limit.
const OUT_OF_CREDIT_RE =
  /API Error:\s*402\b|requires at least \$\s?[\d.]+ in balance|exceed your available credits|insufficient credits|requires more credits|credit balance is too low|"error":\s*"billing_error"/i

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
  const isOutOfCredit = !isTermsNotAccepted && OUT_OF_CREDIT_RE.test(`${raw}\n${pane}`)
  const isRateLimit = !isTermsNotAccepted && !isOutOfCredit && !isTransientRateLimit && /rate_limit|usage.limit/i.test(raw)
  const isTransientApiError =
    !isRateLimit &&
    !isTermsNotAccepted &&
    !isOutOfCredit &&
    (isTransientRateLimit ||
      /overloaded|API Error:\s*(?:5(?:0[234]|29))\b|"type":\s*"(?:overloaded|api)_error"/i.test(`${raw}\n${pane}`))
  return { isTransientRateLimit, isRateLimit, isTermsNotAccepted, isTransientApiError, isOutOfCredit }
}

/**
 * DIVE-6979: the one line a chat gets when the AI credit ran out. A partner's
 * client (lite) does not pay for it, so it hears that the people who do were
 * told (the API's balance watch tells them). Anyone else is the box owner, who
 * pays for the account the agent runs on, so it is theirs to top up.
 */
export const CREDIT_NOTICE: Record<'client' | 'owner', Record<Lang, string>> = {
  client: {
    en: "My AI credit ran out. The team has been told; I'll answer as soon as it's topped up.",
    ru: 'У меня закончился баланс ИИ. Команде уже сообщили — отвечу, как только его пополнят.',
  },
  owner: {
    en: "My AI credit ran out, so I stopped. Top up the AI account I run on and I'll answer.",
    ru: 'У меня закончился баланс ИИ, поэтому я остановился. Пополните аккаунт ИИ, на котором я работаю, и я отвечу.',
  },
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
