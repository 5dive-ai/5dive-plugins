#!/usr/bin/env -S bun
// Stop hook: DIVE-114 context carry-over nudge.
//
// "Context rot" — degraded reasoning as the window fills — sets in around
// ~40% on a 1M window. Rather than let a session silently coast into a deep,
// expensive, lower-quality state, this hook watches the live context-usage %
// and, at a natural break (turn end), drops a SUBTLE nudge with a one-tap
// "Carry over" button so the user can spin up a fresh session that loads a
// structured carryover (see the /carryover command + ho: callback in server.ts).
//
// Tiers (each fires AT MOST ONCE per session, escalating only if ignored):
//   45% → first nudge (rot onset; cleanest, cheapest moment to hand off)
//   60% → firmer reminder, only if 45% was ignored
//   75% → last call, only if still ignored — then it goes quiet for good
//
// Anti-spam is the whole point. We fire only the HIGHEST not-yet-fired tier
// the current usage has crossed, and record it; lower tiers are marked
// consumed so a single big jump (0→65%) shows one message, not a backlog.
// Normal session: one nudge at 45%. The button makes acting on it one tap.
//
// Context % source: the statusline cache (~/.claude/statusline-last.json),
// which claude refreshes every turn with context_window.used_percentage —
// the same on-disk payload /status already reads for rate limits. No new
// plumbing, and it degrades to a clean no-op on older claude builds that
// don't emit context_window.

import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { readEntries } from './lib/transcript'
import { getToken } from './lib/telegram'
import { getAllowedChatIds, getCallerChat, type CallerChat } from './lib/access'
import type { HookPayload } from './lib/types'

// Tier thresholds (percent of context window used) in ascending order, each
// with the copy shown when it fires. Order matters: we walk high→low to find
// the most relevant crossed tier.
const TIERS: { at: number; text: string }[] = [
  { at: 45, text: "Context's at ~45% — good spot to carry over to a fresh session. Tap to save, or keep going." },
  { at: 60, text: "Context's at ~60% — quality starts slipping here. Carrying over keeps things sharp." },
  { at: 75, text: "Context's at ~75% — getting heavy. Strongly suggest carrying over now. Last nudge this session." },
]

const payload = await readPayload<HookPayload>()

// Re-entry from a blocked Stop (stop-reply-check) isn't a fresh natural break —
// skip so the nudge only ever rides a clean turn end.
if (payload.stop_hook_active === true) process.exit(0)
if (!getToken()) process.exit(0)

// --- Read live context usage from the statusline cache ----------------------
type StatuslineCache = {
  session_id?: string
  context_window?: { used_percentage?: number }
}
const cachePath = join(homedir(), '.claude', 'statusline-last.json')
if (!existsSync(cachePath)) process.exit(0)
let cache: StatuslineCache
try {
  cache = JSON.parse(readFileSync(cachePath, 'utf8'))
} catch {
  process.exit(0)
}
const usedPct = cache.context_window?.used_percentage
if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) process.exit(0)

// Highest tier the current usage has crossed. Below the first tier → nothing.
let crossed: { at: number; text: string } | null = null
for (let i = TIERS.length - 1; i >= 0; i--) {
  if (usedPct >= TIERS[i]!.at) {
    crossed = TIERS[i]!
    break
  }
}
if (!crossed) process.exit(0)

// --- Per-session dedupe: store the max tier already fired --------------------
// Key on session_id when present (survives transcript-path quirks), else the
// transcript path. A fresh session (post-carryover /clear or new run) gets a new
// id → the nudge cycle resets, which is exactly what we want.
const sessionKey = cache.session_id || payload.transcript_path || 'unknown'
const stateFile = join(tmpdir(), `5dive-ctx-nudge-${createHash('sha1').update(sessionKey).digest('hex')}.txt`)
let maxFired = 0
try {
  maxFired = parseInt(readFileSync(stateFile, 'utf8').trim(), 10) || 0
} catch {
  // first time this session
}
// Already nudged at this tier (or a higher one) → stay quiet.
if (crossed.at <= maxFired) process.exit(0)

// --- Pick the target chat ---------------------------------------------------
// Prefer the chat we're actively talking to; fall back to the allowed list so
// an autonomous session still surfaces the nudge to whoever's paired.
const entries = (() => {
  try {
    return payload.transcript_path ? readEntries(payload.transcript_path) : []
  } catch {
    return []
  }
})()
const caller = getCallerChat(entries)
const target: CallerChat | null = caller ?? (getAllowedChatIds().map(chatId => ({ chatId }))[0] ?? null)
if (!target) process.exit(0)

// --- Send the nudge with one-tap buttons -------------------------------------
// ho:clear → /clear now, no save (lose this session's context).
// ho:now   → save a structured carryover, then /clear (server.ts reloads it from
//            memory on the fresh session — continuity without a full restart).
// ho:skip  → dismiss; the per-tier dedupe already prevents this tier re-firing,
//            so a later tier can still escalate if the user keeps going.
// Full-width rows (one button each) — Telegram renders single-column buttons wide.
const token = getToken()!
const reply_markup = {
  inline_keyboard: [
    [{ text: 'Clear now', callback_data: 'ho:clear' }],
    [{ text: 'Remember & clear', callback_data: 'ho:now' }],
    [{ text: 'Not yet', callback_data: 'ho:skip' }],
  ],
}
try {
  const params = new URLSearchParams({ chat_id: target.chatId, text: crossed.text })
  if (target.threadId) params.set('message_thread_id', target.threadId)
  params.set('reply_markup', JSON.stringify(reply_markup))
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  // Only burn the tier if Telegram accepted it — a transient network failure
  // shouldn't permanently swallow the nudge for this session.
  if (res.ok) {
    try {
      writeFileSync(stateFile, String(crossed.at))
    } catch {
      // worst case: we nudge this tier again next turn. Acceptable.
    }
  }
} catch {
  // Best-effort; never crash the agent over a missed nudge.
}

process.exit(0)
