import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { CHANNEL_ID, type ResolvedFiveDiveAccount } from "./account.js";
import { fiveDiveChannelBase } from "./channel-base.js";
import { startFiveDiveGatewayAccount } from "./gateway.js";
import { fiveDiveOutboundAdapter, normalizeFiveDiveTarget } from "./outbound.js";

export const fiveDivePlugin: ChannelPlugin<ResolvedFiveDiveAccount> = createChatChannelPlugin<ResolvedFiveDiveAccount>({
  base: {
    ...fiveDiveChannelBase,
    messaging: {
      targetPrefixes: [CHANNEL_ID],
      normalizeTarget: (to: string) => normalizeFiveDiveTarget(to),
      inferTargetChatType: () => "direct",
    },
    agentPrompt: {
      inboundFormattingHints: () => ({
        text_markup: "markdown",
        rules: [
          "You are talking with your owner in the 5dive app chat (web and mobile). Markdown renders.",
          "To share a file, attach it; files on this computer are sent as uploads.",
        ],
      }),
    },
    gateway: {
      startAccount: startFiveDiveGatewayAccount,
    },
  },
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },
  threading: { topLevelReplyToMode: "off" },
  outbound: fiveDiveOutboundAdapter,
});
