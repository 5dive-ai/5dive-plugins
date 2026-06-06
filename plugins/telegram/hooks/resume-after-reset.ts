#!/usr/bin/env -S bun
// Spawned detached by stopfailure-notify.ts when a usage limit is detected and
// we have a tmux pane to drive. Owns the full rate-limit recovery flow:
//
//   Phase 1 (park): poll the pane for claude's "1. Stop and wait" menu and
//     press "1" so the session stays alive while we wait.
//
//   Phase 2 (wait): if we were given a TRUSTWORTHY reset epoch (in the future
//     and within the recovery budget), sleep until then + a buffer. A missing,
//     past, or absurdly-far epoch skips straight to Phase 3 — better to poll
//     than to honor a mis-parsed time and sleep for hours.
//
//   Phase 3 (resume + retry): type "continue" and verify claude actually
//     picked back up (a new non-error assistant entry in the transcript; pane
//     fallback when no transcript path). If still limited, back off and retry —
//     re-parsing any reset time that appears in the pane — until it lifts or
//     the budget runs out. THIS is the deadlock fix: with no reset time the old
//     code forked nothing and the agent sat parked until a manual unlock.
//
//   Phase 4 (ping): tell the paired chats we resumed, or that we gave up.
//
// Argv: <reset_epoch> <tmux_socket> <tmux_target> <chat_ids_csv> <lock_path> <transcript_path>
// Env:  TELEGRAM_BOT_TOKEN (required for the notification)
//
// Why this lives outside the StopFailure hook: the hook has timeout=10s but
// menu rendering lags and the wait/retry can run for hours. stopfailure-notify
// spawns this detached so it runs free of the hook timeout.

import { setTimeout as sleep } from 'timers/promises'
import { unlinkSync, utimesSync } from 'fs'
import { capturePaneFor, sendKeys, type TmuxCtx } from './lib/tmux'
import { sendMessage } from './lib/telegram'
import { readEntries } from './lib/transcript'
import { parseResetEpoch } from './lib/time'

const resetEpoch = parseInt(process.argv[2] ?? '0', 10) || 0
const socket = process.argv[3] ?? ''
const target = process.argv[4] ?? ''
const chatIdsCsv = process.argv[5] ?? ''
const lockPath = process.argv[6] ?? ''
const transcriptPath = process.argv[7] ?? ''

// Split into two budgets so weekly-cap resets — where the API hands us a
// real future epoch 12-24h out — don't get treated as untrustworthy and
// bumped to the retry loop, where the retry loop's own 6h ceiling then
// gives up before the limit actually lifts.
const MAX_WAIT_SEC = 30 * 3600 // trust a future reset epoch up to 30h (5h rolling + weekly cap)
const MAX_RETRY_SEC = 6 * 3600 // after wait/blind, poll-retry for this long before giving up
const RETRY_INTERVAL_SEC = 300 // back-off between blind resume attempts
// DIVE-122: when we have NO trustworthy reset epoch, hold the parked menu for
// this long before the first "continue" attempt. Waking claude immediately into
// a still-active limit makes it re-limit and, when it exits instead of
// re-parking, feeds the systemd respawn loop. Bounded so we never wedge — Phase
// 3's verified retry runs after it.
const BLIND_PARK_SEC = 300
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
// only while its mtime is fresh (< RESUME_LOCK_TTL_MS, 10min), so we MUST
// heartbeat for the entire time we're working — including the long Phase-2
// wait-for-reset — or a concurrent StopFailure will declare the lock stale,
// reclaim it, and re-DM + spawn a duplicate helper (the 700-DMs-in-20s bug).
function heartbeat(): void {
  if (!lockPath) return
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch {
    /* lock vanished — recovery will end naturally */
  }
}

// sleep, but heartbeat the lock every ≤60s so long waits don't let it go stale.
async function sleepHeartbeat(totalMs: number): Promise<void> {
  const STEP_MS = 60 * 1000
  let left = totalMs
  while (left > 0) {
    const chunk = Math.min(STEP_MS, left)
    await sleep(chunk)
    left -= chunk
    heartbeat()
  }
}

const MENU_RE = /\b\d\.\s*Stop and wait/i

// parkHold — keep claude parked on the "Stop and wait" menu for up to totalMs,
// re-pressing "1" whenever the menu is showing (a respawn may have redrawn it)
// and heartbeating the dedup lock throughout. Used for the DIVE-122 blind wait
// when we have no trustworthy reset epoch: holding the menu keeps the session
// ALIVE instead of waking it into the live limit (which can make claude exit and
// trigger a systemd respawn). Returns early — never wedges — if the menu is gone
// and the pane shows no limit banner (claude looks clear, let Phase 3 verify).
async function parkHold(totalMs: number): Promise<void> {
  const STEP_MS = 30 * 1000
  let left = totalMs
  while (left > 0) {
    if (ctx) {
      const pane = capturePaneFor(ctx)
      if (MENU_RE.test(pane)) {
        sendKeys(ctx, '1', 'Enter')
      } else if (!paneStillLimited(pane)) {
        return // menu gone and no limit banner — don't keep holding
      }
    }
    const chunk = Math.min(STEP_MS, left)
    await sleep(chunk)
    left -= chunk
    heartbeat()
  }
}

// Narrow "still limited" signal for the pane fallback: the transient parked
// menu or an active limit banner. Deliberately specific — generic "usage
// limit" prose can linger in scrollback after a successful resume.
function paneStillLimited(pane: string): boolean {
  return (
    MENU_RE.test(pane) ||
    /resets?\s+(?:at\s+|in\s+)?\d|reached your (?:usage )?limit|approaching (?:your )?(?:usage )?limit/i.test(pane)
  )
}

// A genuine resume = a NEW assistant message after `baseline` that isn't itself
// a rate-limit error notice. Transcript is the source of truth (immune to the
// pane scrollback staleness that the alt-screen menu causes).
function resumedSince(baseline: number): boolean {
  if (!transcriptPath || baseline < 0) return false
  const entries = readEntries(transcriptPath)
  for (let i = baseline; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'assistant' && e.error !== 'rate_limit') return true
  }
  return false
}

function transcriptLen(): number {
  if (!transcriptPath) return -1
  return readEntries(transcriptPath).length
}

// One resume attempt: dismiss the menu if showing, type "continue", then watch
// (~24s) for claude to actually pick up. Returns true on confirmed resume.
async function attemptResume(): Promise<boolean> {
  if (!ctx) return false
  const baseline = transcriptLen()
  if (MENU_RE.test(capturePaneFor(ctx))) {
    sendKeys(ctx, '1', 'Enter')
    await sleep(2000)
  }
  sendKeys(ctx, 'continue and reply to the latest message', 'Enter')
  for (let i = 0; i < VERIFY_POLLS; i++) {
    await sleep(VERIFY_STEP_MS)
    if (transcriptPath) {
      if (resumedSince(baseline)) return true
    } else if (!paneStillLimited(capturePaneFor(ctx))) {
      return true
    }
  }
  return false
}

log(
  `resume-after-reset start: reset_epoch=${resetEpoch} socket=${socket} ` +
    `target=${target} transcript=${transcriptPath ? 'yes' : 'no'}`,
)

let resumed = false
try {
  // Phase 1 — park the menu while we wait (poll up to 60s for it to render).
  if (ctx) {
    let pressed = false
    for (let attempt = 0; attempt < 60; attempt++) {
      if (MENU_RE.test(capturePaneFor(ctx))) {
        sendKeys(ctx, '1', 'Enter')
        pressed = true
        log(`phase1 pressed '1' on attempt ${attempt}`)
        break
      }
      await sleep(1000)
      heartbeat()
    }
    if (!pressed) log('phase1 menu never appeared after 60s — proceeding anyway')
  }

  // Phase 2 — precise wait only for a trustworthy epoch.
  {
    const now = Math.floor(Date.now() / 1000)
    const delta = resetEpoch - now
    if (delta > 0 && delta <= MAX_WAIT_SEC) {
      log(`phase2 sleeping ${delta + 30}s until reset`)
      await sleepHeartbeat((delta + 30) * 1000)
    } else if (resetEpoch > 0) {
      log(`phase2 reset epoch out of trusted window (delta=${delta}s) — going to retry loop`)
    } else {
      // DIVE-122: no trustworthy reset epoch. Don't fall straight into Phase 3's
      // "continue" (it wakes claude into the still-active limit → re-limit →
      // possible exit → systemd respawn loop). Hold the parked menu for a bounded
      // blind interval first, then let the verified retry loop take over.
      // Rotation isn't our concern here: the hook only spawns us AFTER its own
      // rotate attempt declined, and every respawn re-evaluates rotation.
      log(`phase2 no reset epoch — blind park-hold ${BLIND_PARK_SEC}s before retry loop`)
      await parkHold(BLIND_PARK_SEC * 1000)
    }
  }

  // Phase 3 — resume with verification + bounded retry.
  if (ctx) {
    const start = Math.floor(Date.now() / 1000)
    while (Math.floor(Date.now() / 1000) - start < MAX_RETRY_SEC) {
      if (await attemptResume()) {
        resumed = true
        log('phase3 resume confirmed')
        break
      }
      // Still limited. If the live pane reveals a parseable reset time, wait
      // precisely for it; otherwise back off a fixed interval and try again.
      const line = capturePaneFor(ctx)
        .split('\n')
        .find(l => /resets?\s+\d|try again|in\s+\d+\s*(?:h|m|hour|min)/i.test(l))
      const epoch = line ? parseResetEpoch(line) : null
      const now = Math.floor(Date.now() / 1000)
      if (epoch && epoch > now && epoch - now <= MAX_WAIT_SEC) {
        log(`phase3 still limited; learned reset, sleeping ${epoch - now + 30}s`)
        await sleepHeartbeat((epoch - now + 30) * 1000)
      } else {
        log(`phase3 still limited; retrying in ${RETRY_INTERVAL_SEC}s`)
        await sleepHeartbeat(RETRY_INTERVAL_SEC * 1000)
      }
    }
  }

  // Phase 4 — Telegram ping (success, or a heads-up that we gave up).
  if (process.env.TELEGRAM_BOT_TOKEN && chatIdsCsv) {
    // Each entry is "chatId" or "chatId:threadId" (forum topic) — see the
    // encoding in stopfailure-notify.ts. Split on the first ':' so the resume
    // ping lands back in the same topic the limit notice went to.
    const targets = chatIdsCsv.split(',').filter(Boolean).map(c => {
      const idx = c.indexOf(':')
      return idx === -1
        ? { chatId: c, threadId: undefined as string | undefined }
        : { chatId: c.slice(0, idx), threadId: c.slice(idx + 1) || undefined }
    })
    const msg = resumed
      ? 'Usage limit reset — agent resumed.'
      : `Still rate-limited after ${Math.round(MAX_RETRY_SEC / 3600)}h — couldn't auto-resume. ` +
        `Send "continue" or /resume when you're ready.`
    await Promise.all(targets.map(t => sendMessage(t.chatId, msg, t.threadId)))
    log(`phase4 telegram ping sent (resumed=${resumed})`)
  }
} finally {
  releaseLock()
}

process.exit(0)
