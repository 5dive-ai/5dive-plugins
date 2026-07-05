#!/usr/bin/env -S bun
// PreToolUse hook for telegram-relayed claude agents.
//
// DIVE-1027: AskUserQuestion (options picker) and ExitPlanMode (plan-approval)
// render only in the local tmux pane — a Telegram-paired agent's user never sees
// them. This hook used to blanket-DENY both, forcing agents to hand-roll numbered
// lines and parse free-text replies. Now it INTERCEPTS instead: it posts the
// tool's options as a Telegram inline keyboard, blocks waiting for the tap, and
// returns the chosen answer to the model — so the agent uses the native picker
// tool with zero hand-rolling.
//
// Mechanics: PreToolUse hooks can't fabricate a success tool_result (only
// allow/deny), and only the long-running MCP server may consume getUpdates
// (DIVE-818 lock), so the tap can only be seen there. We bridge the two
// processes over a file handshake in QUESTION_DIR: this hook drops a `.req.json`
// (the option labels) and posts the keyboard; the server's callback_query router
// resolves a tap into `.ans.json`; we poll for it and return the answer via the
// deny reason (the model reads it as the user's response). Falls back to the
// legacy numbered-message deny when we can't bridge (not paired, no token,
// unsupported shape, or the tap times out).
//
// Also stamps the silence-watchdog last-seen file so an external idle-ping cron
// (if any) can detect when the agent has gone quiet.

import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { STATE_DIR, QUESTION_DIR, TG_TOOL_PREFIX } from './lib/paths'
import { emitDenyTool, emitAllowTool } from './lib/output'
import { getToken } from './lib/telegram'
import { readEntries, analyzeTurn } from './lib/transcript'
import { buildBridge, buttonText } from './lib/question-bridge'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()
const tool = payload.tool_name

function stampAndExit(): never {
  try {
    writeFileSync(join(STATE_DIR, 'last-seen'), String(Date.now()))
  } catch {
    // STATE_DIR may not exist (plugin loaded but never paired). Silent skip.
  }
  process.exit(0)
}

// Legacy behaviour: tell claude to inline the question/plan as a numbered
// Telegram message and read the next reply as the answer.
function legacyDeny(t: string): never {
  emitDenyTool(
    t,
    `${t} is blocked in this Telegram-paired session: its picker UI renders only in the local terminal, so the Telegram user cannot see or respond to it and the session will hang.\n\nInstead, send your question (or plan) as a regular Telegram message via mcp__plugin_telegram_telegram__reply, with options written as numbered lines. Then wait for the user's next telegram message — that reply is the answer.`,
  )
  stampAndExit()
}

if (tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode') {
  // Not our concern — allow the tool. (This hook's matcher shouldn't fire for
  // other tools, but stay defensive.)
  stampAndExit()
}

// Translate the tool_input into a bridge spec; unsupported shapes fall back.
const spec = buildBridge(tool!, payload.tool_input ?? {})
if (!spec) legacyDeny(tool!)

// We need a chat to post into and a token to post with; else fall back.
const token = getToken()
const a = analyzeTurn(readEntries(payload.transcript_path ?? ''), TG_TOOL_PREFIX)
const chatId = a.lastChatId
const threadId = a.lastThreadId ?? undefined
if (!token || !chatId) legacyDeny(tool!)

// Post the inline keyboard directly (sendMessage, not getUpdates — no poller
// conflict). callback_data is `q:<reqid>:<idx>`; the server re-resolves the idx
// against the labels we persist, so it never has to fit the 64-byte cap.
const reqid = `${Date.now()}-${process.pid}`
const reqFile = join(QUESTION_DIR, `${reqid}.req.json`)
const ansFile = join(QUESTION_DIR, `${reqid}.ans.json`)

try {
  mkdirSync(QUESTION_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(
    reqFile,
    JSON.stringify({ tool, chatId, labels: spec!.buttons.map(b => b.answer), createdAt: Date.now() }),
    { mode: 0o600 },
  )
} catch {
  legacyDeny(tool!)
}

const inline_keyboard = spec!.buttons.map((b, i) => [
  { text: buttonText(b.label, i, spec!.markers), callback_data: `q:${reqid}:${i}` },
])

async function post(): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: spec!.prompt.length > 3800 ? spec!.prompt.slice(0, 3800) + '…' : spec!.prompt,
      reply_markup: { inline_keyboard },
    }
    if (threadId) body.message_thread_id = Number(threadId)
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.ok
  } catch {
    return false
  }
}

if (!(await post())) {
  try {
    rmSync(reqFile, { force: true })
  } catch {}
  legacyDeny(tool!)
}

// Poll for the answer the server writes on tap. Hook timeout is 600s (hooks.json)
// — poll up to ~560s to leave cleanup headroom.
const POLL_MS = 1500
const MAX_MS = 560_000
const deadline = Date.now() + MAX_MS
while (Date.now() < deadline) {
  await Bun.sleep(POLL_MS)
  let raw: string | null = null
  try {
    raw = readFileSync(ansFile, 'utf8')
  } catch {
    continue // not answered yet
  }
  let answer = ''
  let idx = -1
  try {
    const parsed = JSON.parse(raw)
    answer = String(parsed.answer ?? '')
    idx = Number(parsed.idx)
  } catch {
    answer = ''
  }
  try {
    rmSync(reqFile, { force: true })
    rmSync(ansFile, { force: true })
  } catch {}
  if (!answer) break
  // An approve-style tap (ExitPlanMode) must ALLOW the tool to actually run —
  // deny would leave the agent in plan mode and re-fire this hook in a loop.
  const btn = spec!.buttons[idx]
  if (btn?.permit === 'allow') {
    emitAllowTool('Approved via Telegram button tap.')
    stampAndExit()
  }
  // Otherwise deliver the tapped choice as the answer. Deny is the only
  // stop-path a PreToolUse hook has, but the reason IS the answer, so the agent
  // proceeds exactly as if the native picker had returned it.
  emitDenyTool(
    tool!,
    `${answer}\n\n(Answered via Telegram button tap — treat this as the ${tool} result and continue. Do not re-ask.)`,
  )
  stampAndExit()
}

// Timed out — clean up the request and fall back so the agent isn't stuck.
try {
  rmSync(reqFile, { force: true })
} catch {}
legacyDeny(tool!)
