#!/usr/bin/env -S bun
// PreToolUse guard for a Teams-connected agent (DIVE-7976).
//
// When the newest Teams message (within TEAMS_ROLE_WINDOW_S, 30 min) came from a
// MEMBER, a risky act — root, paying, deleting, sending outside the firm, changing
// settings, keys or access — is denied with a reason telling the agent to ask an
// admin (the ask_admin tool). An admin's Approve tap is a Teams message from an
// admin, so the same call then goes through. Everything else passes untouched:
// a member's ordinary question gets an ordinary answer.
//
// The role is the channel's (roles.ts), written by server.ts into the mark from
// the sender's Entra id. Fails open on any error, and is a no-op on a seat that
// never received a Teams message.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { guardVerdict, loadRoles, readMark } from '../roles.ts'

const STATE_DIR = process.env.TEAMS_STATE_DIR || join(homedir(), '.claude', 'channels', 'teams')

try {
  const raw = await Bun.stdin.text()
  const p = raw.trim() ? JSON.parse(raw) : {}
  const v = guardVerdict(readMark(join(STATE_DIR, 'last-sender.json')), loadRoles(), String(p.tool_name ?? ''), p.tool_input)
  if (!v.ok) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } }),
    )
  }
} catch {}
process.exit(0)
