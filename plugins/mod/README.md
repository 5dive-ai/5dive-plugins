# mod

A 5dive telemetry **producer** and a 5dive **command surface**, built on Claude Code's
function hooks (early access). Two capabilities, two independent gates, both off by
default.

It publishes the two signals 5dive currently infers from the outside — whether a seat is
mid-turn, and what its usage meter reads — from inside the harness process that owns
them, into the sink described in [`docs/mod-telemetry-contract.md`](../../docs/mod-telemetry-contract.md).

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
   { "env": { "FIVEDIVE_MOD_TELEMETRY": "1" } }
   ```

Optional, same block:

| key | default | meaning |
| --- | --- | --- |
| `FIVEDIVE_MOD_TELEMETRY_DIR` | `~/.5dive/mod-telemetry` on the seat the plugin is installed under | where the sink files land |
| `FIVEDIVE_MOD_TELEMETRY_SEAT` | derived from the plugin's own path | the seat name on each line |

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
