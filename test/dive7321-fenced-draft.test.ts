// DIVE-7321: a numbered list inside a ``` fence is text to copy, not a choice.
// lodar 2026-10-30 11:39Z: "our telegram plugin added buttons to your reply. can
// file fix?" main sent him a Reddit reply draft in a MarkdownV2 code block (msg
// 52457); the draft answered a commenter's two questions as "1. … 2. …", and its
// own "which agent is asking" passed the cue gate, so it went out with two option
// buttons. parseOptions() and the cue test now skip fenced lines, the way
// yesNoChoice() already did (DIVE-6988).
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionChoices, parseOptions } from '../plugins/telegram/tna'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const read = (...p: string[]) => readFileSync(join(PLUGINS, ...p), 'utf8')
const BRIDGES = ['telegram', 'telegram-agy', 'telegram-codex', 'telegram-grok', 'telegram-opencode', 'telegram-pi']

// Run a bridge's REAL optionButtons() (sliced out of its server.ts) against a
// recording keyboard, as test/dive7286-long-option.test.ts does.
function keyboardOf(bridge: string, text: string): string[] {
  const src = read(bridge, 'server.ts')
  const at = src.indexOf('function optionButtons(')
  expect(at).toBeGreaterThan(0)
  const body = src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/\): \{[^\n]*\} \{/, ') {').replace(/\(text: string\)/, '(text)')
  const max = Number(/const OPT_BTN_MAX = (\d+)/.exec(src)![1])
  class Kb { rows: string[] = []; text(t: string) { this.rows.push(t); return this } row() { return this } }
  const fn = new Function('optionChoices', 'YN_SUPPRESS', 'OPT_BTN_MAX', 'InlineKeyboard', `${body}\nreturn optionButtons`)
  const res = fn(optionChoices, /<!--\s*no-buttons\s*-->/, max, Kb)(text)
  return (res.keyboard as Kb | undefined)?.rows ?? []
}

const DRAFT = [
  '1. no, sandboxed ones get no browser. the others share one chrome per login, which agent is asking.',
  '2. tokens per agent and per model, no dollars. each turn counts once.',
].join('\n')
// main's msg 52457 as the row records it (MarkdownV2: the '.' outside the fence is escaped).
const MAIN_52457 = `right, his question assumes they get one\\. fixed:\n\`\`\`\n${DRAFT}\n\`\`\``
const labels = (t: string) => optionChoices(t).map(o => o.label)

describe("main's fenced draft gets no buttons (DIVE-7321)", () => {
  test('0. the draft itself reads as a choice: a clean 1,2 run with a cue word', () =>
    expect(labels(`${DRAFT}`)).toHaveLength(2))
  test('1. msg 52457 gets no option list', () => expect(optionChoices(MAIN_52457)).toEqual([]))
  test('2. the fenced lines are not option lines at all', () => expect(parseOptions(MAIN_52457)).toEqual([]))
  test('3. a "?" outside the fence does not bring them back', () =>
    expect(optionChoices(`Which reply works?\n\`\`\`\n${DRAFT}\n\`\`\``)).toEqual([]))
  test('4. a language tag on the fence changes nothing', () =>
    expect(optionChoices(`Draft:\n\`\`\`text\n${DRAFT}\n\`\`\``)).toEqual([]))
  test('5. an unclosed fence runs to the end', () =>
    expect(optionChoices(`Which one?\n\`\`\`\n${DRAFT}`)).toEqual([]))
  for (const b of BRIDGES) test(`6. ${b}: no keyboard on msg 52457`, () => expect(keyboardOf(b, MAIN_52457)).toEqual([]))
})

describe('a real choice still gets its buttons (negative controls)', () => {
  test('7. the same list OUTSIDE a fence with a "?" pick line gets 2 buttons', () =>
    expect(labels(`Which reply works?\n${DRAFT}`)).toEqual([DRAFT.split('\n')[0]!.slice(3), DRAFT.split('\n')[1]!.slice(3)]))
  test('8. a fenced draft and a real list below it: only the outside list', () =>
    expect(labels(`Draft:\n\`\`\`\n${DRAFT}\n\`\`\`\nWhich do I post?\n1. ⭐ Post it\n2. Hold`)).toEqual(['Post it', 'Hold']))
  test('9. a cue word only inside the fence is not a cue for the list outside it', () =>
    expect(optionChoices(`\`\`\`\nwhich one?\n\`\`\`\nSteps:\n1. Pull\n2. Build`)).toEqual([]))
  test('10. inline code on an option line keeps the line', () =>
    expect(labels('Which flag?\n1. `--fresh`\n2. `--tier=0`')).toEqual(['`--fresh`', '`--tier=0`']))
  for (const b of BRIDGES) test(`11. ${b}: the outside list keeps its keyboard`, () =>
    expect(keyboardOf(b, `Draft:\n\`\`\`\n${DRAFT}\n\`\`\`\nWhich do I post?\n1. ⭐ Post it\n2. Hold`)).toEqual(['1) ⭐ Post it', '2) Hold']))
})

describe('tap side', () => {
  test('12. plain-text re-parse after a restart resolves the outside list, not the draft', () =>
    expect(parseOptions(`\`\`\`\n${DRAFT}\n\`\`\`\nWhich?\n1. Post it\n2. Hold`).map(o => o.label)).toEqual(['Post it', 'Hold']))
  test('13. MarkdownV2 rendered text (fence gone) does not resolve to a wrong label', () =>
    expect(parseOptions(`${DRAFT}\nWhich?\n1. Post it\n2. Hold`)).toEqual([]))
})

describe('every bridge ships the same tna.ts', () => {
  const base = read('telegram', 'tna.ts')
  for (const b of BRIDGES.slice(1)) test(`14. ${b}`, () => expect(read(b, 'tna.ts')).toBe(base))
})
