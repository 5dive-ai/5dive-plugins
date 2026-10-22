#!/usr/bin/env -S bun
// DIVE-6715: PreToolUse on AskUserQuestion. On Telegram the picker becomes tap
// buttons (telegram's pretool-question.ts, DIVE-1027); on the web chat it only
// ever drew in the agent's own terminal, where nobody can tap it, so the agent
// sat waiting. This hook does Telegram's handshake for the web chat:
//
//   1. the person's newest message this turn came from the web chat (else: no
//      decision — Telegram's hook, or the terminal picker, as before);
//   2. post the question as a chat message carrying metadata.question, which
//      the app draws as buttons (via the notice outbox: the server holds the
//      credential, a hook does not);
//   3. write questions/<id>.req.json and wait: the server turns the person's
//      next message in that chat (a tap sends the label) into <id>.ans.json;
//   4. hand the answer back as the deny reason, which the model reads as the
//      tool's result — the same trick Telegram's hook uses.
//
// A shape the buttons cannot carry (several questions, multi-select) is denied
// with the plain instruction to ask in a reply instead, as Telegram does.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { readEntries, newestInboundSource } from './lib/transcript'
import { buildBridge } from './lib/question-bridge'
import { emitDenyTool } from './lib/output'
import { questionsDir, turnDashboardInbound, turnStart, writeOutbox, type PendingQuestion } from './lib/dashboard-chat'
import type { HookPayload } from './lib/types'

const log = (s: string) => console.error(`[dashboard-question] ${s}`)

const payload = await readPayload<HookPayload>()
const tool = payload.tool_name
if (tool !== 'AskUserQuestion') process.exit(0)

const entries = readEntries(payload.transcript_path ?? '')
const inbound = turnDashboardInbound(entries)
if (!inbound || newestInboundSource(entries, turnStart(entries)) !== 'dashboard') process.exit(0)

function askInReply(): never {
  emitDenyTool(
    tool!,
    'AskUserQuestion is blocked here: the person is in the 5dive dashboard chat and cannot see the terminal picker. ' +
      'Ask the question with mcp__plugin_dashboard_dashboard__reply instead, options as numbered lines, ' +
      'then stop and wait: their next dashboard message is the answer.',
  )
  process.exit(0)
}

const spec = buildBridge(tool, payload.tool_input ?? {})
if (!spec) askInReply()

// Same id grammar the relay's `ask` op accepts.
const id = `q${Date.now()}-${process.pid}`
const dir = questionsDir()
const reqFile = join(dir, `${id}.req.json`)
const ansFile = join(dir, `${id}.ans.json`)
const q = ((payload.tool_input?.questions as unknown[]) ?? [])[0] as { options?: Array<{ label?: unknown; description?: unknown }> }
const options = spec!.buttons.map((b, i) => {
  const d = q?.options?.[i]?.description
  return { label: b.label, ...(typeof d === 'string' && d.trim() ? { description: d.trim().slice(0, 200) } : {}) }
})
const pending: PendingQuestion = {
  id,
  chatId: inbound.chatId,
  answers: spec!.buttons.map(b => b.answer),
  labels: spec!.buttons.map(b => b.label),
  createdAt: Date.now(),
}
try {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(reqFile, JSON.stringify(pending), { mode: 0o600 })
  // The ❓ lead is Telegram's; the app draws the buttons under plain words.
  const text = spec!.prompt.replace(/^❓ ?/, '').trim()
  writeOutbox('question', { chat_id: inbound.chatId, text, question: { id, options } })
} catch (err) {
  log(`could not post the question: ${err}`)
  try { rmSync(reqFile, { force: true }) } catch {}
  askInReply()
}
log(`question ${id} posted with ${options.length} buttons; waiting`)

// The hook's timeout is 600 s (hooks.json); stop polling with room to clean up.
const deadline = Date.now() + Number(process.env.DASHBOARD_QUESTION_WAIT_MS ?? 560_000)
while (Date.now() < deadline) {
  await Bun.sleep(Number(process.env.DASHBOARD_QUESTION_POLL_MS ?? 1000))
  let answer = ''
  try {
    answer = String(JSON.parse(readFileSync(ansFile, 'utf8')).answer ?? '')
  } catch {
    continue
  }
  try { rmSync(reqFile, { force: true }); rmSync(ansFile, { force: true }) } catch {}
  if (!answer) break
  emitDenyTool(tool, `${answer}\n\n(Answered in the dashboard chat — treat this as the ${tool} result and continue. Do not re-ask.)`)
  process.exit(0)
}

// No answer in time: the buttons stay in the chat, but this turn moves on.
try { rmSync(reqFile, { force: true }) } catch {}
emitDenyTool(
  tool,
  'The person has not answered the question in the dashboard chat yet (the buttons are still there). ' +
    'Do not ask again: end your turn now; their next dashboard message is the answer.',
)
process.exit(0)
