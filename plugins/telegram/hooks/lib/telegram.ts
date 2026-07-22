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
  // DIVE-1674: never deliver a bare 'undefined'/empty payload to the user.
  // A caller passing undefined (or a template that stringified to the literal
  // string 'undefined') must be dropped at this choke point, not sent. Guard
  // defensively so the symptom dies regardless of which caller slipped up.
  if (text == null || text.trim() === '' || text.trim() === 'undefined') {
    process.stderr.write(
      `telegram sendMessage: refusing to send empty/undefined text to ${chatId}\n`,
    )
    return
  }
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
