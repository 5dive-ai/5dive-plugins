import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setFiveDiveRuntime, getRuntime: getFiveDiveRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "fivedive",
    errorMessage: "5dive app channel runtime not initialized",
  });

export { getFiveDiveRuntime, setFiveDiveRuntime };
