import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { fiveDiveChannelBase } from "./src/channel-base.js";

// Onboarding and read-only status load this instead of index.ts: config and
// account reads only, no spool polling.
export default defineSetupPluginEntry(fiveDiveChannelBase);
