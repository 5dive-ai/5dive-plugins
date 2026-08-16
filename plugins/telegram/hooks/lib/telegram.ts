// Bot API client used by every hook that needs to DM. fetch is built into
// bun — no curl shellout. Telegram caps sendMessage text at 4096 chars;
// we truncate at 4000 with a "[truncated]" tail to leave headroom for the
// utf-8 byte counting Telegram does (text length is character-count but
// transport is bytes).

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AccessConfig } from './types'

const TELEGRAM_TEXT_MAX = 4000

export function getToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN
}

// DIVE-3445: every hook that DMs picks its destination out of TRANSCRIPT TEXT
// (analyzeTurn's lastChatId, access.getCallerChat), and text is settable by
// anything that can put characters into a user entry — an a2a message body, a
// tool_result carrying a grep hit. trustedChannelTags refuses the measured
// vector at the source; this is the second, independent layer at the choke
// point, so a future caller that finds a chat id some other way cannot
// reintroduce the hole. Same place and reason as the DIVE-1674 guard below.
//
// FAIL-OPEN ON AN EMPTY ALLOWLIST, deliberately. An unreadable or not-yet-written
// access.json is indistinguishable from "deny everyone", and refusing every send
// on it converts a missing config into total silence — the DIVE-3422 failure,
// which is worse than the hole this guards, because silence is invisible from
// both ends. Fail CLOSED only when a list EXISTS and the chat is not on it.
export function isAllowedChat(chatId: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  return allowed.includes(chatId)
}

// The allowlist, read fresh, WITHOUT importing ./access or ./paths.
//
// That is not tidiness — it is required. ./paths binds STATE_DIR from the
// environment AT MODULE LOAD, and every hook's state file hangs off it. Pulling
// it in from the send path (statically or by dynamic import) makes the FIRST
// sendMessage call freeze STATE_DIR for the whole process, which in the shared-
// process test runner happens before test/resume-prompt.test.ts sets
// TELEGRAM_STATE_DIR — measured here, it reds two of its arms. Production is
// unaffected (each hook is its own process), but a guard that reds an unrelated
// suite is a guard that gets weakened later to make the suite green again.
//
// The 2-line path duplication that buys is a drift seam, so it is pinned rather
// than trusted: test/dive3445-tag-provenance.test.ts asserts this resolves to
// exactly paths.ACCESS_FILE under the same environment.
function allowedChatIdsFresh(): string[] {
  const stateDir =
    process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
  try {
    const a = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) as AccessConfig
    return [...(a.allowFrom ?? []), ...(a.groups ? Object.keys(a.groups) : [])]
  } catch {
    return []
  }
}

// threadId is the forum-topic id (message_thread_id). Pass it for inbound
// from a supergroup topic so the message lands in that topic instead of the
// supergroup's General channel; omit for DMs, regular groups, and General.
export async function sendMessage(chatId: string, text: string, threadId?: string): Promise<void> {
  const token = getToken()
  if (!token || !chatId) return
  // DIVE-1674: never deliver a bare 'undefined'/empty payload to the user.
  // A caller passing undefined (or a template that stringified to the literal
  // string 'undefined') must be dropped at this choke point, not sent. Guard
  // defensively so the symptom dies regardless of which caller slipped up.
  if (text == null || text.trim() === '' || text.trim() === 'undefined') {
    process.stderr.write(
      `telegram sendMessage: refusing to send empty/undefined text to ${chatId}\n`,
    )
    return
  }
  // DIVE-3445, see isAllowedChat above. Loud on stderr rather than silent: a
  // refusal here means something picked a destination this agent is not paired
  // with, and that is worth a journal line even though the send is dropped.
  if (!isAllowedChat(chatId, allowedChatIdsFresh())) {
    process.stderr.write(
      `telegram sendMessage: refusing ${chatId} — not in access.json's allowlist (DIVE-3445)\n`,
    )
    return
  }
  const trimmed =
    text.length > TELEGRAM_TEXT_MAX
      ? text.slice(0, TELEGRAM_TEXT_MAX - 40) + '… [truncated; see journalctl on the host]'
      : text
  try {
    const params = new URLSearchParams({ chat_id: chatId, text: trimmed })
    if (threadId) params.set('message_thread_id', threadId)
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
  } catch {
    // Best-effort: hook timeouts are short; if the network is wedged the
    // worst case is a missed DM, not a crashed agent.
  }
}
