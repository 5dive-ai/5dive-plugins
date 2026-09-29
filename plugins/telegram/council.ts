/**
 * The council's authenticated Telegram taps: the founder veto (DIVE-1546) and the
 * human-as-seat ballot (DIVE-1566). They are how a human answers a live council
 * gate. Pure parsers, unit-tested headless (test/council.test.ts).
 *
 * DIVE-5164: the read-only `/council` command and its roster / log / lineage /
 * verify renderers were removed (lodar). Only the retired tap verbs stay, below.
 */

// The retired read-only verbs the old `/council` header carried. No message offers
// them any more; server.ts answers a stale tap on an older message and drops its
// keyboard. Kept as data so the veto / ballot parsers stay proven not to take them.
export const COUNCIL_BUTTONS: Array<{ text: string; callback_data: string }> = [
  { text: '📜 Log', callback_data: 'cl:log' },
  { text: '🔗 Lineage', callback_data: 'cl:lin' },
  { text: '✅ Verify', callback_data: 'cl:ver' },
]

// DIVE-1546: the AUTHENTICATED founder-veto TAP. Unlike the read-only cl:* verbs, this
// callback_data carries the one-time veto nonce — it rides ONLY here (the council source never
// prints it to chat, rail B) and the button is delivered founder-chat-only. Format:
// `veto:<receiptPrefix>:<nonce>`. Telegram caps callback_data at 64 bytes; a full base64url sealed
// digest (43) + a 32-char nonce would be 81, so `_tg_veto_offer` carries a unique receipt PREFIX
// (the CLI's `veto exercise --receipt` resolves a unique prefix, fail-closed on miss/ambiguity).
// `veto:` (5) + prefix (≤26) + `:` (1) + nonce (32 = `openssl rand -hex 16`) stays ≤ 64. The
// length anchors reject a truncated / malformed payload; the nonce group is hex-only.
export const VETO_RE = /^veto:([A-Za-z0-9_-]{8,26}):([0-9a-f]{16,40})$/
export function parseVetoTap(data: string): { receipt: string; nonce: string } | null {
  const m = VETO_RE.exec(data)
  return m ? { receipt: m[1]!, nonce: m[2]! } : null
}

// DIVE-1566 (sub-task 4/4 of DIVE-1548): the AUTHENTICATED human-as-seat BALLOT TAP. A council
// seat held by a human votes by tapping Approve/Reject/Abstain on the ballot message the CLI
// dispatch (DIVE-1564) emitted; that button's callback_data carries the one-time DIVE-916 nonce —
// it rides ONLY here (the ballot body stores only the sha256 DIGEST, never the raw nonce; the task
// text is blind), and the button is delivered to the seat-holder's chat only. Format:
// `cvote:<ref>:<code>:<nonce>`, where `ref` is the ballot TASK-id prefix (≤12 chars, DIVE-1564
// slices `taskId.slice(0,12)`), `code` ∈ {a,r,e} → approve/reject/abstain, and `nonce` is
// `randomBytes(16).toString('hex')` = exactly 32 hex chars. Telegram caps callback_data at 64 bytes:
// `cvote:`(6) + ref(≤12) + `:`(1) + code(1) + `:`(1) + nonce(32) ≤ 53 — always fits, no prefixing of
// the nonce needed (unlike the veto's PREFIX'd digest). The length/charset anchors reject a truncated
// or malformed payload; the nonce group is hex-only, the code group is exactly one of a|r|e.
export const CVOTE_RE = /^cvote:([A-Za-z0-9_-]{1,12}):([are]):([0-9a-f]{32})$/
export function parseCvoteTap(data: string): { ref: string; code: 'a' | 'r' | 'e'; nonce: string } | null {
  const m = CVOTE_RE.exec(data)
  return m ? { ref: m[1]!, code: m[2]! as 'a' | 'r' | 'e', nonce: m[3]! } : null
}
