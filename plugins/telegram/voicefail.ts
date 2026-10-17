// DIVE-6440: a voice reply that never left the box must not take the answer
// with it, and must not read as sent.
//
// lodar, 2026-10-17, a tester's voice note: «агент не отвечает голосом и не
// отвечает текстом ... при этом он уверен за то, что он ответил». edge-tts was
// refused by Microsoft (DIVE-6436), so `5dive-speak` made no OGG. The reply that
// carried the text and that path threw on the missing file before any text went
// (the attachment pre-check runs first), so the client got nothing at all.
//
// Now an attached audio file that is missing, empty or refused by Telegram is a
// failed voice note: the text still goes, and the tool result says in words the
// agent cannot misread that the voice note did not. With no text in the call,
// nothing reached the user, and the reply fails with what to do instead.
// Pure logic lives here so it can be unit-tested without booting the server
// (server.ts long-polls Telegram on import).

import { statSync } from 'node:fs'

export const AUDIO_EXT = /\.(ogg|oga|opus|mp3|m4a|wav)$/i

// Below this an "audio" file holds no audio. ffmpeg turns an empty raw-PCM
// answer into a 137-byte OGG of headers only (DIVE-5162); one spoken word at
// 32 kbit/s is already several KB.
export const MIN_AUDIO_BYTES = 512

export function isAudioFile(f: string): boolean {
  return AUDIO_EXT.test(f)
}

// Why this attached file cannot go as a voice note, or null when it can (or
// when it is not audio: other attachments keep their own errors).
export function unsendableAudio(f: string, stat: (p: string) => { size: number } = statSync): string | null {
  if (!isAudioFile(f)) return null
  let size: number
  try {
    size = stat(f).size
  } catch {
    return `${f} does not exist, so the voice note was never made`
  }
  if (size < MIN_AUDIO_BYTES) return `${f} has no audio in it (${size} bytes)`
  return null
}

// The tool-result line when something else in the call did go. Without text in
// the call that is the error's advice, minus the "nothing was sent" claim.
export function voiceFailedNote(reasons: string[], textSent: boolean): string {
  if (!textSent) return `VOICE NOTE NOT SENT: ${reasons.join('; ')}. If your answer has not already gone as text, send it as text now (reply with text=...), and say in one line that the voice reply did not work this time.`
  return `VOICE NOTE NOT SENT: ${reasons.join('; ')}. The user got your text answer only. Do not say you sent a voice note; say in one line that the voice reply did not work this time.`
}

// The error when the call carried no text, so this call delivered nothing. The
// voice section has the text go in an earlier call, so it may already be there.
export function voiceFailedError(reasons: string[]): string {
  return `reply: VOICE NOTE NOT SENT, and this call sent nothing: ${reasons.join('; ')}. If your answer has not already gone as text, send it as text now (reply with text=...). Either way, say in one line that the voice reply did not work this time, and do not say you sent a voice note.`
}
