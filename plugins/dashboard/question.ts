// DIVE-6715: the question an AskUserQuestion becomes in the web chat. The hook
// (hooks/pretool-question.ts) drops it in the notice outbox; the server sends
// it here as a reply whose metadata.question the app draws as buttons.

import type { ChatQuestion } from './hooks/lib/dashboard-chat.ts'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A question the buttons can carry, or null. Bounds match the relay's `ask` op. */
export function parseQuestion(x: unknown): ChatQuestion | null {
  const q = x as { id?: unknown; options?: unknown } | null
  if (!q || typeof q.id !== 'string' || !ID_RE.test(q.id) || !Array.isArray(q.options)) return null
  if (q.options.length < 2 || q.options.length > 10) return null
  const options: ChatQuestion['options'] = []
  for (const o of q.options as Array<{ label?: unknown; description?: unknown }>) {
    const label = typeof o?.label === 'string' ? o.label.trim() : ''
    if (!label || label.length > 120) return null
    const description = typeof o?.description === 'string' ? o.description.trim().slice(0, 200) : ''
    options.push(description ? { label, description } : { label })
  }
  return { id: q.id, options }
}

/** The relay's `ask` op: chat, text, id, then a label and a description per option. */
export function askRelayOp(chatId: string, text: string, q: ChatQuestion): string[] {
  return ['ask', chatId, text, q.id, ...q.options.flatMap(o => [o.label, o.description ?? ''])]
}

/**
 * The question as plain text, for a path that cannot carry buttons (a relay
 * from before the `ask` op). The person answers by typing a number or the
 * words, which the server resolves the same way as a tap.
 */
export function numberedText(text: string, q: ChatQuestion): string {
  const lines = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)
  return `${text}\n\n${lines.join('\n')}`
}
