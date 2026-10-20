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
// The steps are the 5dive FAQ's ("Logs say '--channels blocked by org policy'").
// DIVE-6057: the message carries all of them and links to nothing (lodar,
// 2026-10-12: "give full guide in chat - no links. also suggest to switch to
// personal account type"); the "Step by step" FAQ button is gone too. The one
// button left, "Open claude.ai", opens the very page step 2 names: it is the
// admin's shortcut, not a guide the owner has to leave the chat to read.
//
// DIVE-6599: in Russian for an owner whose Telegram is in Russian (lodar,
// 2026-10-20: "just make it in Russian if your app is in Russian"): the chat's
// language_code, as the bridge's buttons already read it (langOfChat), English
// when there is none. claude.ai and the 5dive dashboard have no Russian
// interface, so their menu names stay English, in quotes. The agent's name is
// in quotes too: Russian would decline it otherwise.

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelDecision } from './channelroute.ts'
import type { Lang } from './hooks/lib/lite.ts'

// Verified 2026-10-10 against code.claude.com/docs/en/server-managed-settings:
// "Organization settings > Claude Code > Managed settings", linked to this URL.
export const ORG_SETTINGS_URL = 'https://claude.ai/admin-settings/claude-code'

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

export function orgPolicyButton(lang: Lang = 'en'): string {
  return lang === 'ru' ? 'Открыть claude.ai' : 'Open claude.ai'
}

// HTML (parse_mode) so the JSON sits in a code block Telegram offers to copy.
export function orgPolicyText(name: string, lang: Lang = 'en'): string {
  if (lang === 'ru') {
    const n = html(name.trim())
    const agent = n ? `агент «${n}»` : 'ваш агент'
    const of = n ? `агента «${n}»` : 'агента'
    return [
      `${agent[0]!.toUpperCase()}${agent.slice(1)} пока не слышит ваших сообщений. В тарифе Claude вашей компании выключены каналы чата с агентами.`,
      [
        'Включить их может администратор вашей организации в Claude:',
        '1. Войдите в claude.ai под аккаунтом администратора.',
        '2. Откройте «Organization settings», затем «Claude Code», затем «Managed settings».',
        '3. Нажмите «Manage».',
        '4. Вставьте настройки ниже в поле и сохраните. Они включают чат с агентами и перечисляют все плагины чата, потому что список компании блокирует любой плагин, которого в нём нет.',
        `5. Перезапустите ${of}: отправьте сюда /restart.`,
      ].join('\n'),
      `<pre><code class="language-json">${html(ORG_POLICY_JSON)}</code></pre>`,
      `Не получается изменить настройку компании? Тогда переключите ${of} на личный аккаунт Claude (Pro или Max), где чат с агентами включён по умолчанию: на странице ${of} в панели 5dive откройте «Account», затем «Switch account».`,
    ].join('\n\n')
  }
  const n = html(name.trim() || 'Your agent')
  return [
    `${n} can't hear your messages yet. Your company's Claude plan has agent chat channels turned off.`,
    [
      'An admin of your Claude organization can turn them on:',
      '1. Sign in to claude.ai with the admin account.',
      '2. Open Organization settings, then Claude Code, then Managed settings.',
      '3. Click Manage.',
      '4. Paste the settings below into the box and save. They switch agent chat on and list every chat plugin, because the company list blocks any plugin it leaves out.',
      `5. Restart ${n}: send /restart here.`,
    ].join('\n'),
    `<pre><code class="language-json">${html(ORG_POLICY_JSON)}</code></pre>`,
    `Can't change the company setting? Switch ${n} to a personal Claude account (Pro or Max) instead, where agent chat is on by default: on ${n}'s page in the 5dive dashboard, Account, then Switch account.`,
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
