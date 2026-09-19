import { readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { readEntries } from './transcript'
import type { TranscriptEntry } from './types'

// DIVE-4628: resolve the transcript that is LIVE **now**, not the one that was
// live when we were spawned.
//
// The resume helpers are handed a transcript path in argv and then wait — for
// hours, in resume-after-reset's Phase 2. A claude session ROTATES to a new
// `<session-id>.jsonl` in the same project dir (compaction, /clear, a restart),
// and when it does the pinned path is frozen forever: nothing is ever appended
// to it again. So the keystroke reaches the LIVE session and wakes the agent,
// while the verification polls a dead file and can only ever answer "no, it did
// not pick up" — which is read as "still limited", so the helper retries, and
// retries. Measured on olivia 2026-09-19: seven `continue` injections into a
// seat that answered every one of them, 5m24s apart.
//
// The fix is to re-resolve on every poll. `<session-id>.jsonl` files for one
// project all live in one directory, and the rotated-to file is by construction
// the most recently written one, so newest-mtime in that directory IS the live
// session.
//
// Failure direction, deliberately: if the newest file in the dir belongs to
// some OTHER session (a second claude in the same project dir), we may read a
// resume that is not ours and stop retrying. Stopping early costs one missed
// recovery that the paired human is told about; guessing the other way is the
// unbounded injection loop this fixes.
export function resolveLiveTranscript(initialPath: string): string {
  if (!initialPath) return ''
  let names: string[]
  try {
    names = readdirSync(dirname(initialPath))
  } catch {
    return initialPath
  }
  let best = initialPath
  let bestMtime = mtimeOf(initialPath)
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const candidate = join(dirname(initialPath), name)
    if (candidate === initialPath) continue
    const m = mtimeOf(candidate)
    if (m > bestMtime) {
      best = candidate
      bestMtime = m
    }
  }
  return best
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

// Where the live transcript stood at the moment we typed. `len < 0` means we
// have no transcript to watch at all — the caller falls back to the pane.
export type ResumeBaseline = { path: string; len: number }

export function captureBaseline(initialPath: string): ResumeBaseline {
  const path = resolveLiveTranscript(initialPath)
  return { path, len: path ? readEntries(path).length : -1 }
}

// Did the agent pick up since `baseline`? `accept` decides what counts as a
// genuine pick-up — the two helpers differ (the rate-limit one tolerates any
// non-rate_limit assistant entry, the transient-error one demands no error at
// all), and that difference must not be flattened by sharing this code.
//
// On a rotation the baseline INDEX is meaningless against the new file — index
// 40 of the old session is not index 40 of the new one — so the whole new file
// is in scope. That is correct for the case this exists for: the rotated-to
// file is where the reply we are waiting for actually lands.
export function resumedSinceBaseline(
  initialPath: string,
  baseline: ResumeBaseline,
  accept: (e: TranscriptEntry) => boolean,
): boolean {
  if (!initialPath || baseline.len < 0) return false
  const live = resolveLiveTranscript(initialPath)
  const from = live === baseline.path ? baseline.len : 0
  const entries = readEntries(live)
  for (let i = from; i < entries.length; i++) {
    if (entries[i].type === 'assistant' && accept(entries[i])) return true
  }
  return false
}

// True when the live transcript is no longer the one the baseline measured.
// Callers log this: a rotation mid-wait is the whole cause of DIVE-4628 and the
// helper's log is the one artifact of a wall episode that survives the respawn.
export function rotatedSince(initialPath: string, baseline: ResumeBaseline): boolean {
  if (!initialPath || baseline.len < 0) return false
  return resolveLiveTranscript(initialPath) !== baseline.path
}
