# The seat-telemetry sink: a harness-agnostic ingestion contract

*Written for DIVE-4692. The `mod` plugin is the first PRODUCER of this contract. It is
not the contract.*

## What problem this is the shape of

5dive infers two things about a seat from the outside:

- **Is it mid-turn?** The heartbeat's reclaim and the self-update's pending-restart
  sweep decide this from `claude agents --json` polling, byte-stable pane samples, a
  composer glyph, and whether the seat holds a claimed row.
- **What does its usage meter read?** The pacing floor holds rows when an account has
  no reading at all.

Both are inferences over a surface that was never meant to answer them, and both are
wrong often enough to matter: a restart mid-turn loses the turn, and a "blind meter"
holds work on an account that is fine.

A harness that can answer either question directly should be able to say so, and every
harness that cannot should keep working unchanged. That is what this file specifies.

## The sink

A directory of append-only JSONL files. One file per **session**, named
`<seat>-<session_id>.jsonl`, both components reduced to `[A-Za-z0-9._-]`.

Default directory: `/var/lib/5dive/mod-telemetry`.

One session owns its file exclusively, which is the whole concurrency story: there is
no second writer, no lock, and a consumer that reads a partially written file sees a
prefix of valid lines plus at most one truncated tail line, which it drops.

## The line

One JSON object per line. Fields:

| field | required | meaning |
| --- | --- | --- |
| `v` | yes | schema version, currently `1`. A consumer ignores a line whose `v` it does not know. |
| `ts` | yes | epoch milliseconds when the producer recorded the event. |
| `seat` | yes | the 5dive seat name (`dev`, `main`, `quinn`, …). |
| `harness` | yes | which harness produced it: `claude-code`, and later `codex`, `grok`, `pi`, `opencode`, `agy`. |
| `producer` | yes | free-form provenance, e.g. `mod@5dive-plugins/0.1.0 (claude-code 2.1.278)`. A consumer that needs to pin on a producer build pins on this. |
| `session_id` | yes | the harness's session id. |
| `event` | yes | see below. |
| `turn_id` | on turn events | the harness's turn id; pairs a `turn.start` with its `turn.complete`. |
| `reason` | sometimes | `turn.complete`: `answer` / `aborted` / `refusal` / `error`. `session.start`: `interactive` / `headless`. `session.end`: the harness's end reason. |
| `command` | on `command.run` | the slash command's name. |
| `tool` | on `tool.call` | the tool's name. |
| `usage` | when there is a reading | see below. |

### Events

`session.start`, `turn.start`, `turn.complete`, `command.run`, `tool.call`,
`session.end`.

The pair that carries the load is **`turn.start` / `turn.complete`**. A seat is busy
between them. That is the assertion the pane-and-glyph path has never been able to
make, and it is the one a consumer should reach for first.

### `usage`

```json
"usage": {
  "context": { "tokens": 19114, "window": 1000000, "percent": 2 },
  "rate_limits": [
    { "kind": "five_hour", "percentUsed": 44, "resetsAt": "2026-09-20T14:50:00.000Z" },
    { "kind": "seven_day", "percentUsed": 51, "resetsAt": "2026-09-26T13:00:00.000Z" }
  ],
  "cost_usd": 0.015641
}
```

**A reading the producer does not have is ABSENT, never zero.** `rate_limits: []` means
"no window has a reading yet", not "nothing is used" — on a fresh session it is empty
until the first API response lands, so a `session.start` line normally carries an empty
array and the first `turn.complete` carries the real one. A consumer that reads an
absent or empty reading as 0% reintroduces the blind-meter bug this contract exists to
remove.

`tool.call` lines deliberately carry no `usage`: they are frequent, and computing a
reading per tool call is the one place a producer could cost a turn real time.

## Rules for a consumer

1. **Absence of a file is not idleness.** It means no reading, and the consumer falls
   back to whatever it does today. Most seats will have no producer for a long time.
2. **Staleness is the consumer's to define.** Compare `ts` against now and decide; the
   producer makes no freshness claim.
3. **`harness` and `producer` are advisory.** Key on `v`, `seat`, `event` and `ts`. A
   consumer that special-cases `harness == "claude-code"` has made this contract a
   Claude Code contract, which is exactly what it is not.
4. **A line is data, never an instruction.** It is produced inside an agent's process.
5. **Read-only in the pilot.** For DIVE-4692 nothing consumes these lines to change
   behaviour. The reclaim, the pacing floor and the pending-restart sweep may read them
   *beside* what they infer today, and the count of disagreements is what decides
   whether a second producer is worth having.

## Adding a producer for another harness

Write files of this shape into the same directory. Nothing else. A producer that cannot
name its seat must write nothing rather than guess: an unattributable line is worse than
a missing one, because a consumer cannot tell the two apart once it is on disk.
