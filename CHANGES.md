## v0.5.28

### Changed — /inbox renders inline tap-to-clear buttons where the banner points (DIVE-1572)

The DIVE-1568 needs-you banner tells the founder to "tap /inbox to review and clear it," but /inbox
only shelled the DIVE-1499 send-verb to DM a *separate* tap-button digest — the buttons weren't where
the banner pointed. Now /inbox renders an actionable reply IN PLACE: each pending tier<2 gate that has
a recommendation gets a one-tap `✅ <ident>: <rec>` button that applies the rec via the DIVE-1305
`clear-recs --channel-proof` rail (the allowFrom-vetted sender id is the human proof — re-enforced
CLI-side, tier<2 only; no DIVE-916 nonce needed). Tapping clears the gate in place and rebuilds the
list so the button drops. tier-2 hard gates (money/secret/destructive/brand) can't be button-minted
in-plugin (the nonce isn't derivable — the DIVE-950 hole), so those still fire the `--send` nonce
digest, noted inline. Sourced from `task ls --json` (which exposes `tier` + `recommend`, unlike the
`task inbox --json` view). Ported across canonical `telegram` + `telegram-{grok,agy,codex,pi}`.

## v0.5.27

### Changed — scope the needs-you banner to the org coordinator (DIVE-1568)

The DIVE-1503/1558 pinned "needs-you" banner reconciled + pinned in EVERY paired agent's DM (base
plus every fork), so the founder got the SAME open-gate reminder pinned across N DMs. The banner now
pins on exactly ONE agent: the resolved org coordinator. Each `server.ts` `reconcileNeedsBanner`
first resolves the coordinator via the new read-only `5dive task coordinator --json` verb (DIVE-333
`_task_resolve_coordinator`: the sole `role='coordinator'`, else the lone org root, else empty).
Unless the resolved coordinator equals this agent, it never pins and unpins any banner it left
behind; an empty/ambiguous org resolves to nobody (fail-quiet, no bare-box spam); a lookup error
skips the tick so a live pin never flickers. `banner.ts` is untouched (stays byte-identical across
all forks). New `test/banner.test.ts` tripwire asserts the gate is present in base + all 5 forks so
a fork can never silently drop it. Applies to base `telegram` + grok/codex/agy/pi/opencode
(agy regenerated from the grok base). Generalizes to customer boxes: each box's org defines its
coordinator. Requires 5dive CLI >= 0.11.35 (the `task coordinator` verb).

## v0.5.26

### Added — needs-you banner fork parity + relay-mode decision (DIVE-1558)

Propagated the DIVE-1503 pinned "needs-you" banner from canonical `telegram` to every poll-based
fork: `telegram-grok` (the generator BASE, hand-edited), `telegram-agy` (regenerated), and
`telegram-codex` / `telegram-pi` / `telegram-opencode` (hand-edited). Each imports
`plugins/telegram/banner.ts` byte-identical (the `test/banner.test.ts` fork-parity tripwire now arms
across all five) and runs the same 60s reconcile in `server.ts`, adapted to each fork's helpers
(`read5diveInfo` host-gate, `run5dive` inbox read, grammy `bot.api` pin/edit/unpin). The generator
now copies `banner.ts` verbatim (added to `COPY_FILES`, exempt from token subs like `tna.ts`) so
codex/agy can never drift; `banner.ts`'s self-reference comment was reworded off the literal
`telegram-grok` token so the generator's stray-token lint stays clean.

Relay mode (SEND_ONLY): decided (with Marcus) to keep the banner OFF under one shared team-bot — a
proactive per-agent timer would pin N banners into the one owner DM (DIVE-249), and relay users
already have the on-demand `/inbox` digest. So the fork banner is gated `!SEND_ONLY` exactly like v1
(pi is polling-only in its lineage, so it arms unconditionally). A listener-aggregated single
consolidated pin is tracked as a follow-up only if relay users report missed gates.

Versions: telegram 0.5.26, grok/codex/agy 0.5.13, pi 0.1.4, opencode 0.5.6.

## v0.5.25

### Added — pinned self-updating "needs-you" banner: a pending gate can never scroll out of sight (DIVE-1503)

The bot now keeps ONE pinned message per paired DM that always reflects the current human-gate
backlog: it pins the banner when the first gate opens, edits it in place as gates open and clear
(`N gate(s) need you, oldest <age> old. Tap /inbox to review and clear them.`), and unpins it at
zero (editing the old message to "All caught up"). A pinned message survives scroll, so a gate can
no longer fall off the bottom of the chat unseen — the 3rd recurrence of that class after DIVE-1428
/ DIVE-1489.

A slow reconcile (60s) reads `5dive task inbox --json`, mirrors buildInboxList's pending filter,
and drives a pure state machine in `plugins/telegram/banner.ts` (`summarizeNeeds` / `reconcileBanner`
/ `formatNeedsBanner`). It is 5dive-only and armed in personal-bot/polled mode (the SEND_ONLY
shared-team-bot banner, with its per-agent dedup, rides with the fork follow-up). Edits
fire only when the backlog size, the oldest gate, or its coarse age label changes — no per-tick edit
storm (the DIVE-1107 lesson) — and a read error never unpins a live backlog. Per-DM `{messageId,
fingerprint}` is persisted in `needs-banner.json`; a user-deleted pin is detected and re-sent next tick.

banner.ts is pure + import-safe (server.ts long-polls on import), unit-tested end-to-end in
`test/banner.test.ts` with a present-only fork-parity tripwire. Canonical `telegram` only this pass;
fork propagation (grok base → generator regen codex/agy → hand-edit pi/opencode) is the split
follow-up.

## v0.5.24

### Added — founder-veto TAP handler: authenticated one-tap veto from the founder's DM (DIVE-1494 #2, plugin half)

The callback router now handles a `veto:<receiptPrefix>:<nonce>` tap — the authenticated
founder-veto button that pairs with the council-source rail B (`_council_veto_ping` →
`_tg_veto_offer`, 5dive-cli). The one-time nonce rides ONLY in the tapped `callback_data`
(the council source never prints it to chat) and the button is delivered founder-chat-only;
tapping shells `sudo 5dive council veto exercise --receipt=<prefix> --nonce=<nonce>`. The
NONCE is the authentication (the CLI refuses an unauthenticated exercise, and only the
founder ever received it); defense in depth adds the router's `allowFrom` gate plus a
private-chat requirement (a veto button must never live in a group). The nonce is never
echoed back — on success the message is edited to a nonce-free confirmation and the keyboard
stripped so a one-time nonce can't be re-tapped. Fully fail-soft (a closed window / already-
resolved / bad nonce acks softly).

Telegram caps `callback_data` at 64 bytes; a full base64url sealed digest (43) + nonce (32)
is 81, so the button carries a unique receipt PREFIX (the CLI resolves it, fail-closed on
miss/ambiguity). Pure parse logic in `plugins/telegram/council.ts` (`parseVetoTap` / `VETO_RE`),
unit-tested in `test/council.test.ts` (rejects malformed/truncated/non-hex payloads, confirms
the read-only `cl:*` verbs are never mistaken for a veto, asserts the prefix form fits 64 bytes).
Baseline-first (claude plugin); the forks track it in a follow-up parity port.

## v0.5.23

### Added — /council: read-only Council view over the sealed governance record (DIVE-1494 #3)

`/council` renders the Council roster (seats + chair, the pass threshold + quorum,
the founder-veto holder, and the sealed lineage head) and carries three tappable
buttons for the tamper-evident record: 📜 Log (recent sealed verdicts), 🔗 Lineage
(the hash-chain summary), and ✅ Verify (the integrity check, green or fail-closed
with the failing leg named). Sourced read-only via `sudo 5dive council
{roster,log,lineage ls,verify} --json`. Everything here is READ-ONLY: the buttons
carry a static verb in `callback_data` with no nonce and no mutation. The
authenticated founder-veto TAP (which must carry a one-time nonce inside the
callback) is a separate path, DIVE-1546.

Pure formatting lives in `plugins/telegram/council.ts`, unit-tested headless in
`test/council.test.ts` (12 cases, incl. a read-only-safety assertion that no
button `callback_data` can carry a long-hex nonce, and that the resolved veto
recipient id never renders). Baseline-first (claude plugin), like `/digest`; the
wait_for_message forks track it in a follow-up parity port.

## v0.5.19

### Added — /inbox lists pending human gates, with one-reply quick-clear (DIVE-1334 / DIVE-1356)

`/inbox` renders one compact card per PENDING human gate from `5dive task inbox`
so the paired human never misses one: ident, type, the ⭐ recommendation, options,
an ask snippet, and a tappable `/task_<id>` deep link. Empty inbox reads
`No pending gates 🎉`. Sourced read-only via `sudo 5dive task inbox --json`,
`paired-5dive`-scoped so it hides and no-ops on non-5dive hosts.

Ships together with the DIVE-1305 channel-proof bulk-clear handler (now unblocked:
clear-recs is live in CLI 0.9.23): replying "go with recs" / "approve all" in the
paired DM applies each tier<2 gate's `--recommend`, and "approve DIVE-N" clears one.
The paired-DM sender IS the human proof (re-verified against access.json via
`--channel-proof`). Tier-2 hard gates (money/secret/destructive/brand) keep their
per-gate Approve/Deny button tap.

## v0.5.18

### Fixed — auto-resume prompt gates its "reply to the latest message" clause on a real unanswered inbound (DIVE-1332)

The three Telegram resume paths (usage-limit reset, transient API error, account
rotation) all typed the hardcoded string "continue and reply to the latest
message" into claude on recovery, even when the interrupted turn was autonomous
work with NO pending DM. With no message to answer, the model escalated hunting
for a referent — the phantom-prompt bug diagnosed in DIVE-1316, which hit
community and olivia on 2026-07-16 (driven by the blind-resume retry loop,
independent of heartbeat interval).

- New shared `resumePrompt()` helper (`hooks/lib/resume-prompt.ts`) reads the
  silence state the plugin already tracks: it returns "continue and reply to the
  latest message" only when `lastInboundAt > lastReplyAt` (a genuine unanswered
  message), else a bare "continue".
- Applied at all three sites: `resume-after-reset.ts`, `resume-after-error.ts`,
  and `stopfailure-notify.ts` (the `resume-next` marker line 2).
- Covered by `test/resume-prompt.test.ts` (empty inbox, already-replied, equal
  stamps, and genuine-unanswered cases). Claude-Code-only hooks — forks
  unaffected; generator parity stays green.

### Fixed — telegram taps record human provenance on every gate type, not just hard gates (DIVE-1115)

A Telegram button tap on a `decision` (and `manual`) gate recorded a bare AGENT
name in `need_answered_by` instead of `human:<actor>`. The tap handler only
appended `--human` when the gate was `approval`/`secret`/`manual`, so decision
taps fell through with no provenance mark. Two consequences: (1) the digest's
zero-human KPI counts only `human:*` provenance, so real human taps (e.g. lodar
answering a tier-2 gate) were INVISIBLE — undercounting human touches and
overstating autonomy on the public badge; (2) tier-2 answers were unprovable as
human.

- Every verified-human tap now marks `--human`. `allowFrom` has already vetted
  the tapper as an allow-listed human upstream, so the gate type is irrelevant to
  provenance. `--human-proof` (the per-gate nonce) still rides along only for
  hard gates that mint one.
- Extracted the decision into a pure `tapEvidenceArgs()` in `tna.ts` (shared,
  byte-identical across base + grok/codex/agy) and covered it in the tna harness.
- Caught a latent drift: `telegram-agy` still gated `--human` on
  approval/secret/manual and would have kept recording bare-agent decision taps.

Historical `need_answered_by` rows are left intact (audit trail). Affected idents
observed pre-fix: OSS-16 (task 1152), DIVE-1099.

## v0.5.16

### Fixed — resume-helper spawn storm: gate the spawn (not just the DM) per episode (DIVE-1107)

agent-marketing spammed ~100 "Usage limit reset — agent resumed." banners into
its topic in ~20 min. One claude process, NO systemd respawn: a BYO/OpenRouter
profile whose limit isn't tagged `error==='rate_limit'` made the resume helper's
`resumedSince()` false-positive, so it declared a resume, fired the Phase-4
banner, released the resume.lock, and exited. claude was still limited, re-stopped
immediately, and the re-fired StopFailure hook re-acquired the FREED lock and
spawned another helper -> another banner. The resume.lock only serializes
CONCURRENT helpers; it never stopped this rapid SEQUENTIAL re-trigger. The
per-episode `claimNotify` dedup already capped the DM to one, but the helper
SPAWN was ungated.

- Gate the helper spawn on the same `shouldSend` per-episode stamp as the DM
  (30-min sliding window, exit- and concurrency-independent). One episode now
  yields one recovery chain + one banner. When suppressed, the lock we acquired
  is released so it can't block the next genuine episode. Anthropic-limit agents
  are unaffected — they get a real reset epoch and wait parked on the menu, so
  the spawn gate is never exercised; only no-epoch BYO false-resume loops were
  storming. Tradeoff: a second genuine limit within the window is not
  auto-resumed and stays parked until the window clears.
- Prune `resume-*.log` on spawn (`pruneOldResumeLogs`, 3-day retention). The dir
  was never pruned and had grown unbounded fleet-wide (community 10k+, main 7k+).
- Base plugin only; forks share this hook path via generator parity. Regression
  coverage in `hooks/lib/notify-dedup.test.ts` (rapid re-trigger -> 1 send;
  new-episode-after-window -> re-send; log prune keeps recent).

# Changes from upstream

Tracks the diff between `plugins/telegram/` and upstream
`anthropics/claude-plugins-official/external_plugins/telegram/`.

## v0.5.15

### Changed — /tasks pins the calling agent's own tasks on top

`/tasks` now renders three sections top-to-bottom: **⭐ Your tasks** (the calling
agent's own unblocked, non-gated rows), then **🔔 Needs you** (human-gated), then
the open list. Previously an agent's own queued/active tasks were scattered
mid-list and easy to lose (e.g. main's two queued tasks). `buildTaskList`
partitions into three disjoint buckets keyed off `taskAssignedToMe` +
`status !== 'blocked'`; blocked-mine rows stay in the open list.

## v0.5.11

### Fixed — transient-API-error DM storm: dedup every StopFailure kind, not just usage limits (DIVE-902)
_(commit 0198c81's message mislabels this DIVE-901; the tracking task is DIVE-902.)_

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
