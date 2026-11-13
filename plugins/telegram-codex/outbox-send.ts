// DIVE-8328: how one dispatcher answer reaches Telegram, and what the model is
// told about its files afterwards.
//
// Until 0.5.50 the answer and its files were one unit: sendMessage(text), then
// each file, and any throw re-ingested the whole outbox file a second later. A
// file Telegram refused (a 479 MB video, a tall screenshot sendPhoto rejects
// with PHOTO_INVALID_DIMENSIONS) re-sent the TEXT forever, the file never came,
// and only stderr knew. Now:
//   - the text goes once; only a failed TEXT is retried (nothing reached the
//     chat yet). After it is out the caller removes the outbox file;
//   - each file is tried on its own; a picture sendPhoto refuses goes again as
//     a document, an OGG sendVoice refuses likewise;
//   - a file that still fails costs one "couldn't send <name>: <reason>" line
//     in the chat, never a second copy of the text;
//   - the outcome is one line the dispatcher puts in the model's NEXT turn
//     (takeAttachReceipts), because a dispatcher model has no tool result to
//     read: it said "sent" and could not know otherwise.
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
// DIVE-5508: 5dive-speak writes OGG/Opus, which Telegram plays as a voice note
// only through sendVoice; sendDocument leaves it a file to download.
export const VOICE_EXTS = new Set(['.ogg', '.oga', '.opus'])

export type FilePorts<T> = {
  sendPhoto(file: string): Promise<T>
  sendVoice(file: string): Promise<T>
  sendDocument(file: string): Promise<T>
  log?(line: string): void
}

/**
 * Send one file the way Telegram shows it best: a photo inline, an OGG as a
 * voice note, anything else as a document. A photo or voice upload Telegram
 * refuses falls back to a document rather than losing the file.
 */
export async function sendOneFile<T>(file: string, ports: FilePorts<T>): Promise<T> {
  const ext = extname(file).toLowerCase()
  const as = PHOTO_EXTS.has(ext) ? 'Photo' : VOICE_EXTS.has(ext) ? 'Voice' : null
  if (as) {
    try {
      return await (as === 'Photo' ? ports.sendPhoto(file) : ports.sendVoice(file))
    } catch (err) {
      ports.log?.(`send${as} refused ${file}, sending as a document: ${errText(err)}`)
    }
  }
  return ports.sendDocument(file)
}

function errText(err: unknown): string {
  return String((err as { description?: string; message?: string })?.description
    ?? (err as { message?: string })?.message ?? err)
}

/** Why a file did not go, in words the person in the chat can act on. */
export function plainSendReason(err: unknown): string {
  const raw = errText(err)
  if (/too large|entity too large|\b413\b|FILE_PARTS_INVALID|file is too big/i.test(raw)) return "too large for Telegram"
  if (/ENOENT|no such file/i.test(raw)) return 'the file is gone'
  if (/EACCES|permission denied/i.test(raw)) return 'no permission to read it'
  if (/file must be non-empty|empty file/i.test(raw)) return 'the file is empty'
  if (/PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|wrong file identifier|wrong type/i.test(raw)) return 'Telegram could not read the file'
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|network|fetch failed/i.test(raw)) return 'the upload timed out'
  const short = raw.replace(/^.*?Bad Request:\s*/i, '').replace(/\s+/g, ' ').trim()
  return short.length > 80 ? `${short.slice(0, 77)}…` : (short || 'Telegram refused it')
}

export type DeliveryPorts = {
  sendText(text: string): Promise<unknown>
  /** Called once the text is out: the caller drops the outbox file here. */
  textSent?(): void
  /** One file, with its fallbacks (sendOneFile); throws when it did not go. */
  sendFile(file: string): Promise<unknown>
  log?(line: string): void
}

export type DeliveryResult = {
  sent: string[]
  failed: Array<{ name: string; reason: string }>
}

/**
 * The text, then each file on its own. Throws only when the TEXT failed (the
 * caller may retry: nothing reached the chat). A failed file never throws.
 */
export async function deliverOutboxReply(text: string, files: string[], ports: DeliveryPorts): Promise<DeliveryResult> {
  await ports.sendText(text)
  ports.textSent?.()
  const sent: string[] = []
  const failed: DeliveryResult['failed'] = []
  for (const file of files) {
    try {
      await ports.sendFile(file)
      sent.push(basename(file))
    } catch (err) {
      ports.log?.(`file not sent ${file}: ${errText(err)}`)
      failed.push({ name: basename(file), reason: plainSendReason(err) })
    }
  }
  if (failed.length) {
    try {
      await ports.sendText(failed.map(f => `couldn't send ${f.name}: ${f.reason}`).join('\n'))
    } catch (err) {
      ports.log?.(`the "couldn't send" line failed too: ${errText(err)}`)
    }
  }
  return { sent, failed }
}

/**
 * The model's receipt for one answer, or '' when it named no file:
 * `[5dive attachments] sent a.png · not sent: c.mp4 (479 MB, over Telegram's 50 MB)`.
 */
export function attachReceiptLine(sent: string[], notSent: Array<{ name: string; reason: string }>): string {
  if (!sent.length && !notSent.length) return ''
  const parts: string[] = []
  if (sent.length) parts.push(`sent ${sent.join(', ')}`)
  if (notSent.length) parts.push(`not sent: ${notSent.map(f => `${f.name} (${f.reason})`).join(', ')}`)
  return `[5dive attachments] ${parts.join(' · ')}`
}

// The bridge and the dispatcher are two processes; the receipt crosses as one
// small file per chat in the dispatcher's state dir. The bridge appends, the
// dispatcher's next turn on that chat takes (and removes) it.
const RECEIPT_KEEP = 5

function receiptFile(dir: string, chatId: string): string {
  return join(dir, `${String(chatId).replace(/[^\w-]/g, '_')}.txt`)
}

export function recordAttachReceipt(dir: string, chatId: string, line: string): void {
  if (!line) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(receiptFile(dir, chatId), `${line.replace(/\s*\n\s*/g, ' ')}\n`, { mode: 0o600 })
  } catch {}
}

/** The chat's pending receipts as one input text, newest RECEIPT_KEEP kept; '' when none. */
export function takeAttachReceipts(dir: string, chatId: string): string {
  const file = receiptFile(dir, chatId)
  const taken = `${file}.${process.pid}.taking`
  try { renameSync(file, taken) } catch { return '' }
  let lines: string[] = []
  try { lines = readFileSync(taken, 'utf8').split('\n').filter(Boolean) } catch {}
  try { unlinkSync(taken) } catch {}
  return lines.slice(-RECEIPT_KEEP).join('\n')
}
