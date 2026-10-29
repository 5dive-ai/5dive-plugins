// DIVE-7032: the agent's pick wears a ⭐ on its button. lodar 2026-10-26 14:48Z:
// "(my pick) should we marked in the options just like we do for human gates" …
// "put same star?". Since DIVE-6963 the line before a choice names the pick, but
// the keyboard alone did not show it; gate keyboards star their recommendation.
// The rule now asks for "1. ⭐ …"; parseOptions() lifts the star off the label
// (so the tapped answer never sees it) and marks `pick`;
// each bridge's optionButtons() puts it back on that one button.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionChoices, parseOptions } from '../plugins/telegram/tna'
import { LITE_INSTRUCTIONS } from '../plugins/telegram/hooks/lib/lite'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const read = (...p: string[]) => readFileSync(join(PLUGINS, ...p), 'utf8')
const BRIDGES = ['telegram', 'telegram-agy', 'telegram-codex', 'telegram-grok', 'telegram-opencode', 'telegram-pi']

// Run a bridge's REAL optionButtons() (sliced out of its server.ts) against a
// recording keyboard, so the arm grades the shipped keyboard line, not a copy.
function buttonsOf(bridge: string, text: string): string[] {
  const src = read(bridge, 'server.ts')
  const at = src.indexOf('function optionButtons(')
  expect(at).toBeGreaterThan(0)
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/\): \{[^\n]*\} \{/, ') {').replace(/\(text: string\)/, '(text)')
  const max = Number(/const OPT_BTN_MAX = (\d+)/.exec(src)![1])
  class Kb { rows: string[] = []; text(t: string) { this.rows.push(t); return this } row() { return this } }
  const fn = new Function('optionChoices', 'YN_SUPPRESS', 'OPT_BTN_MAX', 'InlineKeyboard', `${body}\nreturn optionButtons`)
  const ob = fn(optionChoices, /<!--\s*no-buttons\s*-->/, max, Kb)
  return (ob(text).keyboard as Kb | undefined)?.rows ?? []
}

const STARRED = 'I\'d go with your own server: it stays yours.\n1. ⭐ Your own 5dive server\n2. A 5dive cloud server'

describe('parseOptions — the ⭐ marks the pick (DIVE-7032)', () => {
  test('1. "1. ⭐ X" → label X, pick true; the rest pick false', () =>
    expect(optionChoices(STARRED)).toEqual([
      { marker: '1', label: 'Your own 5dive server', pick: true },
      { marker: '2', label: 'A 5dive cloud server', pick: false },
    ]))
  test('2. no star → no pick', () =>
    expect(optionChoices('Which one?\n1. Landing\n2. Bot').map(o => o.pick)).toEqual([false, false]))
  test('3. two stars → only the first stays a pick, both labels lose the star', () =>
    expect(optionChoices('Which one?\n1. ⭐ Landing\n2. ⭐ Bot\n3. Both')).toEqual([
      { marker: '1', label: 'Landing', pick: true },
      { marker: '2', label: 'Bot', pick: false },
      { marker: '3', label: 'Both', pick: false },
    ]))
  test('4. the pick need not be first: a star on 2 marks 2', () =>
    expect(optionChoices('Which one?\n1. Landing\n2. ⭐ Bot').map(o => o.pick)).toEqual([false, true]))
  test('5. a star before the marker ("⭐ 1. X") counts too', () =>
    expect(optionChoices('Which one?\n⭐ 1. Landing\n2. Bot')).toEqual([
      { marker: '1', label: 'Landing', pick: true },
      { marker: '2', label: 'Bot', pick: false },
    ]))
  test('6. ⭐ with the emoji variation selector (U+FE0F) is a star too', () =>
    expect(optionChoices('Which one?\n1. ⭐️ Landing\n2. Bot')[0]).toEqual({ marker: '1', label: 'Landing', pick: true }))
  test('7. letters work the same', () =>
    expect(optionChoices('Which one?\na) Landing\nb) ⭐ Bot').map(o => [o.marker, o.label, o.pick])).toEqual([['a', 'Landing', false], ['b', 'Bot', true]]))
  test('8. the star is not part of the label', () => {
    const ninety = 'x'.repeat(90)
    expect(parseOptions(`1. ⭐ ${ninety}\n2. y`).map(o => o.label)).toEqual([ninety, 'y'])
  })
  test('9. a star later in the line is text, not a pick', () =>
    expect(optionChoices('Which one?\n1. Landing ⭐\n2. Bot')[0]).toEqual({ marker: '1', label: 'Landing ⭐', pick: false }))
})

describe('every bridge keyboard stars the pick button (DIVE-7032)', () => {
  test.each(BRIDGES)('%s: "1. ⭐ X" → button "1) ⭐ X"', b =>
    expect(buttonsOf(b, STARRED)).toEqual(['1) ⭐ Your own 5dive server', '2) A 5dive cloud server']))
  test.each(BRIDGES)('%s: no star → no star on any button', b =>
    expect(buttonsOf(b, 'Which one?\n1. Landing\n2. Bot')).toEqual(['1) Landing', '2) Bot']))
  test.each(BRIDGES)('%s: two stars → one starred button', b =>
    expect(buttonsOf(b, 'Which one?\n1. ⭐ Landing\n2. ⭐ Bot')).toEqual(['1) ⭐ Landing', '2) Bot']))
  test.each(BRIDGES)('%s: the tapped answer carries no star', b => {
    const src = read(b, 'server.ts')
    expect(src).toContain('labels: opts.map(o => o.label)')
    expect(optionChoices(STARRED)[0]!.label).toBe('Your own 5dive server')
  })
})

describe('every bridge carries the same tna.ts (DIVE-7032)', () => {
  const base = read('telegram', 'tna.ts')
  test.each(BRIDGES.slice(1))('%s', p => expect(read(p, 'tna.ts')).toBe(base))
})

// The rule must tell the agent to star its pick, on the same sentence as the button rule.
const defaultBlock = (() => {
  const lines = read('telegram', 'server.ts').split('\n')
  const start = lines.indexOf('    instructions: [')
  const end = lines.findIndex((l, i) => i > start && /^    \]\.join/.test(l))
  return lines.slice(start + 1, end).join('\n')
})()
const buttonRule = (text: string) => {
  const at = text.search(/numbered list/)
  expect(at).toBeGreaterThanOrEqual(0)
  const from = text.lastIndexOf('\n', at) + 1
  const to = text.indexOf('\n\n', at)
  return text.slice(from, to < 0 ? undefined : to)
}
const asksForStar = (rule: string) => /⭐ at the start of its\s+line/.test(rule) && /star none/.test(rule)

describe('every button instruction asks for the ⭐ (DIVE-7032)', () => {
  test.each([
    ['telegram default MCP instructions', defaultBlock],
    ['telegram lite MCP instructions', LITE_INSTRUCTIONS],
    ['dashboard lite copy', read('dashboard', 'hooks', 'lib', 'lite.ts')],
    ['telegram-agy AGENTS.md', read('telegram-agy', 'AGENTS.md')],
    ['telegram-codex AGENTS.md', read('telegram-codex', 'AGENTS.md')],
    ['telegram-grok AGENTS.md', read('telegram-grok', 'AGENTS.md')],
  ])('%s', (_, text) => expect(asksForStar(buttonRule(text))).toBe(true))
  test('notify-user skill: the rule asks for it and the example shows it', () => {
    const skill = read('telegram', 'skills', 'notify-user', 'SKILL.md')
    expect(asksForStar(buttonRule(skill).replace(/\n/g, ' '))).toBe(true)
    expect(skill).toContain('1. ⭐ Landing page')
  })
  test('negative control: the 0.5.120 wording fails the check', () => {
    const old = "'Exception to no lists: a question with set answers ends the message as a numbered list, one short line per answer (1. … 2. …; 2 to 8 answers, each under 90 characters, all in one message): each line becomes a tap button. The line before the list names the answer you would pick and why, in a few words, and that answer is listed first; only when it is purely their taste, say you have no preference. A single yes/no question at the end gets Yes/No buttons by itself.',"
    expect(asksForStar(buttonRule(old))).toBe(false)
  })
})
