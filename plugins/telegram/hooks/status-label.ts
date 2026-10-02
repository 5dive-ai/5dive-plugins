#!/usr/bin/env -S bun
// PreToolUse hook (DIVE-5419): record a human-readable label for the step
// that is about to run, so the MCP server can show it on the agent's ack
// ("⏳ Running the unit tests · 2m") without the model spending a call on it.
//
// This hook only WRITES A FILE. The Bot API edit, its 30s throttle and the
// clean-up at turn end all live in the long-running server (ackstatus.ts),
// which already knows the ack's message id and text. So the hook adds no
// network round-trip to any tool call, and never blocks or alters one.
//
// What a label may contain is decided in lib/status-label.ts (DIVE-4123 leak
// line: no command text, file contents or transcript).

import { writeFileSync, renameSync } from 'fs'
import { readPayload } from './lib/payload'
import { loadAccess } from './lib/access'
import { labelFor } from './lib/status-label'
import { statusLabelFile, TG_TOOL_PREFIX } from './lib/paths'

const payload = await readPayload<{ tool_name?: string; tool_input?: unknown }>()

const access = loadAccess()
if (!access.allowFrom || access.allowFrom.length === 0) process.exit(0)

const label = labelFor(payload.tool_name, payload.tool_input, TG_TOOL_PREFIX)
if (label) {
  try {
    const file = statusLabelFile()
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), label }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // cosmetic — a lost label just shows the previous one
  }
}
process.exit(0)
