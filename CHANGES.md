# Changes from upstream

Tracks the diff between `plugins/telegram/` and upstream
`anthropics/claude-plugins-official/external_plugins/telegram/`.

## v0.5.11

### Fixed — transient-API-error DM storm: dedup every StopFailure kind, not just usage limits (DIVE-901)
A sustained transient API error (Overloaded / "temporarily limiting requests")
under the systemd respawn loop fired ~550 identical "Transient API throttle …"
DMs at one user in a ~4-minute window. Two independent respawn-storm vectors:

1. **Opening DM sent unconditionally.** The DIVE-122 respawn-surviving notify
   stamp gated ONLY the usage-limit path; the transient-error and generic-stop
   paths re-DMed on every respawn. Now every DM path claims a helper-independent
   stamp keyed by episode KIND (`ratelimit` | `transient` | `stop`), so any one
   kind's storm collapses to one DM per cooldown window while a genuinely
   different kind still notifies.
2. **Non-exclusive stale-lock reclaim.** `tryAcquireResumeLock`'s stale-reclaim
   used a plain `'w'` open, so a thundering herd of queued StopFailures all
   passed the staleness check and all re-created the lock → all spawned a resume
   helper (observed: 520 helpers, each firing an end-ping). Reclaim is now
   unlink-then-`O_EXCL`, single-winner.

Base plugin only — the grok/codex/agy forks use the `notify-stop.ts` path and
carry no `stopfailure-notify.ts`/resume-helper code, so no fork port. Regression
coverage added in `test/stopfailure-hook.smoke.test.ts` (transient storm → 1
SEND; distinct kinds each SEND).

## v0.5.2

### Added — Escalate button on the `/task_<id>` detail view (DIVE-449)
The single-task detail (`/task_<id>`) now carries an inline 🔺 Escalate button
for open tasks. A tap runs `5dive task escalate` (semantics A, Mark's call):
flag for attention — bump priority a tier (cap urgent) + ping the owning agent
and the paired human. Mirrors the `tna:` tap-to-answer flow: re-gated sender,
fail-soft, the button drops after one tap (re-open `/task_<id>` to go high →
urgent). Ported across base + all forks (grok/codex/agy via generator parity,
opencode hand-fork SSE arch). Lockstep version bump 0.5.1 → 0.5.2.

## v0.4.79

### Added — Claude Fable 5 in the /model picker (DIVE-212)
`fable` (→ `claude-fable-5`) is now a selectable tier in `/model`, alongside
opus and sonnet. Opt-in only — no agent's configured model changes. The picker
keyboard, callback router, and write path are all generic over `MODEL_ALIASES`,
so the one-line alias addition lights up the button automatically.

## v0.4.78

### Added — per-topic gating for team groups (DIVE-159)
`GroupPolicy.message_thread_id`: when a group access entry is bound to a forum
topic, the agent only responds IN that topic and drops messages from other
topics / the General channel. Lets one agent's bot live in a multi-agent team
group (topic per agent) and speak only in its own lane, replying without an
@mention.

## v0.4.75

### Changed — carryover nudge: "Clear now" + "Remember & clear" (DIVE-180)

- The context carry-over nudge now offers three full-width buttons instead of the
  vague "Carry over / Not yet": **Clear now** (`/clear` immediately, no save — lose
  this session's context), **Remember & clear** (save a structured carryover, then
  `/clear`), and **Not yet** (dismiss).
- "Remember & clear" chains the reset safely: after dispatching
  `/telegram:carryover`, the server waits for the carryover file to actually land
  in memory (`newestCarryoverMtime`), then for the turn to settle (pane stable),
  and only THEN sends `/clear`. The fresh session auto-reloads the carryover from
  memory, so continuity holds without a heavier full restart (Mark's call: light
  `/clear` over restart). Bounded + best-effort: if the save never lands we leave
  the context alone.

## v0.4.74

### Changed — /task hidden from menu + /agents status dots

- `/task` is now `hidden: true` in the command registry — removed from the
  BotFather featured menu (the bare verb read confusingly next to `/tasks`). The
  command still works fully: `/task add <title>` creates as before; only the menu
  entry is gone. Parity golden baseline menu updated to match.
- `/agents` now shows each agent's status as a round color dot instead of the
  word — 🟢 active / ⚪ otherwise — for a faster scan.

## v0.4.73

### Added — ToS warning on the auto-rotate menu

- The `/account` rotation submenu body now appends an experimental / use-at-
  your-own-risk warning: rotating between Anthropic accounts on a usage limit
  may conflict with Anthropic's usage terms, and the user is responsible for
  complying with their account provider's terms. Mirrors the same copy added to
  the dashboard Auto-rotate toggle (app repo). Shifts compliance responsibility
  to the operator for an OSS CLI feature.

## v0.4.72

### Fixed — access.json read errors no longer wipe the allowlist (DIVE-159)

- `readAccessFile` treated EVERY non-ENOENT error as corrupt JSON: it renamed
  the file aside (`.corrupt-<ts>`) and fell back to EMPTY access, which silently
  denies every chat ("not allowlisted"). A filesystem READ error (EACCES from a
  root-owned edit, a mid-write rename race, a transient IO hiccup) is NOT
  corruption — the allowlist is valid, just momentarily unreadable.
- Now: ENOENT → fresh default (unchanged); an fs read error (has an errno code)
  → preserve the file and THROW a clear "cannot read access.json (CODE) — check
  ownership/permissions" instead of empty-denying; only a genuine JSON parse
  error (no errno) moves the file aside. Prevents data loss + the misleading
  "not allowlisted" on a permissions glitch.
- Surfaced by the team-bot dogfood: a `sudo` root edit of an agent's access.json
  made it unreadable to the agent user → wiped allowlist → dead sends. Fix the
  edit path (use `5dive agent telegram-access set`) AND harden the reader.

## v0.4.71

### Added — team-bot send-only mode + relay-in inbound (DIVE-159)

- Opt-in team-bot membership: with `TELEGRAM_SEND_ONLY=1` the plugin sends via a
  shared team-bot token (its own topic via `message_thread_id`) but NEVER polls
  getUpdates — the single team-bot listener is the sole consumer of that token, so
  N agents can share one bot without fighting over Telegram's one-getUpdates-per-
  token slot (a second poller = 409 = dead channel).
- Structural no-poll guard: in send-only mode `bot.start()` is never invoked, and
  the PID-slot takeover + `checkApprovals` are skipped (listener-only concerns).
- Inbound arrives as atomic JSON file-drops in `<state>/relay-in/` (dir-poll,
  oldest-first, id-dedup, ack-by-delete), emitted to the agent as the standard
  `<channel … message_thread_id=…>` notification — reusing the existing deliver
  path. Replies go back into the agent's own topic via the team token.
- Fully opt-in: with `TELEGRAM_SEND_ONLY` unset, behavior is byte-for-byte the old
  per-agent bot — provisioning never requires a team token.

## v0.4.70

### Added — bot-to-bot loop + rate guards (DIVE-162)

- Mandatory backend safety layer before any cross-box auto-reply ships. Bot API
  10.0 lets bots see and reply to each other; two auto-replying bots in one group
  would otherwise ping-pong forever, and a chatty mesh blows Telegram's
  ~20-msg/min/group cap.
- `gate()` now branches on `from.is_bot` **before** the normal allowlist/pairing
  path, so a bot sender can never trigger a pairing code or a DM auto-reply.
- New `botToBot` access config (`enabled`, `allowFrom`, `maxPerMin`,
  `dedupeWindowMs`). **Default-deny**: with no config, every bot-sender message is
  dropped. When enabled, a bot must still be allowlisted for its chat, and passes
  only within dedupe (identical chat+sender+text inside the window = loop echo)
  and a per-group rolling-minute rate cap (default 12/min, the circuit breaker).
- Guard logic lives in a pure, dependency-free `botguard.ts` so it's unit-tested
  without booting the long-polling server (`test/botguard.test.ts`, incl.
  ping-pong simulations). Forks (codex/grok/agy) can adopt it when cross-box
  auto-reply lands there.

## v0.4.67

### Added — reply to a button-less gate alert to answer it (DIVE-145)

- A `🙋 [DIVE-N] needs you` alert for a **manual** gate carries no tap buttons
  (only decision/approval do), so answering used to mean a dashboard trip. Now
  replying to the alert in Telegram with the answer text clears the gate: the
  inbound handler detects a reply whose replied-to message is one of our own
  gate alerts, extracts `DIVE-N`, and runs `5dive task answer DIVE-N --value=<reply>`,
  then the CLI pings the owning agent to resume (same path as the `tna:` buttons).
- **Carve-out:** `secret` gates are **never** answerable over chat — the raw
  value would persist in Telegram history and we deliberately never store
  secrets in the task db. A reply to a secret gate gets redirected to the
  out-of-band `5dive task answer DIVE-N` (no `--value`) flow instead.
- Source of truth is the **live** gate (re-read via `task show`), never the
  alert text, so a dashboard/CLI answer landing between alert and reply can't
  double-answer. decision/approval replies are nudged toward their buttons.
  Fully fail-soft: any miss replies a one-line nudge and never leaks the reply
  into the agent's chat stream.

## v0.4.66

### Fixed — /account "Failed to list accounts" when the CLI exits nonzero (DIVE-125)

- The `/account` menu read `5dive account list --json` (and agent-list /
  usage / rotation) via raw `execFileP`, which **rejects on any nonzero exit
  and discards stdout**. On some boxes a stray stderr warning flips the CLI's
  exit code even though it wrote a valid `{ok,data}` envelope to stdout — so the
  plugin threw the good data away and surfaced "Failed to list accounts. Try:
  sudo 5dive account list", despite the CLI working. The four readers now go
  through a shared `read5diveJson()` helper that **parses stdout regardless of
  exit code** (the envelope's `ok` flag is the real success signal), giving up
  only when there's no valid JSON — matching the tolerant `run5dive()` the
  codex/grok/agy variants already use.

## v0.4.40

### Added — auto-resume on transient API errors

- **`hooks/resume-after-error.ts`** — new detached recovery helper for
  transient API failures (Overloaded / 5xx). When claude exhausts its built-in
  retries on an overloaded response it aborts the turn and drops to an idle
  prompt; the `while true; claude; done` agent loop only restarts on process
  *exit*, so the still-running-but-idle session used to sit there until a human
  nudged it. `stopfailure-notify.ts` now detects these (distinct from a usage
  limit) and forks this helper to type `continue` with growing backoff
  (`20/45/90/150s`, 4 tries), verifying via the transcript that claude actually
  picked back up. Shares the per-agent resume lock with the rate-limit flow so
  only one helper drives the pane at a time.

### Fixed — StopFailure notify fanned out to all chats on autonomous turns

- On a turn with no Telegram inbound (cron / long-running background agent),
  the StopFailure notifier fell back to *every* allowed chat — both paired DMs
  and the supergroup's General channel — instead of the agent's bound forum
  topic. Added `getGroupTopics()` (access.ts) and switched the autonomous-turn
  fallback to route into the configured group topic(s) (`message_thread_id`),
  so an agent's failure alert lands in its own thread. Falls back to all chats
  only when no group is configured.

## v0.1.1

### Added — bot slash commands

- **`/help`** — full command listing (replaces upstream's two-line version).
- **`/status`** — pairing line **plus** session health for paired senders:
  uptime, model, last activity, cwd, claude version (read from
  `~/.claude/sessions/<pid>.json`), plugin version, and the host's
  `5dive` CLI version when the binary is on PATH. Pairing-only output
  preserved for un-paired senders.
- **`/stop`** — interrupt the agent's current task. Sends `C-c` to the tmux
  pane the running claude session lives in.
- **`/restart`** — `SIGTERM` claude; systemd's respawn loop brings it back
  within ~2s. Useful when claude is stuck.
- **`/agents`** — list sibling agents on the same host via
  `sudo -n 5dive agent list --json`. Marks "← you" against the agent owning
  the bot. Requires the agent user to have passwordless sudo for 5dive (the
  default on 5dive-managed hosts).
- **`/tasks`**, **`/task add <title>`**, **`/org`** — drive the host-shared
  task queue + agent org chart via `sudo -n 5dive task|org … --json`.
  `paired-5dive`-scoped (hidden + no-op on upstream-only hosts). Task titles
  are passed after `--` and `created_by` is the sender's Telegram @handle.
- **Forum-topic capture on inbound + reply** — inbound `<channel>` meta now
  carries `message_thread_id` when a message comes from a non-General topic
  in a supergroup (e.g. a "#5dive" thread). The `reply` tool accepts a
  matching `message_thread_id` arg that's passed through to Telegram's
  sendMessage/sendPhoto/sendDocument, so replies land in the same topic
  instead of falling back to the supergroup's General channel.
- All slash commands are registered via `setMyCommands` so Telegram surfaces
  them in the autocomplete menu.

### Added — v0.1.0 carried over

- Bundled lifecycle hooks (`hooks/pretool-question.sh`, `hooks/stop-reply-check.sh`)
  declared via `hooks/hooks.json` — eliminates the need for `5dive-cli` to
  patch hooks into `settings.json` externally.

### Deferred

- `stop-failure-telegram.sh` — coupled to `/usr/local/lib/5dive/resume-after-reset.sh`.
- Multi-agent routing (1 bot ↔ N agents).
- CLI-agnostic plugin variants (codex / opencode / etc.).
- `/route`, `/spawn`, `/quiet`, `/verbose`, `/usage` — slash command shortlist
  for v2.

### Notes

The "channels" feature (the system-reminder injection on inbound messages)
is gated by claude's internal channel allowlist. For our fork to work as a
channel surface, the host needs `/etc/claude-code/managed-settings.json`
with an `allowedChannelPlugins` entry for `telegram@5dive-plugins`. Without
it the plugin still loads as a regular MCP server (tools callable, but no
auto-injection of inbound messages). 5dive-managed hosts get this
allowlist via the 5dive-cli installer; standalone OSS users currently need
to write the managed-settings file themselves.
