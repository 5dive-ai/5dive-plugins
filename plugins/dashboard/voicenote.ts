// DIVE-6544: voice notes in the web chat, both ways.
//
// Inbound. The web chat records a note, lands it on the box under
// /home/claude/chat-uploads/<agent>/, has the box hear it (`5dive voice hear`),
// and sends the transcript as the message text behind a "[voice note]" line, so
// the agent reads words. Only when hearing failed does the message also carry
// the audio's path (the files API's `image_path` field, the one attachment
// field the control plane forwards). An audio file there is not an image to
// Read: it goes to the session as `audio_path` with attachment_kind="voice",
// and the agent hears it itself with 5dive-transcribe.
//
// Outbound. A voice reply is 5dive-speak's OGG/Opus, which Telegram plays and
// Safari may not. Each audio attachment also goes to the web as an MP3 (ffmpeg,
// which the voice engine installs), and the OGG is kept when that fails. A
// voice note may go with no text, as on Telegram (DIVE-5490); the control plane
// needs a body, so it gets VOICE_ONLY_BODY, which the web chat does not draw.

const AUDIO_RE = /\.(webm|ogg|oga|opus|m4a|mp4|mp3|wav|aac|flac)$/i
const OPUS_RE = /\.(ogg|oga|opus)$/i

/** The body a reply with files and no text carries (the web chat draws the files alone). */
export const VOICE_ONLY_BODY = '🎙'

export function isAudioPath(p: string): boolean {
  return AUDIO_RE.test(p)
}

/** The session meta an inbound attachment path becomes: an audio file is a voice note, anything else stays image_path. */
export function inboundAttachment(path: unknown): Record<string, string> {
  if (typeof path !== 'string' || !path.startsWith('/')) return {}
  if (isAudioPath(path)) return { attachment_kind: 'voice', audio_path: path }
  return { image_path: path }
}

/** A reply's body: its text, else a stand-in when files carry the reply alone. Throws when there is neither. */
export function replyBody(text: string, files: string[]): string {
  if (text.trim()) return text
  if (files.length > 0) return files.every(isAudioPath) ? VOICE_ONLY_BODY : '📎'
  throw new Error('text is required (or files to send alone, such as a voice note)')
}

export type Run = (bin: string, args: string[], timeoutMs: number) => Promise<void>

/**
 * The path a browser can play: an OGG/Opus file gets an MP3 beside it, made by
 * `run` (ffmpeg); anything else, or a failed conversion, keeps the path given.
 */
export async function webPlayable(path: string, run: Run, ffmpeg = 'ffmpeg'): Promise<string> {
  if (!OPUS_RE.test(path)) return path
  const mp3 = path.replace(OPUS_RE, '.mp3')
  try {
    await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', path, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', mp3], 30_000)
    return mp3
  } catch {
    return path
  }
}
