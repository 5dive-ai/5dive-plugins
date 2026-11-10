# @5dive/opencode-chat

Talk to OpenCode from the 5dive web and mobile chat ([5dive.app](https://5dive.app)).

## Install

Add the plugin to your `opencode.json`:

```json
{ "plugin": ["@5dive/opencode-chat"] }
```

Then run OpenCode as usual (the TUI, or `opencode serve`). On a 5dive box nothing else is needed: the plugin reads the chat where the box puts it (`~/.opencode/channels/5dive`). Elsewhere, pass the folder your 5dive bridge uses: `["@5dive/opencode-chat", { "spoolDir": "/path" }]`, or set `FIVEDIVE_SPOOL_DIR`.

## How it works

- The 5dive bridge on your box writes each chat message to `<spool>/inbox/` and sends whatever appears in `<spool>/outbox/dashboard/`.
- The plugin checks the inbox once a second and answers each message, in order, in one OpenCode session titled "5dive web chat". Open that session in the TUI to see the chat there. The text OpenCode writes after its last tool call is the reply.
- While OpenCode runs with the plugin, it marks `<spool>/reader.json`, and the box's own background reader stands aside, so nothing is answered twice. Stop OpenCode and the box answers the chat again on its own, in the same session.
- `opencode run` never reads the chat: it is a one-shot run.
- A tool that asks permission waits for an answer in the TUI. Under `opencode serve`, allow what the chat may do in your `permission` config.

No token: the spool folder is private to your user (mode 0700), so only you can put messages in it.

MIT licensed. Source: [5dive-ai/5dive-plugins](https://github.com/5dive-ai/5dive-plugins/tree/main/plugins/dashboard/opencode-chat).
