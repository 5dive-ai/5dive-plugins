// DIVE-7422: a Grok agent on Telegram can be reached mid-turn, and looks alive.
//
// Box report 598 (chill-gorge, 2026-10-31): the seat asked a question, kept
// making tool calls, and the owner's "so?" / "what the plan?" sat in the queue
// until the turn ended. Nothing showed on the phone in between. Two causes:
//   (a) "typing…" stopped at the first reply, so a turn that keeps working after
//       an ack or a question showed nothing;
//   (b) grok has no push, and its only mid-turn surface is a PreToolUse deny
//       reason, which nothing used.
//
// Arms:
//   (A) decideSurface: deny once per new batch, never a telegram tool, never a
//       stale file, fail-open on anything odd;
//   (B) the hook itself, spawned the way grok runs it (stdin JSON → stdout JSON);
//   (C) server.ts in both generated forks: the queue is mirrored, "typing…"
//       outlives the reply and stops at park/turn end, a mid-turn inbound starts
//       it, telegram results carry the fallback notice;
//   (D) DIVE-165: none of it can start a turn on an idle seat.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  decideSurface, isTelegramToolCall, previewOf, pendingNotice, writePending, readPending,
  PENDING_FILE, SURFACED_FILE, type PendingInbound,
} from '../plugins/telegram-grok/pending-inbound'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const alive = () => true
const dead = () => false
const pending = (over: Partial<PendingInbound> = {}): PendingInbound => ({
  pid: process.pid, count: 3, seq: 7, oldest_ts: '2026-10-31T15:13:35Z', preview: 'what the plan?', ...over,
})

describe('(A) decideSurface — one deny per new batch', () => {
  test('A1 a new batch on a non-telegram tool is denied, with count, preview and the ask', () => {
    const d = decideSurface(pending(), 0, 'run_terminal_cmd', { command: 'ls' }, alive)
    expect(d.deny).toBe(true)
    if (!d.deny) return
    expect(d.seq).toBe(7)
    expect(d.reason).toContain('3 new Telegram messages arrived while you were working')
    expect(d.reason).toContain('"what the plan?"')
    expect(d.reason).toContain('Call wait_for_message now')
  })
  test('A2 the same batch is not denied twice', () => {
    expect(decideSurface(pending(), 7, 'run_terminal_cmd', {}, alive).deny).toBe(false)
  })
  test('A3 a newer message after a surfaced batch is denied again', () => {
    expect(decideSurface(pending({ seq: 8 }), 7, 'read_file', {}, alive).deny).toBe(true)
  })
  test('A4 telegram tools are never denied — direct, via use_tool, or discovery', () => {
    for (const t of ['telegram__wait_for_message', 'telegram__reply', 'mcp_telegram__react']) {
      expect(decideSurface(pending(), 0, t, {}, alive).deny).toBe(false)
    }
    expect(decideSurface(pending(), 0, 'use_tool', { name: 'telegram__wait_for_message' }, alive).deny).toBe(false)
    expect(decideSurface(pending(), 0, 'search_tool', { query: 'telegram' }, alive).deny).toBe(false)
    expect(decideSurface(pending(), 0, 'use_tool', { name: 'github__create_issue' }, alive).deny).toBe(true)
  })
  test('A5 no file, or a file whose server is dead, allows', () => {
    expect(decideSurface(null, 0, 'run_terminal_cmd', {}, alive).deny).toBe(false)
    expect(decideSurface(pending(), 0, 'run_terminal_cmd', {}, dead).deny).toBe(false)
  })
  test('A6 one message reads singular; previews are one line, quote-safe and capped', () => {
    const d = decideSurface(pending({ count: 1 }), 0, 'x', {}, alive)
    expect(d.deny && d.reason.startsWith('1 new Telegram message arrived')).toBe(true)
    expect(previewOf('so?\n\n  "now"')).toBe("so? 'now'")
    expect(previewOf('x'.repeat(200)).length).toBe(80)
    expect(pendingNotice(2)).toContain('2 new Telegram messages are waiting: call wait_for_message')
    expect(isTelegramToolCall('run_terminal_cmd', { command: 'echo telegram__x' })).toBe(false)
  })
})

describe('(B) the hook, run the way grok runs it', () => {
  let dir: string
  const HOOK = join(PLUGINS, 'telegram-grok', 'hooks', 'inbound-surface.ts')
  const run = (event: unknown, env: Record<string, string> = {}) => {
    const r = spawnSync('bun', [HOOK], {
      input: typeof event === 'string' ? event : JSON.stringify(event),
      env: { ...process.env, TELEGRAM_STATE_DIR: dir, ...env }, encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    return JSON.parse(r.stdout)
  }
  const bash = { hookEventName: 'pre_tool_use', toolName: 'run_terminal_cmd', toolInput: { command: 'ls' } }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dive7422-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('B1 empty queue → allow', () => {
    expect(run(bash)).toEqual({ decision: 'allow' })
  })
  test('B2 a queued batch → one deny, then allow; a new message → deny again', () => {
    writePending(dir, pending())
    const first = run(bash)
    expect(first.decision).toBe('deny')
    expect(first.reason).toContain('wait_for_message')
    expect(readFileSync(join(dir, SURFACED_FILE), 'utf8')).toBe('7')
    expect(run(bash)).toEqual({ decision: 'allow' })
    writePending(dir, pending({ count: 4, seq: 8, preview: 'stop' }))
    const again = run(bash)
    expect(again.decision).toBe('deny')
    expect(again.reason).toContain('"stop"')
  })
  test('B3 wait_for_message goes through even on a fresh batch', () => {
    writePending(dir, pending())
    expect(run({ ...bash, toolName: 'telegram__wait_for_message', toolInput: {} })).toEqual({ decision: 'allow' })
    expect(existsSync(join(dir, SURFACED_FILE))).toBe(false)
  })
  test('B4 a stale file from a dead server, the knob, or garbage stdin → allow', () => {
    writePending(dir, pending({ pid: 2 ** 22 + 12345 }))
    expect(run(bash)).toEqual({ decision: 'allow' })
    writePending(dir, pending())
    expect(run(bash, { GROK_INBOUND_SURFACE_DISABLED: '1' })).toEqual({ decision: 'allow' })
    writeFileSync(join(dir, PENDING_FILE), '{not json')
    expect(run('garbage')).toEqual({ decision: 'allow' })
  })
  test('B5 writePending(null) removes the file — the drained queue surfaces nothing', () => {
    writePending(dir, pending())
    expect(readPending(dir)?.seq).toBe(7)
    writePending(dir, null)
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false)
  })
})

for (const fork of ['telegram-grok', 'telegram-agy'] as const) {
  describe(`(C) ${fork} server.ts`, () => {
    const SRC = readFileSync(join(PLUGINS, fork, 'server.ts'), 'utf8')
    const fnBody = (name: string) => {
      const at = SRC.indexOf(`function ${name}(`)
      expect(at).toBeGreaterThan(-1)
      return SRC.slice(at, SRC.indexOf('\n}\n', at))
    }
    const caseBody = (name: string) => {
      const at = SRC.indexOf(`case '${name}': {`)
      expect(at).toBeGreaterThan(-1)
      return SRC.slice(at, SRC.indexOf('\n      case ', at + 10))
    }

    test('C1 the queue is mirrored on every change: enqueue, single dequeue, batch drain, boot', () => {
      expect(fnBody('enqueueInbound')).toMatch(/inboundSeq\+\+\s*\n\s*inboxQueue\.push\(msg\)\s*\n\s*syncPending\(\)/)
      expect(fnBody('dequeueOrWait')).toMatch(/inboxQueue\.shift\(\)!\s*\n\s*syncPending\(\)/)
      expect(caseBody('wait_for_message')).toMatch(/batch\.push\(inboxQueue\.shift\(\)!\)\s*\n\s*\}\s*\n\s*syncPending\(\)/)
      expect(SRC).toMatch(/\nsyncPending\(\)   \/\/ a file left by a previous server/)
      // the hook's surfaced mark survives a restart, so the seq must not restart at 0
      expect(SRC).toContain('let inboundSeq = Date.now()')
    })
    test('C2 a reply releases "typing…" to the turn instead of stopping it', () => {
      expect(caseBody('reply')).not.toContain('stopTypingLoop(')
      expect(caseBody('reply')).toContain('releaseTypingToTurnEnd(chat_id)')
    })
    test('C3 the loop stops when the agent parks, or a released loop sees the turn end; the ceiling is its own', () => {
      const body = fnBody('startTypingLoop')
      expect(body).toContain("waiters.length > 0 || (typingToTurnEnd.has(chat_id) && !turnInFlightCached())")
      expect(body.match(/typingLoops\.get\(chat_id\) === handle/g)?.length).toBe(2)
      expect(fnBody('stopTypingLoop')).toContain('typingToTurnEnd.delete(chat_id)')
    })
    test('C4 a message queued mid-turn starts "typing…" for its chat (not for agent-send)', () => {
      expect(fnBody('enqueueInbound')).toMatch(
        /if \(msg\.chat_id !== 'agent-send' && turnInFlightCached\(0\)\) \{\s*\n\s*startTypingLoop\(msg\.chat_id, msg\.message_thread_id\)\s*\n\s*releaseTypingToTurnEnd\(msg\.chat_id\)/)
    })
    test('C5 telegram tool results carry the fallback notice, except wait_for_message', () => {
      const at = SRC.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
      const wrap = SRC.slice(at, SRC.indexOf('\n})\n', at))
      expect(wrap).toContain("req.params.name !== 'wait_for_message' && inboxQueue.length > 0")
      expect(wrap).toContain('pendingNotice(inboxQueue.length)')
    })
    test('C6 the hook is wired ahead of the watchdog and ships in the plugin', () => {
      const hooks = readFileSync(join(PLUGINS, fork, 'hooks', 'hooks.json'), 'utf8')
      const a = hooks.indexOf('/hooks/inbound-surface.ts'), b = hooks.indexOf('/hooks/silence-watchdog.ts')
      expect(a).toBeGreaterThan(-1)
      expect(a).toBeLessThan(b)
      expect(existsSync(join(PLUGINS, fork, 'pending-inbound.ts'))).toBe(true)
    })
    test('D1 DIVE-165: nothing added here kicks the listen loop', () => {
      for (const fn of ['syncPending', 'startTypingLoop', 'releaseTypingToTurnEnd', 'turnInFlightCached']) {
        expect(fnBody(fn)).not.toContain('kickListenLoop')
      }
      expect(readFileSync(join(PLUGINS, fork, 'hooks', 'inbound-surface.ts'), 'utf8')).not.toContain('kick')
    })
  })
}

test('the generator copies both new files to every fork', () => {
  const gen = readFileSync(join(import.meta.dir, '..', 'generator', 'generate.ts'), 'utf8')
  expect(gen).toContain("'pending-inbound.ts',")
  expect(gen).toContain("'hooks/inbound-surface.ts',")
})
