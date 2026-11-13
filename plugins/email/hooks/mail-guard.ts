#!/usr/bin/env -S bun
// PreToolUse guard for an email-connected agent (DIVE-8315). See ../guard.ts.
// Fails open on any error (a broken hook must not stop the agent's normal
// work), like the Teams member guard.

import { guardVerdict, loadRoles, newestSource, readTail } from '../guard.ts'

try {
  const raw = await Bun.stdin.text()
  const p = raw.trim() ? JSON.parse(raw) : {}
  const tp = String(p.transcript_path ?? '')
  const source = tp ? newestSource(readTail(tp)) : null
  const v = guardVerdict(source, loadRoles(), String(p.tool_name ?? ''), p.tool_input)
  if (!v.ok) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } }),
    )
  }
} catch {}
process.exit(0)
