// DIVE-6816: the dashboard chat on a CHAT-ONLY self-hosted box.
//
// A box linked from my.5dive.ai/self-host as chat only runs no file server and
// takes no inbound connection (no Caddy, no ports, works behind NAT): it only
// ever calls OUT to the API with its box token, like Telegram polling. So on
// such a box (marked by /etc/5dive/chat-only, written by the link script):
//
//   * the adapter holds a long poll on /pending (wait=25) in a loop, instead of
//     waiting for a collect-now nudge that no one can deliver;
//   * an upload the owner sent is not on disk (no files API wrote it), so the
//     adapter fetches it from the API and writes it where the message says;
//   * a reply file cannot be read back by the API, so the adapter posts it.
//
// Every one of these is guarded on the marker, read on each use: a box that is
// not chat-only behaves exactly as before, and an unlink (marker removed) stops
// the loop at its next turn.

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

export const LONG_POLL_WAIT_S = 25
/** The API's own cap for a held file, both ways. */
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024

export function isChatOnly(marker: string): boolean {
  return existsSync(marker)
}

const UPLOAD_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/

/**
 * True when `path` names one file directly in this agent's own chat-uploads
 * dir — the only place the API holds uploads for, and the only place the root
 * relay will write. No traversal, no subdir, no dot name.
 */
export function isOwnUpload(agent: string, uploadsRoot: string, path: unknown): path is string {
  if (typeof path !== 'string') return false
  const dir = `${uploadsRoot.replace(/\/+$/, '')}/${agent}/`
  return path.startsWith(dir) && UPLOAD_NAME_RE.test(path.slice(dir.length))
}

/** Write `bytes` at `path` atomically (temp + rename), 0644 like the files API. */
export function writeFileAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.part`)
  try {
    writeFileSync(tmp, bytes, { mode: 0o644 })
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

/**
 * What one long-poll pass came back with.
 *   ok          the poll was held, or it brought messages
 *   empty-fast  nothing, and the API answered at once (an API that does not hold,
 *               or a wake meant for another agent)
 *   error       transport or HTTP failure
 *   auth        401/403 after the token re-read: the box was unlinked
 *   busy        a drain was already running in this process
 *   skipped     another process holds the drain lock
 */
export type PollOutcome = 'ok' | 'empty-fast' | 'error' | 'auth' | 'busy' | 'skipped'

export type LongPollOpts = {
  poll: () => Promise<PollOutcome>
  active: () => boolean
  sleep: (ms: number) => Promise<void>
  /** First error backoff; doubles per failure up to maxBackoffMs. */
  baseBackoffMs: number
  maxBackoffMs: number
}

/**
 * Run passes back to back while `active()`. Errors and an API that answers
 * at once back off exponentially (so an old API that ignores `wait` cannot be
 * hammered); an auth rejection stops the loop. Resolves with why it stopped.
 */
export async function runLongPoll(o: LongPollOpts): Promise<'auth' | 'off'> {
  let fails = 0
  let fast = 0
  const backoff = (n: number) => Math.min(o.baseBackoffMs * 2 ** Math.max(0, n - 1), o.maxBackoffMs)
  while (o.active()) {
    let r: PollOutcome
    try { r = await o.poll() } catch { r = 'error' }
    if (r === 'auth') return 'auth'
    if (r === 'ok') { fails = 0; fast = 0; continue }
    if (r === 'empty-fast') {
      fails = 0
      fast++
      // One early empty answer is normal (a wake for another agent on the box).
      // More is an API (or relay) that does not hold: poll it, gently, at most
      // every 8 backoff units, so a message still lands within seconds.
      if (fast >= 2) await o.sleep(Math.min(backoff(fast - 1), 8 * o.baseBackoffMs))
      continue
    }
    if (r === 'busy') { await o.sleep(250); continue }
    if (r === 'skipped') { await o.sleep(Math.min(o.baseBackoffMs * 5, o.maxBackoffMs)); continue }
    fails++
    await o.sleep(backoff(fails))
  }
  return 'off'
}

// --- DIVE-7098: hands-free voice on a chat-only box --------------------------
//
// Hands-free sends a clip only when the box heard words in it, so noise costs
// no message and no model turn. The API cannot call this box to hear, so it
// hands the clip over on this agent's own long poll (`hear: [{id, path}]`,
// only to a poll that said `hear=1`); the adapter hears it with the local
// engine and posts the words back (/server/selfhost/heard). Nothing reaches
// the session: the app sends the words as an ordinary voice note when there
// are some, and drops the clip when there are none.

export type HearJob = { id: string; path: string }

/** The `hear` list of a pending answer, each job well formed and in this agent's own uploads dir. */
export function hearJobs(raw: unknown, agent: string, uploadsRoot: string): HearJob[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(j => {
    const id = (j as { id?: unknown })?.id
    const path = (j as { path?: unknown })?.path
    return typeof id === 'string' && id.length > 0 && id.length <= 64 && isOwnUpload(agent, uploadsRoot, path) ? [{ id, path }] : []
  })
}

export type Hear = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>

/** What the engine heard in `path`, whitespace folded ("" for no words); null when it could not hear. */
export async function hearText(path: string, run: Hear, bin: string, timeoutMs = 40_000): Promise<string | null> {
  try {
    const { code, out } = await run(bin, ['--', path], timeoutMs)
    return code === 0 ? out.replace(/\s+/g, ' ').trim() : null
  } catch {
    return null
  }
}
