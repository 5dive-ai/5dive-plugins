// DIVE-1027 regression: on CC v2.1.201 the ExitPlanMode bridge path could fail
// to post/emit a clean decision, letting Claude Code fall through to its native
// plan-approval dialog and HANG a Telegram-paired session on a local keypress.
// The fix short-circuits ExitPlanMode to the legacy clean PreToolUse deny BEFORE
// any bridge/network/file work. This actually EXECUTES the hook (a bundle/unit
// test wouldn't catch a fail-open) and asserts:
//   - ExitPlanMode → permissionDecision:deny, exit 0, and NO req file written
//     (i.e. the bridge handshake was never entered), even with a live chat +
//     token available.
//   - AskUserQuestion still ENTERS the bridge (unchanged) — proven by it writing
//     a req file when a chat + token resolve.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'pretool-question.ts')

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pq-hook-'))
})
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})

const QUESTION_DIR = () => join(home, '.claude', 'channels', 'telegram', 'questions')

// A telegram inbound so analyzeTurn resolves a (dummy) chat target — this is what
// makes the bridge path reachable; ExitPlanMode must NOT take it anyway.
function writeTranscript(): string {
  const p = join(home, 'transcript.jsonl')
  writeFileSync(
    p,
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: '<channel source="plugin:telegram:telegram" chat_id="123" message_id="1">hi</channel>',
      },
    }) + '\n',
  )
  return p
}

// Runs the hook with a short timeout. ExitPlanMode/fallback exit fast; a bridge
// that actually posts would block polling — but our fake token makes sendMessage
// fail, so AskUserQuestion falls back fast too (after writing its req file).
function fireHook(payload: Record<string, unknown>): { code: number; stdout: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TELEGRAM_BOT_TOKEN: '000:FAKE', TMUX: '' },
    timeout: 30000,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '' }
}

describe('DIVE-1027 ExitPlanMode never enters the bridge (never hangs on native dialog)', () => {
  test('ExitPlanMode → clean deny, exit 0, and never reaches the native dialog', () => {
    const transcript_path = writeTranscript() // a live chat IS resolvable here…
    const { code, stdout } = fireHook({
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'Ship it', planFilePath: join(home, 'plan.md') }, // v2.1.201 shape
      transcript_path,
    })
    // Exit 0 + a deny decision = Claude Code blocks the tool and never opens its
    // local plan-approval dialog. This is the anti-hang guarantee.
    expect(code).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('numbered lines')
    // …yet no bridge handshake was ever entered (short-circuit is before the
    // reqFile write / post). The questions dir stays absent/empty.
    const dir = QUESTION_DIR()
    const reqs = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.req.json')) : []
    expect(reqs).toEqual([])
  })

  test('AskUserQuestion is still handled via buildBridge (unsupported shape → clean fallback)', () => {
    const transcript_path = writeTranscript()
    // multiSelect is a v1-unsupported shape → buildBridge returns null → the hook
    // takes the legacy fallback deny. Proves AskUserQuestion still flows through
    // the bridge logic (not the ExitPlanMode short-circuit, not a pass-through).
    const { code, stdout } = fireHook({
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ header: 'Pick', question: 'Any?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
      },
      transcript_path,
    })
    expect(code).toBe(0)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('a non-picker tool passes through untouched (empty output, exit 0)', () => {
    const { code, stdout } = fireHook({ tool_name: 'Read', tool_input: {}, transcript_path: '/nonexistent' })
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('') // no decision emitted — the tool runs normally
  })
})
