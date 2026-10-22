// DIVE-122: respawn-surviving dedup for usage-limit StopFailure DMs.
//
// Background: claude runs under a systemd unit with KillMode=control-group +
// Restart=on-failure (RestartSec=3). When claude exits on a usage limit, systemd
// tears down the whole cgroup — killing the detached resume helper — then
// respawns claude. The fresh claude re-hits the limit, the StopFailure hook
// re-fires, and the mtime-heartbeat resume.lock only dedups while that helper is
// ALIVE to heartbeat it. Once it's killed the lock isn't held, so every respawn
// re-DMs "Usage limit hit …" (dozens/sec across an over-limit shared account).
//
// This dedup is INDEPENDENT of the helper: the StopFailure hook itself
// claims+checks a stamp file before sending. The respawns become the heartbeat,
// so it survives them. Keyed on account+resetEpoch so a genuinely new episode
// (a different future reset, or a different account after rotation) still
// notifies; a stable 'noepoch' token covers the no-reset-time case (the exact
// spam scenario) with a SLIDING-WINDOW expiry rather than a wall-clock bucket —
// a bucket would re-DM at each boundary during a long limit, breaking
// exactly-1-DM-per-episode. The timestamp lives in the file CONTENTS (not just
// mtime) so the decision is deterministic and unit-testable with an injected
// clock.

import { openSync, writeSync, closeSync, statSync, unlinkSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// How long a stamp suppresses duplicate DMs without a fresh touch. Two lower
// bounds: (1) the respawn gap (RestartSec=3 + claude boot, ~tens of seconds) so
// an ongoing storm keeps the stamp fresh and collapses to ONE DM; (2) the resume
// lock's TTL (RESUME_LOCK_TTL_MS, 10min) — while that lock suppresses DMs the
// hook exits BEFORE reaching this stamp, so the stamp isn't being touched; a
// cooldown longer than the lock TTL guarantees no second DM leaks at the moment
// the lock finally goes stale. Short enough that a genuinely new episode after a
// quiet gap re-notifies.
export const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000
// Drop stamps older than this on send so ~/.cache can't grow unbounded. Longer
// than the longest plausible single episode (weekly-cap waits run ~24-30h).
export const NOTIFY_RETENTION_MS = 31 * 60 * 60 * 1000

const STAMP_PREFIX = 'notify-'
const STAMP_SUFFIX = '.stamp'

function sanitize(s: string): string {
  return (s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

// Stable per-episode stamp path. resetEpoch present → 'r<epoch>' (stable for the
// whole episode, distinct per future reset); absent → 'noepoch' (sliding-window
// expiry via the cooldown, NOT a time bucket).
export function notifyStampPath(dir: string, account: string, resetEpoch: number | null): string {
  const epochKey = resetEpoch && resetEpoch > 0 ? `r${resetEpoch}` : 'noepoch'
  return join(dir, `${STAMP_PREFIX}${sanitize(account)}-${epochKey}${STAMP_SUFFIX}`)
}

export type DedupReason = 'first' | 'reclaimed-stale' | 'suppressed' | 'lost-race'
export type DedupResult = { send: boolean; reason: DedupReason }

// Create the stamp iff it doesn't already exist (atomic O_EXCL). Returns true
// when WE created it.
function tryExclusiveWrite(path: string, nowMs: number): boolean {
  try {
    const fd = openSync(path, 'wx')
    writeSync(fd, String(nowMs))
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

// Atomically decide whether to send the usage-limit DM for this stamp.
//   send=true  → caller should DM (this call claimed the episode or reclaimed a
//                stale stamp after a quiet gap)
//   send=false → a fresh stamp already covers this episode; stay silent
// Atomicity: the exclusive O_EXCL create is the arbiter for BOTH first-claim and
// stale-reclaim, so two racing respawns can't both send. Fail-OPEN on unexpected
// state (a possible duplicate beats a silenced limit alert).
export function claimNotify(path: string, nowMs: number, cooldownMs: number = NOTIFY_COOLDOWN_MS): DedupResult {
  // Fast path: claim if absent.
  if (tryExclusiveWrite(path, nowMs)) return { send: true, reason: 'first' }

  // Exists — read its stamped time to decide fresh-vs-stale.
  let stampedMs = 0
  try {
    stampedMs = parseInt(readFileSync(path, 'utf8').trim(), 10) || 0
  } catch {
    stampedMs = 0
  }

  if (stampedMs && nowMs >= stampedMs && nowMs - stampedMs <= cooldownMs) {
    // Fresh window — an ongoing respawn storm. Slide the window forward and
    // suppress this duplicate.
    try {
      const fd = openSync(path, 'w')
      writeSync(fd, String(nowMs))
      closeSync(fd)
    } catch {
      /* best-effort slide */
    }
    return { send: false, reason: 'suppressed' }
  }

  // Stale (or unreadable/garbage) — a new episode after a quiet gap. Reclaim
  // atomically: only one racer wins the exclusive re-create; the loser stays
  // silent rather than double-sending.
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
  if (tryExclusiveWrite(path, nowMs)) return { send: true, reason: stampedMs ? 'reclaimed-stale' : 'first' }
  return { send: false, reason: 'lost-race' }
}

// Drop notify-*.stamp files older than retentionMs (by mtime). Cheap sweep of a
// small dir; call on SEND (≈once per episode) so a storm doesn't sweep every
// respawn. Returns the count pruned.
export function pruneStaleNotifyStamps(dir: string, nowMs: number, retentionMs: number = NOTIFY_RETENTION_MS): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let pruned = 0
  for (const name of names) {
    if (!name.startsWith(STAMP_PREFIX) || !name.endsWith(STAMP_SUFFIX)) continue
    const p = join(dir, name)
    try {
      if (nowMs - statSync(p).mtimeMs > retentionMs) {
        unlinkSync(p)
        pruned++
      }
    } catch {
      /* racing unlink — skip */
    }
  }
  return pruned
}

// The detached recovery helpers write a per-spawn `resume-<ts>-<pid>.log` in the
// same dir and NOTHING ever removed them, so the dir grew unbounded (DIVE-1107:
// 725 logs accrued over ~6 weeks; a banner storm inflates it fast). Prune logs
// older than retentionMs by mtime. Kept generous (default 3 days) so a recent
// storm's logs survive for post-mortem. Call on SPAWN so a genuinely idle agent
// stops accruing without a dedicated cron. Returns the count pruned.
export const RESUME_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
const RESUME_LOG_PREFIX = 'resume-'
const RESUME_LOG_SUFFIX = '.log'
export function pruneOldResumeLogs(
  dir: string,
  nowMs: number,
  retentionMs: number = RESUME_LOG_RETENTION_MS,
): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let pruned = 0
  for (const name of names) {
    if (!name.startsWith(RESUME_LOG_PREFIX) || !name.endsWith(RESUME_LOG_SUFFIX)) continue
    const p = join(dir, name)
    try {
      if (nowMs - statSync(p).mtimeMs > retentionMs) {
        unlinkSync(p)
        pruned++
      }
    } catch {
      /* racing unlink — skip */
    }
  }
  return pruned
}
