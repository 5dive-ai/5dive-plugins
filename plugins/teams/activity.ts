// plugins/teams/activity.ts — read one Bot Framework activity into what the
// session sees. Pure; tested in test/teams-plugin.test.ts.
//
// The session gets ONE shape for every channel: text plus meta attributes on a
// <channel source="teams" …> tag, the same contract Telegram uses, so an agent
// that already answers Telegram answers Teams with no new instructions beyond
// "pass chat_id back to reply".

import { readSubmitValue, parseFileConsentInvoke, type ConsentInvoke } from './cards.ts'

export type InboundFile = { name: string; url: string; contentType: string }

export type Parsed =
  | { kind: 'message'; text: string; meta: Record<string, string>; files: InboundFile[]; conversationId: string; serviceUrl: string }
  | { kind: 'button'; text: string; meta: Record<string, string>; card?: string; replyToId?: string; conversationId: string; serviceUrl: string }
  | { kind: 'consent'; consent: ConsentInvoke; conversationId: string; serviceUrl: string }
  | { kind: 'ignore'; reason: string }

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
  // Only 1:1 chats. A group chat or a channel post is a different trust shape
  // (every member could steer the agent) and is out of scope for v1.
  const convType = String(a.conversation?.conversationType ?? 'personal')
  if (convType !== 'personal') return { kind: 'ignore', reason: `conversation type ${convType}` }
  const userId = String(a.from?.aadObjectId ?? '')
  if (policy.allowedUsers?.length && !policy.allowedUsers.map(s => s.toLowerCase()).includes(userId.toLowerCase())) {
    return { kind: 'ignore', reason: 'user not allowed' }
  }
  if (a.type === 'invoke') {
    const consent = parseFileConsentInvoke(a)
    if (consent) return { kind: 'consent', consent, conversationId, serviceUrl }
    return { kind: 'ignore', reason: `invoke ${a.name}` }
  }
  if (a.type !== 'message') return { kind: 'ignore', reason: `type ${a.type}` }
  const meta: Record<string, string> = {
    chat_id: conversationId,
    message_id: String(a.id ?? ''),
    user: String(a.from?.name ?? 'user'),
    user_id: userId,
    ts: String(a.timestamp ?? new Date().toISOString()),
  }
  if (a.value != null && !a.text) {
    const sub = readSubmitValue(a.value)
    if (!sub) return { kind: 'ignore', reason: 'empty submit' }
    meta.via = 'button'
    if (a.replyToId) meta.answers_message_id = String(a.replyToId)
    return { kind: 'button', text: sub.choice, meta, card: sub.card, replyToId: a.replyToId ? String(a.replyToId) : undefined, conversationId, serviceUrl }
  }
  const text = cleanText(a.text)
  const files = readFiles(a.attachments)
  if (!text && files.length === 0) return { kind: 'ignore', reason: 'empty message' }
  return { kind: 'message', text, meta, files, conversationId, serviceUrl }
}

// A safe local filename for a downloaded file: no path, no control chars.
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file'
  return base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
}
