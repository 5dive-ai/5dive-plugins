// Sends that do not answer an inbound message: the shared `message` tool,
// cron announces, heartbeats. The spool needs no live connection, so these
// work whether or not the gateway account is polling.

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { CHANNEL_ID, resolveFiveDiveAccount } from "./account.js";
import { DEFAULT_CHAT_ID, localFiles, MAX_MESSAGE_LENGTH, voiceLatchFor, writeOutbox } from "./spool.js";

/** `fivedive:dashboard`, `dashboard` or empty all mean the one chat. */
export function normalizeFiveDiveTarget(to: string | undefined | null): string {
  const t = (to ?? "").trim().replace(/^fivedive:/i, "");
  return t || DEFAULT_CHAT_ID;
}

function spoolFor(cfg: Parameters<typeof resolveFiveDiveAccount>[0], accountId?: string | null): string {
  const account = resolveFiveDiveAccount(cfg, accountId);
  if (!account.spoolDir) throw new Error("5dive app channel: no spool. Set FIVEDIVE_SPOOL_DIR or channels.fivedive.spoolDir.");
  return account.spoolDir;
}

export const fiveDiveOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: MAX_MESSAGE_LENGTH,
  sendText: async ({ cfg, to, text, accountId }) => {
    const chatId = normalizeFiveDiveTarget(to);
    const voice = voiceLatchFor(accountId || "default").take(chatId);
    const messageId = writeOutbox(spoolFor(cfg, accountId), { chatId, text: text ?? "", voice });
    return { channel: CHANNEL_ID, to: chatId, messageId };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const chatId = normalizeFiveDiveTarget(to);
    const files = localFiles([mediaUrl]);
    const voice = voiceLatchFor(accountId || "default").take(chatId);
    const messageId = writeOutbox(spoolFor(cfg, accountId), { chatId, text: text ?? "", files, voice });
    return { channel: CHANNEL_ID, to: chatId, messageId };
  },
} satisfies ChannelOutboundAdapter;
