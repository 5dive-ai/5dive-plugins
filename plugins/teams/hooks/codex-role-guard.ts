#!/usr/bin/env -S bun
// Codex PreToolUse guard for a Teams-connected Codex seat (DIVE-8464).
//
// The Claude seat's hooks/role-guard.ts, for Codex: when the newest Teams message
// (within TEAMS_ROLE_WINDOW_S, 30 min) came from a MEMBER, a risky act (root,
// paying, deleting, sending outside the firm, settings, keys, access) is blocked
// with a reason until an admin says yes on Teams. Same rule (roles.ts
// guardVerdict), same mark (written by server.ts from the sender's Entra id),
// two Codex differences:
//
//  - the turn's own source decides first: the dispatcher records the running
//    turn in $CODEX_DISPATCHER_STATE_DIR/state.json (`active.route`). A turn the
//    owner started on Telegram or the web chat is never held by a Teams member's
//    earlier message; a teams turn, or no readable record, falls through to the mark.
//  - Codex names its shell tool differently and has no ask_admin tool (its MCP
//    table is empty under the dispatcher), so the shell names are read as Bash,
//    apply_patch is read as a file write, and the reason says what to do instead.
//
// Blocks by exit code 2 with the reason on stderr (the block both Codex and
// Claude Code hooks honour). Fails open on any error; a no-op on a seat that
// never received a Teams message.
//
// Wired by 5dive-agent-start from the manifest's `fivedive.codex_hook`:
//   [[hooks.PreToolUse]]
//   [[hooks.PreToolUse.hooks]]
//   type = "command"
//   command = "bun <plugin dir>/hooks/codex-role-guard.ts"

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { guardVerdict, loadRoles, readMark } from '../roles.ts'

const STATE_DIR = process.env.TEAMS_STATE_DIR || join(homedir(), '.claude', 'channels', 'teams')
const DISPATCHER_STATE_DIR = process.env.CODEX_DISPATCHER_STATE_DIR || join(homedir(), '.codex', 'channels', 'dispatcher')

export const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'unified_exec'])

/** Codex's tool call as the guard's (tool, input): a shell as Bash, apply_patch as Write per file. */
export function asGuardCalls(tool: string, input: any): Array<{ tool: string; input: Record<string, unknown> }> {
  const i = input && typeof input === 'object' ? input : {}
  if (SHELL_TOOLS.has(tool)) {
    const c = Array.isArray(i.command) ? i.command.map(String).join(' ') : String(i.command ?? i.cmd ?? '')
    return [{ tool: 'Bash', input: { command: c } }]
  }
  if (tool === 'apply_patch') {
    const patch = String(i.input ?? i.patch ?? i.command ?? '')
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]!.trim())
    return paths.map(p => ({ tool: 'Write', input: { file_path: p } }))
  }
  return [{ tool, input: i }]
}

/** The running turn's source, or null when the dispatcher record is missing or unreadable. */
export function activeSource(stateFile: string): string | null {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'))
    const src = s?.active?.route?.source
    return typeof src === 'string' ? src : null
  } catch {
    return null
  }
}

export function codexReason(reason: string): string {
  return reason.replace(/Call the teams ask_admin tool with what (.+?) asked and why; never ask \1 to approve it\./,
    'Tell $1 this needs an admin\'s yes, and do it only after an admin messages you on Teams to approve it; never ask $1 to approve it.')
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text()
    const p = raw.trim() ? JSON.parse(raw) : {}
    const src = activeSource(join(DISPATCHER_STATE_DIR, 'state.json'))
    if (src === null || src === 'teams') {
      const mark = readMark(join(STATE_DIR, 'last-sender.json'))
      const roles = loadRoles()
      for (const c of asGuardCalls(String(p.tool_name ?? ''), p.tool_input)) {
        const v = guardVerdict(mark, roles, c.tool, c.input)
        if (!v.ok) {
          process.stderr.write(codexReason(v.reason) + '\n')
          process.exit(2)
        }
      }
    }
  } catch {}
  process.exit(0)
}
