# telegram-pi — provisioning contract (for 5dive-cli / agent-start)

Bridge-side facts the installer must satisfy. Grounded in `server.ts` @ v0.1.0.
`install_channel_for_pi_agent` + the `5dive-agent-start` pi branch (DIVE-1201)
already implement this; this file is the confirmation-of-contract + reference.

Key distinction: pi has **no MCP/hooks config surface** (DIVE-1198 spike). It is
**extension-based** and ships a first-class in-process SDK, so telegram-pi is a
**standalone relay that HOSTS pi in-process** via `createAgentSession()`. That's
a **FOURTH run-model**:
`claude = --channels flag` · `codex/grok/agy = MCP server via config` ·
`opencode = HTTP relay over opencode serve` · `pi = in-process SDK host`.

Unlike opencode, there is **no child server process** and **no loopback port** —
the relay imports pi and drives it directly. Permission gating is done by the
relay itself (pi has no permission system), via pi's extension `tool_call`
block-hook: mutating tools (bash/write/edit) await a Telegram once/always/reject
tap before running. **Sandboxed-by-default** (DIVE-1198).

---

## 1. Relay launch command

```
cwd:   <plugin_dir>            # the telegram-pi checkout (so bun finds node_modules)
user:  agent-<name>            # same as the other bridges (NOT claude)
cmd:   bun run --cwd <plugin_dir> --shell=bun --silent start
                               # package.json "start" = "bun install --no-summary && bun server.ts"
                               # (server.ts has `#!/usr/bin/env bun`)
```

- This IS the agent's main process. In `5dive-agent-start`, for
  `type=pi && channels=telegram`, `BIN=/home/claude/.local/bin/bun`,
  `ARGS=(run --cwd <plugin_dir> --shell=bun --silent start)`. The relay exits →
  restart loop is correct.
- For `type=pi && channels=none`: launch the pi TUI (`BIN=…/pi ARGS=()`) as today.

## 2. Environment contract

| var | required | default | meaning |
|-----|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | **yes** | — | also read from `<STATE_DIR>/.env`; real env wins |
| `TELEGRAM_STATE_DIR` | no | `${PI_HOME:-~/.pi}/channels/telegram` | bridge state root |
| `PI_HOME` | no | `~/.pi` | only used to derive the default STATE_DIR |
| `PI_AGENT_DIR` | no | pi's `getAgentDir()` = `~/.pi/agent` | pi config home (settings.json / auth.json / sessions) |
| `PI_PROJECT_DIR` | no | `process.cwd()` | working dir the hosted pi's tools operate in (bash cwd etc.) |
| `PI_BIN` | no | — | abs path to the pi binary; exported by agent-start's `PI_OVERRIDE` for parity (the relay hosts pi via the SDK, not this binary, but kept for the TUI/`/status` path) |
| `<PROVIDER>_API_KEY` | **yes** | — | e.g. `ANTHROPIC_API_KEY` — pi's default AuthStorage falls back to the env var (DIVE-1200); systemd injects it. No `auth.json` write needed. |

Model selection is **not** an env var (pi has no `PI_MODEL`): it comes from
`~/.pi/agent/settings.json` `{defaultProvider, defaultModel}`, written at create
by DIVE-1205 and by the bridge's `/model` command. `PI_PROJECT_DIR` + `PI_BIN`
are exported by agent-start's `PI_OVERRIDE`.

Minimum viable env: `TELEGRAM_BOT_TOKEN` + the correct provider `*_API_KEY`
(+ a `settings.json` model pin so pi boots onto the intended model).

## 3. State-dir layout (what the relay reads/writes)

Root = `TELEGRAM_STATE_DIR` (default `~/.pi/channels/telegram`), created `0700`.
Installer must create it and write:

- `<STATE_DIR>/.env` — `TELEGRAM_BOT_TOKEN=<token>\n`, mode **0600** (bridge
  re-chmods 0600 on boot regardless).
- `<STATE_DIR>/access.json` — mode **0600**, schema:
  ```json
  { "allowFrom": ["<userId>", "..."], "groups": {}, "dmPolicy": "allowlist", "pending": {} }
  ```
  `dmPolicy`: `allowlist` (default) | `pairing` | `static`. For
  `--allowed-users`, put the ids in `allowFrom`; with no ids seed `pairing`.
  **Seed UNCONDITIONALLY** — a missing file = every DM silently dropped
  (DIVE-45). `seed_pi_telegram_access` already does this.

Bridge-managed (installer must NOT pre-create, but the dir must be writable):
`bot.pid`. Conversation history lives in pi's own `~/.pi/agent/sessions/`.

## 4. Plugin-dir resolver (parallel to codex/grok/opencode)

Ordered candidates:
```
$TELEGRAM_PI_PLUGIN_DIR
/usr/local/lib/5dive/telegram-pi
/home/claude/projects/5dive/5dive-plugins/plugins/telegram-pi
```
`bun` must be on the agent user's PATH (same prerequisite as opencode). The dir
must contain `server.ts` (agent-start checks this to pick the relay branch).

## 5. Lifecycle

- **Token change → restart required.** The relay reads the token only at boot. On
  rotation, rewrite `<STATE_DIR>/.env` then restart the agent service. The bridge
  self-heals a stale *poller* of the same token (PID_FILE → SIGTERM the old pid),
  but a NEW token needs a process restart.
- **Provider/model change:** update `~/.pi/agent/settings.json` (or use `/model`)
  then restart / send the next message. The bridge disposes + rebuilds the chat's
  pi session on `/model` so the new model applies immediately.
- **Permission gate:** the once/always/reject buttons are the bridge's own, fired
  from pi's `tool_call` extension hook for `bash`/`write`/`edit`. No pi-side config
  governs this — it is unconditional, sandboxed-by-default. Read-only tools
  (read/ls/grep/find) run silently. A never-answered gate blocks after a 10-min
  timeout; a Telegram send-failure fails CLOSED (blocks).

## 6. v1 limitations (documented, like telegram-opencode v1)

- Per-chat pi sessions are held **in memory** for the relay's lifetime; a relay
  restart starts fresh conversations (pi still persists each turn to
  `~/.pi/agent/sessions/`, so history isn't lost — it's just not auto-resumed
  into the chat). Cross-restart chat→session resume is a follow-up.
- Image/document inputs forward the caption only (no vision wiring yet).

---

## Smoke checklist (what a real create+telegram should prove)
1. `agent create --type pi --channels telegram --provider anthropic --api-key <k> --allowed-users <id>` exits 0.
2. `<STATE_DIR>/.env` has the token (0600), `access.json` has the id (0600),
   `~/.pi/agent/settings.json` has the model pin.
3. agent service boots → relay logs `polling as @<bot> (hosting pi via in-process SDK)`.
4. DM the bot → streamed reply (edit-in-place). Send a prompt that needs bash
   (e.g. "run `ls` and tell me what's here") → 🔐 once/always/reject buttons →
   tap once → command runs, reply streams.
5. Send a mutating prompt and tap **reject** → pi reports the tool was blocked.
6. `/status` shows model + active chats; `/model anthropic/<id>` switches; `/stop` aborts.

Ping agent-dev for anything bridge-facing.
