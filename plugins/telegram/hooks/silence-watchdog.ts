#!/usr/bin/env -S bun
// PostToolUse hook: nudge the agent once when it has not acknowledged a
// Telegram message.
//
// Why: agents paired over Telegram sometimes dive into tool calls without
// saying "on it". CLAUDE.md and the notify-user skill both say "ack within
// 30s", but Claude reads those at session start and ignores them mid-task
// once it's deep in work. This hook is the forcing function — it injects a fresh
// <system-reminder> into the next tool result after the silence threshold
// is crossed, so the model sees it in the live context window instead of
// having to recall a session-load directive.
//
// Triggers (PostToolUse) ONCE per inbound, when ALL of:
//   - access.json has at least one allowFrom entry (paired)
//   - the newest inbound is under an hour old
//   - nothing reached the human since it (reply, edit_message or react —
//     lastContactAt, DIVE-4276) for more than FIRST_FIRE_SECONDS
//
// DIVE-5419 deleted the re-fire (every 5 calls / every 60s, after the ack too).
// Once the ack is out, the bridge keeps "typing…" running and edits a status
// line onto the ack itself (ackstatus.ts + hooks/status-label.ts) for zero
// model tokens. The re-fire only made the model do the same job by hand: ~1
// call in 10 of a working session, each re-reading the whole conversation,
// plus every injection staying in context for the rest of the session.

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

// DIVE-5194: lite runs this hook exactly as the default profile does. Its
// output is a reminder to the AGENT, never a message to the client, so a
// profile has no reason to touch it (lodar: "we shouldn't customize our
// perfectly working hooks too much"). DIVE-5121 had dropped it on lite and
// DIVE-5166 had put back a narrower lite arm; both are gone.

// Ack threshold (seconds since the newest inbound with no contact). Lower = the agent
// is forced to ack sooner; higher = quieter but more perceived silence. The
// single retune knob for the ack/annoyance balance. Stepped down 90 -> 60
// gradually 2026-06-22 (Mark) — quick tasks finish under it and never ack,
// long tasks cross it and buzz exactly once. Candidate next step: 45.
// Still the one knob after DIVE-5419; it now also is the ONLY firing.
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
// the counter is informational only since DIVE-5419 (the decision no longer
// reads it).

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
  emitPostToolContext(
    `The user's newest Telegram message has had no acknowledgement for ${decision.sinceInbound}s. ` +
      'Send a short reply now (mcp__plugin_telegram_telegram__reply, reply_to the latest inbound), or react if it needs no answer. ' +
      'After that the bridge keeps "typing…" and a live status line on your reply by itself — do not spend edit_message on progress.',
  )
}
process.exit(0)
