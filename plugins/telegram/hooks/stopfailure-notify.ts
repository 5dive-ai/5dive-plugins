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

import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, statSync, unlinkSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { STATE_DIR } from './lib/paths'
import { readPayload } from './lib/payload'
import { readEntries, findRateLimitText } from './lib/transcript'
import { getAllowedChatIds, getGroupTopics, getCallerChat, type CallerChat } from './lib/access'
import { sendMessage } from './lib/telegram'
import { capturePane, getTmuxContext } from './lib/tmux'
import { parseResetEpoch } from './lib/time'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()
const msg = [payload.message, payload.reason, typeof payload.error === 'string' ? payload.error : undefined, payload.stopReason]
  .filter(Boolean)
  .join(' | ') || 'no details'

const raw = JSON.stringify(payload)

// A transient server-side 429 ("Server is temporarily limiting requests · Rate
// limited") is explicitly NOT a usage limit — but its text literally contains
// the substring "usage limit" (in the phrase "not your usage limit"), so the
// naive usage-limit regex below matches it and we'd report a bogus "usage limit
// hit — couldn't read the reset time" (there's no reset epoch on a transient
// throttle). Detect the transient phrasing first and exclude it from the
// usage-limit branch; it's routed to the transient-API-error recovery instead.
const isTransientRateLimit = /not your usage limit|temporarily limiting requests/i.test(raw)
// `let`, not `const`: the confirmed-headroom check below (activeAccountHasHeadroom)
// may reclassify a transient burst 429 out of the rate-limit branch.
let isRateLimit = !isTransientRateLimit && /rate_limit|usage.limit/i.test(raw)

// Headroom thresholds for the burst-vs-quota reclassification below. A real
// quota exhaustion reports ~100% on the account's 5h/7d window; a transient
// burst (many agents sharing one account momentarily exceed the per-minute
// cap) leaves it well below. Require a recent sample — a stale cache can't
// disprove a fresh spike — so we only suppress rotation on positively-fresh,
// positively-low usage and otherwise fail safe to the existing behavior.
const HEADROOM_PCT = 90
const FRESH_USAGE_MAX_AGE_S = 15 * 60

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

// Transient API error (NOT a usage limit): claude exhausted its built-in
// retries on an Overloaded / 5xx response, aborted the turn, and dropped back
// to an idle prompt — no "Stop and wait" menu, no reset epoch. The
// `while true; claude; done` agent loop only restarts on process *exit*, so an
// aborted-turn-but-still-running claude just sits there until a human nudges
// it. We detect it here and fork resume-after-error.ts to type "continue" with
// backoff. Match the API status line in the pane ("API Error: Overloaded",
// "API Error: 529 …") and the raw payload ("overloaded_error" etc).
const transientHaystack = `${raw}\n${pane}`
// `let`: the headroom check below may add a burst 429 to this bucket.
let isTransientApiError =
  !isRateLimit &&
  (isTransientRateLimit ||
    /overloaded|API Error:\s*(?:5(?:0[234]|29))\b|"type":\s*"(?:overloaded|api)_error"/i.test(transientHaystack))

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

// --- Burst-vs-quota reclassification -------------------------------------
// A short-term burst 429 (`rate_limit_error` — several agents sharing one
// account momentarily exceed the per-minute request cap) and a real 5h/7d
// quota exhaustion BOTH stringify to a payload matching the usage-limit regex
// above. Only the latter actually parks the account; the burst clears in
// seconds. Rotating on a burst falsely cools a healthy account, mis-attributes
// a stray reset time (e.g. a subprocess's "session limit · resets 4am" line
// scraped from the pane), and cascades across accounts as each freshly-swapped
// one keeps bursting. So when we can POSITIVELY confirm the active account
// still has real headroom, treat it as a transient error: retry 'continue'
// with backoff instead of rotating / waiting out a reset we'll never hit.
// Uncertain (CLI error, stale/missing sample, at-limit) → leave as a rate
// limit and fall through to the existing rotate/wait behavior.
if (isRateLimit && tmuxCtx && activeAccountHasHeadroom()) {
  isRateLimit = false
  isTransientApiError = true
}

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
} else if (isTransientApiError) {
  // Transient server-side blip — an Overloaded/5xx, or a 429 "temporarily
  // limiting requests" that's explicitly NOT a usage limit. It self-clears on
  // retry, so lead with the reassuring framing (not "stopped with an error")
  // and surface the underlying API line. The resume-after-error helper drives
  // 'continue' with backoff when we have a pane to type into.
  const apiLine = pane?.split('\n').map(l => l.trim()).find(l => /^API Error:/i.test(l))
  const detail = apiLine ?? msg
  const recovery = tmuxCtx ? "Auto-retrying 'continue' with backoff." : 'Will resume on the next turn.'
  text = `Transient API throttle/overload — NOT a usage limit. ${recovery}\n${detail}`
} else {
  text = `The agent stopped with an error: ${msg}`
  if (pane) {
    const apiErr = pane.match(/API Error:\s+(?:\d+|Overloaded)[^.-]*/gi)?.pop()
    if (apiErr) text += `\n${apiErr}`
  }
}

// Caller-only narrowing: prefer the inbound chat (and its forum topic) the
// user actually wrote from. On an autonomous turn (no telegram inbound in the
// transcript — cron-triggered, long-running background agent, etc) fall back
// to the agent's bound group topic(s) so the alert lands in its own thread
// instead of buzzing every paired DM + the group's General channel. Only when
// no group is configured at all do we fan to all allowed chats — better a
// noisy alert than a silenced one.
let targets: CallerChat[]
const callerChat = getCallerChat(entries)
if (callerChat) {
  targets = [callerChat]
} else {
  const topics = getGroupTopics()
  targets = topics.length ? topics : getAllowedChatIds().map(chatId => ({ chatId }))
}

// For a recoverable rate limit (we have a pane to drive), claim the per-agent
// resume lock BEFORE notifying. If it's already held, a helper is mid-recovery
// and this StopFailure is just the poll loop's "continue" bouncing off the
// still-active limit — stay silent (no duplicate DM, no second helper) and let
// the running helper see it through. The lock dir doubles as the helper's log
// dir. The lock auto-expires (mtime TTL) so a crashed helper can't wedge
// recovery forever.
//
// The same lock serializes BOTH recovery flows (usage-limit and transient
// API error) — only one helper should drive the pane at a time.
const needsRecovery = (isRateLimit || isTransientApiError) && !!tmuxCtx
let lockPath: string | null = null
let resumeLogDir = ''
if (needsRecovery) {
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

// --- Multi-account auto-rotation (opt-in) --------------------------------
// For a real usage limit with a pane to drive, if this agent has rotation
// enabled and an eligible backup account, swap to it and resume THIS session
// on the new credentials instead of waiting out the reset. Reuses
// 5dive-agent-start's one-shot resume marker (the same mechanism /resume
// uses). Falls through to the normal wait-for-reset helper below when rotation
// is off or nothing is eligible (all cooling / none configured). We hold the
// resume lock here, so a concurrent StopFailure can't double-rotate.
if (needsRecovery && isRateLimit && tmuxCtx && lockPath) {
  const rot = tryRotate(resetEpoch)
  if (rot) {
    const rotText =
      `Usage limit hit on '${rot.from}' — rotating to '${rot.to}' and resuming this session on the new account.`
    await Promise.all(targets.map(t => sendMessage(t.chatId, rotText, t.threadId)))
    // The rotate scheduled a deferred unit restart that relaunches with
    // `claude --resume <id>` on the new creds — no wait-helper needed. The
    // restart tears this process down; the next episode reclaims the
    // dead-PID resume lock.
    process.exit(0)
  }
}

await Promise.all(targets.map(t => sendMessage(t.chatId, text, t.threadId)))

// Detach the recovery helper (we already hold the lock). Two flows share the
// same lock + ping encoding but own distinct helpers:
//   • usage limit      → resume-after-reset.ts (park menu, wait for reset,
//                         then continue + retry). Resumes even with NO reset
//                         epoch — the case that used to park the agent until a
//                         manual unlock.
//   • transient API err → resume-after-error.ts (no menu, no wait — just
//                         continue with backoff up to a cap).
// Encode the topic alongside each chat as "chatId:threadId" (bare "chatId"
// when General/DM) so the detached helper threads its resume ping back into
// the same forum topic. chat ids never contain ':' so a plain split is safe
// even for negative supergroup ids.
if (needsRecovery && tmuxCtx && lockPath) {
  const chatsCsv = targets.map(t => (t.threadId ? `${t.chatId}:${t.threadId}` : t.chatId)).join(',')
  const resumeHelper = isRateLimit
    ? join(import.meta.dir, 'resume-after-reset.ts')
    : join(import.meta.dir, 'resume-after-error.ts')
  const helperArgs = isRateLimit
    ? [resumeHelper, String(resetEpoch ?? 0), tmuxCtx.socket, tmuxCtx.target, chatsCsv, lockPath, transcriptPath ?? '']
    : [resumeHelper, tmuxCtx.socket, tmuxCtx.target, chatsCsv, lockPath, transcriptPath ?? '']
  if (existsSync(resumeHelper)) {
    const logFile = join(resumeLogDir, `resume-${Math.floor(Date.now() / 1000)}-${process.pid}.log`)
    const out = openSync(logFile, 'a')
    const child = spawn('bun', helperArgs, {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
    child.unref()
  } else {
    // Helper missing (deploy gap): we already DM'd, so just release the lock
    // so the next episode isn't blocked by a stale one.
    try {
      unlinkSync(lockPath)
    } catch {
      /* noop */
    }
  }
}

process.exit(0)

// deriveAgentName — the tmux session is named "agent-<name>" (5dive-agent-start).
function deriveAgentName(target: string): string | null {
  const sess = target.split(':')[0] ?? ''
  const m = sess.match(/^agent-(.+)$/)
  return m && m[1] ? m[1] : null
}

// activeAccountHasHeadroom — returns true ONLY when we can positively confirm
// this agent's current account is fresh-sampled AND below HEADROOM_PCT on both
// its 5h and 7d windows (i.e. a rate-limit signal can't be real quota
// exhaustion — it's a transient burst). Any uncertainty (no tmux, CLI failure,
// non-ok JSON, unknown active account, missing/stale sample, at-or-near limit)
// returns false so the caller falls back to the existing rotate-on-limit path.
// Two cheap CLI reads, well within the hook's 10s budget; same `sudo -n 5dive`
// privilege the rotation rotate call already relies on.
function activeAccountHasHeadroom(): boolean {
  if (!tmuxCtx) return false
  const agentName = deriveAgentName(tmuxCtx.target)
  if (!agentName) return false

  // Which account is this agent on right now?
  let active = ''
  try {
    const rg = spawnSync('sudo', ['-n', '5dive', '--json', 'agent', 'rotation', 'get', agentName], {
      encoding: 'utf8',
      // Short timeout: both reads run sequentially BEFORE the DM/rotate, and a
      // killed hook (10s budget) recovers nothing. These fire under the same
      // high-load condition that can slow the CLI, so keep the worst case well
      // under budget; a timeout just returns false → existing rotate behavior.
      timeout: 3500,
    })
    const j = JSON.parse((rg.stdout || '').trim())
    if (!j?.ok) return false
    active = String(j.data?.active ?? '')
  } catch {
    return false
  }
  if (!active) return false

  // Freshest measured usage per account (reads each account's newest agent
  // statusline cache; shape: data[].usage.{fiveHour,sevenDay}.pct + asOf).
  let rows: any[] = []
  try {
    const au = spawnSync('sudo', ['-n', '5dive', '--json', 'account', 'usage'], {
      encoding: 'utf8',
      timeout: 3500, // see note above; sub-second normally, fail-safe on timeout
    })
    const j = JSON.parse((au.stdout || '').trim())
    if (!j?.ok || !Array.isArray(j.data)) return false
    rows = j.data
  } catch {
    return false
  }

  const u = rows.find(r => r?.name === active)?.usage
  if (!u) return false
  // Require a recent sample — a stale cache can't disprove a fresh spike.
  const asOf = typeof u.asOf === 'number' ? u.asOf : 0
  if (!asOf || Math.floor(Date.now() / 1000) - asOf > FRESH_USAGE_MAX_AGE_S) return false
  // Missing window → assume worst (no headroom) so we don't suppress wrongly.
  const five = typeof u.fiveHour?.pct === 'number' ? u.fiveHour.pct : 100
  const seven = typeof u.sevenDay?.pct === 'number' ? u.sevenDay.pct : 100
  return five < HEADROOM_PCT && seven < HEADROOM_PCT
}

// tryRotate — arm the one-shot resume marker, then ask the CLI to swap to the
// next eligible account. Returns {from,to} on a real rotation, else null
// (rotation disabled, nothing eligible, or any failure → caller waits for
// reset). The CLI is the single source of truth for eligibility/selection; we
// only translate its verdict. The marker is armed BEFORE the swap so the
// post-rotate restart resumes this conversation, and removed when no rotation
// happens so a later unrelated restart can't wrongly resume a stale session.
function tryRotate(resetEpoch: number | null): { from: string; to: string } | null {
  if (!tmuxCtx) return null
  const agentName = deriveAgentName(tmuxCtx.target)
  if (!agentName) return null
  // claude writes the transcript as <session-id>.jsonl; that basename is the
  // id `claude --resume` wants.
  const sessionId = transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : ''
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return null

  // Line 1 = session id; line 2 = the auto-resume prompt. A bare
  // `claude --resume <id>` reloads the conversation but sits idle at the prompt,
  // so without line 2 the swapped-in account would carry full context yet never
  // answer the in-flight turn. 5dive-agent-start reads line 2 and appends it as
  // the first interactive prompt, so the new account picks up automatically.
  // The prompt is "continue and reply to the latest message", not a bare
  // "continue": when the interrupted turn was an unanswered user DM (not a
  // multi-step task), bare "continue" makes the model hunt for in-progress work,
  // find none, and stay silent — so it never answers the user. The explicit
  // "reply to the latest message" covers both cases (finish the task AND answer
  // the pending message). Manual /resume omits line 2 and stays idle (unchanged).
  const marker = join(STATE_DIR, 'resume-next')
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = `${marker}.tmp.${process.pid}`
    writeFileSync(tmp, sessionId + '\ncontinue and reply to the latest message\n', { mode: 0o600 })
    renameSync(tmp, marker)
  } catch {
    return null
  }

  // Cool the account we're leaving until its reset (or a 5h fallback when the
  // reset time was unreadable) so we don't bounce straight back to it.
  const cooldownUntil =
    resetEpoch && resetEpoch > 0 ? resetEpoch : Math.floor(Date.now() / 1000) + 5 * 3600
  const r = spawnSync(
    'sudo',
    ['-n', '5dive', '--json', 'agent', 'rotation', 'rotate', agentName, `--cooldown-current=${cooldownUntil}`],
    { encoding: 'utf8', timeout: 8000 },
  )
  let parsed: any = null
  try {
    parsed = JSON.parse((r.stdout || '').trim())
  } catch {
    /* non-JSON / CLI failure → treat as no rotation */
  }
  if (parsed?.ok && parsed.data?.rotated && parsed.data?.to) {
    return { from: parsed.data.from ?? '?', to: String(parsed.data.to) }
  }
  // No rotation — drop the marker we armed.
  try {
    unlinkSync(marker)
  } catch {
    /* noop */
  }
  return null
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
// here is this StopFailure HOOK process, which spawns the detached helper and
// then exits within milliseconds — so a PID-liveness check ALWAYS saw it dead,
// declared the lock stale, and re-notified + re-spawned on every single
// StopFailure. A fast claude-restart-while-limited loop turned that into 700+
// identical "usage limit" DMs in ~20s. mtime + heartbeat is immune: the very
// first acquire stamps a fresh mtime, so a same-instant second StopFailure
// already sees the lock held.
const RESUME_LOCK_TTL_MS = 10 * 60 * 1000 // 10 min; helper heartbeats well under this
function tryAcquireResumeLock(lockPath: string): boolean {
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
    try {
      const fd = openSync(lockPath, 'w')
      writeSync(fd, `${process.pid} ${Date.now()}`)
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }
}
