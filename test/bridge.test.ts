import { expect, test } from 'bun:test'
import {
  chunkForTelegram,
  yesNoButtons,
  optionButtons,
  describeTool,
  MUTATING_TOOLS,
} from '../server'

// Importing ../server must NOT boot the bot or poll Telegram. The import.meta.main
// guard keeps all I/O off the import path; if it regressed, this test file would
// hang or exit before any assertion ran.

test('chunkForTelegram: short text is a single chunk', () => {
  const chunks = chunkForTelegram('hello world')
  expect(chunks).toEqual(['hello world'])
})

test('chunkForTelegram: long text splits at boundaries, each within limit', () => {
  const limit = 100
  // Paragraphs separated by blank lines, total well over the limit.
  const para = 'word '.repeat(30).trim()           // ~149 chars
  const text = [para, para, para].join('\n\n')
  const chunks = chunkForTelegram(text, limit)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit)
  // No content is lost (modulo whitespace at split seams).
  expect(chunks.join(' ').replace(/\s+/g, ' ').trim())
    .toBe(text.replace(/\s+/g, ' ').trim())
})

test('yesNoButtons: single trailing yes/no question yields a keyboard', () => {
  const { keyboard, stripped } = yesNoButtons('Should I deploy the build now?')
  expect(keyboard).toBeDefined()
  expect(stripped).toBe('Should I deploy the build now?')
})

test('yesNoButtons: an "A or B?" question does not get a keyboard', () => {
  const { keyboard } = yesNoButtons('Do you want red or blue?')
  expect(keyboard).toBeUndefined()
})

test('yesNoButtons: the no-buttons marker suppresses and is stripped', () => {
  const { keyboard, stripped } = yesNoButtons('Ready to ship? <!-- no-buttons -->')
  expect(keyboard).toBeUndefined()
  expect(stripped).toBe('Ready to ship?')
  expect(stripped).not.toContain('no-buttons')
})

test('optionButtons: a lettered choice list yields labelled buttons', () => {
  const text = [
    'Which environment should I target?',
    'a) staging',
    'b) production',
    'c) local',
  ].join('\n')
  const { keyboard, labels } = optionButtons(text)
  expect(keyboard).toBeDefined()
  expect(labels).toEqual(['staging', 'production', 'local'])
})

test('optionButtons: plain prose yields no buttons', () => {
  const { keyboard } = optionButtons('Just a normal reply with no options.')
  expect(keyboard).toBeUndefined()
})

test('describeTool: bash renders the command string', () => {
  expect(describeTool('bash', { command: 'ls -la /tmp' })).toBe('ls -la /tmp')
})

test('describeTool: write/edit render "<tool> <path>"', () => {
  expect(describeTool('write', { path: '/etc/hosts' })).toBe('write /etc/hosts')
  expect(describeTool('edit', { path: 'src/index.ts' })).toBe('edit src/index.ts')
})

test('MUTATING_TOOLS gates bash/write/edit but not read-only tools', () => {
  expect(MUTATING_TOOLS.has('bash')).toBe(true)
  expect(MUTATING_TOOLS.has('write')).toBe(true)
  expect(MUTATING_TOOLS.has('edit')).toBe(true)
  expect(MUTATING_TOOLS.has('read')).toBe(false)
  expect(MUTATING_TOOLS.has('ls')).toBe(false)
  expect(MUTATING_TOOLS.has('grep')).toBe(false)
})
