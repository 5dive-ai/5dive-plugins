// DIVE-6714: the dashboard-only half of the StopFailure hook. Everything about
// WHAT failed, the dedup and the resume comes from Telegram's own files (see
// ../SHARED.txt); this file only knows the web chat: which chat the person
// wrote in, whether it was answered, the words of the notice, and the drop
// file the dashboard server sends.

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { A2A_ENVELOPE_RE, entryTexts } from './transcript'
import { textLang } from './terms'
import type { Lang } from './lite'
import type { TranscriptEntry } from './types'

// The tag a web-chat message arrives in: pushed by the channel
// (source="plugin:dashboard:dashboard") or typed in when channels are off
// (DIVE-6000, the same tag). Trusted by the same rule as Telegram's
// (transcript.ts, DIVE-3445): inside an inter-agent envelope only a tag at
// offset 0 counts, so a quoted tag cannot pick where a notice goes.
const TAG_RE_G = /<channel source="(?:plugin:dashboard:dashboard|dashboard)"[^>]*>([\s\S]*?)<\/channel>/g
const ANCHORED_RE = /^\s*<channel source="(?:plugin:dashboard:dashboard|dashboard)"/
const REPLY_TOOL_RE = /^mcp__plugin_dashboard_dashboard__reply$/

export type DashboardInbound = { chatId: string; text: string; index: number }

/** The last web-chat message in the transcript, or null when there is none. */
export function lastDashboardInbound(entries: TranscriptEntry[]): DashboardInbound | null {
  let last: DashboardInbound | null = null
  entries.forEach((e, index) => {
    if (e.type !== 'user') return
    const texts = entryTexts(e.message?.content ?? '')
    const inEnvelope = texts.some(t => A2A_ENVELOPE_RE.test(t))
    for (const t of texts) {
      if (inEnvelope && !ANCHORED_RE.test(t)) continue
      for (const m of t.matchAll(TAG_RE_G)) {
        const chatId = /chat_id="([^"]+)"/.exec(m[0])?.[1] ?? 'dashboard'
        last = { chatId, text: m[1] ?? '', index }
      }
    }
  })
  return last
}

/** Did the agent call the dashboard reply tool after entry `index`? */
export function answeredAfter(entries: TranscriptEntry[], index: number): boolean {
  for (let i = index + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    for (const b of e.message.content as Array<{ type?: string; name?: string }>) {
      if (b?.type === 'tool_use' && typeof b.name === 'string' && REPLY_TOOL_RE.test(b.name)) return true
    }
  }
  return false
}

function inLang(lang: Lang, secs: number): string {
  let h = Math.floor(secs / 3600)
  let m = Math.round((secs % 3600) / 60)
  if (m === 60) { h += 1; m = 0 }
  if (h === 0) m = Math.max(1, m)
  const [hu, mu] = lang === 'ru' ? ['ч', 'мин'] : ['h', 'min']
  if (h === 0) return `${m} ${mu}`
  return m ? `${h} ${hu} ${m} ${mu}` : `${h} ${hu}`
}

export type NoticeKind = 'ratelimit' | 'transient'

/**
 * The one line the person sees. Plain words, no percentages, no raw error.
 * The reset is RELATIVE ("in about 2 h 10 min"): the box cannot know the
 * reader's time zone, and a clock time in the box's zone would be wrong for
 * most of them.
 */
export function noticeText(kind: NoticeKind, resetEpoch: number | null, nowSec: number, lang: Lang): string {
  if (kind === 'transient') {
    return lang === 'ru'
      ? 'Сервис ИИ сейчас перегружен, поэтому я остановился. Пробую снова и скоро отвечу.'
      : "The AI service is overloaded right now, so I stopped. I'm retrying and will answer shortly."
  }
  const left = resetEpoch !== null && resetEpoch > nowSec ? resetEpoch - nowSec : null
  if (lang === 'ru') {
    return left !== null
      ? `Я достиг лимита использования — вернусь примерно через ${inLang('ru', left)}. Тогда и отвечу на ваше сообщение.`
      : 'Я достиг лимита использования. Отвечу на ваше сообщение, как только лимит сбросится.'
  }
  return left !== null
    ? `I've hit my usage limit — back in about ${inLang('en', left)}. I'll pick your message up then.`
    : "I've hit my usage limit. I'll pick your message up as soon as it resets."
}

/** The language the person wrote their last web-chat message in. */
export function noticeLang(inbound: DashboardInbound | null): Lang {
  return (inbound && textLang(inbound.text)) || 'en'
}

export function dashboardStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DASHBOARD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'dashboard')
}

/** Drop the notice for the dashboard server to send (server.ts, notice outbox). */
export function writeNotice(chatId: string, text: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(dashboardStateDir(env), 'notice-outbox')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = `stopfailure-${Date.now()}-${process.pid}.json`
  const tmp = join(dir, `.${name}.tmp`)
  writeFileSync(tmp, JSON.stringify({ source: 'dashboard', chat_id: chatId, text }) + '\n', { mode: 0o600 })
  renameSync(tmp, join(dir, name))
  return join(dir, name)
}
