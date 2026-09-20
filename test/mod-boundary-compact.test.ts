// Boundary compaction on the non-fresh seats (DIVE-4695).
//
// What this grades and what it cannot. The decision — "does THIS boundary compact?"
// — and the continuity pin are both pure functions taking plain data, so the whole
// safety argument of the row is decidable here without a Claude Code process:
//
//   1. the three gates (opted in, between turns, above the threshold) and every
//      refusal naming itself, because the 24h A/B the row owes is read off the
//      refusals as much as off the compactions;
//   2. the pin: an unanswered human gate, a standing directive from the paired human
//      or an open row's branch that the compaction DROPPED comes back verbatim. The
//      row calls continuity loss the failure mode — "a compaction that drops a lodar
//      directive is worse than the tokens it saved" — so this is the arm that decides
//      whether the feature may exist at all;
//   3. that a malformed knob turns the feature OFF rather than falling back to a
//      default nobody chose. A typo in a seat's settings must not start compacting a
//      live window at a threshold that was never picked.
//
// What it cannot grade is the SUMMARY: whether the engine's summarizer, told
// COMPACT_INSTRUCTIONS, keeps the obligations it was asked to keep. That is why the
// pin is structural and the instructions are only belt-and-braces — the arms below
// pin the structure, and the live reading is on DIVE-4695.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'plugins', 'mod')
const SRC = readFileSync(join(ROOT, 'hooks', 'register.ts'), 'utf8')

const { compactThreshold, pinFor, compactDecision, pinKept, percentOf } = await import(
  join(ROOT, 'hooks', 'register.ts')
)

const ON = { FIVEDIVE_MOD_BOUNDARY_COMPACT: '1' }

describe('the seat opts in, or nothing happens', () => {
  test('absent is off — which is every seat that has not been changed', () => {
    expect(compactThreshold({})).toBeNull()
    expect(compactThreshold({ FIVEDIVE_MOD_BOUNDARY_COMPACT: '0' })).toBeNull()
    expect(compactThreshold({ FIVEDIVE_MOD_BOUNDARY_COMPACT: 'true' })).toBeNull()
  })

  test('opted in with no threshold takes the documented default', () => {
    expect(compactThreshold(ON)).toBe(50)
  })

  test('a threshold the seat chose is the threshold', () => {
    expect(compactThreshold({ ...ON, FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT: '70' })).toBe(70)
    expect(compactThreshold({ ...ON, FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT: '1' })).toBe(1)
    expect(compactThreshold({ ...ON, FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT: '99' })).toBe(99)
  })

  test('a malformed threshold is OFF, never the default', () => {
    // The failure this forbids: a seat writes "50%" or "0.5" or "eighty", the mod
    // silently falls back to 50, and a live window starts compacting at a number
    // nobody chose. Off is the only safe reading of "I meant something else".
    // ('' is not in this list: an unset knob is "take the default", asserted above.)
    for (const bad of ['50%', '0.5', 'eighty', ' 50', '-1', '1000', '5 0']) {
      expect(compactThreshold({ ...ON, FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT: bad })).toBeNull()
    }
    // 0 would compact an empty window on every boundary; 100 is unreachable before
    // the engine's own auto-compaction has already run.
    expect(compactThreshold({ ...ON, FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT: '0' })).toBeNull()
    expect(compactThreshold({ ...ON, FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT: '100' })).toBeNull()
  })

  test('an uncompilable pin answers null, and resolveState turns the feature off with it', () => {
    expect(pinFor({})).toBeInstanceOf(RegExp)
    expect(pinFor({ FIVEDIVE_MOD_BOUNDARY_COMPACT_PIN: '(unclosed' })).toBeNull()
    // The pin IS the continuity guarantee, so "on but unpinned" must not exist. The
    // wiring that enforces it lives in resolveState.
    expect(SRC).toContain('if (compactAt !== null && pin === null) {')
    expect(SRC).toContain('compactAt = null')
  })
})

describe('a boundary is a boundary', () => {
  const base = { compactAt: 50, percent: 80, inTurn: false, alreadyRunning: false }

  test('above the threshold, between turns, it goes', () => {
    expect(compactDecision(base)).toEqual({ go: true })
    expect(compactDecision({ ...base, percent: 50 })).toEqual({ go: true })
  })

  test('NEVER mid-turn — the row constraint, and the call rejects there anyway', () => {
    // `$.session.compact()` "rejects while a turn runs" (2.1.278). session.measure
    // fires after each main-thread turn AND when a rate-limit window moves a whole
    // point, and the second kind lands anywhere, so the gate is the mod's own
    // turn.start/turn.complete tracking and not the event's timing.
    expect(compactDecision({ ...base, inTurn: true })).toEqual({ go: false, why: 'mid-turn' })
  })

  test('off is off at any fill', () => {
    expect(compactDecision({ ...base, compactAt: null, percent: 99 })).toEqual({
      go: false,
      why: 'off',
    })
  })

  test('below the threshold it declines', () => {
    expect(compactDecision({ ...base, percent: 49 })).toEqual({
      go: false,
      why: 'below-threshold',
    })
  })

  test('no reading is not 0% used', () => {
    // The blind-meter distinction the plugin already respects for the sink lines,
    // applied to the decision: a window whose fill the engine has not reported is
    // not an empty window, and compacting one on that reading would be a compaction
    // nobody asked for.
    expect(compactDecision({ ...base, percent: undefined })).toEqual({
      go: false,
      why: 'no-reading',
    })
  })

  test('one compaction at a time', () => {
    expect(compactDecision({ ...base, alreadyRunning: true })).toEqual({
      go: false,
      why: 'in-flight',
    })
  })

  test('every refusal names itself, so a quiet pilot is distinguishable from a working one', () => {
    const whys = new Set<string>()
    for (const d of [
      compactDecision({ ...base, compactAt: null }),
      compactDecision({ ...base, inTurn: true }),
      compactDecision({ ...base, alreadyRunning: true }),
      compactDecision({ ...base, percent: undefined }),
      compactDecision({ ...base, percent: 1 }),
    ]) {
      expect(d.go).toBe(false)
      if (!d.go) whys.add(d.why)
    }
    expect(whys.size).toBe(5)
  })
})

describe('continuity: what must survive a compaction does', () => {
  const pin = pinFor({})!
  const m = (text: string, handle?: string) => ({ role: 'user' as const, text, handle })

  const GATE = m(
    '5dive task need DIVE-4321 --type=approval --ask="Ship the pricing page change?"',
    'h1',
  )
  const DIRECTIVE = m('lodar: never send marketing a draft without a screenshot', 'h2')
  const ROW = m('Working DIVE-4695. Branch: dive-4695-boundary-compact', 'h3')
  const CHATTER = m('ran the tests, 41 arms, all green', 'h4')

  const before = [GATE, DIRECTIVE, ROW, CHATTER]

  test('a compaction that kept everything is handed back untouched', () => {
    const summary = { role: 'assistant' as const, text: 'summary', handle: 's' }
    const kept = [summary, GATE, DIRECTIVE, ROW]
    const out = pinKept(pin, before, kept)
    expect(out.pinned).toBe(0)
    expect(out.messages).toBe(kept)
  })

  test('a dropped gate, directive and branch all come back, verbatim and in order', () => {
    // The row's failure mode in one arm: the summarizer kept the chatter and dropped
    // the obligations. Instructions are a request; this is the guarantee.
    const summary = { role: 'assistant' as const, text: 'the agent did some work', handle: 's' }
    const out = pinKept(pin, before, [summary])
    expect(out.pinned).toBe(3)
    expect(out.messages.map((x) => x.handle)).toEqual(['s', 'h1', 'h2', 'h3'])
    // verbatim — not a paraphrase, not a truncation
    expect(out.messages[1]!.text).toBe(GATE.text)
    expect(out.messages[2]!.text).toBe(DIRECTIVE.text)
  })

  test('what the summary is FOR is not pinned', () => {
    const summary = { role: 'assistant' as const, text: 'summary', handle: 's' }
    const out = pinKept(pin, [CHATTER], [summary])
    expect(out.pinned).toBe(0)
    expect(out.messages.map((x) => x.handle)).toEqual(['s'])
  })

  test('a paraphrase in the summary does not count as keeping it', () => {
    // Identity is the engine's handle, never the text. A summary saying "there is an
    // open approval gate" is exactly the loss the row names: the seat can no longer
    // answer it, because the question is gone.
    const paraphrase = {
      role: 'assistant' as const,
      text: 'There is an unanswered approval gate about the pricing page.',
      handle: 's',
    }
    const out = pinKept(pin, [GATE], [paraphrase])
    expect(out.pinned).toBe(1)
    expect(out.messages.at(-1)!.text).toBe(GATE.text)
  })

  test('a runaway predicate pins the newest MAX_PINS and says how many', () => {
    // A pattern that matches half the window would defeat the compaction while
    // looking like it worked. The cap makes that visible on the sink line instead.
    const many = Array.from({ length: 40 }, (_, i) => m(`DIVE-${1000 + i} in flight`, `k${i}`))
    const out = pinKept(pin, many, [])
    expect(out.pinned).toBe(12)
    expect(out.messages.map((x) => x.handle)).toEqual(
      Array.from({ length: 12 }, (_, i) => `k${28 + i}`),
    )
  })

  test('no pin means pass-through: a seat that did not opt in is never touched', () => {
    const kept = [{ role: 'assistant' as const, text: 'summary', handle: 's' }]
    const out = pinKept(null, before, kept)
    expect(out.pinned).toBe(0)
    expect(out.messages).toBe(kept)
  })

  test('the default pin covers each thing the row names, and not the rest', () => {
    for (const t of [
      '5dive task need DIVE-1 --type=decision --ask="which one?"',
      'lodar said: cap it at 60 words',
      'Branch: dive-4695-boundary-compact',
      'DIVE-4695 is in progress',
      'gate cleared — resume the task',
    ]) {
      expect(pin.test(t)).toBe(true)
    }
    for (const t of ['ran bun test', 'the file is at src/task/need.sh', 'pushed the branch']) {
      expect(pin.test(t)).toBe(false)
    }
  })
})

describe('the compaction can neither delay a turn nor fail one', () => {
  test('the trigger never awaits the compaction', () => {
    // Not `await considerBoundary(...)` / `await startCompaction(...)`, and both
    // return void, so neither trigger can be delayed by a model call.
    expect(SRC).not.toMatch(/await\s+(considerBoundary|startCompaction)/)
    expect(SRC).toContain('function considerBoundary($: EngineInterface, s: Live, percent: number | undefined): void {')
    expect(SRC).toContain('function startCompaction($: EngineInterface, s: Live, percent: number): void {')
  })

  test('the compaction has its OWN chain, and it is not the writer\'s', () => {
    // Iteration 1 queued $.session.compact() on `flush`, the chain record() writes on.
    // Structural half of the fix (the behavioural half is in mod-telemetry.test.ts):
    // the writer still owns `flush`, the compaction owns `compactChain`, and no
    // $.session.compact call is ever assigned back into `flush`.
    expect(SRC).toContain('let compactChain: Promise<void> = Promise.resolve()')
    expect(SRC).toContain('compactChain = compactChain\n    .then(() => $.session.compact(')
    expect(SRC).toContain('flush = flush.then(() => $.fs.write(path, text))')
    expect(SRC).not.toMatch(/flush\s*=\s*flush[\s\S]{0,80}\$\.session\.compact/)
  })

  test('turn.complete is the PRIMARY boundary, and it decides AFTER clearing inTurn', () => {
    // Measured on Claude Code 2.1.278, 2026-09-20: `session.measure` fired BEFORE
    // `turn.complete` in a headless run, so the mod's own turn-gate refused it
    // (`compact.skip reason=mid-turn percent=3`). A trigger that trusted the
    // declaration's "fires after each main-thread turn" would have called
    // $.session.compact() mid-turn, where it rejects. This arm pins the fix: the
    // boundary is considered from turn.complete, after inTurn is cleared.
    const body = /^  on\('turn\.complete'.*?^  \}\)/gms.exec(SRC)?.[0] ?? ''
    expect(body).not.toBe('')
    expect(body.indexOf('inTurn = false')).toBeGreaterThan(-1)
    expect(body.indexOf('considerBoundary($, s, percentOf(u))')).toBeGreaterThan(
      body.indexOf('inTurn = false'),
    )
    // measure stays wired as the second trigger, for a boundary it raises cleanly
    const measure = /^  on\('session\.measure'.*?^  \}\)/gms.exec(SRC)?.[0] ?? ''
    expect(measure).toContain('considerBoundary($, s, e.context.percent)')
  })

  test('the fill is narrowed in exactly one place, and a non-number is no reading', () => {
    expect(percentOf({ context: { percent: 62 } })).toBe(62)
    expect(percentOf({ context: { percent: 0 } })).toBe(0)
    expect(percentOf(undefined)).toBeUndefined()
    expect(percentOf({})).toBeUndefined()
    expect(percentOf({ context: {} })).toBeUndefined()
    // A string is not a reading. `compactDecision` turns undefined into
    // `no-reading`, which is NOT the same as 0% used.
    expect(percentOf({ context: { percent: '62' } } as never)).toBeUndefined()
  })

  test('both outcomes of the compaction are handled, and both are recorded', () => {
    // A rejection here is EXPECTED — a turn starting while the call was queued is the
    // common one — so it must be a counted line, not an unhandled rejection and not
    // silence. The sink is where the pilot reads the A/B.
    expect(SRC).toContain("event: 'compact.done'")
    expect(SRC).toContain("event: 'compact.skip'")
    expect(SRC).toContain("reason: `rejected: ${String(err)}`")
    // and the in-flight latch is released on BOTH paths, or the feature stops after
    // its first refusal and looks exactly like a feature that is switched off
    // Indented assignments only — the `let compacting = false` declaration is at
    // column 0 and is not one of the two releases.
    expect([...SRC.matchAll(/^\s+compacting = false$/gm)].length).toBe(2)
  })

  test('the token counts are recorded absent, never zeroed', () => {
    expect(SRC).toContain('...(r.tokensBefore === undefined ? {} : { tokens_before: r.tokensBefore })')
    expect(SRC).toContain('...(r.tokensAfter === undefined ? {} : { tokens_after: r.tokensAfter })')
  })
})
