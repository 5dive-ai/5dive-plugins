# `/task` and `/gate` — the 5dive command surface (DIVE-4693)

The `mod` plugin registers two slash commands with `$.command.register` and serves them
with `command.run` hooks that dispatch to the `5dive` CLI in the harness process.

They are **off by default**. See *Turning it on* below.

## What they are

| command | dispatches to | serves |
| --- | --- | --- |
| `/task <verb> …` | `5dive task <verb> …` | `show`, `ls`, `done`, `deliver`, `reject`, `assign`, `set-body` |
| `/gate <ident> …` | `5dive task need <ident> …` | the whole gate surface, flags untouched |

```
/task show DIVE-4693
/task done DIVE-4693 --result="The commands landed and the saving was measured."
/gate DIVE-4693 --type=decision --ask="Ship it or hold it?" --recommend="Ship it"
```

## The CLI is the single source of truth

The commands build an argv and run the same binary a seat runs from Bash. They parse no
flags, default no values, and re-implement no guard. `done` refuses a blank result, a
gate's ask is checked for readability, a verb refuses an unknown ident — all of it
because it is the same process doing the refusing, not because the plugin agrees.

Two consequences worth stating, because both were decisions:

- **`/gate` pre-checks nothing.** Not even "a decision needs `--options`". A copy of
  `need.sh`'s rules here would drift, and a drifted copy refuses gates the CLI would
  have taken — worse than no check, because the CLI never sees the gate to say so.
- **There is no shell.** `$.process.run` takes an argv, so nothing in an ask, a result
  or a row body can be interpreted as shell. The cost is that the surface does its own
  POSIX-style argument splitting (`splitArgs`), which is why `--ask="one question"`
  arrives as one argument and an unterminated quote runs nothing at all.

## The verb allowlist is a rail, not a scope note

`/task` serves a fixed list and refuses everything else — including by falling through,
which it never does.

**`add` is refused by name.** On this fleet the filing cap is a Claude Code `PreToolUse`
hook on the **Bash tool** (`~/.claude/hooks/pretool-filing-cap.sh`). A verb dispatched
through `$.process.run` never touches the Bash tool, so it never crosses that hook. A
command surface offering `task add` would therefore be a way *around* a guard rather
than a shortcut *to* it. Filing stays on Bash.

The same reasoning is why an unrecognised verb is refused rather than forwarded: a
surface that forwards whatever it is given is a second CLI with none of the first one's
guards. A verb joins the list deliberately, and the list is asserted in
`test/mod-commands.test.ts`.

## What comes back

The command's output rides the transcript row, prefixed with the argv that produced it
and, on a non-zero exit, the exit code. The model additionally reads one note naming the
argv and its exit code, because *"it printed something"* and *"it worked"* are different
facts and a 5dive verb that refuses prints its reason and exits non-zero.

## Turning it on

Three gates, and the third is off on every seat by default.

1. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the seat's env — without it no hooks module
   loads at all.
2. The `mod` plugin installed and enabled for the seat.
3. In the seat's `~/.claude/settings.json`:

   ```json
   { "env": { "FIVEDIVE_MOD_COMMANDS": "1" } }
   ```

This gate is **independent of `FIVEDIVE_MOD_TELEMETRY`**: a seat may want the command
surface with no sink, or the sink with no commands.

| key | default | meaning |
| --- | --- | --- |
| `FIVEDIVE_MOD_COMMANDS` | off | registers and serves `/task` and `/gate` |
| `FIVEDIVE_MOD_CLI` | `5dive` | the executable the commands dispatch to |

If registration fails on a future Claude Code, the mod logs one `5dive mod:` debug line
and the seat keeps the `5dive-cli` skill and the Bash path. Nothing else changes.

## Measuring what it saves: `FIVEDIVE_MOD_CONTEXT_AUDIT`

The row that asked for these commands asked for a number, not a claim: does replacing
the `5dive-cli` and `notify-user` skills with two registered commands actually reduce
what a seat pays per turn?

With `FIVEDIVE_MOD_CONTEXT_AUDIT=1` (and the telemetry sink on, since the line has to
land somewhere) the mod records **one** `context_cost` field on the **first completed
turn** of a session: the engine's own `/context` figures for the skill listing (in total
and per skill) and for the slash-command listing.

Two things about the placement, both learned the hard way:

- **The first completed turn, not `session.start`.** At session start the breakdown is
  taken before a request has been assembled. Measured 2026-09-20: two arms whose
  command listings differed by four commands reported an *identical* slash-command
  token figure there, while their skill counts disagreed for no reason the arms
  explain. Those numbers cannot carry a per-turn claim.
- **Once, behind a latch.** Unlike the no-argument `$.session.usage()` the telemetry
  hooks call, a `full` breakdown counts with the token-count API. Left running per turn,
  the instrument would cost the thing it is measuring.

### What it measured

See DIVE-4693 for the arms, the raw sink lines and the conclusion.
