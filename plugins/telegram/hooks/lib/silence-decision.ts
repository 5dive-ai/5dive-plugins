// DIVE-4276: the silence watchdog's decision, extracted as a pure function.
//
// Why a separate module: the watchdog is a top-level script (it reads stdin and
// exits), so its branching was untestable without spawning a process and
// faking a hook payload. The rules below are the part worth locking, so they
// live here and the script keeps only the I/O.
//
// THE BUG this split was cut for: the clock that decides "you have gone quiet"
// used to be lastReplyAt ALONE, and only the `reply` tool stamped that. So an
// agent that answered an acknowledgement-only inbound the way the rules ask —
// a 👍 reaction, never a redundant message — was read as having said nothing,
// and the very next tool call nagged it into sending the filler message the
// reaction existed to avoid (measured on main 2026-09-11 04:39-04:40Z).
//
// The fix is TWO clocks, because a reaction and a reply do not mean the same
// thing:
//   - lastContactAt — "the human saw a sign of life from us". Stamped by
//     reply, by edit_message, and by any react. It drives the SILENCE clock.
//   - lastReplyAt — "the human's latest message has been ANSWERED". Stamped by
//     reply, and by a react ONLY when the reacted-to message is the latest
//     inbound. It drives `unansweredInbound`, which picks reply-vs-edit here
//     and gates the resume prompt's reply clause (resume-prompt.ts).
// Keeping them apart is what makes an edit reset the clock without falsely
// marking a NEWER inbound as answered.

import type { SilenceState } from './types'

export type SilenceDecision = {
  shouldFire: boolean
  // Seconds since the last sign of life (reply, edit or reaction), or since
  // the inbound when we have never contacted this thread at all.
  sinceContact: number
  calls: number
  // The human's newest message has had no reply/latest-inbound reaction yet.
  unansweredInbound: boolean
  inConversation: boolean
  // The lastContactAt to persist — the max of the two stamps, so an older
  // plugin's silence.json (lastReplyAt only, no lastContactAt) still reads
  // as contact rather than as total silence.
  lastContact: number
}

export function decideNag(
  state: SilenceState,
  now: number,
  firstFireSeconds: number,
  calls: number,
): SilenceDecision {
  const lastInbound = state.lastInboundAt ?? 0
  const lastReply = state.lastReplyAt ?? 0
  // Back-compat: pre-DIVE-4276 state files carry no lastContactAt. A reply is
  // contact, so fold it in rather than treating those seats as never-contacted.
  const lastContact = Math.max(state.lastContactAt ?? 0, lastReply)
  const lastReminder = state.lastReminderAt ?? 0

  const inConversation = lastInbound > 0 && now - lastInbound <= 3600

  let sinceContact = 0
  if (lastContact > 0) {
    sinceContact = now - lastContact
  } else if (lastInbound > 0) {
    // Never contacted this TG thread — measure silence from inbound.
    sinceContact = now - lastInbound
  }

  let shouldFire = false
  if (inConversation) {
    const crossedCount = calls >= 5
    const crossedTime = sinceContact > firstFireSeconds
    if (crossedCount || crossedTime) {
      if (lastReminder === 0 || lastReminder < lastContact || lastReminder < lastInbound) {
        // First time crossing the threshold since the last contact/inbound.
        shouldFire = true
      } else if (calls >= 5 && calls % 5 === 0) {
        shouldFire = true
      } else if (now - lastReminder >= 60) {
        shouldFire = true
      }
    }
  }

  return {
    shouldFire,
    sinceContact,
    calls,
    unansweredInbound: lastInbound > lastReply,
    inConversation,
    lastContact,
  }
}
