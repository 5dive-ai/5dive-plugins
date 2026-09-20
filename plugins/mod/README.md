# mod

Three 5dive capabilities built on Claude Code's function hooks (early access), each
behind its own flag and each off by default.

1. **A telemetry producer.** It publishes the two signals 5dive currently infers from
   the outside — whether a seat is mid-turn, and what its usage meter reads — from
   inside the harness process that owns them, into the sink described in
   [`docs/mod-telemetry-contract.md`](../../docs/mod-telemetry-contract.md).
2. **A seat panel.** One line above the prompt naming the row the seat holds, its gate,
   its grader and its token burn against its budget, at zero context cost. See
   [The seat panel](#the-seat-panel-dive-4694).
3. **A command surface.** `/task` and `/gate`, dispatched to the `5dive` CLI in the
   harness process. See [`/task` and `/gate`](#task-and-gate).

## What it does, and what it deliberately does not

Publishes, per session, one JSONL file of `session.start` / `turn.start` /
`turn.complete` / `command.run` / `tool.call` / `session.end` lines, with the account's
rate-limit windows and the session's context fill and cost attached to all but
`tool.call`.

The telemetry is **observe-only**. Every one of those hooks calls `next(e)` first and
returns what the chain resolved to: none of them denies a tool call, rewrites an input,
or delays a turn. The usage-wall handling the original proposal sketched is still *not*
here; it is a separate row.

## The tool-call guard

DIVE-4696 added the proposal's capability 2, and it is the one thing in this plugin that
can refuse a call. A table of policies in [`policy/guard.json`](policy/guard.json) —
data, not code — is matched against each `tool.call`, and a match answers
`{ deny: <the policy's reason> }` instead of running the tool. It ships with six
policies, each one a rule that until now was prose in `CLAUDE.md`, paid for on every
turn of every seat and caught only after the fact: a real identifier in a test fixture,
`--no-verify`, applying `smoke-verified`, writing the runtime's own store, `rm -r`
outside the workdir, and replying on a repository we do not own.

Gate: `FIVEDIVE_MOD_GUARD=1`, independent of the other two flags. With it off — the
default on every seat — the `tool.call` hook is byte-for-byte the observe-only hook
above. It never rewrites a call, it fails open and says so, and adding a policy means
editing the JSON, not the plugin. Full contract, the fields, and what a new policy owes:
[`docs/mod-guard.md`](../../docs/mod-guard.md).

## The seat panel (DIVE-4694)

One line directly above the prompt, on the terminal, naming the row this seat holds:

```
5dive dev · DIVE-4694 · in_progress · gate none · grader temp · burn 15.1M/150.0M* · Function-hook mod: above-prompt seat…
```

It costs the model **nothing**. A `ui.render` hook's tree is drawn by the terminal and
is never part of the prompt, so no token of this reaches the context window — which is
the whole reason it lives here and not in a `/goal` preamble or a skill.

| cell | what it says |
| --- | --- |
| `5dive <seat>` | which seat's board is being read |
| `DIVE-…` | the row the seat is on: an `in_progress` row, else one **delivered and not closed**, else one holding a live gate, else the first open row (`ls` has already ordered by priority then age) |
| `in_progress` | the row's status |
| `gate …` | `none` when no gate is LIVE (an answered one is over and reads `none`), else the board's own compact vocabulary — `HUMAN:<type>` (red) when a person owes the answer, `<seat>:<type>` (yellow) when an agent does. Composed here from `gate_live` / `needs_human` / `need_type` / `routed_reviewer`; `show --json`'s `gate` field is the verbose header the board prints for a human and is never drawn |
| `grader …` | the verifier state: `<seat> waiting` (a delivery is with it), `<seat> bound`, `delivered→temp` (the pool attaches one at delivery), `check` / `rubric`, or `none` |
| `burn …` | the row's metered tokens against its budget. `*` on the denominator means the row carries no budget of its own and the box default is shown. `~… unverified` means the figure is attributed but the dispatch cross-check could not tie it to this row (see below). `—` means no reading — **absent, never zero**. `exempt` is a row budgeted `none` |
| `acct …` | **only** when it says something the status line does not: `5h 92%!` for a window at or past 80%, `—` for a blind meter |

Fields drop from the right as the band narrows, whole rather than truncated; the row's
ident is the last thing to go. The title is the first.

### What this carries, and what the status line carries

DIVE-4665 put the model, effort, context fill, session cost **and the account's 5h/7d
percentages** on the seat's status line (`5dive-api scripts/inc/statusline.sh`), one row
below this band. So the split is by owner of the fact:

- **status line** — everything belonging to the SESSION and the ACCOUNT;
- **this panel** — everything belonging to the ROW, which the statusline payload does
  not know and cannot: ident, status, gate, grader, burn against the row's budget.

The account windows are therefore not repeated here as figures. The one exception is the
`acct` cell above, and it exists because a *missing* reading renders on a status line as
plain absence — the same pixels as the field being switched off — and a blind meter is
exactly what holds rows on the pacing floor.

### Where the burn figure comes from, and why it is sometimes marked

`5dive usage --json` is root-only and a seat is not root. The heartbeat runs it once a
tick and publishes the result at `/var/lib/5dive/pace-usage.json` (mode 0664, group
`claude`, which every seat is in); the panel reads that file. It is the **same** figure
`_hb_task_budget_sweep` parks a row on, so the panel shows the operator the number the
guard will act on rather than a second one derived differently.

That sweep charges a row only when the dispatch cross-check verified the window
(`dispatched: true`) — an attributed window with no `/goal` dispatch of that ident
inside it is likely another row's tokens (DIVE-3343 → DIVE-4430). The panel shows such a
figure, because an operator wants to see it, marked `~… unverified`.

### Refresh, and what it costs

No timer, and `$.clock` is never touched. The band's own `isWorking` prop is true
exactly while a model turn runs and the engine re-renders on its edges, so watching that
edge **is** the turn boundary, with no second hook. (A second registration of
`session.start` / `turn.complete` / `command.run` is not available anyway: the telemetry
half owns them and `claude plugin validate` refuses the duplicate.)

A refresh runs outside the draw and is never awaited by the hook that triggers it — the
panel cannot delay a turn — and is rate-limited to one per 1.5 s. Measured on this box:
`5dive task ls` ≈ 0.6 s CPU, `5dive task show` ≈ 0.5 s, and the 36 kB snapshot read is
noise. `show` is only paid when the drawn row CHANGES or holds a live gate, so steady
state is **one ~0.6 s subprocess per turn boundary, ~1.2 s of CPU per turn**, off the
critical path.

## `/task` and `/gate`

The mod also registers two slash commands that dispatch to the `5dive` CLI in the
harness process — `/task show DIVE-1`, `/gate DIVE-1 --type=decision --ask="…"`. They
are a thin surface over the CLI, not a second implementation, and the verbs they serve
are an allowlist rather than a pass-through (`task add` stays on Bash, because the
filing cap is a PreToolUse hook on the *Bash tool* and a dispatched command never
crosses it).

Gate: `FIVEDIVE_MOD_COMMANDS=1`, independent of the telemetry flag. The contract, the
allowlist and the `FIVEDIVE_MOD_CONTEXT_AUDIT` measurement instrument are in
[`docs/mod-commands.md`](../../docs/mod-commands.md).

## Turning it on

Two independent gates. Both must be on, and the second is off on every seat by default.

1. **The harness's.** `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the seat's env
   (`/var/lib/5dive/agents.d/<seat>.env`). Without it Claude Code never loads any
   installed plugin's hooks module and this plugin is inert.
2. **5dive's.** In the seat's `~/.claude/settings.json`:

   ```json
   { "env": { "FIVEDIVE_MOD_TELEMETRY": "1", "FIVEDIVE_MOD_PANEL": "1", "FIVEDIVE_MOD_COMMANDS": "1" } }
   ```

   The three capabilities have **separate** flags on purpose: a seat may want the screen
   without the sink, the sink without the screen, or the commands without either, and
   one flag for several would make "it is off" ambiguous. Each defaults to off.

Optional, same block:

| key | default | meaning |
| --- | --- | --- |
| `FIVEDIVE_MOD_TELEMETRY_DIR` | `~/.5dive/mod-telemetry` on the seat the plugin is installed under | where the sink files land |
| `FIVEDIVE_MOD_TELEMETRY_SEAT` | derived from the plugin's own path | the seat name on each line |
| `FIVEDIVE_MOD_PANEL_SEAT` | derived from the plugin's own path | whose board the panel reads |
| `FIVEDIVE_MOD_PANEL_USAGE_FILE` | `/var/lib/5dive/pace-usage.json` | the heartbeat's published usage snapshot |
| `FIVEDIVE_MOD_GUARD` | off | enforce the tool-call policies in `policy/guard.json` |
| `FIVEDIVE_MOD_GUARD_POLICY` | the plugin's own `policy/guard.json` | a different policy document |

The seat name is otherwise read off the plugin's install directory, which sits under the
seat's home: `/home/agent-<seat>/…` is `<seat>` and `/home/claude/…` is `claude`. If it
cannot be read, the mod logs one debug line and records **nothing** — an unattributable
line is worse than a missing one.

### Where the sink lands, and why it is not shared by default

`~/.5dive/mod-telemetry/<seat>-<session>.jsonl` — the runtime's per-seat state directory,
under the seat's own home, created on the first write. It is derived from the same path
the seat name is (`$.plugin.root`), so it is a directory the seat owns by construction.

It is deliberately **not** a shared directory under `/var/lib/5dive`. That tree is
`drwxr-s--- root:claude`: group has `r-x`, so no seat — not even `claude` — can create a
subdirectory in it. A shared sink is still the better end state for a consumer (one glob
instead of one per home) and it is opt-in rather than default: ops creates it
group-writable, and each seat points `FIVEDIVE_MOD_TELEMETRY_DIR` at it. Until then a
consumer globs `/home/*/.5dive/mod-telemetry/*.jsonl`.

### If it is on and you see no files

Check the debug log (`--debug-file`, or `~/.claude/logs`) for a line starting
`5dive mod`. Every reason the mod produces nothing says so there: the flag being off is
the only silent case, because that one is not a failure. See *Fail-open* below.

## Compatibility

Written and verified against **Claude Code 2.1.278**. The API is early access and may
change per release.

`plugin.json` has no field for pinning a Claude Code version range — verified against
2.1.278's own manifest schema — so the pin is in the data: every line carries
`producer`, naming the build it came from.

Two things keep a version bump from breaking a seat:

- **The engine's own static scan.** It reads the module's source at load and refuses a
  module that names an event or a `$` call this build does not have. A refused module is
  logged and skipped; the seat runs exactly as it did before.
- **Fail-open at run time.** Every `$` call sits inside a try/catch, so no failure
  reaches the chain.

## Fail-open

Fail-open is **two** claims, and they need separate evidence: the failure does not
propagate, *and* the failure is legible. A `try {} catch {}` only ever shows the first,
and an empty catch is the second claim's negation written in the same shape — an
observe-only producer that swallows its write failure is indistinguishable, from the
outside, from one that is switched off. Iteration 1 of this plugin shipped that, at its
own documented default path, and passed both of its negative controls while writing
nothing. So each catch here emits:

| what fails | what happens | what it says |
| --- | --- | --- |
| the gates / the seat name / the session id | mod OFF for the session | one `5dive mod off: …` / `5dive mod disabled: …` debug line |
| the sink **write** | mod OFF for the session, no retry | one `5dive mod disabled: could not write the telemetry sink at <path>: <error>` line |
| `$.session.usage()` | lines keep recording with **no** `usage` key | one `5dive mod: $.session.usage() failed …` line |

The usage case degrades instead of latching off on purpose: *absent, never zero* is the
contract's own answer for a reading nobody has, and the turn boundaries are the half of
the pilot that does not depend on that call. What is not acceptable is a usage-free line
stream with no tell — that is the blind meter this plugin exists to remove.

The flag being off is the one silent case, because it is not a failure.

## Working on this file

The engine scans the hooks module's SOURCE, and `$` may never be bound to a name: no
`const engine = $`, no walking it, no passing it to a closure. Every use is spelled
literally `$.noun.member(...)` at the call site, and a function that takes `$` must be
declared at the top level of the file. That is why the helpers here are top-level
declarations and not closures inside `register`.

Regenerate the type declarations after a Claude Code upgrade:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "/plugin-types"   # writes .claude/types/
claude plugin validate --strict plugins/mod
```

`claude plugin validate` checks the manifest only; the scan that matters runs when a
session loads the plugin, so a change is exercised with:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude \
  --settings <a settings.json with the flag> \
  --plugin-dir plugins/mod --debug-file /tmp/dbg.log -p "say OK"
grep 'hooks module mod' /tmp/dbg.log
```

## Boundary compaction on the non-fresh seats (DIVE-4695)

`main` and `marketing` run with `heartbeat.fresh=false`: the dispatcher does **not** send
`/clear` before a nudge, so every wake lands on the whole accumulated window and every
model step inside that turn re-sends it. Measured on this box 2026-09-20 (`sudo 5dive
cost`, last 24h), quota over API-EQ — quota counts the cache **read**, so the ratio is how
many times a seat re-read what it had already written:

| seat | quota / API-EQ | fresh |
| --- | --- | --- |
| marketing | 49.9x | no |
| main | 43.7x | no |
| dev | 33.8x | yes |
| quinn | 31.5x | yes |
| ops | 25.0x | yes |

This compacts **at a turn boundary**, so the next dispatched goal lands on a summary
instead of the full transcript — continuity in compacted form, rather than the `/clear`
that throws it away.

Off on every seat. To turn it on, in the seat's `~/.claude/settings.json` `env` block:

| key | default | meaning |
| --- | --- | --- |
| `FIVEDIVE_MOD_BOUNDARY_COMPACT` | absent (off) | `"1"` turns it on. Anything else is off. |
| `FIVEDIVE_MOD_BOUNDARY_COMPACT_PERCENT` | `50` | context fill, as a whole percent 1–99, at or above which a boundary compacts. **A malformed value turns the feature OFF**, never back to the default. |
| `FIVEDIVE_MOD_BOUNDARY_COMPACT_PIN` | see below | the pattern for what must survive a compaction. An uncompilable pattern turns the feature off. |

**Never set it on a fresh seat.** A fresh seat is `/clear`ed before each nudge and has
nothing to compact.

### Continuity is pinned, not asked for

The failure mode is a compaction that drops an unanswered human gate or a standing
directive — worse than the tokens it saved. So there are two layers, and only the second
is a guarantee:

1. Our compactions carry `instructions` telling the summarizer to keep the obligations
   verbatim and summarize the investigation instead. That is a request.
2. The mod hooks `session.compact` and, on the way **up**, checks by the engine's own
   message `handle` that every message the pin matched is still in the result. Any that is
   not is **appended back verbatim**. A paraphrase in the summary does not count as
   keeping it — the seat cannot answer a gate whose question is gone.

The default pin is
`(5dive task need|--ask=|GATE|gate cleared|lodar|Branch: |DIVE-[0-9]{3,})`, matched
case-insensitively against a message's text. At most 12 messages are pinned back (the
newest); a pin that matches more than that means the pattern is wrong, and the count is on
the `compact.pinned` line.

This is the **only** hook in the plugin that returns anything but what the chain resolved
to, and it can only ADD — `test/mod-telemetry.test.ts` asserts both, from the source.

### The boundary is `turn.complete`, and that was a measurement

The 2.1.278 declaration says `session.measure` "fires after each main-thread turn". In a
headless lab run on 2026-09-20 it fired **before** `turn.complete`, and the mod's own
turn-tracking refused it (`compact.skip reason=mid-turn percent=3`). `$.session.compact()`
rejects while a turn runs, so a trigger that trusted the event's timing would have called
it mid-turn on every boundary. The primary trigger is `turn.complete`, after the mod
clears its own `inTurn`; `session.measure` stays wired as a second trigger for the
boundaries it does raise cleanly (a rate-limit window moving while the seat sits idle).

The call itself is never awaited by either hook, and it runs on a promise chain of its
**own** (`compactChain`) rather than the one the telemetry writer uses. Both halves matter.
Not awaiting keeps a compaction from delaying a turn or failing one. The separate chain
keeps it from stalling the **sink**: a compaction was measured at ~50s (51.5s and 50.3s in
the live run), and queued behind it on the writer's chain no telemetry line reached the
file for that whole time — including the next `turn.start`. The heartbeat, the pacing
floor and the pending-restart sweep read idle/busy off that sink, so a compacting seat
would have read as a silent one. Overlap between two compactions is prevented by the
in-flight latch, not by sharing a queue with the writer.

### `$.session.compact` needs a mounted session

On 2.1.278 a `claude -p` run answers
`$.session.compact is not available in this mode: no session is bound in this process`.
The 5dive seats run an interactive session in tmux, which is mounted; a headless one is
not. The rejection is a counted `compact.skip` line and one debug line, and the seat
carries on with its full window.

### Reading the pilot

Every boundary is a line, including every refusal — a quiet sink must not be the same
observable as a working one:

| event | what it means |
| --- | --- |
| `compact.done` | it compacted; `tokens_before` / `tokens_after` are core's own counts (absent when core did not record them, never zero), `pinned` is how many messages had to be put back |
| `compact.pinned` | the compaction dropped `pinned` pinned messages and they were appended back |
| `compact.skip` | the boundary declined; `reason` is `off`, `mid-turn`, `in-flight`, `no-reading`, `vetoed: …` or `rejected: …`. `below-threshold` is deliberately NOT recorded — it is the common case and would drown the file |
