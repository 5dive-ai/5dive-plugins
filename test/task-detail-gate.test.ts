// DIVE-3340 (reported by lodar 2026-08-12, from a CUSTOMER VM through this plugin):
// /task_<id> on a row with a pending gate must SAY the gate is there and NAME the
// route that answers it.
//
// THE DEFECT, and it is three-sided. He tried to clear a gated row and every exit he
// was offered was one he could not take:
//   1. `task cancel` refused over the open gate and named only `task need --withdraw`;
//   2. `--withdraw` authorizes on human/filer/lead/coordinator, and a person typing
//      into a bot is NONE of those — the command executes on an agent seat and the
//      human's identity deliberately does not travel through the chat (DIVE-1401 /
//      DIVE-2330 fail closed on purpose, and must keep doing so);
//   3. the surface he was actually looking at — this one — did not mention the gate,
//      the ask, or the answer route at all. Its keyboard offered ▶️ Do now / 🔺
//      Escalate / ✅ Done / 🚫 Cancel, and the two close verbs are BOTH refused over
//      an open gate (DIVE-555, DIVE-2773). So the row read as uncloseable from every
//      control in front of him, and the answer surface — the gate's own alert message,
//      carrying the DIVE-916 per-gate nonce — was never pointed at.
// (1) and (2) are fixed CLI-side. This file grades (3).
//
// WHY THIS IS A RENDER AND NOT A SOURCE-TEXT LOCK. The house pattern here is text
// locking, because server.ts long-polls on import (banner.test.ts). But a substring
// assertion on prose is blind to a rewrite that inverts the claim, and the row asked
// for a control that can FAIL: "build a fixture row with a pending manual gate, render
// the view, and assert the output contains the answer route. Today's keyboard passes
// any test that only checks the four existing buttons are present." So the gate block
// is EXTRACTED from each shipped fork and EXECUTED against fixture rows. It closes
// over nothing but `t` and `lines`, which is what makes that possible without
// importing the long-polling module — the assertions below grade the strings a real
// reader would receive, not the source that produces them.
//
// WHY EVERY LINEAGE. The forks copy this region rather than importing it:
// telegram-agy is generated from telegram-grok, and telegram-{codex,pi,opencode} are
// hand-maintained. A port done with an unscoped regex has silently deleted a function
// from four of five lineages before (DIVE-3279), and only per-lineage arms caught it.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SIX, matching task-needs-human.test.ts: telegram-opencode has no /inbox but it does
// have buildTaskDetail, so it is in scope here.
const LINEAGES = [
  'telegram', 'telegram-grok', 'telegram-agy', 'telegram-codex', 'telegram-pi',
  'telegram-opencode',
]

function source(fork: string): string {
  return readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
}

/** The gate block inside buildTaskDetail, bounded by brace depth so a later `if` in
 *  the same function cannot be swept in. Anchored INSIDE buildTaskDetail first, so a
 *  same-shaped predicate elsewhere in the file (inboxCard has one) can never satisfy
 *  these arms. */
function gateBlock(fork: string): string {
  const src = source(fork)
  const fnStart = src.indexOf('async function buildTaskDetail(')
  expect(fnStart, `${fork}: buildTaskDetail not found`).toBeGreaterThan(-1)
  const fn = src.slice(fnStart)
  const rel = fn.indexOf('if (t.need_type && !t.need_answered_at) {')
  expect(rel, `${fork}: buildTaskDetail has no pending-gate block`).toBeGreaterThan(-1)
  // The block must be inside buildTaskDetail, not in whatever follows it.
  const fnEnd = fn.search(/\n(async function|function|const|\/\/ ---) /)
  expect(fnEnd === -1 || rel < fnEnd, `${fork}: the gate block is outside buildTaskDetail`).toBe(true)
  let depth = 0
  let i = fn.indexOf('{', rel)
  const open = i
  for (; i < fn.length; i++) {
    if (fn[i] === '{') depth++
    else if (fn[i] === '}') { depth--; if (depth === 0) break }
  }
  // The WHOLE statement, condition included — slicing the body alone would drop the
  // predicate and make the answered-gate arm below unfalsifiable (it did, first cut).
  return fn.slice(rel, i + 1)
}

/** Execute the shipped block against a fixture row and return the lines a reader gets.
 *  `lines` and `t` are the block's only free names — asserted by the fact that this
 *  throws loudly if that ever stops being true, rather than silently rendering less. */
function render(fork: string, t: Record<string, unknown>): string {
  const body = `const lines = []; ${gateBlock(fork)}; return lines`
  const fn = new Function('t', body) as (t: unknown) => string[]
  return fn(t).join('\n')
}

const DECISION = {
  id: 350, ident: 'DIVE-350', need_type: 'decision', need_answered_at: null,
  ask: 'which surface ships first?', need_options: 'A|B', recommend: 'B',
}
const MANUAL = { id: 350, ident: 'DIVE-350', need_type: 'manual', need_answered_at: null, ask: 'rotate the key by hand' }
const SECRET = { id: 350, ident: 'DIVE-350', need_type: 'secret', need_answered_at: null, ask: 'provide the API token' }

describe.each(LINEAGES)('DIVE-3340 /task_<id> surfaces a pending gate (%s)', (fork) => {
  // NON-VACUITY FIRST. Every arm below is an assertion about rendered text, so an
  // extractor that silently returned '' would make all of them pass on an empty
  // string. This is the arm that fails when the block is deleted rather than broken.
  test('the block exists, renders, and produces output', () => {
    expect(gateBlock(fork).length).toBeGreaterThan(200)
    expect(render(fork, MANUAL).length).toBeGreaterThan(80)
  })

  test('a pending gate is ANNOUNCED as needing a human answer', () => {
    const out = render(fork, DECISION)
    expect(out).toContain('PENDING DECISION GATE')
    expect(out).toContain('HUMAN ANSWER')
  })

  test('the ask, its options and the recommendation reach the reader', () => {
    const out = render(fork, DECISION)
    expect(out).toContain('which surface ships first?')
    expect(out).toContain('A|B')
    expect(out).toContain('rec: B')
  })

  // THE ARM THE ROW ASKED FOR. The pre-DIVE-3340 view rendered none of this, and
  // passed every test that only checked the four buttons were present.
  test('the ANSWER ROUTE is named, with the ident the reader would type', () => {
    for (const fixture of [DECISION, MANUAL, SECRET]) {
      expect(render(fork, fixture)).toContain('5dive task answer DIVE-350')
    }
  })

  test('a decision gate gets the --value form', () => {
    expect(render(fork, DECISION)).toContain('--value=<answer>')
  })

  // Publishing the wrong verb is the same defect one layer down: a route that
  // refuses. A secret must never be typed into chat (Telegram keeps history) and a
  // manual gate records that the step was PERFORMED — both take NO --value. A single
  // hardcoded sentence would pass the arm above and be wrong on two of three types.
  test.each([['manual', MANUAL], ['secret', SECRET]] as const)(
    'a %s gate is told NO --value, and never shown the --value form', (_name, fixture) => {
      const out = render(fork, fixture)
      expect(out).toContain('NO --value')
      expect(out).not.toContain('--value=<answer>')
    })

  test('a secret is redirected out-of-band rather than into the chat', () => {
    expect(render(fork, SECRET)).toContain('out-of-band')
  })

  // The clause that makes the keyboard legible instead of just present. Both close
  // verbs ARE refused over an open gate; saying so is the difference between a
  // reader who answers and a reader who concludes the row is dead.
  test('the reader is told Done and Cancel will be REFUSED until it is answered', () => {
    const out = render(fork, DECISION)
    expect(out).toContain('REFUSED')
    expect(out).toMatch(/Done and .*Cancel/)
  })

  // THE CONDITION, graded in the direction that matters. A block that rendered
  // unconditionally would pass every arm above and put a "pending gate" banner on
  // every row in the fleet — including answered ones, whose gate is settled.
  test('an ANSWERED gate renders nothing, and so does an ungated row', () => {
    expect(render(fork, { ...DECISION, need_answered_at: '2026-08-12 12:00:00' })).toBe('')
    expect(render(fork, { id: 350, ident: 'DIVE-350', need_type: null, need_answered_at: null })).toBe('')
  })

  // An ask carrying options must not be truncated — chopping the last option makes a
  // reader answer a question they cannot see (the inboxCard rule, mirrored).
  test('a long ask WITH options is not truncated', () => {
    const long = 'x'.repeat(600)
    expect(render(fork, { ...DECISION, ask: long })).toContain(long)
    expect(render(fork, { ...MANUAL, ask: long, need_options: null })).toContain('…')
  })
})

// A DELIBERATE LINEAGE DIFFERENCE, asserted rather than left to drift. /inbox
// re-sends every pending gate WITH its tap buttons, so it is the recovery when the
// original alert has scrolled away — the half of the incident a static route note
// does not fix. It is named ONLY on the claude lineage because only that lineage
// registers the command (task-needs-human.test.ts records telegram-opencode's lack of
// it), and naming a command a fork does not have is a citation to a route that does
// not exist. Asserted in BOTH directions so neither the pointer nor its absence can
// quietly flip.
describe('DIVE-3340 the /inbox recovery pointer is claude-lineage only', () => {
  test('plugins/telegram names it', () => {
    expect(render('telegram', MANUAL)).toContain('/inbox')
  })
  test.each(LINEAGES.filter((l) => l !== 'telegram'))('%s does not', (fork) => {
    expect(render(fork, MANUAL)).not.toContain('/inbox')
  })
})
