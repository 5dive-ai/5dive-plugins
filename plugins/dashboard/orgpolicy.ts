// DIVE-6006: tell the owner in the web chat when their company's Claude plan
// keeps channels off. A port of the Telegram plugin's DIVE-5993 notice
// (plugins/telegram/orgpolicy.ts — read that header for the evidence); plugins
// install as separate trees, so this is a copy, not an import.
//
// On a Claude Team/Enterprise login whose org has not switched channels on (or
// whose allowlist leaves this plugin out), Claude Code drops every web-chat
// message unheard: the agent looks healthy and the chat never answers. That is
// the org's explicit choice, so channelroute.ts never types around it; the reply
// path is an ordinary MCP tool call and is not gated, so the plugin posts ONE
// message into the web chat saying why and where the admin switches it on.
//
// Differences from Telegram's: the owner is whoever just wrote in the web chat
// (the inbound's chat_id), not an access list, and the words are plain text: the
// web chat draws a reply as-is with its line breaks kept (AgentChat,
// whitespace-pre-wrap, no markdown), so the JSON is plain indented text.
//
// DIVE-6057: the whole guide is in the message and there is no link (lodar,
// 2026-10-12: "give full guide in chat - no links. also suggest to switch to
// personal account type"). The steps are the 5dive FAQ's channelsEnabled answer.
//
// DIVE-6599: the same notice in Russian when the owner writes in Russian (lodar,
// 2026-10-20: "just make it in Russian if your app is in Russian"). The signal is
// the message that set the notice off: the web chat's inbound carries no locale,
// and a Russian UI's owner writes, or speaks into a heard voice note, in
// Cyrillic. No Cyrillic, or an unheard voice note, reads English. claude.ai has
// no Russian interface and the 5dive dashboard has none either, so their menu
// names stay English, in quotes.

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelDecision } from './channelroute.ts'

// The same JSON as plugins/telegram/orgpolicy.ts (held equal by the test):
// channels on, and every channel plugin listed, because an org allowlist drops
// anything it does not name.
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

const indent = (v: string) => v.split('\n').map(l => `    ${l}`).join('\n')

export type NoticeLang = 'en' | 'ru'

/** Russian when the inbound's letters are mostly Cyrillic, else English. The
 *  "[voice note]" tag the box puts on a heard note is not the owner's words. */
export function noticeLang(text: string): NoticeLang {
  const words = text.replace(/^\s*\[voice note\]/i, '')
  const cyr = (words.match(/[\u0400-\u04FF]/g) ?? []).length
  const lat = (words.match(/[A-Za-z]/g) ?? []).length
  return cyr > 0 && cyr >= lat ? 'ru' : 'en'
}

export function orgPolicyText(lang: NoticeLang = 'en'): string {
  if (lang === 'ru') return [
    'Я пока не слышу ваших сообщений здесь. В тарифе Claude вашей компании выключен чат с агентами, поэтому то, что вы пишете в этот чат, до меня не доходит.',
    [
      'Включить его может администратор вашей организации в Claude:',
      '1. Войдите в claude.ai под аккаунтом администратора.',
      '2. Откройте «Organization settings», затем «Claude Code», затем «Managed settings».',
      '3. Нажмите «Manage».',
      '4. Вставьте настройки ниже в поле и сохраните. Они включают чат с агентами и перечисляют все плагины чата, потому что список компании блокирует любой плагин, которого в нём нет.',
      '5. Перезапустите меня кнопкой «Restart» на моей странице в панели 5dive.',
    ].join('\n'),
    indent(ORG_POLICY_JSON),
    'Не получается изменить настройку компании? Тогда переключите меня на личный аккаунт Claude (Pro или Max), где чат с агентами включён по умолчанию: на моей странице в панели 5dive откройте «Account», затем «Switch account».',
  ].join('\n\n')
  return [
    "I can't hear your messages here yet. Your company's Claude plan has agent chat turned off, so what you type in this chat never reaches me.",
    [
      'An admin of your Claude organization can turn it on:',
      '1. Sign in to claude.ai with the admin account.',
      '2. Open Organization settings, then Claude Code, then Managed settings.',
      '3. Click Manage.',
      '4. Paste the settings below into the box and save. They switch agent chat on and list every chat plugin, because the company list blocks any plugin it leaves out.',
      '5. Restart me with the Restart button on my page in the 5dive dashboard.',
    ].join('\n'),
    indent(ORG_POLICY_JSON),
    "Can't change the company setting? Switch me to a personal Claude account (Pro or Max) instead, where agent chat is on by default: on my page in the 5dive dashboard, Account, then Switch account.",
  ].join('\n\n')
}

// Sent once per block: the marker file is written when the message is posted,
// and removed when the gate reads bound again, so an org that switches channels
// off later is told again.
export const ORG_POLICY_NOTIFIED_FILE = 'org-policy-notified'

export function makeOrgPolicyNotifier(opts: {
  dir: string
  send: (chat: string, lang: NoticeLang) => Promise<void>
  log: (line: string) => void
}): (decision: ChannelDecision, chat: string, text?: string) => Promise<'sent' | 'cleared' | 'none'> {
  const marker = join(opts.dir, ORG_POLICY_NOTIFIED_FILE)
  let busy = false
  return async (decision, chat, text = '') => {
    if (decision === 'bound') {
      if (!existsSync(marker)) return 'none'
      try { rmSync(marker, { force: true }) } catch {}
      opts.log('dashboard channel: org policy now lets channels through; notice cleared')
      return 'cleared'
    }
    if (decision !== 'org_policy' || busy || existsSync(marker)) return 'none'
    busy = true
    try {
      try {
        await opts.send(chat, noticeLang(text))
      } catch (err) {
        opts.log(`dashboard channel: org-policy notice to ${chat} not sent: ${err instanceof Error ? err.message : String(err)}`)
        return 'none'
      }
      try { writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }) } catch {}
      opts.log(`dashboard channel: channels off by org policy; told the owner in chat ${chat}`)
      return 'sent'
    } finally {
      busy = false
    }
  }
}
