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

// Attach to OPENCODE_SERVER_URL if reachable, else spawn `opencode serve` and
// read its port off stdout. The spawned server is a child of this process and
// dies with it (the systemd unit owns the lifecycle either way).
let serveChild: ReturnType<typeof import('child_process').spawn> | null = null
async function ensureServer(): Promise<void> {
  const configured = process.env.OPENCODE_SERVER_URL
  if (configured && await ocAlive(configured)) {
    ocBase = configured.replace(/\/$/, '')
    process.stderr.write(`telegram-opencode: attached to ${ocBase}\n`)
    return
  }
  // Spawn our own server on a fixed loopback port.
  const { spawn } = require('child_process')
  const port = Number(process.env.OPENCODE_SERVE_PORT ?? 4096)
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

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help',    description: 'Show commands' },
  { command: 'status',  description: 'Server, model, session' },
  { command: 'stop',    description: 'Abort current turn' },
  { command: 'restart', description: 'Respawn opencode' },
  { command: 'agents',  description: 'Team' },
  { command: 'tasks',   description: 'List open tasks' },
  { command: 'task',    description: 'Add a task — /task add <title>' },
  { command: 'org',     description: 'Show the agent org chart' },
  { command: 'model',   description: 'Pick model' },
  { command: 'ping',    description: 'Liveness check' },
  { command: 'start',   description: 'Pair this chat' },
]

function helpText(): string {
  return [
    `*telegram-opencode* v${PLUGIN_VERSION} — bridge for the opencode CLI`,
    ``, `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send is forwarded to opencode as a prompt.`,
    `docs: github.com/5dive-com/5dive-plugins/tree/main/plugins/telegram-opencode`,
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

async function listTasks(): Promise<string> {
  try {
    const j = await run5dive(['task', 'ls', '--json'])
    if (!j.ok || !Array.isArray(j.data?.tasks)) return '⚠️ `5dive task ls` returned unexpected output.'
    const tasks = j.data.tasks
    if (tasks.length === 0) return 'No open tasks.\n\nAdd one with `/task add <title>`.'
    const lines = tasks.map((t: any) => {
      const pri = t.priority && t.priority !== 'medium' ? ` (${t.priority})` : ''
      const who = t.assignee ? ` · ${t.assignee}` : ''
      return `• \`${t.ident}\` [${t.status}]${pri} ${t.title}${who}`
    })
    return `*Open tasks:*\n\n${lines.join('\n')}`
  } catch (err) { return `⚠️ Failed to list tasks: ${err instanceof Error ? err.message : String(err)}` }
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
    stopTypingLoop(chat_id)
    return r.ok ? '✋ aborted the current turn.' : `⚠️ abort failed: HTTP ${r.status}`
  } catch (e) { return `⚠️ abort failed: ${e instanceof Error ? e.message : String(e)}` }
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
      case 'agents': await md(await listAgents()); return true
      case 'tasks': await md(await listTasks()); return true
      case 'task': await md(await addTask(cmdArg, ctx.from?.username || 'telegram')); return true
      case 'org': await md(await orgTree(cmdArg)); return true
      case 'start':
        await md(
          'This bot bridges Telegram to an opencode session.\n\n' +
          'To pair:\n' +
          '1. Run `bun pair.ts` in the telegram-opencode plugin dir to get your user id allowlisted\n' +
          '2. After that, messages here are forwarded to opencode.\n\n' +
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

  startTypingLoop(chat_id)
  try {
    const ses = await sessionForChat(chat_id)
    const model = currentModel()
    const body: any = { parts: [{ type: 'text', text }] }
    if (model) body.model = model
    // Synchronous prompt: resolves with the assistant message once the turn
    // ends. Permission/question interrupts that arrive mid-turn are handled
    // concurrently by the SSE relay below.
    const r = await ocFetch(`/session/${ses}/message`, { method: 'POST', body: JSON.stringify(body) })
    if (!r.ok) {
      stopTypingLoop(chat_id)
      await sendReply(chat_id, `⚠️ opencode error: HTTP ${r.status}`, { reply_to, thread: threadId })
      return
    }
    const msg = (await r.json()) as { parts?: any[]; info?: any }
    const out = extractText(msg.parts ?? [])
    stopTypingLoop(chat_id)
    await sendReply(chat_id, out || '(opencode returned no text)', { reply_to, thread: threadId })
  } catch (err) {
    stopTypingLoop(chat_id)
    await sendReply(chat_id, `⚠️ failed to reach opencode: ${err instanceof Error ? err.message : String(err)}`,
      { reply_to, thread: threadId })
  }
}

bot.on('message:text', async ctx => { await ingest(ctx, ctx.message.text) })
bot.on('message:photo', async ctx => {
  // Image understanding via file parts is a follow-up; for now forward the caption.
  await ingest(ctx, ctx.message.caption ?? '(photo — image input not yet wired)')
})
bot.on('message:document', async ctx => {
  await ingest(ctx, ctx.message.caption ?? `(document: ${ctx.message.document.file_name ?? 'file'} — file input not yet wired)`)
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
  const tool = p.tool?.callID ? ` (${p.permission})` : ''
  const body = `🔐 opencode wants permission${tool}:\n\`${String(p.permission).slice(0, 300)}\``
  const kb = new InlineKeyboard()
    .text('✅ once', `ocperm:once:${reqId}`).text('✅ always', `ocperm:always:${reqId}`).text('❌ reject', `ocperm:reject:${reqId}`)
  try {
    const sent = await bot.api.sendMessage(chat_id, body, { parse_mode: 'Markdown', reply_markup: kb })
    pendingPermissions.set(reqId, { chat_id, ses, message_id: sent.message_id })
  } catch (err) { process.stderr.write(`telegram-opencode: permission prompt failed: ${err}\n`) }
}

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''
  const m = data.match(/^ocperm:(once|always|reject):(.+)$/)
  if (!m) return
  const response = m[1] as 'once' | 'always' | 'reject'
  const reqId = m[2]!
  const senderId = String(ctx.from.id)
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
    case 'session.error': {
      const p = ev.properties ?? ev
      const chat_id = sessionToChat.get(String(p.sessionID ?? ''))
      if (chat_id) {
        stopTypingLoop(chat_id)
        const detail = p.error?.data?.message ?? p.error?.name ?? JSON.stringify(p.error ?? {}).slice(0, 300)
        await sendReply(chat_id, `⚠️ opencode error: ${detail}`)
      }
      break
    }
    // session.idle / heartbeat / deltas are observed for liveness but the text
    // reply is delivered from the awaited prompt POST, so nothing to do here.
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
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-opencode: polling as @${info.username}\n`)
          for (const scope of [undefined, { type: 'all_private_chats' as const }]) {
            void bot.api.setMyCommands(BOT_COMMANDS, scope ? { scope } : undefined).catch(err => {
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
