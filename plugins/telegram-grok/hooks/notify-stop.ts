#!/usr/bin/env bun
/**
 * Grok `Stop` hook — pings every allowFrom user via the Telegram bot
 * when Grok finishes a turn (returns control to the user).
 *
 * Wired by the plugin's hooks/hooks.json (Stop event). For a manual /
 * standalone install, drop into ~/.grok/hooks/telegram-grok.json:
 *
 *   { "hooks": { "Stop": [ { "hooks": [
 *     { "type": "command", "command": "/abs/path/to/telegram-grok/hooks/notify-stop.ts" }
 *   ] } ] } }
 *
 * Reads token + recipients from the same state dir as server.ts:
 *   ~/.grok/channels/telegram/{.env, access.json}  (honors GROK_HOME)
 *
 * Override the ping text per session by setting GROK_NOTIFY_TEXT in env.
 * Skip the ping entirely with GROK_NOTIFY_DISABLED=1 (useful when the user
 * is already talking to the bot — the wait_for_message/reply loop already
 * tells them it's done, so the Stop ping would be duplicate).
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

if (process.env.GROK_NOTIFY_DISABLED === '1') process.exit(0)

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'channels', 'telegram')
const LAST_REPLY_FILE = join(STATE_DIR, 'last-reply.stamp')

// Duplicate-suppression: if Grok just sent a Telegram reply within the
// window, the user already knows the turn finished — the Stop ping would
// be noise. Window override via env (GROK_NOTIFY_SUPPRESS_MS, range 0..600000).
const SUPPRESS_MS = Math.max(0, Math.min(600_000,
  Number(process.env.GROK_NOTIFY_SUPPRESS_MS ?? 30_000)))
if (SUPPRESS_MS > 0) {
  try {
    const lastTs = Number(readFileSync(LAST_REPLY_FILE, 'utf8'))
    if (Number.isFinite(lastTs) && Date.now() - lastTs < SUPPRESS_MS) {
      process.exit(0)
    }
  } catch {}
}

try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) process.exit(0)

let access: { allowFrom?: string[] } = {}
try {
  access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
} catch { process.exit(0) }

const recipients = access.allowFrom ?? []
if (recipients.length === 0) process.exit(0)

const text = process.env.GROK_NOTIFY_TEXT ?? '🟢 grok: turn complete'

await Promise.all(recipients.map(chat_id =>
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  }).catch(() => {})
))
