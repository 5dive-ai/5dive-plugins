// DIVE-5368: what happens when the bot is added to a group, kept pure so it is
// tested without importing server.ts (which long-polls Telegram on import).
//
// The owner shares an agent from the Mini App ("Who can talk to {name}" →
// Add to a group, t.me/<bot>?startgroup=1). A group added by someone already in
// allowFrom is approved at once, mention-only, and the agent says hello. A group
// added by anyone else stays in `discovered` until it is approved, as before,
// and its join line points at the app instead of a dashboard or a terminal.
// A lite client's lines never name the platform and carry no emoji (DIVE-5121).

import type { Lang } from './hooks/lib/lite.ts'

type From = { id: number | string; is_bot?: boolean } | undefined

/** The adder is someone the bot already answers in private: approve the group. */
export function addedByOwner(allowFrom: readonly string[], from: From): boolean {
  if (!from || from.is_bot) return false
  return allowFrom.includes(String(from.id))
}

export const GROUP_STRINGS = {
  en: {
    hello: (name: string, username: string) =>
      `Hi, I'm ${name}. Mention me${username ? ` (@${username})` : ''} to ask something.`,
    waiting: (name: string) => `Hi, I'm ${name}. I'll stay quiet here until my owner lets this group in.`,
    privacy:
      'Heads-up: Telegram only shows me messages here that mention me or reply to me. ' +
      'To let me read every message, make me an admin of this group.',
  },
  ru: {
    hello: (name: string, username: string) =>
      `Привет, я ${name}. Упомяните меня${username ? ` (@${username})` : ''}, чтобы задать вопрос.`,
    waiting: (name: string) => `Привет, я ${name}. Я буду молчать здесь, пока владелец не разрешит эту группу.`,
    privacy:
      'Важно: Telegram показывает мне здесь только сообщения, где меня упомянули или ответили мне. ' +
      'Чтобы я видел все сообщения, сделайте меня администратором группы.',
  },
} as const

/** What a stranger who DMs a lite bot is told under dmPolicy=pairing: no code,
 *  the owner lets them in from the app. Said once; the reminder is silent. */
export const ASK_OWNER: Record<Lang, string> = {
  en: "Hi! I only talk with people my owner has let in. Ask them to let you in, then message me again.",
  ru: 'Привет! Я общаюсь только с теми, кого пустил мой владелец. Попросите его разрешить вам писать мне, а потом напишите снова.',
}

export type JoinInput = {
  lite: boolean
  lang: Lang
  /** The bot's display name (getMe first_name), else its username. */
  name: string
  username: string
  title: string
  chatId: string
  /** Approved just now because the owner added it. */
  approved: boolean
  /** Not approved and never announced: the one-time waiting line. */
  announce: boolean
  /** Non-admin with BotFather's Group Privacy on (DIVE-246). */
  privacyOn: boolean
  /** A 5dive host (the app exists); else the OSS /telegram:access pointer. */
  fivedive: boolean
}

export function groupJoinLines(i: JoinInput): string[] {
  const lines: string[] = []
  if (i.lite) {
    const s = GROUP_STRINGS[i.lang]
    if (i.approved) lines.push(s.hello(i.name, i.username))
    else if (i.announce) lines.push(s.waiting(i.name))
    if (i.privacyOn) lines.push(s.privacy)
    return lines
  }
  if (i.approved) lines.push(`👋 ${GROUP_STRINGS.en.hello(i.name, i.username)}`)
  else if (i.announce) {
    lines.push(
      `👋 Hi! I've been added to "${i.title}" — group id: ${i.chatId}. ` +
        (i.fivedive
          ? `I'll stay quiet until my owner approves this group in the 5dive app (the agent's settings → Who can talk to).`
          : `I'll stay quiet until this group is approved: run /telegram:access in the agent terminal.`),
    )
  }
  // DIVE-246, in plain words. Mention-only groups work with privacy on; this is
  // for the owner who wants the agent to read everything.
  if (i.privacyOn) {
    lines.push(
      `⚠️ ${GROUP_STRINGS.en.privacy} (Or turn Group Privacy off in @BotFather → Bot Settings, ` +
        `then remove me and add me back.)`,
    )
  }
  return lines
}
