// DIVE-8036 (DIVE-8032 B) — a new person knocks; the owner lets them in.
//
// A Teams connection whose config says `access: "knock"` holds a message from
// anyone who is not on its `allowed_users` (and not an admin in the box's roles
// file). Nothing of it reaches the agent. The server keeps the message in its
// own state and runs `sudo -n 5dive people knock file …`, which pages the owner
// on Telegram with Allow / Admin / No. The CLI writes the owner's answer into
// this agent's teams state dir as `knocks/<kid>.json`; the server watches that
// dir and, on allow/admin, delivers the held message as a normal inbound and
// tells the person they are in; on no, it says once, politely, that the agent is
// not open to them, then stays quiet (at most DENY_LINES_PER_DAY lines a day).
//
// A config with no `access` key keeps today's behaviour: allowed_users, when
// set, still silently refuses; when empty, the whole tenant may write.
//
// This module is the pure half (the policy, the held-message store, the answer
// file, the lines) plus the two I/O steps with their effects injected, so the
// suite drives it without Teams or sudo. server.ts does the wiring.

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Roles } from './roles.ts'

export type Access = { access?: string; allowed_users?: string[] }

/** The access part of config.json, read fresh: `people sync` rewrites it while the server runs. */
export function readAccess(configPath: string): Access {
  try {
    const c = JSON.parse(readFileSync(configPath, 'utf8'))
    return {
      access: typeof c.access === 'string' ? c.access : undefined,
      allowed_users: Array.isArray(c.allowed_users) ? c.allowed_users.filter((s: unknown) => typeof s === 'string') : undefined,
    }
  } catch {
    return {}
  }
}

export const isKnockMode = (a: Access) => a.access === 'knock'

/** In knock mode: may this Entra id talk to the agent without asking? An id on
 *  allowed_users, or an admin named in the roles file (never "check off": that
 *  switch is about risky asks, not about who may write). */
export function mayTalk(a: Access, roles: Roles, userId: string): boolean {
  const id = String(userId).trim().toLowerCase()
  if (!id) return false
  if ((a.allowed_users ?? []).some(u => u.trim().toLowerCase() === id)) return true
  return roles.admins.includes(`teams:${id}`)
}

/** The one question server.ts asks of every inbound: hold it for the owner? */
export function needsKnock(a: Access, roles: Roles, userId: string): boolean {
  return isKnockMode(a) && !mayTalk(a, roles, userId)
}

// ── held messages ────────────────────────────────────────────────────────────

export type HeldItem = { text: string; meta: Record<string, string> }
// serviceUrl/chatType: where to answer the person. A held chat is NOT in the server's
// conversations map, so the agent cannot reply into it before the owner says yes.
export type Held = { conv: string; serviceUrl: string; chatType: string; sender: string; name: string; items: HeldItem[]; at: string }
export type Denied = { day: string; lines: number }
export type KnockState = { held: Record<string, Held>; denied: Record<string, Denied> }

/** A held message's text is capped; a person writing a book before they are let in keeps the start. */
export const MAX_HELD_TEXT = 4000
/** The newest few messages per knock; older ones drop (the owner sees one card either way). */
export const MAX_HELD_ITEMS = 5
/** Knocks the server remembers at once (the CLI caps pending ones per agent at 5). */
export const MAX_HELD_KNOCKS = 20
export const DENY_LINES_PER_DAY = 3

export function emptyKnockState(): KnockState {
  return { held: {}, denied: {} }
}

export function readKnockState(raw: any): KnockState {
  const s = emptyKnockState()
  if (raw && typeof raw === 'object') {
    if (raw.held && typeof raw.held === 'object') s.held = raw.held
    if (raw.denied && typeof raw.denied === 'object') s.denied = raw.denied
  }
  return s
}

/** Keep a message under its knock. Returns true when this is the knock's first message (say "waiting" once). */
export function hold(ks: KnockState, kid: string, h: Omit<Held, 'items' | 'at'>, item: HeldItem, now = new Date()): boolean {
  const cur = ks.held[kid]
  const it = { text: item.text.slice(0, MAX_HELD_TEXT), meta: item.meta }
  if (cur) {
    cur.items.push(it)
    if (cur.items.length > MAX_HELD_ITEMS) cur.items.splice(0, cur.items.length - MAX_HELD_ITEMS)
    cur.conv = h.conv
    cur.serviceUrl = h.serviceUrl
    cur.chatType = h.chatType
    return false
  }
  ks.held[kid] = { ...h, items: [it], at: now.toISOString() }
  const ids = Object.keys(ks.held)
  if (ids.length > MAX_HELD_KNOCKS) {
    ids.sort((x, y) => ks.held[x]!.at.localeCompare(ks.held[y]!.at))
    for (const id of ids.slice(0, ids.length - MAX_HELD_KNOCKS)) delete ks.held[id]
  }
  return true
}

/** May the "not open to you" line go to this sender now? Counts it when yes. */
export function denyLineAllowed(ks: KnockState, sender: string, now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10)
  const key = sender.toLowerCase()
  const d = ks.denied[key]
  if (!d || d.day !== day) {
    ks.denied[key] = { day, lines: 1 }
    return true
  }
  if (d.lines >= DENY_LINES_PER_DAY) return false
  d.lines += 1
  return true
}

// ── the lines a person sees ─────────────────────────────────────────────────

export const shownName = (agent: string) => (agent ? agent[0]!.toUpperCase() + agent.slice(1) : 'This agent')
export const WAITING_LINE = (agent: string) => `I've asked the owner to let you talk to ${shownName(agent)}. Your message waits until they do.`
export const IN_LINE = (agent: string) => `You're in — ${shownName(agent)} will answer here.`
export const NOT_OPEN_LINE = (agent: string) => `${shownName(agent)} isn't open to you — ask your admin.`

// ── filing: `sudo -n 5dive people knock file …` ─────────────────────────────

const ENTRA_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Never looser than the box (cmd_people.sh _people_check_email, <=120 chars):
// an address it refuses would refuse the whole knock.
const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

/** The sender's email, from the tenant's own member record (Bot Connector
 *  GET conversations/{id}/members/{aadObjectId}, what TeamsInfo.getMember
 *  reads) — never from the message. Only a record for THIS sender counts:
 *  its aadObjectId must be the knocking id. `email` first, then the UPN
 *  when it has an email's shape. Anything else is '' (the knock files
 *  without an email and the box makes a fresh person, as before). */
export function memberEmail(member: unknown, sender: string): string {
  const m = member as Record<string, unknown> | null
  if (!m || typeof m !== 'object') return ''
  if (String(m.aadObjectId ?? '').toLowerCase() !== sender.toLowerCase()) return ''
  for (const v of [m.email, m.userPrincipalName]) {
    const e = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (e.length <= 120 && EMAIL_RE.test(e)) return e
  }
  return ''
}

/** The argv after `sudo -n`. The seat is the agent (the CLI reads it from
 *  SUDO_UID, never from argv), so no --agent. Shaped to match the seat's
 *  sudoers line `/usr/local/bin/5dive people knock file *`. `email` is the
 *  tenant's address for the sender (memberEmail), so the box can bind the
 *  knock to a person the owner added by email (DIVE-8032). */
export function knockFileArgs(sender: string, name: string, email = ''): string[] | null {
  if (!ENTRA_RE.test(sender)) return null
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  const args = ['5dive', 'people', 'knock', 'file', '--channel=teams', `--sender=${sender.toLowerCase()}`]
  if (clean) args.push(`--name=${clean}`)
  const mail = email.trim().toLowerCase()
  if (mail.length <= 120 && EMAIL_RE.test(mail)) args.push(`--email=${mail}`)
  args.push('--json')
  return args
}

export type Filed = { kid: string | null; status: 'pending' | 'denied' | 'allowed' | 'error'; why?: string }

/** The CLI's answer: {ok, data:{id, status, carded, human}}; a refusal {ok:false, error:{message}}. */
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

// ── the owner's answer: knocks/<kid>.json ───────────────────────────────────

export type Answer = { id: string; sender: string; answer: 'allow' | 'admin' | 'no' }

/** The CLI's answer file, or null for anything that is not one. */
export function parseAnswer(raw: string): Answer | null {
  let a: any
  try {
    a = JSON.parse(raw)
  } catch {
    return null
  }
  if (!a || typeof a !== 'object' || a.channel !== 'teams') return null
  const id = String(a.id ?? '')
  const sender = String(a.sender ?? '').toLowerCase()
  if (!/^\d+$/.test(id) || !ENTRA_RE.test(sender)) return null
  if (a.answer !== 'allow' && a.answer !== 'admin' && a.answer !== 'no') return null
  return { id, sender, answer: a.answer }
}

export type AnswerIO = {
  /** the held message, delivered as a normal inbound (the server opens the chat to the agent first) */
  deliver: (item: HeldItem, where: Where) => void
  /** one line to the person, in the chat they wrote from */
  say: (where: Where, text: string) => Promise<void>
  save: () => void
  log: (line: string) => void
}

export type Where = { conv: string; serviceUrl: string; chatType: string }

/** Apply every answer file in dir. Each file is read once and removed; one
 *  that matches no held knock (already applied, or the server restarted
 *  before it held anything) is dropped too. Returns how many were applied. */
export async function applyAnswers(dir: string, ks: KnockState, agent: string, io: AnswerIO, now = new Date()): Promise<number> {
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n))
  } catch {
    return 0
  }
  let applied = 0
  for (const n of names) {
    const path = join(dir, n)
    let raw = ''
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    try {
      rmSync(path, { force: true })
    } catch {}
    const a = parseAnswer(raw)
    if (!a || `${a.id}.json` !== n) {
      io.log(`knock answer ${n} unreadable: dropped`)
      continue
    }
    const h = ks.held[a.id]
    if (!h || h.sender.toLowerCase() !== a.sender) {
      io.log(`knock answer ${n} matches nothing held: dropped`)
      continue
    }
    delete ks.held[a.id]
    io.save()
    applied++
    if (a.answer === 'no') {
      if (denyLineAllowed(ks, a.sender, now)) await io.say(h, NOT_OPEN_LINE(agent)).catch(() => {})
      io.save()
      io.log(`knock ${a.id}: no — ${h.items.length} held message(s) dropped`)
      continue
    }
    await io.say(h, IN_LINE(agent)).catch(() => {})
    for (const item of h.items) io.deliver(item, h)
    io.log(`knock ${a.id}: ${a.answer} — ${h.items.length} held message(s) delivered`)
  }
  return applied
}

export type HoldIO = {
  /** `sudo -n <args>`: resolves with stdout, a refusal's envelope included */
  run: (args: string[]) => Promise<string>
  /** the sender's member record from the tenant (Bot Connector), or null; never throws */
  member?: (where: Where, sender: string) => Promise<unknown>
  say: (where: Where, text: string) => Promise<void>
  deliver: (item: HeldItem, where: Where) => void
  save: () => void
  log: (line: string) => void
}

/** A message from someone who may not talk to the agent yet. Never reaches the
 *  agent unless the CLI says the person is already allowed (a race with an
 *  answer, or the owner added them from the app). */
export async function onStranger(ks: KnockState, agent: string, where: Where, sender: string, name: string, item: HeldItem, io: HoldIO, now = new Date()): Promise<Filed['status']> {
  if (!ENTRA_RE.test(sender)) {
    io.log(`knock: sender ${sender.slice(0, 12)} is not an Entra id; refused`)
    return 'error'
  }
  const email = io.member ? memberEmail(await io.member(where, sender).catch(() => null), sender) : ''
  const args = knockFileArgs(sender, name, email)
  if (!args) {
    io.log(`knock: sender ${sender.slice(0, 12)} is not an Entra id; refused`)
    return 'error'
  }
  const f = knockFiled(await io.run(args))
  if (f.status === 'allowed') {
    io.deliver(item, where)
    return f.status
  }
  if (f.status === 'denied') {
    if (denyLineAllowed(ks, sender, now)) await io.say(where, NOT_OPEN_LINE(agent)).catch(() => {})
    io.save()
    return f.status
  }
  if (f.status === 'error') {
    // Not filed (the cap, an old CLI, no sudo grant): held nowhere, said nothing.
    // The owner can still add the person from the app; a later message knocks again.
    io.log(`knock: not filed for ${sender.slice(0, 12)}: ${f.why}`)
    return f.status
  }
  const first = hold(ks, f.kid!, { ...where, sender: sender.toLowerCase(), name }, item, now)
  io.save()
  if (first) await io.say(where, WAITING_LINE(agent)).catch(() => {})
  return f.status
}
