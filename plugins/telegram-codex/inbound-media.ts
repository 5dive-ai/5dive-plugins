// DIVE-5505: an inbound attachment on the DISPATCHER path.
//
// The pane path hands the model `formatInbound()`'s meta (attachment_file_id
// and friends) and the model calls `download_attachment`. The dispatcher path
// starts Codex with `mcp_servers={}`, so that model has no MCP tools: a bare
// "(voice message)" reached it with nothing it could fetch, and it asked the
// owner to resend. So here the BRIDGE fetches the file, and for voice/audio it
// also runs 5dive-transcribe, which saves a tool call and a model round per
// voice note on a seat that pays provider quota for every round.
//
// dispatcherTurnText is pure: Telegram and the transcriber come in as ports,
// so the harness drives it with stubs (test/codex-voice-attachments.test.ts).

import { execFile } from 'child_process'

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
  /** Seconds, as Telegram reports it on a voice note or an audio file. */
  duration?: number
}

export type MediaPorts = {
  /** Fetch the Telegram file into the inbox; resolves its local path. */
  download: (fileId: string) => Promise<string>
  /** The transcript of a local audio file (5dive-transcribe's stdout). */
  transcribe: (path: string, durationSec?: number) => Promise<string>
}

/**
 * A `transcribe` port that runs `bin <path>` and resolves its stdout.
 *
 * DIVE-5779: the kill is `baseMs` plus the note's own length. A fixed 120s
 * killed every note over ~5 min, although 5dive-transcribe (DIVE-5750) waits
 * 120s plus the note's length on local whisper and then may fall back to
 * OpenRouter. The binary bounds its own wait; this is only the net for a hung
 * binary, so it has to sit above the binary's worst case, never below it.
 */
export function execTranscriber(bin: string, baseMs: number): (path: string, durationSec?: number) => Promise<string> {
  return (path, durationSec) => new Promise((resolve, reject) => {
    const timeout = baseMs + Math.max(0, durationSec ?? 0) * 1000
    execFile(bin, [path], { timeout, maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim()))
      else resolve(String(out))
    })
  })
}

const TRANSCRIBED = new Set(['voice', 'audio'])

/** The same keys `formatInbound` gives the pane path, plus the local file. */
export function attachmentMetaLine(a: AttachmentMeta, path?: string): string {
  return [
    `attachment_kind=${a.kind}`,
    `attachment_file_id=${a.file_id}`,
    a.size != null ? `attachment_size=${a.size}` : null,
    a.mime ? `attachment_mime=${a.mime}` : null,
    a.name ? `attachment_name=${a.name}` : null,
    path ? `attachment_path=${path}` : null,
  ].filter(Boolean).join(' ')
}

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0].slice(0, 120) || 'unknown error'
}

/**
 * The turn text the dispatcher submits for an inbound `text` + `attachment`.
 * `transcript` is set only when transcription succeeded, so the caller can keep
 * it in the chat log. Never throws: every failure degrades to the meta line.
 */
export async function dispatcherTurnText(
  text: string,
  attachment: AttachmentMeta | undefined,
  ports: MediaPorts,
): Promise<{ text: string; transcript?: string }> {
  if (!attachment) return { text }
  let path: string | undefined
  let failed: string | undefined
  try {
    path = await ports.download(attachment.file_id)
  } catch (err) {
    failed = `download failed: ${reason(err)}`
  }
  if (path && TRANSCRIBED.has(attachment.kind)) {
    try {
      const transcript = (await ports.transcribe(path, attachment.duration)).replace(/\s+/g, ' ').trim()
      if (transcript) {
        const label = attachment.kind === 'voice' ? '(voice message)' : '(audio)'
        // A caption replaces the "(voice message)" label, so say what follows.
        const head = text.startsWith('(') ? text : `${text}\n${label}`
        return { text: `${head} ${transcript}\n[${attachmentMetaLine(attachment, path)}]`, transcript }
      }
      failed = 'transcription was empty'
    } catch (err) {
      failed = `transcription failed: ${reason(err)}`
    }
  }
  const note = failed ? ` (${failed})` : ''
  return { text: `${text}\n[${attachmentMetaLine(attachment, path)}]${note}` }
}
