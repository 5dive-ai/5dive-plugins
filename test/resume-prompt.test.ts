// Covers the DIVE-1332 fix: the auto-resume prompt gates its "reply to the
// latest message" clause on a genuine unanswered inbound, so an autonomous-turn
// resume with an empty inbox no longer emits the phantom reply instruction.
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// DIVE-3452: plain static imports. These used to be `await import`s preceded by
// the env assignment, because paths.ts froze STATE_DIR at module load — so this
// file passed only when the runner happened to walk it before anything else
// that imports paths.ts, which differs between a dev box and CI. paths.ts now
// resolves per call, so setting the env before the first CALL is enough and the
// import order of the whole suite stops mattering. Reverting paths.ts to consts
// reds these arms again under `bun test test/dive3445-tag-provenance.test.ts
// test/resume-prompt.test.ts` — that ordering is the mutation check.
import { resumePrompt } from '../plugins/telegram/hooks/lib/resume-prompt'
import { saveSilence } from '../plugins/telegram/hooks/lib/state'

const dir = mkdtempSync(join(tmpdir(), 'tg-resume-'))
process.env.TELEGRAM_STATE_DIR = dir

beforeEach(() => saveSilence({}))

test('empty inbox (never any DM) resumes bare — no phantom reply clause', () => {
  expect(resumePrompt()).toBe('continue')
})

test('already replied to the last inbound resumes bare', () => {
  saveSilence({ lastInboundAt: 100, lastReplyAt: 200 })
  expect(resumePrompt()).toBe('continue')
})

test('equal stamps (reply covers the inbound) resume bare', () => {
  saveSilence({ lastInboundAt: 150, lastReplyAt: 150 })
  expect(resumePrompt()).toBe('continue')
})

test('genuine unanswered inbound appends the reply clause', () => {
  saveSilence({ lastInboundAt: 300, lastReplyAt: 200 })
  expect(resumePrompt()).toBe('continue and reply to the latest message')
})

test('inbound with no reply ever appends the reply clause', () => {
  saveSilence({ lastInboundAt: 300 })
  expect(resumePrompt()).toBe('continue and reply to the latest message')
})
