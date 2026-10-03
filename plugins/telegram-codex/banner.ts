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
// forks (grok/codex/agy/pi/opencode) import this same file byte-for-
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
//
// DIVE-2041 — ANSWERED IS `need_answered_at`, NOT `need_answer`. The CLI and the
// dashboard both key on need_answered_at (see gatereply.ts / tna.ts here, and
// taskNeedsHuman() on the dashboard); this filter keyed on need_answer, the
// answer TEXT. Those differ for a whole gate type: an answered SECRET gate keeps
// need_answer NULL by design, because the value is the secret and is never
// stored on the row. So a secret gate that a human HAS answered reads as still
// pending to this predicate.
//
// It is harmless today only because the one caller feeds it `task inbox --json`,
// whose SQL already excludes answered rows — i.e. the correctness lives in a
// query two processes away, and the "mirror EXACTLY" contract above is the only
// thing holding it. Any future caller handing this an unfiltered list (a `task
// ls --all` payload, a cached inbox, a test fixture) silently over-counts, and
// an over-counted banner is a pinned message asserting work that is already
// done. Keyed on the CLI's own column, this module is correct on ANY list.
//
// need_answer stays in the disjunction as a belt-and-braces: withdraw NULLs
// need_answer/at/by together (tna.ts), so the two can never disagree in the
// direction that would over-count — the OR can only ever exclude MORE.
// buildInboxList in server.ts is fixed the same way in this change, so the
// mirror the comment claims is a mirror again rather than a shared defect.
export function summarizeNeeds(inbox: unknown): NeedSummary {
  const rows = Array.isArray(inbox) ? inbox : []
  let count = 0
  let oldestCreatedAt: string | null = null
  for (const t of rows) {
    if (!t || typeof t !== 'object') continue
    const row = t as Record<string, unknown>
    if (!row.need_type || row.need_answered_at || row.need_answer) continue
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

// DIVE-5447 — THE BANNER IS OFF UNLESS A SEAT OPTS IN.
//
// lodar, 2026-10-03: "Let's disable inbox pinning because it feels too noisy."
// The gate alerts, /inbox and the dashboard stay; only the proactive pin goes.
// The code stays behind TELEGRAM_NEEDS_BANNER=1 (the seat's telegram connector
// env or its channel .env) so it can come back without a rewrite. Off also
// silences the DIVE-2041 "SUPPRESSED FLEET-WIDE" line: it is only ever printed
// from inside the reconcile tick, and with the switch off no tick runs.
//
// Off is not just "stop pinning": every DM that already carries a pin would keep
// it forever, because the only code that ever unpinned was the tick being turned
// off. So when the switch is off, the bot retires what its store remembers ONCE
// at boot (retireBannerStore below) and writes back only what it could not reach.
export const NEEDS_BANNER_ENV = 'TELEGRAM_NEEDS_BANNER'
export const NEEDS_BANNER_FIRST_MS = 3000
export const NEEDS_BANNER_EVERY_MS = 60_000

export function needsBannerEnabled(env: Record<string, string | undefined>): boolean {
  return env[NEEDS_BANNER_ENV] === '1'
}

export interface BannerTimers {
  setTimeout(fn: () => void, ms: number): { unref?(): unknown }
  setInterval(fn: () => void, ms: number): { unref?(): unknown }
}

// The one place the banner's timers are armed. Opted in: the DIVE-1503 cadence
// (first tick deferred so the bot and access.json are settled, then every 60s).
// Off: no interval at all, one deferred retire. Timers are injected so a test can
// count them instead of trusting a comment.
export function armNeedsBanner(
  env: Record<string, string | undefined>,
  run: { reconcile: () => Promise<void>; retire: () => Promise<void> },
  timers: BannerTimers = globalThis as unknown as BannerTimers,
): 'armed' | 'retiring' {
  if (needsBannerEnabled(env)) {
    timers.setTimeout(() => void run.reconcile(), NEEDS_BANNER_FIRST_MS).unref?.()
    timers.setInterval(() => void run.reconcile(), NEEDS_BANNER_EVERY_MS).unref?.()
    return 'armed'
  }
  timers.setTimeout(() => void run.retire(), NEEDS_BANNER_FIRST_MS).unref?.()
  return 'retiring'
}

// What a retired pin is edited to. Not BANNER_CLEAR_TEXT: "all caught up" would
// be a false claim on a DM whose gates are still pending.
export const BANNER_RETIRED_TEXT = 'This pinned reminder is switched off. Tap /inbox to see anything that needs you.'

// Telegram's answers that mean the pinned message no longer exists (or can no
// longer be touched): nothing left to retire, so forget it.
export function isBannerGoneError(err: unknown): boolean {
  const msg = String((err as { description?: unknown })?.description ?? err)
  return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|to unpin not found|chat not found|bot was blocked/i.test(msg)
}

export interface BannerUnpinApi {
  unpinChatMessage(chatId: string, messageId: number): Promise<unknown>
  editMessageText(chatId: string, messageId: number, text: string): Promise<unknown>
}

// Unpin and relabel every remembered banner. Returns the store to write back:
// empty once every pin is gone, so the next boot does nothing. A pin the API
// could not reach for a transient reason (network, 429) is kept for the next boot
// rather than forgotten with the pin still showing. The relabel is best-effort:
// the unpin is the part the owner sees.
export async function retireBannerStore(
  store: Record<string, BannerState>,
  api: BannerUnpinApi,
): Promise<Record<string, BannerState>> {
  const left: Record<string, BannerState> = {}
  for (const [chat, st] of Object.entries(store)) {
    if (!st || typeof st.messageId !== 'number') continue
    try {
      await api.unpinChatMessage(chat, st.messageId)
    } catch (err) {
      if (!isBannerGoneError(err)) left[chat] = st
      continue
    }
    await api.editMessageText(chat, st.messageId, BANNER_RETIRED_TEXT).catch(() => {})
  }
  return left
}
