import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { fiveDivePlugin } from "./src/channel.js";
import { setFiveDiveRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "fivedive",
  name: "5dive app",
  description: "The 5dive web and mobile chat, through the box's local spool.",
  plugin: fiveDivePlugin,
  setRuntime: setFiveDiveRuntime,
});
