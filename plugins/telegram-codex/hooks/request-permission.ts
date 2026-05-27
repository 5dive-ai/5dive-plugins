#!/usr/bin/env bun
/**
 * Codex `PermissionRequest` hook → Telegram approval bridge.
 *
 * Wire from ~/.codex/config.toml:
 *
 *   [features]
 *   hooks = true
 *
 *   [[hooks.PermissionRequest]]
 *
 *   [[hooks.PermissionRequest.hooks]]
 *   type = "command"
 *   command = "bun /abs/path/to/telegram-codex/hooks/request-permission.ts"
 *   timeout = 180
 *   async = false
 *
 * Flow:
 *   1. Codex pipes the PermissionRequest payload to this script's stdin.
 *   2. We mint a request id, write the payload to permissions/req-<id>.json
 *      in the plugin's state dir.
 *   3. The running MCP server (server.ts) watches that dir, sends a Telegram
 *      message with [✅ allow] [❌ deny] inline buttons, waits for the user
 *      to tap one, then writes permissions/res-<id>.json with the decision.
 *   4. We poll for res-<id>.json (1s interval, default 120s timeout, env-
 *      overridable), parse it, and emit Codex's hook output envelope on
 *      stdout.
 *
 * Fail-closed: if the MCP server isn't running, or the user doesn't respond
 * before timeout, we return behavior=deny so Codex's existing approval UI
 * surfaces — the user is never silently auto-approved.
 *
 * Skip-bypass: set CODEX_TG_APPROVAL_DISABLED=1 in the hook's env to bypass
 * this script entirely (returns "allow" without touching the bridge). Useful
 * for unattended sessions where you'd rather Codex's policy be authoritative.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'telegram')
const PERMS_DIR = join(STATE_DIR, 'permissions')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const TIMEOUT_MS = Math.max(5_000, Math.min(600_000,
  Number(process.env.CODEX_TG_APPROVAL_TIMEOUT_MS ?? 120_000)))

function emit(envelope: object): never {
  process.stdout.write(JSON.stringify(envelope))
  process.exit(0)
}

function decide(behavior: 'allow' | 'deny', message?: string): never {
  emit({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior, ...(message ? { message } : {}) },
    },
  })
}

if (process.env.CODEX_TG_APPROVAL_DISABLED === '1') decide('allow', 'TG approval bypassed (env)')

mkdirSync(PERMS_DIR, { recursive: true, mode: 0o700 })

// MCP server must be running to bridge — otherwise fail closed.
let serverAlive = false
try {
  const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (pid > 1) { process.kill(pid, 0); serverAlive = true }
} catch {}
if (!serverAlive) decide('deny', 'telegram-codex MCP server not running — falling back to Codex approval UI')

let payload: unknown
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  decide('deny', 'hook payload was not valid JSON')
}

const id = randomBytes(8).toString('hex')
const reqPath = join(PERMS_DIR, `req-${id}.json`)
const resPath = join(PERMS_DIR, `res-${id}.json`)

writeFileSync(reqPath, JSON.stringify({ id, ...((payload && typeof payload === 'object') ? payload : { payload }) }, null, 2))

const deadline = Date.now() + TIMEOUT_MS
let response: { behavior?: 'allow' | 'deny'; message?: string; user?: string } | null = null

while (Date.now() < deadline) {
  if (existsSync(resPath)) {
    try {
      response = JSON.parse(readFileSync(resPath, 'utf8'))
      break
    } catch {}
  }
  Bun.sleepSync(500)
}

try { unlinkSync(reqPath) } catch {}
try { unlinkSync(resPath) } catch {}

if (!response || response.behavior !== 'allow' && response.behavior !== 'deny') {
  decide('deny', `no Telegram response within ${TIMEOUT_MS / 1000}s`)
}

const who = response.user ? ` by @${response.user}` : ''
const reason = response.message ? `: ${response.message}` : ''
decide(response.behavior!, `${response.behavior}${who}${reason}`)
