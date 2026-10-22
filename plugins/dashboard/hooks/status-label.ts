#!/usr/bin/env -S bun
// DIVE-6715: PreToolUse. Telegram shows the step a turn is on ("⏳ Running the
// unit tests") from its status-label hook (DIVE-5419); the web chat's "typing…"
// was a guess in the browser that died at the agent's first message. This hook
// writes the same label, from the same leak-filtered labelFor (shared copy),
// into the dashboard's own state dir. The server forwards it to the chat only
// while it has a web-chat message in flight, so a Telegram or autonomous turn
// shows nothing there. No network here: a tool call is never slowed by it.

import { renameSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { readPayload } from './lib/payload'
import { labelFor } from './lib/status-label'
import { statusLabelPath } from './lib/dashboard-chat'

const DASHBOARD_TOOL_PREFIX = 'mcp__plugin_dashboard_dashboard__'

const payload = await readPayload<{ tool_name?: string; tool_input?: unknown }>()
const label = labelFor(payload.tool_name, payload.tool_input, DASHBOARD_TOOL_PREFIX)
if (label) {
  try {
    const file = statusLabelPath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), label }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // cosmetic: a lost label just shows the previous one
  }
}
process.exit(0)
