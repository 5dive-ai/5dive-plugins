// DIVE-6862: a chat reply over the cap is refused, nothing is sent, and the
// error tells the model to cut it. A pack line ("60 words at most") is read as
// advice: 27 of 30 graded replies still ran over it. A tool's error is read as
// an instruction, so the rule lives here.
//
// BYTE-IDENTICAL in plugins/telegram/replycap.ts and plugins/dashboard/replycap.ts
// (each plugin installs as its own tree). test/dive6862-reply-word-cap.test.ts
// fails on any drift: edit one, copy it to the other.
//
//   - a word is a whitespace-separated token with a letter or digit in it, so a
//     URL is one word and a bare "—" or "-" bullet is none;
//   - a CLOSED fenced code block (``` or ~~~) is not counted: a command or a
//     pasted log is not the wall. An unclosed fence counts as prose;
//   - attached files do not exempt the text; a files-only reply has 0 words;
//   - FIVEDIVE_REPLY_MAX_WORDS overrides the cap, 0 turns it off.

export const REPLY_WORD_CAP = 70
export const REPLY_WORD_TARGET = 60

export function replyWordCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FIVEDIVE_REPLY_MAX_WORDS?.trim()
  if (!raw) return REPLY_WORD_CAP
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : REPLY_WORD_CAP
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

function withoutFencedCode(text: string): string {
  const lines = text.split('\n')
  const keep: string[] = []
  let i = 0
  while (i < lines.length) {
    const open = FENCE_RE.exec(lines[i])
    if (open) {
      const fence = open[1]
      let close = -1
      for (let j = i + 1; j < lines.length; j++) {
        const m = FENCE_RE.exec(lines[j])
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && lines[j].trim() === m[1]) { close = j; break }
      }
      if (close >= 0) { i = close + 1; continue }
    }
    keep.push(lines[i])
    i++
  }
  return keep.join('\n')
}

export function countReplyWords(text: string): number {
  if (!text) return 0
  let n = 0
  for (const tok of withoutFencedCode(text).split(/\s+/)) if (/[\p{L}\p{N}]/u.test(tok)) n++
  return n
}

// The refusal text, or null when the reply may go. The stop hooks find a
// refused reply by REPLY_TOO_LONG_RE, so keep the two in step.
export const REPLY_TOO_LONG_RE = /too long: \d+ words; cut to \d+/

export function replyTooLong(text: unknown, cap = replyWordCap()): string | null {
  if (cap <= 0 || typeof text !== 'string') return null
  const n = countReplyWords(text)
  if (n <= cap) return null
  return `too long: ${n} words; cut to ${Math.min(REPLY_WORD_TARGET, cap)} or attach a file and name it in one line. Nothing was sent.`
}
