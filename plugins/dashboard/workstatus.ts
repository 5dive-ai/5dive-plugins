// DIVE-6715: what the web chat shows while the agent works on a message —
// "working: Running the tests" — and when it stops showing it.
//
// Telegram keeps "typing…" up for the whole turn and puts the step on its ack
// (ackstatus.ts, DIVE-5419). The web chat only guessed "typing…" in the browser
// and dropped it at the agent's first message. Here the server, which knows when
// it handed a web-chat message to the session, owns the state:
//
//   inbound(chat)  a web-chat message went into the session → active, no label
//   label(l, at)   the status-label hook named the next step → forwarded, at most
//                  one post per minGap (the newest label wins)
//   ended(at)      the Stop / StopFailure hook ended the turn → inactive
//   tick()         flushes a held label, re-sends the live status every
//                  heartbeat (the app drops a status it has not heard for 5 min),
//                  and ends a turn that has been silent past the ceiling
//
// A label or an end stamped before the message went in belongs to an older turn
// and is ignored, so a Telegram or autonomous turn never shows up in the chat.
// Pure, clock injected, so the tests drive it without a session.

export type StatusPost = (chatId: string, active: boolean, label: string | null) => Promise<void>

export type WorkStatusOptions = {
  post: StatusPost
  now?: () => number
  minGapMs?: number
  heartbeatMs?: number
  ceilingMs?: number
}

export function makeWorkStatus(o: WorkStatusOptions) {
  const now = o.now ?? Date.now
  const minGap = o.minGapMs ?? 2_000
  const heartbeat = o.heartbeatMs ?? 60_000
  const ceiling = o.ceilingMs ?? 30 * 60_000
  let chat: string | null = null
  let since = 0
  let activity = 0
  let label: string | null = null
  let sentLabel: string | null | undefined
  let sentAt = 0

  const send = (active: boolean) => {
    if (!chat) return
    sentAt = now()
    sentLabel = active ? label : undefined
    void o.post(chat, active, active ? label : null).catch(() => {})
  }

  return {
    inbound(chatId: string): void {
      // A second message mid-turn keeps the turn (and its label) going.
      if (chat !== chatId) label = null
      if (chat === null) since = now()
      chat = chatId
      activity = now()
      sentLabel = undefined
      send(true)
    },
    label(next: string, at: number): void {
      if (!chat || at < since) return
      activity = now()
      label = next
      if (label !== sentLabel && now() - sentAt >= minGap) send(true)
    },
    ended(at: number): void {
      if (!chat || at < since) return
      send(false)
      chat = null
      label = null
    },
    tick(): void {
      if (!chat) return
      if (now() - activity > ceiling) {
        send(false)
        chat = null
        label = null
        return
      }
      if ((label !== sentLabel && now() - sentAt >= minGap) || now() - sentAt >= heartbeat) send(true)
    },
    active(): string | null {
      return chat
    },
  }
}
