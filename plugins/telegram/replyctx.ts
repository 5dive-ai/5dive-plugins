// DIVE-7429 (box report 601): what a forward, a reply or a quote points at.
// Without these keys the agent saw only the owner's own words — it could not
// tell who wrote a forwarded text, which message a reply was aimed at, or what
// was quoted, and guessed.
//
// Every value here is text someone else controls: a forwarded sender picks
// their own display name, a preview is another person's message. They ride in
// META (rendered as attributes on the <channel> tag), so each one is flattened
// to a single line with `"` `<` `>` and control characters removed — a crafted
// name must not close the attribute and forge via="button", image_path or user.
// Pure: no bot, no I/O, so test/dive7429-reply-context.test.ts imports it
// directly (server.ts long-polls Telegram on import).
import type { Message, MessageOrigin } from 'grammy/types'

export const NAME_MAX = 64
export const PREVIEW_MAX = 120
export const QUOTE_MAX = 300

// C0/C1 controls, line/paragraph separators, and the bidi overrides that can
// make a name read differently from what it is.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069"<>]/g

export function sanitizeMetaValue(s: string | undefined | null, max: number): string | undefined {
  if (s == null) return undefined
  const flat = String(s).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  const chars = [...flat]
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : flat
}

type User = { id: number; username?: string; first_name?: string; last_name?: string }

function userLabel(u: User | undefined): string | undefined {
  if (!u) return undefined
  if (u.username) return '@' + u.username
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return full || String(u.id)
}

type Origin = { kind: 'user' | 'hidden_user' | 'chat' | 'channel'; name: string | undefined }

function originOf(o: MessageOrigin): Origin {
  switch (o.type) {
    case 'user':
      return { kind: 'user', name: userLabel(o.sender_user) }
    case 'hidden_user':
      return { kind: 'hidden_user', name: o.sender_user_name }
    case 'chat': {
      const title = o.sender_chat.title ?? userLabel(o.sender_chat as unknown as User)
      return { kind: 'chat', name: o.author_signature ? `${title} (${o.author_signature})` : title }
    }
    case 'channel': {
      const title = o.chat.title ?? (o.chat.username ? '@' + o.chat.username : undefined)
      return { kind: 'channel', name: o.author_signature ? `${title} (${o.author_signature})` : title }
    }
  }
}

// A reply to a sticker or a captionless photo still deserves a hint of what it was.
function previewOf(m: Partial<Message>): string | undefined {
  const t = m.text ?? m.caption
  if (t) return t
  if (m.photo) return '[photo]'
  if (m.voice) return '[voice]'
  if (m.video) return '[video]'
  if (m.video_note) return '[video note]'
  if (m.audio) return '[audio]'
  if (m.sticker) return `[sticker${m.sticker.emoji ? ' ' + m.sticker.emoji : ''}]`
  if (m.document) return '[document]'
  return undefined
}

export function replyContextMeta(
  msg: Partial<Message> | undefined,
  botId: string | number | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!msg) return out
  const put = (k: string, v: string | undefined, max: number) => {
    const s = sanitizeMetaValue(v, max)
    if (s) out[k] = s
  }

  if (msg.forward_origin) {
    const o = originOf(msg.forward_origin)
    put('forward_from', o.name ?? (o.kind === 'hidden_user' ? 'hidden user' : undefined), NAME_MAX)
    out.forward_from_kind = o.kind
    if (msg.forward_origin.date) out.forward_date = new Date(msg.forward_origin.date * 1000).toISOString()
  }

  const r = msg.reply_to_message
  // Inside a forum topic Telegram sets reply_to_message to the topic's
  // "topic created" service message on EVERY post; that is not a reply.
  if (r && !r.forum_topic_created) {
    out.reply_to_message_id = String(r.message_id)
    const self = botId != null && r.from != null && String(r.from.id) === String(botId)
    put('reply_to_from', self ? 'bot' : (r.from ? (r.from.username ?? String(r.from.id)) : r.sender_chat?.title), NAME_MAX)
    put('reply_to_preview', previewOf(r), PREVIEW_MAX)
  } else if (msg.external_reply) {
    const x = msg.external_reply
    if (x.message_id != null) out.reply_to_message_id = String(x.message_id)
    put('reply_to_from', originOf(x.origin).name, NAME_MAX)
    put('reply_to_preview', previewOf(x as Partial<Message>), PREVIEW_MAX)
  }

  if (msg.quote?.text) put('quote_text', msg.quote.text, QUOTE_MAX)
  return out
}
