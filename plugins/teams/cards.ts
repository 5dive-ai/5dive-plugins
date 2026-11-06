// plugins/teams/cards.ts — what the agent's words look like in Teams. Pure.
//
// THE BUTTON CONTRACT is Telegram's, unchanged, so an agent writes the same
// message for either channel: a question with set answers ENDS with a numbered
// list (2 to 8 lines, each under 90 characters) and each line becomes a tap
// button. A leading ⭐ marks the recommended answer. In Teams the buttons are
// an Adaptive Card's Action.Submit actions; a tap comes back as a message
// activity whose `value` carries the choice (see activity.ts).
//
// The file-consent and file-info card shapes and the submit-value reading are
// ported from OpenClaw's msteams extension (MIT, see ../../NOTICE):
//   extensions/msteams/src/file-consent.ts, adaptive-card-submit.ts

export const MAX_BUTTONS = 8
export const MAX_BUTTON_CHARS = 90

export type Split = { body: string; options: string[] }

// Split a trailing numbered list off the message. Returns options=[] when the
// message does not end in a qualifying list, and then body is the input as-is.
export function splitTrailingOptions(text: string): Split {
  const lines = text.replace(/\s+$/, '').split('\n')
  const opts: string[] = []
  let i = lines.length - 1
  for (; i >= 0; i--) {
    const m = lines[i].match(/^\s*(\d{1,2})[.)]\s+(.+?)\s*$/)
    if (!m) break
    opts.unshift(m[2])
  }
  // The list must be numbered 1..n in order, or it is prose that happens to
  // contain numbers ("2. we shipped it") and must stay text.
  const ordered = opts.length > 0 && lines.slice(i + 1).every((l, k) => Number(l.match(/^\s*(\d{1,2})/)?.[1]) === k + 1)
  if (!ordered || opts.length < 2 || opts.length > MAX_BUTTONS || opts.some(o => o.length >= MAX_BUTTON_CHARS)) {
    return { body: text, options: [] }
  }
  return { body: lines.slice(0, i + 1).join('\n').replace(/\s+$/, ''), options: opts }
}

// The value a button carries back. The star is presentation, not the answer.
export function optionValue(label: string): string {
  return label.replace(/^\s*⭐\s*/, '').trim()
}

export const CHOICE_KIND = '5dive.choice'

export function choiceCard(body: string, options: string[], cardId: string) {
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: body ? [{ type: 'TextBlock', text: body, wrap: true }] : [],
      actions: options.map(o => ({
        type: 'Action.Submit',
        title: o,
        data: { kind: CHOICE_KIND, card: cardId, choice: optionValue(o) },
      })),
    },
  }
}

// The card after a tap: same text, buttons gone, the answer shown. Stops a
// second tap answering a question twice.
export function answeredCard(body: string, choice: string) {
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        ...(body ? [{ type: 'TextBlock', text: body, wrap: true }] : []),
        { type: 'TextBlock', text: `✓ ${choice}`, weight: 'Bolder', wrap: true },
      ],
    },
  }
}

// What a submit carries, as text. Our own buttons give their choice; anything
// else (an imBack, a foreign card) is serialized so nothing is silently lost.
export function readSubmitValue(value: unknown): { choice: string; card?: string } | null {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() ? { choice: value.trim() } : null
  if (typeof value !== 'object') return null
  let v = value as Record<string, unknown>
  const action = v.action as Record<string, unknown> | undefined
  if (action && String(action.type).toLowerCase() === 'action.submit' && action.data && typeof action.data === 'object') {
    v = action.data as Record<string, unknown>
  }
  if (v.kind === CHOICE_KIND && typeof v.choice === 'string') {
    return { choice: v.choice, card: typeof v.card === 'string' ? v.card : undefined }
  }
  const ms = v.msteams as Record<string, unknown> | undefined
  if (ms && String(ms.type).toLowerCase() === 'imback' && typeof ms.value === 'string') return { choice: ms.value }
  try {
    const s = JSON.stringify(v)
    return s && s !== '{}' ? { choice: s } : null
  } catch {
    return null
  }
}

export function fileConsentCard(filename: string, sizeInBytes: number, uploadId: string) {
  return {
    contentType: 'application/vnd.microsoft.teams.card.file.consent',
    name: filename,
    content: {
      description: `File: ${filename}`,
      sizeInBytes,
      acceptContext: { filename, uploadId },
      declineContext: { filename, uploadId },
    },
  }
}

export function fileInfoCard(p: { filename: string; contentUrl: string; uniqueId: string; fileType: string }) {
  return {
    contentType: 'application/vnd.microsoft.teams.card.file.info',
    contentUrl: p.contentUrl,
    name: p.filename,
    content: { uniqueId: p.uniqueId, fileType: p.fileType },
  }
}

export type ConsentInvoke = {
  action: 'accept' | 'decline'
  uploadId?: string
  uploadInfo?: { name: string; uploadUrl: string; contentUrl: string; uniqueId: string; fileType: string }
}

export function parseFileConsentInvoke(activity: { name?: string; value?: any }): ConsentInvoke | null {
  if (activity?.name !== 'fileConsent/invoke') return null
  const v = activity.value
  if (!v || v.type !== 'fileUpload') return null
  return {
    action: v.action === 'accept' ? 'accept' : 'decline',
    uploadId: typeof v.context?.uploadId === 'string' ? v.context.uploadId : undefined,
    uploadInfo: v.uploadInfo,
  }
}

// Teams caps a message at ~28 KB of payload. Split long text on paragraph,
// then line, then hard boundaries, keeping each piece under `max` characters.
export function chunkText(text: string, max = 20000): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).replace(/\s+$/, ''))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) out.push(rest)
  return out
}
