// DIVE-5490 (lodar, 2026-10-04: "lets kill this mic emoji" / "just noise"): an
// agent's voice reply arrived as text, then a lone "🎙" (drawn by Telegram as a
// big animated sticker), then the voice note. The voice section tells the model
// to send the audio as a follow-up reply call; `text` was required and nothing
// said it could be empty, so the model captioned it with the emoji.
//
// server.ts long-polls on import, so this runs the REAL isVoiceCaptionNoise cut
// out of each fork's source, then checks the reply handler wires it into the
// files-only path (no text chunks) and tells the model `text` may be empty.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FORKS = ['telegram', 'telegram-agy', 'telegram-codex', 'telegram-grok']

function src(fork: string): string {
  return readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
}

function loadFn(s: string, fork: string): (text: string, files: string[]) => boolean {
  const start = s.indexOf('function isVoiceCaptionNoise(')
  expect(start, `${fork}: no isVoiceCaptionNoise`).toBeGreaterThan(-1)
  const end = s.indexOf('\n}\n', start)
  const body = s.slice(start, end + 2)
    .replace('(text: string, files: string[]): boolean', '(text, files)')
  return new Function(`${body}; return isVoiceCaptionNoise`)()
}

// The reply handler's own block, so a wiring check cannot match elsewhere.
function replyCase(s: string): string {
  const start = s.indexOf("case 'reply': {")
  const end = s.indexOf("case 'edit_message'", start)
  return s.slice(start, end)
}

// What the reply handler sends for (text, files): the text message is skipped
// exactly when textMissing is true, and every file goes out regardless.
function sends(noise: (t: string, f: string[]) => boolean, text: string, files: string[]) {
  const textMissing = files.length > 0 &&
    (text.trim() === '' || text.trim() === 'undefined' || noise(text, files))
  return { textMessages: textMissing ? 0 : 1, files: files.length }
}

describe.each(FORKS)('%s reply', (fork) => {
  const s = src(fork)
  const noise = loadFn(s, fork)

  test('"🎙" + a voice note sends 0 text messages and 1 file', () => {
    expect(sends(noise, '🎙', ['/tmp/x.ogg'])).toEqual({ textMessages: 0, files: 1 })
  })

  test('"Here you go 🎙" + a voice note sends both', () => {
    expect(sends(noise, 'Here you go 🎙', ['/tmp/x.ogg'])).toEqual({ textMessages: 1, files: 1 })
  })

  test('"🎉" + a photo sends both', () => {
    expect(sends(noise, '🎉', ['/tmp/x.png'])).toEqual({ textMessages: 1, files: 1 })
  })

  test('emoji-only means pictographs, modifiers, VS16, ZWJ and spaces', () => {
    for (const t of ['🎙', ' 🎙️ ', '🔊🎧', '👍🏽', '👨‍👩‍👧', '🎙\n']) {
      expect(noise(t, ['/a/v.ogg']), JSON.stringify(t)).toBe(true)
    }
    for (const ext of ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.WAV']) {
      expect(noise('🎙', [`/a/v${ext}`]), ext).toBe(true)
    }
  })

  test('anything else keeps its text', () => {
    expect(noise('', ['/a/v.ogg'])).toBe(false) // no pictograph: the DIVE-1674 path owns empty
    expect(noise('ok', ['/a/v.ogg'])).toBe(false)
    expect(noise('1', ['/a/v.ogg'])).toBe(false)
    expect(noise('🎙 2', ['/a/v.ogg'])).toBe(false)
    expect(noise('🎙', [])).toBe(false)
    expect(noise('🎙', ['/a/v.ogg', '/a/report.pdf'])).toBe(false)
    expect(noise('🎙', ['/a/clip.mp4'])).toBe(false)
  })

  test('the reply handler skips the text message on that verdict', () => {
    const r = replyCase(s)
    expect(r).toMatch(/const textMissing =[\s\S]{0,200}isVoiceCaptionNoise\(text, files\)/)
    expect(r).toMatch(/const chunks = textMissing \? \[\] :/)
  })

  test('the tool tells the model `text` may be empty with files', () => {
    expect(s).toContain("text: { type: 'string', description: 'May be empty when files are attached (for example a voice note): then only the files are sent.' }")
    expect(s).toContain('With files attached, `text` may be empty (for example a voice note): then only the files are sent.')
  })
})
