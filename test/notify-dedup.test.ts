// DIVE-122: usage-limit StopFailure DM dedup.
//
// The bug: claude runs under a systemd unit (KillMode=control-group +
// Restart=on-failure). On a usage limit it exits → systemd kills the cgroup
// (incl. the detached resume helper) → respawns claude → the StopFailure hook
// re-fires and re-DMs. The mtime-heartbeat resume.lock only dedups while a helper
// is ALIVE, so the respawn loop spammed dozens of identical DMs in seconds.
//
// These tests drive the helper-independent dedup (lib/notify-dedup) with an
// INJECTED clock and assert the core guarantee: a respawn storm collapses to
// EXACTLY ONE DM per episode, while genuinely new episodes still notify. A
// separate static-parse test guards the ordering invariant in the hook so the
// dedup gate can never swallow the rotation path (rotation must still win).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, openSync, writeSync, closeSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimNotify,
  notifyStampPath,
  pruneStaleNotifyStamps,
  NOTIFY_COOLDOWN_MS,
  NOTIFY_RETENTION_MS,
} from '../plugins/telegram/hooks/lib/notify-dedup'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notify-dedup-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

// Simulate `count` StopFailure firings `stepMs` apart, all for the same
// account+epoch episode. Returns how many would actually DM.
function stormSends(account: string, resetEpoch: number | null, count: number, startMs: number, stepMs: number): number {
  let sends = 0
  for (let i = 0; i < count; i++) {
    const now = startMs + i * stepMs
    if (claimNotify(notifyStampPath(dir, account, resetEpoch), now).send) sends++
  }
  return sends
}

describe('DIVE-122 usage-limit notify dedup', () => {
  test('respawn storm WITH a reset epoch collapses to exactly 1 DM', () => {
    // 50 respawns ~18s apart (RestartSec=3 + claude boot) over ~15min.
    expect(stormSends('acct-a', 1_899_999_999, 50, 1_000_000, 18_000)).toBe(1)
  })

  test('respawn storm with NO reset epoch (the spam case) collapses to exactly 1 DM', () => {
    // The exact incident shape: null reset time, fast respawns. Even spanning
    // longer than the cooldown, the sliding window (touched each respawn) keeps
    // it at ONE DM because the gaps stay under the cooldown.
    expect(stormSends('acct-a', null, 80, 1_000_000, 18_000)).toBe(1)
  })

  test('a genuinely new episode after a quiet gap > cooldown re-notifies', () => {
    const path = notifyStampPath(dir, 'acct-a', null)
    expect(claimNotify(path, 1_000_000).send).toBe(true) // episode 1, first DM
    expect(claimNotify(path, 1_060_000).send).toBe(false) // still storming → silent
    // Limit lifts; respawns stop; quiet for > cooldown; then a NEW limit hits.
    expect(claimNotify(path, 1_060_000 + NOTIFY_COOLDOWN_MS + 60_000).send).toBe(true)
  })

  test('a gap UNDER the cooldown stays deduped (same episode)', () => {
    const path = notifyStampPath(dir, 'acct-a', null)
    expect(claimNotify(path, 1_000_000).send).toBe(true)
    expect(claimNotify(path, 1_000_000 + NOTIFY_COOLDOWN_MS - 1_000).send).toBe(false)
  })

  test('distinct reset epochs are distinct episodes — each notifies once', () => {
    expect(claimNotify(notifyStampPath(dir, 'acct-a', 111), 1_000).send).toBe(true)
    expect(claimNotify(notifyStampPath(dir, 'acct-a', 222), 1_000).send).toBe(true)
    expect(claimNotify(notifyStampPath(dir, 'acct-a', 111), 2_000).send).toBe(false)
  })

  test('distinct accounts dedup independently (shared-account fan-out)', () => {
    expect(claimNotify(notifyStampPath(dir, 'acct-a', null), 1_000).send).toBe(true)
    expect(claimNotify(notifyStampPath(dir, 'acct-b', null), 1_000).send).toBe(true)
  })

  test('prune drops stamps older than retention, keeps fresh ones', () => {
    const oldP = notifyStampPath(dir, 'old', 111)
    const freshP = notifyStampPath(dir, 'fresh', 222)
    for (const p of [oldP, freshP]) {
      const fd = openSync(p, 'wx')
      writeSync(fd, '0')
      closeSync(fd)
    }
    const now = Date.now()
    const stale = new Date(now - NOTIFY_RETENTION_MS - 60_000)
    utimesSync(oldP, stale, stale)
    expect(pruneStaleNotifyStamps(dir, now)).toBe(1)
    expect(existsSync(oldP)).toBe(false)
    expect(existsSync(freshP)).toBe(true)
  })

  test('stamp contents are the claim timestamp (so the decision is clock-driven, not mtime-driven)', () => {
    const path = notifyStampPath(dir, 'acct-a', 111)
    claimNotify(path, 1_234_567)
    expect(readFileSync(path, 'utf8').trim()).toBe('1234567')
  })
})

describe('DIVE-122 hook ordering invariant (static parse)', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts'),
    'utf8',
  )

  test('rotation is attempted BEFORE the dedup gate — rotation always wins over a suppressed DM', () => {
    const rotateIdx = src.indexOf('tryRotate(resetEpoch)')
    const dedupIdx = src.indexOf('claimNotify(')
    expect(rotateIdx).toBeGreaterThan(-1)
    expect(dedupIdx).toBeGreaterThan(-1)
    expect(rotateIdx).toBeLessThan(dedupIdx)
  })

  test('the dedup gate only guards the usage-limit DM (gated on isRateLimit)', () => {
    // The claimNotify call must sit inside an `if (isRateLimit)` block so
    // transient-error / generic-stop notifications are never suppressed.
    const gate = src.indexOf('if (isRateLimit) {')
    const dedup = src.indexOf('claimNotify(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(dedup)
  })
})
