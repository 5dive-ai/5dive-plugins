// DIVE-4628 — the resume helper typed `continue` into a live seat forever.
//
// Cause: the helper is handed a transcript path in argv and then waits (hours,
// in Phase 2). The session ROTATES to a new <session-id>.jsonl; the keystroke
// still reaches the LIVE session and wakes the agent, but the verification
// polls the frozen old file, which by definition never changes again. So "did
// claude pick up?" is permanently NO, the helper reads that as "still limited",
// and retries on a timer. Seven injections landed on olivia 2026-09-19, each
// one a fresh assistant turn with her whole context re-sent.
//
// Three properties are graded here, matching the row's acceptance:
//   1. a resume is detected across a mid-wait rotation — including end-to-end,
//      by executing the real hook with the transcript rotated under it;
//   2. Phase 3 gives up on a bounded number of ATTEMPTS, not on time alone, and
//      names that bound in the log and in the chat ping;
//   3. no second `continue` once the seat has demonstrably answered the first.
//
// The `pinned-path control` arm is the pre-fix behaviour reproduced inline: it
// asserts that reading only the launch-time path CANNOT see the resume, so arm
// 1 is measuring the fix and not a tautology.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  captureBaseline,
  resolveLiveTranscript,
  resumedSinceBaseline,
  rotatedSince,
} from '../plugins/telegram/hooks/lib/live-transcript'
import { readEntries } from '../plugins/telegram/hooks/lib/transcript'
import { backoffSec, retryResume, type RetryLimits } from '../plugins/telegram/hooks/lib/resume-retry'

const NOT_RATE_LIMIT = (e: { error?: string }) => e.error !== 'rate_limit'
const NO_ERROR = (e: { error?: string }) => !e.error

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dive4628-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

function line(o: unknown): string {
  return JSON.stringify(o) + '\n'
}
const userEntry = line({ type: 'user', message: { role: 'user', content: 'continue' } })
const assistantEntry = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
const rateLimitEntry = line({
  type: 'assistant',
  error: 'rate_limit',
  isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text: 'limit reached, resets 5pm' }] },
})

// Write a session file and stamp its mtime, so "newest" is exact and not at the
// mercy of the filesystem's timestamp granularity.
function session(name: string, body: string, ageSec: number): string {
  const p = join(dir, name)
  writeFileSync(p, body)
  const t = new Date(Date.now() - ageSec * 1000)
  utimesSync(p, t, t)
  return p
}

describe('DIVE-4628 live transcript resolution', () => {
  test('no rotation: a new assistant entry past the baseline is a resume', () => {
    const p = session('a.jsonl', userEntry + assistantEntry, 60)
    const baseline = captureBaseline(p)
    expect(baseline.path).toBe(p)
    expect(baseline.len).toBe(2)
    expect(resumedSinceBaseline(p, baseline, NOT_RATE_LIMIT)).toBe(false) // nothing new yet
    appendFileSync(p, assistantEntry)
    expect(resumedSinceBaseline(p, baseline, NOT_RATE_LIMIT)).toBe(true)
  })

  test('rotation mid-wait: the reply lands in the NEW session file and is seen', () => {
    const old = session('old.jsonl', userEntry + assistantEntry, 600)
    const baseline = captureBaseline(old)
    expect(rotatedSince(old, baseline)).toBe(false)

    // The session rotates: a newer file appears and is where the reply lands.
    session('new.jsonl', userEntry, 5)
    expect(rotatedSince(old, baseline)).toBe(true)
    expect(resumedSinceBaseline(old, baseline, NOT_RATE_LIMIT)).toBe(false) // woken, not answered yet
    appendFileSync(join(dir, 'new.jsonl'), assistantEntry)
    expect(resolveLiveTranscript(old)).toBe(join(dir, 'new.jsonl'))
    expect(resumedSinceBaseline(old, baseline, NOT_RATE_LIMIT)).toBe(true)
  })

  test('pinned-path control: the pre-fix read of the launch-time path can never see it', () => {
    const old = session('old.jsonl', userEntry + assistantEntry, 600)
    const pinnedBaselineLen = readEntries(old).length // what the old code captured
    const baseline = captureBaseline(old) // what it captures now — same file, same instant
    expect(baseline.path).toBe(old)
    session('new.jsonl', userEntry + assistantEntry, 5)
    // Exactly what the shipped helper did before this fix.
    const preFix = readEntries(old)
      .slice(pinnedBaselineLen)
      .some(e => e.type === 'assistant' && e.error !== 'rate_limit')
    expect(preFix).toBe(false)
    // …and what it does now.
    expect(resumedSinceBaseline(old, baseline, NOT_RATE_LIMIT)).toBe(true)
  })

  test('a rotated-to file holding only a rate-limit notice is NOT a resume', () => {
    const old = session('old.jsonl', userEntry, 600)
    const baseline = captureBaseline(old)
    session('new.jsonl', userEntry + rateLimitEntry, 5)
    expect(resumedSinceBaseline(old, baseline, NOT_RATE_LIMIT)).toBe(false)
  })

  test('the two helpers keep their different accept predicates', () => {
    const p = session('a.jsonl', userEntry, 60)
    const baseline = captureBaseline(p)
    appendFileSync(p, line({ type: 'assistant', error: 'overloaded', message: { role: 'assistant', content: [] } }))
    // resume-after-reset tolerates any non-rate-limit assistant entry…
    expect(resumedSinceBaseline(p, baseline, NOT_RATE_LIMIT)).toBe(true)
    // …resume-after-error must not count an errored turn as recovery.
    expect(resumedSinceBaseline(p, baseline, NO_ERROR)).toBe(false)
  })

  test('degenerate inputs stay safe: no path, unreadable dir, no siblings', () => {
    expect(resolveLiveTranscript('')).toBe('')
    expect(captureBaseline('').len).toBe(-1)
    expect(resumedSinceBaseline('', { path: '', len: -1 }, NOT_RATE_LIMIT)).toBe(false)
    const missing = join(dir, 'nope', 'x.jsonl')
    expect(resolveLiveTranscript(missing)).toBe(missing)
    expect(resumedSinceBaseline(missing, captureBaseline(missing), NOT_RATE_LIMIT)).toBe(false)
    const lone = session('only.jsonl', userEntry, 30)
    expect(resolveLiveTranscript(lone)).toBe(lone)
  })

  test('non-jsonl files in the project dir are never mistaken for a session', () => {
    const old = session('old.jsonl', userEntry, 600)
    session('notes.md', 'newer but not a session', 1)
    expect(resolveLiveTranscript(old)).toBe(old)
  })
})

const LIMITS: RetryLimits = {
  maxRetrySec: 6 * 3600,
  maxAttempts: 6,
  intervalSec: 300,
  intervalMaxSec: 3600,
  maxWaitSec: 30 * 3600,
}

// A fake clock: sleeps advance it instead of costing wall time, so the real
// shipped limits are graded rather than test-only ones.
function harness(attempt: () => Promise<boolean>, learned: () => number | null = () => null) {
  let clock = 1_000_000
  const sleeps: number[] = []
  const logs: string[] = []
  return {
    sleeps,
    logs,
    get elapsed() {
      return clock - 1_000_000
    },
    deps: {
      attempt,
      learnedWaitSec: learned,
      sleep: async (ms: number) => {
        sleeps.push(ms / 1000)
        clock += ms / 1000
      },
      nowSec: () => clock,
      log: (m: string) => logs.push(m),
    },
  }
}

describe('DIVE-4628 Phase 3 is bounded by attempts, not only by time', () => {
  test('a seat that never confirms stops after the attempt cap and says so', async () => {
    let calls = 0
    const h = harness(async () => {
      calls++
      return false
    })
    const out = await retryResume(h.deps, LIMITS)
    expect(out).toEqual({ resumed: false, attempts: 6, giveUp: 'attempts' })
    expect(calls).toBe(6)
    expect(h.logs.at(-1)).toMatch(/giving up after 6 attempts \(cap 6\)/)
    // The old loop was time-only: 6h of 300s sleeps = 72 injections.
    expect(calls).toBeLessThan(72)
  })

  test('the give-up ping is not delayed by one more back-off after the last try', async () => {
    const h = harness(async () => false)
    await retryResume(h.deps, LIMITS)
    expect(h.sleeps).toEqual([300, 600, 1200, 2400, 3600]) // five, for six attempts
    expect(backoffSec(1, LIMITS)).toBe(300)
    expect(backoffSec(9, LIMITS)).toBe(LIMITS.intervalMaxSec) // capped, never unbounded
    expect(h.elapsed).toBeLessThan(LIMITS.maxRetrySec)
  })

  test('no second `continue` once the seat has answered the first', async () => {
    let calls = 0
    const h = harness(async () => {
      calls++
      return true
    })
    const out = await retryResume(h.deps, LIMITS)
    expect(out).toEqual({ resumed: true, attempts: 1, giveUp: '' })
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(h.logs.at(-1)).toMatch(/resume confirmed on attempt 1/)
  })

  test('the time bound still ends it when attempts are cheap', async () => {
    // A pane that keeps promising a reset an hour out: each miss sleeps 1h, so
    // the clock runs out before the attempt cap does.
    const h = harness(async () => false, () => 3600)
    const out = await retryResume(h.deps, { ...LIMITS, maxAttempts: 100 })
    expect(out.resumed).toBe(false)
    expect(out.giveUp).toBe('time')
    expect(h.logs.at(-1)).toMatch(/giving up after 6h of retries/)
  })

  test('a learned reset time is honoured over the back-off', async () => {
    let n = 0
    const h = harness(
      async () => ++n > 1,
      () => 900,
    )
    const out = await retryResume(h.deps, LIMITS)
    expect(out).toEqual({ resumed: true, attempts: 2, giveUp: '' })
    expect(h.sleeps).toEqual([930]) // 900 + the 30s buffer, not the 300s back-off
  })

  test('a learned reset outside the trusted window falls back to the back-off', async () => {
    const h = harness(async () => false, () => 40 * 3600)
    await retryResume(h.deps, { ...LIMITS, maxAttempts: 2 })
    expect(h.sleeps).toEqual([300])
  })
})

// End-to-end: execute the REAL hook with a stub tmux on PATH and rotate the
// transcript out from under it exactly as olivia's session did. Nothing is
// mocked inside the helper — this is the arm that would have caught the bug.
describe('DIVE-4628 the shipped helper survives a rotation (e2e)', () => {
  test('one `continue`, resume confirmed from the rotated-to file, clean exit', () => {
    const projectDir = join(dir, 'project')
    mkdirSync(projectDir)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const sendLog = join(dir, 'sendkeys.log')
    const old = join(projectDir, 'old.jsonl')
    writeFileSync(old, userEntry + rateLimitEntry)
    const rotated = join(projectDir, 'rotated.jsonl')

    // Stub tmux: `capture-pane` shows the parked limit menu (so Phase 1 has
    // something to press and the pane never says "clear"), and `send-keys`
    // records the keystroke — and, for the `continue`, does what the live seat
    // did: answers in a ROTATED session file.
    writeFileSync(
      join(bin, 'tmux'),
      `#!/bin/bash
for a in "$@"; do
  case "$a" in
    capture-pane) echo "1. Stop and wait for the limit to reset"; exit 0 ;;
    send-keys) mode=send ;;
  esac
done
if [ "$mode" = send ]; then
  key="\${@: -2:1}"
  echo "$key" >> ${JSON.stringify(sendLog)}
  if [ "$key" != "1" ]; then
    cat ${JSON.stringify(old)} > ${JSON.stringify(rotated)}
    echo ${JSON.stringify(assistantEntry.trim())} >> ${JSON.stringify(rotated)}
  fi
fi
exit 0
`,
      { mode: 0o755 },
    )

    const helper = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'resume-after-reset.ts')
    const lock = join(dir, 'resume.lock')
    writeFileSync(lock, '')
    const past = String(Math.floor(Date.now() / 1000) - 5) // untrusted epoch → straight to Phase 3
    const r = spawnSync(
      process.execPath,
      [helper, past, join(dir, 'sock'), 'sess:0.0', '', lock, old],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TELEGRAM_BOT_TOKEN: '' },
        timeout: 120000,
      },
    )

    expect(r.status).toBe(0)
    const out = r.stdout ?? ''
    expect(out).toMatch(/phase3 session rotated mid-wait/)
    expect(out).toMatch(/phase3 resume confirmed on attempt 1/)
    expect(out).not.toMatch(/still limited/)
    // Exactly one `continue` — the whole defect was the second, third, seventh.
    const keys = Bun.file(sendLog).text()
    return keys.then(text => {
      const continues = text.split('\n').filter(l => l && l !== '1')
      expect(continues.length).toBe(1)
    })
  }, 130000)
})
