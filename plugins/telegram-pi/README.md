# telegram-pi

A Telegram channel for the [pi](https://github.com/earendil-works/pi) CLI
(`@earendil-works/pi-coding-agent`).

**This is not an MCP fork, and not an HTTP relay either.** pi has no MCP/hooks
config surface (DIVE-1198 spike) — it is extension-based and ships a first-class
in-process SDK. So this plugin is a **long-running relay that HOSTS pi directly**
via `createAgentSession()`, a fourth run-model:

```
Telegram inbound ─▶ session.prompt(text) ─▶ text_delta stream ─▶ Telegram (edit in place)
pi tool_call hook (bash/write/edit) ─▶ 🔐 once/always/reject buttons ─▶ { block:true } on reject
```

## Sandboxed by default

pi ships **no permission system of its own** — open filesystem/process/network by
default (DIVE-1198). So this bridge is the sandbox boundary: every **mutating**
tool (`bash`, `write`, `edit`) is gated behind a Telegram **once / always /
reject** tap, implemented with pi's extension `tool_call` block-hook (which can
return `{ block: true }`). Read-only tools (`read`, `ls`, `grep`, `find`) run
silently. A never-answered gate blocks after 10 minutes; a Telegram send-failure
fails **closed**. This is why the bridge hosts pi via the SDK rather than letting
pi consume our Telegram MCP server — an MCP server can only gate MCP tools, never
pi's own internal tools.

## Run

```sh
# token lives in ~/.pi/channels/telegram/.env
#   TELEGRAM_BOT_TOKEN=123456789:AAH...
# the provider key is read from the environment (pi's default auth), e.g.
#   ANTHROPIC_API_KEY=sk-ant-...
# the model comes from ~/.pi/agent/settings.json {defaultProvider, defaultModel}
bun start          # = bun install + bun server.ts
bun pair.ts        # allowlist your Telegram user id (run while the relay is DOWN)
```

## Commands

`/help /status /stop /restart /agents /tasks /task /org /model /ping /start` —
same menu as the sibling forks. `/stop` aborts the current turn
(`session.abort()`); `/model <provider>/<modelId>` writes the pin to
`~/.pi/agent/settings.json` and rebuilds your chat's session so it applies to
your next message; `/status` shows the model, active chats, and pi version.

## v1 limitations

- Per-chat pi sessions are held **in memory** for the relay's lifetime; a relay
  restart starts fresh conversations. pi still persists each turn to
  `~/.pi/agent/sessions/`, so history isn't lost — it's just not auto-resumed
  into the chat yet.
- Image/document inbound is forwarded as a caption note, not yet fed to the model
  as vision input.

## Notes

- One continuous pi `AgentSession` per Telegram chat, hosted in-process.
- Access control / pairing / streaming edit-in-place / inline-button transport
  are reused verbatim from the telegram-opencode fork — the divergence is only
  the engine (in-process pi SDK) and the permission gate (pi extension hook).
