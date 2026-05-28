# telegram-grok roadmap

Parity with `plugins/telegram/` (the Claude Code build) is the goal,
forked from `plugins/telegram-codex/` because Grok shares Codex's
poll-based inbound model (no Claude-Code `channel` push protocol). Items
ordered by UX criticality unless noted.

## Up next

## Still open

- 5dive `--channels=telegram` **grok** provisioning (handed off to main):
  grok must be added to the channel-capable type list in `cmd_agent.sh`
  and the plugin staged, mirroring what codex got in 5dive-cli 0.1.8/0.1.9.
- Confirm grok plugin **trust** under `--always-approve` — plugins must be
  trusted before hooks/MCP run; verify the launch flag bypasses the trust
  gate or wire a `/plugins trust` step (main's territory).
- ExecStopPost in 5dive's systemd unit for true crash-aware notification.
- `.mcp.json` `${GROK_PLUGIN_ROOT}` expansion: verify on a live grok; the
  reliable fallback is an absolute path in `~/.grok/config.toml`
  `[mcp_servers.telegram]` (documented in README).

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
