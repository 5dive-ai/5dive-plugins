// DIVE-7061: a ⭐ on an option is a choice cue. marketing's 02:12Z choice to lodar
// put its pick line as a statement ("I'd keep 22, because …"), no '?' and none of
// DIVE-6995's cue words, with a ⭐ on option 1. parseOptions() saw the pick, but
// optionChoices() counted only words, so the list went out as plain text
// (lodar: "no buttons"). A starred option now gives the buttons on its own; a
// step list carries no star and still gets none.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionChoices } from '../plugins/telegram/tna'

// marketing's message is not readable from this seat (its channel log is private
// to that seat), so this is the SHAPE the row records: a statement pick line, no
// '?', no cue word, two numbered options, the first starred.
const MARKETING_0212 = 'I\'d keep 22, because I counted it.\n1. ⭐ Keep 22\n2. Say over 30'

describe('optionChoices — a ⭐ option is the cue (DIVE-7061)', () => {
  test('1. marketing\'s 02:12Z shape gets 2 buttons, the first starred', () =>
    expect(optionChoices(MARKETING_0212)).toEqual([
      { marker: '1', label: 'Keep 22', pick: true },
      { marker: '2', label: 'Say over 30', pick: false },
    ]))
  test('2. a Russian statement pick line with no cue word and a ⭐ option gets buttons', () =>
    expect(optionChoices('Я бы оставил 22, так честнее.\n1. ⭐ Оставить 22\n2. Написать больше 30').map(o => o.label))
      .toEqual(['Оставить 22', 'Написать больше 30']))
  const YES = [
    'I\'d go for b.\na. Rebuild\nb. ⭐ Patch',
    'My vote: the second.\n1. Wait for CI\n2. ⭐ Ship now',
    '⭐ 1. Keep\n2. Drop',
  ]
  test.each(YES)('buttons: %j', t => expect(optionChoices(t).length).toBeGreaterThan(1))
})

describe('optionChoices — no cue and no ⭐ still gets none (DIVE-7061)', () => {
  test('3. an English step list', () =>
    expect(optionChoices('Steps:\n1. pull\n2. restart')).toEqual([]))
  test('4. a Russian step list', () =>
    expect(optionChoices('Сделал так:\n1. Обновил\n2. Перезапустил')).toEqual([]))
  test('a ⭐ over a broken sequence still gets none', () =>
    expect(optionChoices('I\'d keep 22.\n1. ⭐ Keep 22\n3. Say over 30')).toEqual([]))
})

describe('every bridge carries the same tna.ts (DIVE-7061)', () => {
  const PLUGINS = join(import.meta.dir, '..', 'plugins')
  const base = readFileSync(join(PLUGINS, 'telegram', 'tna.ts'), 'utf8')
  test.each(['telegram-agy', 'telegram-codex', 'telegram-grok', 'telegram-opencode', 'telegram-pi'])(
    '%s', p => expect(readFileSync(join(PLUGINS, p, 'tna.ts'), 'utf8')).toBe(base))
})
