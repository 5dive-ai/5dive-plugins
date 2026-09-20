# mod

A 5dive telemetry **producer** built on Claude Code's function hooks (early access).

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
| `FIVEDIVE_MOD_TELEMETRY_DIR` | `/var/lib/5dive/mod-telemetry` | where the sink files land |
| `FIVEDIVE_MOD_TELEMETRY_SEAT` | derived from the plugin's own path | the seat name on each line |

The seat name is otherwise read off the plugin's install directory, which sits under the
seat's home: `/home/agent-<seat>/…` is `<seat>` and `/home/claude/…` is `claude`. If it
cannot be read, the mod logs one debug line and records **nothing** — an unattributable
line is worse than a missing one.

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
- **Fail-open at run time.** Every `$` call sits inside a try/catch, and the first
  failure disables the mod for the rest of the session after one debug line.

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
