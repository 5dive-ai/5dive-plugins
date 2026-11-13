// plugins/email/mail.ts — the pure half of the email channel (DIVE-8315).
//
// Node builtins only, so repo CI's bare `bun test` (no plugin dependencies
// installed) executes every decision here: threading, who the agent may mail
// without asking, the daily cap, what an inbound mail looks like to the agent,
// and the local-only rule. server.ts does the I/O (IMAP, SMTP, the maildir).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ── config ───────────────────────────────────────────────────────────────────
// ~/.claude/channels/email/config.json, 0600 and the agent's own, written by
// `sudo 5dive agent email connect`. The password arrives through a one-time
// secret link (or `secret write` at a terminal), never as an argument.
//
//   mode "imap"  — a mailbox the firm already runs (Google Workspace, Exchange,
//                  any IMAP+SMTP server): read over IMAP,
//                  send through the firm's own SMTP.
//   mode "local" — the box's own mail server (OpenAgent Mail, mailserver.ts):
//                  mail lands in a maildir the agent owns, and goes out through
//                  the server's submission port on 127.0.0.1.

export type Endpoint = { host: string; port: number; secure: boolean; user: string; pass: string }
export type Config = {
  address: string
  name?: string
  mode: 'imap' | 'local'
  imap?: Endpoint
  smtp: Endpoint
  maildir?: string
  /** true (default) = a mail to an address that never wrote to the agent waits for the owner's OK. */
  approve_new?: boolean
  /** Domains the agent mails without asking (default: its own address's domain — colleagues). */
  free_domains?: string[]
  /** Mails a day, all recipients counted once per mail (default 50). */
  daily_cap?: number
  poll_seconds?: number
}

const HOST_RX = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

function endpointOk(e: any): e is Endpoint {
  return !!e && typeof e.host === 'string' && HOST_RX.test(e.host) && Number.isInteger(e.port) && e.port > 0 && e.port < 65536
    && typeof e.secure === 'boolean' && typeof e.user === 'string' && typeof e.pass === 'string'
}

export function parseConfig(raw: unknown): Config | null {
  const c = raw && typeof raw === 'object' ? (raw as any) : null
  if (!c) return null
  if (!normAddr(c.address)) return null
  if (c.mode !== 'imap' && c.mode !== 'local') return null
  if (!endpointOk(c.smtp)) return null
  if (c.mode === 'imap' && !endpointOk(c.imap)) return null
  if (c.mode === 'local' && (typeof c.maildir !== 'string' || !c.maildir.startsWith('/'))) return null
  return { ...c, address: normAddr(c.address)! } as Config
}

// ── addresses ────────────────────────────────────────────────────────────────
const ADDR_RX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** A bare, lower-cased address, or null. Accepts "Name <a@b.c>". */
export function normAddr(s: unknown): string | null {
  if (typeof s !== 'string') return null
  let a = s.trim()
  const m = a.match(/<([^<>]+)>\s*$/)
  if (m) a = m[1]
  a = a.trim().toLowerCase()
  return a.length <= 254 && ADDR_RX.test(a) ? a : null
}

export const domainOf = (addr: string) => addr.slice(addr.lastIndexOf('@') + 1)

// ── threads ──────────────────────────────────────────────────────────────────
// A reply chain is ONE conversation: its chat_id is derived from the root
// Message-ID (the first id in References, else In-Reply-To, else the mail's
// own id), so every mail in the chain lands in the same chat.

const MID_RX = /<[^<>\s]+>/g
export function messageIds(s: unknown): string[] {
  if (Array.isArray(s)) return s.flatMap(messageIds)
  if (typeof s !== 'string') return []
  const ids = s.match(MID_RX)
  if (ids) return ids
  const t = s.trim()
  return t && !/\s/.test(t) ? [`<${t.replace(/^<|>$/g, '')}>`] : []
}

export function threadRoot(messageId: string | undefined, inReplyTo: unknown, references: unknown): string | null {
  const refs = messageIds(references)
  if (refs.length) return refs[0]
  const irt = messageIds(inReplyTo)
  if (irt.length) return irt[0]
  const own = messageIds(messageId)
  return own[0] ?? null
}

export const chatIdOf = (root: string) => 'm' + createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16)

export function replySubject(s: string | undefined): string {
  const t = (s ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!t) return 'Re: (no subject)'
  return /^(re|aw|sv|antw)\s*:/i.test(t) ? t : `Re: ${t}`
}

/** References for a reply: the chain so far plus the mail being answered, the
 *  newest 20 (RFC 5322 lets them grow; servers choke on very long headers). */
export function nextReferences(refs: string[], answering: string | undefined): string[] {
  const out = [...refs]
  if (answering && !out.includes(answering)) out.push(answering)
  return out.slice(-20)
}

// ── what the agent sees ──────────────────────────────────────────────────────
// The text the person wrote this time: the quoted history below an
// "On … wrote:" line or a block of "> " lines is cut (the agent has the
// earlier mails in this chat already), and the whole is capped.
export const MAX_TEXT = 12_000
export function freshText(text: string): string {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n')
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^On .{4,200} wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{8,}$/.test(l) && /^From:/i.test(lines[i + 1] ?? '')) { end = i; break }
    if (/^>/.test(l) && lines.slice(i).every(x => /^>/.test(x) || !x.trim())) { end = i; break }
  }
  let t = lines.slice(0, end).join('\n').trim()
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + '\n[… cut: the mail is longer]'
  return t
}

export type Inbound = {
  messageId: string
  from: { address: string; name: string }
  to: string[]
  cc: string[]
  subject: string
  text: string
  date: string
  files: string[]
}

/** The channel notification for one mail. Every field the agent sees about the
 *  sender comes from the headers; nothing marks the mail as trusted. */
export function renderInbound(m: Inbound, chatId: string, shortId: string, self: string): { content: string; meta: Record<string, string> } {
  const others = [...m.to, ...m.cc].filter(a => a !== self && a !== m.from.address)
  const head = [`Subject: ${m.subject || '(no subject)'}`]
  if (others.length) head.push(`Also to: ${others.slice(0, 10).join(', ')}${others.length > 10 ? ` (+${others.length - 10})` : ''}`)
  const body = freshText(m.text) || '(no text)'
  const content = `${head.join('\n')}\n\n${body}`
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: shortId,
    user: (m.from.name || m.from.address).replace(/[\r\n"]/g, ' ').slice(0, 80),
    user_id: m.from.address,
    subject: (m.subject || '').replace(/[\r\n"]/g, ' ').slice(0, 200),
    ts: m.date,
    sender_role: 'outside',
  }
  if (m.files.length) meta.file_path = m.files[0]
  if (m.files.length > 1) meta.more_files = m.files.slice(1).join(',')
  return { content, meta }
}

// ── state ────────────────────────────────────────────────────────────────────
export type Thread = { root: string; subject: string; last: string; refs: string[]; with: string; name: string; cc: string[]; at: string }
export type Held = { id: string; to: string[]; cc: string[]; subject: string; text: string; files: string[]; chat?: string; waiting: string[]; knocks: Record<string, number | null>; at: string }
export type State = {
  uid_validity?: string
  last_uid?: number
  seen: string[]
  threads: Record<string, Thread>
  /** Addresses that have mailed the agent: it may answer them without asking. */
  known: string[]
  /** Addresses the owner allowed (a knock answered Allow). */
  approved: string[]
  /** Addresses the owner said No to: mail to them is refused at once. */
  refused: string[]
  held: Record<string, Held>
  sent: { day: string; n: number }
}

export function emptyState(): State {
  return { seen: [], threads: {}, known: [], approved: [], refused: [], held: {}, sent: { day: '', n: 0 } }
}

export function readState(raw: any): State {
  const s = emptyState()
  if (!raw || typeof raw !== 'object') return s
  for (const k of ['seen', 'known', 'approved', 'refused'] as const) if (Array.isArray(raw[k])) s[k] = raw[k].filter((x: unknown) => typeof x === 'string')
  if (raw.threads && typeof raw.threads === 'object') s.threads = raw.threads
  if (raw.held && typeof raw.held === 'object') s.held = raw.held
  if (raw.sent && typeof raw.sent.day === 'string' && Number.isInteger(raw.sent.n)) s.sent = raw.sent
  if (typeof raw.uid_validity === 'string') s.uid_validity = raw.uid_validity
  if (Number.isInteger(raw.last_uid)) s.last_uid = raw.last_uid
  return s
}

const MAX_SEEN = 2000
const MAX_THREADS = 500
const MAX_KNOWN = 5000
export function trimState(s: State) {
  if (s.seen.length > MAX_SEEN) s.seen = s.seen.slice(-MAX_SEEN)
  if (s.known.length > MAX_KNOWN) s.known = s.known.slice(-MAX_KNOWN)
  const t = Object.entries(s.threads)
  if (t.length > MAX_THREADS) {
    t.sort((a, b) => a[1].at.localeCompare(b[1].at))
    for (const [id] of t.slice(0, t.length - MAX_THREADS)) delete s.threads[id]
  }
}

export function remember(list: string[], addr: string) {
  const i = list.indexOf(addr)
  if (i >= 0) list.splice(i, 1)
  list.push(addr)
}

// ── the send gate ────────────────────────────────────────────────────────────
// lodar 11-11/11-13: replies to people who wrote in go out freely (that is not
// cold mail). The first mail to a NEW address waits for one owner tap, after
// which the address joins the list. The owner can switch the tap off per agent
// (approve_new:false). Colleagues on the agent's own domain are not "outside".
// A No is remembered, and the daily cap holds either way.

export function freeDomains(cfg: Config): string[] {
  const d = Array.isArray(cfg.free_domains) ? cfg.free_domains : [domainOf(cfg.address)]
  return d.map(x => String(x).trim().toLowerCase()).filter(Boolean)
}

export type Gate = 'free' | 'ask' | 'refused'
export function gateFor(cfg: Config, s: State, addr: string): Gate {
  if (s.refused.includes(addr)) return 'refused'
  if (cfg.approve_new === false) return 'free'
  if (s.known.includes(addr) || s.approved.includes(addr)) return 'free'
  if (freeDomains(cfg).includes(domainOf(addr))) return 'free'
  return 'ask'
}

export const DEFAULT_CAP = 50
export function capLeft(cfg: Config, s: State, now = new Date()): number {
  const day = now.toISOString().slice(0, 10)
  const used = s.sent.day === day ? s.sent.n : 0
  const cap = Number.isInteger(cfg.daily_cap) && cfg.daily_cap! >= 0 ? cfg.daily_cap! : DEFAULT_CAP
  return cap - used
}
export function countSent(s: State, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  s.sent = s.sent.day === day ? { day, n: s.sent.n + 1 } : { day, n: 1 }
}

/** One held mail after an owner answer about `addr`: 'send' when nobody it
 *  waits on is left, 'drop' on a No, else 'wait'. */
export function afterAnswer(h: Held, addr: string, answer: 'allow' | 'admin' | 'no'): 'send' | 'drop' | 'wait' {
  if (!h.waiting.includes(addr)) return 'wait'
  if (answer === 'no') return 'drop'
  h.waiting = h.waiting.filter(a => a !== addr)
  return h.waiting.length ? 'wait' : 'send'
}

// ── local-only ───────────────────────────────────────────────────────────────
// A local-only box is fully offline. Mail stays allowed when the mail server
// is on the office network (a LAN address), because nothing then leaves the
// building. A cloud mailbox (Microsoft 365, Google) needs IT to open email
// alone: `sudo 5dive config local-only allow email`.

export function localOnlyPaths(env: Record<string, string | undefined> = process.env) {
  const flag = env.FIVE_LOCAL_ONLY_FILE || '/etc/5dive/local-only'
  const allow = env.FIVE_LOCAL_ONLY_ALLOW_FILE || join(dirname(flag), 'local-only.allow')
  return { flag, allow }
}

export function emailOpenedOffline(paths = localOnlyPaths()): boolean {
  if (!existsSync(paths.flag)) return true
  try {
    return readFileSync(paths.allow, 'utf8').split('\n').some(l => l.trim() === 'email')
  } catch {
    return false
  }
}

export function isPrivateAddress(ip: string): boolean {
  const a = ip.toLowerCase()
  if (a === '::1' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const p = v4.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
}

export const SHUT_LINE =
  "Email to an outside mail server is shut on this local-only box. A mail server on the office network works as it is; for Microsoft 365 or Google your IT opens email alone: sudo 5dive config local-only allow email"

/** May this box talk to a mail server at these resolved addresses? */
export function mayReach(addrs: string[], paths = localOnlyPaths()): boolean {
  if (emailOpenedOffline(paths)) return true
  return addrs.length > 0 && addrs.every(isPrivateAddress)
}

// ── the owner's tap: `sudo -n 5dive people knock file --channel=email …` ─────
// The same owner card Teams uses (DIVE-8036), on the address the agent wants to
// mail. Allow = the address joins the send list and the held mail goes out;
// No = the mail is dropped and the address stays refused. The CLI drops the
// answer into this agent's state dir as knocks/<kid>.json.

export function knockFileArgs(addr: string, name = ''): string[] | null {
  const a = normAddr(addr)
  if (!a || a.length > 120) return null
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  const args = ['5dive', 'people', 'knock', 'file', '--channel=email', `--sender=${a}`, `--email=${a}`]
  if (clean) args.push(`--name=${clean}`)
  args.push('--json')
  return args
}

export type Filed = { kid: string | null; status: 'pending' | 'denied' | 'allowed' | 'error'; why?: string }
export function knockFiled(stdout: string): Filed {
  let r: any = null
  try {
    r = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '')
  } catch {
    r = null
  }
  if (r?.ok === true) {
    const st = r.data?.status
    const kid = r.data?.id == null ? null : String(r.data.id)
    if ((st === 'pending' || st === 'denied') && kid && /^\d+$/.test(kid)) return { kid, status: st }
    if (st === 'allowed') return { kid, status: 'allowed' }
  }
  return { kid: null, status: 'error', why: r?.error?.message ? String(r.error.message) : 'no answer from 5dive' }
}

export type Answer = { id: string; sender: string; answer: 'allow' | 'admin' | 'no' }
export function parseAnswer(raw: unknown, file: string): Answer | null {
  const a = raw as any
  if (!a || typeof a !== 'object' || a.channel !== 'email') return null
  const id = String(a.id ?? '')
  const sender = normAddr(a.sender)
  if (!/^\d+$/.test(id) || `${id}.json` !== file || !sender) return null
  if (a.answer !== 'allow' && a.answer !== 'admin' && a.answer !== 'no') return null
  return { id, sender, answer: a.answer }
}
