# telegram-grok roadmap

Parity with `plugins/telegram/` (the Claude Code build) is the goal,
forked from `plugins/telegram-codex/` because Grok shares Codex's
poll-based inbound model (no Claude-Code `channel` push protocol). Items
ordered by UX criticality unless noted.

## Up next

## Still open

- ExecStopPost in 5dive's systemd unit for true crash-aware notification.

## Resolved (2026-05-28, 5dive-cli 0.1.11)

- `grok --channels=telegram` provisioning shipped end-to-end by main (mirrors
  codex). Verified live: `grok mcp doctor` (5 tools healthy), `grok inspect`
  (3 hooks loaded).
- Plugin **trust**: `--always-approve` auto-trusts plugin/MCP commands — no
  separate `/plugins trust` step.
- `${GROK_PLUGIN_ROOT}` does NOT expand in `.mcp.json` on grok 0.1.x (does
  expand in hook `command` fields) → MCP server wired via absolute path in
  `~/.grok/config.toml` `[mcp_servers.telegram]`. See README "Grok 0.1.x quirks".
- grok IGNORES `config.toml [[hooks.*]]` — hooks load only from
  `~/.grok/hooks/*.json` (or plugin `hooks/hooks.json`). Documented in README.

## Won't port

These don't translate to Grok's runtime, mentioned for completeness:

- **Permission/approval bridge** (`request-permission.ts` + the server-side
  inline-button flow) — Grok launches with `--always-approve`, so there are
  no permission prompts to bridge, and Grok has no Codex-style
  `PermissionRequest` event. Dropped for v0.1.0. (A future `PreToolUse`-based
  approval bridge is possible if grok is ever run without `--always-approve`.)
- `claude/channel/permission_request` protocol — Claude-Code specific.
- `/checkpoint`, `/resume` slash commands — Claude-specific session
  persistence. Grok has its own `/load`, `--resume`, and `grok sessions`.
- `pretool-question.ts` — blocks `AskUserQuestion` / `ExitPlanMode` in
  Claude. Grok has no equivalent tools.

## Shipped

- v0.1.0 — initial fork from `telegram-codex` adapted to Grok:
  - outbound + blocking inbound (`wait_for_message`, default/max 50s to
    stay under grok's 60s `tool_timeout_sec`), `reply`/`edit_message`/
    `react`/`download_attachment`, text chunking, typing indicator.
  - access control: allowlist + per-group `requireMention`, `bun pair.ts`
    pairing CLI, configurable `access.json` knobs (`ackReaction`,
    `textChunkLimit`, `dmPolicy`).
  - bot slash commands: `/help`, `/status`, `/ping`, `/stop` (tmux C-c),
    `/restart` (`5dive agent restart`), `/agents`.
  - Grok lifecycle hooks: `silence-watchdog` (PreToolUse), `notify-stop`
    (Stop), `notification-relay` (Notification) — `GROK_*` env knobs,
    state under `~/.grok/channels/telegram/` (honors `GROK_HOME`).
  - declarative manifests: `.mcp.json`, `hooks/hooks.json`,
    `.claude-plugin/plugin.json` (Grok reads Claude plugin format).
  - permission bridge removed (see "Won't port").
