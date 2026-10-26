// DIVE-6988: a '?' inside a quote is not a question to the reader. main's 05:38Z
// onboarding reply quoted "what should Olivia do first?" and ended in a real yes/no,
// so it held two '?', got no ✅Yes/❌No, and lodar skimmed past it (DIVE-6987 started
// 40 min late). yesNoChoice() now reads the text with quoted spans emptied; every
// DIVE-332/1429/6859 rule is unchanged and pinned again here as a negative control.
import { describe, test, expect } from 'bun:test'
import { yesNoChoice } from '../plugins/telegram/tna'

// Verbatim from main's Telegram msglog, 2026-10-26 05:38Z.
const MAIN_0538 = 'Good bones: 3 taps from ad to a working agent, and sign-in before card is the order we can build.\n\nOne change: ask "what should Olivia do first?" before the card. Then the card screen says "Start Olivia on: find me customers", paying for a job, not a subscription. Same taps, no server cost before payment.\n\nWant dev2 to mock that order?'

describe('yesNoChoice — a quoted question does not cost the buttons (DIVE-6988)', () => {
  test('1. main\'s 05:38Z text gets buttons', () => expect(yesNoChoice(MAIN_0538)).toBe(true))
  const YES = [
    'I\'ll ask “ready?” first. Ship it?',
    'Rename it «Готово?» before launch. Do it?',
    'The check is `a ? b : c` today. Simplify it?',
    'Code:\n```\nconst x = ok ? 1 : 2\n```\nMerge it?',
    'He said \'why?\' so I answered. Close the row?',
    // A quoted "A or B" is a title, not the choice being asked.
    'Name the button "Now or later". OK?',
  ]
  test.each(YES)('buttons: %j', q => expect(yesNoChoice(q)).toBe(true))
})

describe('yesNoChoice — negative controls still get none (DIVE-6988)', () => {
  test('2. two real unquoted questions', () => expect(yesNoChoice('Ship it? Or wait for CI?')).toBe(false))
  test('3. wh-question ending (DIVE-1429)', () => expect(yesNoChoice('here. what\'s up?')).toBe(false))
  test('4a. "A or B?" (DIVE-6859)', () => expect(yesNoChoice('A or B?')).toBe(false))
  test('4b. «A или B?» (DIVE-6859)', () => expect(yesNoChoice('A или B?')).toBe(false))
  test('5. only "?" is inside a quote, no trailing question', () =>
    expect(yesNoChoice('I\'ll ask "ready?" later.')).toBe(false))
  test('a quoted question with nothing after it', () => expect(yesNoChoice('I\'ll ask "ready?"')).toBe(false))
  // Apostrophes must not pair into a "quote" that swallows a real '?'.
  test('apostrophes do not hide a second question', () =>
    expect(yesNoChoice('Can\'t decide: ship it? Or we\'re waiting?')).toBe(false))
  test('an unclosed quote hides nothing', () => expect(yesNoChoice('He said "ship it? Merge?')).toBe(false))
  test('a quote does not reach across lines', () =>
    expect(yesNoChoice('Title "Ship\nit?" Merge it?')).toBe(false))
  test('a wh-question after a quote is still open', () =>
    expect(yesNoChoice('You wrote "done?". Which one?')).toBe(false))
})
