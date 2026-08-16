// DIVE-3452: paths.ts must resolve STATE_DIR PER CALL, never once at module load.
//
// The bug this locks was not a wrong path — it was a landmine. As consts, the
// first file to import paths.ts (directly or transitively, e.g. via ./access or
// ./state) froze STATE_DIR for the whole process, so any test that set
// TELEGRAM_STATE_DIR afterwards silently read the real $HOME instead. Whether
// that happened was decided by the order the runner walks test/, which differs
// between a dev box and CI: identical bytes ran 833/0 locally and 831/2 in CI
// (run 31930246792), and the red landed on test/resume-prompt.test.ts — a file
// that had not changed.
//
// So this file imports paths EAGERLY, at the top, BEFORE touching the env. That
// is the whole point: a static import at module scope is exactly what a future
// author would add, and under the old consts it is what armed the mine. Under
// lazy resolution it is harmless, and these arms prove it — they fail if anyone
// converts these back to module-load consts, whatever order this file runs in.
import { test, expect, afterAll } from 'bun:test'
import { accessFile, nudgeFile, questionDir, silenceFile, stateDir, typingStopFile } from '../plugins/telegram/hooks/lib/paths'
// Transitive importers of paths.ts, also loaded eagerly — ./state and ./access
// are the two that dragged it in and caused the CI red.
import { loadSilence } from '../plugins/telegram/hooks/lib/state'
import { loadAccess } from '../plugins/telegram/hooks/lib/access'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const before = process.env.TELEGRAM_STATE_DIR
afterAll(() => {
  if (before === undefined) delete process.env.TELEGRAM_STATE_DIR
  else process.env.TELEGRAM_STATE_DIR = before
})

test('every path follows TELEGRAM_STATE_DIR set AFTER the module was imported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-lazy-'))
  process.env.TELEGRAM_STATE_DIR = dir
  expect(stateDir()).toBe(dir)
  expect(accessFile()).toBe(join(dir, 'access.json'))
  expect(silenceFile()).toBe(join(dir, 'silence.json'))
  expect(nudgeFile()).toBe(join(dir, 'context-nudge.json'))
  expect(typingStopFile()).toBe(join(dir, 'typing-stop'))
  expect(questionDir()).toBe(join(dir, 'questions'))
})

test('a SECOND reassignment is followed too — resolution is per call, not first call', () => {
  const a = mkdtempSync(join(tmpdir(), 'tg-lazy-a-'))
  process.env.TELEGRAM_STATE_DIR = a
  expect(stateDir()).toBe(a)
  const b = mkdtempSync(join(tmpdir(), 'tg-lazy-b-'))
  process.env.TELEGRAM_STATE_DIR = b
  expect(stateDir()).toBe(b)
  expect(accessFile()).toBe(join(b, 'access.json'))
})

// Path strings alone would still pass if a CONSUMER cached the value, so read
// through the two modules that actually dragged paths.ts in, against seeded
// files. This is the arm that fails on a real regression rather than on a
// cosmetic one.
test('consumers imported before the env was set read the tmp dir, not $HOME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-lazy-consumer-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'silence.json'), JSON.stringify({ lastInboundAt: 4242 }))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['1234567890'] }))
  process.env.TELEGRAM_STATE_DIR = dir
  expect(loadSilence().lastInboundAt).toBe(4242)
  expect(loadAccess().allowFrom).toEqual(['1234567890'])
})
