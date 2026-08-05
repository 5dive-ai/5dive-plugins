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

// The shape the CLI's high-stakes DM prompt tells the human to send:
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

export type GateReplyResolution =
  | { kind: 'nomatch' }
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
): GateReplyResolution {
  const { ident, value } = parsed

  if (!gate || !gate.need_type) {
    return { kind: 'nogate', ident, reply: `${ident} no longer has an open gate, so there is nothing to answer.` }
  }
  if (gate.need_answered_at) {
    return { kind: 'already', ident, reply: `${ident} was already answered.` }
  }
  if (msgId == null) {
    // No message id means no citation, and a clear with no citation on this path
    // would be the weak clear wearing the strong path's clothes. Refuse and point
    // at the button, which at least carries the per-gate nonce.
    return { kind: 'invalid', ident, reply: `Could not cite your message for ${ident}. Tap the button on the alert instead.` }
  }

  const allowed = allowedValues(gate)
  const canonical = allowed.find(a => a.toLowerCase() === value.toLowerCase())
  if (!canonical) {
    const shown = allowed.length ? allowed.map(a => `${ident} ${a}`).join('\n') : '(none)'
    return {
      kind: 'invalid',
      ident,
      reply: `That is not an answer ${ident} accepts. Reply with exactly one of:\n${shown}`,
    }
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
