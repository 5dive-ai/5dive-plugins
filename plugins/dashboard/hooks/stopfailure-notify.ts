#!/usr/bin/env -S bun
// DIVE-6714: StopFailure on a dashboard-paired seat. Before this hook the web
// chat went silent when the agent hit its usage limit (or an Overloaded/5xx
// blip): no notice, and on a seat without Telegram nothing typed 'continue'
// either, so the message waited until a human nudged the pane.
//
// Everything that decides WHAT happened and WHEN it lifts is Telegram's own
// code, run from byte-identical copies (SHARED.txt): classifyFailure,
// resolveResetEpoch, claimNotify (DIVE-122's cooldown that survives respawns),
// the resume lock and the two resume helpers. This file only adds the web chat.
//
//   1. A usage limit or a transient blip, and the person wrote in the web chat
//      this session → ONE notice in that chat per episode (own stamp, so Telegram
//      and the dashboard each get exactly one), sent by the dashboard server
//      from the notice outbox.
//   2. Recovery: when the seat ALSO runs the telegram plugin, its hook owns the
//      resume (one helper per pane, one lock). Otherwise this hook takes the same
//      lock and runs the same helper, telling it to answer the waiting message.
//
// Terms walls and other stops are left alone here: Telegram's hook covers them
// on a seat that has it, and they are outside this row.

import { spawn } from 'child_process'
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { readEntries } from './lib/transcript'
import { capturePane, getTmuxContext } from './lib/tmux'
import { classifyFailure, failureMessage, resolveResetEpoch } from './lib/failure'
import { claimNotify, notifyStampPath, pruneStaleNotifyStamps, pruneOldResumeLogs } from './lib/notify-dedup'
import { resumeLogDir, tryAcquireResumeLock } from './lib/resume-lock'
import { answeredAfter, dashboardStateDir, lastDashboardInbound, noticeLang, noticeText, signalTurnEnded, writeNotice } from './lib/dashboard-chat'
import type { HookPayload } from './lib/types'

const log = (s: string) => console.error(`[dashboard-stopfailure] ${s}`)

const payload = await readPayload<HookPayload>()
// DIVE-6715: a failed turn is still a finished one; the chat stops showing "working".
signalTurnEnded()
const raw = JSON.stringify(payload)
const msg = failureMessage(payload)
const pane = capturePane()
const kind = classifyFailure(payload, raw, pane)
if (!kind.isRateLimit && !kind.isTransientApiError) {
  log('not a usage limit or a transient error — nothing to do here')
  process.exit(0)
}
const noticeKind = kind.isRateLimit ? 'ratelimit' : 'transient'

const transcriptPath = payload.transcript_path
const first = transcriptPath ? readEntries(transcriptPath) : []
const { resetEpoch, entries } = await resolveResetEpoch(payload, msg, pane, kind.isRateLimit, first)

const inbound = lastDashboardInbound(entries)
const pending = inbound !== null && !answeredAfter(entries, inbound.index)
const tmuxCtx = getTmuxContext()

// Which seat this is, for the stamp: the tmux session is "agent-<name>".
const agent = (tmuxCtx?.target.split(':')[0] ?? '').replace(/^agent-/, '') || (process.env.USER ?? '').replace(/^agent-/, '') || 'unknown'

// --- 1. the notice, once per episode ----------------------------------------
// Own dir, so this stamp never swallows (or is swallowed by) Telegram's: a seat
// on both channels gets one notice in each. Keyed like Telegram's: kind, and
// for a usage limit the reset, so a NEW wall notifies again.
const stampDir = join(dashboardStateDir(), 'notify')
// claimNotify needs the dir: without it every claim reads as a lost race and
// the notice is never sent.
try { mkdirSync(stampDir, { recursive: true, mode: 0o700 }) } catch {}
const stamp = notifyStampPath(stampDir, `${agent}:${noticeKind}`, kind.isRateLimit ? resetEpoch : null)
const claim = claimNotify(stamp, Date.now())
log(`${noticeKind} dedup: ${claim.send ? 'SEND' : 'suppress'} (${claim.reason}) reset=${resetEpoch ?? 'null'} chat=${inbound?.chatId ?? '(none)'}`)
if (claim.send) {
  pruneStaleNotifyStamps(stampDir, Date.now())
  if (inbound) {
    const file = writeNotice(inbound.chatId, noticeText(noticeKind, resetEpoch, Math.floor(Date.now() / 1000), noticeLang(inbound)))
    log(`notice queued ${file}`)
  } else {
    log('no web-chat message this session — no notice')
  }
}

// --- 2. recovery --------------------------------------------------------------
if (!tmuxCtx) {
  log('no tmux pane — nothing to resume')
  process.exit(0)
}
if (telegramEnabled()) {
  log('telegram plugin is on this seat — its hook owns the resume')
  process.exit(0)
}
// DIVE-1107's rule, as in Telegram's hook: the helper spawn rides the same
// per-episode claim as the notice, so a release/re-trigger loop cannot chain
// helpers. Then the shared lock: one helper per pane, whoever runs it.
if (!claim.send) process.exit(0)
const dir = resumeLogDir()
const lockPath = join(dir, 'resume.lock')
if (!tryAcquireResumeLock(lockPath)) {
  log('a resume helper already holds the lock')
  process.exit(0)
}
const helper = join(import.meta.dir, kind.isRateLimit ? 'resume-after-reset.ts' : 'resume-after-error.ts')
if (!existsSync(helper)) {
  try { unlinkSync(lockPath) } catch {}
  process.exit(0)
}
// No Telegram chats to ping: the helper only drives the pane. It types "continue
// and reply to the latest message" when the web chat is waiting (resume-prompt.ts).
const args = kind.isRateLimit
  ? [helper, String(resetEpoch ?? 0), tmuxCtx.socket, tmuxCtx.target, '', lockPath, transcriptPath ?? '']
  : [helper, tmuxCtx.socket, tmuxCtx.target, '', lockPath, transcriptPath ?? '']
pruneOldResumeLogs(dir, Date.now())
const out = openSync(join(dir, `resume-dashboard-${Math.floor(Date.now() / 1000)}-${process.pid}.log`), 'a')
const child = spawn(process.env.DASHBOARD_RESUME_BUN ?? 'bun', args, {
  detached: true,
  stdio: ['ignore', out, out],
  env: { ...process.env, ...(pending ? { RESUME_PENDING_REPLY: '1' } : {}) },
})
child.unref()
log(`resume helper started (${kind.isRateLimit ? 'reset' : 'error'}) pending_reply=${pending}`)
process.exit(0)

// Is the telegram plugin enabled for this seat? Its own StopFailure hook then
// runs the resume, and a second helper would type into the same pane.
function telegramEnabled(): boolean {
  try {
    const s = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'), 'utf8'))
    return s?.enabledPlugins?.['telegram@5dive-plugins'] === true
  } catch {
    return false
  }
}
