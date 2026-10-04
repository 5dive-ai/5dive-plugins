// DIVE-5504 item 7: one sticky acknowledgement per Codex turn on Telegram.
//
// Claude's bridge acks a long job once and edits that message with progress;
// the Codex dispatcher path only showed "typing…" and then sent every message
// the model wrote, each one a phone notification. Here a turn that runs past
// ACK_DELAY_MS gets ONE silent message ("⏳ Working on it · running `npm test`
// · 40s"), edited in place as the dispatcher reports steps (edits never
// notify), and closed with the dispatcher's summary when the turn ends. A turn
// that answers inside the delay never shows an ack at all. The one
// notification is the turn's last answer (the dispatcher marks the rest
// silent).
//
// Pure apart from the injected I/O, so the timing is tested without a bot.

export const ACK_DELAY_MS = 8_000
/** Turns tracked at once; the oldest is dropped past this (never unbounded). */
const MAX_TURNS = 64

export type ProgressIO = {
  /** Send the ack silently; resolves its message id. */
  send(chatId: string, threadId: string | undefined, text: string): Promise<number>
  edit(chatId: string, messageId: number, text: string): Promise<void>
  now(): number
  later(fn: () => void, ms: number): void
}

type Turn = {
  chatId: string
  threadId?: string
  status: string
  startedAt: number
  ackId?: number
  sending?: Promise<number | undefined>
  done?: string
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function ackText(status: string, ms: number): string {
  const what = status && status !== 'starting' ? ` · ${status}` : ''
  return `⏳ Working on it${what} · ${elapsed(ms)}`
}

export class ProgressAcks {
  private turns = new Map<string, Turn>()
  constructor(private readonly io: ProgressIO) {}

  /** A progress event for <key> (chat:turn). The first one opens the turn. */
  progress(key: string, chatId: string, threadId: string | undefined, status: string): void {
    let t = this.turns.get(key)
    if (!t) {
      t = { chatId, threadId, status, startedAt: this.io.now() }
      this.turns.set(key, t)
      while (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value!)
      this.io.later(() => this.open(key), ACK_DELAY_MS)
      return
    }
    if (t.done) return
    t.status = status
    if (t.ackId != null) {
      void this.io.edit(t.chatId, t.ackId, ackText(t.status, this.io.now() - t.startedAt)).catch(() => {})
    } else if (this.io.now() - t.startedAt >= ACK_DELAY_MS) {
      this.open(key)
    }
  }

  /** The turn ended: close the ack with <summary>, or say nothing if none was shown. */
  done(key: string, summary: string): void {
    const t = this.turns.get(key)
    if (!t) return
    t.done = summary
    this.turns.delete(key)
    if (t.ackId != null) {
      void this.io.edit(t.chatId, t.ackId, summary).catch(() => {})
    } else if (t.sending) {
      void t.sending.then(id => id != null ? this.io.edit(t.chatId, id, summary) : undefined).catch(() => {})
    }
  }

  /** Whether <key> has a turn open (for tests and the log). */
  has(key: string): boolean { return this.turns.has(key) }

  private open(key: string): void {
    const t = this.turns.get(key)
    if (!t || t.done || t.ackId != null || t.sending) return
    t.sending = this.io.send(t.chatId, t.threadId, ackText(t.status, this.io.now() - t.startedAt))
      .then(id => { t.ackId = id; return id }, () => undefined)
  }
}
