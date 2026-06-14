#!/usr/bin/env bun
/**
 * Telegram bridge for the opencode CLI (DIVE-11).
 *
 * UNLIKE the codex/grok/agy forks, opencode is NOT driven through a
 * wait_for_message MCP loop. opencode ships a headless HTTP server
 * (`opencode serve`) with a 131-route REST API and a `GET /event` SSE push
 * stream, so this is a long-running RELAY, not an MCP server:
 *
 *   Telegram inbound ──▶ POST /session/{id}/message ──▶ assistant reply ──▶ Telegram
 *                        GET /event (SSE) ──▶ permission.asked / question.asked
 *                                             ──▶ Telegram inline buttons ──▶ reply
 *                                          ──▶ session.error ──▶ Telegram
 *
 * Because the server pushes events, there is NO re-arm watchdog (server.heartbeat
 * is the liveness signal), NO Stop/silence hooks (session.idle marks turn-end),
 * and NO file-IPC permission bridge (permission.asked/permission reply are API).
 * See plugins/telegram-opencode-SPIKE.md for the feasibility findings.
 *
 * State: ~/.opencode/channels/telegram/{access.json, .env, sessions.json, inbox/, bot.pid}
 * Reused verbatim from the grok fork: access control, pairing, chunking, and the
 * /status /stop /restart /agents /tasks /task /org /model command handlers.
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
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

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.OPENCODE_HOME ?? join(homedir(), '.opencode'), 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'bot.pid')
// chat_id -> opencode sessionID, so a chat keeps one continuous conversation.
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
// Persisted model override (set via /model), "providerID/modelID".
const MODEL_FILE = join(STATE_DIR, 'model')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

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
    `telegram-opencode: TELEGRAM_BOT_TOKEN required\n` +
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
    process.stderr.write(`telegram-opencode: replacing stale poller pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-opencode: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-opencode: uncaught exception: ${err}\n`)
})

// ============================================================================
// Access control  (verbatim from the grok fork — keeps access/pairing parity)
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
    process.stderr.write(`telegram-opencode: saveAccess failed: ${err}\n`)
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
// opencode HTTP client (REST + SSE)
// ============================================================================

// Resolved at boot by ensureServer(): the base URL of the opencode server we
// drive. Either an already-running server (OPENCODE_SERVER_URL) or one we spawn.
let ocBase = ''
const OC_USER = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
const OC_PASS = process.env.OPENCODE_SERVER_PASSWORD ?? ''
const OC_DIR = process.env.OPENCODE_PROJECT_DIR ?? process.cwd()

function ocHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) }
  if (OC_PASS) h['authorization'] = 'Basic ' + Buffer.from(`${OC_USER}:${OC_PASS}`).toString('base64')
  return h
}

async function ocFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ocBase}${path}`, {
    ...init,
    headers: ocHeaders({ 'content-type': 'application/json', ...(init?.headers as any) }),
  })
}

// Model used for prompts: /model override file > OPENCODE_MODEL env > server
// default (omit the field). Returns {providerID, modelID} or null.
function currentModel(): { providerID: string; modelID: string } | null {
  let raw = ''
  try { raw = readFileSync(MODEL_FILE, 'utf8').trim() } catch {}
  if (!raw) raw = process.env.OPENCODE_MODEL ?? ''
  const slash = raw.indexOf('/')
  if (slash <= 0) return null
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

// Probe a base URL for a live opencode server.
async function ocAlive(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/global/health`, { headers: ocHeaders(), signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

// Bind an OS-assigned loopback port, then release it and hand the number to
// `opencode serve --port N`. Lets multiple opencode agents share one box with no
// per-agent port bookkeeping in provisioning (DIVE-42). The bind→close→reuse
// window is tiny and we're the only thing spawning servers in this state dir.
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => port ? resolve(port) : reject(new Error('could not acquire a free port')))
    })
  })
}

// Attach to OPENCODE_SERVER_URL if reachable, else spawn `opencode serve`. The
// spawned server is a child of this process and dies with it (the systemd unit
// owns the lifecycle either way).
let serveChild: ReturnType<typeof import('child_process').spawn> | null = null
async function ensureServer(): Promise<void> {
  const configured = process.env.OPENCODE_SERVER_URL
  if (configured && await ocAlive(configured)) {
    ocBase = configured.replace(/\/$/, '')
    process.stderr.write(`telegram-opencode: attached to ${ocBase}\n`)
    return
  }
  const { spawn } = require('child_process')
  // Honor an explicit OPENCODE_SERVE_PORT (debug/attach), otherwise auto-pick a
  // free loopback port so co-located opencode agents never collide.
  const explicit = process.env.OPENCODE_SERVE_PORT
  const port = explicit ? Number(explicit) : await pickFreePort()
  const bin = process.env.OPENCODE_BIN ?? 'opencode'
  const env = { ...process.env }
  if (OC_PASS) env.OPENCODE_SERVER_PASSWORD = OC_PASS
  serveChild = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: OC_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  serveChild!.stderr?.on('data', (d: Buffer) => process.stderr.write(`[opencode serve] ${d}`))
  serveChild!.stdout?.on('data', (d: Buffer) => process.stderr.write(`[opencode serve] ${d}`))
  ocBase = `http://127.0.0.1:${port}`
  // Wait for it to come up.
  for (let i = 0; i < 40; i++) {
    if (await ocAlive(ocBase)) {
      process.stderr.write(`telegram-opencode: spawned opencode serve at ${ocBase}\n`)
      return
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`opencode serve did not come up at ${ocBase} within 20s`)
}

// chat_id <-> sessionID maps. Persisted so a relay restart keeps continuity.
const chatToSession = new Map<string, string>()
const sessionToChat = new Map<string, string>()
function loadSessions(): void {
  try {
    const m = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Record<string, string>
    for (const [chat, ses] of Object.entries(m)) { chatToSession.set(chat, ses); sessionToChat.set(ses, chat) }
  } catch {}
}
function saveSessions(): void {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(chatToSession), null, 2) + '\n', { mode: 0o600 })
  } catch (err) { process.stderr.write(`telegram-opencode: saveSessions failed: ${err}\n`) }
}

async function sessionForChat(chat_id: string): Promise<string> {
  const existing = chatToSession.get(chat_id)
  if (existing) {
    // Verify it still exists server-side (a server restart drops sessions).
    try {
      const r = await ocFetch(`/session/${existing}`)
      if (r.ok) return existing
    } catch {}
  }
  const r = await ocFetch('/session', { method: 'POST', body: JSON.stringify({}) })
  if (!r.ok) throw new Error(`POST /session failed: HTTP ${r.status}`)
  const ses = (await r.json()) as { id: string }
  chatToSession.set(chat_id, ses.id)
  sessionToChat.set(ses.id, chat_id)
  saveSessions()
  return ses.id
}

// Concatenate the text parts of an assistant message response.
function extractText(parts: any[]): string {
  return (parts ?? []).filter(p => p?.type === 'text' && typeof p.text === 'string')
    .map(p => p.text).join('').trim()
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

// DIVE-341 (port of DIVE-332/335): auto-render a Yes/No inline keyboard when an
// assistant reply ends in a single yes/no question. Conservative on purpose — we
// only attach when there's exactly one '?' in the message, and the trailing
// question isn't an "A or B?" choice (false buttons on rhetorical/multi-part
// prompts are worse than a missed one). Opt-out: a trailing `<!-- no-buttons -->`
// (or `<!-- no-yn -->`), stripped from the outgoing text either way.
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

// Send a (possibly long) reply to a chat, chunked. Reused by the relay and commands.
async function sendReply(chat_id: string, text: string, opts?: { reply_to?: number; thread?: number }): Promise<void> {
  const limit = loadAccess().textChunkLimit ?? TG_MAX_MESSAGE_CHARS
  const chunks = chunkForTelegram(text || '(empty reply)', limit)
  for (let i = 0; i < chunks.length; i++) {
    await bot.api.sendMessage(chat_id, chunks[i]!, {
      ...(i === 0 && opts?.reply_to != null ? { reply_parameters: { message_id: opts.reply_to } } : {}),
      ...(opts?.thread != null ? { message_thread_id: opts.thread } : {}),
    }).catch((err: any) => process.stderr.write(`telegram-opencode: sendReply failed: ${err?.message}\n`))
  }
}

let lastInboundTs: string | null = null

// ============================================================================
// Progressive streaming relay
// ============================================================================
//
// The per-token stream comes from `message.part.delta` events (field:text). We
// accumulate those and edit a Telegram message in place as it grows, so the user
// watches the reply form instead of waiting for one dump at turn-end.
//
// Three traps the live API taught us, all handled here:
//   • `message.part.updated` is NOT the token stream — it fires only at part
//     start (empty) and end (full). Keying off it makes the reply land as one
//     block. It IS the source of truth for a part's TYPE and final text.
//   • reasoning streams through the same `field:text` deltas as the answer, but
//     on parts typed `reasoning`. We learn each part's type from `updated` and
//     append deltas only for `text` parts, so reasoning never leaks in.
//   • the user's OWN prompt echoes back as a text part (role=user) — skipped via
//     the role learned from `message.updated`.

const EDIT_THROTTLE_MS = 1100

type StreamState = {
  chat_id: string
  ses: string
  reply_to?: number
  thread?: number
  textParts: Map<string, string>   // assistant text partID -> accumulated text
  partType: Map<string, string>    // partID -> opencode part type (text/reasoning/…)
  order: string[]                  // text partIDs in first-seen order
  msgIds: number[]                 // telegram message id per chunk
  sentChunks: string[]             // last text set on each chunk's message
  lastEditAt: number
  timer: ReturnType<typeof setTimeout> | null
  started: boolean                 // first chunk sent (typing can stop)
  finalized: boolean
  finalText: string | null         // authoritative text from the prompt POST
  flushing: boolean
  dirty: boolean
}

const streams = new Map<string, StreamState>()   // sessionID -> stream
const roleByMsg = new Map<string, string>()       // messageID -> role
const lastPromptByChat = new Map<string, string>() // chat_id -> last prompt text

function newStream(chat_id: string, ses: string, reply_to?: number, thread?: number): StreamState {
  const s: StreamState = {
    chat_id, ses, reply_to, thread,
    textParts: new Map(), partType: new Map(), order: [], msgIds: [], sentChunks: [],
    lastEditAt: 0, timer: null, started: false, finalized: false,
    finalText: null, flushing: false, dirty: false,
  }
  streams.set(ses, s)
  return s
}

function renderStream(s: StreamState): string {
  return s.order.map(id => s.textParts.get(id) ?? '').join('').trim()
}
function targetText(s: StreamState): string {
  return s.finalText ?? renderStream(s)
}

function scheduleFlush(s: StreamState): void {
  if (s.timer || s.finalized) return
  const wait = Math.max(0, EDIT_THROTTLE_MS - (Date.now() - s.lastEditAt))
  s.timer = setTimeout(() => { s.timer = null; void flushStream(s) }, wait)
}

// Render the current target text into one-or-more Telegram messages, editing in
// place. chunkForTelegram splits greedily from the front, so once text only
// grows by appending, earlier chunk boundaries are stable — only the tail chunk
// keeps changing, and sentChunks[] dedup skips no-op edits on the settled ones.
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
          if (!/not modified/i.test(d)) process.stderr.write(`telegram-opencode: stream edit failed: ${d}\n`)
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
          process.stderr.write(`telegram-opencode: stream send failed: ${err}\n`)
        }
      }
    }
  } finally {
    s.flushing = false
    if (s.dirty) { s.dirty = false; void flushStream(s) }
  }
}

// Lock in the authoritative text from the prompt POST and flush one last time,
// so the final Telegram state always matches opencode's response exactly even
// if some stream events were missed.
async function finalizeStream(s: StreamState, finalText: string): Promise<void> {
  const text = finalText.trim() ? finalText : (renderStream(s) || '(opencode returned no text)')
  // DIVE-341: render the authoritative text minus any opt-out marker, then (after
  // the final flush) attach the Yes/No keyboard to the LAST chunk's message — the
  // streaming equivalent of the forks' last-chunk reply_markup.
  const { stripped, keyboard } = yesNoButtons(text)
  s.finalText = stripped
  s.finalized = true
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  await flushStream(s)
  if (s.dirty) { await new Promise(r => setTimeout(r, 50)); await flushStream(s) }
  if (keyboard && s.msgIds.length) {
    const lastId = s.msgIds[s.msgIds.length - 1]!
    await bot.api.editMessageReplyMarkup(s.chat_id, lastId, { reply_markup: keyboard })
      .catch((err: any) => process.stderr.write(`telegram-opencode: yn keyboard attach failed: ${err?.message}\n`))
  }
  streams.delete(s.ses)
  stopTypingLoop(s.chat_id)
}

function dropStream(ses: string): void {
  const s = streams.get(ses)
  if (s?.timer) { clearTimeout(s.timer); s.timer = null }
  streams.delete(ses)
}

const BOT_COMMANDS: Array<{ command: string; description: string; menuHidden?: boolean }> = [
  { command: 'help',    description: 'Show commands' },
  { command: 'status',  description: 'Server, model, session' },
  { command: 'stop',    description: 'Abort current turn' },
  { command: 'restart', description: 'Respawn opencode' },
  { command: 'agents',  description: 'Team' },
  { command: 'team',    description: 'Team (alias for /agents)', menuHidden: true },
  { command: 'tasks',   description: 'List open tasks' },
  { command: 'task',    description: 'Add a task — /task add <title>' },
  { command: 'org',     description: 'Show the agent org chart' },
  { command: 'model',   description: 'Pick model' },
  { command: 'login',   description: 'Authenticate your coding-CLI' },
  { command: 'ping',    description: 'Liveness check' },
  { command: 'start',   description: 'Pair this chat' },
]

// /team is a hidden alias: still dispatched and shown in /help, but kept off
// the BotFather command-menu picker — Mark: don't list both /agents and /team.
const MENU_COMMANDS = BOT_COMMANDS.filter(c => !c.menuHidden)

function helpText(): string {
  return [
    `*telegram-opencode* v${PLUGIN_VERSION} — bridge for the opencode CLI`,
    ``, `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send is forwarded to opencode as a prompt.`,
    `docs: github.com/5dive-ai/5dive-plugins/tree/main/plugins/telegram-opencode`,
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
  const now = Date.now()
  const lines = [`Paired as ${senderName}.`, '']
  lines.push(`status: ${ocBase ? '🟢 connected' : '🔴 no server'}`)
  lines.push(`server: ${ocBase || '(none)'}`)
  const mdl = currentModel()
  lines.push(`model: ${mdl ? `${mdl.providerID}/${mdl.modelID}` : '(opencode default)'}`)
  lines.push(`uptime: ${formatDuration(agentUptimeMs())}`)
  const info = await read5diveInfo()
  if (info?.cliVersion) {
    const v0 = info.cliVersion.replace(/^[A-Za-z][A-Za-z0-9-]*\s+/, '').trim() || info.cliVersion
    lines.push(`opencode: ${/^\d/.test(v0) ? 'v' + v0 : v0}`)
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
// Open tasks render as one button each (tap -> detail); rows assigned to THIS
// agent are starred. The detail view carries a Back button that re-renders the
// list. Read-only; mutations still go through /task add and the dashboard/CLI.
function taskAssignedToMe(assignee: string | null | undefined): boolean {
  if (!assignee) return false
  const me = agentName()
  if (!me || me === 'unknown') return false
  // task assignees appear as either the bare agent name ("main") or the unix
  // user form ("agent-main") in the queue — match both.
  return assignee === me || assignee === `agent-${me}`
}

// Telegram inline-button labels are centered and silently clipped, so the list
// is plain left-aligned text with a tappable /task_<id> deep link per row
// (handled by the bot.hears below). Rows assigned to THIS agent are starred.
// Read-only; mutations go through /task add + dashboard/CLI.
// Render one task row: ⭐ if mine, a status flag, ident · title, assignee, link.
// `needTag` appends the gate type (e.g. " [approval]") for the Needs-you section.
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
  // Human-gated tasks (a pending need awaiting a person) float to their own
  // "Needs you" section on top; `task ls` carries need_type only while the gate
  // is unanswered, so its presence is a clean "needs a human" flag.
  const needsYou = tasks.filter((t: any) => t.need_type)
  const rest = tasks.filter((t: any) => !t.need_type)
  const sections: string[] = []
  if (needsYou.length) {
    const lines = needsYou.map((t: any) => taskRow(t, true))
    sections.push(`🔔 Needs you (${needsYou.length}) · tap /task_N to act:\n\n${lines.join('\n')}`)
  }
  if (rest.length) {
    const lines = rest.slice(0, MAX).map((t: any) => taskRow(t))
    const more = rest.length > MAX ? `\n(+${rest.length - MAX} more)` : ''
    sections.push(`Open tasks · ⭐ = yours · tap /task_N to open:\n\n${lines.join('\n')}${more}`)
  }
  return sections.join('\n\n')
}

async function buildTaskDetail(id: number): Promise<string> {
  let j: any
  try {
    j = await run5dive(['task', 'show', String(id), '--json'])
  } catch (err) {
    return `Failed to load task: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!j.ok || !j.data?.task) return 'Task not found.'
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
  return lines.join('\n')
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
  // Ack the triggering update before we tear down, so Telegram doesn't redeliver
  // /restart on the next boot and self-restart-loop (DIVE-13).
  if (ackUpdateId != null) {
    try { await bot.api.getUpdates({ offset: ackUpdateId + 1, limit: 1, timeout: 0 }) } catch {}
  }
  await new Promise<void>(resolve => {
    require('child_process').execFile('sudo', ['-n', '5dive', 'agent', 'restart', name], { timeout: 10_000 }, () => resolve())
  })
}

// /model — show or switch the model used for prompts. Persisted to MODEL_FILE;
// takes effect on the next message (no restart needed — the model is a per-prompt field).
async function handleModelCommand(arg: string): Promise<string> {
  const name = arg.trim()
  if (!name) {
    const cur = currentModel()
    let avail = ''
    try {
      const r = await ocFetch('/provider'); if (r.ok) {
        const d = await r.json() as any
        const ids: string[] = (d?.providers ?? d ?? []).flatMap?.((p: any) =>
          Object.keys(p.models ?? {}).slice(0, 3).map((m: string) => `${p.id}/${m}`)) ?? []
        if (ids.length) avail = `\n\nsome available:\n${ids.slice(0, 12).map(i => `  \`${i}\``).join('\n')}`
      }
    } catch {}
    return `*model* — opencode\n\ncurrent: \`${cur ? `${cur.providerID}/${cur.modelID}` : '(opencode default)'}\`\n\n`
      + `Switch with \`/model <providerID>/<modelID>\` — applies to your next message.${avail}`
  }
  if (!/^[A-Za-z0-9._:\/-]+$/.test(name) || !name.includes('/')) {
    return `⚠️ \`${name}\` isn't a \`<providerID>/<modelID>\` id.`
  }
  try { writeFileSync(MODEL_FILE, name + '\n', { mode: 0o600 }) }
  catch (e) { return `⚠️ couldn't save model: ${e instanceof Error ? e.message : String(e)}` }
  return `🔁 model → \`${name}\` (applies to your next message)`
}

async function abortChat(chat_id: string): Promise<string> {
  const ses = chatToSession.get(chat_id)
  if (!ses) return 'Nothing running for this chat.'
  try {
    const r = await ocFetch(`/session/${ses}/abort`, { method: 'POST', body: '{}' })
    dropStream(ses)
    stopTypingLoop(chat_id)
    return r.ok ? '✋ aborted the current turn.' : `⚠️ abort failed: HTTP ${r.status}`
  } catch (e) { return `⚠️ abort failed: ${e instanceof Error ? e.message : String(e)}` }
}

// ── /login (DIVE-380): self-serve coding-CLI auth (self-poll types) ──────────
// Wraps the on-box device-code flow (`5dive agent auth start|poll|cancel`). The
// CLI type is resolved at RUNTIME via `agent info` — never hardcoded — so this
// is identical across forks and dodges the generator's name-sweep. grok/codex/
// openclaw self-poll (CLI completes on its own); antigravity is v2 (deferred).
type AuthState = { state?: string; url?: string; code?: string; error?: string; type?: string }
async function authPollFork(sid: string): Promise<AuthState | null> {
  const j = await run5dive(['agent', 'auth', 'poll', sid, '--json'], 8000)
  return j?.ok && j.data ? (j.data as AuthState) : null
}
async function pollAuthUntilFork(
  sid: string,
  done: (s: AuthState) => boolean,
  deadline: number,
): Promise<AuthState | null> {
  const backoff = [2000, 3000, 5000, 8000, 12000, 15000]
  let i = 0
  let last: AuthState | null = null
  while (Date.now() < deadline) {
    const s = await authPollFork(sid)
    if (s) {
      last = s
      if (s.state === 'ok' || s.state === 'error' || s.state === 'expired') return s
      if (done(s)) return s
    }
    const wait = backoff[Math.min(i, backoff.length - 1)]!
    i++
    if (Date.now() + wait >= deadline) break
    await new Promise(r => setTimeout(r, wait))
  }
  return last
}
async function reportLoginFork(sid: string, chatId: string, s: AuthState | null, opts?: { restarting?: boolean }): Promise<void> {
  if (s?.state === 'ok') {
    // Copy must match the action: fresh auth restarts to apply the creds; an
    // already-authed (cached) result changes nothing, so it must NOT say "restarting".
    await bot.api.sendMessage(chatId, opts?.restarting
      ? '✅ Authenticated — restarting to apply (~2s).'
      : '✅ Already authenticated — your agent is ready.').catch(() => {})
  } else if (s?.state === 'error') {
    await bot.api.sendMessage(chatId, `⚠️ Login failed: ${s.error ?? 'unknown error'}. Tap /login to retry.`).catch(() => {})
  } else {
    await run5dive(['agent', 'auth', 'cancel', sid, '--json'], 5000)
    await bot.api.sendMessage(chatId, '⏱️ Login timed out — tap /login to start over.').catch(() => {})
  }
}

// Returns true if handled as a slash command (don't forward to opencode).
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
        await bot.api.sendMessage(chat_id, `pong — telegram-opencode v${PLUGIN_VERSION}`,
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
      case 'model': await md(await handleModelCommand(cmdArg)); return true
      case 'login': {
        const info = await run5dive(['agent', 'info', agentName(), '--json'])
        const type = info?.data?.type
        if (!type) {
          await bot.api.sendMessage(chat_id, "Couldn't detect your coding-CLI type — use the dashboard.")
          return true
        }
        // 0.5.0 ships /login for claude ONLY. Every fork (self-poll) type is
        // DEFERRED until DIVE-382 verifies each one's cred-path: a fork /login
        // that auths then boots a REVOKED token leaves the agent dead (codex hit
        // exactly this), which is worse than no /login — so the self-poll path
        // below is intentionally unreachable in this release. No swept type
        // literals here, so this stays identical across forks; flip per-type
        // (re-enable the self-poll) once DIVE-382 proves each type.
        const LOGIN_SELF_POLL_ENABLED = false
        if (!LOGIN_SELF_POLL_ENABLED || type === 'antigravity') {
          await bot.api.sendMessage(
            chat_id,
            `/login doesn't support ${type} yet — use the dashboard or \`5dive agent auth start ${type}\`.`,
          )
          return true
        }
        await bot.api.sendMessage(chat_id, `🔐 Starting ${type} login…`)
        const started = await run5dive(['agent', 'auth', 'start', type, '--json'], 15000)
        const sid = started?.data?.sessionId
        if (!sid) {
          await bot.api.sendMessage(chat_id, `Couldn't start login: ${started?.error?.message ?? 'failed'}.`)
          return true
        }
        const s = await pollAuthUntilFork(sid, st => !!st.url, Date.now() + 90_000)
        if (s?.state === 'ok') {
          await reportLoginFork(sid, chat_id, s) // already authed (cached creds) — no cred change, no restart
          return true
        }
        if (!s?.url) {
          await run5dive(['agent', 'auth', 'cancel', sid, '--json'], 5000)
          await bot.api.sendMessage(chat_id, 'No auth link in time — tap /login to retry.')
          return true
        }
        const codeLine = s.code ? `\n\nDevice code: ${s.code}` : ''
        await bot.api.sendMessage(
          chat_id,
          `Open this link, sign in and approve:\n${s.url}${codeLine}\n\nI'll confirm here when it completes — nothing to send back.`,
        )
        // Background-poll the device flow to completion, then APPLY the new creds by
        // restarting: a coding-CLI only reads auth at boot, and a fresh device-login
        // revokes the live session's prior token — so without a restart /login would
        // falsely report ok while the agent stays dead/on-old-creds. Restart reloads
        // creds AND re-enters the listen loop (mirrors the /model self-restart,
        // DIVE-380). Only on success; failure/timeout leaves the session untouched.
        void pollAuthUntilFork(sid, () => false, Date.now() + 3600_000).then(async fin => {
          await reportLoginFork(sid, chat_id, fin, { restarting: fin?.state === 'ok' })
          if (fin?.state === 'ok') await restartAgent(agentName())
        })
        return true
      }
      case 'team':
      case 'agents': await md(await listAgents()); return true
      case 'tasks': {
        // Plain text (no parse_mode) so the /task_N deep links stay tappable and
        // titles aren't mangled by Markdown.
        await bot.api.sendMessage(chat_id, await buildTaskList(), {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'task': await md(await addTask(cmdArg, ctx.from?.username || 'telegram')); return true
      case 'org': await md(await orgTree(cmdArg)); return true
      case 'start':
        await md(
          'This bot bridges Telegram to your opencode session.\n\n' +
          'Already paired? Just type. Messages here reach the opencode session.\n\n' +
          'Not paired yet? Send me a message to get a pairing code, then have the ' +
          'server operator run `5dive agent pair <agent> --code=<code>`. You can also ' +
          'be added from the 5dive dashboard (Telegram access). Standalone installs ' +
          'without 5dive: `bun pair.ts` in the telegram-opencode plugin dir.\n\n' +
          'Try `/help` for the full command list.')
        return true
    }
  } catch (err) {
    process.stderr.write(`telegram-opencode: /${cmd} reply failed: ${err}\n`)
  }
  return true
}

// ============================================================================
// Inbound → opencode prompt
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

// Forward one prompt to opencode and relay the streamed reply back. Split out of
// ingest() so a synthetic prompt (e.g. a Yes/No button tap, DIVE-341) rides the
// exact same session/stream/finalize path a typed message takes.
async function runPrompt(chat_id: string, text: string, opts: { reply_to?: number; thread?: number }): Promise<void> {
  const { reply_to, thread } = opts
  startTypingLoop(chat_id)
  lastPromptByChat.set(chat_id, text)
  let ses = ''
  try {
    ses = await sessionForChat(chat_id)
    const model = currentModel()
    const body: any = { parts: [{ type: 'text', text }] }
    if (model) body.model = model
    // Register a stream so the SSE relay can edit a Telegram message in place as
    // assistant text parts arrive during this turn.
    const stream = newStream(chat_id, ses, reply_to, thread)
    // Synchronous prompt: resolves with the assistant message once the turn
    // ends. Permission/question interrupts that arrive mid-turn are handled
    // concurrently by the SSE relay below.
    const r = await ocFetch(`/session/${ses}/message`, { method: 'POST', body: JSON.stringify(body) })
    if (!r.ok) {
      dropStream(ses)
      stopTypingLoop(chat_id)
      await sendReply(chat_id, `⚠️ opencode error: HTTP ${r.status}`, { reply_to, thread })
      return
    }
    const msg = (await r.json()) as { parts?: any[]; info?: any }
    // Finalize against the authoritative response text — this both delivers the
    // reply when nothing streamed (fast turns) and corrects any drift when it did.
    await finalizeStream(stream, extractText(msg.parts ?? []))
  } catch (err) {
    if (ses) dropStream(ses)
    stopTypingLoop(chat_id)
    await sendReply(chat_id, `⚠️ failed to reach opencode: ${err instanceof Error ? err.message : String(err)}`,
      { reply_to, thread })
  }
}

// IMPORTANT: do NOT await ingest() here. grammy's bot.start() processes updates
// sequentially — it won't fetch the next update until the current handler
// resolves. An opencode turn blocks until it ends, and a turn that hits a
// permission prompt can't end until the user TAPS a button — but that tap is the
// next update, which can't be processed while we're still awaiting the turn.
// Awaiting would deadlock (turn waits for tap, tap waits for turn). Firing the
// turn async keeps the update loop free so callbacks/new messages flow through.
const runIngest = (ctx: Context, text: string) =>
  void ingest(ctx, text).catch(err => process.stderr.write(`telegram-opencode: ingest failed: ${err}\n`))

// /task_<id> — tappable deep link from the /tasks list. Opens the single-task
// detail. Registered BEFORE the message bridge so the tap is handled here and
// NOT forwarded to the agent as a normal message (no next()). Gated on allowFrom.
bot.hears(/^\/task_(\d+)\b/, async ctx => {
  const senderId = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(senderId)) return
  const m = /^\/task_(\d+)\b/.exec(ctx.message?.text ?? '')
  if (!m) return
  await ctx.reply(await buildTaskDetail(Number(m[1])))
})

bot.on('message:text', ctx => { runIngest(ctx, ctx.message.text) })
bot.on('message:photo', ctx => {
  // Image understanding via file parts is a follow-up; for now forward the caption.
  runIngest(ctx, ctx.message.caption ?? '(photo — image input not yet wired)')
})
bot.on('message:document', ctx => {
  runIngest(ctx, ctx.message.caption ?? `(document: ${ctx.message.document.file_name ?? 'file'} — file input not yet wired)`)
})

bot.catch(err => { process.stderr.write(`telegram-opencode: handler error (polling continues): ${err.error}\n`) })

// ============================================================================
// SSE event relay — permission.asked / question.asked / session.error
// ============================================================================

// permission requestID -> {chat_id, sessionID, message_id} for the buttons we posted.
const pendingPermissions = new Map<string, { chat_id: string; ses: string; message_id?: number }>()

async function postPermissionPrompt(ev: any): Promise<void> {
  const p = ev.properties ?? ev
  const ses = String(p.sessionID ?? ''), reqId = String(p.id ?? '')
  const chat_id = sessionToChat.get(ses)
  if (!chat_id || !reqId) return
  // `permission` is the tool/action (e.g. "bash"); `patterns` holds the concrete
  // thing being permitted (e.g. the command), which is what the user wants to see.
  const what = Array.isArray(p.patterns) && p.patterns.length
    ? p.patterns.join('\n') : String(p.permission ?? 'action')
  const body = `🔐 opencode wants to run *${String(p.permission)}*:\n\`${what.slice(0, 350)}\``
  const kb = new InlineKeyboard()
    .text('✅ once', `ocperm:once:${reqId}`).text('✅ always', `ocperm:always:${reqId}`).text('❌ reject', `ocperm:reject:${reqId}`)
  try {
    const sent = await bot.api.sendMessage(chat_id, body, { parse_mode: 'Markdown', reply_markup: kb })
    pendingPermissions.set(reqId, { chat_id, ses, message_id: sent.message_id })
  } catch (err) { process.stderr.write(`telegram-opencode: permission prompt failed: ${err}\n`) }
}

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''

  // DIVE-341 (port of DIVE-332/335): tap on an auto-rendered Yes/No question
  // button (attached in finalizeStream when a reply ends in a single yes/no
  // question). Inject the plain 'yes'/'no' through the SAME prompt path a typed
  // reply takes (runPrompt) — so opencode's next turn just sees the answer.
  // Fire async (do NOT await) for the same deadlock reason ingest does. Drop the
  // keyboard so it can't be double-tapped, leaving the question text intact.
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
      process.stderr.write(`telegram-opencode: yn ingest failed: ${err}\n`))
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.answerCallbackQuery({ text: value === 'yes' ? '👍 Yes' : '👎 No' }).catch(() => {})
    return
  }

  // Permission-approval buttons (the /tasks list is now plain text + /task_<id>
  // deep links, handled by the bot.hears below — no task callbacks remain).
  const m = data.match(/^ocperm:(once|always|reject):(.+)$/)
  if (!m) return
  const response = m[1] as 'once' | 'always' | 'reject'
  const reqId = m[2]!
  const senderId = String(ctx.from.id)
  process.stderr.write(`telegram-opencode: callback ${response} for ${reqId} from ${senderId}\n`)
  if (!loadAccess().allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
    return
  }
  const pending = pendingPermissions.get(reqId)
  pendingPermissions.delete(reqId)
  if (pending) {
    try {
      await ocFetch(`/session/${pending.ses}/permissions/${reqId}`, { method: 'POST', body: JSON.stringify({ response }) })
    } catch (err) { process.stderr.write(`telegram-opencode: permission reply failed: ${err}\n`) }
  }
  await ctx.answerCallbackQuery({ text: response === 'reject' ? '❌ rejected' : `✅ ${response}` }).catch(() => {})
  if (pending?.message_id != null) {
    const who = ctx.from.username ?? ctx.from.first_name ?? senderId
    await bot.api.editMessageText(pending.chat_id, pending.message_id,
      `${response === 'reject' ? '❌ rejected' : `✅ allowed (${response})`} by ${who}`, { reply_markup: undefined }).catch(() => {})
  }
})

// One long-lived SSE subscription to /event. Reconnects with backoff. Drives the
// interactive interrupts (text replies come from the awaited prompt POST instead).
async function startEventRelay(): Promise<void> {
  let attempt = 0
  while (!shuttingDown) {
    try {
      const res = await fetch(`${ocBase}/event`, { headers: ocHeaders({ accept: 'text/event-stream' }) })
      if (!res.ok || !res.body) throw new Error(`/event HTTP ${res.status}`)
      attempt = 0
      process.stderr.write(`telegram-opencode: subscribed to /event\n`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (!shuttingDown) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        // SSE frames are separated by blank lines; each carries `data: <json>`.
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
          const line = frame.split('\n').find(l => l.startsWith('data:'))
          if (!line) continue
          let ev: any
          try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
          void handleEvent(ev)
        }
      }
    } catch (err) {
      if (shuttingDown) return
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5))
      process.stderr.write(`telegram-opencode: /event stream dropped (${err instanceof Error ? err.message : err}); reconnecting in ${wait}ms\n`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

async function handleEvent(ev: any): Promise<void> {
  switch (ev.type) {
    case 'permission.asked': await postPermissionPrompt(ev); break
    case 'message.updated': {
      // Learn each message's role so we can tell the assistant's answer apart
      // from the user's echoed prompt when streaming text parts below.
      const info = ev.properties?.info
      if (info?.id && info?.role) {
        roleByMsg.set(info.id, info.role)
        if (roleByMsg.size > 2000) roleByMsg.clear()
      }
      break
    }
    case 'message.part.updated': {
      // This event carries part.type but only fires at part start (empty) and
      // end (full) — NOT per token. We use it purely to learn each part's TYPE
      // (so delta events below can be filtered to text vs reasoning) and to
      // correct the accumulated text with the authoritative full value.
      const part = ev.properties?.part
      if (!part) break
      const s = streams.get(String(part.sessionID ?? ''))
      if (!s) break
      const role = roleByMsg.get(part.messageID)
      if (role === 'user') break   // skip the user's own echoed prompt
      if (role === undefined && part.type === 'text' && typeof part.text === 'string'
          && part.text === lastPromptByChat.get(s.chat_id)) break
      s.partType.set(part.id, part.type)
      if (part.type !== 'text') break
      if (!s.textParts.has(part.id)) s.order.push(part.id)
      // Take the full text only if it's at least as long as what deltas built,
      // so a late empty/short update can't clobber streamed tokens.
      if (typeof part.text === 'string' && part.text.length >= (s.textParts.get(part.id) ?? '').length) {
        s.textParts.set(part.id, part.text)
      }
      scheduleFlush(s)
      break
    }
    case 'message.part.delta': {
      // The real token stream. Deltas don't carry part type, so we only append
      // for parts already known to be text (reasoning streams here too, on parts
      // typed 'reasoning' — excluded). Leading tokens before the part's first
      // `updated` are skipped; the prompt POST's authoritative text fills any gap.
      const p = ev.properties ?? {}
      if (p.field !== 'text') break
      const s = streams.get(String(p.sessionID ?? ''))
      if (!s || s.partType.get(p.partID) !== 'text') break
      if (!s.textParts.has(p.partID)) s.order.push(p.partID)
      s.textParts.set(p.partID, (s.textParts.get(p.partID) ?? '') + String(p.delta ?? ''))
      scheduleFlush(s)
      break
    }
    case 'session.error': {
      const p = ev.properties ?? ev
      const ses = String(p.sessionID ?? '')
      const chat_id = sessionToChat.get(ses)
      if (chat_id) {
        dropStream(ses)
        stopTypingLoop(chat_id)
        const detail = p.error?.data?.message ?? p.error?.name ?? JSON.stringify(p.error ?? {}).slice(0, 300)
        await sendReply(chat_id, `⚠️ opencode error: ${detail}`)
      }
      break
    }
    // session.idle / heartbeat are observed for liveness; the authoritative text
    // is finalized from the awaited prompt POST, so nothing to do here.
    default: break
  }
}

// ============================================================================
// Boot
// ============================================================================

process.on('SIGTERM', () => { shuttingDown = true; bot.stop().catch(() => {}); serveChild?.kill('SIGTERM') })
process.on('SIGINT',  () => { shuttingDown = true; bot.stop().catch(() => {}); serveChild?.kill('SIGTERM') })

loadSessions()
await ensureServer()
void startEventRelay()

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        // Telegram REMEMBERS the last allowed_updates passed to getUpdates and
        // reuses it when omitted. A bridge that ran on this token before (e.g.
        // an antigravity bot with no inline buttons) may have narrowed it to
        // exclude callback_query — which silently kills our permission buttons
        // (messages arrive, taps don't). Pin it explicitly to what we handle.
        allowed_updates: ['message', 'callback_query'],
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-opencode: polling as @${info.username}\n`)
          for (const scope of [undefined, { type: 'all_private_chats' as const }]) {
            void bot.api.setMyCommands(MENU_COMMANDS, scope ? { scope } : undefined).catch(err => {
              process.stderr.write(`telegram-opencode: setMyCommands(${scope?.type ?? 'default'}) failed: ${err}\n`)
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
        `telegram-opencode: polling error attempt ${attempt}${is409 ? ' (409 Conflict)' : ''}: `
        + `${err instanceof Error ? err.message : String(err)}; retrying in ${wait}ms\n`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
})()

// Touch unused imports kept for parity with the fork family / future use.
void InputFile; void statSync; void unlinkSync; void existsSync
