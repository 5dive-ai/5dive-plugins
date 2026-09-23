// DIVE-4889: a react on the NEWEST inbound answers it, so the Stop hook must
// not auto-relay the turn's narration on top of the 👍.
//
// Seen 2026-09-23 ~08:10Z (marketing seat, telegram 0.5.60): the human sent an
// acknowledgement, the seat reacted 👍 as our rules require, and its end-of-turn
// recap still reached the human as `(auto-relay) …`. DIVE-4276 (09-11) fixed
// only the silence watchdog for the same complaint; this Stop hook counted a
// react as "not a send", so any loose text relayed. 5dive-ai/5dive #1005 fixed
// the same thing in the CLI's shell copy of this hook, which no seat wires.
//
// Semantics, from community/wiki/a-reaction-is-contact-but-only-sometimes-an-answer.md:
// a react on the newest inbound IS an answer; a react on an older message is
// contact only, and must keep relaying — else it buries a live question.
//
// Driven END TO END: the real hook runs as a subprocess against synthetic
// transcripts, and a local Bot API stub records what it actually transmitted.
// Arms reuse #1005's cases (react/no-tool/reply/edit/download/no-inbound) and
// add the two only the plugin can express: react on an OLDER message, and a new
// inbound arriving after the react.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { analyzeTurn } from '../plugins/telegram/hooks/lib/transcript'
import type { TranscriptEntry } from '../plugins/telegram/hooks/lib/types'

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stop-reply-check.ts')
const TG = 'mcp__plugin_telegram_telegram__'
const CHAT = '1234567890'

const inbound = (messageId: string, text = 'yes from now on that the template', chat = CHAT) =>
  ({
    type: 'user',
    message: { content: `<channel source="plugin:telegram:telegram" chat_id="${chat}" message_id="${messageId}" user="lodar">${text}</channel>` },
  }) as unknown as TranscriptEntry
// A mid-turn DM: the harness appends it as a text block of an array-content
// user entry, so the turn boundary does NOT move (DIVE-3448's shape).
const midTurnInbound = (messageId: string) =>
  ({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't', content: 'ok' },
        { type: 'text', text: `<system-reminder><channel source="plugin:telegram:telegram" chat_id="${CHAT}" message_id="${messageId}">wait, one more thing?</channel></system-reminder>` },
      ],
    },
  }) as unknown as TranscriptEntry
const tool = (name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: `${TG}${name}`, input }] } }) as unknown as TranscriptEntry
const react = (messageId: string, chat = CHAT) => tool('react', { chat_id: chat, message_id: messageId, emoji: '👍' })
const text = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }) as unknown as TranscriptEntry
const RECAP = text('The centered title is already the template. I reacted 👍 and saved a memory.')

let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''
let apiBase = ''

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dive4889-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  stubLog = join(home, 'stub.jsonl')
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: 'ok' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    const first = readFileSync(stubLog, 'utf8').split('\n')[0]
    if (first) {
      const port = (JSON.parse(first) as { port?: number }).port
      if (port) { apiBase = `http://127.0.0.1:${port}`; break }
    }
    await new Promise(r => setTimeout(r, 50))
  }
  if (!apiBase) throw new Error('telegram stub never bound a port')
})
afterEach(() => {
  stub?.kill()
  stub = null
  apiBase = ''
  try { rmSync(home, { recursive: true, force: true }) } catch { /* noop */ }
})

// Run the real hook; return every message it transmitted.
function runHook(entries: TranscriptEntry[]): { code: number; sent: string[]; stdout: string } {
  const transcript = join(home, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      TELEGRAM_STATE_DIR: join(home, 'state'),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: apiBase,
      TMUX: '',
    },
    timeout: 20000,
  })
  const sent = readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { port?: number; text?: string })
    .filter(c => c.port === undefined)
    .map(c => c.text ?? '')
  return { code: r.status ?? -1, sent, stdout: r.stdout ?? '' }
}

describe('DIVE-4889: the Stop hook and a react on the newest inbound', () => {
  test('(1) inbound N, react on N, loose text → NO relay (the fix)', () => {
    const r = runHook([inbound('50'), react('50'), RECAP])
    expect(r.code).toBe(0)
    expect(r.sent).toEqual([])
  })

  test('(2) inbound N, react on an OLDER message M, loose text → relays as today', () => {
    const r = runHook([inbound('50'), react('49'), RECAP])
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].startsWith('(auto-relay) The centered title')).toBe(true)
  })

  test('(2b) react on N, then a NEW inbound N+1 lands mid-turn → relays (N is no longer the newest)', () => {
    const r = runHook([inbound('50'), react('50'), midTurnInbound('51'), RECAP])
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].startsWith('(auto-relay)')).toBe(true)
  })

  test('(2c) same message_id but another chat → relays (identity is chat AND message)', () => {
    const r = runHook([inbound('50'), react('50', '999'), RECAP])
    expect(r.sent.length).toBe(1)
  })

  test('(3) reply present → no relay (unchanged)', () => {
    const r = runHook([inbound('50'), tool('reply', { chat_id: CHAT, text: 'done' }), RECAP])
    expect(r.sent).toEqual([])
  })

  test('(3b) edit_message present → no relay (unchanged)', () => {
    const r = runHook([inbound('50'), tool('edit_message', { chat_id: CHAT, message_id: '7', text: 'x' }), RECAP])
    expect(r.sent).toEqual([])
  })

  test('(4) no telegram tool call, text present → relays (unchanged — the net still works)', () => {
    const r = runHook([inbound('50'), RECAP])
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].startsWith('(auto-relay)')).toBe(true)
  })

  test('(4b) download_attachment + text → relays (it reads from the channel, says nothing back)', () => {
    const r = runHook([inbound('50'), tool('download_attachment', { file_id: 'f' }), RECAP])
    expect(r.sent.length).toBe(1)
  })

  test('(5) react on N with no text → clean, no block (unchanged react-only ack)', () => {
    const r = runHook([inbound('50'), react('50')])
    expect(r.sent).toEqual([])
    expect(r.stdout).not.toContain('"block"')
  })

  test('(6) no telegram inbound → silent (the hook is scoped to a channel turn)', () => {
    const r = runHook([{ type: 'user', message: { content: 'hello from the terminal' } } as unknown as TranscriptEntry, RECAP])
    expect(r.sent).toEqual([])
  })
})

describe('DIVE-4889: analyzeTurn.reactedNewest', () => {
  test('true only for the newest inbound, and never folded into hadSend', () => {
    const a = analyzeTurn([inbound('50'), react('50'), RECAP], TG)
    expect(a.reactedNewest).toBe(true)
    expect(a.hadSend).toBe(false)
    expect(analyzeTurn([inbound('50'), react('49'), RECAP], TG).reactedNewest).toBe(false)
    expect(analyzeTurn([inbound('50'), react('50'), midTurnInbound('51')], TG).reactedNewest).toBe(false)
  })

  test('an inbound with no message_id cannot be credited', () => {
    const noId = {
      type: 'user',
      message: { content: `<channel source="plugin:telegram:telegram" chat_id="${CHAT}">tap</channel>` },
    } as unknown as TranscriptEntry
    expect(analyzeTurn([noId, react('50'), RECAP], TG).reactedNewest).toBe(false)
  })
})
