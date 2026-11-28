// DIVE-6714: the dashboard-only half of the StopFailure hook. Everything about
// WHAT failed, the dedup and the resume comes from Telegram's own files (see
// ../SHARED.txt); this file only knows the web chat: which chat the person
// wrote in, whether it was answered, the words of the notice, and the drop
// file the dashboard server sends. DIVE-6715 adds what the Stop, question and
// status hooks need from the web chat on top of that.

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { A2A_ENVELOPE_RE, entryTexts, refusedTooLongIds } from './transcript'
import { textLang } from './terms'
import { CREDIT_NOTICE, MODEL_NOTICE } from './failure'
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

export type NoticeKind = 'ratelimit' | 'transient' | 'credit' | 'model'

/**
 * The one line the person sees. Plain words, no percentages, no raw error.
 * The reset is RELATIVE ("in about 2 h 10 min"): the box cannot know the
 * reader's time zone, and a clock time in the box's zone would be wrong for
 * most of them.
 */
export function noticeText(kind: NoticeKind, resetEpoch: number | null, nowSec: number, lang: Lang, lite = false): string {
  // DIVE-6979: no reset to name; who tops it up depends on who reads (failure.ts).
  if (kind === 'credit') return CREDIT_NOTICE[lite ? 'client' : 'owner'][lang]
  // DIVE-8610: no reset either; only someone who runs the AI server can fix it.
  if (kind === 'model') return MODEL_NOTICE[lang]
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

// --- DIVE-9477: «Switch to <account>» on the usage-limit notice ----------------
// The hook (stopfailure-notify.ts) sends the notice with two buttons when another account of this AI has room
// (limit-switch.ts picks it): «Switch to <account>» and «Wait for reset». The app's buttons are a question of
// 2 to 10 options, so the one action goes with the notice's own promise. It records the offer here; the
// server's next message from that chat that is one of those buttons (a tap sends the label, an older relay's
// numbered text is answered with "1" or "2") is the answer, and is NOT typed into the session, which is at its
// limit. Anything else the person writes goes on as before. An offer lives until the limit lifts, 6 h at most.

export type LimitOffer = {
  id: string
  chatId: string
  account: string
  lang: Lang
  labels: [string, string]
  expiresAt: number
}

export const LIMIT_OFFER_MAX_MS = 6 * 3600_000

export function limitOfferDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dashboardStateDir(env), 'limit-switch')
}

/** The offer's expiry: the reset when it is known and sooner than 6 h, else 6 h. */
export function limitOfferExpiry(resetEpoch: number | null, nowMs: number): number {
  const cap = nowMs + LIMIT_OFFER_MAX_MS
  return resetEpoch !== null && resetEpoch * 1000 > nowMs ? Math.min(resetEpoch * 1000, cap) : cap
}

export function writeLimitOffer(o: LimitOffer, env: NodeJS.ProcessEnv = process.env): string {
  const dir = limitOfferDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dest = join(dir, `${o.id}.json`)
  writeFileSync(`${dest}.tmp`, JSON.stringify(o), { mode: 0o600 })
  renameSync(`${dest}.tmp`, dest)
  return dest
}

/**
 * The answer to this chat's newest live offer, or null when `text` is not one of its buttons (or no offer is
 * live). A button answer removes every offer for that chat, so a second tap does nothing; expired offers are
 * removed as they are read.
 */
export function takeLimitOffer(
  chatId: string,
  text: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): { action: 'switch' | 'wait'; offer: LimitOffer } | null {
  const dir = limitOfferDir(env)
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return null }
  const mine: Array<{ path: string; o: LimitOffer }> = []
  for (const n of names) {
    const path = join(dir, n)
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as LimitOffer
      if (!(o.expiresAt > nowMs)) { try { unlinkSync(path) } catch {} ; continue }
      if (o.chatId === chatId && Array.isArray(o.labels) && o.labels.length === 2) mine.push({ path, o })
    } catch {}
  }
  if (!mine.length) return null
  const newest = mine.reduce((a, b) => (b.o.expiresAt > a.o.expiresAt ? b : a))
  const { idx } = resolveAnswer({ labels: newest.o.labels, answers: [] }, text)
  if (idx < 0) return null
  for (const m of mine) { try { unlinkSync(m.path) } catch {} }
  return { action: idx === 0 ? 'switch' : 'wait', offer: newest.o }
}

export type SwitchExec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>

/** Under set-account's own budget on Telegram (seatpriv.ts ACCOUNT_SWITCH_TIMEOUT_MS): never killed mid-write. */
export const LIMIT_SWITCH_TIMEOUT_MS = 60_000

/**
 * The existing switch, once: `5dive agent set-account <agent> <account>`, as root first (an admin seat) and then
 * as the seat itself (a standard seat holding its own `_self_account` line, DIVE-5367). A failed call is checked
 * against `agent rotation get` before it counts as failed (DIVE-6867: a switch that landed is never reported as
 * failed, and never run twice).
 */
export async function runLimitSwitch(agent: string, account: string, exec: SwitchExec): Promise<{ ok: boolean; detail: string }> {
  const NAME = /^[a-z][a-z0-9_-]{0,31}$/
  if (!NAME.test(agent) || !NAME.test(account)) return { ok: false, detail: 'invalid name' }
  const moved = async (): Promise<boolean> => {
    for (const cmd of [['5dive'], ['sudo', '-n', '5dive']]) {
      const r = await exec(cmd[0]!, [...cmd.slice(1), '--json', 'agent', 'rotation', 'get', agent], 5_000).catch(() => null)
      try {
        const j = JSON.parse(r?.stdout ?? '')
        if (j?.ok === true) return j.data?.active === account
      } catch {}
    }
    return false
  }
  let detail = ''
  for (const cmd of [['sudo', '-n', '5dive'], ['5dive']]) {
    const r = await exec(cmd[0]!, [...cmd.slice(1), 'agent', 'set-account', agent, account], LIMIT_SWITCH_TIMEOUT_MS)
      .catch(err => ({ ok: false, stdout: '', stderr: String(err) }))
    if (r.ok) return { ok: true, detail: '' }
    if (await moved()) return { ok: true, detail: '' }
    detail = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? ''
  }
  return { ok: false, detail }
}

/** What the chat is told around a tapped switch. The agent restarts on success, so "done" may not get out. */
export function limitSwitchText(step: 'pending' | 'done' | 'failed' | 'wait', account: string, lang: Lang, detail = ''): string {
  if (lang === 'ru') {
    if (step === 'pending') return `Перехожу на ${account}…`
    if (step === 'done') return `Перешёл на ${account}. Вернусь примерно через 30 секунд и отвечу на ваше сообщение.`
    if (step === 'wait') return 'Хорошо, жду сброса лимита.'
    return `Не получилось перейти на ${account}${detail ? `: ${detail}` : ''}. Остаюсь на текущем аккаунте и отвечу, когда лимит сбросится.`
  }
  if (step === 'pending') return `Switching to ${account}…`
  if (step === 'done') return `Switched to ${account}. Back in about 30 seconds, then I'll answer your message.`
  if (step === 'wait') return "OK, I'll wait for the reset."
  return `Couldn't switch to ${account}${detail ? `: ${detail}` : ''}. I'm still on my current account and will answer when the limit resets.`
}
