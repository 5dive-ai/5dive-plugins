// DIVE-5411: the agent greets its owner when its bot goes live, and greets a
// chat once however many /starts are queued for it.
//
// WHY. The manager bot tells the owner "@bot is ready. <Name> is setting up there
// and greets you in a moment" the instant the bot is created (5dive-api,
// partner-tg.ts settingUp). The box then wires the token and restarts the seat,
// so the plugin's poller comes up ~10 s later (measured 2026-10-02 on two boxes:
// 13:37:23 → 13:37:35 and 13:53:41 → 13:53:51). Until this change the plugin only
// ever greeted in answer to /start: an owner who did not tap Start was never
// greeted, and one who did saw nothing for ~10 s, tapped again, and got the
// greeting twice within 100 ms when the poller drained the queue (msglog on
// divine-owl: two "Hi, I'm Olivia" at 13:53:51.376 and .469). lodar: "i have to
// press /start twice to get it".
//
// Pure decisions only: server.ts long-polls Telegram on import, so the I/O stays
// there and test/dive5411-boot-greet.test.ts drives these with no bot.

/** One greeting per chat inside this window, whoever sends it (a /start or the boot). */
export const GREET_WINDOW_MS = 60_000
/** After the poller starts, how long the queued backlog gets to greet first. */
export const BOOT_GREET_DELAY_MS = 3_000
/** A token written this recently is a bot being wired now, not a seat restarting. */
export const WIRED_RECENTLY_MS = 10 * 60_000

export type GreetClaims = {
  /** true = this caller greets `chat` now; false = it was greeted inside the window. */
  claim(chat: string): boolean
  /** The greeting did not go out: let the next caller try. */
  release(chat: string): void
}

export function makeGreetClaims(now: () => number = Date.now, windowMs = GREET_WINDOW_MS): GreetClaims {
  const at = new Map<string, number>()
  return {
    claim(chat) {
      const t = now()
      const prev = at.get(chat)
      if (prev !== undefined && t - prev < windowMs) return false
      at.set(chat, t)
      return true
    },
    release(chat) {
      at.delete(chat)
    },
  }
}

/** The bot id is the token's part before the colon; never the secret half. */
export function botIdOf(token: string | undefined): string | null {
  const m = /^(\d+):/.exec(token ?? '')
  return m ? m[1] : null
}

/**
 * Who the poller greets unprompted on boot, and whether it records this bot as done.
 *
 * - `marker` is the bot id this state dir already greeted for. Equal: nothing to do,
 *   so a restart never greets again.
 * - A new bot whose token was not written just now (`wiredRecently`: the .env
 *   mtime), or on a seat that has already heard a human (`heardHuman`), is a plugin
 *   upgrade or a seat in use: record it, greet nobody. Both are needed: an upgraded
 *   seat has no marker yet, and not every seat that chatted kept last-human-chat.
 * - Otherwise the bot was just wired: greet each owner who is allowlisted, private
 *   chats only (a positive id; group ids are negative).
 */
export function bootGreetTargets(o: {
  botId: string | null
  marker: string | null
  heardHuman: boolean
  wiredRecently: boolean
  owners: string[] | undefined
  allowFrom: string[]
}): { greet: string[]; record: boolean } {
  if (!o.botId || o.marker === o.botId) return { greet: [], record: false }
  if (o.heardHuman || !o.wiredRecently) return { greet: [], record: true }
  const owners = (o.owners ?? o.allowFrom).filter(id => o.allowFrom.includes(id) && /^[1-9]\d*$/.test(id))
  return { greet: [...new Set(owners)], record: true }
}
