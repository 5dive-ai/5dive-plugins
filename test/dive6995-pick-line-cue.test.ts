// DIVE-6995: the pick line is a choice cue. Since DIVE-6963 the line before a
// numbered choice names the agent's own pick, often as a statement with no '?'.
// A partner agent's 07:00Z voice-settings choice to lodar («Советую …» over three numbered
// options, in Russian) matched no cue, so it went out as plain text and lodar had
// to type «1». optionChoices() now counts recommend/suggest/go with and the Russian
// pick words; a numbered STEP list with none of them still gets no buttons.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionChoices } from '../plugins/telegram/tna'

// The partner agent's message is not readable from this seat (its channel log
// is private to that seat), so this is the same SHAPE as the row records it: a
// Russian «Советую …» statement, no '?', no other cue word, three numbered options.
const PARTNER_0700 = 'В настройках голоса сейчас видно имя OpenRouter. Советую первое: клиенту не нужно знать поставщика.\n1. Убрать имя OpenRouter\n2. Оставить как есть\n3. Показывать только владельцу'

const labels = (t: string) => optionChoices(t).map(o => o.label)

describe('optionChoices — a pick line is a cue (DIVE-6995)', () => {
  test('1. the partner agent\'s 07:00Z shape gets 3 option buttons', () =>
    expect(labels(PARTNER_0700)).toEqual(['Убрать имя OpenRouter', 'Оставить как есть', 'Показывать только владельцу']))
  test('2. "I recommend the first." gets 2', () =>
    expect(labels('I recommend the first.\n1. Remove\n2. Keep')).toEqual(['Remove', 'Keep']))
  const YES = [
    'I suggest b, it is cheaper.\na. Rebuild\nb. Patch',
    'I\'d go with 2.\n1. Wait for CI\n2. Ship now',
    'My recommendation: 1.\n1. Keep\n2. Drop',
    'Рекомендую второй.\n1. Ждать\n2. Выкатить сейчас',
    'Предлагаю так.\n1. Лендинг\n2. Бот',
    'Выбираем из двух.\n1. Лендинг\n2. Бот',
    'Есть два варианта.\n1. Лендинг\n2. Бот',
    'Скажи, какой.\n1. Лендинг\n2. Бот',
    'СОВЕТУЮ первый.\n1. Лендинг\n2. Бот',
  ]
  test.each(YES)('buttons: %j', t => expect(optionChoices(t).length).toBeGreaterThan(1))
})

describe('optionChoices — negative controls still get none (DIVE-6995)', () => {
  test('3. a Russian step list with no cue', () =>
    expect(optionChoices('Сделал так:\n1. Обновил\n2. Перезапустил')).toEqual([]))
  test('4. an English step list with no cue', () =>
    expect(optionChoices('Steps:\n1. pull\n2. restart')).toEqual([]))
  // A Russian word that only CONTAINS a cue stem is not one (lookbehind, not `\b`).
  test('a stem inside another word is not a cue', () =>
    expect(optionChoices('Пересоветовался с командой:\n1. Обновил\n2. Перезапустил')).toEqual([]))
  test('a pick line over a broken sequence still gets none', () =>
    expect(optionChoices('Советую первый.\n1. Лендинг\n3. Бот')).toEqual([]))
})

describe('every bridge carries the same tna.ts (DIVE-6995)', () => {
  const PLUGINS = join(import.meta.dir, '..', 'plugins')
  const base = readFileSync(join(PLUGINS, 'telegram', 'tna.ts'), 'utf8')
  test.each(['telegram-agy', 'telegram-codex', 'telegram-grok', 'telegram-opencode', 'telegram-pi'])(
    '%s', p => expect(readFileSync(join(PLUGINS, p, 'tna.ts'), 'utf8')).toBe(base))
})
