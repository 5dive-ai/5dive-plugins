// DIVE-4982: the owner's one-tap answer to a browser ask.
//
// A browser send, pay, publish or delete stops with exit 73, and
// `5dive owner-ask browser` sends the owner the ask with Approve
// `bap:<12hex>:<nonce>` and Decline `bdn:<12hex>:<nonce>` (49 bytes). ROOT
// minted the nonce and put it straight into the button. On a seat running its
// own bot the tap lands here, and this bridge relays it to
// `sudo -n 5dive --json owner-ask tap <data> --tap-uid=<from.id>`, the same
// call the team-bot listener makes. The CLI decides everything: the live
// request, whether the tapper is the owner, the proof, the approve. This
// bridge never approves, never mints, never checks ownership and never opens
// the approval files. This module is the pure half plus the relay, with its
// I/O injected so the suite drives it without a bot; the ctx calls live in
// server.ts.

export const BAP_RE = /^(bap|bdn):([0-9a-f]{12}):([0-9a-f]{32})$/
// Ours even when malformed: a bap:/bdn: that reached the generic agent-keyboard
// bridge would hand whatever it carries into the agent's session.
const OWNER_ASK_PREFIX_RE = /^(bap|bdn):/
// The grammar `owner-ask tap` accepts for --tap-uid.
const TAP_UID_RE = /^-?\d{1,20}$/
// Telegram caps an answerCallbackQuery text at 200 chars.
const MAX_TOAST = 190

export type OwnerAskTap = { verb: 'bap' | 'bdn'; hex: string; nonce: string; data: string }

/** applied: the CLI approved or declined. text: the one line the tapper sees. */
export type OwnerAskOutcome = { applied: boolean; text: string }

export type OwnerAskIO = {
  /** `sudo -n 5dive <args>`; resolves with stdout, including a refusal's envelope. */
  run: (args: string[]) => Promise<string>
  answer: (text: string) => Promise<void>
  /** false when Telegram refused the edit */
  edit: (text: string) => Promise<boolean>
  dropButtons: () => Promise<void>
  log: (line: string) => void
}

export const OWNER_ASK_EXPIRED = 'This approval button has expired — nothing was authorised.'
const OWNER_ASK_UNREADABLE = "Couldn't apply — answer on the box: sudo 5dive browser approve <id>"

/** null: not an owner-ask button. 'malformed': a bap:/bdn: that is not the shape. */
export function parseOwnerAskTap(data: string): OwnerAskTap | 'malformed' | null {
  if (!OWNER_ASK_PREFIX_RE.test(data)) return null
  const m = BAP_RE.exec(data)
  if (!m) return 'malformed'
  return { verb: m[1] as 'bap' | 'bdn', hex: m[2]!, nonce: m[3]!, data }
}

/** The CLI's argv after `sudo -n 5dive`. The tapper id is Telegram's
 *  `from.id`, never anything the message carried. */
export function ownerAskArgs(tap: OwnerAskTap, tapUid: string): string[] | null {
  if (!TAP_UID_RE.test(tapUid)) return null
  return ['--json', 'owner-ask', 'tap', tap.data, `--tap-uid=${tapUid}`]
}

/** The CLI's answer. Success carries {result, id}; a refusal carries
 *  {ok:false,error:{message}}, written for the person tapping. */
export function ownerAskOutcome(stdout: string): OwnerAskOutcome {
  let r: any = null
  try {
    r = JSON.parse(stdout)
  } catch {
    r = null
  }
  if (r?.ok === true) {
    const id = String(r.data?.id ?? '')
    if (r.data?.result === 'approved') return { applied: true, text: `✅ Approved — ${id}` }
    if (r.data?.result === 'declined') return { applied: true, text: `❌ Declined — ${id}` }
  }
  const why = r?.ok === false && r.error?.message ? String(r.error.message) : OWNER_ASK_UNREADABLE
  return { applied: false, text: why.slice(0, MAX_TOAST) }
}

/** false: not an owner-ask button, the router carries on. Every bap:/bdn: is
 *  answered here and never reaches the agent's session. The message is edited
 *  only when the CLI says what happened; a refusal only answers the tap. */
export async function relayOwnerAskTap(data: string, tapUid: string, messageText: string | undefined, io: OwnerAskIO): Promise<boolean> {
  const tap = parseOwnerAskTap(data)
  if (tap === null) return false
  const args = tap === 'malformed' ? null : ownerAskArgs(tap, tapUid)
  if (!args) {
    await io.answer(OWNER_ASK_EXPIRED)
    return true
  }
  const out = ownerAskOutcome(await io.run(args))
  if (!out.applied) {
    io.log(`owner-ask tap from ${tapUid} refused: ${out.text}`)
    await io.answer(out.text)
    return true
  }
  if (!messageText || !(await io.edit(`${messageText}\n\n${out.text}`))) await io.dropButtons()
  await io.answer(out.text)
  return true
}
