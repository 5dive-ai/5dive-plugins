// DIVE-2818: pure, import-safe core of the REPLY-TO-CLEAR flow — the inbound
// half of the non-forgeable `--channel-msg` gate clear.
//
// WHY THIS EXISTS. `--channel-msg` is the one clear on this rail the filing agent
// cannot forge: it cites the id of the HUMAN'S OWN message, and Telegram attests
// the authorship. It shipped, it verifies, and it had ZERO callers — measured on
// DIVE-2799, 0 of 94 deployed `tna.ts` emit the flag. So the weak nonce path was
// the only REACHABLE one, which is what let a gate be cleared by the agent that
// filed it (DIVE-2802: a real clear recorded `answered_by=human:olivia uid=1011`,
// the filer's own uid).
//
// SIZING NOTE, because the ticket's estimate was written before this file was
// read: server.ts is NOT innocent of inbound gate answers. The DIVE-145 path
// already answers a gate from a REPLY to the bot's alert — but only for `manual`
// gates, and it shells `task answer <id> --value=<text>` with NO evidence flags at
// all. So the pre-existing inbound path is itself an instance of the weak clear
// this ticket is about. This module is the strong one beside it, not a rewrite of
// it: DIVE-145 keeps its shape for the reply-to-alert case it already serves.
//
// Extracted from server.ts for the reason tna.ts was (DIVE-369): server.ts
// long-polls on import, so a test that imports it boots a bot. This module
// imports cleanly and holds the whole decision matrix.
//
// ── ITERATION 2, and it changed the DEFAULT rather than any check ──────────────
//
// Iteration 1 was rejected because this row was RE-SCOPED underneath it. lodar,
// 2026-08-06 04:10:49Z, having just used both paths on live gates: "but asking
// user to type is not good ux" — measured, not theorised (he was refused once for
// sending "2803 B" without the ident, then tapped the button and it worked first
// press). So TAP is primary on every gate and this typed path is the RECOVERY
// path: for when the button is stale, already consumed, or the tap rail is down.
//
// That demotion inverts one call in this file, and only this one: how much
// benefit of the doubt a near-miss earns. While typing was the EXPECTED act, a
// `DIVE-N <anything>` on an open gate was probably a fumbled answer, so replying
// with the exact format was a kindness. Now that nobody is expected to type,
// "DIVE-2818 whats the holdup" is CONVERSATION, and answering it with a format
// lecture eats a message off the human's primary channel. Same code, same
// checks, opposite default: we now fall through unless intent is UNAMBIGUOUS.
//
// NON-FORGEABILITY IS UNTOUCHED BY ALL OF THIS, and the distinction is worth
// stating because it is the one a future reader will get wrong: narrowing WHEN we
// listen is not loosening WHAT we require. Condition (2) still needs the ident in
// the human's own words, no value is ever coerced, and nothing here composes a
// string on his behalf. A message we decline to claim is simply relayed to the
// agent as chat — the weakest possible outcome, not a bypass.

// The shape the CLI's recovery prompt tells the human to send:
//   DIVE-2818 approved
// Anchored and non-greedy on the value so a trailing "thanks!" is not silently
// swallowed into the answer — a value the human did not intend is exactly the
// class this rail exists to prevent.
export const GATE_REPLY_RE = /^\s*(DIVE-\d+)[\s,:]+(.+?)\s*$/i

// What we read off a live `5dive task show --json` gate. Loosely typed on
// purpose: it is whatever the CLI emits, narrowed to what we use.
export interface GateReplyGate {
  need_type?: string | null
  need_options?: string | null
  need_answered_at?: string | null
}

// Where the message arrived and what it was aimed at. Both fields exist to
// decide INTERCEPT vs FALL THROUGH; neither is an input to any security check.
export interface GateReplyContext {
  // True only for a 1:1 DM. REQUIRED rather than defaulted: a caller that
  // forgets it should fail to compile, not silently re-enable the group path.
  isDirect: boolean
  // The ident of the gate alert this message is a `reply_to`, if any — the same
  // condition DIVE-145 already uses. A human who replies directly to
  // "🙋 [DIVE-N] needs you" has named the gate by pointing at it, so whatever
  // they typed is an attempt to answer even if it is not a recognisable value.
  repliesToAlertFor?: string | null
}

export type GateReplyResolution =
  | { kind: 'nomatch' }
  // Not a DM. Falls through, carries no copy: see resolveGateReply.
  | { kind: 'elsewhere'; ident: string }
  // An open gate, but the text reads as conversation. Falls through, silently.
  | { kind: 'chatter'; ident: string; value: string }
  | { kind: 'nogate'; ident: string; reply: string }
  | { kind: 'already'; ident: string; reply: string }
  | { kind: 'invalid'; ident: string; reply: string }
  | { kind: 'answer'; ident: string; value: string; answerArgs: string[]; ack: string }

export interface ParsedGateReply { ident: string; value: string }

export function parseGateReply(text: string): ParsedGateReply | null {
  const m = GATE_REPLY_RE.exec(text ?? '')
  if (!m) return null
  return { ident: m[1]!.toUpperCase(), value: m[2]!.trim() }
}

// The answer values each gate type accepts over this path, in the exact spelling
// the CLI's prompt prints. STRICT ON PURPOSE, and the strictness is load-bearing
// rather than fussy: `_gate_channel_session_ok` condition 5 requires the human's
// own text to CONTAIN the value we pass as `--value`. Accepting "approve" and
// helpfully sending `--value=approved` would produce a citation that refuses,
// because "approved" is not a substring of "dive-2818 approve" — a fail-closed
// refusal the human would read as the feature being broken. So we accept only
// what we asked for, and nudge otherwise.
function allowedValues(gate: GateReplyGate): string[] {
  switch ((gate.need_type ?? '').toLowerCase()) {
    case 'approval': return ['approved', 'denied']
    case 'manual':   return ['done']
    // A secret gate's answer VALUE is the literal word `provided`, never the
    // credential. DIVE-2232 is why this is spelled out: a human holding the nonce
    // tapped ✅ Provided on a gate with no drop target and the row recorded a
    // signed, nonced, uid-stamped answer over an EMPTY payload. Here the risk runs
    // the other way — accepting free text would invite the raw credential into a
    // persistent chat log — so this path accepts exactly one token and nothing else.
    case 'secret':   return ['provided']
    case 'decision':
      // Same split rule as the CLI's option renderer and the tna: handler
      // (split '|', trim, drop empties). A divergence here resolves the wrong
      // option, which is the DIVE-118 failure the CLI comments pin byte-identical.
      return (gate.need_options ?? '')
        .split('|')
        .map(o => o.trim())
        .filter(o => o.length > 0)
    default: return []
  }
}

// Levenshtein, capped at 1 and short-circuiting. Only ever asked "is this one
// typo away", so the full matrix is not worth writing.
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let slack = 1
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue }
    if (slack === 0) return false
    slack--
    if (short.length === long.length) i++ // substitution
    j++                                   // insertion in `long`
  }
  return true
}

/**
 * Did the human plainly mean to ANSWER, or are they talking?
 *
 * The bar is deliberately mechanical, because the alternative is inventing
 * semantics: a value that AGREES with an allowed answer for at least 3 leading
 * characters (so "approve", "approved thanks!" and "ship it" all count, while a
 * single-letter decision option cannot be triggered by an unrelated word), or a
 * value one typo away from one. Anything else is conversation.
 *
 * Note what is NOT here: no synonym table. "no" does not resolve to "denied".
 * Guessing at meaning on a rail whose entire value is the human's own literal
 * words is the wrong place to be clever, and the tap — which is primary — already
 * covers the human who does not want to type an exact string.
 */
function meantToAnswer(value: string, allowed: string[]): boolean {
  const v = value.toLowerCase().replace(/[\s.,;:!?]+$/, '')
  if (!v) return false
  return allowed.some(a => {
    const c = a.toLowerCase()
    if (v.startsWith(c) || c.startsWith(v)) return Math.min(v.length, c.length) >= 3
    return withinOneEdit(v, c)
  })
}

/**
 * Decide what an inbound `DIVE-N <value>` message means for a live gate.
 *
 * `chatId` and `msgId` become the citation. They are the whole point of this
 * path: `--channel-proof` names the verified DM and `--channel-msg` names the
 * human's own message inside it, and the CLI re-checks both against Telegram
 * rather than trusting us. We are not asserting a human answered; we are handing
 * the CLI the coordinates at which it can go and verify that for itself.
 */
export function resolveGateReply(
  parsed: ParsedGateReply,
  gate: GateReplyGate | null | undefined,
  chatId: string,
  msgId: number | undefined,
  rawText: string,
  ctx: GateReplyContext,
): GateReplyResolution {
  const { ident, value } = parsed

  // GROUPS ARE NOT ON THIS RAIL, and it costs nothing to say so — measured, not
  // assumed: `_gate_channel_proof_ok` requires `^[0-9]+$` and a Telegram group id
  // is NEGATIVE, so a group can never produce a citation that attests. Without
  // this guard the group path was strictly worse than doing nothing: a valid
  // "DIVE-N done" in #5dive shelled `task answer`, was refused for a reason the
  // copy could not explain, and ate the message off the agent's stream on the way.
  // Meanwhile #5dive is exactly where idents get discussed all day.
  //
  // server.ts checks this too, before it spends a subprocess on `task show`. That
  // is not a second authority — this one is the tested rule — it just declines to
  // look up a gate whose answer cannot matter.
  if (!ctx.isDirect) return { kind: 'elsewhere', ident }

  if (!gate || !gate.need_type) {
    return { kind: 'nogate', ident, reply: `${ident} no longer has an open gate, so there is nothing to answer.` }
  }
  if (gate.need_answered_at) {
    return { kind: 'already', ident, reply: `${ident} was already answered.` }
  }

  const isSecret = (gate.need_type ?? '').toLowerCase() === 'secret'
  const allowed = allowedValues(gate)
  const canonical = allowed.find(a => a.toLowerCase() === value.toLowerCase())

  if (!canonical) {
    // THE ITERATION-2 NARROWING. Three ways to earn a reply; everything else is
    // conversation and is handed straight back to the agent.
    const intended =
      // A secret gate is the one place we intercept on TYPE rather than on
      // intent, and it is a deliberate exception to the narrowing above. The
      // whole risk on a secret gate runs toward the human having just pasted a
      // credential into a permanent chat log, and the one useful thing to do
      // about that is say so immediately. Falling silent to protect a
      // conversation we might be interrupting trades a certain safety warning
      // for a hypothetical one — the wrong way round. Secret gates are rare and
      // short-lived, so the cost of occasionally answering "DIVE-N any news?"
      // with a don't-send-it-here notice is a confused second of a human's day.
      isSecret ||
      // Replied straight to the gate's own alert: they pointed at it.
      (ctx.repliesToAlertFor ?? '').toUpperCase() === ident ||
      meantToAnswer(value, allowed)

    if (!intended) return { kind: 'chatter', ident, value }

    if (isSecret) {
      // Never echoes what they sent — a nudge that quotes the rejected text
      // copies the credential into a SECOND chat message.
      return {
        kind: 'invalid',
        ident,
        reply:
          `🔒 ${ident} needs a secret — don't send it here (Telegram keeps chat history). ` +
          `Place it out-of-band, then reply exactly: ${ident} provided`,
      }
    }
    const shown = allowed.length ? allowed.map(a => `${ident} ${a}`).join('\n') : '(none)'
    return {
      kind: 'invalid',
      ident,
      reply: `That is not an answer ${ident} accepts. Reply with exactly one of:\n${shown}`,
    }
  }

  if (msgId == null) {
    // No message id means no citation, and a clear with no citation on this path
    // would be the weak clear wearing the strong path's clothes. Refuse and point
    // at the button, which at least carries the per-gate nonce.
    return { kind: 'invalid', ident, reply: `Could not cite your message for ${ident}. Tap the button on the alert instead.` }
  }

  // PRE-CHECK THE CITATION RULE WE ALREADY KNOW WE MUST SATISFY. This is not a
  // second authority — the CLI re-runs conditions 1-5 against Telegram and its
  // answer is the only one that counts — it is a way to fail with a useful nudge
  // instead of shelling a command whose refusal we can already predict.
  const hay = (rawText ?? '').toLowerCase()
  if (!hay.includes(ident.toLowerCase()) || !hay.includes(canonical.toLowerCase())) {
    return {
      kind: 'invalid',
      ident,
      reply: `Your message has to name both the gate and the answer. Send exactly: ${ident} ${canonical}`,
    }
  }

  return {
    kind: 'answer',
    ident,
    value: canonical,
    // NOTE the absence of `--human`. The tap path self-asserts it (tapEvidenceArgs)
    // because a callback carries no artifact; here the citation IS the evidence and
    // the CLI raises `human=1` itself once it attests. Passing a self-asserted flag
    // alongside real evidence only makes the audit row harder to read, and if the
    // citation does NOT attest, `task answer` fails closed rather than falling
    // through to the weaker form — so there is nothing for the flag to rescue.
    answerArgs: [ident, `--value=${canonical}`, `--channel-proof=${chatId}`, `--channel-msg=${String(msgId)}`],
    ack: `✅ Answered ${ident} (${canonical}). Your own message is the evidence, so the record shows a human answered.`,
  }
}
