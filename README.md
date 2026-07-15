<!-- POSITIONING/marketing copy + public-repo naming are owned by marketing; this is a neutral placeholder. -->

# telegram-pi-bridge

Run your pi coding agent from Telegram. A long-running relay that hosts pi
in-process via its SDK and streams replies back into a chat. Every mutating tool
(bash/write/edit) is gated behind a Telegram approval tap; read-only tools
(read/ls/grep/find) run silently.

## Requirements

- [bun](https://bun.sh) (the bridge runs on bun).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A provider API key for pi (for example `ANTHROPIC_API_KEY`).

## Install

```
bun install
```

## Configure

- Bot token: set `TELEGRAM_BOT_TOKEN` in the environment, or write it to
  `~/.pi/channels/telegram/.env` as `TELEGRAM_BOT_TOKEN=123456789:AAH...`.
  The file is locked to owner-only (`0600`) on startup.
- pi auth: pi's default auth storage falls back to an environment API key such
  as `ANTHROPIC_API_KEY`. Set the key for whichever provider you use.
- Optional: `PI_PROJECT_DIR` sets the directory pi's tools operate in (defaults
  to the current working directory). `TELEGRAM_STATE_DIR` overrides where
  `access.json`, `.env`, and the poller lock live.

## Pair a user

Only allowlisted Telegram user ids may talk to the bot. To add yourself, stop
the bridge first (Telegram allows one poller per token), then run the pairing
tool and DM the bot:

```
bun pair.ts
```

It prints the bot's `@username`, waits for your first DM, and appends your user
id to `access.json`. The `telegram-pi-pair` bin does the same.

## Run

```
bun server.ts
```

Or via the package script:

```
bun start
```

Anything you send that is not a command is forwarded to pi as a prompt. Replies
stream back and are edited in place as they grow.

## Permission gate

pi has no built-in permission system, so this bridge is sandboxed by default.
When pi wants to run a mutating tool it posts a `🔐` prompt with three buttons:

- once: allow this single call.
- always: allow this tool for the rest of the session.
- reject: block the call.

The gate fails closed: if the prompt cannot be delivered, or no one answers
within the timeout, the call is blocked.

## Commands

- `/help` — show commands.
- `/status` — model, active chats, uptime, bridge and pi SDK versions.
- `/stop` — abort the current turn.
- `/restart` — reset the pi session (does not restart the process).
- `/model` — show the model, or switch with `/model <provider>/<modelId>`.
- `/ping` — liveness check.
- `/start` — pairing help for this chat.
