// DIVE-3224: /inbox must be sourced from the CLI's `task inbox --json` — the view
// that already knows which gates wait on a HUMAN — and must not re-derive that
// split plugin-side.
//
// THE DEFECT. buildActionableInbox shelled `task ls --json` and kept every row
// carrying a `need_type`: "has an unanswered gate", not "needs a human". Measured
// 2026-08-11 on lodar's chat — 12 gates listed, 3 actually his; the other 9 were
// routed to agent seats (dev, dev2, dev3, cli, main2, quinn) and each rendered a
// ✅ apply-the-recommendation button on a question addressed to somebody else. The
// honest reason it drifted is in the old comment: `task inbox --json` withheld
// `tier`, which the button path needs. So the CLI now exports `tier` and the copy
// here is deleted.
//
// WHY A SOURCE-TEXT LOCK. server.ts long-polls on import (see banner.test.ts), so
// buildActionableInbox cannot be called headlessly; parity.test.ts sets the
// precedent for grading fork text directly. The assertions are therefore written
// against the SHAPE that would regress: a `task ls` call inside this function, a
// hand-rolled `need_type` filter, or a fork left behind on the old source. Each
// arm asserts the new form AND the absence of the old one, so a half-applied
// patch is red rather than half-green.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LINEAGES = ['telegram', 'telegram-grok', 'telegram-agy', 'telegram-codex', 'telegram-pi']

function actionableInbox(fork: string): string {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
  const start = src.indexOf('async function buildActionableInbox(')
  expect(start, `${fork}: buildActionableInbox not found`).toBeGreaterThan(-1)
  // Bounded at the next top-level declaration so a later function's `task ls`
  // call (buildInboxList legitimately has one) can never satisfy these arms.
  const rest = src.slice(start + 1)
  const endRel = rest.search(/\n(async function|function|const|\/\/ ---) /)
  return rest.slice(0, endRel > -1 ? endRel : rest.length)
}

describe.each(LINEAGES)('DIVE-3224 /inbox source (%s)', (fork) => {
  const fn = actionableInbox(fork)

  test('shells `task inbox --json`, never `task ls --json`', () => {
    expect(fn).toContain("'task', 'inbox', '--json'")
    expect(fn).not.toContain("'task', 'ls', '--json'")
  })

  test('reads data.inbox, not data.tasks', () => {
    expect(fn).toContain('j.data?.inbox')
    expect(fn).toContain('const pending = j.data.inbox')
    expect(fn).not.toContain('j.data.tasks')
    expect(fn).not.toContain('j.data?.tasks')
  })

  test('keeps NO local pending-gate filter — the predicate lives in the CLI', () => {
    // The exact copy that caused the defect, plus the shape of any re-derivation
    // of the routing half (which the CLI owns and has since grown a fourth clause).
    expect(fn).not.toContain('filter((t: any) => t.need_type)')
    expect(fn).not.toContain('routed_reviewer')
    expect(fn).not.toContain('needs_capability')
  })

  test('an absent/unparseable tier reads as 2 — no plugin-minted ✅ on an unproven gate', () => {
    expect(fn).toContain('return Number.isFinite(tr) ? tr : 2')
    // The pre-fix classifier dropped an unknown-tier gate from BOTH sets, so it
    // got neither an inline button nor the nonce digest.
    expect(fn).not.toContain('Number.isFinite(tr) && tr >= 2')
  })

  test('reports the gates it withheld, so a filtered inbox differs from an empty fleet', () => {
    expect(fn).toContain('routed_elsewhere')
    expect(fn).toContain('routedNote')
    expect(fn).toContain('not yours to answer')
  })
})

test('DIVE-3224 every lineage got the same patch (no fork left behind)', () => {
  const shapes = LINEAGES.map((f) => {
    const fn = actionableInbox(f)
    return [
      fn.includes("'task', 'inbox', '--json'"),
      fn.includes('const pending = j.data.inbox'),
      fn.includes('return Number.isFinite(tr) ? tr : 2'),
      fn.includes('routedNote'),
    ].join('/')
  })
  expect(new Set(shapes).size).toBe(1)
  expect(shapes[0]).toBe('true/true/true/true')
})
