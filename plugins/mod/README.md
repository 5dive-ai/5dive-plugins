# mod

Two 5dive capabilities built on Claude Code's function hooks (early access), each behind
its own flag and each off by default.

1. **A telemetry producer.** It publishes the two signals 5dive currently infers from
   the outside — whether a seat is mid-turn, and what its usage meter reads — from
   inside the harness process that owns them, into the sink described in
   [`docs/mod-telemetry-contract.md`](../../docs/mod-telemetry-contract.md).
2. **A seat panel.** One line above the prompt naming the row the seat holds, its gate,
   its grader and its token burn against its budget, at zero context cost. See
   [The seat panel](#the-seat-panel-dive-4694).

## What it does, and what it deliberately does not

Publishes, per session, one JSONL file of `session.start` / `turn.start` /
`turn.complete` / `command.run` / `tool.call` / `session.end` lines, with the account's
rate-limit windows and the session's context fill and cost attached to all but
`tool.call`.

It is **observe-only**. Every hook calls `next(e)` first and returns what the chain
resolved to. It never denies a tool call, rewrites an input, or delays a turn. The
`tool.call` deny-list guard and the usage-wall handling that the original proposal
sketched are *not* here; they are separate rows, and shipping them alongside a
measurement would make the measurement unreadable.

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

## Turning it on

Two independent gates. Both must be on, and the second is off on every seat by default.

1. **The harness's.** `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the seat's env
   (`/var/lib/5dive/agents.d/<seat>.env`). Without it Claude Code never loads any
   installed plugin's hooks module and this plugin is inert.
2. **5dive's.** In the seat's `~/.claude/settings.json`:

   ```json
   { "env": { "FIVEDIVE_MOD_TELEMETRY": "1", "FIVEDIVE_MOD_PANEL": "1" } }
   ```

   The two capabilities have **separate** flags on purpose: a seat may want the screen
   without the sink or the sink without the screen, and one flag for both would make
   "it is off" ambiguous. Each defaults to off.

Optional, same block:

| key | default | meaning |
| --- | --- | --- |
| `FIVEDIVE_MOD_TELEMETRY_DIR` | `~/.5dive/mod-telemetry` on the seat the plugin is installed under | where the sink files land |
| `FIVEDIVE_MOD_TELEMETRY_SEAT` | derived from the plugin's own path | the seat name on each line |
| `FIVEDIVE_MOD_PANEL_SEAT` | derived from the plugin's own path | whose board the panel reads |
| `FIVEDIVE_MOD_PANEL_USAGE_FILE` | `/var/lib/5dive/pace-usage.json` | the heartbeat's published usage snapshot |

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
