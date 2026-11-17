// DIVE-8649: lodar's TEST version of faster voice answers in the app, and the
// clock that measures it. Pure logic (server.ts long-polls on import).
//
// The switch is ONE file per box, /var/lib/5dive/voice/labs, absent on every
// box: absent, a voice reply runs exactly as before and nothing is logged. It
// holds words:
//   timing  log one line of timings per voice reply (no text, no audio)
//   fast    start speaking the reply while its text is still being posted,
//           instead of after (and log, as with timing)
// It sits beside the voice engine's own config, in a directory no installer
// and no nightly rewrites, so turning it on survives the nightly; it is read
// on every voice reply, so turning it on or off needs no restart.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const VOICE_LABS_FILE_DEFAULT = '/var/lib/5dive/voice/labs'
export const VOICE_TIMING_KEEP = 500
/** A voice note heard longer ago than this is not the one being answered. */
export const VOICE_TURN_MAX_MS = 10 * 60_000

export type VoiceLab = 'timing' | 'fast'

/** The labs this box has on. A missing or unreadable file: none. Unknown words are ignored. */
export function readVoiceLabs(file: string): Set<VoiceLab> {
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return new Set() }
  const on = new Set<VoiceLab>()
  for (const line of raw.split('\n')) {
    for (const w of line.replace(/#.*/, '').split(/[\s,]+/)) {
      if (w === 'timing' || w === 'fast') on.add(w)
    }
  }
  return on
}

/** When the agent was handed each chat's last voice note, so its reply can be timed from there. */
export function makeVoiceClock() {
  const heard = new Map<string, number>()
  return {
    heard(chat: string, at: number): void { heard.set(chat, at) },
    /** The hand-over time of this chat's voice note, once; null when there is none or it is stale. */
    take(chat: string, now: number): number | null {
      const at = heard.get(chat)
      heard.delete(chat)
      return at !== undefined && now - at >= 0 && now - at <= VOICE_TURN_MAX_MS ? at : null
    },
  }
}

/** The moments of one voice reply, in ms since the epoch. */
export type VoiceReplyMarks = {
  chat: string
  fast: boolean
  /** The voice note was handed to the agent (null: not seen by this process). */
  heardAt: number | null
  /** The agent called reply. */
  replyAt: number
  /** The text reply was posted. */
  textAt: number
  /** 5dive-speak was started. */
  speakAt: number
  /** 5dive-speak finished. */
  spokeAt: number
  /** The voice note was posted (null: it was not). */
  sentAt: number | null
}

const span = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : Math.max(0, Math.round(to - from))

/** One JSON line of stage durations. Timings and the chat's id only: never the text or the audio. */
export function voiceTimingLine(m: VoiceReplyMarks, now: Date = new Date()): string {
  return JSON.stringify({
    at: now.toISOString(),
    chat: m.chat,
    fast: m.fast,
    agent_ms: span(m.heardAt, m.replyAt),
    text_ms: span(m.replyAt, m.textAt),
    speak_ms: span(m.speakAt, m.spokeAt),
    // How long the spoken note waited after its text: the part the user hears as delay.
    after_text_ms: span(m.textAt, m.spokeAt),
    voice_ms: span(m.spokeAt, m.sentAt),
    box_ms: span(m.heardAt, m.sentAt),
    reply_ms: span(m.replyAt, m.sentAt),
    ok: m.sentAt !== null,
  })
}

/** Append one line, keeping the newest VOICE_TIMING_KEEP. Never throws: timing must not cost a reply. */
export function appendVoiceTiming(file: string, line: string, keep = VOICE_TIMING_KEEP): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line + '\n')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length > keep * 2) writeFileSync(file, lines.slice(-keep).join('\n') + '\n')
  } catch {}
}
