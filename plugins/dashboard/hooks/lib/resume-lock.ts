// The per-agent resume lock: one recovery helper drives the pane at a time.
// Lifted out of stopfailure-notify.ts (DIVE-6714) so the dashboard plugin's
// StopFailure hook takes the SAME lock at the SAME path (it runs a byte-identical
// copy, plugins/dashboard/hooks/SHARED.txt): a seat can never have a telegram
// helper and a dashboard helper typing into one pane.

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const RESUME_LOCK_TTL_MS = 10 * 60 * 1000 // 10 min; helper heartbeats well under this

/** The resume log dir (it holds the lock too); /tmp when it cannot be made. */
export function resumeLogDir(): string {
  const dir = join(homedir(), '.cache', '5dive-telegram', 'resume')
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return '/tmp'
  }
}

// Best-effort cross-process lock guarding a single resume helper per agent —
// AND the per-agent dedup that stops us re-DMing the same usage-limit episode.
//
// The lock is held iff its mtime is FRESH (within RESUME_LOCK_TTL_MS). The
// detached recovery helper (resume-after-reset / resume-after-error) touches
// the lock on a < TTL heartbeat for the whole time it's working, so a long
// wait-for-reset keeps the lock held and every concurrent StopFailure stays
// silent. When the helper exits it unlinks the lock; if it's killed, the
// mtime simply goes stale and the next episode reclaims it.
//
// We deliberately do NOT key the decision on the recorded PID. The PID written
// here is the StopFailure HOOK process, which spawns the detached helper and
// then exits within milliseconds — so a PID-liveness check ALWAYS saw it dead,
// declared the lock stale, and re-notified + re-spawned on every single
// StopFailure. A fast claude-restart-while-limited loop turned that into 700+
// identical "usage limit" DMs in ~20s. mtime + heartbeat is immune: the very
// first acquire stamps a fresh mtime, so a same-instant second StopFailure
// already sees the lock held.
export function tryAcquireResumeLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, `${process.pid} ${Date.now()}`)
    closeSync(fd)
    return true
  } catch {
    // Lock exists. Honor it while its mtime is fresh (a helper is heartbeating);
    // reclaim only once it's gone stale (helper died/finished without cleanup).
    try {
      const st = statSync(lockPath)
      if (Date.now() - st.mtimeMs <= RESUME_LOCK_TTL_MS) return false
    } catch {
      /* lock vanished mid-check — fall through and try to (re)create it */
    }
    // DIVE-901: reclaim a STALE lock atomically. This path previously used a
    // non-exclusive 'w' open, so when the lock went stale a thundering herd of
    // queued StopFailures ALL passed the staleness check above and ALL re-created
    // it → every one returned true → every one spawned a resume helper (observed:
    // 520 helpers in ~4min, each firing an end-ping). Unlink-then-O_EXCL makes the
    // reclaim single-winner: only the racer whose exclusive create succeeds owns
    // the lock; the rest fail and stay silent.
    try {
      unlinkSync(lockPath)
    } catch {
      /* already gone — another racer reclaimed it; our wx below will lose */
    }
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, `${process.pid} ${Date.now()}`)
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }
}
