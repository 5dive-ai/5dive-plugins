// The setup-safe half of the channel: identity, config and account reads.
// No gateway or runtime code, so `setup-entry.ts` can load it during
// onboarding and read-only status without starting anything.

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  DEFAULT_ACCOUNT_ID,
  inspectFiveDiveAccount,
  listFiveDiveAccountIds,
  resolveFiveDiveAccount,
  type ResolvedFiveDiveAccount,
} from "./account.js";

export const fiveDiveMeta = {
  id: CHANNEL_ID,
  label: CHANNEL_LABEL,
  selectionLabel: "5dive app (web and mobile chat)",
  docsPath: "/channels/fivedive",
  blurb: "Talk to this agent from the 5dive web and mobile chat.",
};

export const fiveDiveChannelBase = {
  id: CHANNEL_ID,
  meta: fiveDiveMeta,
  capabilities: { chatTypes: ["direct"] },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    listAccountIds: () => listFiveDiveAccountIds(),
    resolveAccount: (cfg, accountId) => resolveFiveDiveAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
    inspectAccount: (cfg, accountId) => inspectFiveDiveAccount(cfg, accountId),
    resolveAllowFrom: ({ cfg, accountId }) => resolveFiveDiveAccount(cfg, accountId).allowFrom,
  },
} satisfies Pick<ChannelPlugin<ResolvedFiveDiveAccount>, "id" | "meta" | "capabilities" | "reload" | "config">;
