// DIVE-5993: tell the owner when their company's Claude plan keeps channels off.
//
// On a Claude Team/Enterprise login, Claude Code drops every inbound channel
// message unless the org's managed settings say `channelsEnabled: true`
// (2.1.296 gate: `{action:"skip", kind:"policy", reason:"channels not enabled by
// org policy (set channelsEnabled: true in managed settings)"}`), and an org
// allowlist that leaves this plugin out does the same. The agent looks healthy
// and never hears its owner. That is the org's explicit choice, so we do not
// route around it (channelroute.ts never injects for `org_policy`); outbound is
// not gated, so the bot tells the owner, ONCE, what an admin switches on.
//
// The steps are the 5dive FAQ's ("Logs say '--channels blocked by org policy'"),
// which stays the one source: this message is the short version plus a link to it.

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelDecision } from './channelroute.ts'

// Verified 2026-10-10 against code.claude.com/docs/en/server-managed-settings:
// "Organization settings > Claude Code > Managed settings", linked to this URL.
export const ORG_SETTINGS_URL = 'https://claude.ai/admin-settings/claude-code'
// The FAQ answer, filtered to itself (docs/faq reads ?q=).
export const ORG_POLICY_FAQ_URL = 'https://5dive.ai/docs/faq?q=channelsEnabled'

// The JSON the FAQ tells the admin to paste: channels on, and every channel
// plugin listed, because an org allowlist drops anything it does not name.
export const ORG_POLICY_JSON = JSON.stringify(
  {
    channelsEnabled: true,
    allowedChannelPlugins: [
      { plugin: 'dashboard', marketplace: '5dive-plugins' },
      { plugin: 'telegram', marketplace: '5dive-plugins' },
      { plugin: 'telegram', marketplace: 'claude-plugins-official' },
      { plugin: 'discord', marketplace: 'claude-plugins-official' },
    ],
  },
  null,
  2,
)

function html(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// HTML (parse_mode) so the JSON sits in a code block Telegram offers to copy.
export function orgPolicyText(name: string): string {
  const n = html(name.trim() || 'Your agent')
  return [
    `${n} can't hear your messages yet. Your company's Claude plan has agent chat channels turned off.`,
    `An admin of your Claude organization can turn them on: claude.ai → Organization settings → Claude Code → Managed settings. Paste this, save, then restart ${n}:`,
    `<pre><code class="language-json">${html(ORG_POLICY_JSON)}</code></pre>`,
  ].join('\n\n')
}

// Sent once per block: the marker file is written when the message reaches at
// least one owner, and removed when the gate reads bound again, so an org that
// switches channels off later is told again.
export const ORG_POLICY_NOTIFIED_FILE = 'org-policy-notified'

export function makeOrgPolicyNotifier(opts: {
  dir: string
  owners: () => string[]
  send: (chat: string) => Promise<void>
  log: (line: string) => void
}): (decision: ChannelDecision) => Promise<'sent' | 'cleared' | 'none'> {
  const marker = join(opts.dir, ORG_POLICY_NOTIFIED_FILE)
  let busy = false
  return async decision => {
    if (decision === 'bound') {
      if (!existsSync(marker)) return 'none'
      try { rmSync(marker, { force: true }) } catch {}
      opts.log('telegram channel: org policy now lets channels through; notice cleared')
      return 'cleared'
    }
    if (decision !== 'org_policy' || busy || existsSync(marker)) return 'none'
    busy = true
    try {
      let reached = 0
      for (const chat of opts.owners()) {
        try {
          await opts.send(chat)
          reached++
        } catch (err) {
          opts.log(`telegram channel: org-policy notice to ${chat} not sent: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (reached === 0) return 'none'
      try { writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }) } catch {}
      opts.log(`telegram channel: channels off by org policy; told ${reached} owner(s)`)
      return 'sent'
    } finally {
      busy = false
    }
  }
}
