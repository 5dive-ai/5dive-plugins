/**
 * DIVE-6678: Claude refuses every turn until the account accepts new terms.
 *
 * When an owner connects their own Claude login and that account has not
 * accepted Anthropic's updated consumer terms, every turn fails at once with
 *   API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll
 *   need to accept them in claude.ai with the email in /status to continue.
 * Measured on a partner box 2026-10-21 (DIVE-6677): six seats moved onto the
 * login in 24 s, and the owner's chat heard nothing while five messages failed.
 * Only the owner can fix it, in a minute, at claude.ai, so the agent says so.
 *
 * DETECT. Only the error of THIS failure counts: the hook payload's own error
 * fields, the last assistant message when it is the harness's `API Error:` line,
 * and the LAST `API Error:` line on the pane. Claude Code's own classifier keys
 * this failure on the same phrase ("updated our consumer terms" →
 * terms_not_accepted). An agent that only talks about the copy — a transcript
 * line, an earlier error further up the pane — does not match.
 *
 * ONCE. The caller claims a notify stamp of its own kind ('terms'), so the
 * failed turns of one episode share one notice.
 *
 * Pure: no grammy import, so the hooks can use it.
 */

import type { Lang } from './lite'
import { channelBody, entryTexts, trustedChannelTagsForEntry } from './transcript'
import type { TranscriptEntry } from './types'

export const TERMS_RE = /updated our consumer terms/i

type TermsPayload = {
  error?: unknown
  error_details?: unknown
  last_assistant_message?: unknown
  message?: unknown
  reason?: unknown
}

/** Does this failure say the account owes Claude's updated terms? */
export function isTermsWall(payload: TermsPayload, pane: string): boolean {
  const own = [payload.error, payload.error_details, payload.message, payload.reason]
  if (own.some(v => typeof v === 'string' && TERMS_RE.test(v))) return true
  const last = payload.last_assistant_message
  if (typeof last === 'string' && /^\s*API Error\b/i.test(last) && TERMS_RE.test(last)) return true
  const apiLine = pane
    .split('\n')
    .filter(l => /API Error:/i.test(l))
    .pop()
  return !!apiLine && TERMS_RE.test(apiLine)
}

export const TERMS_NOTICE: Record<Lang, string> = {
  en: 'Claude needs you to accept its updated terms: sign in at claude.ai with the account you connected and accept, then write again.',
  ru: 'Claude просит принять его обновлённые условия: войдите на claude.ai под аккаунтом, который вы подключили, примите их и напишите снова.',
}

/** Russian when the letters are mostly Cyrillic, English when mostly Latin,
 *  null when there are no letters to go by. */
export function textLang(text: string): Lang | null {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length
  const lat = (text.match(/[A-Za-z]/g) ?? []).length
  if (cyr === 0 && lat === 0) return null
  return cyr >= lat ? 'ru' : 'en'
}

/** The language the owner last wrote in on Telegram, from the transcript, or
 *  null when no inbound says. */
export function inboundLang(entries: TranscriptEntry[]): Lang | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'user') continue
    const content = e.message?.content ?? ''
    const tags = trustedChannelTagsForEntry(content)
    for (let j = tags.length - 1; j >= 0; j--) {
      const body = channelBody(entryTexts(content), tags[j]!)
      const lang = body ? textLang(body) : null
      if (lang) return lang
    }
  }
  return null
}
