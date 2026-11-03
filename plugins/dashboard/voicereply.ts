// DIVE-7603 (DIVE-7578 run 6): on a box with no voice add-on, the reply tool
// still offered `voice: true`, and a failed voice note answered "say in one
// line that the voice reply did not work". qwen3:8b said that line with
// voice: true again, failed again, and posted 9 "voice note failed" messages
// in 11 minutes until the owner restarted it.
//
// Two rules, kept here as pure logic (server.ts long-polls on import):
// 1. The tool offers voice only when this box can make it (5dive-speak exists).
// 2. A voice failure never invites another try. The first failure tells the
//    agent to say it once in TEXT; for VOICE_COOLDOWN_MS after it, a voice
//    request is not attempted and the agent is told to say nothing more.

/** How long after a failed voice note a new voice request is skipped. */
export const VOICE_COOLDOWN_MS = 10 * 60_000

const BASE_DESC =
  'Reply in the 5dive dashboard chat. Pass chat_id from the inbound message (normally "dashboard"). ' +
  'Optionally pass files (absolute paths on this box) to offer as downloads in the chat. ' +
  'An audio file (a voice note from 5dive-speak) plays in the chat; with files attached, text may be empty. '
const VOICE_DESC =
  'Set voice: true to answer a voice note: the text goes first, then the plugin speaks it and sends that voice note. '
const CAP_DESC =
  'Text over 70 words (outside fenced code) is refused and nothing is sent: keep it to 60, or put the detail in a file and name it in one line.'

/** The reply tool's definition. `withVoice` false: no `voice` field and no word about it. */
export function replyTool(withVoice: boolean) {
  const properties: Record<string, unknown> = {
    chat_id: { type: 'string' },
    text: { type: 'string' },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute file paths on this box to attach as downloadable files.',
    },
  }
  if (withVoice) {
    properties.voice = {
      type: 'boolean',
      description: 'Also speak text as a voice note (made on this box) and send it right after the text. Use it to answer a voice note.',
    }
  }
  return {
    name: 'reply',
    description: BASE_DESC + (withVoice ? VOICE_DESC : '') + CAP_DESC,
    inputSchema: { type: 'object', properties, required: ['chat_id'] },
  }
}

export type VoicePlan = 'speak' | 'absent' | 'cooling'

/** Whether a `voice: true` reply is spoken now. `lastFailAt` 0: no failure yet. */
export function voicePlan(speakExists: boolean, lastFailAt: number, now: number): VoicePlan {
  if (!speakExists) return 'absent'
  if (lastFailAt > 0 && now - lastFailAt < VOICE_COOLDOWN_MS) return 'cooling'
  return 'speak'
}

/** The tool-result line for a voice request that was not attempted. Neither invites a reply. */
export function voiceSkippedNote(plan: Exclude<VoicePlan, 'speak'>): string {
  if (plan === 'absent') return 'this server makes no voice notes: the text went, which is the whole answer. Say nothing about voice and do not set voice again.'
  return 'voice skipped: a voice note failed a few minutes ago and is not retried yet. The text went. Say nothing more about voice and do not reply again for it.'
}

/** The tool-result line for the first voice note that failed: one TEXT line, never a retry. */
export function voiceFailedOnce(why: string): string {
  return `VOICE NOTE NOT SENT (${why}). The text went. If you say so, say it once, in text only (no voice), and do not try voice again.`
}
