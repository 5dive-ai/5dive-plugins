// DIVE-1429: the Yes/No detector (DIVE-332) must fire ONLY on polar (yes/no)
// questions. lodar hit a false ✅Yes/❌No keyboard on "here. what's up?" three
// times — an OPEN wh-question a Yes/No answer can't address. yesNoChoice() is the
// pure core in tna.ts (sibling of optionChoices); server.ts wraps it into the
// keyboard. This pins: wh-questions get NO buttons, polar questions still do.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { yesNoChoice } from '../plugins/telegram/tna'

describe('yesNoChoice — wh-questions suppressed (DIVE-1429)', () => {
  const NO = [
    'here. what\'s up?',
    'what\'s up?',
    'how are you?',
    'what do you think?',
    'which one do you want?',
    'why did that fail?',
    'who should own this?',
    'where should I put it?',
    'when do you need it?',
    'Working on it. How should I proceed?',
  ]
  test.each(NO)('no keyboard for open wh-question: %j', q => {
    expect(yesNoChoice(q)).toBe(false)
  })
})

describe('yesNoChoice — polar questions still get buttons', () => {
  const YES = [
    'ready to ship?',
    'should I proceed?',
    'Done. Ship it?',
    'Can you confirm?',
    'Is this good?',
    'Approve?',
  ]
  test.each(YES)('keyboard for polar question: %j', q => {
    expect(yesNoChoice(q)).toBe(true)
  })
})

describe('yesNoChoice — pre-existing carve-outs preserved', () => {
  test('non-question → no keyboard', () => expect(yesNoChoice('on it, working now.')).toBe(false))
  test('"A or B?" choice → no keyboard (falls to option buttons)', () =>
    expect(yesNoChoice('ship now or wait?')).toBe(false))
  test('multiple "?" → no keyboard', () => expect(yesNoChoice('really? are you sure?')).toBe(false))
})

// Parity: the wh-guard must live in every shipped tna.ts, not just the baseline,
// or a fork DM regresses the exact bug we just fixed.
describe('yesNoChoice shipped across all telegram plugins (DIVE-1429 parity)', () => {
  const PLUGINS = join(import.meta.dir, '..', 'plugins')
  const ALL = ['telegram', 'telegram-grok', 'telegram-codex', 'telegram-agy', 'telegram-pi', 'telegram-opencode']
  test.each(ALL)('%s/tna.ts exports yesNoChoice with the wh-opener guard', p => {
    const src = readFileSync(join(PLUGINS, p, 'tna.ts'), 'utf8')
    expect(src).toContain('export function yesNoChoice')
    expect(src).toMatch(/WH_OPENER_RE\s*=\s*\/\^\(what\|which\|who/)
  })
})
