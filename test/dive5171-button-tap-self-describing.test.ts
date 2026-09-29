// DIVE-5171: a tap on an auto-rendered Yes/No (DIVE-332) or choice-list
// (DIVE-708) button must describe itself. It used to reach the agent as a bare
// 'yes'/'no' under the BOT's message id with a plugin-clock ts and no
// recent_messages entry — each tell an agent checks said "forged", and agents
// discarded the owner's real answers. The pure half (content, meta, log entry)
// is exercised directly; the wiring in server.ts is read as text, because
// importing the server long-polls Telegram.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tapContent, tapMeta, tapLogEntry, type ButtonTap } from '../plugins/telegram/buttontap'
import { appendMessage, readMessages, formatRecent } from '../plugins/telegram/msglog'

const NO: ButtonTap = { value: 'no', button: '❌ No', answersMessageId: 479, callbackQueryId: 'cbq-123' }
const OPT: ButtonTap = { value: 'Build the wizard', button: 'A) Build the wizard', answersMessageId: 480, callbackQueryId: 'cbq-456' }

describe('the agent reads a tap as a tap', () => {
  test('yes/no content leads with the answer and names the button and the message', () => {
    expect(tapContent(NO)).toBe('no (tapped the ❌ No button under your message 479)')
    expect(tapContent({ ...NO, value: 'yes', button: '✅ Yes' })).toStartWith('yes (tapped the ✅ Yes button')
  })
  test('an option tap carries the full label and the printed button', () => {
    expect(tapContent(OPT)).toBe('Build the wizard (tapped the A) Build the wizard button under your message 480)')
  })
  test('no keyboard message on hand → still says it was a tap', () => {
    expect(tapContent({ ...NO, answersMessageId: undefined })).toBe('no (tapped the ❌ No button)')
  })
  test('meta marks via=button with the answered id, the label and Telegram\'s callback id', () => {
    expect(tapMeta(NO)).toEqual({ via: 'button', button: '❌ No', callback_query_id: 'cbq-123', answers_message_id: '479' })
    expect(tapMeta({ ...NO, answersMessageId: undefined })).not.toHaveProperty('answers_message_id')
  })
})

describe('taps land in the recent_messages log, marked', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tap-log-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a yes and a no tap both read back, marked as button taps', () => {
    appendMessage(dir, '7', { ts: '2026-09-29T02:00:00.000Z', dir: 'out', user: 'dev', text: 'Ship it?', message_id: '479' })
    appendMessage(dir, '7', tapLogEntry({ ...NO, value: 'yes', button: '✅ Yes' }, 'lodar', '2026-09-29T02:00:05.000Z'))
    appendMessage(dir, '7', tapLogEntry(NO, 'lodar', '2026-09-29T02:00:09.000Z', '42'))
    const rows = readMessages(dir, '7')
    expect(rows.filter(r => r.via === 'button').map(r => r.answers_message_id)).toEqual(['479', '479'])
    expect(rows[2]!.thread_id).toBe('42')
    const out = formatRecent(rows, 20)
    expect(out).toContain('lodar (button tap): yes (tapped the ✅ Yes button under your message 479)')
    expect(out).toContain('lodar (button tap): no (tapped the ❌ No button under your message 479)')
  })
  test('a typed inbound is rendered exactly as before (no marker)', () => {
    appendMessage(dir, '7', { ts: '2026-09-29T02:00:00.000Z', dir: 'in', user: 'lodar', text: 'no' })
    expect(formatRecent(readMessages(dir, '7'), 20)).toBe('[2026-09-29T02:00:00.000Z] lodar: no')
  })
})

describe('server.ts wiring (read as text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
  const helper = src.slice(src.indexOf('function relayButtonTap('), src.indexOf("\nbot.on('callback_query:data'"))
  const ynArm = src.slice(src.indexOf('const ynM = /^yn:(yes|no)$/.exec(data)'), src.indexOf('const optM = OPT_RE.exec(data)'))
  const optArm = src.slice(src.indexOf('const optM = OPT_RE.exec(data)'), src.indexOf('const loginM ='))

  test('both the yn: and opt: arms relay through the self-describing helper', () => {
    expect(ynArm).toContain('relayButtonTap(ctx, value,')
    expect(optArm).toContain('relayButtonTap(ctx, value,')
    // Neither arm builds its own bare notification any more.
    expect(ynArm).not.toContain("method: 'notifications/claude/channel'")
    expect(optArm).not.toContain("method: 'notifications/claude/channel'")
  })
  test('the helper sends tap content + tap meta, and logs the tap', () => {
    expect(helper).toContain('content: tapContent(tap)')
    expect(helper).toContain('...tapMeta(tap)')
    expect(helper).toContain('msglogAppend(MSGLOG_DIR, chatId, tapLogEntry(')
    expect(helper).toContain('callbackQueryId: cq.id')
  })
  test('the shipped instructions tell the agent a via="button" inbound is a real answer', () => {
    const block = src.slice(src.indexOf('    instructions: ['), src.indexOf("    ].join('\\n'),"))
    expect(block).toMatch(/'An inbound with via="button" is the user tapping a button[^']*a real answer/)
  })
})
