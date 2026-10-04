# telegram-codex roadmap

Parity with `plugins/telegram/` (the Claude Code build) is the goal. Items
ordered by UX criticality unless noted.

## Up next

## Still open

- `/account` switching from Telegram. 0.5.25 is read-only: switching runs
  `5dive agent set-account` (a restart, and a sudo verb on standard seats that
  needs the Claude plugin's `_self_account` gating, DIVE-5220/5367). Port that
  gating before offering buttons.
- Republish `@5dive/telegram-codex-mcp` on npm. 0.5.7 is the newest published
  version, and `.mcp.json` pins it for the Codex plugin install. Publishing
  needs the npm credential.
- 5dive's `install.sh` extracts `CODEX_PLUGIN_TARBALL` under a
  `5dive-plugins-main/` prefix, so pinning the tarball to a commit does not
  work. A fleet-wide rollback is therefore a revert on `main`. See the README
  "Upgrade, canary and rollback" section.
- 5dive's health reader does not show the handshake's new `codex` block
  (version, tested) yet.

## Won't port

These don't translate to Codex's runtime, mentioned for completeness:

- `claude/channel/permission_request` protocol — we use a hook-based
  bridge instead (shipped in v0.1.3).
- `/checkpoint`, `/resume` slash commands — Claude-specific session
  persistence. Codex has its own `codex resume` CLI.
- `pretool-question.ts` — blocks `AskUserQuestion` / `ExitPlanMode` in
  Claude. Codex has no equivalent tools.

## Shipped

- v0.5.31 — DIVE-5508: "typing…" on dispatcher seats; commentary edits the ack
  instead of arriving as a second answer; OGG replies go as voice notes.
- v0.5.30 — DIVE-5505: dispatcher-path attachments are downloaded by the
  bridge (meta + local path in the turn); voice/audio are transcribed in it.
- v0.5.29 — DIVE-5504: one silent, edited acknowledgement per Telegram turn on
  the dispatcher path and one notification (the last answer).
- v0.5.28 — DIVE-5504: `recent_messages` and the per-chat message log; a
  lost dispatcher thread's next turn carries the chat's recent transcript.
- v0.5.27 — DIVE-5504: auto-attach of named files on the dispatcher outbox and
  the MCP `reply` tool (`autoattach.ts` fork + `outbox-attach.ts`), with
  `.codex` denied and explicit directives checked too.
- v0.5.26 — DIVE-5504: Codex approval requests on the dispatcher path go to
  Telegram buttons instead of an unseen decline (`approvals.ts`); timeout and
  no-adapter stay explicit declines; the seat's approval policy is untouched.
- v0.5.25 — DIVE-5502: `/effort`, `/usage` and `/account` on the dispatcher
  path. Inbox verbs `set-effort`, `usage` and `account` run at once, even
  mid-turn: an effort change is written with `config/value/write` and applies
  from the next `turn/start`; `/usage` shows OpenAI's own windows and, apart,
  the session's token counts; `/account` shows the Codex sign-in and the 5dive
  binding. Account switching from Telegram is still a follow-up (see below).
- v0.5.24 — DIVE-5502: context controls on the dispatcher path. `/context`
  shows the session's size (from app-server token accounting), the last model
  call's input/cached/output and the call count, with Compact and Fresh session
  buttons; `/clear` starts a fresh session. Controls travel as an inbox
  `control` verb (`compact`, `new-session`) advertised in `health.json`
  `controls`, run at the turn boundary, and every model call appends one line
  to `usage.jsonl`.
- v0.5.23 — DIVE-5490: a reply whose text is emoji-only (a lone 🎙)
  with only audio files attached sends the files alone, and an empty text
  with files is a files-only send instead of a refusal.
- v0.5.22 — DIVE-5447: the pinned needs-you banner is opt-in
  (`TELEGRAM_NEEDS_BANNER=1`). Off, one boot task unpins and relabels the
  pins `needs-banner.json` remembers and empties it; gate alerts and
  `/inbox` are unchanged.
- v0.5.21 — DIVE-4924: `/model` or a `config.toml` edit plus restart now
  moves the existing conversation to the new model (history kept): the
  configured model/effort ride `thread/resume` and each `turn/start`, and
  `health.json`/`/status` report the thread's actual model.
- v0.5.20 — DIVE-3969: compatibility and rollback hardening. The dispatcher
  refuses Codex below 0.136.0 by name (measured: older app-servers reject
  `--stdio`), records the Codex version in `health.json`, versions
  `state.json` (idempotent migration; a newer or corrupt file is quarantined,
  not misread), adds `bun dispatcher.ts --check` and `release.sh`
  (check/promote/rollback). CI checks the package `files` closure, the
  manifest versions, and the commands the docs name.
- 5dive `--channels=telegram` codex provisioning (DIVE-3960/3961): codex
  seats are provisioned with the dispatcher and Telegram/dashboard adapters.
- v0.5.13 — DIVE-3965: a restart no longer loses the thread silently. A clean
  stop and a crash are different sentences in the chat, a stale thread says so,
  and the recovery context rides the NEXT turn instead of replaying the
  interrupted one. The crash-aware half now exists too: 5dive's unit gained an
  `ExecStopPost` notifier (`5dive-agent-stop-notify`), so an OOM, a SIGKILL or a
  permanent start failure is reported once, with its cause, by the only observer
  that outlives the unit.
- v0.1.0 — outbound + blocking inbound, preconfigured allowlist
- v0.1.1 — `Stop` hook for turn-complete pings
- v0.1.2 — `bun pair.ts` pairing CLI
- v0.1.3 — `PermissionRequest` → Telegram approval bridge with inline buttons
- v0.1.4 — bot slash commands (`/help`, `/status`, `/ping`) + setMyCommands;
  `wait_for_message` capped at 90s (Codex's MCP tool-call timeout)
- v0.1.5 — `reply` chunks text >4000 chars across multiple messages
- v0.1.6 — Stop hook suppresses ping when `reply` was sent in the last 30s
  (override via `CODEX_NOTIFY_SUPPRESS_MS`)
- v0.1.7 — typing indicator (`startTypingLoop`/`stopTypingLoop`) between
  `wait_for_message` dequeue and `reply`; 5min ceiling
- v0.1.8 — silence watchdog `PreToolUse` hook (`CODEX_SILENCE_WATCHDOG_MS`,
  default 120000); single ping per silence window
- v0.1.9 — `Notification` hook relays error-flavored notifications to
  Telegram (`CODEX_NOTIFY_RELAY_ALL=1` to relay everything; pattern match
  on error/failed/timeout/rate-limit etc. by default). True crash-aware
  notification still pending — needs ExecStopPost in 5dive's unit (main's
  territory).
- v0.1.10 — `/stop` (tmux C-c) + `/restart` (`5dive agent restart`) bot
  commands.
- v0.1.11 — `/agents` bot command (wraps `5dive agent list --json`,
  marks self).
- v0.2.0 — configurable `access.json` knobs: `ackReaction`,
  `textChunkLimit`, `dmPolicy`.
- v0.2.1 — `notify-user` SKILL.md ported from the Claude build,
  adapted for Codex's `wait_for_message`/`reply` loop semantics.
- v0.2.24 — DIVE-13: `/restart` (and `/model`) ack/advance the getUpdates
  offset past the triggering update before tearing down the poller, so
  Telegram can't redeliver it into a self-restart loop. (Same fix in
  telegram-grok v0.1.23 + telegram-agy v0.1.12.)
