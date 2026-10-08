// DIVE-5874: the agent's first message to a new owner is the result of the first
// job they picked at hire, not a greeting.
//
// WHY. At hire the owner taps one of three small jobs in the Mini App. The box runs
// it on the agent's own AI (`5dive agent first-job`, a detached unit) and writes the
// answer to STATE_DIR/first-reply.json; FiveDiveBot then sends the owner ONE notice
// with an "Open <Name>" button, t.me/<bot>?start=fj-<token>. This plugin answers
// that /start with the stored result in place of the greeting (one message, not
// two), and stamps first-reply.state.json so the API can tell the result was seen
// (startAt) and answered (secondAt) through `5dive agent first-job status`.
//
// The file is the hand-off: it stays until a send to the owner succeeds, so a 403
// (the owner never opened the bot) or any failed send keeps it for the next /start
// or poll. Pure decisions plus small file I/O here; server.ts long-polls Telegram on
// import, so the bot calls stay there and test/dive5874-first-reply.test.ts drives
// this module with a fake send.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GreetClaims } from './bootgreet.ts'

export const FIRST_REPLY_FILE = 'first-reply.json'
export const FIRST_REPLY_STATE_FILE = 'first-reply.state.json'
/** Telegram rejects a message over 4096 characters (UTF-16 units, as JS counts). */
export const TG_TEXT_LIMIT = 4096
/** How often the poll looks for a waiting result (contract: at most every 20 s). */
export const FIRST_REPLY_POLL_MS = 20_000
/** After a failed poll send (a 403: the bot is blocked), the poll rests this long. A /start still tries at once. */
export const FIRST_REPLY_POLL_BACKOFF_MS = 10 * 60_000

export type FirstReply = { token: string; text: string; at?: string }
export type FirstReplyState = { token: string; startAt: string; secondAt?: string }

/** The token the API minted: 22 chars of base64url today; accept a little either side. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

/** first-reply.json, or null when absent or not the CLI's shape. Never throws. */
export function readFirstReply(dir: string): FirstReply | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, FIRST_REPLY_FILE), 'utf8')) as Partial<FirstReply>
    if (typeof j?.token !== 'string' || !TOKEN_RE.test(j.token)) return null
    if (typeof j.text !== 'string' || !j.text.trim()) return null
    return { token: j.token, text: j.text, ...(typeof j.at === 'string' ? { at: j.at } : {}) }
  } catch {
    return null
  }
}

export function readFirstReplyState(dir: string): FirstReplyState | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, FIRST_REPLY_STATE_FILE), 'utf8')) as Partial<FirstReplyState>
    return typeof j?.token === 'string' && typeof j.startAt === 'string' ? (j as FirstReplyState) : null
  } catch {
    return null
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * The result went out: drop first-reply.json (only if it still holds the token we
 * sent, so a newer job written meanwhile survives) and record startAt for the CLI.
 */
export function consumeFirstReply(dir: string, token: string, now: Date = new Date()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeJsonAtomic(join(dir, FIRST_REPLY_STATE_FILE), { token, startAt: now.toISOString() } satisfies FirstReplyState)
  if (readFirstReply(dir)?.token === token) {
    try { unlinkSync(join(dir, FIRST_REPLY_FILE)) } catch {}
  }
}

/**
 * The owner's next message after the result: stamp secondAt once.
 * 'stamped' = written now; 'done' = already stamped (callers stop asking);
 * 'none' = no result was sent yet.
 */
export function stampSecond(dir: string, now: Date = new Date()): 'stamped' | 'done' | 'none' {
  const s = readFirstReplyState(dir)
  if (!s) return 'none'
  if (s.secondAt) return 'done'
  try {
    writeJsonAtomic(join(dir, FIRST_REPLY_STATE_FILE), { ...s, secondAt: now.toISOString() })
  } catch {
    return 'none'
  }
  return 'stamped'
}

/** The "Open <Name>" button's payload: /start fj-<token>. It never reaches the model. */
export function isFirstJobPayload(payload: string): boolean {
  return /^fj-[A-Za-z0-9_-]+$/.test(payload)
}

/**
 * Split at Telegram's limit, preferring a paragraph, then a line, then a space in
 * the second half of the window; never between the halves of a surrogate pair.
 */
export function splitForTelegram(text: string, limit = TG_TEXT_LIMIT): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    let cut = para > limit / 2 ? para : line > limit / 2 ? line : space > limit / 2 ? space : limit
    const c = rest.charCodeAt(cut - 1)
    if (cut === limit && c >= 0xd800 && c <= 0xdbff) cut--
    const part = rest.slice(0, cut).trimEnd()
    if (part) out.push(part)
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** Who may receive the result: owners (else the allowlist), private chats only. */
export function firstReplyOwners(access: { owners?: string[]; allowFrom: string[] }): string[] {
  return (access.owners ?? access.allowFrom).filter(id => access.allowFrom.includes(id) && /^[1-9]\d*$/.test(id))
}

/** The chat in last-human-chat.json (the owner has opened the bot), or null. */
export function lastHumanChatId(path: string): string | null {
  try {
    const id = (JSON.parse(readFileSync(path, 'utf8')) as { chatId?: unknown }).chatId
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null
  } catch {
    return null
  }
}

export type DeliverResult = 'none' | 'busy' | 'sent' | 'failed'

export type FirstReplier = {
  /** Send the waiting result to `chat` if it is an owner's DM. 'none' = nothing waits (or not an owner): greet as usual. */
  deliver(chat: string): Promise<DeliverResult>
  /** The poll's turn: deliver to the last human chat, unless resting after a failure. */
  poll(lastHumanChat: string | null): Promise<DeliverResult>
  /** Called on each inbound human message in `chat`. */
  noteInbound(chat: string): void
}

export function makeFirstReplier(o: {
  dir: string
  claims: GreetClaims
  owners: () => string[]
  send: (chat: string, text: string) => Promise<unknown>
  log?: (line: string) => void
  now?: () => number
}): FirstReplier {
  const now = o.now ?? Date.now
  let inFlight = false
  let restUntil = 0
  let secondDone = false
  const isOwner = (chat: string) => { try { return o.owners().includes(chat) } catch { return false } }

  async function deliver(chat: string): Promise<DeliverResult> {
    if (!existsSync(join(o.dir, FIRST_REPLY_FILE)) || !isOwner(chat)) return 'none'
    const fr = readFirstReply(o.dir)
    if (!fr) return 'none'
    // The poll and a /start can land together: one send.
    if (inFlight) return 'busy'
    inFlight = true
    // Under the greeting claim, so a /start queued behind this greets nobody. A
    // greeting already sent inside the window does not hold the result back: the
    // owner tapped "Open" for it.
    const took = o.claims.claim(chat)
    try {
      for (const part of splitForTelegram(fr.text)) await o.send(chat, part)
    } catch (err) {
      if (took) o.claims.release(chat)
      o.log?.(`telegram channel: first job result to ${chat} not sent (kept for the next /start): ${err instanceof Error ? err.message : String(err)}`)
      return 'failed'
    } finally {
      inFlight = false
    }
    try {
      consumeFirstReply(o.dir, fr.token, new Date(now()))
    } catch (err) {
      o.log?.(`telegram channel: first job result sent, state not written: ${err}`)
    }
    secondDone = false
    return 'sent'
  }

  return {
    deliver,
    async poll(lastHumanChat) {
      if (!lastHumanChat || now() < restUntil) return 'none'
      const r = await deliver(lastHumanChat)
      if (r === 'failed') restUntil = now() + FIRST_REPLY_POLL_BACKOFF_MS
      return r
    },
    noteInbound(chat) {
      if (secondDone || !isOwner(chat)) return
      if (stampSecond(o.dir, new Date(now())) !== 'none') secondDone = true
    },
  }
}
