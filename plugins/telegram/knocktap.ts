// DIVE-8036 (DIVE-8032 B): the owner's Allow / Admin / No on a knock.
//
// Someone the agent does not know wrote to it (on Teams). `5dive people knock
// file` sent the owner a card through this agent's bot with three buttons,
// `kn:<kid>:allow|admin|no:<nonce>`, each with ITS OWN nonce minted by root. A
// tap lands here and is relayed to
//   sudo -n 5dive people knock answer <kid> <choice> --proof=<nonce> --by=telegram:<uid> --json
// only when the tapper is in this bot's owners record (the accessreq.ts
// stance: who MAY DM is not who decides). The CLI checks the proof against the
// hash for THAT choice, so a nonce never answers another button; it adds the
// person, syncs, and hands the answer to the agent's Teams server. This bridge
// never mints, never stores the nonce and never applies anything itself.
//
// Pure half plus the relay, its I/O injected so the suite drives it without a
// bot; server.ts holds the ctx calls.

export const KN_RE = /^kn:(\d{1,12}):(allow|admin|no):([0-9a-f]{32})$/
// Ours even when malformed: a kn: that reached the generic agent-keyboard
// bridge would hand its nonce into the agent's session.
const KN_PREFIX_RE = /^kn:/
const TAP_UID_RE = /^\d{1,20}$/
const MAX_TOAST = 190

export type KnockChoice = 'allow' | 'admin' | 'no'
export type KnockTap = { kid: string; choice: KnockChoice; nonce: string }

export type KnockIO = {
  /** owners record check for this bot (accessreq.ts isOwner) */
  isOwner: (uid: string) => boolean
  /** `sudo -n <args>`; resolves with stdout, a refusal's envelope included */
  run: (args: string[]) => Promise<string>
  answer: (text: string) => Promise<void>
  /** false when Telegram refused the edit */
  edit: (text: string) => Promise<boolean>
  dropButtons: () => Promise<void>
  log: (line: string) => void
}

export const KNOCK_NOT_OWNER = 'Only the owner can answer this.'
export const KNOCK_EXPIRED = 'This button no longer works — answer in 5dive.app, Team tab.'

/** null: not a knock button. 'malformed': a kn: that is not the shape. */
export function parseKnockTap(data: string): KnockTap | 'malformed' | null {
  if (!KN_PREFIX_RE.test(data)) return null
  const m = KN_RE.exec(data)
  if (!m) return 'malformed'
  return { kid: m[1]!, choice: m[2] as KnockChoice, nonce: m[3]! }
}

/** The argv after `sudo -n`. Shaped to match the seat's sudoers line
 *  `/usr/local/bin/5dive people knock answer *` (the global --json may sit last).
 *  The tapper id is Telegram's from.id, never anything the message carried. */
export function knockAnswerArgs(tap: KnockTap, tapUid: string): string[] | null {
  if (!TAP_UID_RE.test(tapUid)) return null
  return ['5dive', 'people', 'knock', 'answer', tap.kid, tap.choice, `--proof=${tap.nonce}`, `--by=telegram:${tapUid}`, '--json']
}

export type KnockOutcome = { applied: boolean; text: string }

/** The CLI's answer: {ok, data:{status, answer, agent, person}}; a refusal {ok:false, error:{message}}. */
export function knockOutcome(stdout: string): KnockOutcome {
  let r: any = null
  try {
    r = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '')
  } catch {
    r = null
  }
  if (r?.ok === true) {
    const agent = String(r.data?.agent ?? '')
    const who = agent ? agent[0]!.toUpperCase() + agent.slice(1) : 'the agent'
    if (r.data?.answer === 'admin') return { applied: true, text: `✅ Admin — they can talk to ${who} and change settings.` }
    if (r.data?.answer === 'allow') return { applied: true, text: `✅ Allowed — they can talk to ${who}.` }
    if (r.data?.answer === 'no') return { applied: true, text: `❌ No — ${who} won't answer them.` }
  }
  const why = r?.ok === false && r.error?.message ? String(r.error.message) : KNOCK_EXPIRED
  return { applied: false, text: why.slice(0, MAX_TOAST) }
}

/** false: not a knock button, the router carries on. Every kn: is answered
 *  here and never reaches the agent's session. */
export async function relayKnockTap(data: string, tapUid: string, messageText: string | undefined, io: KnockIO): Promise<boolean> {
  const tap = parseKnockTap(data)
  if (tap === null) return false
  if (!io.isOwner(tapUid)) {
    io.log(`knock tap from non-owner ${tapUid} refused`)
    await io.answer(KNOCK_NOT_OWNER)
    return true
  }
  const args = tap === 'malformed' ? null : knockAnswerArgs(tap, tapUid)
  if (!args) {
    await io.answer(KNOCK_EXPIRED)
    return true
  }
  const out = knockOutcome(await io.run(args))
  if (!out.applied) {
    io.log(`knock tap from ${tapUid} refused: ${out.text}`)
    await io.answer(out.text)
    return true
  }
  if (!messageText || !(await io.edit(`${messageText}\n\n${out.text}`))) await io.dropButtons()
  await io.answer(out.text)
  return true
}
