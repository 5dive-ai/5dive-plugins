// DIVE-1323: golden tripwire for the a2a-turn reply-suppression invariant.
//
// THE BUG: an agent's inter-agent (a2a) replies were leaking into the paired
// HUMAN's Telegram DM. Root cause — the telegram plugin's liveness hooks
// (silence-watchdog nag + stop-reply-check relay) had ZERO awareness of a2a
// turns: a turn triggered by `5dive agent send` (injected as a `[5dive-msg
// from=X]` opening prompt, no telegram <channel> tag) looked identical to an
// idle human turn, so the "reply every turn" reflex dumped the agent's
// main-directed reply into the human's DM.
//
// THE FIX: analyzeTurn() now flags a2aTurn, and BOTH hooks suppress on it.
// This suite locks the TWO halves so a future mis-detect can't regress
// silently:
//   1. BEHAVIOR — analyzeTurn tags a pure a2a turn a2aTurn=true, but a human
//      turn (incl. a MIXED a2a+human turn) a2aTurn=false so the human is
//      still answered.
//   2. WIRING — both hook sources actually consult `.a2aTurn` to suppress, so
//      a refactor that drops the guard trips CI even if analyzeTurn is fine.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTurn } from '../plugins/telegram/hooks/lib/transcript'
import type { TranscriptEntry } from '../plugins/telegram/hooks/lib/types'

const TG_PREFIX = 'mcp__plugin_telegram_telegram__'
const HOOKS = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks')

// --- synthetic transcript builders (mirror claude's JSONL shapes) ---
const userStr = (content: string): TranscriptEntry =>
  ({ type: 'user', message: { content } }) as unknown as TranscriptEntry
const assistantText = (text: string): TranscriptEntry =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as TranscriptEntry

const A2A_PROMPT = '[5dive-msg from=main id=34e2756e tier=admin] please rebase and ship'
const HUMAN_INBOUND =
  '<channel source="plugin:telegram:telegram" chat_id="433634012" message_id="10">what is the ETA?</channel>'

describe('DIVE-1323: analyzeTurn a2a-turn detection', () => {
  test('pure a2a turn → a2aTurn=true, hadInbound=false (SUPPRESS the human-DM reflex)', () => {
    const a = analyzeTurn([userStr(A2A_PROMPT), assistantText('on it')], TG_PREFIX)
    expect(a.a2aTurn).toBe(true)
    expect(a.hadInbound).toBe(false)
  })

  test('human telegram turn → a2aTurn=false, hadInbound=true (PRESERVE the reply)', () => {
    const a = analyzeTurn([userStr(HUMAN_INBOUND), assistantText('~5 min')], TG_PREFIX)
    expect(a.a2aTurn).toBe(false)
    expect(a.hadInbound).toBe(true)
    expect(a.lastChatId).toBe('433634012')
  })

  test('MIXED: a human DM arriving after an a2a envelope → a2aTurn=false (human still answered)', () => {
    // A telegram inbound landing after the a2a prompt is a fresh string user
    // entry, so the turn boundary relocates to it — analyzeTurn then sees a
    // human turn and the reply is preserved.
    const a = analyzeTurn(
      [userStr(A2A_PROMPT), assistantText('working'), userStr(HUMAN_INBOUND)],
      TG_PREFIX,
    )
    expect(a.a2aTurn).toBe(false)
    expect(a.hadInbound).toBe(true)
    expect(a.lastChatId).toBe('433634012')
  })

  test('autonomous / non-envelope turn → a2aTurn=false (no false positive)', () => {
    const a = analyzeTurn([userStr('continue'), assistantText('done')], TG_PREFIX)
    expect(a.a2aTurn).toBe(false)
    expect(a.hadInbound).toBe(false)
  })

  test('a literal "[5dive-msg" in human prose (no from=) does NOT false-positive', () => {
    const a = analyzeTurn(
      [userStr('the log line was [5dive-msg id=7] — what does it mean?'), assistantText('...')],
      TG_PREFIX,
    )
    expect(a.a2aTurn).toBe(false)
  })
})

describe('DIVE-1323: both liveness hooks are wired to suppress on a2a turns', () => {
  for (const hook of ['silence-watchdog.ts', 'stop-reply-check.ts']) {
    test(`${hook} consults .a2aTurn`, () => {
      const src = readFileSync(join(HOOKS, hook), 'utf8')
      expect(src, `${hook} lost its a2aTurn guard — a2a replies can leak to the human DM again`)
        .toContain('a2aTurn')
    })
  }
})
