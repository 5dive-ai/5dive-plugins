// DIVE-7825: the long poll must not be able to hang for eight minutes in silence.
//
// The bot is built with the client's default request timeout (500 s), and that
// timeout covers getUpdates too. When Telegram stops answering a poll socket,
// the request sits for the full 500 s while every message the owner sends waits
// on the server side. The poll loop's error handler retries every getUpdates
// failure after 3 s and logs only through a debug channel that is off, so
// nothing reached stderr, and the beacon file kept beating on its own timer.
//
// This transformer touches getUpdates only: uploads keep the long default.
//   1. It aborts a poll that has not answered by its own long-poll window plus
//      POLL_SLACK_MS, so the loop's 3 s retry fires instead of a 500 s wait.
//   2. Every completed poll writes LAST_POLL (its mtime = last poll that came
//      back), the file a liveness check reads to tell "polling" from "stuck".
//   3. A failure writes one stderr line (then at most one per logEveryMs while
//      it keeps failing), and the first success after it says it recovered.
// A stop() of the bot aborts through the caller's signal; that is not a failure.
//
// DIVE-8896: a poll that comes BACK with ok:false is a failure too. Transformers
// see Telegram's raw answer; grammY throws only after them. So a 409 "Conflict:
// terminated by other getUpdates request" (a second consumer on this token, which
// takes the owner's messages instead of us) used to count as a completed poll:
// bot.lastpoll stayed fresh and nothing was logged while the bridge was deaf. Now:
//   4. Any ok:false getUpdates leaves LAST_POLL alone and logs like a failure.
//   5. A 409 says so in plain words, names the other local pollers it can see,
//      and writes CONFLICT (bot.conflict next to bot.lastpoll) with when it began;
//      the first good poll removes it and logs how long the bridge was deaf.
//
// No grammy import: the test suite runs without plugin dependencies.

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export const POLL_SLACK_MS = 15_000
export const POLL_LOG_EVERY_MS = 60_000

type Prev = (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>

export interface PollGuardOpts {
  /** File whose mtime is the last completed getUpdates. */
  lastPollFile: string
  /** One line, no prefix, no newline. */
  log: (line: string) => void
  slackMs?: number
  logEveryMs?: number
  now?: () => number
  /** Swappable for tests; defaults to writing the file. */
  touch?: (file: string, now: number) => void
  /** Written while getUpdates answers 409; default bot.conflict beside lastPollFile. */
  conflictFile?: string
  /** Other local processes that may be polling this token; swappable for tests. */
  rivals?: () => string[]
}

export const CONFLICT_FILE_NAME = 'bot.conflict'

/**
 * Other local processes that look like a getUpdates consumer: a Telegram bridge
 * server.ts, the team-bot listener, or a `telegram-discover` poll. Best effort and
 * read-only: it names candidates for the log, it never signals them. The real
 * rival may be on another machine using the same token; then this list is empty.
 */
export function localRivalPollers(selfPid: number = process.pid, procDir = '/proc'): string[] {
  const out: string[] = []
  let pids: string[] = []
  try { pids = readdirSync(procDir).filter(d => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b)) } catch { return out }
  for (const d of pids) {
    const pid = Number(d)
    if (pid === selfPid) continue
    let cmd = ''
    try { cmd = readFileSync(join(procDir, d, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ') } catch { continue }
    if (!/telegram[^ ]*\/server\.ts|team-bot-listener|telegram-discover/.test(cmd)) continue
    let ppid = '?'
    try {
      const st = readFileSync(join(procDir, d, 'stat'), 'utf8')
      ppid = st.slice(st.lastIndexOf(')') + 2).split(' ')[1] ?? '?'
    } catch {}
    out.push(`pid ${pid} (ppid ${ppid}): ${cmd.slice(0, 160)}`)
  }
  return out
}

type ApiErr = { ok: false; error_code?: number; description?: string }
function apiError(res: unknown): ApiErr | null {
  return res !== null && typeof res === 'object' && (res as { ok?: unknown }).ok === false ? res as ApiErr : null
}

export function touchLastPoll(file: string, now: number = Date.now()): void {
  try { writeFileSync(file, String(now)) } catch {}
}

/** How long one getUpdates may take: its long-poll window plus slack. */
export function pollDeadlineMs(payload: unknown, slackMs: number = POLL_SLACK_MS): number {
  const t = Number((payload as { timeout?: unknown } | undefined)?.timeout)
  return (Number.isFinite(t) && t > 0 ? t * 1000 : 0) + slackMs
}

export function createPollGuard(opts: PollGuardOpts) {
  const slackMs = opts.slackMs ?? POLL_SLACK_MS
  const logEveryMs = opts.logEveryMs ?? POLL_LOG_EVERY_MS
  const now = opts.now ?? Date.now
  const touch = opts.touch ?? touchLastPoll
  const conflictFile = opts.conflictFile ?? join(dirname(opts.lastPollFile), CONFLICT_FILE_NAME)
  const rivals = opts.rivals ?? (() => localRivalPollers())
  let failing = 0
  let lastLogAt = Number.NEGATIVE_INFINITY
  let conflictSince = 0
  let conflicts = 0
  let seen: string[] = []
  // A bot.conflict may exist: ours, or one an earlier process left when it died mid-conflict.
  let conflictFileMaybe = true

  const failed = (why: string, force = false) => {
    failing++
    const t = now()
    if (force || failing === 1 || t - lastLogAt >= logEveryMs) {
      lastLogAt = t
      opts.log(`getUpdates failed (${failing} in a row): ${why}; retrying in 3s`)
    }
  }
  const onConflict = (desc: string) => {
    const t = now()
    conflicts++
    const first = conflictSince === 0
    if (first) conflictSince = t
    const loud = first || t - lastLogAt >= logEveryMs
    failed(`409 Conflict, another process is polling this bot token and owner messages go to it, not here (${desc})`, first)
    if (loud) {
      seen = rivals()
      opts.log(seen.length
        ? `getUpdates 409: other local pollers on this box: ${seen.join(' | ')}`
        : 'getUpdates 409: no other poller on this box, so the token is in use somewhere else')
    }
    conflictFileMaybe = true
    try {
      writeFileSync(conflictFile, JSON.stringify({ since: conflictSince, last: t, count: conflicts, description: desc, local_rivals: seen }) + '\n')
    } catch {}
  }
  const onGoodPoll = () => {
    touch(opts.lastPollFile, now())
    if (conflictSince) {
      opts.log(`getUpdates 409 cleared: this bridge could not receive messages for ${Math.round((now() - conflictSince) / 1000)}s`)
      conflictSince = 0
      conflicts = 0
    }
    if (conflictFileMaybe) { conflictFileMaybe = false; try { unlinkSync(conflictFile) } catch {} }
    if (failing > 0) {
      opts.log(`getUpdates recovered after ${failing} failed attempt${failing === 1 ? '' : 's'}`)
      failing = 0
      lastLogAt = Number.NEGATIVE_INFINITY
    }
  }

  return async function pollGuard(prev: Prev, method: string, payload: unknown, signal?: AbortSignal): Promise<any> {
    if (method !== 'getUpdates') return prev(method, payload, signal)

    const deadline = pollDeadlineMs(payload, slackMs)
    const ctl = new AbortController()
    const onCallerAbort = () => ctl.abort(signal?.reason)
    if (signal?.aborted) ctl.abort(signal.reason)
    else signal?.addEventListener('abort', onCallerAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort(new Error(`getUpdates got no answer in ${Math.round(deadline / 1000)}s`))
    }, deadline)
    ;(timer as { unref?: () => void }).unref?.()

    try {
      const res = await prev(method, payload, ctl.signal)
      const bad = apiError(res)
      if (!bad) onGoodPoll()
      else if (bad.error_code === 409) onConflict(bad.description ?? 'Conflict')
      // grammY turns this answer into the GrammyError the poll loop sees.
      else failed(`${bad.error_code ?? '?'} ${bad.description ?? 'not ok'}`)
      return res
    } catch (err) {
      if (signal?.aborted) throw err // the bot is stopping: not a poll failure
      failed(timedOut
        ? `no answer in ${Math.round(deadline / 1000)}s, aborted`
        : (err instanceof Error ? err.message : String(err)))
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}
