#!/usr/bin/env -S bun
// StopFailure hook: relay failure info to Telegram. For rate-limit failures,
// fork the resume-after-reset helper which owns the full recovery flow
// (auto-press "1" on the menu, wait for reset, type "continue", ping). The
// hook itself stays short — well under its 10s timeout — because all the
// slow parts (menu polling, long wait) live in the detached helper.
//
// Auto-registered via the plugin manifest (hooks/hooks.json). Reads
// TELEGRAM_BOT_TOKEN from the inherited env (set by whatever launched
// claude: a 5dive-agent systemd unit, a claude-always-on user unit /
// launchd plist, an interactive shell that sourced
// ~/.claude/channels/telegram/.env, etc).

import { spawn } from 'child_process'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, statSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { readEntries, findRateLimitText } from './lib/transcript'
import { getAllowedChatIds, getCallerChatId } from './lib/access'
import { sendMessage } from './lib/telegram'
import { capturePane, getTmuxContext } from './lib/tmux'
import { parseResetEpoch } from './lib/time'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()
const msg = [payload.message, payload.reason, typeof payload.error === 'string' ? payload.error : undefined, payload.stopReason]
  .filter(Boolean)
  .join(' | ') || 'no details'

const raw = JSON.stringify(payload)
const isRateLimit = /rate_limit|usage.limit/i.test(raw)

const transcriptPath = payload.transcript_path
let entries = transcriptPath ? readEntries(transcriptPath) : []

// Capture the pane up front. Two uses:
//   1. Scrape "API Error: 529 ..." for non-rate-limit failures (payload only
//      carries the high-level reason; the API status line appears only in
//      claude's pane output).
//   2. Last-resort fallback for the rate-limit reset time.
//
// Not the primary source for rate-limit timing: when claude shows the
// "Stop and wait" menu, the pane switches to the alternate screen and
// the preceding "resets Xpm (TZ)" line disappears from `tmux capture-pane`.
// The transcript captures that line as a structured synthetic message
// (error="rate_limit", isApiErrorMessage=true) and is immune.
const pane = capturePane()

// Resolve an unlock/reset epoch. Order: payload → transcript → message text → pane.
let resetEpoch: number | null = null

const resetRaw =
  (payload.resetsAt as number | string | undefined) ??
  (payload.reset_at as number | string | undefined) ??
  (payload.resetAt as number | string | undefined) ??
  (typeof payload.error === 'object' && payload.error?.resetsAt) ??
  payload.rateLimit?.resetsAt

if (resetRaw !== undefined && resetRaw !== null) {
  resetEpoch = parseResetEpoch(String(resetRaw))
}

if (resetEpoch === null && transcriptPath) {
  // The synthetic rate-limit entry is written ~concurrently with this hook
  // firing, so the first read can miss it (flush race). findRateLimitText is
  // bounded to recent entries, so a miss returns null rather than silently
  // reusing a stale earlier-episode reset line — which means we can safely
  // retry: re-read the transcript a few times over ~2s to catch the write.
  // Well within the hook's 10s budget; the slow recovery lives in the detached
  // helper, not here. Non-rate-limit failures don't retry (no extra latency).
  const tries = isRateLimit ? 5 : 1
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 500))
      entries = readEntries(transcriptPath)
    }
    const transcriptResetText = findRateLimitText(entries)
    if (transcriptResetText) {
      const e = parseResetEpoch(transcriptResetText)
      if (e !== null) {
        resetEpoch = e
        break
      }
    }
  }
}

if (resetEpoch === null) {
  resetEpoch = parseResetEpoch(msg)
}

if (resetEpoch === null && pane) {
  const line = pane.split('\n').find(l => /resets?\s+\d/i.test(l))
  if (line) resetEpoch = parseResetEpoch(line)
}

// Time-left string for the DM.
let timeLeft = ''
if (resetEpoch !== null) {
  const delta = resetEpoch - Math.floor(Date.now() / 1000)
  if (delta <= 0) timeLeft = 'any moment now'
  else if (delta < 60) timeLeft = `${delta}s`
  else if (delta < 3600) timeLeft = `${Math.floor(delta / 60)}m`
  else {
    const h = Math.floor(delta / 3600)
    const m = Math.floor((delta % 3600) / 60)
    timeLeft = m === 0 ? `${h}h` : `${h}h ${m}m`
  }
}

const tmuxCtx = getTmuxContext()

// Build the DM text. Advertise auto-resume only when BOTH reset epoch AND
// tmux context are present — that's when the resume fork below will run.
let text: string
if (isRateLimit) {
  if (timeLeft && tmuxCtx) {
    text = `Usage limit hit — resumes in ${timeLeft}. Will auto-press the menu and type 'continue' when the limit lifts.`
  } else if (tmuxCtx) {
    // Couldn't read a reset time, but we still have a pane to drive — the
    // helper below polls and resumes on its own, so this is NOT a dead end.
    text = `Usage limit hit — couldn't read the reset time. I'll keep retrying and resume automatically once it lifts.`
  } else if (timeLeft) {
    text = `Usage limit hit — resumes in ${timeLeft}.`
  } else {
    text = 'Usage limit hit — waiting for reset.'
  }
} else {
  text = `The agent stopped with an error: ${msg}`
  if (pane) {
    const apiErr = pane.match(/API Error:\s+\d+[^.-]*/g)?.pop()
    if (apiErr) text += `\n${apiErr}`
  }
}

// Caller-only narrowing: prefer the inbound chat over fanning to all
// paired chats. Falls back to all chats for autonomous turns so we don't
// silence the alert entirely.
let chatIds: string[]
const callerChat = getCallerChatId(entries)
if (callerChat) chatIds = [callerChat]
else chatIds = getAllowedChatIds()

// For a recoverable rate limit (we have a pane to drive), claim the per-agent
// resume lock BEFORE notifying. If it's already held, a helper is mid-recovery
// and this StopFailure is just the poll loop's "continue" bouncing off the
// still-active limit — stay silent (no duplicate DM, no second helper) and let
// the running helper see it through. The lock dir doubles as the helper's log
// dir. The lock auto-expires (mtime TTL) so a crashed helper can't wedge
// recovery forever.
let lockPath: string | null = null
let resumeLogDir = ''
if (isRateLimit && tmuxCtx) {
  resumeLogDir = join(homedir(), '.cache', '5dive-telegram', 'resume')
  try {
    mkdirSync(resumeLogDir, { recursive: true })
  } catch {
    resumeLogDir = '/tmp'
  }
  lockPath = join(resumeLogDir, 'resume.lock')
  if (!tryAcquireResumeLock(lockPath)) {
    process.exit(0)
  }
}

await Promise.all(chatIds.map(cid => sendMessage(cid, text)))

// Detach the recovery helper (we already hold the lock). It poll-retries and
// resumes once the limit lifts — even with NO reset epoch, which is exactly
// the case that used to leave the agent parked until a manual unlock. The
// helper releases the lock when it finishes.
if (isRateLimit && tmuxCtx && lockPath) {
  const resumeHelper = join(import.meta.dir, 'resume-after-reset.ts')
  if (existsSync(resumeHelper)) {
    const logFile = join(resumeLogDir, `resume-${Math.floor(Date.now() / 1000)}-${process.pid}.log`)
    const out = openSync(logFile, 'a')
    const child = spawn(
      'bun',
      [
        resumeHelper,
        String(resetEpoch ?? 0),
        tmuxCtx.socket,
        tmuxCtx.target,
        chatIds.join(','),
        lockPath,
        transcriptPath ?? '',
      ],
      {
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
      },
    )
    child.unref()
  } else {
    // Helper missing (deploy gap): we already DM'd, so just release the lock
    // so the next limit episode isn't blocked by a stale one.
    try {
      unlinkSync(lockPath)
    } catch {
      /* noop */
    }
  }
}

process.exit(0)

// Best-effort cross-process lock guarding a single resume helper per agent.
// Exclusive-create wins; an existing lock is honored unless it's older than
// the TTL (longer than the helper's max retry window), in which case it's
// treated as stale and taken over.
const RESUME_LOCK_TTL_MS = 6.5 * 3600 * 1000
function tryAcquireResumeLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, `${process.pid} ${Date.now()}`)
    closeSync(fd)
    return true
  } catch {
    try {
      const st = statSync(lockPath)
      if (Date.now() - st.mtimeMs > RESUME_LOCK_TTL_MS) {
        const fd = openSync(lockPath, 'w')
        writeSync(fd, `${process.pid} ${Date.now()}`)
        closeSync(fd)
        return true
      }
    } catch {
      /* lock vanished mid-check — let the next StopFailure retry acquire it */
    }
    return false
  }
}
