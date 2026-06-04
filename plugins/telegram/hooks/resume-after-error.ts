#!/usr/bin/env -S bun
// Spawned detached by stopfailure-notify.ts when a TRANSIENT API error
// (Overloaded / 5xx) aborts a turn and leaves the agent idle at the prompt.
//
// Unlike a usage limit (resume-after-reset.ts), there's no "Stop and wait"
// menu and no reset epoch — claude exhausted its own retries on the 5xx,
// gave up the turn, and dropped back to an interactive prompt. The
// `while true; claude; done` agent loop only restarts on process *exit*, so
// the still-running-but-idle claude sits there until something types into it.
// Recovery is therefore simple: wait a short backoff (the overload usually
// clears in seconds-to-minutes), type "continue", verify claude picked up;
// retry with growing backoff up to a small cap.
//
// Argv: <tmux_socket> <tmux_target> <chat_ids_csv> <lock_path> <transcript_path>
// Env:  TELEGRAM_BOT_TOKEN (required for the notification)
//
// Why a detached helper (not inline in the StopFailure hook): the hook has a
// 10s timeout, but the backoff+retry budget runs into minutes. The hook holds
// the per-agent resume lock before spawning us; we release it when done.

import { setTimeout as sleep } from 'timers/promises'
import { unlinkSync, utimesSync } from 'fs'
import { capturePaneFor, sendKeys, type TmuxCtx } from './lib/tmux'
import { sendMessage } from './lib/telegram'
import { readEntries } from './lib/transcript'

const socket = process.argv[2] ?? ''
const target = process.argv[3] ?? ''
const chatIdsCsv = process.argv[4] ?? ''
const lockPath = process.argv[5] ?? ''
const transcriptPath = process.argv[6] ?? ''

// Backoff schedule between "continue" attempts (seconds). Four tries over
// ~5min — overloads almost always clear inside that window; beyond it a human
// nudge is the right call rather than hammering the API indefinitely.
const BACKOFFS_SEC = [20, 45, 90, 150]
const VERIFY_POLLS = 6 // after a "continue", watch this many times…
const VERIFY_STEP_MS = 4000 // …at this cadence (~24s) for claude to pick up

const ctx: TmuxCtx | null = socket && target ? { socket, target } : null

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function releaseLock(): void {
  if (!lockPath) return
  try {
    unlinkSync(lockPath)
  } catch {
    /* already gone */
  }
}

// Touch the resume lock's mtime. stopfailure-notify treats the lock as held
// only while its mtime is fresh (< RESUME_LOCK_TTL_MS, 10min); heartbeat each
// retry so a concurrent StopFailure can't declare it stale and re-DM + spawn a
// duplicate helper while we're still backing off.
function heartbeat(): void {
  if (!lockPath) return
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch {
    /* lock vanished — recovery will end naturally */
  }
}

// A genuine resume = a NEW assistant message after `baseline` that carries NO
// error. Stricter than the rate-limit helper's check (which only excludes
// error="rate_limit"): a fresh transient-error retry would land as an
// assistant entry with a non-rate-limit error, and we must NOT count that as
// success. Transcript is the source of truth (immune to pane scrollback).
function resumedSince(baseline: number): boolean {
  if (!transcriptPath || baseline < 0) return false
  const entries = readEntries(transcriptPath)
  for (let i = baseline; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'assistant' && !e.error) return true
  }
  return false
}

function transcriptLen(): number {
  if (!transcriptPath) return -1
  return readEntries(transcriptPath).length
}

// Pane fallback when there's no transcript path: an active "API Error" line
// still showing means the last continue bounced off a fresh overload.
function paneStillErrored(pane: string): boolean {
  return /API Error|overloaded/i.test(pane)
}

// One attempt: type "continue", then watch (~24s) for claude to actually pick
// back up. Returns true on confirmed resume.
async function attemptResume(): Promise<boolean> {
  if (!ctx) return false
  const baseline = transcriptLen()
  sendKeys(ctx, 'continue and reply to the latest message', 'Enter')
  for (let i = 0; i < VERIFY_POLLS; i++) {
    await sleep(VERIFY_STEP_MS)
    if (transcriptPath) {
      if (resumedSince(baseline)) return true
    } else if (!paneStillErrored(capturePaneFor(ctx))) {
      return true
    }
  }
  return false
}

log(`resume-after-error start: socket=${socket} target=${target} transcript=${transcriptPath ? 'yes' : 'no'}`)

let resumed = false
try {
  if (ctx) {
    for (let attempt = 0; attempt < BACKOFFS_SEC.length; attempt++) {
      heartbeat()
      const wait = BACKOFFS_SEC[attempt]
      log(`attempt ${attempt + 1}/${BACKOFFS_SEC.length}: backing off ${wait}s before 'continue'`)
      await sleep(wait * 1000)
      if (await attemptResume()) {
        resumed = true
        log(`resume confirmed on attempt ${attempt + 1}`)
        break
      }
      log(`attempt ${attempt + 1} did not pick up; ${attempt + 1 < BACKOFFS_SEC.length ? 'retrying' : 'giving up'}`)
    }
  }

  // Telegram ping — success quietly confirms recovery; failure asks for a hand.
  // Stay silent on success when we never had a chat to ping.
  if (process.env.TELEGRAM_BOT_TOKEN && chatIdsCsv) {
    // Each entry is "chatId" or "chatId:threadId" (forum topic) — see the
    // encoding in stopfailure-notify.ts. Split on the first ':' so the ping
    // threads back into the same topic the error notice went to.
    const targets = chatIdsCsv.split(',').filter(Boolean).map(c => {
      const idx = c.indexOf(':')
      return idx === -1
        ? { chatId: c, threadId: undefined as string | undefined }
        : { chatId: c.slice(0, idx), threadId: c.slice(idx + 1) || undefined }
    })
    const msg = resumed
      ? 'Recovered from a transient API error — agent resumed.'
      : `Couldn't auto-resume after a transient API error (${BACKOFFS_SEC.length} tries). ` +
        `Send "continue" when you're ready.`
    await Promise.all(targets.map(t => sendMessage(t.chatId, msg, t.threadId)))
    log(`telegram ping sent (resumed=${resumed})`)
  }
} finally {
  releaseLock()
}

process.exit(0)
