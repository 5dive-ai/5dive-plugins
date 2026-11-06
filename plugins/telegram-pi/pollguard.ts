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
// No grammy import: the test suite runs without plugin dependencies.

import { writeFileSync } from 'fs'

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
  let failing = 0
  let lastLogAt = Number.NEGATIVE_INFINITY

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
      touch(opts.lastPollFile, now())
      if (failing > 0) {
        opts.log(`getUpdates recovered after ${failing} failed attempt${failing === 1 ? '' : 's'}`)
        failing = 0
        lastLogAt = Number.NEGATIVE_INFINITY
      }
      return res
    } catch (err) {
      if (signal?.aborted) throw err // the bot is stopping: not a poll failure
      failing++
      const t = now()
      if (failing === 1 || t - lastLogAt >= logEveryMs) {
        lastLogAt = t
        const why = timedOut
          ? `no answer in ${Math.round(deadline / 1000)}s, aborted`
          : (err instanceof Error ? err.message : String(err))
        opts.log(`getUpdates failed (${failing} in a row): ${why}; retrying in 3s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}
