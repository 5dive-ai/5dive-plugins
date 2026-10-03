// DIVE-5368: what happens when the bot is added to a group, kept pure so it is
// tested without importing server.ts (which long-polls Telegram on import).
//
// The owner shares an agent from the Mini App ("Who can talk to {name}" →
// Add to a group, t.me/<bot>?startgroup=1). A group added by an OWNER is
// approved at once, mention-only, and the agent says hello. A group added by
// anyone else stays in `discovered` until it is approved, as before, and its
// join line points at the app instead of a dashboard or a terminal.
// A lite client's lines never name the platform and carry no emoji (DIVE-5121).
//
// Owner is NOT "in allowFrom": the app approves guests into allowFrom so they can
// DM the agent, and a guest must not be able to put the agent, on the owner's
// account, into a group of people the owner never saw (quinn, DIVE-5368 iter 1).
// `access.owners` is the plugin's own record: ids paired through the owner-level
// paths (`agent pair`, the /telegram:access skill), which both drop
// approved/<id>; the app's guest approve never does. `telegram-access set`
// rewrites only dmPolicy/allowFrom/groups, so the record survives the app.

import type { Lang } from './hooks/lib/lite.ts'

type From = { id: number | string; is_bot?: boolean } | undefined

const USER_ID = /^\d+$/

/** The adder is a recorded owner the bot still answers: approve the group.
 *  No record yet (`owners` undefined) → nobody is the owner: the group waits. */
export function addedByOwner(owners: readonly string[] | undefined, allowFrom: readonly string[], from: From): boolean {
  if (!from || from.is_bot || !owners) return false
  const id = String(from.id)
  return owners.includes(id) && allowFrom.includes(id)
}

/** The join's decision, on the handler's copy of access: an owner's add puts
 *  the group in `groups` mention-only; any other add leaves it only in
 *  `discovered` (written by the handler before this), waiting for approval. */
export function admitOnJoin(
  access: { owners?: string[]; allowFrom: string[]; groups: Record<string, unknown> },
  chatId: string,
  from: From,
): boolean {
  const approved = !(chatId in access.groups) && addedByOwner(access.owners, access.allowFrom, from)
  if (approved) access.groups[chatId] = { requireMention: true, allowFrom: [] }
  return approved
}

/**
 * The owners record after one pass, or null when it is unchanged.
 * First sight seeds it from allowFrom: every id there came in through an
 * owner-level pairing, because the app refuses a guest approve until this
 * record exists (it is the app's proof the plugin can tell the two apart).
 * Then each id paired since (an approved/<id> file) is added.
 */
export function nextOwners(cur: readonly string[] | undefined, allowFrom: readonly string[], paired: readonly string[]): string[] | null {
  const next = cur ? [...cur] : allowFrom.filter((id) => USER_ID.test(id))
  for (const id of paired) if (USER_ID.test(id) && !next.includes(id)) next.push(id)
  return cur && next.length === cur.length ? null : next
}

export const GROUP_STRINGS = {
  en: {
    // DIVE-5454: `replyOnly` = a non-admin bot with Group Privacy on. Telegram never
    // passes it a mention (measured 2026-10-03: topic, General, plain group), only
    // replies to its own messages and /cmd@bot. So "mention me" would be a promise
    // the bot cannot keep.
    hello: (name: string, username: string, replyOnly = false) =>
      replyOnly
        ? `Hi, I'm ${name}. Reply to one of my messages to ask something.`
        : `Hi, I'm ${name}. Mention me${username ? ` (@${username})` : ''} to ask something.`,
    waiting: (name: string) => `Hi, I'm ${name}. I'll stay quiet here until my owner lets this group in.`,
    privacy:
      'Heads-up: Telegram only passes me replies to my own messages here, not mentions. ' +
      'To answer when someone mentions me, make me an admin of this group.',
  },
  ru: {
    hello: (name: string, username: string, replyOnly = false) =>
      replyOnly
        ? `Привет, я ${name}. Чтобы задать вопрос, ответьте на одно из моих сообщений.`
        : `Привет, я ${name}. Упомяните меня${username ? ` (@${username})` : ''}, чтобы задать вопрос.`,
    waiting: (name: string) => `Привет, я ${name}. Я буду молчать здесь, пока владелец не разрешит эту группу.`,
    privacy:
      'Важно: Telegram передаёт мне здесь только ответы на мои сообщения, а не упоминания. ' +
      'Чтобы я отвечал на упоминания, сделайте меня администратором группы.',
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
    if (i.approved) lines.push(s.hello(i.name, i.username, i.privacyOn))
    else if (i.announce) lines.push(s.waiting(i.name))
    if (i.privacyOn) lines.push(s.privacy)
    return lines
  }
  if (i.approved) lines.push(`👋 ${GROUP_STRINGS.en.hello(i.name, i.username, i.privacyOn)}`)
  else if (i.announce) {
    lines.push(
      `👋 Hi! I've been added to "${i.title}" — group id: ${i.chatId}. ` +
        (i.fivedive
          ? `I'll stay quiet until my owner approves this group in the 5dive app (the agent's settings → Who can talk to).`
          : `I'll stay quiet until this group is approved: run /telegram:access in the agent terminal.`),
    )
  }
  // DIVE-246, in plain words. DIVE-5454: with privacy on and no admin rights a
  // mention never arrives, so this is how a mention-only group starts working.
  if (i.privacyOn) {
    lines.push(
      `⚠️ ${GROUP_STRINGS.en.privacy} (Or turn Group Privacy off in @BotFather → Bot Settings, ` +
        `then remove me and add me back.)`,
    )
  }
  return lines
}
