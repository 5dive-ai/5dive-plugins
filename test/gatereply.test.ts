// DIVE-2818 — the REPLY-TO-CLEAR resolver: which inbound messages become a
// non-forgeable gate clear, which become a nudge, and which must be left alone.
//
// The third category is the one with teeth. People discuss ticket idents in chat
// all day ("DIVE-2818 looks good to me"), so a resolver that claims every message
// matching the pattern would silently delete ordinary conversation from the
// agent's stream in order to answer a gate nobody meant to answer. Half these
// arms exist to pin the FALL-THROUGH, not the answer.
import { test, expect, describe } from 'bun:test'
import { parseGateReply, resolveGateReply, GATE_REPLY_RE } from '../plugins/telegram/gatereply'

// Reserved fakes only (repo rule): chat id 1234567890, never a real one.
const CHAT = '1234567890'
const MSG = 4242

const open = (need_type: string, need_options?: string) => ({ need_type, need_options: need_options ?? null, need_answered_at: null })

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
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'approved' }, open('approval'), CHAT, MSG, 'DIVE-2818 approved')
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
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ship' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 ship')
    expect(res.kind).toBe('answer')
    if (res.kind !== 'answer') throw new Error('unreachable')
    expect(res.value).toBe('ship')
  })

  test('option matching is case-insensitive but sends the CANONICAL spelling', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'SHIP' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 SHIP')
    if (res.kind !== 'answer') throw new Error(`expected answer, got ${res.kind}`)
    expect(res.value).toBe('ship')
  })

  test('a manual gate takes done', () => {
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'done' }, open('manual'), CHAT, MSG, 'DIVE-1 done').kind).toBe('answer')
  })
})

describe('resolveGateReply — the secret carve-out', () => {
  // A secret gate's answer VALUE is the literal word `provided`. The credential
  // itself must never enter a persistent chat log (DIVE-145's carve-out, and
  // DIVE-2232 where a real human nearly sent one into a DM).
  test('accepts the literal token provided', () => {
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'provided' }, open('secret'), CHAT, MSG, 'DIVE-1 provided').kind).toBe('answer')
  })
  test('REFUSES anything else on a secret gate, so free text cannot become the value', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ghp_examplenotreal' }, open('secret'), CHAT, MSG, 'DIVE-1 ghp_examplenotreal')
    expect(res.kind).toBe('invalid')
  })
  test('the refusal does not echo what the human sent', () => {
    // A nudge that quotes the rejected text copies the credential into a SECOND
    // chat message, which is the leak the carve-out exists to prevent.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ghp_examplenotreal' }, open('secret'), CHAT, MSG, 'DIVE-1 ghp_examplenotreal')
    if (res.kind !== 'invalid') throw new Error('expected invalid')
    expect(res.reply).not.toContain('ghp_examplenotreal')
  })
})

describe('resolveGateReply — the near-miss nudge', () => {
  test('a wrong-but-close value on an OPEN gate nudges with the exact strings', () => {
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'approve' }, open('approval'), CHAT, MSG, 'DIVE-2818 approve')
    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') throw new Error('unreachable')
    // Why strict rather than helpfully coercing "approve" to "approved": the CLI
    // requires the human's own text to CONTAIN the value we pass, and "approved"
    // is not a substring of "dive-2818 approve". Coercion would buy a refusal the
    // human reads as the feature being broken.
    expect(res.reply).toContain('DIVE-2818 approved')
    expect(res.reply).toContain('DIVE-2818 denied')
  })

  test('a message that names the gate but not the answer cannot be answered', () => {
    // Mirrors condition 5 locally so we fail with a nudge instead of shelling a
    // command whose refusal is already predictable. The CLI still decides.
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'ship' }, open('decision', 'ship|hold'), CHAT, MSG, 'DIVE-1 something else entirely')
    expect(res.kind).toBe('invalid')
  })

  test('no message id means no citation, and it refuses rather than clearing weakly', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'done' }, open('manual'), CHAT, undefined, 'DIVE-1 done')
    expect(res.kind).toBe('invalid')
  })
})

describe('resolveGateReply — what it must NOT claim', () => {
  test('a task with no open gate falls through (ordinary chat is not swallowed)', () => {
    const res = resolveGateReply({ ident: 'DIVE-2818', value: 'looks good to me' }, { need_type: null }, CHAT, MSG, 'DIVE-2818 looks good to me')
    expect(res.kind).toBe('nogate')
  })
  test('an already-answered gate falls through', () => {
    const res = resolveGateReply(
      { ident: 'DIVE-1', value: 'approved' },
      { need_type: 'approval', need_answered_at: '2026-08-05 20:00:00' },
      CHAT, MSG, 'DIVE-1 approved',
    )
    expect(res.kind).toBe('already')
  })
  test('a missing task falls through', () => {
    expect(resolveGateReply({ ident: 'DIVE-1', value: 'approved' }, null, CHAT, MSG, 'DIVE-1 approved').kind).toBe('nogate')
  })
  test('an unknown gate type yields no allowed values and never answers', () => {
    const res = resolveGateReply({ ident: 'DIVE-1', value: 'granted' }, open('access'), CHAT, MSG, 'DIVE-1 granted')
    expect(res.kind).toBe('invalid')
  })
})

describe('GATE_REPLY_RE', () => {
  test('does not swallow a trailing sentence into the answer value', () => {
    // Non-greedy + anchored: the value is what is there, not everything after the
    // ident. A value the human did not intend is the class this rail prevents.
    const p = parseGateReply('DIVE-1 approved thanks!')
    expect(p?.value).toBe('approved thanks!')
    // ...and that value is then rejected against the gate, rather than coerced.
    expect(resolveGateReply(p!, open('approval'), CHAT, MSG, 'DIVE-1 approved thanks!').kind).toBe('invalid')
  })
  test('is exported for the parity/lint surface', () => {
    expect(GATE_REPLY_RE).toBeInstanceOf(RegExp)
  })
})
