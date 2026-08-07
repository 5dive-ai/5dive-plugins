// DIVE-2818 — the REPLY-TO-CLEAR resolver: which inbound messages become a
// non-forgeable gate clear, which become a nudge, and which must be left alone.
//
// The third category is the one with teeth, and iteration 2 GREW it. This path is
// now the RECOVERY path, not the expected one (lodar: "asking user to type is not
// good ux"), so a `DIVE-N <anything>` on an open gate is conversation until it
// shows unambiguous aim. Most of the arms below pin the FALL-THROUGH, not the
// answer — including the two that were missing, which is why iteration 1 shipped
// an intercept nobody wanted with a green suite.
import { test, expect, describe } from 'bun:test'
import { parseGateReply, resolveGateReply, GATE_REPLY_RE } from '../plugins/telegram/gatereply'

// Reserved fakes only (repo rule): chat id 1234567890, never a real one.
const CHAT = '1234567890'
const MSG = 4242

const open = (need_type: string, need_options?: string) => ({ need_type, need_options: need_options ?? null, need_answered_at: null })

// A DM that is not a reply to anything — the ordinary case.
const DM = { isDirect: true, repliesToAlertFor: null }
// A DM that replies straight to "🙋 [DIVE-N] needs you".
const replyTo = (ident: string) => ({ isDirect: true, repliesToAlertFor: ident })
// A group/supergroup, e.g. #5dive.
const GROUP = { isDirect: false, repliesToAlertFor: null }

describe('parseGateReply', () => {
  test('accepts the exact string the CLI prompt prints', () => {
    expect(parseGateReply('DIVE-2818 approved')).toEqual({ ident: 'DIVE-2818', value: 'approved' })
  })
  test('is case-insensitive on the ident and normalises it upward', () => {
    expect(parseGateReply('dive-2818 approved')?.ident).toBe('DIVE-2818')
  })
  test('tolerates a comma or colon after the ident', () => {
    expect(parseGateReply('DIVE-2818: approved')?.value).toBe('approved')
  })
  test('does not match a bare ident with no answer', () => {
    expect(parseGateReply('DIVE-2818')).toBeNull()
  })
  test('does not match an ident mid-sentence', () => {
    // The anchor is what keeps "what about DIVE-2818 then" out of the rail.
    expect(parseGateReply('what about DIVE-2818 then')).toBeNull()
  })
})

describe('resolveGateReply — the answer path', () => {
  test('an approval reply produces a CITATION, not a self-asserted human claim', () => {
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'approved' }, open('approval'), CHAT, MSG, 'DIVE-2818 approved', DM)
    expect(res.kind).toBe('answer')
    if (res.kind !== 'answer') throw new Error('unreachable')
    expect(res.answerArgs).toEqual([
      'DIVE-2818', '--value=approved', `--channel-proof=${CHAT}`, `--channel-msg=${MSG}`,
    ])
    // The tap path self-asserts --human because a callback carries no artifact.
    // Here the citation IS the evidence and the CLI raises human=1 itself once it
    // attests, so a self-asserted flag beside real evidence is noise at best.
    expect(res.answerArgs).not.toContain('--human')
  })

  test('a decision reply resolves against the gate OPTIONS, not a guess', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ship' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 ship', DM)
    expect(res.kind).toBe('answer')
    if (res.kind !== 'answer') throw new Error('unreachable')
    expect(res.value).toBe('ship')
  })

  test('option matching is case-insensitive but sends the CANONICAL spelling', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'SHIP' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 SHIP', DM)
    if (res.kind !== 'answer') throw new Error(`expected answer, got ${res.kind}`)
    expect(res.value).toBe('ship')
  })

  test('a manual gate takes done', () => {
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'done' }, open('manual'), CHAT, MSG, 'DIVE-1 done', DM).kind).toBe('answer')
  })

  test('a single-letter decision option still answers exactly', () => {
    // The shape lodar was actually given on DIVE-2803. The ident is what he
    // omitted then; with it present this is an exact option match.
    const res = resolveGateReply({ ident: 'DIVE-2803', value: 'B' }, open('decision', 'A|B'), CHAT, MSG, 'DIVE-2803 B', DM)
    if (res.kind !== 'answer') throw new Error(`expected answer, got ${res.kind}`)
    expect(res.value).toBe('B')
  })
})

describe('resolveGateReply — DMs only (iteration 2)', () => {
  // Not a preference. `_gate_channel_proof_ok` matches the chat id against
  // `^[0-9]+$` and a Telegram group id is negative, so a citation from a group
  // cannot attest — the rail could only ever refuse there, and would consume the
  // message on its way to refusing. #5dive is precisely where idents are discussed.
  test('a group message is never claimed, even when the value is exactly right', () => {
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'done' }, open('manual'), '-1001234567890', MSG, 'DIVE-2818 done', GROUP)
    expect(res.kind).toBe('elsewhere')
  })
  test('a group message on a SECRET gate is not claimed either', () => {
    // The secret carve-out below intercepts on type; it must not smuggle the
    // group path back in behind that.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'whats the holdup' }, open('secret'), '-1001234567890', MSG, 'DIVE-1 whats the holdup', GROUP)
    expect(res.kind).toBe('elsewhere')
  })
  test('the DM guard is checked before the gate is even consulted', () => {
    // Pinning the ORDER, because server.ts relies on it to skip the `task show`
    // subprocess entirely for group chatter.
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'done' }, null, '-1001', MSG, 'DIVE-1 done', GROUP).kind).toBe('elsewhere')
  })
})

describe('resolveGateReply — conversation about an OPEN gate falls through (iteration 2)', () => {
  // THE ARM THAT WAS MISSING. Iteration 1 returned `invalid` for any `DIVE-N
  // <text>` whose ident had an open gate, and server.ts stopped there — so this
  // message got a format lecture and never reached the agent. The old suite only
  // covered fall-through for CLOSED and MISSING gates, so nothing went red.
  test('a question about an open gate is relayed, not lectured', () => {
    const p = parseGateReply('DIVE-2818 whats the holdup')!
    const res = resolveGateReply(p, open('approval'), CHAT, MSG, 'DIVE-2818 whats the holdup', DM)
    expect(res.kind).toBe('chatter')
  })
  test('a comment on an open DECISION gate is relayed', () => {
    const p = parseGateReply('DIVE-1 looks good to me')!
    expect(resolveGateReply(p, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 looks good to me', DM).kind).toBe('chatter')
  })
  test('an unknown gate type has no answerable value, so it falls through', () => {
    // Iteration 1 returned `invalid` here and nudged with a literal "(none)",
    // which ate the message to print nothing useful.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'granted' }, open('access'), CHAT, MSG, 'DIVE-1 granted', DM)
    expect(res.kind).toBe('chatter')
  })
  test('a reply aimed straight at the gate alert IS claimed, however it is worded', () => {
    // The other half of the narrowing: pointing at the alert is itself the aim,
    // so this one earns the exact-string nudge rather than falling through.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'whatever you think' }, open('approval'), CHAT, MSG, 'DIVE-1 whatever you think', replyTo('DIVE-1'))
    expect(res.kind).toBe('invalid')
  })
  test("a reply to a DIFFERENT gate's alert does not claim this ident", () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'whatever you think' }, open('approval'), CHAT, MSG, 'DIVE-1 whatever you think', replyTo('DIVE-999'))
    expect(res.kind).toBe('chatter')
  })
})

describe('resolveGateReply — the secret carve-out', () => {
  // A secret gate's answer VALUE is the literal word `provided`. The credential
  // itself must never enter a persistent chat log (DIVE-145's carve-out, and
  // DIVE-2232 where a real human nearly sent one into a DM).
  test('accepts the literal token provided', () => {
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'provided' }, open('secret'), CHAT, MSG, 'DIVE-1 provided', DM).kind).toBe('answer')
  })
  test('REFUSES anything else on a secret gate, so free text cannot become the value', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ghp_examplenotreal' }, open('secret'), CHAT, MSG, 'DIVE-1 ghp_examplenotreal', DM)
    expect(res.kind).toBe('invalid')
  })
  test('the refusal does not echo what the human sent', () => {
    // A nudge that quotes the rejected text copies the credential into a SECOND
    // chat message, which is the leak the carve-out exists to prevent.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ghp_examplenotreal' }, open('secret'), CHAT, MSG, 'DIVE-1 ghp_examplenotreal', DM)
    if (res.kind !== 'invalid') throw new Error('expected invalid')
    expect(res.reply).not.toContain('ghp_examplenotreal')
  })
  test('a secret gate intercepts on TYPE, not on aim — the one exception to the narrowing', () => {
    // Deliberate, and the trade is stated rather than hidden: on a secret gate the
    // live risk is that the human just pasted a credential into permanent history,
    // and saying so is worth more than protecting a conversation we might be
    // interrupting. Nothing else in this file intercepts without unambiguous aim.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'any news on this' }, open('secret'), CHAT, MSG, 'DIVE-1 any news on this', DM)
    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') throw new Error('unreachable')
    expect(res.reply).toContain("don't send it here")
  })
})

describe('resolveGateReply — the near-miss nudge', () => {
  test('a wrong-but-close value on an OPEN gate nudges with the exact strings', () => {
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'approve' }, open('approval'), CHAT, MSG, 'DIVE-2818 approve', DM)
    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') throw new Error('unreachable')
    // Why strict rather than helpfully coercing "approve" to "approved": the CLI
    // requires the human's own text to CONTAIN the value we pass, and "approved"
    // is not a substring of "dive-2818 approve". Coercion would buy a refusal the
    // human reads as the feature being broken.
    expect(res.reply).toContain('DIVE-2818 approved')
    expect(res.reply).toContain('DIVE-2818 denied')
  })

  test('a single typo still counts as aim', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'aproved' }, open('approval'), CHAT, MSG, 'DIVE-1 aproved', DM)
    expect(res.kind).toBe('invalid')
  })

  test('the answer plus a pleasantry counts as aim', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ship it please' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 ship it please', DM)
    expect(res.kind).toBe('invalid')
  })

  test('a message that names the gate but not the answer cannot be answered', () => {
    // Mirrors condition 5 locally so we fail with a nudge instead of shelling a
    // command whose refusal is already predictable. The CLI still decides.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ship' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 something else entirely', DM)
    expect(res.kind).toBe('invalid')
  })

  test('no message id means no citation, and it refuses rather than clearing weakly', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'done' }, open('manual'), CHAT, undefined, 'DIVE-1 done', DM)
    expect(res.kind).toBe('invalid')
  })

  test('no synonym table: "no" is not resolved to "denied"', () => {
    // The rail's whole value is the human's literal words. Guessing meaning here
    // would be the wrong place to be clever, and the tap covers this human.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'no' }, open('approval'), CHAT, MSG, 'DIVE-1 no', DM)
    expect(res.kind).toBe('chatter')
  })
})

describe('resolveGateReply — what it must NOT claim', () => {
  test('a task with no open gate falls through (ordinary chat is not swallowed)', () => {
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'looks good to me' }, { need_type: null }, CHAT, MSG, 'DIVE-2818 looks good to me', DM)
    expect(res.kind).toBe('nogate')
  })
  test('an already-answered gate falls through', () => {
    const res = resolveGateReply(
      { ident: 'DIVE-1', value: 'approved' },
      { need_type: 'approval', need_answered_at: '2026-08-05 20:00:00' },
      CHAT, MSG, 'DIVE-1 approved', DM,
    )
    expect(res.kind).toBe('already')
  })
  test('a missing task falls through', () => {
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'approved' }, null, CHAT, MSG, 'DIVE-1 approved', DM).kind).toBe('nogate')
  })
  test('an already-answered gate is not resurrected by replying to its alert', () => {
    const res = resolveGateReply(
      { ident: 'DIVE-1', value: 'approved' },
      { need_type: 'approval', need_answered_at: '2026-08-05 20:00:00' },
      CHAT, MSG, 'DIVE-1 approved', replyTo('DIVE-1'),
    )
    expect(res.kind).toBe('already')
  })
})

describe('GATE_REPLY_RE', () => {
  test('does not swallow a trailing sentence into the answer value', () => {
    // Non-greedy + anchored: the value is what is there, not everything after the
    // ident. A value the human did not intend is the class this rail prevents.
    const p = parseGateReply('DIVE-1 approved thanks!')
    expect(p?.value).toBe('approved thanks!')
    // ...and that value is then rejected against the gate, rather than coerced —
    // but it still reads as aim, so the human gets the exact string back.
    expect(resolveGateReply(p!, open('approval'), CHAT, MSG, 'DIVE-1 approved thanks!', DM).kind).toBe('invalid')
  })
  test('is exported for the parity/lint surface', () => {
    expect(GATE_REPLY_RE).toBeInstanceOf(RegExp)
  })
})
