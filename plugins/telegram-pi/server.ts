#!/usr/bin/env bun
/**
 * Telegram bridge for the pi CLI (earendil-works / pi-coding-agent) — DIVE-1202.
 *
 * pi has NO MCP/hooks config surface (DIVE-1198 spike): it is EXTENSION-based
 * and ships a first-class in-process SDK. So this is a long-running RELAY that
 * HOSTS pi directly via `createAgentSession()` — a FOURTH run-model, distinct
 * from claude (`--channels` flag), codex/grok/agy (MCP wired into config), and
 * opencode (HTTP relay over `opencode serve`):
 *
 *   Telegram inbound ──▶ session.prompt(text) ──▶ text_delta stream ──▶ Telegram
 *                        pi `tool_call` extension hook (bash/write/edit)
 *                                             ──▶ 🔐 once/always/reject buttons
 *                                             ──▶ { block:true } on reject
 *
 * SANDBOXED-BY-DEFAULT (DIVE-1198): pi ships no built-in permission system, so
 * this bridge gates every MUTATING tool (bash/write/edit) behind a Telegram
 * approval tap. Read-only tools (read/ls/grep/find) pass silently. The gate is
 * the pi extension API's `tool_call` event, which can block execution — the
 * reason TelePi's TUI-dialog adapter is unnecessary here.
 *
 * Auth: pi's default AuthStorage falls back to the env `*_API_KEY` (DIVE-1200),
 * injected by systemd, so no key wiring is needed here. Model: read from
 * ~/.pi/agent/settings.json defaultProvider/defaultModel (DIVE-1205).
 *
 * State: ~/.pi/channels/telegram/{access.json, .env, bot.pid}
 * Transport + access + command surface reused verbatim from the telegram-opencode
 * fork (access control, pairing, chunking, streaming edit-in-place, permission
 * buttons, and the /status /stop /restart /agents /tasks /task /org /model handlers).
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { OPT_RE, optionChoices, parseOptions } from './tna'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, statSync,
  realpathSync, renameSync, existsSync, unlinkSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join, sep } from 'path'

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version ?? 'unknown')
  } catch { return 'unknown' }
})()

// ~/.pi/agent (settings.json, sessions/, auth.json) — pi's config home.
const AGENT_DIR = process.env.PI_AGENT_DIR ?? getAgentDir()
const SETTINGS_FILE = join(AGENT_DIR, 'settings.json')
// Where the agent's tools operate (bash cwd etc.). Exported by 5dive-agent-start.
const PI_PROJECT_DIR = process.env.PI_PROJECT_DIR ?? process.cwd()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.PI_HOME ?? join(homedir(), '.pi'), 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// Lock the token to owner-only, then load it. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `telegram-pi: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// Telegram allows exactly one getUpdates consumer per token. Replace any
// stale poller left over from a crashed prior run.
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    process.stderr.write(`telegram-pi: replacing stale poller pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-pi: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-pi: uncaught exception: ${err}\n`)
})

// ============================================================================
// Access control  (verbatim from the opencode/grok forks — access/pairing parity)
// ============================================================================

type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
type PendingEntry = {
  senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number
}
type AccessJson = {
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  ackReaction?: string
  textChunkLimit?: number
  dmPolicy?: 'allowlist' | 'static' | 'pairing'
  pending?: Record<string, PendingEntry>
}

const DEFAULT_ACCESS: AccessJson = { allowFrom: [], groups: {}, pending: {} }

function loadAccess(): AccessJson {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<AccessJson>
    return {
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      ackReaction: typeof parsed.ackReaction === 'string' ? parsed.ackReaction : undefined,
      textChunkLimit: typeof parsed.textChunkLimit === 'number'
        ? Math.max(500, Math.min(4096, parsed.textChunkLimit)) : undefined,
      dmPolicy: parsed.dmPolicy === 'static' ? 'static'
        : parsed.dmPolicy === 'pairing' ? 'pairing' : 'allowlist',
      pending: parsed.pending ?? {},
    }
  } catch {
    return { ...DEFAULT_ACCESS, pending: {} }
  }
}

function saveAccess(a: AccessJson): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = ACCESS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, ACCESS_FILE)
  } catch (err) {
    process.stderr.write(`telegram-pi: saveAccess failed: ${err}\n`)
  }
}

function pruneExpired(a: AccessJson): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending ?? {})) {
    if (p.expiresAt < now) { delete a.pending![code]; changed = true }
  }
  return changed
}

function assertInStateDir(path: string) {
  let real: string, stateReal: string
  try { real = realpathSync(path); stateReal = realpathSync(STATE_DIR) } catch { return }
  if (real !== stateReal && !real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send file outside state dir: ${path}`)
  }
}

type GateResult =
  | { allowed: true; access: AccessJson }
  | { allowed: false }
  | { allowed: false; pair: { code: string; chatId: string; isResend: boolean } }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const chat = ctx.chat, from = ctx.from
  if (!chat || !from) return { allowed: false }
  const chatId = String(chat.id), senderId = String(from.id)

  if (chat.type === 'private') {
    if (access.allowFrom.includes(senderId)) return { allowed: true, access }
    if (access.dmPolicy === 'pairing') {
      if (pruneExpired(access)) saveAccess(access)
      for (const [code, p] of Object.entries(access.pending ?? {})) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { allowed: false }
          p.replies = (p.replies ?? 1) + 1
          saveAccess(access)
          return { allowed: false, pair: { code, chatId, isResend: true } }
        }
      }
      if (Object.keys(access.pending ?? {}).length >= 3) return { allowed: false }
      const code = randomBytes(3).toString('hex')
      const now = Date.now()
      access.pending = access.pending ?? {}
      access.pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 3600_000, replies: 1 }
      saveAccess(access)
      return { allowed: false, pair: { code, chatId, isResend: false } }
    }
    return { allowed: false }
  }

  const policy = access.groups[chatId]
  if (!policy) return { allowed: false }
  const senderOk = policy.allowFrom.length === 0
    ? access.allowFrom.includes(senderId) : policy.allowFrom.includes(senderId)
  if (!senderOk) return { allowed: false }
  if (policy.requireMention && !isMentioned(ctx)) return { allowed: false }
  return { allowed: true, access }
}

function isMentioned(ctx: Context): boolean {
  const msg = ctx.message
  if (!msg) return false
  const text = msg.text ?? msg.caption ?? ''
  if (!botUsername) return false
  if (text.includes(`@${botUsername}`)) return true
  const reply = msg.reply_to_message
  if (reply && reply.from?.id === ctx.me?.id) return true
  return false
}

function assertAllowedChat(chatId: string) {
  const access = loadAccess()
  if (access.allowFrom.includes(chatId)) return
  if (access.groups[chatId]) return
  throw new Error(`chat_id ${chatId} is not on the allowlist`)
}

// ============================================================================
// pi engine — in-process AgentSession per chat + sandboxed-by-default gate
// ============================================================================

// One pi model = ~/.pi/agent/settings.json {defaultProvider, defaultModel}.
// Read for /status and /model; written by /model (and by DIVE-1205 at create).
function currentModel(): { providerID: string; modelID: string } | null {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as any
    if (s?.defaultProvider && s?.defaultModel) return { providerID: String(s.defaultProvider), modelID: String(s.defaultModel) }
  } catch {}
  return null
}
function setModel(provider: string, model: string): void {
  let s: any = {}
  try { s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch {}
  s.defaultProvider = provider
  s.defaultModel = model
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + '\n')
}

// Which tools mutate the box and therefore require a human tap. Everything else
// (read/ls/grep/find and read-only custom tools) runs silently. pi has no
// permission system of its own, so this list IS the sandbox boundary.
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit'])

function describeTool(name: string, input: any): string {
  try {
    if (name === 'bash' && typeof input?.command === 'string') return input.command
    if ((name === 'write' || name === 'edit') && typeof input?.path === 'string') return `${name} ${input.path}`
    return JSON.stringify(input ?? {}).slice(0, 300)
  } catch { return name }
}

type PermVerdict = 'once' | 'always' | 'reject'
const pendingToolPerms = new Map<string, { resolve: (v: PermVerdict) => void; chat_id: string; message_id?: number }>()
let permSeq = 0
const PERM_TIMEOUT_MS = 10 * 60 * 1000

// Post 🔐 once/always/reject buttons and resolve when the user taps (or after a
// timeout → reject, so a never-answered gate can't hang the turn forever). Fails
// CLOSED (reject) if the prompt can't even be sent — sandboxed-by-default.
function requestToolApproval(chat_id: string, toolName: string, detail: string): Promise<PermVerdict> {
  const id = String(++permSeq)
  const body = `🔐 pi wants to run *${toolName}*:\n\`${detail.slice(0, 350)}\``
  const kb = new InlineKeyboard()
    .text('✅ once', `piperm:once:${id}`).text('✅ always', `piperm:always:${id}`).text('❌ reject', `piperm:reject:${id}`)
  return new Promise<PermVerdict>(resolve => {
    let settled = false
    const done = (v: PermVerdict) => { if (!settled) { settled = true; pendingToolPerms.delete(id); resolve(v) } }
    bot.api.sendMessage(chat_id, body, { parse_mode: 'Markdown', reply_markup: kb })
      .then(sent => {
        if (settled) return
        pendingToolPerms.set(id, { resolve: done, chat_id, message_id: sent.message_id })
        setTimeout(() => {
          if (!settled) {
            bot.api.sendMessage(chat_id, `⏱️ approval for *${toolName}* timed out — blocked.`, { parse_mode: 'Markdown' }).catch(() => {})
            done('reject')
          }
        }, PERM_TIMEOUT_MS)
      })
      .catch(err => {
        process.stderr.write(`telegram-pi: permission prompt failed (blocking): ${err}\n`)
        done('reject')
      })
  })
}

// The inline extension injected into every per-chat pi session. Its `tool_call`
// hook runs before each tool executes and can block it (pi extension API). We
// close over chat_id + a per-session "always" allowlist so approvals are scoped
// to the conversation they were granted in.
function buildPermExtension(chat_id: string, allowedTools: Set<string>) {
  return (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event: any) => {
      const name = String(event?.toolName ?? '')
      if (!MUTATING_TOOLS.has(name)) return undefined      // read-only → silent pass
      if (allowedTools.has(name)) return undefined          // "always" this session
      const verdict = await requestToolApproval(chat_id, name, describeTool(name, event?.input))
      if (verdict === 'reject') return { block: true, reason: 'Rejected by user via Telegram' }
      if (verdict === 'always') allowedTools.add(name)
      return undefined
    })
  }
}

type ChatEngine = { session: AgentSession; allowedTools: Set<string>; unsub: () => void }
const engines = new Map<string, ChatEngine>()

async function engineForChat(chat_id: string): Promise<ChatEngine> {
  const existing = engines.get(chat_id)
  if (existing) return existing
  const allowedTools = new Set<string>()
  const resourceLoader = new DefaultResourceLoader({
    cwd: PI_PROJECT_DIR,
    agentDir: AGENT_DIR,
    extensionFactories: [buildPermExtension(chat_id, allowedTools)],
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: PI_PROJECT_DIR,
    resourceLoader,
    sessionManager: SessionManager.create(PI_PROJECT_DIR),
  })
  const unsub = session.subscribe((ev: any) => handleSessionEvent(chat_id, ev))
  const engine: ChatEngine = { session, allowedTools, unsub }
  engines.set(chat_id, engine)
  return engine
}

async function disposeEngine(chat_id: string): Promise<void> {
  const e = engines.get(chat_id)
  if (!e) return
  engines.delete(chat_id)
  try { e.unsub?.() } catch {}
  try { await e.session.abort?.() } catch {}
  try { e.session.dispose?.() } catch {}
}

// Extract the last assistant message's text — a fallback for finalize when the
// streamed text_delta accumulation came up empty.
function lastAssistantText(session: AgentSession): string {
  try {
    const msgs: any[] = (session as any).messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role !== 'assistant') continue
      const c = m.content
      if (typeof c === 'string') return c.trim()
      if (Array.isArray(c)) {
        return c.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('').trim()
      }
      return ''
    }
  } catch {}
  return ''
}

// pi AgentSession event → live Telegram stream. Only text_delta feeds the reply
// (thinking_delta / tool events are excluded, matching the CLI's own rendering).
function handleSessionEvent(chat_id: string, event: any): void {
  if (event?.type !== 'message_update') return
  const ame = event.assistantMessageEvent
  if (ame?.type !== 'text_delta' || typeof ame.delta !== 'string') return
  const s = streams.get(chat_id)
  if (!s) return
  s.text += ame.delta
  scheduleFlush(s)
}

// ============================================================================
// Bot
// ============================================================================

const bot = new Bot(TOKEN)
let botUsername = ''
let shuttingDown = false

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

const TYPING_INTERVAL_MS = 4_000
const TYPING_CEILING_MS = 5 * 60 * 1000
const typingLoops = new Map<string, ReturnType<typeof setInterval>>()
const typingCeilings = new Map<string, ReturnType<typeof setTimeout>>()
function startTypingLoop(chat_id: string) {
  stopTypingLoop(chat_id)
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  typingLoops.set(chat_id, setInterval(() => {
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  }, TYPING_INTERVAL_MS))
  typingCeilings.set(chat_id, setTimeout(() => stopTypingLoop(chat_id), TYPING_CEILING_MS))
}
function stopTypingLoop(chat_id: string) {
  const h = typingLoops.get(chat_id); if (h) { clearInterval(h); typingLoops.delete(chat_id) }
  const c = typingCeilings.get(chat_id); if (c) { clearTimeout(c); typingCeilings.delete(chat_id) }
}

const TG_MAX_MESSAGE_CHARS = 4000
function chunkForTelegram(text: string, limit = TG_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let split = rest.lastIndexOf('\n\n', limit)
    if (split < limit / 2) split = rest.lastIndexOf('\n', limit)
    if (split < limit / 2) split = rest.lastIndexOf(' ', limit)
    if (split < limit / 2) split = limit
    out.push(rest.slice(0, split))
    rest = rest.slice(split).replace(/^\s+/, '')
  }
  if (rest.length > 0) out.push(rest)
  return out
}

// DIVE-341: auto-render a Yes/No inline keyboard when an assistant reply ends in
// a single yes/no question. Conservative — only when there's exactly one '?' and
// the trailing question isn't an "A or B?" choice. Opt-out: a trailing
// `<!-- no-buttons -->` (or `<!-- no-yn -->`), stripped either way.
const YN_SUPPRESS = /\s*<!--\s*no-?(?:yn|buttons)\s*-->\s*$/i
function yesNoButtons(text: string): { stripped: string; keyboard?: InlineKeyboard } {
  if (YN_SUPPRESS.test(text)) return { stripped: text.replace(YN_SUPPRESS, '') }
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith('?')) return { stripped: text }
  if ((trimmed.match(/\?/g) ?? []).length !== 1) return { stripped: text }
  const lastQ = trimmed.split(/[\n.!?]/).filter(s => s.trim()).pop() ?? ''
  if (/\bor\b/i.test(lastQ)) return { stripped: text }
  return {
    stripped: text,
    keyboard: new InlineKeyboard().text('✅ Yes', 'yn:yes').text('❌ No', 'yn:no'),
  }
}

// DIVE-708/717: render one tappable button per option when a reply presents a
// lettered/numbered choice list. Detection is optionChoices() in tna.ts; here we
// build the keyboard. callback_data is `opt:<index>`; the label is re-resolved
// from the tapped message at tap time. Shares the YN opt-out marker.
const OPT_BTN_MAX = 56
function optionButtons(text: string): { keyboard?: InlineKeyboard; labels?: string[] } {
  if (YN_SUPPRESS.test(text)) return {}
  const opts = optionChoices(text)
  if (!opts.length) return {}
  const kb = new InlineKeyboard()
  opts.forEach((o, i) => {
    const label = o.label.length > OPT_BTN_MAX ? o.label.slice(0, OPT_BTN_MAX - 1).trimEnd() + '…' : o.label
    kb.text(`${o.marker.toUpperCase()}) ${label}`, `opt:${i}`).row()
  })
  return { keyboard: kb, labels: opts.map(o => o.label) }
}

const OPTION_CAP = 200
const optionLabelsByMsg = new Map<number, string[]>()
function rememberOptions(message_id: number, labels: string[]): void {
  if (optionLabelsByMsg.has(message_id)) return
  if (optionLabelsByMsg.size >= OPTION_CAP) {
    const oldest = optionLabelsByMsg.keys().next().value
    if (oldest != null) optionLabelsByMsg.delete(oldest)
  }
  optionLabelsByMsg.set(message_id, labels)
}

async function sendReply(chat_id: string, text: string, opts?: { reply_to?: number; thread?: number }): Promise<void> {
  const limit = loadAccess().textChunkLimit ?? TG_MAX_MESSAGE_CHARS
  const chunks = chunkForTelegram(text || '(empty reply)', limit)
  for (let i = 0; i < chunks.length; i++) {
    await bot.api.sendMessage(chat_id, chunks[i]!, {
      ...(i === 0 && opts?.reply_to != null ? { reply_parameters: { message_id: opts.reply_to } } : {}),
      ...(opts?.thread != null ? { message_thread_id: opts.thread } : {}),
    }).catch((err: any) => process.stderr.write(`telegram-pi: sendReply failed: ${err?.message}\n`))
  }
}

let lastInboundTs: string | null = null

// ============================================================================
// Progressive streaming relay
// ============================================================================
//
// pi streams tokens as `message_update` events whose assistantMessageEvent is a
// `text_delta` (handleSessionEvent appends the delta into s.text). We edit a
// Telegram message in place as it grows, so the user watches the reply form.
// The authoritative final text is set from session.prompt()'s resolution in
// runPrompt via finalizeStream. Streams are keyed by chat_id (one pi session
// per chat).

const EDIT_THROTTLE_MS = 1100

type StreamState = {
  chat_id: string
  reply_to?: number
  thread?: number
  text: string                     // accumulated assistant text
  msgIds: number[]                 // telegram message id per chunk
  sentChunks: string[]             // last text set on each chunk's message
  lastEditAt: number
  timer: ReturnType<typeof setTimeout> | null
  started: boolean
  finalized: boolean
  finalText: string | null
  flushing: boolean
  dirty: boolean
}

const streams = new Map<string, StreamState>()   // chat_id -> stream

function newStream(chat_id: string, reply_to?: number, thread?: number): StreamState {
  const s: StreamState = {
    chat_id, reply_to, thread, text: '',
    msgIds: [], sentChunks: [],
    lastEditAt: 0, timer: null, started: false, finalized: false,
    finalText: null, flushing: false, dirty: false,
  }
  streams.set(chat_id, s)
  return s
}

function targetText(s: StreamState): string {
  return s.finalText ?? s.text.trim()
}

function scheduleFlush(s: StreamState): void {
  if (s.timer || s.finalized) return
  const wait = Math.max(0, EDIT_THROTTLE_MS - (Date.now() - s.lastEditAt))
  s.timer = setTimeout(() => { s.timer = null; void flushStream(s) }, wait)
}

// Render the current target text into one-or-more Telegram messages, editing in
// place. chunkForTelegram splits greedily from the front, so as text grows by
// appending only the tail chunk changes; sentChunks[] dedup skips no-op edits.
async function flushStream(s: StreamState): Promise<void> {
  if (s.flushing) { s.dirty = true; return }
  s.flushing = true
  try {
    const full = targetText(s)
    if (!full && !s.started) return
    const limit = loadAccess().textChunkLimit ?? TG_MAX_MESSAGE_CHARS
    const chunks = chunkForTelegram(full || '…', limit)
    s.lastEditAt = Date.now()
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      if (i < s.msgIds.length) {
        if (s.sentChunks[i] === chunk) continue
        try {
          await bot.api.editMessageText(s.chat_id, s.msgIds[i]!, chunk)
        } catch (err: any) {
          const d = String(err?.description ?? err?.message ?? err)
          if (!/not modified/i.test(d)) process.stderr.write(`telegram-pi: stream edit failed: ${d}\n`)
        }
        s.sentChunks[i] = chunk
      } else {
        try {
          const sent = await bot.api.sendMessage(s.chat_id, chunk, {
            ...(i === 0 && s.reply_to != null ? { reply_parameters: { message_id: s.reply_to } } : {}),
            ...(s.thread != null ? { message_thread_id: s.thread } : {}),
          })
          s.msgIds[i] = sent.message_id
          s.sentChunks[i] = chunk
          if (!s.started) { s.started = true; stopTypingLoop(s.chat_id) }
        } catch (err) {
          process.stderr.write(`telegram-pi: stream send failed: ${err}\n`)
        }
      }
    }
  } finally {
    s.flushing = false
    if (s.dirty) { s.dirty = false; void flushStream(s) }
  }
}

// Lock in the authoritative text and flush one last time, so the final Telegram
// state always matches pi's response even if some stream events were missed.
async function finalizeStream(s: StreamState, finalText: string): Promise<void> {
  const text = finalText.trim() ? finalText : (s.text.trim() || '(pi returned no text)')
  // DIVE-341: render the authoritative text minus any opt-out marker, then attach
  // the Yes/No keyboard to the LAST chunk's message after the final flush.
  const { stripped, keyboard: ynKeyboard } = yesNoButtons(text)
  s.finalText = stripped
  s.finalized = true
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  await flushStream(s)
  if (s.dirty) { await new Promise(r => setTimeout(r, 50)); await flushStream(s) }
  // DIVE-708/717: a choice-list keyboard takes precedence over Yes/No, but only
  // when the reply landed as a single chunk (the tap resolves from that message).
  const optRes = s.msgIds.length === 1 ? optionButtons(text) : {}
  const keyboard = optRes.keyboard ?? ynKeyboard
  if (keyboard && s.msgIds.length) {
    const lastId = s.msgIds[s.msgIds.length - 1]!
    await bot.api.editMessageReplyMarkup(s.chat_id, lastId, { reply_markup: keyboard })
      .catch((err: any) => process.stderr.write(`telegram-pi: keyboard attach failed: ${err?.message}\n`))
    if (optRes.keyboard && optRes.labels) rememberOptions(lastId, optRes.labels)
  }
  streams.delete(s.chat_id)
  stopTypingLoop(s.chat_id)
}

function dropStream(chat_id: string): void {
  const s = streams.get(chat_id)
  if (s?.timer) { clearTimeout(s.timer); s.timer = null }
  streams.delete(chat_id)
}

const BOT_COMMANDS: Array<{ command: string; description: string; menuHidden?: boolean }> = [
  { command: 'help',    description: 'Show commands' },
  { command: 'status',  description: 'Model, session' },
  { command: 'stop',    description: 'Abort current turn' },
  { command: 'restart', description: 'Restart the agent' },
  { command: 'agents',  description: 'Team' },
  { command: 'team',    description: 'Team (alias for /agents)', menuHidden: true },
  { command: 'tasks',   description: 'List open tasks' },
  { command: 'task',    description: 'Add a task — /task add <title>' },
  { command: 'org',     description: 'Show the agent org chart' },
  { command: 'model',   description: 'Pick model' },
  { command: 'ping',    description: 'Liveness check' },
  { command: 'start',   description: 'Pair this chat' },
]

// /team is a hidden alias: still dispatched and shown in /help, but kept off the
// BotFather command-menu picker.
const MENU_COMMANDS = BOT_COMMANDS.filter(c => !c.menuHidden)

function helpText(): string {
  return [
    `*telegram-pi* v${PLUGIN_VERSION} — bridge for the pi CLI`,
    ``, `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send is forwarded to pi as a prompt.`,
    `mutating tools (bash/write/edit) ask for a 🔐 tap before they run.`,
    `docs: github.com/5dive-ai/5dive-plugins/tree/main/plugins/telegram-pi`,
  ].join('\n')
}

const SERVER_STARTED_AT = Date.now()

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

function execText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    require('child_process').execFile(cmd, args, { timeout: 4000 }, (err: any, out: string) => {
      resolve(err ? null : (String(out || '').split('\n')[0].trim() || null))
    })
  })
}

function fmtVer(raw: string): string {
  const m = raw.match(/\d+\.\d+(?:\.\d+)?[\w.+-]*/)
  return m ? `v${m[0]}` : raw
}

function agentName(): string {
  try {
    const user = require('os').userInfo().username as string
    if (user.startsWith('agent-')) return user.slice('agent-'.length)
  } catch {}
  return 'unknown'
}

function run5dive(args: string[], timeout = 8000): Promise<{ ok: boolean; data?: any; error?: { message?: string } }> {
  return new Promise((resolve, reject) => {
    require('child_process').execFile('sudo', ['-n', '5dive', ...args], { timeout },
      (err: any, stdout: string) => {
        if (err && !stdout) return reject(err)
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
      })
  })
}

async function read5diveInfo(): Promise<{ cliVersion?: string; authProfile?: string; model?: string } | null> {
  try {
    const j = await run5dive(['agent', 'info', agentName(), '--json'])
    if (!j.ok || !j.data) return null
    return { cliVersion: j.data.cliVersion ?? undefined, authProfile: j.data.authProfile ?? undefined, model: j.data.model ?? undefined }
  } catch { return null }
}

function agentUptimeMs(): number {
  const name = agentName()
  if (name !== 'unknown') {
    try {
      const out = require('child_process').execFileSync('tmux',
        ['display-message', '-t', `agent-${name}`, '-p', '#{session_created}'], { timeout: 3000 }).toString().trim()
      const created = Number(out) * 1000
      if (created > 0) return Date.now() - created
    } catch {}
  }
  return Date.now() - SERVER_STARTED_AT
}

async function statusText(senderName: string): Promise<string> {
  const lines = [`Paired as ${senderName}.`, '']
  lines.push(`status: 🟢 pi (in-process SDK)`)
  const mdl = currentModel()
  lines.push(`model: ${mdl ? `${mdl.providerID}/${mdl.modelID}` : '(pi default)'}`)
  lines.push(`active chats: ${engines.size}`)
  lines.push(`uptime: ${formatDuration(agentUptimeMs())}`)
  const info = await read5diveInfo()
  if (info?.cliVersion) {
    const v0 = info.cliVersion.replace(/^[A-Za-z][A-Za-z0-9-]*\s+/, '').trim() || info.cliVersion
    lines.push(`pi: ${/^\d/.test(v0) ? 'v' + v0 : v0}`)
  }
  lines.push(`plugin: v${PLUGIN_VERSION}`)
  const fiveVer = await execText('sudo', ['-n', '5dive', '--version'])
  if (fiveVer) lines.push(`5dive: ${fmtVer(fiveVer)}`)
  lines.push(`account: ${info?.authProfile || 'default'}`)
  return lines.join('\n')
}

async function listAgents(): Promise<string> {
  return new Promise(resolve => {
    require('child_process').execFile('sudo', ['-n', '5dive', 'agent', 'list', '--json'], { timeout: 5000 },
      (err: any, stdout: string) => {
        if (err) return resolve(`⚠️ \`5dive agent list\` failed: ${err.message}`)
        try {
          const env = JSON.parse(stdout) as { ok: boolean; data: any[] }
          if (!env.ok || !Array.isArray(env.data) || env.data.length === 0) return resolve('no agents found')
          const self = agentName()
          const lines = [`*agents on this host* (${env.data.length}):`, '']
          for (const a of env.data) {
            const me = a.name === self ? ' ← me' : ''
            const dot = a.active === 'active' ? '🟢' : '⚪'
            lines.push(`${dot} \`${a.name}\` — ${a.type}${a.channels && a.channels !== 'none' ? ` · ${a.channels}` : ''}${me}`)
          }
          resolve(lines.join('\n'))
        } catch (e) { resolve(`⚠️ couldn't parse \`5dive agent list\`: ${e}`) }
      })
  })
}

// --- /tasks: tappable list + single-task detail (host-shared queue) ---
function taskAssignedToMe(assignee: string | null | undefined): boolean {
  if (!assignee) return false
  const me = agentName()
  if (!me || me === 'unknown') return false
  return assignee === me || assignee === `agent-${me}`
}

function clampList(header: string, lines: string[], total = lines.length): string {
  const BUDGET = 4000
  let used = header.length
  const kept: string[] = []
  for (const line of lines) {
    if (used + line.length + 1 > BUDGET) break
    kept.push(line)
    used += line.length + 1
  }
  const hidden = total - kept.length
  return header + kept.join('\n') + (hidden > 0 ? `\n(+${hidden} more)` : '')
}

function taskRow(t: any, needTag = false): string {
  const TITLE_MAX = 80
  const mine = taskAssignedToMe(t.assignee) ? '⭐ ' : ''
  const flag = t.status === 'in_progress' ? '▶ ' : t.status === 'blocked' ? '⛔ ' : ''
  let title = String(t.title ?? '')
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX - 1) + '…'
  const tag = needTag && t.need_type ? ` [${t.need_type}]` : ''
  const who = t.assignee ? ` (${String(t.assignee).replace(/^agent-/, '')})` : ''
  return `${mine}${flag}${t.ident} · ${title}${tag}${who}  /task_${t.id}`
}

async function buildTaskList(): Promise<string> {
  let j: any
  try {
    j = await run5dive(['task', 'ls', '--json'])
  } catch (err) {
    return `Failed to list tasks: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!j.ok || !Array.isArray(j.data?.tasks)) return '5dive returned unexpected output.'
  const tasks = j.data.tasks
  if (tasks.length === 0) return 'No open tasks.\n\nAdd one with /task add <title>.'
  const MAX = 40
  const needsYou = tasks.filter((t: any) => t.need_type)
  const rest = tasks.filter((t: any) => !t.need_type)
  const sections: string[] = []
  if (needsYou.length) {
    const lines = needsYou.map((t: any) => taskRow(t, true))
    sections.push(clampList(`🔔 Needs you (${needsYou.length}) · tap /task_N to act:\n\n`, lines))
  }
  if (rest.length) {
    const lines = rest.slice(0, MAX).map((t: any) => taskRow(t))
    sections.push(clampList('Open tasks · ⭐ = yours · tap /task_N to open:\n\n', lines, rest.length))
  }
  return sections.join('\n\n')
}

async function buildTaskDetail(id: number): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  let j: any
  try {
    j = await run5dive(['task', 'show', String(id), '--json'])
  } catch (err) {
    return { text: `Failed to load task: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!j.ok || !j.data?.task) return { text: 'Task not found.' }
  const t = j.data.task
  const mine = taskAssignedToMe(t.assignee) ? ' ⭐' : ''
  const lines = [
    `${t.ident} · ${t.title}`,
    ``,
    `status: ${t.status}${t.priority ? `  ·  priority: ${t.priority}` : ''}`,
    `assignee: ${t.assignee || '(unassigned)'}${mine}`,
  ]
  if (t.created_by) lines.push(`created by: ${t.created_by}`)
  const subs = Array.isArray(j.data.subtasks) ? j.data.subtasks : []
  if (subs.length) lines.push(`subtasks: ${subs.length}`)
  if (t.body) {
    let body = String(t.body)
    if (body.length > 1500) body = body.slice(0, 1500) + '\n…(truncated)'
    lines.push('', body)
  }
  if (t.result) lines.push('', `result: ${t.result}`)
  lines.push('', 'back to list: /tasks')
  let keyboard: InlineKeyboard | undefined
  if (t.status !== 'done' && t.status !== 'cancelled') {
    keyboard = new InlineKeyboard()
    if (t.assignee) keyboard.text('▶️ Do now', `donow:${t.id}`)
    keyboard.text('🔺 Escalate', `esc:${t.id}`)
    keyboard.row()
    keyboard.text('✅ Done', `tdone:${t.id}`).text('🚫 Cancel', `tcancel:${t.id}`)
  }
  return { text: lines.join('\n'), keyboard }
}

async function addTask(arg: string, from: string): Promise<string> {
  const sp = arg.indexOf(' ')
  const sub = (sp === -1 ? arg : arg.slice(0, sp)).toLowerCase()
  const title = sp === -1 ? '' : arg.slice(sp + 1).trim()
  if (sub !== 'add') return 'Usage:\n`/task add <title>` — create a task\n`/tasks` — list open tasks'
  if (!title) return "What's the task? Try:\n`/task add Wire up the billing webhook`"
  try {
    const j = await run5dive(['task', 'add', '--json', `--from=${from}`, '--', title])
    if (!j.ok) return `⚠️ Failed: ${j.error?.message ?? 'unknown error'}`
    return `✅ Created \`${j.data.ident}\` — ${j.data.title}`
  } catch (err) { return `⚠️ Failed to add task: ${err instanceof Error ? err.message : String(err)}` }
}

async function orgTree(arg: string): Promise<string> {
  if (arg !== '' && arg !== 'tree') return 'Usage:\n`/org tree` — show the agent org chart'
  try {
    const j = await run5dive(['org', 'tree', '--json'])
    if (!j.ok || !Array.isArray(j.data?.tree)) return '⚠️ `5dive org tree` returned unexpected output.'
    const tree = j.data.tree
    if (tree.length === 0) return 'Org chart is empty.'
    const lines = tree.map((n: any) => {
      const indent = '  '.repeat(Math.max(0, n.depth ?? 0))
      const label = n.title || n.role ? ` — ${n.title || n.role}` : ''
      return `${indent}${n.name}${label}`
    })
    return `*Org chart:*\n\n${lines.join('\n')}`
  } catch (err) { return `⚠️ Failed to read org chart: ${err instanceof Error ? err.message : String(err)}` }
}

async function restartAgent(name: string, ackUpdateId?: number): Promise<void> {
  if (name === 'unknown') return
  if (ackUpdateId != null) {
    try { await bot.api.getUpdates({ offset: ackUpdateId + 1, limit: 1, timeout: 0 }) } catch {}
  }
  await new Promise<void>(resolve => {
    require('child_process').execFile('sudo', ['-n', '5dive', 'agent', 'restart', name], { timeout: 10_000 }, () => resolve())
  })
}

// /model — show or switch the pi model. Written to ~/.pi/agent/settings.json
// (defaultProvider/defaultModel), then the chat's engine is disposed so the next
// message rebuilds the session onto the new model (pi reads model at session start).
async function handleModelCommand(chat_id: string, arg: string): Promise<string> {
  const name = arg.trim()
  if (!name) {
    const cur = currentModel()
    return `*model* — pi\n\ncurrent: \`${cur ? `${cur.providerID}/${cur.modelID}` : '(pi default)'}\`\n\n`
      + `Switch with \`/model <provider>/<modelId>\` (e.g. \`anthropic/claude-sonnet-4-5\`) — applies to your next message.`
  }
  const slash = name.indexOf('/')
  if (!/^[A-Za-z0-9._:\/-]+$/.test(name) || slash <= 0) {
    return `⚠️ \`${name}\` isn't a \`<provider>/<modelId>\` id.`
  }
  const provider = name.slice(0, slash), model = name.slice(slash + 1)
  try { setModel(provider, model) }
  catch (e) { return `⚠️ couldn't save model: ${e instanceof Error ? e.message : String(e)}` }
  await disposeEngine(chat_id)
  return `🔁 model → \`${provider}/${model}\` (applies to your next message)`
}

async function abortChat(chat_id: string): Promise<string> {
  const e = engines.get(chat_id)
  if (!e) return 'Nothing running for this chat.'
  try { await e.session.abort() } catch (err) {
    return `⚠️ abort failed: ${err instanceof Error ? err.message : String(err)}`
  }
  dropStream(chat_id)
  stopTypingLoop(chat_id)
  return '✋ aborted the current turn.'
}

// ── /login: pi authenticates via env-injected API keys (DIVE-1200), not a device
// flow, so there's nothing to self-serve here — point at the dashboard/CLI. ─────
function loginHint(): string {
  return 'pi authenticates via an API key set at create time (or on the dashboard). '
    + 'There is no device-login flow. To change providers/keys use the 5dive dashboard '
    + 'or `5dive agent auth set pi --provider=<p> --api-key=<key>`, then /restart.'
}

// Returns true if handled as a slash command (don't forward to pi).
async function handleSlashCommand(ctx: Context, text: string): Promise<boolean> {
  const m = text.match(/^\/([a-z][a-z0-9_]*)(?:@([\w]+))?(?:\s|$)/i)
  if (!m) return false
  const cmd = m[1]!.toLowerCase()
  const targetBot = m[2]?.toLowerCase()
  if (targetBot && targetBot !== botUsername.toLowerCase()) return false
  if (!BOT_COMMANDS.some(c => c.command === cmd)) return false

  const chat_id = String(ctx.chat!.id)
  const reply_to = ctx.message?.message_id
  const updateId = ctx.update.update_id
  const cmdArg = text.slice(m[0]!.length).trim()
  const md = (t: string) => bot.api.sendMessage(chat_id, t, {
    parse_mode: 'Markdown', ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
  })

  try {
    switch (cmd) {
      case 'help': await md(helpText()); return true
      case 'status': {
        const sender = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'you')
        await bot.api.sendMessage(chat_id, await statusText(sender),
          reply_to ? { reply_parameters: { message_id: reply_to } } : undefined)
        return true
      }
      case 'ping':
        await bot.api.sendMessage(chat_id, `pong — telegram-pi v${PLUGIN_VERSION}`,
          reply_to ? { reply_parameters: { message_id: reply_to } } : undefined)
        return true
      case 'stop': await md(await abortChat(chat_id)); return true
      case 'restart': {
        const name = agentName()
        await bot.api.sendMessage(chat_id, `restarting agent \`${name}\` — back in ~2s`, {
          parse_mode: 'Markdown', ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        }).catch(() => {})
        await restartAgent(name, updateId)
        return true
      }
      case 'model': await md(await handleModelCommand(chat_id, cmdArg)); return true
      case 'team':
      case 'agents': await md(await listAgents()); return true
      case 'tasks': {
        await bot.api.sendMessage(chat_id, await buildTaskList(), {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'task': await md(await addTask(cmdArg, ctx.from?.username || 'telegram')); return true
      case 'org': await md(await orgTree(cmdArg)); return true
      case 'start':
        await md(
          'This bot bridges Telegram to your pi session.\n\n' +
          'Already paired? Just type. Messages here reach the pi session, and any ' +
          'command that writes to the box (bash/write/edit) asks you to approve it first.\n\n' +
          'Not paired yet? Send me a message to get a pairing code, then have the ' +
          'server operator run `5dive agent pair <agent> --code=<code>`. You can also ' +
          'be added from the 5dive dashboard (Telegram access).\n\n' +
          'Try `/help` for the full command list.')
        return true
    }
  } catch (err) {
    process.stderr.write(`telegram-pi: /${cmd} reply failed: ${err}\n`)
  }
  return true
}

// ============================================================================
// Inbound → pi prompt
// ============================================================================

async function ingest(ctx: Context, text: string): Promise<void> {
  const verdict = gate(ctx)
  if (!verdict.allowed) {
    if ('pair' in verdict && verdict.pair) {
      const { code, chatId, isResend } = verdict.pair
      const lead = isResend ? 'Still pending' : 'Pairing required'
      await bot.api.sendMessage(chatId,
        `${lead} — give this code to the 5dive operator to approve you:\n\n` +
        `\`${code}\`\n\n` + `They run: 5dive agent pair <agent> --code=${code}`,
        { parse_mode: 'Markdown' }).catch(() => {})
    }
    return
  }
  if (await handleSlashCommand(ctx, text)) return

  lastInboundTs = new Date().toISOString()
  const chat = ctx.chat!
  const chat_id = String(chat.id)
  const reply_to = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id

  const ack = verdict.access.ackReaction
  if (ack && reply_to != null) {
    void bot.api.setMessageReaction(chat_id, reply_to, [{ type: 'emoji', emoji: ack as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }

  await runPrompt(chat_id, text, { reply_to, thread: threadId })
}

// Forward one prompt to the chat's pi session and relay the streamed reply. Split
// out of ingest() so a synthetic prompt (a Yes/No or option button tap) rides the
// same session/stream/finalize path a typed message takes.
async function runPrompt(chat_id: string, text: string, opts: { reply_to?: number; thread?: number }): Promise<void> {
  const { reply_to, thread } = opts
  startTypingLoop(chat_id)
  let engine: ChatEngine | undefined
  try {
    engine = await engineForChat(chat_id)
    const stream = newStream(chat_id, reply_to, thread)
    // Resolves when the turn ends. A mutating tool mid-turn blocks on a Telegram
    // tap (see buildPermExtension) — that tap is a separate update, which is why
    // runIngest fires this un-awaited so the grammy update loop stays free.
    await engine.session.prompt(text)
    const finalText = stream.text.trim() || lastAssistantText(engine.session)
    await finalizeStream(stream, finalText)
  } catch (err) {
    dropStream(chat_id)
    stopTypingLoop(chat_id)
    await sendReply(chat_id, `⚠️ pi error: ${err instanceof Error ? err.message : String(err)}`, { reply_to, thread })
  }
}

// IMPORTANT: do NOT await ingest() here. grammy processes updates sequentially —
// it won't fetch the next update until the current handler resolves. A pi turn
// blocks until it ends, and a turn that hits a permission gate can't end until
// the user TAPS a button — but that tap is the next update, which can't be
// processed while we're still awaiting the turn. Awaiting would deadlock. Firing
// the turn async keeps the update loop free so callbacks/new messages flow.
const runIngest = (ctx: Context, text: string) =>
  void ingest(ctx, text).catch(err => process.stderr.write(`telegram-pi: ingest failed: ${err}\n`))

// /task_<id> — tappable deep link from the /tasks list. Registered BEFORE the
// message bridge so the tap opens the detail and is NOT forwarded as a prompt.
bot.hears(/^\/task_(\d+)\b/, async ctx => {
  const senderId = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(senderId)) return
  const m = /^\/task_(\d+)\b/.exec(ctx.message?.text ?? '')
  if (!m) return
  const detail = await buildTaskDetail(Number(m[1]))
  await ctx.reply(detail.text, detail.keyboard ? { reply_markup: detail.keyboard } : undefined)
})

bot.on('message:text', ctx => { runIngest(ctx, ctx.message.text) })
bot.on('message:photo', ctx => {
  runIngest(ctx, ctx.message.caption ?? '(photo — image input not yet wired)')
})
bot.on('message:document', ctx => {
  runIngest(ctx, ctx.message.caption ?? `(document: ${ctx.message.document.file_name ?? 'file'} — file input not yet wired)`)
})

bot.catch(err => { process.stderr.write(`telegram-pi: handler error (polling continues): ${err.error}\n`) })

// ============================================================================
// Callback routing — buttons (perm gate / yn / options / task actions)
// ============================================================================

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''

  // 🔐 tool-permission tap (piperm:<verdict>:<id>) — resolves the pending
  // requestToolApproval() promise, unblocking (or blocking) the pi tool call.
  const pm = data.match(/^piperm:(once|always|reject):(.+)$/)
  if (pm) {
    const verdict = pm[1] as PermVerdict
    const id = pm[2]!
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const pending = pendingToolPerms.get(id)
    pendingToolPerms.delete(id)
    if (pending) pending.resolve(verdict)
    await ctx.answerCallbackQuery({ text: verdict === 'reject' ? '❌ rejected' : `✅ ${verdict}` }).catch(() => {})
    if (pending?.message_id != null) {
      const who = ctx.from.username ?? ctx.from.first_name ?? senderId
      await bot.api.editMessageText(pending.chat_id, pending.message_id,
        `${verdict === 'reject' ? '❌ rejected' : `✅ allowed (${verdict})`} by ${who}`, { reply_markup: undefined }).catch(() => {})
    }
    return
  }

  // DIVE-341: Yes/No question tap — inject 'yes'/'no' through the same prompt path.
  const ynM = /^yn:(yes|no)$/.exec(data)
  if (ynM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const value = ynM[1]!
    const msg = ctx.callbackQuery.message
    const chat_id = String(msg?.chat.id ?? ctx.from.id)
    const thread = msg && 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id != null
      ? msg.message_thread_id : undefined
    void runPrompt(chat_id, value, { thread }).catch(err =>
      process.stderr.write(`telegram-pi: yn ingest failed: ${err}\n`))
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.answerCallbackQuery({ text: value === 'yes' ? '👍 Yes' : '👎 No' }).catch(() => {})
    return
  }

  // DIVE-708/717: choice-list button tap (opt:<index>).
  const optM = OPT_RE.exec(data)
  if (optM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const idx = Number(optM[1])
    const msg = ctx.callbackQuery.message
    const labels = (msg ? optionLabelsByMsg.get(msg.message_id) : undefined)
      ?? (msg && 'text' in msg && typeof msg.text === 'string' ? parseOptions(msg.text).map(o => o.label) : [])
    const value = labels[idx]
    if (value == null) {
      await ctx.answerCallbackQuery({ text: 'That option is no longer available.' }).catch(() => {})
      return
    }
    const chat_id = String(msg?.chat.id ?? ctx.from.id)
    const thread = msg && 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id != null
      ? msg.message_thread_id : undefined
    void runPrompt(chat_id, value, { thread }).catch(err =>
      process.stderr.write(`telegram-pi: opt ingest failed: ${err}\n`))
    if (msg) optionLabelsByMsg.delete(msg.message_id)
    await ctx.editMessageReplyMarkup().catch(() => {})
    const ackLabel = value.length > 40 ? value.slice(0, 39) + '…' : value
    await ctx.answerCallbackQuery({ text: `✓ ${ackLabel}` }).catch(() => {})
    return
  }

  // DIVE-449: Escalate tap under a /task_<id> detail.
  const escM = /^esc:(\d+)$/.exec(data)
  if (escM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = escM[1]!
    try {
      const r = await run5dive(['task', 'escalate', taskId, '--json'], 8000)
      const pri = r.ok ? (r.data?.priority ?? 'high') : 'high'
      await ctx.answerCallbackQuery({ text: `🔺 Escalated — priority ${pri}` }).catch(() => {})
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard().text('▶️ Do now', `donow:${taskId}`),
      }).catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't escalate — open the dashboard." }).catch(() => {})
    }
    return
  }

  // DIVE-503: Do now tap — ping the assignee to pick it up immediately.
  const dnM = /^donow:(\d+)$/.exec(data)
  if (dnM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = dnM[1]!
    try {
      const show = await run5dive(['task', 'show', taskId, '--json'], 5000)
      const task = show.ok ? show.data?.task : undefined
      const assignee = task?.assignee ? String(task.assignee).replace(/^agent-/, '') : ''
      if (!assignee) {
        await ctx.answerCallbackQuery({ text: 'No assignee — assign it first.' }).catch(() => {})
        return
      }
      const ident = task?.ident ?? `task ${taskId}`
      await run5dive(['task', 'start', taskId, '--json'], 8000).catch(() => {})
      const msg = `▶️ Mark wants ${ident} done now — please pick it up immediately. Details: /task_${taskId}`
      await run5dive(['agent', 'send', assignee, msg, '--json'], 8000)
      await ctx.answerCallbackQuery({ text: `▶️ Pinged ${assignee} — on it now` }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't kick it off — open the dashboard." }).catch(() => {})
    }
    return
  }

  // DIVE-503: ✅ Done (one-tap) / 🚫 Cancel (two-tap confirm) for /task_<id>.
  const tdM = /^tdone:(\d+)$/.exec(data)
  if (tdM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = tdM[1]!
    try {
      await run5dive(['task', 'done', taskId, '--json'], 8000)
      await ctx.answerCallbackQuery({ text: '✅ Marked done' }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't mark done — open the dashboard." }).catch(() => {})
    }
    return
  }
  const tcM = /^tcancel:(\d+)$/.exec(data)
  if (tcM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = tcM[1]!
    await ctx.answerCallbackQuery({ text: 'Tap "Confirm cancel" to cancel this task.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard()
        .text('⚠️ Confirm cancel', `tcancelc:${taskId}`)
        .text('↩︎ Keep', `tkeep:${taskId}`),
    }).catch(() => {})
    return
  }
  const tccM = /^tcancelc:(\d+)$/.exec(data)
  if (tccM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = tccM[1]!
    try {
      await run5dive(['task', 'cancel', taskId, '--json'], 8000)
      await ctx.answerCallbackQuery({ text: '🚫 Cancelled' }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't cancel — open the dashboard." }).catch(() => {})
    }
    return
  }
  const tkM = /^tkeep:(\d+)$/.exec(data)
  if (tkM) {
    const taskId = tkM[1]!
    try {
      const detail = await buildTaskDetail(Number(taskId))
      await ctx.editMessageText(detail.text, { reply_markup: detail.keyboard }).catch(() => {})
    } catch {}
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
})

// ============================================================================
// Boot
// ============================================================================

process.on('SIGTERM', () => { shuttingDown = true; bot.stop().catch(() => {}); for (const id of [...engines.keys()]) void disposeEngine(id) })
process.on('SIGINT',  () => { shuttingDown = true; bot.stop().catch(() => {}); for (const id of [...engines.keys()]) void disposeEngine(id) })

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        // Telegram remembers the last allowed_updates for a token; pin ours so a
        // prior bridge on this token can't have narrowed out callback_query
        // (which would silently kill our permission/option buttons).
        allowed_updates: ['message', 'callback_query'],
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-pi: polling as @${info.username} (hosting pi via in-process SDK)\n`)
          for (const scope of [undefined, { type: 'all_private_chats' as const }]) {
            void bot.api.setMyCommands(MENU_COMMANDS, scope ? { scope } : undefined).catch(err => {
              process.stderr.write(`telegram-pi: setMyCommands(${scope?.type ?? 'default'}) failed: ${err}\n`)
            })
          }
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
      process.stderr.write(
        `telegram-pi: polling error attempt ${attempt}${is409 ? ' (409 Conflict)' : ''}: `
        + `${err instanceof Error ? err.message : String(err)}; retrying in ${wait}ms\n`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
})()

// Touch unused imports/helpers kept for parity with the fork family / future use.
void InputFile; void statSync; void unlinkSync; void existsSync; void assertInStateDir
void assertAllowedChat; void PHOTO_EXTS; void MAX_ATTACHMENT_BYTES; void loginHint; void lastInboundTs
