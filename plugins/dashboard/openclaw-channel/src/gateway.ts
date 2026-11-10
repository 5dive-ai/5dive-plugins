// The running channel: polls the spool inbox, hands each message to OpenClaw
// as a direct message from the 5dive app owner, and writes the agent's
// answers to the spool outbox.

import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { StableChannelIngressIdentityParams, ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { CHANNEL_ID, CHANNEL_LABEL, type ResolvedFiveDiveAccount } from "./account.js";
import { pollSpool } from "./poll.js";
import { bodyFor, ensureSpool, localFiles, SENDER_ID, voiceLatchFor, writeOutbox, type SpoolMessage } from "./spool.js";

/** Told to the agent with a voice note: its answer is spoken back. */
export const VOICE_HINT =
  "[It was spoken: answer in one to three short sentences with no lists, links or code; your answer is spoken back.]";

const identity = {
  key: "fivedive-sender",
  normalizeEntry: (entry: string) => entry.trim() || null,
  normalizeSubject: (value: string) => value.trim() || null,
  sensitivity: "pii",
  entryIdPrefix: "fivedive-entry",
} satisfies StableChannelIngressIdentityParams;

/** Spool of each running account (diagnostics only; sends resolve their own). */
const activeSpools = new Map<string, string>();

export function activeSpoolFor(accountId: string): string | undefined {
  return activeSpools.get(accountId);
}

export async function startFiveDiveGatewayAccount(ctx: ChannelGatewayContext<ResolvedFiveDiveAccount>): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error("5dive app channel: no spool. Set FIVEDIVE_SPOOL_DIR or channels.fivedive.spoolDir.");
  }
  const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
  if (!channelRuntime?.inbound?.ingress?.resolveStable) {
    throw new Error("5dive app channel needs the registered channel runtime (OpenClaw too old?)");
  }
  const spool = account.spoolDir;
  ensureSpool(spool);
  activeSpools.set(account.accountId, spool);
  const latch = voiceLatchFor(account.accountId);
  ctx.setStatus({ accountId: account.accountId, lifecycle: "starting", configured: true, enabled: account.enabled });

  const resolveAccess = (senderId: string, contextBinding?: ChannelIngressContextBinding) =>
    channelRuntime.inbound.ingress.resolveStable({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      identity,
      cfg: ctx.cfg,
      subject: { stableId: senderId },
      conversation: { kind: "direct", id: senderId },
      contextBinding,
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    });

  const onMessage = async (msg: SpoolMessage) => {
    // The bridge pins every message to the one owner; the chat id says which
    // chat window it came from, the sender is always SENDER_ID.
    const senderId = SENDER_ID;
    const chatId = msg.route.chat_id;
    const access = await resolveAccess(senderId);
    if (access.senderAccess.decision !== "allow") {
      ctx.log?.warn?.(`[${account.accountId}] 5dive app: sender not allowed (${access.senderAccess.reasonCode})`);
      return;
    }
    const body = bodyFor(msg);
    if (msg.route.voice) latch.arm(chatId);
    const { dispatchInboundDirectDm } = await import("openclaw/plugin-sdk/channel-inbound");
    await dispatchInboundDirectDm({
      channelRuntime,
      resolveChannelIngress: async (contextBinding) => {
        const exact = await resolveAccess(senderId, contextBinding);
        if (!exact.senderAccess.allowed) throw new Error("5dive app sender authorization changed before dispatch");
        return exact;
      },
      cfg: ctx.cfg,
      channel: CHANNEL_ID,
      channelLabel: CHANNEL_LABEL,
      accountId: account.accountId,
      peer: { kind: "direct", id: senderId },
      senderId,
      senderAddress: `${CHANNEL_ID}:${senderId}`,
      recipientAddress: `${CHANNEL_ID}:${chatId}`,
      conversationLabel: CHANNEL_LABEL,
      rawBody: body,
      bodyForAgent: msg.route.voice ? `${VOICE_HINT}\n${body}` : body,
      messageId: msg.id,
      timestamp: msg.receivedAt,
      originatingTo: chatId,
      deliver: async (payload) => {
        const text = (payload.text ?? "").trim();
        const files = localFiles([...(payload.mediaUrls ?? []), payload.mediaUrl]);
        if (!text && !files.length) return;
        writeOutbox(spool, { chatId, text, files, voice: latch.take(chatId) });
      },
      onRecordError: (err) => ctx.log?.error?.(`[${account.accountId}] 5dive app: recording the message failed: ${String(err)}`),
      onDispatchError: (err, info) =>
        ctx.log?.error?.(`[${account.accountId}] 5dive app: ${info.kind} reply failed: ${String(err)}`),
    });
  };

  ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
  ctx.log?.info?.(`[${account.accountId}] 5dive app: reading ${spool}/inbox`);
  try {
    await pollSpool({
      spool,
      signal: ctx.abortSignal,
      intervalMs: account.pollMs,
      onMessage,
      onError: (err) => ctx.log?.error?.(`[${account.accountId}] 5dive app inbox error: ${String(err)}`),
      onDrop: (name, why) => ctx.log?.warn?.(`[${account.accountId}] 5dive app: dropped an ${why} inbox file ${name}`),
    });
  } finally {
    if (activeSpools.get(account.accountId) === spool) activeSpools.delete(account.accountId);
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}
