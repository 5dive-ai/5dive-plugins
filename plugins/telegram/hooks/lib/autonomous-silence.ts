// DIVE-3422: an AUTONOMOUS session has no chat scope, so nothing it writes
// can reach anyone — and every other guard in this plugin is scoped to a
// caller that an autonomous session does not have.
//
// Measured 2026-08-15/16 (olivia, then re-measured by dev3 against
// origin/main). A `/goal` session ran 342 transcript entries over 52 minutes,
// wrote every progress report, its completion report and a security
// escalation to the TERMINAL, and reached the channel zero times. Replayed
// through the installed `analyzeTurn`, every turn of it read
// `{hadInbound:false, lastChatId:null, hadSend:false}` — so
// stop-reply-check's `if (!a.hadInbound || !a.lastChatId ...) exit(0)` was
// CORRECT to exit on all of them. Nothing was broken; the session was simply
// never in any guard's scope. From outside, an agent reporting diligently
// into the void is indistinguishable from one that has hung or crashed.
//
// The one branch that already solves this shape is stop-reply-check's
// session-limit notice: on a null caller chat it falls back to the configured
// chats, precisely so "an autonomous-turn limit hit still pings someone".
// This is that branch's second instance, not a new mechanism.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING BELOW (acceptance item 3 on the row):
// an over-firing nag gets muted, and a muted warning is the silence we
// started with. An autonomous session is SUPPOSED to be quiet, so "warn after
// N silent turns, every turn" would fire forever on a healthy cron seat. Two
// things hold that line: the run RESETS to zero the moment the agent reaches
// the channel (the negative-control arm — that is the arm that matters), and
// after the first notice it re-fires only on a large multiple.

// Turns of consecutive channel-silence before the first notice. 3 is chosen
// against the incident: it would have fired ~28 minutes in, with 5 of the 8
// wasted driver turns still ahead of it. The single retune knob.
export const SILENT_RUN_FIRST = 3
// After the first notice, re-fire only on multiples of this. Deliberately far
// above FIRST: the second notice is "this is still going", not a nag.
export const SILENT_RUN_REPEAT = 25

// The only facts about a turn this decision needs. Kept as a plain shape
// rather than a TurnAnalysis so the decision is testable without building a
// synthetic transcript, and so it cannot accidentally read anything else.
export type SilentTurn = {
  hadInbound: boolean
  a2aTurn: boolean
  hadSend: boolean
  hasText: boolean
}

export type SilentRunDecision = {
  // The new consecutive-silent-turn count to persist.
  count: number
  // Emit the notice for this turn.
  notify: boolean
}

// Pure. Given the run length so far and this turn, return the new run length
// and whether to speak. No I/O, no clock — every arm below is directly
// assertable.
export function nextSilentRun(prev: number, t: SilentTurn): SilentRunDecision {
  // NEGATIVE CONTROL. The agent reached the channel this turn (hadSend), or
  // was addressed on it (hadInbound — that turn is the existing relay path's
  // business, and it will either send or deliberately stay quiet). Either way
  // the session is NOT dark, so the run ends. An agent that is replying
  // correctly can never accumulate a run, which is the whole guarantee.
  if (t.hadSend || t.hadInbound) return { count: 0, notify: false }

  // An inter-agent turn is neither silence toward the user nor a reply to
  // them (DIVE-1323: its output belongs on the a2a channel). Leave the run
  // untouched — an a2a burst inside an otherwise-dark session must neither
  // launder the silence away nor count as more of it.
  if (t.a2aTurn) return { count: prev, notify: false }

  // A turn that produced no assistant text has nothing to report, so it is
  // not evidence of unreported work. Tool-only turns are ordinary mid-task
  // shape and must not push the count toward a notice on their own.
  if (!t.hasText) return { count: prev, notify: false }

  const count = prev + 1
  const notify =
    count === SILENT_RUN_FIRST ||
    (count > SILENT_RUN_FIRST && count % SILENT_RUN_REPEAT === 0)
  return { count, notify }
}

// Telegram caps a message at 4096; leave generous headroom for the prefix and
// for the transport's own truncation.
const TAIL_LIMIT = 1200

// The notice. lodar's recovery move in the incident was to send ANOTHER
// message into the silence, which produced another silent turn — the failure
// mode consumes the attempts to escape it. So the notice has to carry enough
// to make that move unnecessary: what is happening, for how long, and what
// the agent actually last said.
export function composeSilentRunNotice(count: number, lastText: string): string {
  const trimmed = lastText.trim()
  const tail =
    trimmed.length > TAIL_LIMIT ? `${trimmed.slice(0, TAIL_LIMIT)}…` : trimmed
  // No em-dash in user-facing copy (house style).
  const head = `🔇 Still working, but nothing has reached this channel for ${count} turns. You are seeing this because otherwise you would see nothing at all.`
  return tail ? `${head}\n\nLatest from the transcript:\n${tail}` : head
}
