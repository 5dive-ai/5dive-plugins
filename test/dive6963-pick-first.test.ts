// DIVE-6963: since DIVE-6859 told agents a numbered list becomes tap buttons,
// they ended questions on a bare list with no pick of their own (lodar 10-26:
// "some of the agents dont give their recs now when they give option button").
// Every place that tells an agent how to get those buttons must also say: name
// your pick and why just before the list, list it first, and say "no
// preference" only when it is purely the owner's taste.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LITE_INSTRUCTIONS } from '../plugins/telegram/hooks/lib/lite'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const read = (...p: string[]) => readFileSync(join(PLUGINS, ...p), 'utf8')

// The block the MCP server actually sends, as tests/telegram_instructions_unit.sh extracts it.
const defaultBlock = (() => {
  const lines = read('telegram', 'server.ts').split('\n')
  const start = lines.indexOf('    instructions: [')
  const end = lines.findIndex((l, i) => i > start && /^    \]\.join/.test(l))
  return lines.slice(start + 1, end).join('\n')
})()

// The sentence that carries the button rule, so the clause cannot drift to a
// different paragraph (or a comment) and still pass.
const buttonRule = (text: string) => {
  const at = text.search(/numbered list/)
  expect(at).toBeGreaterThanOrEqual(0)
  const from = text.lastIndexOf('\n', at) + 1
  const to = text.indexOf('\n\n', at)
  return text.slice(from, to < 0 ? undefined : to)
}

const carriesPickFirst = (rule: string) =>
  /would (pick|choose)/.test(rule) && /\bwhy\b/.test(rule) && /listed first|put that answer first/.test(rule) && /no preference/.test(rule)

const SURFACES: [string, string][] = [
  ['telegram default MCP instructions', defaultBlock],
  ['telegram lite MCP instructions', LITE_INSTRUCTIONS],
  ['dashboard lite copy', read('dashboard', 'hooks', 'lib', 'lite.ts')],
  ['telegram notify-user skill', read('telegram', 'skills', 'notify-user', 'SKILL.md')],
  ['telegram-agy AGENTS.md', read('telegram-agy', 'AGENTS.md')],
  ['telegram-codex AGENTS.md', read('telegram-codex', 'AGENTS.md')],
  ['telegram-grok AGENTS.md', read('telegram-grok', 'AGENTS.md')],
]

describe('every button instruction names a pick first', () => {
  test.each(SURFACES)('%s', (_, text) => expect(carriesPickFirst(buttonRule(text))).toBe(true))
})

describe('the default and lite blocks keep the DIVE-6859 rule intact', () => {
  test.each([['default', defaultBlock], ['lite', LITE_INSTRUCTIONS]])('%s', (_, text) => {
    const rule = buttonRule(text)
    expect(rule).toContain('2 to 8 answers, each under 90 characters')
    expect(rule).toMatch(/becomes a (tap )?button/)
    expect(rule).toContain('Yes/No buttons by itself')
  })
})

describe('the notify-user skill no longer says "not a numbered list"', () => {
  test('stale curl-the-Bot-API advice is gone', () => {
    const skill = read('telegram', 'skills', 'notify-user', 'SKILL.md')
    expect(skill).not.toContain('not a numbered list')
    expect(skill).not.toContain('inline_keyboard')
  })
})

describe('negative control: the 0.5.115 wording fails the check', () => {
  test('a bare list rule is red', () => {
    const old = "'Exception to no lists: a question with set answers ends the message as a numbered list, one short line per answer (1. … 2. …; 2 to 8 answers, each under 90 characters, all in one message): each line becomes a tap button. A single yes/no question at the end gets Yes/No buttons by itself.',"
    expect(carriesPickFirst(buttonRule(old))).toBe(false)
  })
  test('a clause in a different paragraph does not count', () => {
    const moved = 'End with a numbered list; each line becomes a button.\n\nName the answer you would pick and why; it is listed first; or say no preference.'
    expect(carriesPickFirst(buttonRule(moved))).toBe(false)
  })
})
