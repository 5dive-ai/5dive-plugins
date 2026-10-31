#!/usr/bin/env bun
/**
 * Grok `PreToolUse` hook — tells the model a Telegram message arrived mid-turn
 * (DIVE-7422, box report 598).
 *
 * Grok has no channel push: a message sent while the agent works waits in the
 * server's queue until the turn's next wait_for_message, so the owner looks
 * ignored. A PreToolUse deny `reason` is the only text a hook can show the model
 * during a turn, so when server.ts has mirrored a NEW batch to
 * pending-inbound.json we deny this one call with a reason that says to call
 * wait_for_message, then allow every later call until another message lands.
 * The telegram tools themselves are never denied (see pending-inbound.ts).
 *
 * Wired by hooks/hooks.json (PreToolUse, no matcher). Fail-open everywhere: any
 * error allows the call.
 *
 * Knob: GROK_INBOUND_SURFACE_DISABLED=1 → always allow.
 */

import { homedir } from 'os'
import { join } from 'path'
import { decideSurface, readPending, readSurfaced, writeSurfaced, pidAlive } from '../pending-inbound.ts'

function allow(): never {
  process.stdout.write(JSON.stringify({ decision: 'allow' }))
  process.exit(0)
}

if (process.env.GROK_INBOUND_SURFACE_DISABLED === '1') allow()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'channels', 'telegram')

let event: any = {}
try { event = JSON.parse(await Bun.stdin.text()) } catch {}
const toolName = String(event?.toolName ?? event?.tool_name ?? '')
const toolInput = event?.toolInput ?? event?.tool_input

try {
  const d = decideSurface(readPending(STATE_DIR), readSurfaced(STATE_DIR), toolName, toolInput, pidAlive)
  if (!d.deny) allow()
  writeSurfaced(STATE_DIR, d.seq)
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: d.reason }))
  process.exit(0)
} catch { allow() }
