// DIVE-5162: on a lite (partner client) bot, a failed voice reply led the agent
// to change the box's voice settings itself and ask the CLIENT for a key and for
// consent to send text elsewhere. The lite instructions carry one line against
// it; the default profile's instructions are not touched.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { LITE_INSTRUCTIONS } from '../plugins/telegram/hooks/lib/lite'

describe('DIVE-5162 lite: a failed voice reply never becomes a question for the client', () => {
  test('the lite block says what to do when a voice reply fails', () => {
    expect(LITE_INSTRUCTIONS).toContain('If a voice reply of yours does not work, answer in text and say only that the voice reply did not work this time.')
  })
  test('…and forbids the three things the client was asked', () => {
    expect(LITE_INSTRUCTIONS).toContain('Never ask them to pick a setting, give a key or password, or agree to send anything somewhere else')
    expect(LITE_INSTRUCTIONS).toContain('never change voice settings yourself')
  })
  test('…in consumer wording: no platform, backend or vendor names', () => {
    const line = LITE_INSTRUCTIONS.split('\n').find((l) => l.startsWith('Voice messages:'))!
    expect(line).toBeDefined()
    for (const word of ['5dive', 'OpenRouter', 'openrouter', 'backend', 'edge-tts', 'sudo', 'API', 'Gemini'])
      expect(line).not.toContain(word)
  })
  test('the default profile does not carry the line (it is lite-only)', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
    expect(server).not.toContain('If a voice reply of yours does not work')
  })
})
