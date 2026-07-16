import { loadSilence } from './state'

// The auto-resume prompt typed into claude after a usage-limit reset, a
// transient API error, or an account rotation. Historically every resume site
// hardcoded "continue and reply to the latest message". That reply clause has
// no referent when the interrupted turn was autonomous work with NO pending DM,
// so the model resumes, finds nothing to reply to, and escalates hunting for a
// message to answer — the phantom-prompt bug (DIVE-1316, hit community + olivia
// on 2026-07-16).
//
// The plugin already tracks lastInboundAt (stamped on every inbound DM) vs
// lastReplyAt (stamped on every reply we send). When lastInbound > lastReply
// there is a genuine unanswered message, so append the reply clause; otherwise
// resume with a bare "continue" and let the model pick its interrupted work
// back up without a phantom instruction.
export function resumePrompt(): string {
  const state = loadSilence()
  const lastInbound = state.lastInboundAt ?? 0
  const lastReply = state.lastReplyAt ?? 0
  return lastInbound > lastReply
    ? 'continue and reply to the latest message'
    : 'continue'
}
