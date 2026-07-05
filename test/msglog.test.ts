// DIVE-1028: unit matrix for the bounded per-chat rolling message log that lets
// a restarted agent recover recent Telegram context (the Bot API has no
// history). Pure fs-backed logic lives in msglog.ts; this asserts append/rotate
// bounds, chat-id filename safety, body clamping, most-recent-chat selection,
// and transcript formatting.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendMessage,
  readMessages,
  chatLogFile,
  clampText,
  listChatIds,
  mostRecentChatId,
  formatRecent,
  MSGLOG_MAX_PER_CHAT,
  MSGLOG_MAX_TEXT,
  type LoggedMessage,
} from '../plugins/telegram/msglog'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msglog-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const mk = (over: Partial<LoggedMessage> = {}): LoggedMessage => ({
  ts: '2026-07-05T00:00:00.000Z',
  dir: 'in',
  user: 'lodar',
  text: 'hi',
  ...over,
})

describe('chatLogFile — id safety', () => {
  test('numeric DM id', () => expect(chatLogFile(dir, '12345')).toBe(join(dir, '12345.jsonl')))
  test('negative supergroup id kept', () => expect(chatLogFile(dir, '-1001234')).toBe(join(dir, '-1001234.jsonl')))
  test('path-traversal / junk stripped', () => {
    expect(chatLogFile(dir, '../../etc/passwd')).toBe(join(dir, 'unknown.jsonl'))
    expect(chatLogFile(dir, 'a/b;rm -rf')).toBe(join(dir, '-.jsonl')) // only the '-' survives
  })
})

describe('clampText', () => {
  test('short text untouched', () => expect(clampText('abc')).toBe('abc'))
  test('long text truncated with ellipsis', () => {
    const out = clampText('x'.repeat(MSGLOG_MAX_TEXT + 500))
    expect(out.length).toBe(MSGLOG_MAX_TEXT + 1) // +1 for the … glyph
    expect(out.endsWith('…')).toBe(true)
  })
  test('nullish safe', () => expect(clampText(undefined as any)).toBe(''))
})

describe('append / read round-trip', () => {
  test('appends and reads back in order', () => {
    appendMessage(dir, '99', mk({ text: 'first' }))
    appendMessage(dir, '99', mk({ dir: 'out', user: 'dev', text: 'reply' }))
    const rows = readMessages(dir, '99')
    expect(rows.map(r => r.text)).toEqual(['first', 'reply'])
    expect(rows[1]!.dir).toBe('out')
  })
  test('log file is written 0600', () => {
    appendMessage(dir, '7', mk())
    const mode = statSync(chatLogFile(dir, '7')).mode & 0o777
    expect(mode).toBe(0o600)
  })
  test('missing chat reads empty, never throws', () => {
    expect(readMessages(dir, 'nope')).toEqual([])
  })
  test('per-message body is clamped on write', () => {
    appendMessage(dir, '1', mk({ text: 'y'.repeat(MSGLOG_MAX_TEXT + 100) }))
    expect(readMessages(dir, '1')[0]!.text.length).toBe(MSGLOG_MAX_TEXT + 1)
  })
})

describe('rotation — bounded window', () => {
  test('trims to the last N (default cap honored via override)', () => {
    for (let i = 0; i < 10; i++) appendMessage(dir, '5', mk({ text: `m${i}` }), { maxPerChat: 3 })
    const rows = readMessages(dir, '5')
    expect(rows.map(r => r.text)).toEqual(['m7', 'm8', 'm9'])
  })
  test('default cap constant is the documented bound', () => {
    expect(MSGLOG_MAX_PER_CHAT).toBe(200)
  })
  test('file stays bounded across many appends', () => {
    for (let i = 0; i < 250; i++) appendMessage(dir, '5', mk({ text: `m${i}` }))
    expect(readMessages(dir, '5').length).toBe(MSGLOG_MAX_PER_CHAT)
  })
})

describe('multi-chat listing + most-recent selection', () => {
  test('lists all chat ids', () => {
    appendMessage(dir, '1', mk())
    appendMessage(dir, '-200', mk())
    expect(listChatIds(dir).sort()).toEqual(['-200', '1'])
  })
  test('mostRecentChatId picks newest last-message ts', () => {
    appendMessage(dir, '1', mk({ ts: '2026-07-05T01:00:00.000Z' }))
    appendMessage(dir, '2', mk({ ts: '2026-07-05T03:00:00.000Z' }))
    appendMessage(dir, '3', mk({ ts: '2026-07-05T02:00:00.000Z' }))
    expect(mostRecentChatId(dir)).toBe('2')
  })
  test('empty store → undefined', () => expect(mostRecentChatId(dir)).toBeUndefined())
})

describe('formatRecent', () => {
  test('marks outbound with arrow, tails to limit', () => {
    appendMessage(dir, '1', mk({ text: 'a' }))
    appendMessage(dir, '1', mk({ dir: 'out', user: 'dev', text: 'b' }))
    const out = formatRecent(readMessages(dir, '1'), 20)
    expect(out).toContain('lodar: a')
    expect(out).toContain('→ dev: b')
  })
  test('limit tails to the most recent', () => {
    for (let i = 0; i < 5; i++) appendMessage(dir, '1', mk({ text: `m${i}` }))
    const out = formatRecent(readMessages(dir, '1'), 2)
    expect(out).toContain('m3')
    expect(out).toContain('m4')
    expect(out).not.toContain('m0')
  })
  test('empty → placeholder', () => expect(formatRecent([], 20)).toContain('no recorded messages'))
})
