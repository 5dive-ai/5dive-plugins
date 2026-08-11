// DIVE-3267: /task's "Needs you" section partitions on the CLI's `needs_human`
// verdict, not on the presence of a gate.
//
// THE DEFECT. `const needsYou = tasks.filter((t: any) => t.need_type)` — "has an
// unanswered gate", not "needs a HUMAN" — with a comment above it in five of the six
// forks calling that presence "a clean needs-a-human flag". That is the premise
// DIVE-3224 disproved, written down as the justification for not looking. So "Needs
// you" listed every open gate in the fleet, including the ones routed to agent seats,
// rendered via taskRow(t, true) as act-on-me rows. lodar's complaint named /inbox
// because that is the command he typed; this is the same noise one command over.
//
// Found by main, grading DIVE-3224's merge, with an over-broad grep: searching
// `filter((t: any) => t.need_type)` rather than the precise form DIVE-3224 changed.
// A grep scoped exactly to what you fixed cannot show you what you did not.
//
// THREE BUCKETS, ONE PREDICATE — the arm that would have caught the obvious wrong fix.
// The base fork partitions into "Your tasks" / "Needs you" / "Open tasks", and
// need_type appeared in ALL THREE (once positive, twice negated). Changing only the
// first would have dropped every agent-routed gate out of all three sections: excluded
// from "Needs you" by the new predicate and from the other two by the old one. A row
// belonging to an agent would have vanished from the board instead of moving sections
// — a worse bug than the one being fixed, and invisible to any test that only checks
// what "Needs you" now contains. B1 asserts the negation moved with it.
//
// Source-text lock, per test/inbox-source.test.ts: server.ts long-polls on import.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SIX here, not the five of DIVE-3224: telegram-opencode has no /inbox and no
// buildActionableInbox, so it was correctly outside that row's scope and is inside
// this one. The count differing between the two rows IS the finding — see the
// method note above.
const FORKS = [
  'telegram', 'telegram-grok', 'telegram-agy', 'telegram-codex', 'telegram-pi',
  'telegram-opencode',
]

function src(fork: string): string {
  return readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
}
// Comments are stripped before any "the old form is gone" assertion. The first cut of
// this file did not, and every fork went red against the new code's OWN comment
// quoting `!t.need_type` while explaining why it was removed — a guard that cannot
// tell the code from the prose about the code. It also has to tolerate the fallback's
// `!!t.need_type`, which contains the forbidden string as a substring.
function codeOnly(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}
function partition(fork: string): string {
  const s = src(fork)
  const i = s.indexOf('const needsYou =')
  expect(i, `${fork}: no needsYou partition found`).toBeGreaterThan(-1)
  // Back up over the comment block, forward to the end of the bucket assignments.
  const start = Math.max(0, s.lastIndexOf('const MAX = 40', i))
  const end = s.indexOf('const sections', i)
  return s.slice(start, end > -1 ? end : i + 400)
}

describe.each(FORKS)('DIVE-3267 /task partition (%s)', (fork) => {
  const block = partition(fork)

  test('partitions on the CLI verdict, not on gate presence', () => {
    expect(block).toContain('Number(t.needs_human) === 1')
    expect(block).toContain('const needsYou = tasks.filter(needsHuman)')
    expect(block).not.toContain('tasks.filter((t: any) => t.need_type)')
  })

  test('B1 the negated buckets use the SAME predicate — no orphaned rows', () => {
    // Every remaining bucket must exclude via needsHuman(t). A leftover single-negated
    // `!t.need_type` in CODE is the orphaning bug in this file's header; the `!!` in
    // the fallback ternary is not (hence the leading [^!]).
    expect(codeOnly(block)).not.toMatch(/[^!]!t\.need_type/)
    expect(block).toContain('!needsHuman(t)')
  })

  test('falls back to the old reading on a CLI without the field', () => {
    expect(block).toContain("tasks.some((t: any) => t.needs_human !== undefined)")
    // The fallback must be the OLD filter, not `false`: absent-everywhere means an
    // older CLI, and treating that as "nothing needs a human" would empty the section
    // and hide the founder's own gates.
    expect(block).toContain('!!t.need_type')
  })

  test('does not re-derive the predicate from its inputs', () => {
    expect(block).not.toContain('routed_reviewer')
    expect(block).not.toContain('needs_capability')
    expect(block).not.toContain('tier')
  })
})

test('DIVE-3267 every fork got the same patch (no fork left behind)', () => {
  const shapes = FORKS.map((f) => {
    const b = partition(f)
    return [
      b.includes('const needsYou = tasks.filter(needsHuman)'),
      b.includes('Number(t.needs_human) === 1'),
      b.includes('!needsHuman(t)'),
      !/[^!]!t\.need_type/.test(codeOnly(b)),
    ].join('/')
  })
  expect(new Set(shapes).size).toBe(1)
  expect(shapes[0]).toBe('true/true/true/true')
})

// The remaining `need_type` reads in these files are NOT copies of the predicate, and
// this arm states that as a measurement rather than leaving it as something a future
// reader has to re-audit. Both survivors filter rows that ALREADY came from
// `task inbox --json` — the CLI's human view — so they narrow within the human set and
// cannot readmit an agent-routed gate. If either ever gets re-sourced from `task ls`,
// this arm goes red and names the file.
test('DIVE-3267 the surviving need_type reads are scoped to the CLI human view', () => {
  for (const fork of FORKS) {
    const s = src(fork)
    const hits = s.split('\n').filter((l) => /filter\(\(t: any\) => t\.need_type/.test(l))
    for (const line of hits) {
      expect(line, `${fork}: a need_type filter not sourced from data.inbox`).toContain('j.data.inbox')
    }
  }
})
