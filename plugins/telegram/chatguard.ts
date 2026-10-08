// DIVE-5867: the outbound gate's refusal, kept pure so it is tested without
// importing server.ts (which long-polls Telegram on import).
//
// A reported agent called edit_message with chat_id "979" and message_id "979"
// and was told the chat "is not allowlisted — add via /telegram:access". The
// mistake was a message id in the chat_id slot; the text sent it to access
// control instead. Telegram message ids count up per chat from 1, and user ids
// have been 6+ digits for over a decade, so a chat_id equal to the call's own
// message id, or a 1-5 digit positive one, is almost always that slip. The
// refusal itself is unchanged; only its wording points at the likely cause.

/** The error text for a chat the gate refuses. `messageId` is the call's own
 *  message_id / reply_to, when it has one. */
export function notAllowlistedMessage(chatId: string, messageId?: string | number): string {
  const base = `chat ${chatId} is not allowlisted — add via /telegram:access`
  const mid = messageId === undefined || messageId === null ? '' : String(messageId)
  const same = mid !== '' && mid === chatId
  if (!same && !/^\d{1,5}$/.test(chatId)) return base
  return (
    `chat_id ${chatId} looks like a message_id, not a chat` +
    (same ? ' (it equals this call\'s message id)' : '') +
    `: pass the chat_id from the inbound <channel> tag. (${base})`
  )
}
