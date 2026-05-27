# telegram-codex MCP

A Telegram bridge for [OpenAI Codex CLI](https://github.com/openai/codex),
delivered as a stdio MCP server.

Sibling to the [`telegram/`](../telegram/) plugin (which targets Claude
Code). Forked rather than shared because the runtime contracts diverge —
Codex has no channel-notification protocol, so inbound delivery here is
poll-based via a `wait_for_message` tool instead of pushed via channels.

## What you get

Five MCP tools available to Codex:

- `wait_for_message` — block until the user sends a DM/group message.
- `reply` — send a new Telegram message (text, MarkdownV2, file attachments).
- `edit_message` — patch a prior bot message in place (silent, no push).
- `react` — emoji reaction on an inbound message.
- `download_attachment` — fetch a file by `file_id` into the local inbox.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

**1. Install the server**

```sh
git clone https://github.com/5dive-com/5dive-plugins
cd 5dive-plugins/plugins/telegram-codex
bun install
```

**2. Save the bot token**

```sh
mkdir -m 700 -p ~/.codex/channels/telegram
cat > ~/.codex/channels/telegram/.env <<EOF
TELEGRAM_BOT_TOKEN=123456789:AAH...
EOF
chmod 600 ~/.codex/channels/telegram/.env
```

**3. Seed the allowlist**

Two options:

**3a. Pair via the bot (recommended)**

```sh
bun pair.ts
```

The CLI prints `DM @<botname> from your Telegram account within 60s to
pair...`. Send any message to your bot from the Telegram account you
want allowed. The CLI captures your user_id, writes
`~/.codex/channels/telegram/access.json`, and replies "✅ paired" in
the chat.

Re-run anytime to add another user to the allowlist. Conflicts with a
running Codex MCP server (one getUpdates consumer per token) — stop
Codex first, pair, then restart.

**3b. Hand-write access.json**

```json
{
  "allowFrom": ["123456789"],
  "groups": {
    "-1001234567890": { "requireMention": false, "allowFrom": [] }
  }
}
```

- `allowFrom` — Telegram user IDs allowed to DM the bot. In a DM the
  `chat_id` equals the user ID.
- `groups` — group/supergroup chat IDs (negative) and per-group policy.
  - `requireMention: true` only routes messages that `@mention` the bot
    (or quote-reply to it).
  - `allowFrom: []` falls back to the top-level `allowFrom` list; a
    non-empty list overrides per group.

Messages from anyone not on the lists are silently dropped before they
reach `wait_for_message`. Group access can only be configured by
hand-writing access.json — the `pair.ts` CLI handles DMs only.

**4. Wire into Codex**

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.telegram]
command = "bun"
args = ["/absolute/path/to/5dive-plugins/plugins/telegram-codex/server.ts"]
```

**5. Add the comms playbook**

Drop the contents of [`AGENTS.md`](./AGENTS.md) into your
`~/.codex/AGENTS.md` so the model knows when and how to use the tools.

**6. (Optional) Wire the "turn complete" ping**

To get a Telegram ping every time Codex finishes a turn, add the `Stop`
hook to `~/.codex/config.toml`:

```toml
[features]
hooks = true

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "bun /absolute/path/to/5dive-plugins/plugins/telegram-codex/hooks/notify-stop.ts"
async = false
```

Codex 0.134 doesn't support `async = true` — keep it sync. The hook
fires once per Codex turn and runs in under a second.

Override the message text per-session with `CODEX_NOTIFY_TEXT=...`;
silence pings entirely with `CODEX_NOTIFY_DISABLED=1` (useful when
you're already talking to the bot via `wait_for_message`/`reply` and
the Stop ping would be duplicate).

**7. Run Codex**

```sh
codex
```

DM your bot. Codex calls `wait_for_message`, your DM resolves it, Codex
replies via the `reply` tool. Done.

## Differences from the Claude Code build

| Concern               | `telegram/` (Claude Code)              | `telegram-codex/` (this)         |
| --------------------- | -------------------------------------- | -------------------------------- |
| Inbound delivery      | `claude/channel` JSON-RPC notification | `wait_for_message` blocking tool |
| Permission relay      | `claude/channel/permission` protocol   | not yet (planned for v0.2)       |
| Slash commands        | `/telegram:configure`, `:access`, …    | not yet (Codex plugin API TBD)   |
| Lifecycle hooks       | PreToolUse, Stop, etc.                 | `Stop` hook ships in `hooks/`    |
| State dir             | `~/.claude/channels/telegram/`         | `~/.codex/channels/telegram/`    |
| Pairing flow          | code via DM → `/telegram:access pair`  | `bun pair.ts` standalone CLI     |

## Roadmap

- v0.1.0 — outbound + blocking inbound, preconfigured allowlist
- v0.1.1 — `Stop` hook for "turn complete" Telegram ping
- v0.1.2 — pairing CLI (`bun pair.ts`) for one-shot user-id capture (this)
- v0.2.0 — approval-mode bridge so risky-command y/n prompts route to TG
