// DIVE-6714: the dashboard-only half of the StopFailure hook. Everything about
// WHAT failed, the dedup and the resume comes from Telegram's own files (see
// ../SHARED.txt); this file only knows the web chat: which chat the person
// wrote in, whether it was answered, the words of the notice, and the drop
// file the dashboard server sends. DIVE-6715 adds what the Stop, question and
// status hooks need from the web chat on top of that.

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { A2A_ENVELOPE_RE, entryTexts, refusedTooLongIds } from './transcript'
import { textLang } from './terms'
import { CREDIT_NOTICE } from './failure'
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
// DIVE-6862: a reply refused for length sent nothing, so neither of these
// counts it: the Stop hook then relays the turn's text or blocks once.
export function answeredAfter(entries: TranscriptEntry[], index: number): boolean {
  const refused = refusedTooLongIds(entries.slice(index + 1))
  for (let i = index + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    for (const b of e.message.content as Array<{ type?: string; name?: string; id?: string }>) {
      if (b?.type === 'tool_use' && typeof b.name === 'string' && REPLY_TOOL_RE.test(b.name) && !(b.id && refused.has(b.id))) return true
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

export type NoticeKind = 'ratelimit' | 'transient' | 'credit'

/**
 * The one line the person sees. Plain words, no percentages, no raw error.
 * The reset is RELATIVE ("in about 2 h 10 min"): the box cannot know the
 * reader's time zone, and a clock time in the box's zone would be wrong for
 * most of them.
 */
export function noticeText(kind: NoticeKind, resetEpoch: number | null, nowSec: number, lang: Lang, lite = false): string {
  // DIVE-6979: no reset to name; who tops it up depends on who reads (failure.ts).
  if (kind === 'credit') return CREDIT_NOTICE[lite ? 'client' : 'owner'][lang]
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
  return writeOutbox('stopfailure', { chat_id: chatId, text }, env)
}

/**
 * DIVE-6715: any hook's message into the web chat goes the notice's way: a drop
 * file the dashboard server sends with its own credential. `question` rides
 * along for the buttons (server.ts puts it in the reply's metadata).
 */
export function writeOutbox(
  kind: string,
  msg: { chat_id: string; text: string; question?: ChatQuestion },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = join(dashboardStateDir(env), 'notice-outbox')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = `${kind}-${Date.now()}-${process.pid}.json`
  const tmp = join(dir, `.${name}.tmp`)
  writeFileSync(tmp, JSON.stringify({ source: 'dashboard', ...msg }) + '\n', { mode: 0o600 })
  renameSync(tmp, join(dir, name))
  return join(dir, name)
}

// --- DIVE-6715: parity with Telegram ------------------------------------------

/** Where the current turn starts: the newest user entry whose content is a
 *  string (a channel message, a typed prompt or an a2a envelope). Telegram's
 *  analyzeTurn uses the same boundary. */
export function turnStart(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'user' && typeof e.message?.content === 'string') return i
  }
  return 0
}

/** The web-chat message this turn is answering: the newest one at or after the
 *  turn's start, or null when the turn has none. */
export function turnDashboardInbound(entries: TranscriptEntry[]): DashboardInbound | null {
  const last = lastDashboardInbound(entries)
  return last && last.index >= turnStart(entries) ? last : null
}

/** What the agent wrote into its own session after entry `index`, one string
 *  per assistant message. Claude's synthetic error lines are not the agent's words. */
export function assistantTextsAfter(entries: TranscriptEntry[], index: number): string[] {
  const out: string[] = []
  for (let i = index + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant' || e.isApiErrorMessage || !Array.isArray(e.message?.content)) continue
    const joined = (e.message.content as Array<{ type?: string; text?: unknown }>)
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
      .trim()
    if (joined) out.push(joined)
  }
  return out
}

/** Did the agent call any tool at all after entry `index`? */
export function usedToolAfter(entries: TranscriptEntry[], index: number): boolean {
  const refused = refusedTooLongIds(entries.slice(index + 1))
  for (let i = index + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    if ((e.message.content as Array<{ type?: string; id?: string }>).some(b => b?.type === 'tool_use' && !(b.id && refused.has(b.id)))) return true
  }
  return false
}

export type ChatQuestion = { id: string; options: Array<{ label: string; description?: string }> }

/** A question waiting for its answer in the web chat (questions/<id>.req.json). */
export type PendingQuestion = {
  id: string
  chatId: string
  // What the model is told for each button, in button order (question-bridge.ts).
  answers: string[]
  labels: string[]
  createdAt: number
}

export function questionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dashboardStateDir(env), 'questions')
}

/**
 * The answer the model gets for what the person sent while a question waited.
 * A tap sends the button's label verbatim, so an exact label (or its number, for
 * someone who typed "2") is that option; anything else is their own words, which
 * is still an answer: they chose not to pick.
 */
export function resolveAnswer(q: Pick<PendingQuestion, 'answers' | 'labels'>, text: string): { idx: number; answer: string } {
  const t = text.trim()
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  let idx = q.labels.findIndex(l => norm(l) === norm(t))
  if (idx < 0 && /^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= q.labels.length) idx = Number(t) - 1
  if (idx >= 0) return { idx, answer: q.answers[idx] ?? `The user selected: "${q.labels[idx]}"` }
  return { idx: -1, answer: `The user did not pick an option and wrote instead: "${t}"` }
}

/** Status files the dashboard server forwards to the web chat as "working: <step>". */
export function statusLabelPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dashboardStateDir(env), 'status-label.json')
}
export function turnEndedPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dashboardStateDir(env), 'turn-ended')
}

/** Tell the server the turn is over, so the chat stops showing "working". */
export function signalTurnEnded(env: NodeJS.ProcessEnv = process.env): void {
  try {
    mkdirSync(dashboardStateDir(env), { recursive: true, mode: 0o700 })
    writeFileSync(turnEndedPath(env), String(Date.now()), { mode: 0o600 })
  } catch {
    // cosmetic: the server's ceiling clears the label anyway
  }
}
