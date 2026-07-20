// DIVE-1503: pinned self-updating "needs-you" banner.
//
// WHY THIS EXISTS: pending human gates are posted as normal Telegram messages,
// so a gate scrolls out of sight the moment newer chatter arrives — the 3rd
// recurrence of the "a gate went unseen" class (DIVE-1428 → DIVE-1489). The fix
// is ONE pinned message per paired DM that always reflects the current backlog:
// pin it when the first gate opens, edit it in place as gates open/clear, unpin
// it at zero. A pinned message survives scroll, so a gate can never fall off the
// bottom of the chat unnoticed.
//
// This module is PURE + import-safe. server.ts long-polls on import (so tests
// can't import it), which is exactly why the decision logic lives here — the
// forks (telegram-grok/codex/agy/pi/opencode) import this same file byte-for-
// byte, and the test suite asserts that identity so a fork can never drift. All
// I/O (reading the inbox, sendMessage/pin/edit/unpin, persisting the message id)
// stays in server.ts; this file only decides WHAT should happen given the
// current gate summary and the previously-pinned state.
//
// v1 scope: armed in personal-bot/polled mode only. In SEND_ONLY one shared
// team-bot fronts several agents (DIVE-249), so a proactive per-agent banner
// timer is deferred to the fork-parity + live-relay-verify follow-up.

export interface NeedSummary {
  count: number
  // "YYYY-MM-DD HH:MM:SS" (UTC) of the oldest pending gate, or null when none.
  oldestCreatedAt: string | null
}

// Persisted per DM chat so we edit the existing pin instead of posting a fresh
// banner every tick (the DIVE-1107 "banner storm" lesson).
export interface BannerState {
  messageId: number
  fingerprint: string
}

export type BannerAction =
  | { kind: 'none' }
  | { kind: 'send'; text: string; fingerprint: string }
  | { kind: 'edit'; messageId: number; text: string; fingerprint: string }
  | { kind: 'unpin'; messageId: number; clearText: string }

// Mirror buildInboxList's filter EXACTLY: a live gate needs a human iff it has a
// need_type and has not been answered. Anything else (plain blocked tasks,
// already-answered gates) must not inflate the banner count.
export function summarizeNeeds(inbox: unknown): NeedSummary {
  const rows = Array.isArray(inbox) ? inbox : []
  let count = 0
  let oldestCreatedAt: string | null = null
  for (const t of rows) {
    if (!t || typeof t !== 'object') continue
    const row = t as Record<string, unknown>
    if (!row.need_type || row.need_answer) continue
    count++
    const c = typeof row.created_at === 'string' ? row.created_at : null
    // Timestamps are fixed-width "YYYY-MM-DD HH:MM:SS", so lexical < is
    // chronological < — no Date parsing needed to find the oldest.
    if (c && (oldestCreatedAt === null || c < oldestCreatedAt)) oldestCreatedAt = c
  }
  return { count, oldestCreatedAt }
}

// Parse a "YYYY-MM-DD HH:MM:SS" UTC stamp to epoch ms (null if unparseable).
export function parseGateTs(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isFinite(ms) ? ms : null
}

// Coarse, monotonic age label. Coarsening bounds how often the banner edits:
// per-minute under an hour, per-hour under a day, per-day beyond — never a
// churny per-second refresh, and it doubles as the freshness key (see
// bannerFingerprint), so the banner re-renders exactly when the label changes.
export function humanizeAge(fromMs: number | null, nowMs: number): string {
  if (fromMs === null) return 'unknown age'
  const secs = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// The pinned banner body. No em-dashes in user-facing copy (lodar hard rule).
export function formatNeedsBanner(summary: NeedSummary, nowMs: number): string {
  const { count } = summary
  const gate = count === 1 ? 'gate needs' : 'gates need'
  const age = humanizeAge(parseGateTs(summary.oldestCreatedAt), nowMs)
  const clearIt = count === 1 ? 'it' : 'them'
  const oldest = summary.oldestCreatedAt ? `, oldest ${age} old` : ''
  return `📌 ${count} ${gate} you${oldest}. Tap /inbox to review and clear ${clearIt}.`
}

// Shown on the (now-unpinned) banner once the backlog drains to zero.
export const BANNER_CLEAR_TEXT = '✅ All caught up. No gates need a human right now.'

// count + oldest + age-label. Changes exactly when the backlog size changes, the
// oldest gate rotates, or its age label rolls over — the three cases that should
// trigger an edit, and no others.
export function bannerFingerprint(summary: NeedSummary, nowMs: number): string {
  const age = humanizeAge(parseGateTs(summary.oldestCreatedAt), nowMs)
  return `${summary.count}|${summary.oldestCreatedAt ?? ''}|${age}`
}

// The whole state machine, as one pure decision. server.ts feeds it the prior
// pin state (or undefined) + the current summary and performs the returned I/O.
export function reconcileBanner(
  prev: BannerState | undefined,
  summary: NeedSummary,
  nowMs: number,
): BannerAction {
  if (summary.count <= 0) {
    return prev ? { kind: 'unpin', messageId: prev.messageId, clearText: BANNER_CLEAR_TEXT } : { kind: 'none' }
  }
  const text = formatNeedsBanner(summary, nowMs)
  const fingerprint = bannerFingerprint(summary, nowMs)
  if (!prev) return { kind: 'send', text, fingerprint }
  if (prev.fingerprint !== fingerprint) return { kind: 'edit', messageId: prev.messageId, text, fingerprint }
  return { kind: 'none' }
}
