// DIVE-5419: the bridge, not the model, keeps the human posted for the rest of
// the turn after the ack.
//
// Before this, liveness after the ack was the MODEL's job: the silence
// watchdog re-fired every 5 calls / 60s and the model answered each nudge with
// an edit_message. Every forced call re-reads the whole conversation (~110k
// prompt tokens late in a session), so about 1 call in 10 of a working session
// went to "still here" (measured on main 2026-10-02, session b80088fe). The
// server already sees every inbound and every reply, so it can do the same job
// for zero model tokens:
//
//   - the ack is the agent's latest text reply since the turn began;
//   - on the typing loop's tick, at most once per STATUS_THROTTLE_MS, the
//     server edits that ack with one status line: the latest step's label
//     (written by hooks/status-label.ts on PreToolUse) and the turn's elapsed
//     time;
//   - when the turn ends, or a newer reply becomes the ack, the line is taken
//     back off, so no message is left saying "⏳ Running tests" forever.
//
// Pure state machine with the Bot API call injected, so the rules are testable
// without a bot (test/dive5419-typing-status.test.ts).

export type ParseMode = 'MarkdownV2'
export type StatusLabel = { at: number; label: string }

export type AckStatusDeps = {
  edit: (chatId: string, messageId: number, text: string, parseMode?: ParseMode) => Promise<unknown>
  // The newest step label, or null when none was ever written.
  readLabel: () => StatusLabel | null
  now?: () => number
  throttleMs?: number
}

type Ack = {
  messageId: number
  // What the message says WITHOUT our status line — the reply text, or the
  // model's own latest edit of it. Restoring means editing back to this.
  base: string
  parseMode?: ParseMode
  // The status line currently on the message, or null when it shows `base`.
  shown: string | null
}

type Turn = {
  startedAt: number
  ack: Ack | null
  lastEditAt: number
  inflight: Promise<unknown> | null
  // >0 while the model's own edit_message is in flight — never race it.
  held: number
}

export const STATUS_THROTTLE_MS = 30_000
// Telegram's text limit. A status that would push the ack past it is skipped,
// never truncating the agent's words to make room.
const MAX_TEXT = 4096
const STATUS_SEPARATOR = '\n\n'
// Used when no step label was written during this turn (the model is
// thinking, or the PreToolUse hook is absent on an older install).
export const FALLBACK_LABEL = 'Working'

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Minute granularity past the first minute is deliberate: the line then only
// changes when the step changes or a minute passes, so a long think costs at
// most one edit a minute, not one per throttle window.
export function statusLine(label: string, elapsedMs: number): string {
  return `⏳ ${label} · ${formatElapsed(elapsedMs)}`
}

function escapeMdv2(t: string): string {
  return t.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

export function withStatus(base: string, line: string, parseMode?: ParseMode): string {
  return `${base}${STATUS_SEPARATOR}${parseMode === 'MarkdownV2' ? escapeMdv2(line) : line}`
}

export function createAckStatus(deps: AckStatusDeps) {
  const now = deps.now ?? (() => Date.now())
  const throttle = deps.throttleMs ?? STATUS_THROTTLE_MS
  const turns = new Map<string, Turn>()

  // Take our line back off a message. Waits for any edit already in flight on
  // it first, or that edit could land AFTER the restore and leave the line up.
  function restore(chatId: string, ack: Ack, after: Promise<unknown> | null): Promise<void> {
    return (after ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (ack.shown === null) return
        ack.shown = null
        await deps.edit(chatId, ack.messageId, ack.base, ack.parseMode).catch(() => {})
      })
  }

  function endTurn(chatId: string): Promise<void> {
    const turn = turns.get(chatId)
    if (!turn) return Promise.resolve()
    turns.delete(chatId)
    return turn.ack ? restore(chatId, turn.ack, turn.inflight) : Promise.resolve()
  }

  return {
    hasTurn(chatId: string): boolean {
      return turns.has(chatId)
    },

    // An inbound (or a reply outside any turn) opened a turn for this chat.
    beginTurn(chatId: string): Promise<void> {
      const ended = endTurn(chatId)
      const t = now()
      turns.set(chatId, { startedAt: t, ack: null, lastEditAt: t, inflight: null, held: 0 })
      return ended
    },

    endTurn,

    // The agent sent a text reply. It becomes the ack; the previous ack gets
    // its line back off. A message carrying an inline keyboard is never a
    // target — editMessageText without reply_markup would strip its buttons.
    noteReply(chatId: string, messageId: number, text: string, parseMode?: ParseMode, hasKeyboard = false): void {
      const turn = turns.get(chatId)
      if (!turn) return
      const prev = turn.ack
      turn.ack = hasKeyboard || !text ? null : { messageId, base: text, parseMode, shown: null }
      turn.lastEditAt = now()
      if (prev) void restore(chatId, prev, turn.inflight)
    },

    // The model is about to edit a message itself. Wait out our own in-flight
    // edit so the two never cross, and pause ticks until afterEdit.
    async beforeEdit(chatId: string): Promise<void> {
      const turn = turns.get(chatId)
      if (!turn) return
      turn.held++
      await (turn.inflight ?? Promise.resolve()).catch(() => {})
    },

    // `text` is what the message now says, or null when the edit failed.
    afterEdit(chatId: string, messageId: number, text: string | null, parseMode?: ParseMode): void {
      const turn = turns.get(chatId)
      if (!turn) return
      if (turn.held > 0) turn.held--
      if (text === null) return
      turn.lastEditAt = now()
      if (turn.ack && turn.ack.messageId === messageId) {
        // The model's edit replaced our line along with everything else.
        turn.ack.base = text
        turn.ack.parseMode = parseMode
        turn.ack.shown = null
      }
    },

    // Called from the typing loop's tick. Returns the edit when one was sent.
    tick(chatId: string): Promise<unknown> | null {
      const turn = turns.get(chatId)
      if (!turn || !turn.ack || turn.held > 0 || turn.inflight) return null
      const t = now()
      if (t - turn.lastEditAt < throttle) return null
      const fresh = deps.readLabel()
      const label = fresh && fresh.at >= turn.startedAt ? fresh.label : FALLBACK_LABEL
      const line = statusLine(label, t - turn.startedAt)
      const ack = turn.ack
      if (line === ack.shown) return null
      const text = withStatus(ack.base, line, ack.parseMode)
      if (text.length > MAX_TEXT) return null
      turn.lastEditAt = t
      const p = deps
        .edit(chatId, ack.messageId, text, ack.parseMode)
        .then(() => {
          ack.shown = line
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (/not modified/i.test(msg)) ack.shown = line
          // Deleted, too old, or otherwise uneditable: stop targeting it.
          else if (/not found|can't be edited|cannot be edited/i.test(msg) && turn.ack === ack) turn.ack = null
        })
        .finally(() => {
          if (turn.inflight === p) turn.inflight = null
        })
      turn.inflight = p
      return p
    },
  }
}

export type AckStatus = ReturnType<typeof createAckStatus>
