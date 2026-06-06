// DIVE-122 regression: actually EXECUTE stopfailure-notify.ts on a usage-limit
// payload. The dedup unit tests (notify-dedup.test.ts) import only the pure
// primitive, and `bun build` doesn't execute — so a temporal-dead-zone bug
// (resolveActiveAccount's module-level `let` referenced by top-level code before
// its declaration → "Cannot access '_activeAccount' before initialization") slid
// past both and only surfaced when the live hook ran. This smoke runs the hook in
// a subprocess with an isolated HOME and a fake token (sendMessage swallows the
// failed send) and asserts it runs clean AND the storm collapses to one SEND.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sf-hook-'))
})
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

function writeTranscript(): string {
  const p = join(home, 'transcript.jsonl')
  // A telegram inbound so getCallerChat resolves a (dummy) target.
  writeFileSync(
    p,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="1">hi</channel>' },
    }) + '\n',
  )
  return p
}

function fireHook(payload: Record<string, unknown>): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // Isolated HOME → stamps land in a temp dir, never the real cache. Fake token
    // + no tmux → no real DM, no rotation/lock/helper paths.
    env: { ...process.env, HOME: home, TELEGRAM_BOT_TOKEN: '000:FAKE', TMUX: '' },
    timeout: 20000,
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

describe('DIVE-122 stopfailure-notify executes on a usage limit (TDZ regression)', () => {
  test('runs clean and emits the dedup SEND trace — no ReferenceError/TDZ', () => {
    const payload = {
      message: 'Claude usage limit reached',
      reason: 'usage_limit',
      stopReason: 'rate_limit',
      resetsAt: 1_999_999_999,
      transcript_path: writeTranscript(),
    }
    const r = fireHook(payload)
    expect(r.stderr).not.toMatch(/ReferenceError|SyntaxError|TypeError|before initialization/)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('usage-limit dedup: SEND (first)')
  })

  test('a 5x StopFailure storm collapses to exactly one SEND', () => {
    const payload = {
      message: 'usage limit reached',
      reason: 'usage_limit',
      stopReason: 'rate_limit',
      resetsAt: 1_999_999_999,
      transcript_path: writeTranscript(),
    }
    let sends = 0
    let suppress = 0
    for (let i = 0; i < 5; i++) {
      const r = fireHook(payload)
      expect(r.code).toBe(0)
      if (/usage-limit dedup: SEND/.test(r.stderr)) sends++
      if (/usage-limit dedup: suppress/.test(r.stderr)) suppress++
    }
    expect(sends).toBe(1)
    expect(suppress).toBe(4)
  })
})
