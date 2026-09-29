// DIVE-5185: /app — an existing 5dive customer opens the my.5dive.ai Mini App
// from their own agent's bot, signed into the account the dashboard shows.
//
// The bot cannot open the Mini App itself: a web_app button here would sign
// Telegram's initData with THIS bot's token, which 5dive's sign-in rejects. So
// the button is a plain URL button to t.me/<5dive bot>?startapp=link_<code>,
// and the code comes from `5dive telegram-app link` (the box asks 5dive-api for
// a one-time link, bound to the Telegram user who tapped). Pure, so the copy and
// the URL check are unit-tested without importing server.ts.

export const APP_LINK_TIMEOUT_MS = 20_000

// Only a 5dive Mini App deep link becomes a button. Anything else the CLI
// prints is treated as a failure, never shown as a link.
export function isMiniAppLink(url: unknown): url is string {
  return typeof url === 'string' && /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?startapp=link_[A-Za-z0-9_-]{43}$/.test(url)
}

export type AppReply = { text: string; url?: string }

export const APP_BUTTON_TEXT = 'Open 5dive'

// `j` is the CLI's {ok, data:{status, url}} envelope, or null when the CLI
// could not be read at all (an old CLI without the verb, or a timeout).
export function appReply(j: unknown): AppReply {
  const d = (j && typeof j === 'object' ? (j as { data?: unknown }).data : null) as
    | { status?: unknown; url?: unknown }
    | null
    | undefined
  const status = typeof d?.status === 'string' ? d.status : null
  if (status === 'ready' && isMiniAppLink(d?.url)) {
    return {
      text: 'Your 5dive account, inside Telegram: your server, your agents, your plan. The button works once, for 15 minutes.',
      url: d!.url as string,
    }
  }
  switch (status) {
    case 'off':
      return { text: 'The 5dive app button is turned off on this server.' }
    case 'not_paired':
      return { text: "Only this bot's paired owner can open the 5dive app from here." }
    case 'partner_box':
      return { text: 'This server is managed by your provider. Use their account button instead.' }
    case 'other_telegram':
      return { text: 'Your 5dive account is linked to a different Telegram account. Open 5dive from that one.' }
    case 'taken':
      return { text: 'This Telegram account is already signed in to a different 5dive account.' }
    case 'unavailable':
      return { text: "The 5dive app in Telegram isn't available on this server yet." }
    case null:
      if (!j) return { text: '/app needs a newer 5dive CLI. It updates overnight, so try again tomorrow.' }
      return { text: "Couldn't reach 5dive just now. Try again in a minute." }
    default:
      return { text: "Couldn't reach 5dive just now. Try again in a minute." }
  }
}
