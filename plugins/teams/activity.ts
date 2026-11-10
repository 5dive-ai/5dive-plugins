// plugins/teams/activity.ts — read one Bot Framework activity into what the
// session sees. Pure; tested in test/teams-plugin.test.ts.
//
// The session gets ONE shape for every channel: text plus meta attributes on a
// <channel source="teams" …> tag, the same contract Telegram uses, so an agent
// that already answers Telegram answers Teams with no new instructions beyond
// "pass chat_id back to reply".

import { readSubmitValue, parseFileConsentInvoke, type ConsentInvoke } from './cards.ts'

export type InboundFile = { name: string; url: string; contentType: string }

// DIVE-8023: where a message was written. Teams names them personal (a 1:1
// chat), groupChat and channel; the tag says personal | group | channel.
export type ChatType = 'personal' | 'group' | 'channel'

export type Parsed =
  | { kind: 'message'; text: string; meta: Record<string, string>; files: InboundFile[]; conversationId: string; serviceUrl: string; chatType: ChatType }
  | { kind: 'button'; text: string; meta: Record<string, string>; card?: string; replyToId?: string; conversationId: string; serviceUrl: string; chatType: ChatType }
  | { kind: 'consent'; consent: ConsentInvoke; conversationId: string; serviceUrl: string; chatType: ChatType }
  | { kind: 'ignore'; reason: string }

export function chatTypeOf(conversationType: unknown): ChatType | null {
  const t = String(conversationType ?? 'personal')
  if (t === 'personal') return 'personal'
  if (t === 'groupChat') return 'group'
  if (t === 'channel') return 'channel'
  return null
}

// A channel post's conversation id names its thread: "19:…@thread.tacv2;messageid=…".
// Replying to that id answers inside the thread; the part before ';' is the channel.
export function baseConversation(id: string): string {
  return id.split(';')[0]
}

// Is this bot @mentioned? Teams lists every mention in entities, the bot as
// "28:<app id>" (also the activity's recipient). A mention of anyone else does not count.
function isBotId(id: unknown, appId: string, recipient: unknown): boolean {
  const s = String(id ?? '').toLowerCase()
  if (!s) return false
  if (s === `28:${appId}`.toLowerCase() || s === appId.toLowerCase()) return true
  return !!recipient && s === String(recipient).toLowerCase()
}
function botMentions(a: any, appId: string): string[] {
  const out: string[] = []
  for (const e of Array.isArray(a?.entities) ? a.entities : []) {
    if (e?.type !== 'mention') continue
    if (isBotId(e.mentioned?.id, appId, a?.recipient?.id)) out.push(String(e.text ?? ''))
  }
  return out
}
export function mentionsBot(a: any, appId: string): boolean {
  return botMentions(a, appId).length > 0
}

// The text of a group or channel message: the bot's own @mention removed, and
// anyone else's kept as "@Name", so "ask <at>Ana</at> about it" still reads right.
export function groupText(a: any, appId: string): string {
  let raw = String(a?.text ?? '')
  for (const m of botMentions(a, appId)) if (m) raw = raw.split(m).join('')
  raw = raw.replace(/<at>([^<]*)<\/at>/gi, (_x, name) => `@${name}`)
  return cleanText(raw)
}

// The chat's name for the tag: a group chat's topic, or "Team › Channel".
function chatName(a: any, type: ChatType): string {
  if (type === 'group') return String(a?.conversation?.name ?? '').trim()
  if (type === 'channel') {
    const team = String(a?.channelData?.team?.name ?? '').trim()
    const chan = String(a?.channelData?.channel?.name ?? '').trim()
    return [team, chan].filter(Boolean).join(' › ')
  }
  return ''
}

// Teams wraps a DM's text in HTML when it has formatting or an @mention of the
// bot. The text field is the plain form; strip the residue Teams leaves in it.
export function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/<at>[^<]*<\/at>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

export function readFiles(attachments: unknown): InboundFile[] {
  if (!Array.isArray(attachments)) return []
  const out: InboundFile[] = []
  for (const a of attachments) {
    if (!a || typeof a !== 'object') continue
    const ct = String((a as any).contentType ?? '')
    // A file shared in a 1:1 chat: a pre-signed SharePoint/OneDrive link.
    if (ct === 'application/vnd.microsoft.teams.file.download.info') {
      const url = (a as any).content?.downloadUrl
      if (typeof url === 'string') out.push({ name: String((a as any).name ?? 'file'), url, contentType: String((a as any).content?.fileType ?? '') })
      continue
    }
    // A pasted image: lives on the Bot Framework attachment service.
    if (ct.startsWith('image/') && typeof (a as any).contentUrl === 'string') {
      const ext = ct.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
      out.push({ name: String((a as any).name ?? `image.${ext}`), url: (a as any).contentUrl, contentType: ct })
    }
    // text/html is the formatted copy of the message itself; cards are ours.
  }
  return out
}

export type Policy = { tenantId: string; appId: string; allowedUsers?: string[] }

export function parseActivity(a: any, policy: Policy): Parsed {
  if (!a || typeof a !== 'object') return { kind: 'ignore', reason: 'not an activity' }
  if (a.channelId !== 'msteams') return { kind: 'ignore', reason: `channel ${a.channelId}` }
  const conversationId = String(a.conversation?.id ?? '')
  const serviceUrl = String(a.serviceUrl ?? '')
  if (!conversationId || !serviceUrl) return { kind: 'ignore', reason: 'no conversation' }
  // Single-tenant by construction: the app registration lives in the
  // customer's tenant. A message from any other tenant is refused even though
  // Microsoft signed it — a guest or a cross-tenant chat is not this office.
  const tenant = String(a.channelData?.tenant?.id ?? a.conversation?.tenantId ?? '')
  if (!tenant || tenant.toLowerCase() !== policy.tenantId.toLowerCase()) {
    return { kind: 'ignore', reason: `tenant ${tenant || 'missing'}` }
  }
  // DIVE-8023: 1:1 chats, group chats and channels, the Telegram group model.
  // In a group or channel the agent hears only a message that @mentions it (or a
  // tap on its own buttons). Every member can write there, so who is speaking
  // rides on the tag and the sender's own role still decides what they may ask.
  const chatType = chatTypeOf(a.conversation?.conversationType)
  if (!chatType) return { kind: 'ignore', reason: `conversation type ${a.conversation?.conversationType}` }
  const userId = String(a.from?.aadObjectId ?? '')
  if (policy.allowedUsers?.length && !policy.allowedUsers.map(s => s.toLowerCase()).includes(userId.toLowerCase())) {
    return { kind: 'ignore', reason: 'user not allowed' }
  }
  if (a.type === 'invoke') {
    // Teams offers file consent in a 1:1 chat only.
    const consent = chatType === 'personal' ? parseFileConsentInvoke(a) : null
    if (consent) return { kind: 'consent', consent, conversationId, serviceUrl, chatType }
    return { kind: 'ignore', reason: `invoke ${a.name}` }
  }
  if (a.type !== 'message') return { kind: 'ignore', reason: `type ${a.type}` }
  const meta: Record<string, string> = {
    chat_id: conversationId,
    message_id: String(a.id ?? ''),
    user: String(a.from?.name ?? 'user'),
    user_id: userId,
    ts: String(a.timestamp ?? new Date().toISOString()),
    chat_type: chatType,
  }
  const name = chatName(a, chatType)
  if (name) meta.chat_name = name
  const isTap = a.value != null && !a.text
  if (chatType !== 'personal' && !isTap && !mentionsBot(a, policy.appId)) return { kind: 'ignore', reason: 'not mentioned' }
  if (isTap) {
    const sub = readSubmitValue(a.value)
    if (!sub) return { kind: 'ignore', reason: 'empty submit' }
    meta.via = 'button'
    if (a.replyToId) meta.answers_message_id = String(a.replyToId)
    return { kind: 'button', text: sub.choice, meta, card: sub.card, replyToId: a.replyToId ? String(a.replyToId) : undefined, conversationId, serviceUrl, chatType }
  }
  const text = chatType === 'personal' ? cleanText(a.text) : groupText(a, policy.appId)
  const files = readFiles(a.attachments)
  if (!text && files.length === 0) return { kind: 'ignore', reason: 'empty message' }
  return { kind: 'message', text, meta, files, conversationId, serviceUrl, chatType }
}

// A safe local filename for a downloaded file: no path, no control chars.
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file'
  return base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
}
