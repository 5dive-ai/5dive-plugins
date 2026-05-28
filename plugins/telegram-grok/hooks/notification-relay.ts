#!/usr/bin/env bun
/**
 * Grok `Notification` hook — relays error-flavored notifications to
 * Telegram so the user finds out when Grok crashes, hits a rate limit,
 * or otherwise fails mid-turn.
 *
 * Wired by the plugin's hooks/hooks.json (Notification event). Grok pipes
 * a JSON payload to stdin. We extract a message text from the common fields
 * (message / title / reason / error / notification) and post to every
 * allowFrom user — IF the content matches one of the error patterns. Set
 * `GROK_NOTIFY_RELAY_ALL=1` to relay every notification.
 *
 * Disable entirely with `GROK_NOTIFY_RELAY_DISABLED=1`. Always exits
 * `continue=true` — a notification, never a gate.
 *
 * A true "session crashed → systemd respawn" path needs an ExecStopPost
 * in the agent's systemd unit (5dive territory, not the plugin).
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function exitContinue(): never {
  process.stdout.write(JSON.stringify({ continue: true }))
  process.exit(0)
}

if (process.env.GROK_NOTIFY_RELAY_DISABLED === '1') exitContinue()

let payload: any = {}
try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch {}

// Pull a meaningful text out of whatever shape Grok hands us. Grok's
// Notification hook payload isn't strictly documented, so be generous:
// check common field names, fall back to JSON.stringify.
function extractText(p: any): string {
  if (!p || typeof p !== 'object') return String(p ?? '')
  const candidates = [
    p.message,
    p.notification,
    p.title,
    p.text,
    p.reason,
    p.error && (typeof p.error === 'string' ? p.error : p.error.message),
    p.stopReason,
  ]
  for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c
  // Last-resort: short JSON dump so the user at least gets *something*.
  const raw = JSON.stringify(p)
  return raw.length > 500 ? raw.slice(0, 500) + '…' : raw
}

const ERROR_RE = /\b(error|failed|failure|crash|panic|timeout|rate.?limit|usage.?limit|unauthor|denied|forbidden|exceed)/i
const text = extractText(payload)
const relayAll = process.env.GROK_NOTIFY_RELAY_ALL === '1'
if (!relayAll && !ERROR_RE.test(text)) exitContinue()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'channels', 'telegram')

try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) exitContinue()

let access: { allowFrom?: string[] } = {}
try { access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')) } catch {}
const recipients = access.allowFrom ?? []
if (recipients.length === 0) exitContinue()

const body = `⚠️ grok: ${text.slice(0, 3500)}`

await Promise.all(recipients.map(chat_id =>
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id, text: body }),
  }).catch(() => {})
))

exitContinue()
