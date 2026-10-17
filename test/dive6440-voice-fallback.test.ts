// DIVE-6440 (lodar, 2026-10-17): a client's voice note got no answer at all,
// neither voice nor text, and the agent insisted it had answered. edge-tts was
// refused (DIVE-6436), so no OGG was made, and the reply carrying the text and
// that path threw on the missing file before any text was sent.
//
// server.ts long-polls on import, so the pure logic is tested from voicefail.ts
// and the reply handler's wiring is checked in its own source block.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  unsendableAudio, isAudioFile, voiceFailedNote, voiceFailedError, MIN_AUDIO_BYTES,
} from '../plugins/telegram/voicefail.ts'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dive6440-'))
  writeFileSync(join(dir, 'empty.ogg'), '')
  writeFileSync(join(dir, 'headers.ogg'), Buffer.alloc(137)) // ffmpeg's empty-PCM OGG (DIVE-5162)
  writeFileSync(join(dir, 'reply.ogg'), Buffer.alloc(4096))
  writeFileSync(join(dir, 'tiny.png'), Buffer.alloc(10))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('unsendableAudio', () => {
  test('a voice note that was never made is a failure, not an error that drops the text', () => {
    expect(unsendableAudio(join(dir, 'missing.ogg'))).toContain('never made')
  })

  test('an empty or header-only OGG is a failure', () => {
    expect(unsendableAudio(join(dir, 'empty.ogg'))).toContain('(0 bytes)')
    expect(unsendableAudio(join(dir, 'headers.ogg'))).toContain('(137 bytes)')
  })

  test('a real voice note sends', () => {
    expect(unsendableAudio(join(dir, 'reply.ogg'))).toBeNull()
  })

  test('other attachments keep their own errors', () => {
    expect(unsendableAudio(join(dir, 'missing.pdf'))).toBeNull()
    expect(unsendableAudio(join(dir, 'tiny.png'))).toBeNull()
  })

  test('every audio extension the reply treats as a voice note', () => {
    for (const ext of ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.WAV']) {
      expect(isAudioFile(`/a/v${ext}`), ext).toBe(true)
      expect(unsendableAudio(`/nope/v${ext}`), ext).not.toBeNull()
    }
    expect(MIN_AUDIO_BYTES).toBeGreaterThan(137)
  })
})

describe('what the agent is told', () => {
  test('text sent: the voice note did not go, and say so', () => {
    const n = voiceFailedNote(['x'], true)
    expect(n).toStartWith('VOICE NOTE NOT SENT')
    expect(n).toContain('text answer only')
    expect(n).toContain('did not work this time')
  })

  test('no text in the call: send the answer as text', () => {
    for (const s of [voiceFailedNote(['x'], false), voiceFailedError(['x'])]) {
      expect(s).toContain('VOICE NOTE NOT SENT')
      expect(s).toContain('send it as text now')
      expect(s).not.toContain('text answer only')
    }
  })
})

describe('the telegram reply handler', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
  const start = s.indexOf("case 'reply': {")
  const reply = s.slice(start, s.indexOf("case 'react':", start))

  test('imports the logic', () => {
    expect(s).toContain("from './voicefail.ts'")
  })

  test('drops a failed voice note BEFORE the file pre-check that used to throw on it', () => {
    const drop = reply.indexOf('unsendableAudio(f)')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(reply.indexOf('assertSendable(f)'))
    expect(reply).not.toContain('for (const f of files)')
    expect(reply.match(/for \(const f of sendFiles\)/g)?.length).toBe(2)
  })

  test('a call with only a failed voice note fails before anything is sent', () => {
    const early = reply.indexOf('throw new Error(voiceFailedError(voiceFailed))')
    expect(early).toBeGreaterThan(-1)
    expect(early).toBeLessThan(reply.indexOf('bot.api.sendMessage('))
  })

  test('Telegram refusing the voice note is reported, not thrown past the sent text', () => {
    const branch = reply.slice(reply.indexOf('} else if (isAudioFile(f)) {'))
    expect(branch.indexOf('try {')).toBeGreaterThan(-1)
    expect(branch.indexOf('voiceFailed.push(`Telegram refused')).toBeGreaterThan(branch.indexOf('catch (err)'))
  })

  test('the result and the rolling log both say the voice note did not go', () => {
    expect(reply).toContain('voiceFailedNote(voiceFailed, chunks.length > 0)')
    expect(reply).toContain("'\\n\\n[voice note not sent]'")
    // and markReplySent is never reached by a call that delivered nothing
    expect(reply.lastIndexOf('throw new Error(voiceFailedError(voiceFailed))'))
      .toBeLessThan(reply.indexOf('markReplySent()'))
  })
})
