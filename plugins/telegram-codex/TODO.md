# telegram-codex roadmap

Parity with `plugins/telegram/` (the Claude Code build) is the goal. Items
ordered by UX criticality unless noted.

## In flight

- **v0.1.7 — typing indicator.** Keep "typing…" visible during long Codex
  turns by re-sending `sendChatAction` every ~4s. Start when an inbound is
  dequeued (Codex is now working on it); stop when `reply` lands. Mirrors
  `startTypingLoop` / `stopTypingLoop` in `plugins/telegram/server.ts`.
  Without this, a thinking Codex looks identical to a hung one.

## Up next

- **v0.1.8 — silence watchdog hook.** Ping the user if Codex has been
  silent for N seconds mid-turn without a `reply`. Currently the `Stop`
  hook only fires at end-of-turn, so a stuck Codex is undetectable.
  Mirror of `plugins/telegram/hooks/silence-watchdog.ts`.

- **v0.1.9 — stop-failure notification.** Send a Telegram alert when the
  Codex session exits unexpectedly (non-zero, crash). Mirror of
  `plugins/telegram/hooks/stopfailure-notify.ts`. Needs a separate
  trigger (Codex `SubagentStop` hook or systemd ExecStopPost — TBD).

- **v0.1.10 — `/restart` and `/stop` bot commands.** Let the user
  interrupt a stuck Codex from Telegram. `/stop` sends C-c via tmux to
  the running Codex pane; `/restart` SIGTERMs the systemd unit (relies
  on respawn). Both gate on allowFrom.

- **v0.1.11 — `/agents` bot command.** List sibling agents on the host
  via `5dive agent list --json`. Useful since multi-agent is the 5dive
  story.

## v0.2 — configurable knobs

- `access.json` fields the Claude build supports but we ignore today:
  `ackReaction` (emoji on every inbound, user opts in), `textChunkLimit`
  (currently hardcoded 4000), `dmPolicy` ("static" mode = no pairing
  attempt for new users).
- `notify-user` skill content (just a docs port of the comms playbook).

## Won't port

These don't translate to Codex's runtime, mentioned for completeness:

- `claude/channel/permission_request` protocol — we use a hook-based
  bridge instead (shipped in v0.1.3).
- `/checkpoint`, `/resume` slash commands — Claude-specific session
  persistence. Codex has its own `codex resume` CLI.
- `pretool-question.ts` — blocks `AskUserQuestion` / `ExitPlanMode` in
  Claude. Codex has no equivalent tools.

## Shipped

- v0.1.0 — outbound + blocking inbound, preconfigured allowlist
- v0.1.1 — `Stop` hook for turn-complete pings
- v0.1.2 — `bun pair.ts` pairing CLI
- v0.1.3 — `PermissionRequest` → Telegram approval bridge with inline buttons
- v0.1.4 — bot slash commands (`/help`, `/status`, `/ping`) + setMyCommands;
  `wait_for_message` capped at 90s (Codex's MCP tool-call timeout)
- v0.1.5 — `reply` chunks text >4000 chars across multiple messages
- v0.1.6 — Stop hook suppresses ping when `reply` was sent in the last 30s
  (override via `CODEX_NOTIFY_SUPPRESS_MS`)
