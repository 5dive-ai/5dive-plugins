# telegram-codex

A Telegram and dashboard bridge for [OpenAI Codex CLI](https://github.com/openai/codex).
Its primary entrypoint owns a persistent local `codex app-server` process, so
inbound messages start or steer turns without asking the model to poll.

The original stdio MCP bridge remains available as a compatibility fallback.

## Primary dispatcher

Run `bun start` (or the installed `telegram-codex-dispatcher` binary). The
dispatcher uses Codex app-server's supported local stdio transport, persists
its thread and delivery ids under `~/.codex/channels/dispatcher/`, and launches
the selected channel adapters. Telegram is enabled by default; enable both with:

```sh
CODEX_DISPATCHER_CHANNELS=telegram,dashboard bun start
```

Inbound behavior is source-safe: a message starts `turn/start` while idle,
same-conversation messages use `turn/steer`, and another source waits for the
active turn to finish. Agent-message events are written to the matching
channel outbox, so a Telegram turn cannot reply into dashboard chat.

The state file survives process restarts. A delivery id is handled once; an
inbox file is removed only after app-server accepts it. If dispatch fails, the
file remains and is retried. If the process restarts during a turn, the source
gets an explicit interrupted-turn notice and queued messages continue after the
thread resumes. Supervisors should restart the dispatcher when it exits after
an app-server or adapter failure. Thread sandbox and approval settings are
inherited from Codex configuration; because this headless dispatcher has no
approval UI, app-server approval requests are declined rather than escalated.

The model and reasoning effort follow the seat config on every start: the
dispatcher reads them through app-server `config/read` and passes them to
`thread/resume` and each `turn/start`, because a resumed thread otherwise keeps
the model it was saved with. So `/model` (or a `config.toml` edit) plus a
restart switches the EXISTING conversation, history intact. `health.json`
records `threadModel`/`threadEffort` as the app-server reports them, and
`/status` prints a `conversation:` line whenever that differs from the config.

Dashboard delivery keeps using `~/.claude/channels/dashboard/` as a runtime-
neutral compatibility path because shelld writes durable inbound drops there.
To attach a local file in dispatcher mode, Codex emits a non-empty caption plus
a separate `[[5dive-attachment:/absolute/path]]` line. The directive is removed
from chat text and up to ten files are sent only on the response's source
channel.

## MCP polling fallback

Run `bun run start:mcp-fallback` and wire `server.ts` into Codex only when the
dispatcher cannot be used. This legacy path exposes five MCP tools:

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
git clone https://github.com/5dive-ai/5dive-plugins
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

**4. Optional: wire the polling fallback into Codex**

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.telegram]
command = "bun"
args = ["/absolute/path/to/5dive-plugins/plugins/telegram-codex/server.ts"]
```

**5. Add the comms playbook**

Drop the contents of [`AGENTS.md`](./AGENTS.md) into your
`~/.codex/AGENTS.md` so the model knows when and how to use the tools.

**6a. (Optional) Wire the "approve risky commands from Telegram" bridge**

Codex's `PermissionRequest` hook fires every time it wants to run a command
that exceeds its current `approval_policy` / `sandbox_mode`. The
`request-permission.ts` hook in this plugin routes that prompt to your
Telegram bot — a message with **✅ allow / ❌ deny** inline buttons. Tap one
and Codex proceeds (or doesn't).

```toml
[features]
hooks = true

[[hooks.PermissionRequest]]

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "bun /absolute/path/to/5dive-plugins/plugins/telegram-codex/hooks/request-permission.ts"
timeout = 180
async = false
```

Behavior notes:

- **Fail-closed.** If the MCP server isn't running (no Telegram bridge),
  or no one taps a button before the 120s default timeout, the hook
  returns `deny`. Codex's native UI then takes over — you're never
  silently auto-approved.
- The MCP server must be live for the bridge to work. In practice this
  means Codex must have called at least one telegram tool earlier in the
  session (the MCP server lazy-spawns). For one-shot Codex runs where
  the very first action is privileged, the bridge will fall through to
  Codex's native UI.
- **Hook trust gate.** On the first session after wiring this hook,
  Codex shows a one-time "Hook needs review" TUI prompt. Press `2` (or
  `t`) to trust. Codex persists the decision in `[hooks.state]` of the
  config.
- **Override timeout** with `CODEX_TG_APPROVAL_TIMEOUT_MS` env (range
  5000–600000).
- **Bypass entirely** with `CODEX_TG_APPROVAL_DISABLED=1` env — useful
  for unattended runs where you want Codex's own approval policy to be
  authoritative without going to Telegram.

This is useless if your `approval_policy = "never"` / `sandbox_mode =
"danger-full-access"`. The bridge only matters when Codex actually
needs to ask.

**6b. (Optional) Wire the "turn complete" ping**

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

**7. Run the dispatcher**

```sh
bun start
```

DM your bot. The channel adapter submits the message directly to app-server and
routes streamed agent messages back. No model-owned listen loop is involved.

## Compatibility

The dispatcher checks the pair before it starts anything. `codex --version`
below the floor is refused by name — written to `health.json` as the bridge's
failure cause and to `lifecycle.log` — instead of surfacing as an app-server
exit code that a supervisor restarts forever.

| Component | Supported | Notes |
| --- | --- | --- |
| Codex CLI (dispatcher) | **>= 0.136.0**; tested through 0.156.1 | 0.135.0 and older reject `app-server --stdio` (measured on 0.100–0.135). Newer than the tested range is allowed and recorded as untested. |
| Codex CLI (MCP fallback) | any release with MCP servers + hooks | `server.ts` never starts app-server. |
| Dispatcher state (`state.json`) | schema 1; files with no `schema` migrate in place | Idempotent. A file from a newer bridge, or one that does not parse, is moved to `state.json.quarantined-<ms>` and the next turn says the earlier conversation is not in context. |
| Health handshake (`health.json`) | schema 1 | 5dive's reader reports a schema it does not know as unreadable and never guesses. The `codex` block is optional, so it is not a schema bump. |
| npm package (`@5dive/telegram-codex-mcp`) | 0.5.7 is the newest published | `.mcp.json` pins it for the Codex plugin install. The dispatcher is not in that package. |

`CODEX_DISPATCHER_ALLOW_UNSUPPORTED=1` bypasses the floor for a deliberate
canary. Do not set it on a seat: below the floor app-server exits before the
first request.

## Upgrade, canary and rollback

5dive boxes run the dispatcher from `/usr/local/lib/5dive/telegram-codex`.
`install.sh --upgrade` copies this directory from the `main` branch, so merging
here reaches every box at its next upgrade. To take a change onto one box
first, use `release.sh`:

```sh
# 1. stage the candidate with its dependencies
cp -a plugins/telegram-codex /tmp/tcx-candidate
(cd /tmp/tcx-candidate && bun install --production)

# 2. preflight as the seat user: its Codex, its saved state; starts nothing
sudo -u agent-codex -H env CODEX_BIN=$(command -v codex) \
  bash /tmp/tcx-candidate/release.sh check /tmp/tcx-candidate

# 3. make it live (the old tree is kept), then restart ONE seat and watch it
sudo bash /tmp/tcx-candidate/release.sh promote /tmp/tcx-candidate
sudo 5dive agent restart codex
cat /home/agent-codex/.codex/channels/dispatcher/health.json   # bridgeVersion, codex, bound

# 4. if it misbehaves: swap back and restart
sudo bash /usr/local/lib/5dive/telegram-codex/release.sh rollback
sudo 5dive agent restart codex
```

`check` prints one JSON line (`ok`, `codex`, `state`) and exits 1 on an
unsupported pair. `promote` runs the same check and changes nothing when it
fails. `rollback` swaps the live tree with the previous one, so running it again
rolls forward. State stays compatible in both directions: a pre-0.5.20 bridge
ignores the `schema` field, and a newer schema is quarantined, not misread.
A box-local rollback lasts until that box's next `install.sh --upgrade`.
Rolling back the whole fleet means reverting on `main`.

## Differences from the Claude Code build

| Concern               | `telegram/` (Claude Code)              | `telegram-codex/` (this)         |
| --------------------- | -------------------------------------- | -------------------------------- |
| Inbound delivery      | `claude/channel` JSON-RPC notification | app-server `turn/start` / `turn/steer` (MCP polling fallback retained) |
| Permission relay      | `claude/channel/permission` protocol   | `PermissionRequest` hook + buttons |
| Slash commands        | `/telegram:configure`, `:access`, …    | bot-side menu (`/help` `/status` `/stop` `/restart` `/agents` `/tasks` `/task` `/org` `/model` `/ping` `/start`) |
| Lifecycle hooks       | PreToolUse, Stop, etc.                 | `Stop` hook ships in `hooks/`    |
| State dir             | `~/.claude/channels/telegram/`         | `~/.codex/channels/telegram/`    |
| Pairing flow          | code via DM → `/telegram:access pair`  | `bun pair.ts` standalone CLI     |

A fifth runtime, [`telegram-opencode`](../telegram-opencode), is **not** in this
family: opencode ships a headless HTTP server, so its bridge is a long-running
relay (no `wait_for_message`, no watchdog, no hooks) rather than an MCP server.

## Roadmap

- v0.1.0 — outbound + blocking inbound, preconfigured allowlist
- v0.1.1 — `Stop` hook for "turn complete" Telegram ping
- v0.1.2 — pairing CLI (`bun pair.ts`) for one-shot user-id capture
- v0.1.3 — approval-mode bridge: `PermissionRequest` → Telegram buttons
- v0.1.4 — bot slash commands (`/help`, `/status`, `/ping`) + setMyCommands menu; wait_for_message capped at 90s to stay inside Codex's MCP-call timeout
- v0.1.5 — `reply` chunks text >4000 chars across multiple Telegram messages (paragraph→line→word→hard cut), so long Codex outputs no longer fail with 400 Bad Request
- v0.1.6 — Stop hook suppresses the "turn complete" ping when Codex sent a `reply` within the last 30s (the user already knows). Override via `CODEX_NOTIFY_SUPPRESS_MS` env (0 disables suppression)
- v0.1.7 — typing indicator (re-sends `sendChatAction` every 4s between `wait_for_message` and `reply`, with a 5min ceiling) so a thinking Codex looks different from a hung one
- v0.1.8 — silence watchdog `PreToolUse` hook — pings "🟡 still working — N tool calls in, Xs since last reply" when Codex has been silent past `CODEX_SILENCE_WATCHDOG_MS` (default 120000). Single ping per silence window — the hook resets its own clock so spam is impossible.
- v0.1.9 — `Notification` hook relays error-flavored notifications (rate limit, API failure, timeout) to Telegram with a `⚠️ codex: …` prefix. Relay-all override via `CODEX_NOTIFY_RELAY_ALL=1`; disable via `CODEX_NOTIFY_RELAY_DISABLED=1`
- v0.1.10 — `/stop` bot command sends Ctrl-C via tmux to interrupt the current Codex turn; `/restart` invokes `sudo 5dive agent restart <name>` so the systemd unit respawns the session in ~2s. Both gated on allowFrom
- v0.1.11 — `/agents` lists sibling 5dive agents on the host (active/inactive, type, channel, marks self). Wraps `sudo 5dive agent list --json`
- v0.2.0 — configurable knobs in `access.json`: `ackReaction` (emoji on every inbound, off by default), `textChunkLimit` (override the 4000-char chunker cap, range 500–4096), `dmPolicy` (allowlist/static — reserved for forward parity)
- v0.2.1 — `notify-user` skill (`skills/notify-user/SKILL.md`) — Codex-adapted comms playbook covering cadence, the wait_for_message loop, files/images/reactions, the approval bridge, and security. Description trimmed under Codex's 1024-char SKILL.md limit.
- v0.2.2 — quieter user-facing pings: silence-watchdog now says `⏳ still working…` instead of dumping `N tool calls in, Xs since last reply` (telemetry read like debug output). `notification-relay` drops transient `RetryState` payloads and, when the upstream hands us a Rust `Debug`-formatted `SessionNotification { ... }` blob, extracts the inner `reason:` field instead of forwarding the whole struct.
- v0.2.3 — silence-watchdog backoff: first ping in a silence stretch trips at the base threshold (default 2 min); the 2nd ping needs ~20 min of additional silence, the 3rd+ needs ~30 min (cap). A real `reply` resets the counter. Stops the "⏳ still working…" message from feeling like a 2-minute heartbeat during long silent runs.
- v0.2.4 — `PLUGIN_VERSION` now reads from `package.json` at startup instead of a hardcoded const, so `/ping` / `/status` / `setMyCommands` report the actual shipped version. Previous PATCH bumps shipped the code but `/status` kept showing `0.2.1`.
- v0.2.5 — silence-watchdog base default raised from 2 min → 10 min. With backoff (1× / 10× / 15×), the cadence on a truly silent run is now ~10 min, then +100 min, then +150 min cap — far less surprise during normal back-and-forth where the user just sent a slash command 2 minutes ago. Override via `CODEX_SILENCE_WATCHDOG_MS` as before.
- v0.2.6 — silence-watchdog is now **off by default**. With `notify-user` auto-seeded, the agent already acks + edits progress updates; the watchdog ping was a redundant heartbeat that just felt like noise. Opt back in with `CODEX_SILENCE_WATCHDOG_ENABLED=1`.
- v0.2.7–v0.5.12 — kept in lockstep with the Claude `telegram` build (inbox, gate cards, task buttons, single-flight poller, `/model`). `TODO.md` and the git history have the per-release detail.
- DIVE-3960 — the primary entrypoint is the app-server dispatcher (`bun start`), and MCP polling becomes the fallback.
- DIVE-3964 — `health.json` handshake: bound/listening, last inbound and outbound, queue depth and a named failure cause, refreshed every 15s.
- v0.5.13 — DIVE-3965: a clean stop and a crash are different sentences in the chat. Recovery context rides the next turn.
- v0.5.20 — DIVE-3969: compatibility handshake. Codex below 0.136.0 is refused by name, `state.json` is versioned with idempotent migration and quarantine, `bun dispatcher.ts --check` preflights a tree, `release.sh` does canary, promote and rollback, and CI checks the packaged file list, versions and documented commands.
- v0.5.21 — DIVE-4924: a model switch applies to the EXISTING conversation. The dispatcher reads the seat model/effort via app-server `config/read` and passes them to `thread/resume` and every `turn/start`; `health.json` records the thread's actual model and `/status` prints a `conversation:` line when it differs from the config.
