// DIVE-1335: the automatic Yes/No keyboard must reject open wh-questions while
// preserving ordinary yes/no-style questions. server.ts is unsafe to import
// because it starts long-polling, so exercise its production classifier here
// and pin the detector wiring with a source assertion.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startsWithWhInterrogative } from '../plugins/telegram/yes-no'

describe('Yes/No wh-question guard', () => {
  test.each([
    'What can I help you with',
    'which model should we use',
    'Who owns this',
    'whom should I contact',
    'Whose branch is this',
    'where did it fail',
    'When should this ship',
    'why did it stop',
    'How can I help',
  ])('rejects open question: %s', question => {
    expect(startsWithWhInterrogative(`  ${question}`)).toBe(true)
  })

  test.each([
    'Is this ready',
    'Are we done',
    'Do you approve',
    'Can I ship it',
    'Should I continue',
  ])('keeps yes/no-style question eligible: %s', question => {
    expect(startsWithWhInterrogative(question)).toBe(false)
  })

  test('server detector applies the guard after isolating the trailing question', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
    const lastQ = server.indexOf("const lastQ = trimmed.split")
    const whGuard = server.indexOf('if (startsWithWhInterrogative(lastQ))', lastQ)
    const keyboard = server.indexOf("new InlineKeyboard().text('✅ Yes'", whGuard)
    expect(lastQ).toBeGreaterThan(-1)
    expect(whGuard).toBeGreaterThan(lastQ)
    expect(keyboard).toBeGreaterThan(whGuard)
  })
})
