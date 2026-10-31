#!/usr/bin/env -S bun
// DIVE-6715: Stop hook. Telegram's stop-reply-check catches the turn where the
// agent answered a message in its own session and never called the reply tool;
// the dashboard had no hook, so the person on the web chat waited forever.
//
//   always                                   → tell the server the turn ended
//                                              (the chat stops showing "working")
//   no web-chat message this turn            → nothing (a Telegram, a2a or
//                                              autonomous turn is not ours)
//   the dashboard reply tool ran after it    → nothing (loose text is narration)
//   text written after it, no reply          → send that text into the chat
//   no text, no tool at all, a real message  → block the Stop once so the agent
//                                              answers (stop_hook_active = the
//                                              re-entry; never block twice)
//
// Sending goes through the notice outbox (DIVE-6714): the server holds the
// credential, a hook does not.

import { existsSync } from 'fs'
import { setTimeout as sleep } from 'timers/promises'
import { readPayload } from './lib/payload'
import { readEntries, transcriptSize, isBareAck } from './lib/transcript'
import { emitBlock } from './lib/output'
import {
  answeredAfter,
  assistantTextsAfter,
  signalTurnEnded,
  turnDashboardInbound,
  usedToolAfter,
  writeOutbox,
} from './lib/dashboard-chat'
import type { HookPayload, TranscriptEntry } from './lib/types'

// DIVE-7434: this hook's own deadline, under hooks.json's 10s. Claude Code's
// timeout did not reap a hook the kernel was throttling (one lived 2:56 h),
// so the hook ends itself; bounded transcript reads keep the loop free to fire.
setTimeout(() => process.exit(0), 9_000).unref()

const log = (s: string) => console.error(`[dashboard-stop] ${s}`)

const payload = await readPayload<HookPayload>()

// First, before any early exit: every Stop ends the turn (Telegram's DIVE-5419 rule).
signalTurnEnded()

const transcriptPath = payload.transcript_path
if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0)

// Claude appends the turn's last message after Stop can fire; read until the
// tail stops growing (Telegram's readStableEntries, same bounds; the file
// size, since readEntries is a tail window — DIVE-7434).
async function readStable(path: string): Promise<TranscriptEntry[]> {
  const deadline = Date.now() + 1500
  let size = transcriptSize(path)
  let prev = -1
  do {
    prev = size
    await sleep(120)
    size = transcriptSize(path)
  } while (size !== prev && Date.now() < deadline)
  return readEntries(path)
}

const entries = await readStable(transcriptPath)
const inbound = turnDashboardInbound(entries)
if (!inbound) process.exit(0)
if (answeredAfter(entries, inbound.index)) process.exit(0)

const texts = assistantTextsAfter(entries, inbound.index)
if (texts.length > 0) {
  const file = writeOutbox('relay', { chat_id: inbound.chatId, text: texts.join('\n\n') })
  log(`no reply tool this turn; relayed ${texts.length} message(s) via ${file}`)
  process.exit(0)
}

// Nothing written and nothing run: the agent stopped on the message. "ok" and
// "thanks" need no answer (Telegram's DIVE-5419 rule); anything else gets one
// retry, and only one.
if (payload.stop_hook_active === true || usedToolAfter(entries, inbound.index) || isBareAck(inbound.text)) process.exit(0)
emitBlock(
  'You received a message in the 5dive dashboard chat (chat_id=' + inbound.chatId + ') and the turn ended with ' +
    'neither text nor a reply. Answer it now with mcp__plugin_dashboard_dashboard__reply before stopping.',
)
process.exit(0)
