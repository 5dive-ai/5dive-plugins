// A browser viewer URL is a one-time credential consumed by its first GET.
// Telegram's link previewer performs that GET before the human can tap it, so
// every outbound path must mark the URL as code and disable previews at the
// transport choke point. Direct tests keep this behavior aligned across forks.

type TelegramEntity = { type: string; offset: number; length: number }

export type TelegramTextPayload = {
  text?: string
  parse_mode?: string
  entities?: TelegramEntity[]
  link_preview_options?: Record<string, unknown>
}

const VIEWER_LINK_RE = /(?:https?:\/\/[^\s`<>()]+)?\/browser\/viewer\/[A-Za-z0-9._-]+\/[a-fA-F0-9]{64}/g
const WARNING = 'Copy-paste this one-time link into your browser. Do not paste it back here.'

function matchesViewerLinks(text: string): Array<{ index: number; link: string }> {
  return [...text.matchAll(VIEWER_LINK_RE)].map(match => ({ index: match.index!, link: match[0] }))
}

function alreadyCodeWrapped(text: string, index: number, length: number, html: boolean): boolean {
  if (html) {
    return text.slice(Math.max(0, index - 6), index).toLowerCase() === '<code>'
      && text.slice(index + length, index + length + 7).toLowerCase() === '</code>'
  }
  return text[index - 1] === '`' && text[index + length] === '`'
}

export function protectTelegramViewerLinks(payload: TelegramTextPayload): boolean {
  if (typeof payload.text !== 'string') return false
  const matches = matchesViewerLinks(payload.text)
  if (matches.length === 0) return false
  payload.link_preview_options = { ...(payload.link_preview_options ?? {}), is_disabled: true }
  const mode = payload.parse_mode?.toLowerCase()
  if (!mode) {
    const prior = payload.entities ?? []
    const viewerRanges = matches.map(({ index, link }) => ({ type: 'code', offset: index, length: link.length }))
    payload.entities = [
      ...prior.filter(entity => !viewerRanges.some(range =>
        entity.offset < range.offset + range.length && range.offset < entity.offset + entity.length,
      )),
      ...viewerRanges,
    ]
  } else if (mode === 'markdown' || mode === 'markdownv2' || mode === 'html') {
    const html = mode === 'html'
    for (const { index, link } of [...matches].reverse()) {
      if (alreadyCodeWrapped(payload.text, index, link.length, html)) continue
      const open = html ? '<code>' : '`'
      const close = html ? '</code>' : '`'
      payload.text = payload.text.slice(0, index) + open + link + close + payload.text.slice(index + link.length)
    }
  }
  if (!payload.text.includes('Do not paste it back here')) {
    const suffix = mode === 'markdownv2'
      ? 'Copy\\-paste this one\\-time link into your browser\\. Do not paste it back here\\.'
      : WARNING
    if (payload.text.length + suffix.length + 2 <= 4096) payload.text += `\n\n${suffix}`
  }
  return true
}
