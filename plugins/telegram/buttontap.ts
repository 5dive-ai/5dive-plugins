// DIVE-5171: a tap on an auto-rendered Yes/No (DIVE-332) or choice-list
// (DIVE-708) button reaches the agent as a channel inbound. It used to arrive as
// a bare 'yes'/'no' (or the option label) carrying the BOT's keyboard message id,
// a plugin-clock timestamp, and no recent_messages entry — every tell an agent
// checks for a forged inbound, so agents discarded the owner's real answers.
// Pure helpers: the words the agent reads, the meta that marks the tap, and the
// log line, so the router in server.ts only wires them.

import type { LoggedMessage } from './msglog'

export interface ButtonTap {
  value: string // what the tap answers: 'yes' | 'no' | the full option label
  button: string // the label printed on the tapped button, e.g. '❌ No'
  answersMessageId?: number // the bot message the keyboard was on
  callbackQueryId: string // Telegram's own id for this tap
}

// `no (tapped the ❌ No button under your message 479)` — leads with the answer,
// so a reader looking for 'yes'/'no' still finds it first.
export function tapContent(t: ButtonTap): string {
  const under = t.answersMessageId != null ? ` under your message ${t.answersMessageId}` : ''
  return `${t.value} (tapped the ${t.button} button${under})`
}

export function tapMeta(t: ButtonTap): Record<string, string> {
  return {
    via: 'button',
    button: t.button,
    callback_query_id: t.callbackQueryId,
    ...(t.answersMessageId != null ? { answers_message_id: String(t.answersMessageId) } : {}),
  }
}

// The recent_messages entry, so "not in the log" stops reading as forgery.
export function tapLogEntry(t: ButtonTap, user: string, ts: string, threadId?: string): LoggedMessage {
  return {
    ts,
    dir: 'in',
    user,
    text: tapContent(t),
    via: 'button',
    ...(t.answersMessageId != null ? { answers_message_id: String(t.answersMessageId) } : {}),
    ...(threadId != null ? { thread_id: threadId } : {}),
  }
}
