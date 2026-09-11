#!/usr/bin/env -S bun
// PostToolUse hook: nudge the agent when it's gone quiet on Telegram.
//
// Why: agents paired over Telegram sometimes go silent for minutes while
// they crunch through tool calls. CLAUDE.md and the notify-user skill both
// say "ack within 30s, edit your last message every ~30s", but Claude
// reads those at session start and ignores them mid-task once it's deep
// in work. This hook is the forcing function — it injects a fresh
// <system-reminder> into the next tool result after the silence threshold
// is crossed, so the model sees it in the live context window instead of
// having to recall a session-load directive.
//
// Triggers (PostToolUse, after every tool call) when ALL of:
//   - access.json has at least one allowFrom entry (paired)
//   - silence.json shows recent TG activity (inbound within last hour)
//   - EITHER (now - lastContactAt > FIRST_FIRE_SECONDS) OR (toolCallsSinceReply >= 5)
//     where lastContactAt is the newest of reply / edit_message / react
//     (DIVE-4276 — a reaction is contact, so it must silence this hook)
//
// Re-firing policy (avoids one-shot fatigue without spamming):
//   - First time after contact: fire immediately when threshold crossed
//   - After first fire: re-fire only on multiples of 5 calls OR every 60s

import { readPayload } from './lib/payload'
import { loadAccess } from './lib/access'
import { loadSilence, saveSilence } from './lib/state'
import { decideNag } from './lib/silence-decision'
import { emitPostToolContext } from './lib/output'
import { readEntries, analyzeTurn } from './lib/transcript'
import { TG_TOOL_PREFIX } from './lib/paths'

// Drain stdin. We only need transcript_path (for the DIVE-1323 a2a-turn
// check below); the rest is unused.
const payload = await readPayload<{ transcript_path?: string }>()

// First-fire silence threshold (seconds since last reply). Lower = the agent
// is forced to ack sooner; higher = quieter but more perceived silence. The
// single retune knob for the ack/annoyance balance. Stepped down 90 -> 60
// gradually 2026-06-22 (Mark) — quick tasks finish under it and never ack,
// long tasks cross it and buzz exactly once. Candidate next step: 45.
const FIRST_FIRE_SECONDS = 60

const access = loadAccess()
if (!access.allowFrom || access.allowFrom.length === 0) process.exit(0)

const now = Math.floor(Date.now() / 1000)
const state = loadSilence()
// Bump counter unconditionally; we still want it accurate even if the
// session isn't currently in a TG conversation (a fresh inbound later
// should see real numbers, not zero).
const calls = (state.toolCallsSinceReply ?? 0) + 1

// Race window between server.ts reset and this hook's increment is benign:
// the counter ends up at 1 after a reply (instead of 0), so the threshold
// fires after 4 more tool calls — close enough for a heuristic.

// DIVE-4276: the clock runs from the last CONTACT (reply, edit or reaction),
// not from the last reply alone — a 👍 on an acknowledgement is an answer, and
// nagging past it produces exactly the filler message the reaction avoided.
let decision = decideNag(state, now, FIRST_FIRE_SECONDS, calls)
let shouldFire = decision.shouldFire

// DIVE-1323: never nag the agent to DM the human on an inter-agent (a2a)
// turn — its reply belongs on the a2a channel (`5dive agent send`), not the
// paired human's DM. The read is gated on shouldFire so we only touch the
// transcript when a nag is actually imminent (this hook runs after EVERY tool
// call). Fail-open: if we can't read/parse, keep the existing nag so the
// human-liveness ack is never silently dropped.
if (shouldFire && payload.transcript_path) {
  try {
    if (analyzeTurn(readEntries(payload.transcript_path), TG_TOOL_PREFIX).a2aTurn) {
      shouldFire = false
    }
  } catch {
    // ignore — fall through and fire as before
  }
}

// DIVE-4276 (the second, smaller bug on the row): a reply issued in the SAME
// parallel tool batch as another call still nagged on that sibling's
// PostToolUse — the server's stamp lands after the reply tool's own hook, so a
// sibling that read silence.json earlier sees the pre-reply value. Re-read
// right before emitting and re-decide: by now the write has landed, and the
// counter comes from the fresh file so a reset is honoured too. The nag is the
// only thing gated on this; the counter bump below still uses the fresh read.
let fresh = state
let freshCalls = calls
if (shouldFire) {
  fresh = loadSilence()
  freshCalls = (fresh.toolCallsSinceReply ?? 0) + 1
  decision = decideNag(fresh, now, FIRST_FIRE_SECONDS, freshCalls)
  if (!decision.shouldFire) shouldFire = false
}

saveSilence({
  ...fresh,
  lastReminderAt: shouldFire ? now : (fresh.lastReminderAt ?? 0),
  toolCallsSinceReply: freshCalls,
})

if (shouldFire) {
  // Pick the right verb. If the latest inbound hasn't been replied to yet,
  // the user expects an answer BELOW their question — edits land on older
  // messages and look misplaced. Only edit when the in-flight task already
  // has an ack and no new inbound has landed since.
  const unansweredInbound = decision.unansweredInbound
  const sinceReply = decision.sinceContact
  const action = unansweredInbound
    ? 'Send a fresh reply (mcp__plugin_telegram_telegram__reply, reply_to the latest inbound) — the user is waiting on an answer to their newest message.'
    : 'Edit your last reply (mcp__plugin_telegram_telegram__edit_message) with a one-line status — same in-flight task, no new inbound, so an edit avoids re-pinging their phone.'
  emitPostToolContext(
    `You've gone ${sinceReply}s and ${freshCalls} tool calls without sending a Telegram message. The user alarms at >60s silence. ${action} Don't go silent.`,
  )
}
process.exit(0)
