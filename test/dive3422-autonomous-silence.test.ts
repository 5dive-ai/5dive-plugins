// DIVE-3422: an autonomous session has no chat scope, so nothing it writes
// reaches anyone — and every existing guard is scoped to a caller it does not
// have.
//
// THE INCIDENT: a `/goal` session (342 entries, 52 minutes) wrote every
// progress report, its completion report and a security escalation to the
// terminal. Replayed through the installed analyzeTurn, every turn read
// {hadInbound:false, lastChatId:null, hadSend:false}, so stop-reply-check
// exited clean on all of them — correctly. The session was never in scope.
//
// THE ROW'S ACCEPTANCE ITEM 3 is what this suite is really about: "an
// over-firing nag gets muted, and a muted warning is the silence we started
// with." So the arm that matters is the NEGATIVE one — an agent that IS
// reaching the channel must never accumulate a run, and a session past the
// first notice must not speak again until a large multiple.
//
// Locks two halves so a regression can't land quietly:
//   1. BEHAVIOR — every arm of nextSilentRun, including both negative ones.
//   2. WIRING — stop-reply-check actually consults it, and does so BEFORE the
//      a2a/inbound exits that the silent case leaves through. A refactor that
//      drops the call, or sinks it below those exits, trips CI even though
//      the pure decision is still perfect.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  nextSilentRun,
  composeSilentRunNotice,
  SILENT_RUN_FIRST,
  SILENT_RUN_REPEAT,
  type SilentTurn,
} from '../plugins/telegram/hooks/lib/autonomous-silence'

const HOOKS = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks')

// A turn of the incident: autonomous, no inbound, agent talked to the
// transcript and to nobody else.
const DARK: SilentTurn = { hadInbound: false, a2aTurn: false, hadSend: false, hasText: true }

// Drive a sequence of turns from zero and collect the turn indices that spoke.
function run(turns: SilentTurn[]): { count: number; firedAt: number[] } {
  let count = 0
  const firedAt: number[] = []
  turns.forEach((t, i) => {
    const d = nextSilentRun(count, t)
    count = d.count
    if (d.notify) firedAt.push(i + 1)
  })
  return { count, firedAt }
}

describe('DIVE-3422: when an autonomous session goes dark', () => {
  test('the incident shape fires exactly once, at the threshold', () => {
    const { count, firedAt } = run(Array(SILENT_RUN_FIRST).fill(DARK))
    expect(count).toBe(SILENT_RUN_FIRST)
    expect(firedAt).toEqual([SILENT_RUN_FIRST])
  })

  test('below the threshold it says nothing (a short quiet task is not a defect)', () => {
    const { firedAt } = run(Array(SILENT_RUN_FIRST - 1).fill(DARK))
    expect(firedAt).toEqual([])
  })

  test('a turn with no assistant text does not advance the run', () => {
    const toolOnly: SilentTurn = { ...DARK, hasText: false }
    const { count, firedAt } = run([DARK, toolOnly, toolOnly, DARK])
    expect(count).toBe(2)
    expect(firedAt).toEqual([])
  })
})

describe('DIVE-3422 NEGATIVE CONTROL: an agent that is replying is never warned', () => {
  test('a reply this turn resets the run to zero', () => {
    const replied: SilentTurn = { ...DARK, hadSend: true }
    const d = nextSilentRun(SILENT_RUN_FIRST - 1, replied)
    expect(d.count).toBe(0)
    expect(d.notify).toBe(false)
  })

  test('a healthy paired session — reply every turn — never fires, ever', () => {
    const replied: SilentTurn = { ...DARK, hadInbound: true, hadSend: true }
    const { count, firedAt } = run(Array(SILENT_RUN_REPEAT * 4).fill(replied))
    expect(count).toBe(0)
    expect(firedAt).toEqual([])
  })

  test('a single reply mid-drought disarms it: the run restarts from zero', () => {
    const replied: SilentTurn = { ...DARK, hadSend: true }
    // Two dark turns, a reply, then two more dark turns = never 3 in a row.
    const { count, firedAt } = run([DARK, DARK, replied, DARK, DARK])
    expect(count).toBe(2)
    expect(firedAt).toEqual([])
  })

  test('an inbound turn resets too — that turn is the auto-relay path’s business', () => {
    const inbound: SilentTurn = { ...DARK, hadInbound: true, hadSend: false }
    const { count, firedAt } = run([DARK, DARK, inbound, DARK, DARK])
    expect(count).toBe(2)
    expect(firedAt).toEqual([])
  })

  test('an a2a turn is neutral: it neither launders the silence nor deepens it', () => {
    const a2a: SilentTurn = { ...DARK, a2aTurn: true }
    // DIVE-1323 says an a2a turn's output belongs on the a2a channel, so it is
    // not a reply to the user — but it is not unreported user-facing work
    // either. The run is left exactly where it was.
    expect(nextSilentRun(2, a2a)).toEqual({ count: 2, notify: false })
    const { firedAt } = run([DARK, a2a, DARK, a2a, DARK])
    expect(firedAt).toEqual([SILENT_RUN_FIRST + 2]) // the 3rd DARK turn, at index 5
  })
})

describe('DIVE-3422: it does not become the nag it was built to avoid', () => {
  test('a long dark run speaks at the threshold and then only on a large multiple', () => {
    const { firedAt } = run(Array(SILENT_RUN_REPEAT * 2).fill(DARK))
    expect(firedAt).toEqual([SILENT_RUN_FIRST, SILENT_RUN_REPEAT, SILENT_RUN_REPEAT * 2])
  })

  test('the turns either side of a repeat are silent', () => {
    expect(nextSilentRun(SILENT_RUN_REPEAT - 2, DARK).notify).toBe(false)
    expect(nextSilentRun(SILENT_RUN_REPEAT - 1, DARK).notify).toBe(true)
    expect(nextSilentRun(SILENT_RUN_REPEAT, DARK).notify).toBe(false)
  })

  test('the repeat interval is far above the first-fire threshold', () => {
    // Guards the retune knob: dropping REPEAT to near FIRST turns this into a
    // per-turn nag on any long autonomous seat.
    expect(SILENT_RUN_REPEAT).toBeGreaterThan(SILENT_RUN_FIRST * 5)
  })
})

describe('DIVE-3422: the notice carries enough to end the silence', () => {
  test('it names the run length and quotes the last transcript text', () => {
    const msg = composeSilentRunNotice(3, 'CI is green, pushing the branch now.')
    expect(msg).toContain('3 turns')
    expect(msg).toContain('CI is green, pushing the branch now.')
  })

  test('a long tail is truncated, not dropped (Telegram caps at 4096)', () => {
    const msg = composeSilentRunNotice(25, 'x'.repeat(9000))
    expect(msg.length).toBeLessThan(4096)
    expect(msg).toContain('…')
  })

  test('no transcript text still produces a usable notice', () => {
    const msg = composeSilentRunNotice(3, '   ')
    expect(msg).toContain('3 turns')
    expect(msg).not.toContain('Latest from the transcript')
  })
})

describe('DIVE-3422 WIRING: the hook consults it, above the exits it leaks through', () => {
  const src = readFileSync(join(HOOKS, 'stop-reply-check.ts'), 'utf8')

  test('stop-reply-check calls nextSilentRun', () => {
    expect(src).toContain('nextSilentRun(')
  })

  test('it runs BEFORE the a2a exit and the inbound exit', () => {
    // This is the whole point. The autonomous case exits at
    // `if (!a.hadInbound || ...) process.exit(0)`; a check placed after that
    // line is unreachable for exactly the sessions it is meant to cover.
    const call = src.indexOf('nextSilentRun(')
    const a2aExit = src.indexOf('if (a.a2aTurn) process.exit(0)')
    const inboundExit = src.indexOf('if (!a.hadInbound')
    expect(call).toBeGreaterThan(-1)
    expect(a2aExit).toBeGreaterThan(-1)
    expect(inboundExit).toBeGreaterThan(-1)
    expect(call).toBeLessThan(a2aExit)
    expect(call).toBeLessThan(inboundExit)
  })

  test('it routes to the group topic first, allowed chats only as fallback', () => {
    expect(src).toContain('getGroupTopics()')
    const topics = src.indexOf('getGroupTopics()')
    const fallback = src.indexOf('getAllowedChatIds().map(chatId => ({ chatId }))', topics)
    expect(fallback).toBeGreaterThan(topics)
  })
})
