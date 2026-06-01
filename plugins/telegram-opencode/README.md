# telegram-opencode

A Telegram channel for the [opencode](https://opencode.ai) CLI.

**This is not an MCP fork.** The codex/grok/agy Telegram plugins embed an MCP
server the agent polls with `wait_for_message`. opencode ships a headless HTTP
server (`opencode serve`) with a `GET /event` SSE push stream, so this plugin is
instead a **long-running relay** that sits *outside* the model:

```
Telegram inbound ─▶ POST /session/{id}/message ─▶ assistant reply ─▶ Telegram
GET /event (SSE) ─▶ permission.asked ─▶ Telegram inline buttons ─▶ permission reply
                 ─▶ session.error    ─▶ Telegram
```

Because the server pushes events, the relay needs **none** of the codex-family
compensation machinery: no `wait_for_message` loop, no re-arm watchdog
(`server.heartbeat` is the liveness signal), no Stop/silence hooks
(`session.idle` marks turn-end), and no file-IPC permission bridge
(`permission.asked` + the permission-reply route are first-class API). See
`../telegram-opencode-SPIKE.md` (DIVE-11) for the feasibility findings.

## Run

```sh
# token + (optional) server config live in ~/.opencode/channels/telegram/.env
#   TELEGRAM_BOT_TOKEN=123456789:AAH...
#   OPENCODE_SERVER_PASSWORD=<set this — serve is unsecured otherwise>
#   OPENCODE_MODEL=opencode/big-pickle        # optional; else opencode's default
#   OPENCODE_SERVER_URL=http://127.0.0.1:4096 # optional; else the relay spawns serve
bun start          # = bun install + bun server.ts
bun pair.ts        # allowlist your Telegram user id (run while the relay is up)
```

If `OPENCODE_SERVER_URL` is set and reachable the relay attaches to that server;
otherwise it spawns `opencode serve` on `OPENCODE_SERVE_PORT` (default 4096) as a
child and tears it down on exit. `OPENCODE_PROJECT_DIR` sets the serve cwd.

## Commands

`/help /status /stop /restart /agents /tasks /task /org /model /ping /start` —
same menu as the sibling forks. `/stop` aborts the current turn
(`POST /session/{id}/abort`); `/model <providerID>/<modelID>` switches the model
for your next message; `/status` shows the server URL, model, and opencode version.

## v1 limitations (vs the MCP forks)

The model is **Telegram-unaware** — the relay forwards your message as a prompt
and sends the model's text turn back as one reply. So unlike the MCP forks, the
model can't (yet) drive progressive edits, attach files, react, or thread
`reply_to` itself. Image/file inbound is forwarded as a caption note, not yet
fed to the model. Wiring an MCP tool *back into* opencode (opencode supports MCP)
to give the model those controls is the natural v2.

## Notes

- One continuous opencode session per Telegram chat (persisted in
  `sessions.json`); a server restart that drops sessions is detected and a fresh
  one is created.
- Bind `serve` to loopback and set `OPENCODE_SERVER_PASSWORD` — `serve` logs a
  warning when unsecured.
