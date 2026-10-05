// lodar 2026-10-05: a Codex answer on Telegram showed "**bold**" with its
// asterisks. Plain-text sends (no parse_mode) drop Markdown syntax and keep the
// words. The negative arms matter as much: identifiers, globs, arithmetic and a
// fenced block's contents must reach the chat exactly as written.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripMarkdown } from '../plugins/telegram-codex/plain-text.ts'

describe('stripMarkdown', () => {
  test('bold, italic, strike, inline code', () => {
    expect(stripMarkdown('**Done.** The PR is *merged* and `main` is ~~red~~ green.'))
      .toBe('Done. The PR is merged and main is red green.')
  })
  test('headings and quotes keep their text', () => {
    expect(stripMarkdown('## Result\n> quoted line\nbody')).toBe('Result\nquoted line\nbody')
  })
  test('links become text (url)', () => {
    expect(stripMarkdown('see [the PR](https://github.com/x/y/pull/1)')).toBe('see the PR (https://github.com/x/y/pull/1)')
  })
  test('bold that spans a list item', () => {
    expect(stripMarkdown('- **Voice:** on\n- **Browser:** off')).toBe('- Voice: on\n- Browser: off')
  })
  test('identifiers, globs, arithmetic and bullets are not emphasis', () => {
    for (const s of ['agent_main and __init__', 'ls *.ts', '2*3*4', 'a * b * c', '* first item', 'x**2 + y**2']) {
      expect(stripMarkdown(s)).toBe(s)
    }
  })
  test('a fenced block keeps its contents verbatim; only the fences go', () => {
    expect(stripMarkdown('run:\n```bash\necho **not bold** `x`\n```\nthen **this**'))
      .toBe('run:\necho **not bold** `x`\nthen this')
  })
  test('plain text is unchanged', () => {
    const s = 'Fixed. Tests pass: 12 of 12.\n\nNext: deploy at 03:00.'
    expect(stripMarkdown(s)).toBe(s)
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'server.ts'), 'utf8')
  test('dispatcher outbox answers are stripped before send', () => {
    expect(src).toContain('const body = stripMarkdown(String(obj.text))')
  })
  test('reply and edit_message strip only when no parse_mode', () => {
    expect(src).toContain('const ynBody = parseMode ? ynRaw : stripMarkdown(ynRaw)')
    expect(src).toContain('editParseMode ? String(args.text) : stripMarkdown(String(args.text))')
  })
})
