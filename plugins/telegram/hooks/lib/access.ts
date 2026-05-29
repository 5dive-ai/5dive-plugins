import { readFileSync } from 'fs'
import { ACCESS_FILE } from './paths'
import type { AccessConfig, TranscriptEntry } from './types'

export function loadAccess(): AccessConfig {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as AccessConfig
  } catch {
    return {}
  }
}

export function getAllowedChatIds(access?: AccessConfig): string[] {
  const a = access ?? loadAccess()
  const allow = a.allowFrom ?? []
  const groups = a.groups ? Object.keys(a.groups) : []
  return [...allow, ...groups]
}

// A chat to notify, plus the optional forum-topic it should land in.
export type CallerChat = { chatId: string; threadId?: string }

// Caller-only narrowing. When an agent is paired with multiple chats
// (DM + group), the "ping everyone in access.json" approach makes an
// unrelated group buzz every time a single user's session hits a failure.
// Scan the transcript for the most-recent telegram <channel> inbound and
// return just that chat — with its topic — so the caller can scope
// notifications back into the same thread the user wrote from.
//
// Matches the upstream system-reminder format the telegram plugin injects
// on inbound:
//   <channel source="plugin:telegram:telegram" chat_id="-100…" message_id="…"
//            message_thread_id="42" …>
// chat_id is negative for groups/supergroups, so we capture -?\d+ (the old
// \d+ silently dropped the leading '-' and never matched a group at all,
// which is why group alerts used to fan out to General instead of the topic).
// message_thread_id is present only for posts inside a non-General forum
// topic; we pull it from WITHIN the same matched tag so a topic id is never
// stitched onto a different inbound's chat id.
// Returns null when there's no inbound (autonomous turn, cron-triggered, etc).
export function getCallerChat(entries: TranscriptEntry[]): CallerChat | null {
  const tagRe = /source="plugin:telegram:telegram"[^>]*/g
  let last: CallerChat | null = null
  for (const e of entries) {
    if (e.type !== 'user') continue
    const content =
      typeof e.message?.content === 'string'
        ? e.message.content
        : JSON.stringify(e.message?.content ?? '')
    tagRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(content)) !== null) {
      const tag = m[0]
      const chatId = /chat_id="(-?\d+)"/.exec(tag)?.[1]
      if (!chatId) continue
      const threadId = /message_thread_id="(-?\d+)"/.exec(tag)?.[1]
      last = threadId ? { chatId, threadId } : { chatId }
    }
  }
  return last
}
