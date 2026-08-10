// DIVE-3088: source tripwire for the ONE CLI-read budget.
//
// THE BUG: every read5diveJson() call site named its own timeout — 3000 here,
// 5000 there, 8000 for `task inbox` — each picked by eye against whatever box
// the author was sitting on. `/account` then rendered "Failed to list accounts"
// on slow VMs, because `account list --json` measured ~3.12s there against a
// 3000ms budget, and on timeout the child is killed BEFORE it prints: e.stdout
// is empty, so the DIVE-125 salvage-nonzero-exit path has nothing to salvage.
//
// THE FIX was not a bigger number at that one site. Measured on healthy
// hardware, `agent list --json` (~2.07s, three call sites, all on 3000ms) sat
// NEARER its budget than `account list --json` (~1.58s) — so on a slower box
// `agent list` breaches first or alongside and /account keeps flapping with the
// reported one-line fix applied. The fix is the single CLI_READ_MS default.
//
// WHY A SOURCE SCAN AND NOT A UNIT TEST: the defect is a NUMBER TYPED AT A CALL
// SITE. Nothing about a correct default stops the next contributor from typing
// `, 3000)` on a new call, and no behavioural assertion on read5diveJson can
// see that they did. The only test that can fail on it reads the call sites.
//
// This suite is deliberately one-directional: a LARGER explicit budget is fine
// (the auth flows wait on a remote device-code round-trip and legitimately need
// 10000/15000). Only a budget BELOW the shared default is a regression, because
// that is the class that made someone else's box the reference hardware.
//
// BOUNDARY, stated so this is not read as full coverage (main, reviewing): it
// matches a LITERAL budget in the source text, so a call site passing a computed
// or variable timeout is invisible to it. That is the intended trade — the
// literal form is what the next contributor will actually type — but a green run
// means "no literal sub-default budget", not "no sub-default budget".

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

// `read5diveJson(<args>, <n>)` — the trailing numeric literal is the budget.
// Args can contain nested brackets/backticks, so match up to the LAST comma
// before a bare integer + `)`, non-greedily anchored on the call name.
const EXPLICIT_BUDGET = /read5diveJson\((?:[^()]|\([^()]*\))*?,\s*(\d+)\s*\)/g

describe('DIVE-3088 — one CLI-read budget, not a per-call-site guess', () => {
  test('CLI_READ_MS is declared and is the default parameter of read5diveJson', () => {
    expect(SRC).toMatch(/const CLI_READ_MS = (\d+)/)
    // The default must reference the constant, not restate a literal — a second
    // copy of the number is a second thing to forget.
    expect(SRC).toMatch(/async function read5diveJson\([^)]*timeout: number = CLI_READ_MS/)
  })

  test('CLI_READ_MS is at least the slowest measured read plus headroom', () => {
    const declared = Number(SRC.match(/const CLI_READ_MS = (\d+)/)![1])
    // `agent list --json` measured ~2.07s on healthy hardware and ~3.12s was
    // seen for `account list --json` on an old VM. 8000 is ~2.5x the slowest
    // observation; anything under 5000 puts a slow box back inside the failure.
    expect(declared).toBeGreaterThanOrEqual(5000)
  })

  test('no call site names a budget BELOW the shared default', () => {
    const declared = Number(SRC.match(/const CLI_READ_MS = (\d+)/)![1])
    const offenders: number[] = []
    for (const m of SRC.matchAll(EXPLICIT_BUDGET)) {
      const ms = Number(m[1])
      if (ms < declared) offenders.push(ms)
    }
    // A larger explicit budget is allowed (auth flows); a smaller one is the
    // regression this row exists to prevent.
    expect(offenders).toEqual([])
  })

  test('the scan can actually see a call site (non-vacuity)', () => {
    // A regex that matches nothing passes the assertion above forever. Prove it
    // still finds the auth-flow budgets, which are SUPPOSED to be explicit.
    const found = [...SRC.matchAll(EXPLICIT_BUDGET)].map((m) => Number(m[1]))
    expect(found.length).toBeGreaterThan(0)
    expect(Math.max(...found)).toBeGreaterThanOrEqual(10000)
  })

  test('the scan would FAIL on a reintroduced sub-default budget (mutation control)', () => {
    const declared = Number(SRC.match(/const CLI_READ_MS = (\d+)/)![1])
    const mutated = SRC.replace(
      "read5diveJson(['account', 'list', '--json'])",
      "read5diveJson(['account', 'list', '--json'], 3000)",
    )
    expect(mutated).not.toBe(SRC) // the call site we mutate must still exist
    const offenders = [...mutated.matchAll(EXPLICIT_BUDGET)]
      .map((m) => Number(m[1]))
      .filter((ms) => ms < declared)
    expect(offenders).toEqual([3000])
  })
})
