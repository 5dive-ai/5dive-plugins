// Account resolution. Setup-safe: no gateway or runtime imports, so the
// setup entry and read-only status can load it cheaply.

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveAllowFrom, resolveSpoolDir } from "./spool.js";

export const CHANNEL_ID = "fivedive" as const;
export const CHANNEL_LABEL = "5dive app";
export const DEFAULT_ACCOUNT_ID = "default";

/** `channels.fivedive` in the OpenClaw config. Every field is optional on a 5dive box. */
export type FiveDiveChannelConfig = {
  enabled?: boolean;
  spoolDir?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "allowlist" | "open" | "pairing" | "disabled";
  pollMs?: number;
};

export type ResolvedFiveDiveAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  spoolDir: string;
  allowFrom: string[];
  dmPolicy: NonNullable<FiveDiveChannelConfig["dmPolicy"]>;
  pollMs: number;
};

export function channelSection(cfg: OpenClawConfig | undefined): FiveDiveChannelConfig {
  const section = (cfg?.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID];
  return section && typeof section === "object" ? (section as FiveDiveChannelConfig) : {};
}

/** One account: a seat has one owner and one spool. */
export function listFiveDiveAccountIds(): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveFiveDiveAccount(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedFiveDiveAccount {
  const section = channelSection(cfg);
  const spoolDir = resolveSpoolDir(section.spoolDir, env);
  const pollMs = typeof section.pollMs === "number" && section.pollMs >= 100 ? section.pollMs : 500;
  return {
    accountId: accountId || DEFAULT_ACCOUNT_ID,
    name: CHANNEL_LABEL,
    enabled: section.enabled !== false,
    configured: Boolean(spoolDir),
    spoolDir,
    allowFrom: resolveAllowFrom(section.allowFrom, env),
    dmPolicy: section.dmPolicy ?? "allowlist",
    pollMs,
  };
}

/** Read-only diagnostics: never touches the spool. */
export function inspectFiveDiveAccount(cfg: OpenClawConfig | undefined, accountId?: string | null) {
  const account = resolveFiveDiveAccount(cfg, accountId);
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
  };
}
