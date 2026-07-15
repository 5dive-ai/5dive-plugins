#!/usr/bin/env bun
/**
 * Telegram bridge for the pi coding agent (earendil-works / pi-coding-agent).
 *
 * A long-running relay that HOSTS pi in-process via `createAgentSession()`:
 *
 *   Telegram inbound ──▶ session.prompt(text) ──▶ text_delta stream ──▶ Telegram
 *                        pi `tool_call` extension hook (bash/write/edit)
 *                                             ──▶ 🔐 once/always/reject buttons
 *                                             ──▶ { block:true } on reject
 *
 * SANDBOXED BY DEFAULT: pi ships no built-in permission system, so this bridge
 * gates every MUTATING tool (bash/write/edit) behind a Telegram approval tap.
 * Read-only tools (read/ls/grep/find) pass silently. The gate is the pi
 * extension API's `tool_call` event, which can block execution.
 *
 * Auth: pi's default AuthStorage falls back to the env `*_API_KEY` (e.g.
 * ANTHROPIC_API_KEY), so no key wiring is needed here. Model: read from
 * ~/.pi/agent/settings.json defaultProvider/defaultModel.
 *
 * State: ~/.pi/channels/telegram/{access.json, .env, bot.pid}
 * Surface: access control, pairing, chunking, streaming edit-in-place,
 * permission buttons, and the /status /stop /restart /model handlers.
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
import { createRequire } from 'module'
import { homedir } from 'os'
import { join, sep } from 'path'

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version ?? 'unknown')
  } catch { return 'unknown' }
})()

// Version of the installed pi SDK, for /status. Resolved via node_modules.
const requirePkg = createRequire(import.meta.url)
function piSdkVersion(): string {
  try {
    const pkg = requirePkg('@earendil-works/pi-coding-agent/package.json')
    return String(pkg.version ?? 'unknown')
  } catch { return 'unknown' }
}

// ~/.pi/agent (settings.json, sessions/, auth.json) — pi's config home.
const AGENT_DIR = process.env.PI_AGENT_DIR ?? getAgentDir()
const SETTINGS_FILE = join(AGENT_DIR, 'settings.json')
// The directory pi's tools operate in (bash cwd etc.). Set PI_PROJECT_DIR;
// defaults to the current working directory.
const PI_PROJECT_DIR = process.env.PI_PROJECT_DIR ?? process.cwd()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.PI_HOME ?? join(homedir(), '.pi'), 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')

// Liveness beacon for the single getUpdates slot. The active poller bumps this
// file's mtime every HEARTBEAT_MS; a newcomer treats the slot as HELD only while
// the beacon is fresh. Acquisition happens in the poll bootstrap at the bottom.
const HEARTBEAT_FILE = join(STATE_DIR, 'bot.heartbeat')
const HEARTBEAT_MS = 3000
// 3 missed beats — how long a newcomer waits before deciding the incumbent died.
const HEARTBEAT_STALE_MS = 9000

// A TRANSIENT spawn running this server.ts (an overlapping respawn, or a
// shared-checkout enumeration) used to eagerly SIGTERM whatever PID held the
// slot and claim it, then die — leaving NO poller (channel deaf until a manual
// restart). Fix: never stomp a HEALTHY incumbent; acquisition is deferred to the
// poll bootstrap, which waits out a fresh heartbeat and only reclaims the slot
// once the beacon goes stale (incumbent actually dead).
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function heartbeatFresh(): boolean {
  try { return Date.now() - statSync(HEARTBEAT_FILE).mtimeMs < HEARTBEAT_STALE_MS } catch { return false }
}
function incumbentHolds(): boolean {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    return pid > 1 && pid !== process.pid && pidAlive(pid) && heartbeatFresh()
  } catch { return false }
}
// Set once this process becomes the active poller; cleared on shutdown.
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

// ============================================================================
// Access control  (allowlist + DM pairing)
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

export function loadAccess(): AccessJson {
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

export function saveAccess(a: AccessJson): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = ACCESS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, ACCESS_FILE)
  } catch (err) {
    process.stderr.write(`telegram-pi: saveAccess failed: ${err}\n`)
  }
}

export function pruneExpired(a: AccessJson): boolean {
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

export function gate(ctx: Context): GateResult {
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
// Read for /status and /model; written by /model.
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
export const MUTATING_TOOLS = new Set(['bash', 'write', 'edit'])

export function describeTool(name: string, input: any): string {
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

let bot!: Bot
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
export function chunkForTelegram(text: string, limit = TG_MAX_MESSAGE_CHARS): string[] {
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

// Auto-render a Yes/No inline keyboard when an assistant reply ends in a single
// yes/no question. Conservative — only when there's exactly one '?' and the
// trailing question isn't an "A or B?" choice. Opt-out: a trailing
// `<!-- no-buttons -->` (or `<!-- no-yn -->`), stripped either way.
const YN_SUPPRESS = /\s*<!--\s*no-?(?:yn|buttons)\s*-->\s*$/i
export function yesNoButtons(text: string): { stripped: string; keyboard?: InlineKeyboard } {
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

// Render one tappable button per option when a reply presents a lettered/numbered
// choice list. Detection is optionChoices() in tna.ts; here we build the keyboard.
// callback_data is `opt:<index>`; the label is re-resolved from the tapped message
// at tap time. Shares the YN opt-out marker.
const OPT_BTN_MAX = 56
export function optionButtons(text: string): { keyboard?: InlineKeyboard; labels?: string[] } {
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
  // Render the authoritative text minus any opt-out marker, then attach the
  // Yes/No keyboard to the LAST chunk's message after the final flush.
  const { stripped, keyboard: ynKeyboard } = yesNoButtons(text)
  s.finalText = stripped
  s.finalized = true
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  await flushStream(s)
  if (s.dirty) { await new Promise(r => setTimeout(r, 50)); await flushStream(s) }
  // A choice-list keyboard takes precedence over Yes/No, but only when the reply
  // landed as a single chunk (the tap resolves from that message).
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
  { command: 'restart', description: 'Reset the pi session' },
  { command: 'model',   description: 'Pick model' },
  { command: 'ping',    description: 'Liveness check' },
  { command: 'start',   description: 'Pair this chat' },
]

const MENU_COMMANDS = BOT_COMMANDS.filter(c => !c.menuHidden)

function helpText(): string {
  return [
    `*telegram-pi* v${PLUGIN_VERSION} — bridge for the pi coding agent`,
    ``, `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send is forwarded to pi as a prompt.`,
    `mutating tools (bash/write/edit) ask for a 🔐 tap before they run.`,
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

// Generic status — no external supervisor. Shows the in-process pi runtime, the
// current model, active chats, uptime, the bridge version, and the pi SDK version.
function statusText(senderName: string): string {
  const lines = [`Paired as ${senderName}.`, '']
  lines.push(`status: 🟢 pi (in-process SDK)`)
  const mdl = currentModel()
  lines.push(`model: ${mdl ? `${mdl.providerID}/${mdl.modelID}` : '(pi default)'}`)
  lines.push(`active chats: ${engines.size}`)
  lines.push(`uptime: ${formatDuration(Date.now() - SERVER_STARTED_AT)}`)
  lines.push(`bridge: v${PLUGIN_VERSION}`)
  lines.push(`pi SDK: v${piSdkVersion()}`)
  return lines.join('\n')
}

// /model — show or switch the pi model. Written to ~/.pi/agent/settings.json
// (defaultProvider/defaultModel), then the chat's engine is disposed so the next
// message rebuilds the session onto the new model (pi reads model at session start).
async function handleModelCommand(chat_id: string, arg: string): Promise<string> {
  const name = arg.trim()
  if (!name) {
    const cur = currentModel()
    return `*model* — pi\n\ncurrent: \`${cur ? `${cur.providerID}/${cur.modelID}` : '(pi default)'}\`\n\n`
      + `Switch with \`/model <provider>/<modelId>\` (e.g. \`anthropic/claude-sonnet-4-5\`) — applies to your next message.\n\n`
      + `pi authenticates with a provider API key from the environment (e.g. \`ANTHROPIC_API_KEY\`).`
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

// /restart — no external supervisor in standalone. Dispose every chat's engine
// so the next message starts a fresh pi session. Does NOT kill the process.
async function resetAllSessions(): Promise<string> {
  const n = engines.size
  for (const id of [...engines.keys()]) await disposeEngine(id)
  dropStreamAll()
  return `🔁 pi session reset${n ? ` (${n} chat${n === 1 ? '' : 's'})` : ''}`
}

function dropStreamAll(): void {
  for (const id of [...streams.keys()]) { dropStream(id); stopTypingLoop(id) }
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
  const md = (t: string) => bot.api.sendMessage(chat_id, t, {
    parse_mode: 'Markdown', ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
  })

  try {
    switch (cmd) {
      case 'help': await md(helpText()); return true
      case 'status': {
        const sender = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'you')
        await bot.api.sendMessage(chat_id, statusText(sender),
          reply_to ? { reply_parameters: { message_id: reply_to } } : undefined)
        return true
      }
      case 'ping':
        await bot.api.sendMessage(chat_id, `pong — telegram-pi v${PLUGIN_VERSION}`,
          reply_to ? { reply_parameters: { message_id: reply_to } } : undefined)
        return true
      case 'stop': await md(await abortChat(chat_id)); return true
      case 'restart': await md(await resetAllSessions()); return true
      case 'model': {
        const cmdArg = text.slice(m[0]!.length).trim()
        await md(await handleModelCommand(chat_id, cmdArg)); return true
      }
      case 'start':
        await md(
          'This bot bridges Telegram to a pi coding agent.\n\n' +
          'Already paired? Just type. Messages here reach the pi session, and any ' +
          'command that writes to the box (bash/write/edit) asks you to approve it first.\n\n' +
          'Not paired yet? Send me a message to get a pairing code, then ask the bot ' +
          'operator to add you with the pairing tool (`telegram-pi-pair`, or `bun pair.ts`).\n\n' +
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
        `${lead} — share this code with the bot operator so they can approve you:\n\n` +
        `\`${code}\`\n\n` +
        `They run the pairing tool on the host: \`telegram-pi-pair\` (or \`bun pair.ts\`).`,
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

// ============================================================================
// Handler registration (wired only when the bridge actually polls)
// ============================================================================

function registerHandlers(): void {
  bot.on('message:text', ctx => { runIngest(ctx, ctx.message.text) })
  bot.on('message:photo', ctx => {
    runIngest(ctx, ctx.message.caption ?? '(photo — image input not yet wired)')
  })
  bot.on('message:document', ctx => {
    runIngest(ctx, ctx.message.caption ?? `(document: ${ctx.message.document.file_name ?? 'file'} — file input not yet wired)`)
  })

  bot.catch(err => { process.stderr.write(`telegram-pi: handler error (polling continues): ${err.error}\n`) })

  // ==========================================================================
  // Callback routing — buttons (perm gate / yn / options)
  // ==========================================================================
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

    // Yes/No question tap — inject 'yes'/'no' through the same prompt path.
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

    // Choice-list button tap (opt:<index>).
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
  })
}

// ============================================================================
// Boot
// ============================================================================

function shutdown() {
  shuttingDown = true
  try {
    // Only the active poller owns these files — never clear an incumbent's.
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
      unlinkSync(PID_FILE)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      try { unlinkSync(HEARTBEAT_FILE) } catch {}
    }
  } catch {}
  bot?.stop().catch(() => {})
  for (const id of [...engines.keys()]) void disposeEngine(id)
}

async function boot(): Promise<void> {
  // Single-flight acquisition: wait until no HEALTHY incumbent holds the slot,
  // then claim it. A transient enumeration spawn parks here harmlessly and is
  // killed by its parent before it ever polls.
  async function acquireSlot(): Promise<void> {
    for (;;) {
      if (shuttingDown) return
      if (!incumbentHolds()) {
        try {
          const prev = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
          if (prev > 1 && prev !== process.pid && pidAlive(prev)) {
            process.stderr.write(`telegram-pi: reclaiming stale poller pid=${prev}\n`)
            process.kill(prev, 'SIGTERM')
          }
        } catch {}
        writeFileSync(PID_FILE, String(process.pid))
        return
      }
      await new Promise(r => setTimeout(r, HEARTBEAT_MS))
    }
  }
  const bumpHeartbeat = () => { try { writeFileSync(HEARTBEAT_FILE, String(Date.now())) } catch {} }
  await acquireSlot()
  if (shuttingDown) return
  bumpHeartbeat()
  heartbeatTimer = setInterval(bumpHeartbeat, HEARTBEAT_MS)

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
      // A 409 means another process is already polling this bot token. Re-run
      // single-flight acquisition so we PARK behind a HEALTHY incumbent (fresh
      // heartbeat) instead of thrashing getUpdates against it forever. Without
      // this, a second server.ts spawned by an overlapping respawn fights the
      // boot poller indefinitely — two live pollers on one token = permanent
      // 409 = the plugin goes deaf.
      if (is409) await acquireSlot()
    }
  }
}

// Only wire I/O, require the token, and start polling when run directly. Importing
// this module (e.g. from tests) must NOT boot the bot or exit the process.
if (import.meta.main) {
  process.on('unhandledRejection', err => {
    process.stderr.write(`telegram-pi: unhandled rejection: ${err}\n`)
  })
  process.on('uncaughtException', err => {
    process.stderr.write(`telegram-pi: uncaught exception: ${err}\n`)
  })

  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

  // Lock the token file to owner-only, then load it. Real env wins.
  try {
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    process.stderr.write(
      `telegram-pi: TELEGRAM_BOT_TOKEN required\n` +
      `  set in ${ENV_FILE}\n` +
      `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
    )
    process.exit(1)
  }

  bot = new Bot(token)
  registerHandlers()

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  void boot()
}

// Touch symbols kept for parity / future use so the bundler doesn't flag them.
void InputFile; void existsSync; void assertInStateDir
void assertAllowedChat; void PHOTO_EXTS; void MAX_ATTACHMENT_BYTES; void lastInboundTs
