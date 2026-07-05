// DIVE-1028: bounded, per-chat rolling message log so an agent can recover
// recent Telegram context after a restart. The Bot API exposes NO history or
// search — after a session reset the agent is blind to earlier messages and
// otherwise has to ask the human to re-paste context. The plugin already SEES
// every inbound as it arrives (and every reply it sends), so we persist a
// bounded rolling window per chat to a local JSONL store and expose a lookup
// (the `recent_messages` MCP tool).
//
// Privacy posture: LOCAL ONLY (under the plugin state dir, mode 0600), per-chat,
// bounded/rotated to a fixed cap — never a durable archive, never uploaded, and
// never wider than what the live process already handles in memory. Secret
// values never reach here: credential-gate / permission / login-code inbounds
// return before the relay point, and secrets never transit the reply tool.
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Rolling window kept per chat, and per-message body cap (bounds file size so a
// pasted wall of text can't blow up the store). Both are generous enough to
// recover a working conversation, small enough to stay a cache not an archive.
export const MSGLOG_MAX_PER_CHAT = 200
export const MSGLOG_MAX_TEXT = 2000

export interface LoggedMessage {
  ts: string // ISO 8601
  dir: 'in' | 'out' // inbound (human/peer) vs a reply we sent
  user: string // sender username / our agent name
  text: string
  message_id?: string
  thread_id?: string
}

// chat_id → log filename. chat_ids are numeric (DMs) or '-100…' (supergroups);
// strip anything unexpected so a crafted id can never escape the log dir.
export function chatLogFile(dir: string, chatId: string): string {
  const safe = String(chatId).replace(/[^0-9-]/g, '') || 'unknown'
  return join(dir, `${safe}.jsonl`)
}

export function clampText(s: string): string {
  const t = s ?? ''
  return t.length <= MSGLOG_MAX_TEXT ? t : t.slice(0, MSGLOG_MAX_TEXT) + '…'
}

export function readMessages(dir: string, chatId: string): LoggedMessage[] {
  try {
    return readFileSync(chatLogFile(dir, chatId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l) as LoggedMessage
        } catch {
          return null // tolerate a torn/partial line, never throw
        }
      })
      .filter((x): x is LoggedMessage => x != null)
  } catch {
    return [] // no log yet, or unreadable — treated as empty
  }
}

// Append + rotate atomically: read the (bounded) existing log, push the new
// entry, trim to the last `cap`, write via tmp+rename. The file stays bounded
// so the read-modify-write is cheap. Best-effort — a lost write must never
// block message handling, so callers wrap this and swallow.
export function appendMessage(
  dir: string,
  chatId: string,
  entry: LoggedMessage,
  opts?: { maxPerChat?: number },
): void {
  const cap = Math.max(1, opts?.maxPerChat ?? MSGLOG_MAX_PER_CHAT)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const rows = readMessages(dir, chatId)
  rows.push({ ...entry, text: clampText(entry.text) })
  const body = rows.slice(-cap).map(r => JSON.stringify(r)).join('\n') + '\n'
  const file = chatLogFile(dir, chatId)
  const tmp = file + '.tmp'
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, file)
}

export function listChatIds(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6))
  } catch {
    return []
  }
}

// The chat whose most recent message is newest — the sensible default target
// when an agent recovering after a restart doesn't yet have a chat_id in hand.
export function mostRecentChatId(dir: string): string | undefined {
  let best: { id: string; ts: string } | undefined
  for (const id of listChatIds(dir)) {
    const rows = readMessages(dir, id)
    const last = rows[rows.length - 1]
    if (last && (!best || last.ts > best.ts)) best = { id, ts: last.ts }
  }
  return best?.id
}

// Render the last `limit` messages for a chat as a compact transcript for the
// tool result. Outbound lines are marked with → so the agent can tell its own
// replies apart from inbound.
export function formatRecent(rows: LoggedMessage[], limit: number): string {
  const slice = rows.slice(-Math.max(1, limit))
  if (!slice.length) return '(no recorded messages for this chat yet)'
  return slice
    .map(r => `[${r.ts}] ${r.dir === 'out' ? '→ ' : ''}${r.user}: ${r.text}`)
    .join('\n')
}
