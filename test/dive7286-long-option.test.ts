// DIVE-7286: a long answer gets a cut button instead of killing every button.
// lodar 2026-10-29 16:30Z, forwarding creative's choice: "telegram buttons didn't
// work here. only plain text". Its option 1 was a 119-character reply draft, and
// parseOptions() returned [] for any label over 90 characters, so both buttons
// went. The pick line "I'd send …" had no cue word either; the ⭐ already counts
// as the cue since DIVE-7061, so length was the one gate left that failed.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionChoices, parseOptions } from '../plugins/telegram/tna'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const read = (...p: string[]) => readFileSync(join(PLUGINS, ...p), 'utf8')
const BRIDGES = ['telegram', 'telegram-agy', 'telegram-codex', 'telegram-grok', 'telegram-opencode', 'telegram-pi']

// Run a bridge's REAL optionButtons() (sliced out of its server.ts) against a
// recording keyboard: the button texts and the labels the tap cache stores.
function keyboardOf(bridge: string, text: string): { buttons: string[]; labels: string[] } {
  const src = read(bridge, 'server.ts')
  const at = src.indexOf('function optionButtons(')
  expect(at).toBeGreaterThan(0)
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/\): \{[^\n]*\} \{/, ') {').replace(/\(text: string\)/, '(text)')
  const max = Number(/const OPT_BTN_MAX = (\d+)/.exec(src)![1])
  class Kb { rows: string[] = []; text(t: string) { this.rows.push(t); return this } row() { return this } }
  const fn = new Function('optionChoices', 'YN_SUPPRESS', 'OPT_BTN_MAX', 'InlineKeyboard', `${body}\nreturn optionButtons`)
  const res = fn(optionChoices, /<!--\s*no-buttons\s*-->/, max, Kb)(text)
  return { buttons: (res.keyboard as Kb | undefined)?.rows ?? [], labels: res.labels ?? [] }
}

const DRAFT_1 = 'got the pdf. still no setup. if a bot runs your linkedin, try 5dive, it has a browser plugin: github.com/5dive-ai/5dive'
const DRAFT_2 = 'asked for your setup, got a pdf. the funnel works, respect'
const CREATIVE_1630 = `I'd send the joke + pitch: he's selling to you, so this is your one shot to sell back.\n1. ⭐ ${DRAFT_1}\n2. ${DRAFT_2}`

describe("creative's 16:30Z message gets its buttons (DIVE-7286)", () => {
  test('0. the draft really is over the old 90-character limit', () => expect(DRAFT_1.length).toBe(119))
  test('1. two options, ⭐ on 1, full labels', () =>
    expect(optionChoices(CREATIVE_1630)).toEqual([
      { marker: '1', label: DRAFT_1, pick: true },
      { marker: '2', label: DRAFT_2, pick: false },
    ]))
  test.each(BRIDGES)('2. %s: 2 buttons, ⭐ on 1, each at most 90 characters', b => {
    const { buttons } = keyboardOf(b, CREATIVE_1630)
    expect(buttons.length).toBe(2)
    expect(buttons[0]!.startsWith('1) ⭐ got the pdf. still no setup.')).toBe(true)
    expect(buttons[0]!.endsWith('…')).toBe(true)
    expect(buttons[1]!.startsWith('2) asked for your setup')).toBe(true)
    for (const t of buttons) expect([...t].length).toBeLessThanOrEqual(90)
  })
  test.each(BRIDGES)('3. %s: a tap on 1 sends the full 119-character line (cache path)', b =>
    expect(keyboardOf(b, CREATIVE_1630).labels[0]).toBe(DRAFT_1))
  // The fallback when the cache is gone (restart between send and tap) re-parses
  // the tapped message's text; it must accept the same long line.
  test('4. a tap on 1 sends the full line (re-parse path)', () =>
    expect(parseOptions(CREATIVE_1630).map(o => o.label)[0]).toBe(DRAFT_1))
  test.each(BRIDGES)('5. %s: the tap resolve re-parses with parseOptions', b =>
    expect(read(b, 'server.ts')).toContain("parseOptions(msg.text).map(o => o.label)"))
})

describe('the other gates still hold (DIVE-7286)', () => {
  test('6. an unstarred numbered step list with no cue gets no buttons, long lines or not', () => {
    expect(optionChoices('Done:\n1. pulled main\n2. restarted the bot')).toEqual([])
    expect(optionChoices(`Done:\n1. ${'pulled main and rebuilt '.repeat(5)}\n2. restarted`)).toEqual([])
  })
  test('7. a starred Russian list with no cue word gets buttons', () =>
    expect(optionChoices(`Я бы отправил шутку.\n1. ⭐ ${'длинный черновик ответа '.repeat(5).trim()}\n2. Короткий ответ`).length).toBe(2))
  test('8. nine options get none', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${i + 1}. ${i === 0 ? '⭐ ' : ''}opt`).join('\n')
    expect(optionChoices(`Which one?\n${nine}`)).toEqual([])
  })
  test('9. a broken sequence still gets none', () =>
    expect(optionChoices(`Which?\n1. ⭐ ${DRAFT_1}\n3. ${DRAFT_2}`)).toEqual([]))
})
