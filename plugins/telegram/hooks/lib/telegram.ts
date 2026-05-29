// Bot API client used by every hook that needs to DM. fetch is built into
// bun — no curl shellout. Telegram caps sendMessage text at 4096 chars;
// we truncate at 4000 with a "[truncated]" tail to leave headroom for the
// utf-8 byte counting Telegram does (text length is character-count but
// transport is bytes).

const TELEGRAM_TEXT_MAX = 4000

export function getToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN
}

// threadId is the forum-topic id (message_thread_id). Pass it for inbound
// from a supergroup topic so the message lands in that topic instead of the
// supergroup's General channel; omit for DMs, regular groups, and General.
export async function sendMessage(chatId: string, text: string, threadId?: string): Promise<void> {
  const token = getToken()
  if (!token || !chatId) return
  const trimmed =
    text.length > TELEGRAM_TEXT_MAX
      ? text.slice(0, TELEGRAM_TEXT_MAX - 40) + '… [truncated; see journalctl on the host]'
      : text
  try {
    const params = new URLSearchParams({ chat_id: chatId, text: trimmed })
    if (threadId) params.set('message_thread_id', threadId)
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
  } catch {
    // Best-effort: hook timeouts are short; if the network is wedged the
    // worst case is a missed DM, not a crashed agent.
  }
}
