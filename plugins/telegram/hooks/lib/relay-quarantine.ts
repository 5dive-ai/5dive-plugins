// DIVE-1514: startup age-gate + dead-letter quarantine for the SEND_ONLY
// team-bot relay-in queue (DIVE-159 inbound file-drops; see server.ts drainRelayIn).
//
// The leak class (DIVE-1506): drainRelayIn dedups with an *in-memory* `seen` Set
// and has no age check, so a relay-in/*.json file left across a bot restart/roll
// (the v0.5.22 roll was the trigger) is replayed by the fresh process — its `seen`
// is empty on boot. The fixture->human leg is already closed CLI-side (PR #70), so
// this is defense-in-depth: at startup, quarantine any drop older than a short TTL
// into a dead-letter dir and LOG it. We never silent-delete — a legitimate-but-stale
// send vanishing is the availability-direction twin of the leak, and the operator
// needs a trail to reconcile.
import { readdirSync, statSync, mkdirSync, renameSync } from 'fs'
import { join, basename } from 'path'

export type QuarantinedDrop = { file: string; ageMs: number; dest: string }

// Move every relay-in/*.json whose mtime is older than ttlMs into deadLetterDir.
// Pure w.r.t. clock (caller passes `now`) and quiet on fs errors — a boot-time
// sweep must never wedge startup. Returns what it quarantined so the caller logs it.
export function sweepStaleRelayIn(
  relayInDir: string,
  deadLetterDir: string,
  ttlMs: number,
  now: number,
): QuarantinedDrop[] {
  let files: string[]
  try {
    files = readdirSync(relayInDir).filter(f => f.endsWith('.json'))
  } catch {
    return [] // dir not created yet — nothing to sweep
  }
  const quarantined: QuarantinedDrop[] = []
  for (const f of files) {
    const src = join(relayInDir, f)
    let mtimeMs: number
    try {
      mtimeMs = statSync(src).mtimeMs
    } catch {
      continue // vanished under us (concurrent drain) — skip
    }
    const ageMs = now - mtimeMs
    if (ageMs <= ttlMs) continue // fresh: let drainRelayIn deliver it
    // mtime prefix keeps prior sweeps' drops distinct if basenames collide.
    const dest = join(deadLetterDir, `${Math.round(mtimeMs)}-${basename(f)}`)
    try {
      mkdirSync(deadLetterDir, { recursive: true, mode: 0o700 })
      renameSync(src, dest)
      quarantined.push({ file: f, ageMs, dest })
    } catch {
      // best-effort: leave it for drainRelayIn rather than crash the boot sweep
    }
  }
  return quarantined
}
