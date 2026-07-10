// DIVE-1107 regression coverage for the resume-storm dedup primitives.
//
// Run: `bun test` from plugins/telegram (bun auto-discovers *.test.ts).
//
// Covers (1) claimNotify's exit/concurrency-independent per-episode gate — the
// property stopfailure-notify now leans on to cap BOTH the DM and the resume
// helper spawn to one-per-episode — and (2) pruneOldResumeLogs keeping the
// never-pruned resume-*.log dir bounded.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  claimNotify,
  notifyStampPath,
  pruneOldResumeLogs,
  NOTIFY_COOLDOWN_MS,
} from './notify-dedup'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dive1107-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('claimNotify: one episode -> exactly one send across a rapid re-trigger storm', () => {
  const stamp = notifyStampPath(dir, 'marketing:ratelimit', null)
  const t0 = 1_000_000
  // First claim sends (start recovery); every re-trigger within the sliding
  // window suppresses — this is the loop that spammed ~100 banners.
  expect(claimNotify(stamp, t0).send).toBe(true)
  let sends = 0
  for (let i = 1; i <= 200; i++) {
    // re-triggers a few seconds apart, as observed in the marketing burst
    if (claimNotify(stamp, t0 + i * 2000).send) sends++
  }
  expect(sends).toBe(0)
})

test('claimNotify: a genuinely new episode after the window re-sends', () => {
  const stamp = notifyStampPath(dir, 'marketing:ratelimit', null)
  const t0 = 5_000_000
  expect(claimNotify(stamp, t0).send).toBe(true)
  // Just inside the window: suppressed.
  expect(claimNotify(stamp, t0 + NOTIFY_COOLDOWN_MS - 1).send).toBe(false)
  // Past the window with no intervening touch: reclaim + send.
  const later = t0 + NOTIFY_COOLDOWN_MS - 1 + NOTIFY_COOLDOWN_MS + 1
  expect(claimNotify(stamp, later).send).toBe(true)
})

test('claimNotify: distinct reset epochs are independent episodes', () => {
  const a = notifyStampPath(dir, 'marketing:ratelimit', 1783600000)
  const b = notifyStampPath(dir, 'marketing:ratelimit', 1783700000)
  expect(a).not.toBe(b)
  expect(claimNotify(a, 1).send).toBe(true)
  expect(claimNotify(b, 1).send).toBe(true)
})

test('pruneOldResumeLogs: drops logs past retention, keeps recent, ignores non-logs', () => {
  const now = 100_000_000_000
  const day = 24 * 60 * 60 * 1000
  const mk = (name: string, ageMs: number) => {
    const p = join(dir, name)
    writeFileSync(p, 'x')
    const t = new Date(now - ageMs)
    utimesSync(p, t, t)
  }
  mk('resume-1-100.log', 5 * day) // stale -> pruned
  mk('resume-2-200.log', 4 * day) // stale -> pruned
  mk('resume-3-300.log', 1 * day) // recent -> kept
  mk('notify-acct-noepoch.stamp', 5 * day) // not a resume log -> kept
  mk('resume.lock', 5 * day) // not a resume-*.log -> kept

  const pruned = pruneOldResumeLogs(dir, now) // default 3-day retention
  expect(pruned).toBe(2)
  const left = readdirSync(dir).sort()
  expect(left).toEqual(['notify-acct-noepoch.stamp', 'resume-3-300.log', 'resume.lock'])
})

test('pruneOldResumeLogs: missing dir is a no-op', () => {
  expect(pruneOldResumeLogs(join(dir, 'does-not-exist'), 1)).toBe(0)
})
