// DIVE-6930: the owner lets someone talk to the agent from chat.
//
// The owner writes "let Masha in" in their own DM. The agent calls the
// `access_request` tool, which only PROPOSES: the plugin sends the owner a
// message with Allow / No (or, when it cannot tell who Masha is, Telegram's own
// "pick a person" button). Only a tap or a pick from a user in the owners
// record applies it, in plugin code. So text the agent reads elsewhere (an
// email, a web page, a group message) that says "add @x" gets at most a button
// in the owner's chat, never an add. Injection defence is the protocol, not a
// guard model (lodar).
//
// Who the person is comes from Telegram (a pending entry, the owner's pick, or
// getChat), never from the agent: a name the agent supplied could put "Masha"
// on a stranger's id.
//
// After an add, the server lifts Telegram's owner-only lock on a bot a manager
// made (`sudo 5dive agent _telegram_open`), the box's twin of the Mini App's
// Invite tap; access.json stays the gate either way.
//
// This module is the pure half: the button grammar, the request store, the
// owner check, the access.json edit and the strings. server.ts does the I/O.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import type { Lang } from './hooks/lib/lite.ts'

/** The slice of access.json this module reads and edits. */
export type AccessLike = {
  allowFrom: string[]
  owners?: string[]
  pending: Record<string, { senderId: string; chatId?: string; expiresAt: number; name?: string; username?: string }>
}

export type Person = { userId: string; name?: string; username?: string }

export type AccessRequest = {
  id: string
  op: 'add' | 'remove'
  /** absent: the owner picks the person (add) or the guest (remove) */
  person?: Person
  /** the request_id on the "pick a person" button, for an add with no person */
  pickId?: number
  /** a remove with no person: the guests its buttons named, in button order */
  guests?: string[]
  createdAt: number
  expiresAt: number
}

export type RequestStore = {
  requests: Record<string, AccessRequest>
  /** what Telegram said about people let in this way, for labels and "remove @x" */
  known: Record<string, { name?: string; username?: string }>
}

export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000
/** a cap on open asks, so an agent talked into a loop cannot flood the owner */
export const MAX_OPEN_REQUESTS = 5
/** guest buttons on a "who should I remove" message */
export const MAX_GUEST_BUTTONS = 8

// acc:<12 hex>:<y|n|g<idx>> — 20 bytes at most, well under Telegram's 64.
export const ACC_RE = /^acc:([0-9a-f]{12}):(y|n|g\d{1,2})$/
const ACC_PREFIX_RE = /^acc:/
const USER_ID_RE = /^[1-9]\d{0,19}$/
const HANDLE_RE = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/
/** "the person who just tried to write" */
const LAST_PENDING_RE = /^(|last|pending|latest|newest|recent)$/i

export type AccessTap = { id: string; verb: 'y' | 'n' | 'g'; idx?: number }

/** null: not ours. 'malformed': an acc: that is not the shape (still ours: it
 *  must never reach the generic bridge into the agent's session). */
export function parseAccessTap(data: string): AccessTap | 'malformed' | null {
  if (!ACC_PREFIX_RE.test(data)) return null
  const m = ACC_RE.exec(data)
  if (!m) return 'malformed'
  const v = m[2]!
  if (v[0] === 'g') return { id: m[1]!, verb: 'g', idx: Number(v.slice(1)) }
  return { id: m[1]!, verb: v as 'y' | 'n' }
}

export function newRequestId(): string {
  return randomBytes(6).toString('hex')
}

/** A request_id for Telegram's KeyboardButtonRequestUsers: a signed 32-bit int. */
export function newPickId(): number {
  return randomBytes(4).readUInt32BE(0) & 0x7fffffff || 1
}

// ── who decides ────────────────────────────────────────────────────────────────

/** The owners: the owners record within allowFrom (DIVE-5867). A box whose
 *  record is not written yet falls back to the first paired user, the same
 *  seed groupjoin.ts writes; never all of allowFrom (that is "who may DM"). */
export function ownerIds(a: Pick<AccessLike, 'allowFrom' | 'owners'>): string[] {
  const base = a.owners ?? a.allowFrom.slice(0, 1)
  return base.filter(id => a.allowFrom.includes(id))
}

export function isOwner(a: Pick<AccessLike, 'allowFrom' | 'owners'>, userId: string): boolean {
  return ownerIds(a).includes(userId)
}

/** People who may DM and are not owners: the ones a remove can name. */
export function guestIds(a: Pick<AccessLike, 'allowFrom' | 'owners'>): string[] {
  const owners = ownerIds(a)
  return a.allowFrom.filter(id => !owners.includes(id) && USER_ID_RE.test(id))
}

// ── who is meant ───────────────────────────────────────────────────────────────

export type Target =
  | { kind: 'person'; person: Person }
  /** a numeric id with nothing known about it: the server asks getChat */
  | { kind: 'id'; userId: string }
  /** a handle nobody here has seen: the owner picks the person */
  | { kind: 'unknown' }
  | { kind: 'invalid'; reason: string }

/** Resolve the agent's `who` against what Telegram already told this box.
 *  Never trusts a name from the agent. */
export function resolveTarget(who: string | undefined, a: AccessLike, known: RequestStore['known'], now: number): Target {
  const w = (who ?? '').trim()
  const live = Object.values(a.pending)
    .filter(p => p.expiresAt > now && USER_ID_RE.test(p.senderId))
  if (LAST_PENDING_RE.test(w)) {
    // the newest person who tried to write
    const p = live.sort((x, y) => y.expiresAt - x.expiresAt)[0]
    return p ? { kind: 'person', person: { userId: p.senderId, name: p.name, username: p.username } } : { kind: 'unknown' }
  }
  if (USER_ID_RE.test(w)) {
    const p = live.find(e => e.senderId === w)
    if (p) return { kind: 'person', person: { userId: w, name: p.name, username: p.username } }
    const k = known[w]
    if (k) return { kind: 'person', person: { userId: w, ...k } }
    return { kind: 'id', userId: w }
  }
  const h = HANDLE_RE.exec(w)
  if (!h) return { kind: 'invalid', reason: 'who must be an @username, a numeric Telegram id, or empty for the person who just tried to write' }
  const handle = h[1]!.toLowerCase()
  const p = live.find(e => e.username?.toLowerCase() === handle)
  if (p) return { kind: 'person', person: { userId: p.senderId, name: p.name, username: p.username } }
  for (const [id, k] of Object.entries(known)) {
    if (k.username?.toLowerCase() === handle) return { kind: 'person', person: { userId: id, ...k } }
  }
  return { kind: 'unknown' }
}

export function personLabel(p: Person): string {
  const name = (p.name ?? '').trim().slice(0, 64)
  if (name && p.username) return `${name} (@${p.username})`
  if (name) return name
  if (p.username) return `@${p.username}`
  return p.userId
}

// ── the edit ───────────────────────────────────────────────────────────────────

/** Let the person DM: the same write as `agent telegram-access set` plus
 *  `telegram-pending-ignore` (never `pair`: that makes an owner, DIVE-5368). */
export function applyAdd(a: AccessLike, userId: string): 'added' | 'already' {
  for (const [code, p] of Object.entries(a.pending)) if (p.senderId === userId) delete a.pending[code]
  if (a.allowFrom.includes(userId)) return 'already'
  a.allowFrom.push(userId)
  return 'added'
}

/** Stop the person DMing. An owner is never removed this way. */
export function applyRemove(a: AccessLike, userId: string): 'removed' | 'absent' | 'owner' {
  if (isOwner(a, userId)) return 'owner'
  const i = a.allowFrom.indexOf(userId)
  if (i < 0) return 'absent'
  a.allowFrom.splice(i, 1)
  return 'removed'
}

// ── a tap ──────────────────────────────────────────────────────────────────────

export type TapPlan =
  | { kind: 'not_owner' }
  | { kind: 'expired' }
  | { kind: 'decline' }
  | { kind: 'add'; person: Person }
  | { kind: 'remove'; person: Person }

/** What a tap does. The tapper is Telegram's from.id; the person comes from
 *  the stored request (or, for a guest button, the live allowFrom), never from
 *  the button's own text. */
export function planTap(
  tap: AccessTap,
  req: AccessRequest | undefined,
  a: AccessLike,
  known: RequestStore['known'],
  tapperId: string,
  now: number,
): TapPlan {
  if (!isOwner(a, tapperId)) return { kind: 'not_owner' }
  if (!req || req.expiresAt <= now) return { kind: 'expired' }
  if (tap.verb === 'n') return { kind: 'decline' }
  if (tap.verb === 'g') {
    if (req.op !== 'remove' || req.person) return { kind: 'expired' }
    // The id the button named when it was sent, and still a guest now.
    const id = req.guests?.[tap.idx ?? -1]
    if (!id || !guestIds(a).includes(id)) return { kind: 'expired' }
    return { kind: 'remove', person: { userId: id, ...known[id] } }
  }
  if (!req.person) return { kind: 'expired' }
  return req.op === 'add' ? { kind: 'add', person: req.person } : { kind: 'remove', person: req.person }
}

// ── the store ──────────────────────────────────────────────────────────────────

export function emptyStore(): RequestStore {
  return { requests: {}, known: {} }
}

export function readStore(file: string): RequestStore {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RequestStore>
    return { requests: raw.requests ?? {}, known: raw.known ?? {} }
  } catch {
    return emptyStore()
  }
}

export function writeStore(file: string, s: RequestStore): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function pruneStore(s: RequestStore, now: number): void {
  for (const [id, r] of Object.entries(s.requests)) if (r.expiresAt <= now) delete s.requests[id]
}

/** An open ask for the same thing, so asking twice sends one button. */
export function findOpen(s: RequestStore, op: AccessRequest['op'], userId: string | undefined, now: number): AccessRequest | undefined {
  return Object.values(s.requests).find(r => r.expiresAt > now && r.op === op && r.person?.userId === userId)
}

export function openCount(s: RequestStore, now: number): number {
  return Object.values(s.requests).filter(r => r.expiresAt > now).length
}

// ── strings ────────────────────────────────────────────────────────────────────
// Neutral and short; no word about the platform (a lite box shows these too).

export const ACCESS_STRINGS = {
  ru: {
    askAdd: (who: string) => `Разрешить писать мне: ${who}?`,
    askRemove: (who: string) => `Запретить писать мне: ${who}?`,
    askPick: 'Кому разрешить писать мне? Нажмите кнопку ниже и выберите человека.',
    askPickRemove: 'Кому запретить писать мне?',
    allow: 'Разрешить',
    remove: 'Запретить',
    no: 'Нет',
    pick: 'Выбрать человека',
    added: (who: string) => `Готово, теперь мне может писать: ${who}.`,
    addedMaybe: (who: string) => `Готово, теперь мне может писать: ${who}. Если не получится до меня достучаться, откройте в приложении экран «Кто может писать».`,
    already: (who: string) => `${who} уже может мне писать.`,
    removed: (who: string) => `Готово, мне больше не может писать: ${who}.`,
    absent: (who: string) => `${who} и так не может мне писать.`,
    ownerStays: 'Владельца так убрать нельзя.',
    declined: 'Хорошо, ничего не меняю.',
    notOwner: 'Это решает только владелец.',
    expired: 'Этот запрос устарел. Попросите ещё раз.',
    nobody: 'Сейчас никто, кроме владельца, не может мне писать.',
  },
  en: {
    askAdd: (who: string) => `Allow ${who} to write to me?`,
    askRemove: (who: string) => `Stop ${who} writing to me?`,
    askPick: 'Who should be able to write to me? Tap the button below and pick them.',
    askPickRemove: 'Who should stop writing to me?',
    allow: 'Allow',
    remove: 'Remove',
    no: 'No',
    pick: 'Choose a person',
    added: (who: string) => `Done: ${who} can write to me now.`,
    addedMaybe: (who: string) => `Done: ${who} can write to me now. If they can't reach me, open "Who can talk" in the app.`,
    already: (who: string) => `${who} can already write to me.`,
    removed: (who: string) => `Done: ${who} can no longer write to me.`,
    absent: (who: string) => `${who} couldn't write to me anyway.`,
    ownerStays: "An owner can't be removed this way.",
    declined: 'OK, nothing changed.',
    notOwner: 'Only the owner can decide this.',
    expired: 'This request has expired. Ask again.',
    nobody: 'Nobody but the owner can write to me right now.',
  },
} satisfies Record<Lang, Record<string, unknown>>

/** The note the agent gets after the owner decided: plugin-made, in English. */
export function agentNote(op: 'added' | 'already' | 'removed' | 'declined', p: Person | undefined, lockOpen: boolean | null): string {
  const who = p ? `${personLabel(p)} (Telegram id ${p.userId})` : 'the person'
  switch (op) {
    case 'added':
      return `[access] Your owner tapped Allow: ${who} can now write to you in a private chat.` +
        (lockOpen === false ? ' Telegram may still keep them out until the owner opens access in the app; the owner was told how.' : '') +
        ' If they wrote before, you can greet them in that chat; otherwise you will hear from them when they write.'
    case 'already':
      return `[access] Your owner tapped Allow, but ${who} could already write to you. Nothing changed.`
    case 'removed':
      return `[access] Your owner tapped Remove: ${who} can no longer write to you.`
    case 'declined':
      return '[access] Your owner tapped No on your access request. Nothing changed.'
  }
}
