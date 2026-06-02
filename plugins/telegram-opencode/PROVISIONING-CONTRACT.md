# telegram-opencode — provisioning contract (for 5dive-cli / agent-start)

Bridge-side facts main needs to implement `install_channel_for_opencode_agent`
+ the agent-start relay branch. All grounded in `server.ts` @ v0.1.1 (de0b07b).

Key distinction: opencode is a **standalone relay**, not an MCP server. It runs
as the agent's *main long-running process* and itself spawns `opencode serve`
over loopback HTTP. So the run-model is a THIRD pattern:
`claude = --channels flag` · `codex/grok = MCP server via config` · `opencode = relay`.

---

## 1. Relay launch command

```
cwd:   <plugin_dir>            # the telegram-opencode checkout (so bun finds node_modules)
user:  agent-<name>            # same as the other bridges (NOT claude)
cmd:   bun server.ts           # server.ts has `#!/usr/bin/env bun`; package.json
                               # "start" = "bun install --no-summary && bun server.ts"
```

- This IS the agent's main process. In `5dive-agent-start`, for
  `type=opencode && channels=telegram`, set `BIN=bun`, `ARGS=(server.ts)`,
  cwd=`<plugin_dir>` — instead of the current `BIN=opencode ARGS=()` (TUI) at
  line 54. The existing `while true; do … sleep 2; done` loop is correct (relay
  exits → restart).
- For `type=opencode && channels=none`: keep launching the TUI as today.

## 2. Environment contract

| var | required | default | meaning |
|-----|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | **yes** | — | also read from `<STATE_DIR>/.env`; real env wins |
| `TELEGRAM_STATE_DIR` | no | `${OPENCODE_HOME:-~}/.opencode/channels/telegram` | bridge state root |
| `OPENCODE_HOME` | no | `~/.opencode` | only used to derive the default STATE_DIR |
| `OPENCODE_SERVE_PORT` | no | `4096` | **⚠ FIXED — collision risk, see below** |
| `OPENCODE_PROJECT_DIR` | no | `process.cwd()` | cwd for the spawned `opencode serve` |
| `OPENCODE_BIN` | no | `opencode` | serve binary (set to the abs `/home/claude/.local/bin/opencode`) |
| `OPENCODE_SERVER_URL` | no | — | attach to an existing server instead of spawning |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | no | `opencode` / `` | basic-auth for the local server (loopback; unset → warns but works) |
| `OPENCODE_MODEL` | no | server default | `providerID/modelID`; overridden per-chat by `/model` |
| `OPENAI_API_KEY` | only for BYO | — | free `opencode/*` models need NO auth; BYO providers read this |

Minimum viable env for a free-model agent: just `TELEGRAM_BOT_TOKEN` +
`OPENCODE_BIN` (abs path) + a per-agent `OPENCODE_SERVE_PORT`.

### ⚠ Port collision (main's Q2) — needs a decision
`OPENCODE_SERVE_PORT` defaults to a **fixed 4096**. Two opencode agents on one
box would both try 4096 → the second `opencode serve` fails to bind. Options:
- **(preferred) I patch the bridge to auto-pick a free loopback port** (probe an
  ephemeral port, pass it to `opencode serve --port N`, use it as the base URL).
  Then provisioning never has to manage ports. Small, bridge-side, my lane — say
  the word and I'll ship it in a v0.1.2 before you wire the installer.
- or provisioning assigns a unique `OPENCODE_SERVE_PORT` per agent (e.g.
  `4096 + <agent index>`), passed via the agent env file.

## 3. State-dir layout (what the relay reads/writes)

Root = `TELEGRAM_STATE_DIR` (default `~/.opencode/channels/telegram`), created
`0700`. Installer must create it and write:

- `<STATE_DIR>/.env` — `TELEGRAM_BOT_TOKEN=<token>\n`, mode **0600** (bridge
  re-chmods 0600 on boot regardless).
- `<STATE_DIR>/access.json` — mode **0600**, schema:
  ```json
  { "allowFrom": ["<userId>", "..."], "groups": {}, "dmPolicy": "allowlist", "pending": {} }
  ```
  `dmPolicy`: `allowlist` (default) | `pairing` | `static`. For
  `--allowed-users`, put the ids in `allowFrom`. (Same access schema the
  codex/grok forks use — reusable verbatim.)

Bridge-managed (installer should NOT pre-create, but the dir must be writable):
`inbox/` (0700), `bot.pid`, `sessions.json`, `model`.

## 4. Plugin-dir resolver (parallel to codex/grok)

Ordered candidates (mirror `codex_plugin_dir` / `grok_plugin_dir`):
```
$TELEGRAM_OPENCODE_PLUGIN_DIR
/usr/local/lib/5dive/telegram-opencode
/home/claude/projects/5dive/5dive-plugins/plugins/telegram-opencode
```
Same `bun` prerequisite check as the others (bun must be on the agent user's PATH).

## 5. Lifecycle

- **Token change → restart required.** The relay reads the token only at boot.
  On rotation, rewrite `<STATE_DIR>/.env` then restart the agent service (same
  as codex/grok). The bridge already self-heals a stale *poller* of the same
  token (PID_FILE → SIGTERM the old pid), but a NEW token needs a process
  restart.
- **Spawned `opencode serve`** is a child of the relay and dies with it (SIGTERM
  handler kills it). It needs `--port` (OPENCODE_SERVE_PORT) and cwd
  (OPENCODE_PROJECT_DIR) — both already handled internally; just pass the env.
- **Permission prompts**: the once/always/reject buttons only appear when
  opencode *asks* for a tool. That's governed by opencode's own permission
  config (e.g. `opencode.json` `{"permission":{"bash":"ask"}}`) in the project
  dir — NOT by the bridge. Product decision whether to seed a default
  `opencode.json` into `OPENCODE_PROJECT_DIR`; with stock opencode defaults the
  bridge still works, you just get fewer interactive prompts.

---

## Smoke checklist (what a real create+telegram should prove)
1. `agent create --type opencode --channels telegram --allowed-users <id>` exits 0.
2. `<STATE_DIR>/.env` has the token (0600), `access.json` has the id (0600).
3. agent service boots → relay logs `polling as @<bot>` + `spawned opencode serve` + `subscribed to /event`.
4. DM the bot → streamed reply. Send a bash-tool prompt → 🔐 buttons → tap once → runs.
5. Second opencode agent on the same box → no port clash (validates the port fix).

I'll review the bridge-facing parts of your CLI branch + agent-start fork.
Ping me about the port-autopick decision (§2) — I'd lean toward doing it so your
installer stays port-agnostic.
