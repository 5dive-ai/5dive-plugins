// 5dive `mod` — a telemetry PRODUCER for the harness-agnostic idle/usage contract
// (DIVE-4692, pilot).
//
// Why this exists: the heartbeat's reclaim, the pacing floor and the self-update's
// pending-restart sweep infer "is this seat mid-turn?" and "what does its usage meter
// read?" from `claude agents --json` polling, byte-stable pane samples, a composer
// glyph and the task board. Claude Code's function hooks hand both out as first-class
// signals from inside the process that owns them. This mod publishes them; NOTHING in
// the heartbeat or the pacing floor changes behaviour on this row — they may read the
// new lines side by side with what they infer today, and the comparison decides
// whether a second producer is worth having.
//
// Three hard properties, in the order they matter:
//
// DIVE-4693 added a SECOND capability to this module, and it is the one place the
// "observe only" property above is deliberately not universal, so read this before the
// list: the mod now also SERVES two slash commands of its own, `/task` and `/gate`,
// registered with `$.command.register` behind their own gate. A command this plugin
// registered has no core implementation — nothing downstream of the hook can run it —
// so its `command.run` hook ANSWERS with `{ text }` instead of calling `next`. That is
// the only hook in the file that does, it is reached only for names this plugin
// registered (an engine matcher, not an `if`), and it still never returns `{ deny }`:
// it cannot refuse, rewrite or delay anything the session would otherwise have done.
// The telemetry hooks below are untouched and remain observe-only.
//
//   1. OBSERVE ONLY (every hook registered with NO matcher). Every one calls `next(e)`
//      FIRST and returns exactly what the chain resolved to. No hook returns `{ deny }`, rewrites `e`, or awaits
//      anything before `next`. The guard capability (a `tool.call` deny list) and
//      the wall-handling capability are deliberately NOT here; they are separate rows.
//   2. FAIL OPEN, AND FAIL LEGIBLY. The surface below is EARLY ACCESS and may change
//      between Claude Code releases. Every `$` call the mod makes sits inside a
//      try/catch, so no failure ever propagates into the chain — and every catch
//      EMITS, because a producer that swallows its failure is indistinguishable from
//      one that is switched off (DIVE-4692 iteration 1 shipped exactly that: an empty
//      rejection handler on the sink write, at a default path no seat could write, so
//      the mod loaded and wrote nothing and said nothing). Which failure does what:
//        - resolving the gates, the seat or the session id fails -> one debug line,
//          the mod is OFF for the session;
//        - the sink WRITE fails -> one debug line naming the path and the error, and
//          the mod is OFF for the session (a sink it cannot write is not a sink);
//        - `$.session.usage()` fails -> one debug line, and the turn boundaries keep
//          recording with NO `usage` key. Absent is the contract's own answer for a
//          reading nobody has (never zero), so losing the boundaries as well would
//          cost the pilot more than the meter does.
//      A seat whose Claude Code no longer has one of these calls runs exactly as a
//      seat with no mod, and the debug log says which call went.
//   3. OFF BY DEFAULT. Two independent gates, both of which must be on:
//        - the harness's: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in the seat's env, or
//          this module is never loaded at all;
//        - 5dive's: `env.FIVEDIVE_MOD_TELEMETRY` = "1" in the seat's settings.json.
//          Absent (the default on every seat) means off, and off means pass-through.
//
// HOST RULE that shapes this file: the engine statically scans a hooks module's
// SOURCE, and `$` may never be bound to a name — no `const e = $`, no passing `$` to
// a helper, no walking it. Every use is spelled literally as `$.noun.member(...)` at
// the call site. That is why there is no tidy "probe every member I touch" loop here
// and why each hook repeats its own calls: the scan is what makes a plugin's reach
// auditable from its source, and working around it is not available. Its corollary is
// that the compatibility check CANNOT be a lookup — it is the try/catch above, plus
// the scan itself, which refuses at load a module naming a call this build lacks.
//
// Compatibility: written and verified against Claude Code 2.1.278 (`/plugin-types` on
// this box, 2026-09-20). plugin.json has NO field for pinning a Claude Code version
// range — verified against 2.1.278's own manifest schema — so the pin is recorded in
// the data instead: every line carries `producer`, which names the build it came from,
// and a consumer that cares pins on that.
//
// The sink and its schema are documented in docs/mod-telemetry-contract.md. The
// contract is HARNESS-AGNOSTIC on purpose: this mod is one producer of it, not the
// contract itself. A codex/grok/pi/opencode/agy seat keeps the pane-and-board
// fallback today and could drop lines of the same shape into a sink of the same shape
// later without any consumer changing.

import type { EngineInterface, Register } from 'claude-code'
// The above-prompt seat panel (DIVE-4694). Its own file, its own flag, its own state;
// registered from here because `hooks.json` admits exactly one module per plugin.
import { registerPanel } from './panel'

/** The schema version of a sink line. Bump only on a breaking change. */
const SCHEMA = 1

/** The plugin's own version; kept in step with plugin.json by test/mod-telemetry.test.ts. */
const VERSION = '0.3.0'

/**
 * The Claude Code build this file was written and verified against. Recorded on every
 * line rather than enforced — see the compatibility note above.
 */
const VERIFIED_AGAINST = '2.1.278'

/** The settings key that turns the mod on for a seat. Absent or anything but "1" is off. */
const FLAG = 'FIVEDIVE_MOD_TELEMETRY'

/** Optional overrides, same place as FLAG. */
const DIR_KEY = 'FIVEDIVE_MOD_TELEMETRY_DIR'
const SEAT_KEY = 'FIVEDIVE_MOD_TELEMETRY_SEAT'

/**
 * The settings key that turns the `/task` and `/gate` commands on for a seat
 * (DIVE-4693). Independent of FLAG on purpose: the telemetry pilot and the command
 * surface are separate decisions, and a seat may want either without the other.
 * Absent or anything but "1" is off, and off means the commands are never registered.
 */
const COMMANDS_FLAG = 'FIVEDIVE_MOD_COMMANDS'

/**
 * The settings key that makes the mod record ONE context-cost line per session
 * (DIVE-4693's measurement instrument). Off by default and meant to be switched on for
 * a measurement run, never left on: unlike `$.session.usage()` with no argument, a
 * breakdown counts with the token-count API, so it is not free.
 */
const AUDIT_FLAG = 'FIVEDIVE_MOD_CONTEXT_AUDIT'

/** The 5dive CLI the commands dispatch to; override for a test or a non-standard path. */
const CLI_KEY = 'FIVEDIVE_MOD_CLI'
const DEFAULT_CLI = '5dive'

/**
 * How long a dispatched CLI call may take before the command gives up. `5dive task
 * show` is a local sqlite read; the ceiling is here so a hung CLI cannot hold the
 * composer, not because any verb is expected to approach it.
 */
const CLI_TIMEOUT_MS = 60_000

/**
 * Where the sink lands unless DIR_KEY says otherwise: the runtime's per-seat state
 * directory, under the seat's own home. One file per session.
 *
 * NOT a shared directory under /var/lib/5dive. That tree is `drwxr-s--- root:claude`,
 * so a seat cannot create a subdirectory in it (measured 2026-09-20 — it is what made
 * iteration 1 of this plugin write nothing at its own documented default). A shared
 * sink is still reachable, and is opt-in: ops creates it group-writable and the seat
 * points DIR_KEY at it. The default has to be a path the seat owns.
 */
const DEFAULT_SUBDIR = '.5dive/mod-telemetry'

/**
 * How many lines one session's file may hold. A session that reaches it stops
 * recording and says so once: the pilot is a measurement, not a debug trace, and an
 * unbounded in-memory buffer rewritten per event is the one place this mod could cost
 * a seat something.
 */
const MAX_LINES = 5000

type Usage = {
  context?: unknown
  rate_limits?: unknown
  cost_usd?: number
}

type Fields = {
  ts: number
  event: string
  turn_id?: string
  reason?: string
  command?: string
  tool?: string
  usage?: Usage
  /** DIVE-4693's measurement: what the per-turn listings cost this session. */
  context_cost?: ContextCost
}

/**
 * The per-turn listing cost, as the engine itself counts it (`/context`'s own numbers,
 * not an estimate of ours): the skill listing in total and per skill, and the
 * slash-command listing in total. This is the instrument DIVE-4693's before/after is
 * read off — a saving claimed from the difference between two of these lines, one with
 * the skills in the seat's skill set and one with the commands registered instead.
 */
type ContextCost = {
  model: string
  total_tokens: number
  skills?: {
    total: number
    included: number
    tokens: number
    per_skill: Array<{ name: string; source: string; tokens: number }>
  }
  slash_commands?: { total: number; included: number; tokens: number }
}

type Live = {
  on: true
  seat: string
  path: string
  producer: string
  sessionId: string
}

const OFF = { on: false } as const
type State = Live | typeof OFF

/** Resolved once per session, then reused; `null` until the first hook runs. */
let state: Promise<State> | null = null

/** The session's lines, and the chain that serialises the rewrites of its file. */
const lines: string[] = []
let flush: Promise<void> = Promise.resolve()
let stopped = false

/** Each of these says its thing once per session, not once per event. */
let writeFailureLogged = false
let usageFailureLogged = false

/**
 * The seat's name, from the plugin's own directory, which lives under the seat's home:
 * /home/agent-<seat>/... is `<seat>` and /home/claude/... is `claude`. Anything else
 * answers null and the mod stays off rather than writing lines nothing can attribute.
 *
 * Exported so test/mod-telemetry.test.ts can exercise it without an engine.
 */
export function seatFromRoot(root: string): string | null {
  const m = /^\/home\/([^/]+)\//.exec(root.endsWith('/') ? root : `${root}/`)
  const user = m?.[1]
  if (user === undefined) return null
  if (user === 'claude') return 'claude'
  if (user.startsWith('agent-') && user.length > 'agent-'.length) {
    return user.slice('agent-'.length)
  }
  return null
}

/**
 * The seat's home directory, read off the same path the seat name comes from. The
 * default sink lives under it because it is the one directory a seat is guaranteed to
 * be able to write. Answers null on a path the rule does not cover, and then the mod
 * records nothing unless DIR_KEY names a directory explicitly.
 *
 * Exported so test/mod-telemetry.test.ts can exercise it without an engine.
 */
export function homeFromRoot(root: string): string | null {
  const m = /^(\/home\/[^/]+)(?:\/|$)/.exec(root)
  return m?.[1] ?? null
}

/** A filename component that cannot escape the sink directory. */
export function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The `env` block of a settings snapshot, which is where both 5dive gates live. */
export function envOf(settings: unknown): Record<string, unknown> {
  const block = (settings as Record<string, unknown> | null)?.['env']
  return block !== null && typeof block === 'object'
    ? (block as Record<string, unknown>)
    : {}
}

/** Builds the sink path for a seat and session. */
export function sinkPath(dir: string, seat: string, sessionId: string): string {
  return `${dir}/${safe(seat)}-${safe(sessionId)}.jsonl`
}

/** Builds one sink line. Pure, so the schema is testable without an engine. */
export function lineFor(s: Live, f: Fields): string {
  return JSON.stringify({
    v: SCHEMA,
    seat: s.seat,
    harness: 'claude-code',
    producer: s.producer,
    session_id: s.sessionId,
    ...f,
  })
}

/** The `producer` string a line carries. */
export function producerFor(name: string): string {
  return `${name}@5dive-plugins/${VERSION} (claude-code ${VERIFIED_AGAINST})`
}

/**
 * Decides once whether this session records, and where. Every failure answers OFF:
 * a mod that cannot tell what it is measuring must not guess, and a mod that throws
 * must not reach the chain. Declared at the top of the file because it takes
 * `$`: the host scan admits `$` as an argument only to a top-level function, never
 * to a closure or a stored value.
 */
async function resolveState($: EngineInterface): Promise<State> {
  try {
    const vars = envOf(await $.settings.read())
    if (String(vars[FLAG] ?? '') !== '1') return OFF

    const seat = String(vars[SEAT_KEY] ?? '') || seatFromRoot($.plugin.root)
    if (seat === null || seat === '') {
      $.ui.log(
        `5dive mod off: cannot name this seat from ${$.plugin.root}; set ` +
          `${SEAT_KEY} in the seat's settings to record anyway.`,
        { to: 'debug' },
      )
      return OFF
    }

    // Binding the HOME is fine; binding `$` is what the host scan refuses.
    const home = homeFromRoot($.plugin.root)
    const dir =
      String(vars[DIR_KEY] ?? '') || (home === null ? '' : `${home}/${DEFAULT_SUBDIR}`)
    if (dir === '') {
      $.ui.log(
        `5dive mod off: no sink directory — ${$.plugin.root} is not under a seat's ` +
          `home, so the default cannot be derived; set ${DIR_KEY} in the seat's ` +
          `settings to a directory this seat can write.`,
        { to: 'debug' },
      )
      return OFF
    }

    const sessionId = await $.session.id()
    return {
      on: true,
      seat,
      producer: producerFor($.plugin.name),
      sessionId,
      path: sinkPath(dir, seat, sessionId),
    }
  } catch (err) {
    // Not a crash and not a silent no-op: one line naming what this Claude Code
    // build would not do, which is what makes the next upgrade's break legible.
    try {
      $.ui.log(
        `5dive mod disabled: this Claude Code build refused a call the mod needs ` +
          `(verified against ${VERIFIED_AGAINST}): ${String(err)}. The seat runs as before.`,
        { to: 'debug' },
      )
    } catch {
      // $.ui.log is itself one of the calls that can go; if it is the one, stay quiet.
    }
    return OFF
  }
}

/**
 * The usage reading, shaped for the contract. Called only on the events the pilot
 * measures — never per tool call.
 *
 * `$.session.usage()` with no argument computes no breakdown and sends no
 * token-count request, so this costs the turn nothing.
 *
 * A reading the engine cannot produce comes back ABSENT, never zero: a consumer must
 * be able to tell "no reading" from "0% used", which is the blind-meter bug this row
 * exists to measure in the first place.
 */
async function usage($: EngineInterface): Promise<Usage | undefined> {
  try {
    const u = await $.session.usage()
    return {
      context: u.context,
      rate_limits: u.rateLimits,
      ...(u.cost === undefined ? {} : { cost_usd: u.cost.usd }),
    }
  } catch (err) {
    // Absent, not zero — but absent SILENTLY, forever, is the blind meter this row
    // exists to remove, so the first failure says so once. The boundaries keep
    // recording: they are the half of the pilot that does not depend on this call.
    if (!usageFailureLogged) {
      usageFailureLogged = true
      try {
        $.ui.log(
          `5dive mod: $.session.usage() failed on this build (verified against ` +
            `${VERIFIED_AGAINST}): ${String(err)}. Lines this session carry NO usage ` +
            `reading — absent, never zero. Turn boundaries keep recording.`,
          { to: 'debug' },
        )
      } catch {}
    }
    return undefined
  }
}

/**
 * The sink write failed. Says so ONCE, naming the path and the error, and stops the
 * session's recording: a producer that cannot write its sink is off, and it has to be
 * possible to tell that from the outside — "off", "on and broken" and "on and quiet"
 * are one observable otherwise, which is how iteration 1 passed its own negative
 * controls while producing nothing.
 *
 * It does not throw and it does not retry. Declared at the top level because it takes
 * `$` (see the HOST RULE note at the top of the file).
 */
function writeFailed($: EngineInterface, path: string, err: unknown): void {
  stopped = true
  if (writeFailureLogged) return
  writeFailureLogged = true
  try {
    $.ui.log(
      `5dive mod disabled: could not write the telemetry sink at ${path}: ` +
        `${String(err)}. No further lines this session; the seat runs exactly as it ` +
        `does with no mod. Point ${DIR_KEY} at a directory this seat can write.`,
      { to: 'debug' },
    )
  } catch {}
}

/**
 * Appends one line to the session's file. `$.fs.write` replaces a file rather than
 * appending, so the session's lines are held here and the whole file is rewritten;
 * one session owns one file, so there is no second writer to race with. Writes are
 * chained so two events in the same tick cannot interleave, and no failure is ever
 * allowed to reach the chain — telemetry must not be able to fail a turn — but the
 * first one is logged and latches recording off (`writeFailed`).
 */
export function record($: EngineInterface, s: Live, f: Fields): void {
  if (stopped) return
  if (lines.length >= MAX_LINES) {
    stopped = true
    try {
      $.ui.log(`5dive mod: ${MAX_LINES} lines this session; stopping.`, { to: 'debug' })
    } catch {}
    return
  }
  lines.push(lineFor(s, f))
  const text = `${lines.join('\n')}\n`
  const path = s.path
  flush = flush.then(() => $.fs.write(path, text)).then(
    () => {},
    (err) => writeFailed($, path, err),
  )
}


// ---------------------------------------------------------------------------
// DIVE-4693: `/task` and `/gate` as first-class commands.
//
// WHY A COMMAND AND NOT A SKILL. The `5dive-cli` and `notify-user` skills are the
// seat's instructions for driving the same CLI. A skill's frontmatter is listed to the
// model on EVERY turn whether or not it is ever used, and its BODY is loaded again on
// every invocation. A slash command this plugin registers is listed once in the
// command listing and its body is code, not prompt. Whether that is actually cheaper
// per turn is a measurement, not an assumption — the instrument is `contextCost`
// below and the numbers are on DIVE-4693. The commands are worth having either way
// (they are one dispatch instead of "recall the flag, write the bash line"), but the
// row's claim was the token one, so the token one is measured.
//
// THE CLI IS THE SINGLE SOURCE OF TRUTH. These commands build an argv and run the same
// `5dive` binary a seat runs from Bash. They parse no flags, default no values, and
// reimplement no guard: the filing cap, done-refuses-blank and the ask-readability
// check refuse a command exactly as they refuse a Bash line, because it is the same
// process doing the refusing.
//
// WITH ONE EXCEPTION, AND IT IS THE POINT OF THE ALLOWLIST. Not every 5dive guard
// lives in the CLI. On this fleet the filing cap is a Claude Code PreToolUse hook on
// the *Bash tool* (`~/.claude/hooks/pretool-filing-cap.sh`), so a verb dispatched
// through `$.process.run` does not pass it — the tool it guards is never used. A
// command surface that offered `task add` would therefore be a hole in a rail, not a
// shortcut through it. So the surface is an ALLOWLIST of the verbs DIVE-4693 scoped,
// `add` is not on it and is refused by name with the reason, and a verb nobody has
// thought about is refused rather than passed through.

/** The `task` verbs `/task` will dispatch. Anything else is refused, not passed on. */
export const TASK_VERBS = [
  'show',
  'ls',
  'done',
  'deliver',
  'reject',
  'assign',
  'set-body',
] as const

/**
 * Verbs refused with a reason of their own rather than the generic one, because the
 * reason is a rail and not a scoping accident. `add` is guarded by a PreToolUse hook on
 * the Bash tool, which a dispatched command does not cross (see the note above).
 */
export const TASK_VERBS_REFUSED: Record<string, string> = {
  add: 'filing goes through Bash: the filing cap is a PreToolUse hook on the Bash tool, and a command dispatched in-process would not cross it',
  need: 'use /gate, which is this same dispatch with the gate CLI\'s own checks',
}

/**
 * Splits a command's argument string into an argv the way a POSIX shell would, so
 * `--ask="one crisp question"` arrives as ONE argument. Single quotes are literal,
 * double quotes allow a backslash escape, and a backslash outside quotes escapes the
 * next character.
 *
 * This exists because `$.process.run` takes an argv and runs no shell — which is the
 * property worth having (nothing in an ask, a result or a body can reach a shell), and
 * the cost of it is that the splitting is ours. An unterminated quote answers null and
 * the command says so rather than guessing where the argument ended.
 */
export function splitArgs(input: string): string[] | null {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) {
        i += 1
        cur += input[i]!
      } else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      continue
    }
    if (c === '\\' && i + 1 < input.length) {
      i += 1
      cur += input[i]!
      has = true
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (has) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
    has = true
  }
  if (quote !== null) return null
  if (has) out.push(cur)
  return out
}

/** What a command resolved to: an argv to run, or a refusal to show as the output. */
export type Dispatch = { argv: string[] } | { refuse: string }

/**
 * Turns `/task <verb> ...` into the argv for the CLI, or into a refusal.
 *
 * `cli` is the executable; everything after it is passed to `5dive task` untouched.
 */
export function taskDispatch(cli: string, args: string): Dispatch {
  const argv = splitArgs(args)
  if (argv === null) {
    return { refuse: 'Unterminated quote in the arguments — nothing was run.' }
  }
  const verb = argv[0]
  if (verb === undefined) {
    return {
      refuse:
        `/task needs a verb. This surface serves: ${TASK_VERBS.join(', ')}.\n` +
        'Everything else stays on the CLI: run `5dive task --help` from Bash.',
    }
  }
  const named = TASK_VERBS_REFUSED[verb]
  if (named !== undefined) {
    return { refuse: `/task ${verb} is not served here — ${named}. Run it from Bash.` }
  }
  if (!(TASK_VERBS as readonly string[]).includes(verb)) {
    return {
      refuse:
        `/task ${verb} is not one of the verbs this surface serves ` +
        `(${TASK_VERBS.join(', ')}).\nRun it from Bash: \`5dive task ${verb} …\`. ` +
        'A verb is added here deliberately, never by falling through.',
    }
  }
  return { argv: [cli, 'task', ...argv] }
}

/**
 * Turns `/gate <ident> --type=… --ask=… --recommend=…` into `5dive task need …`.
 *
 * The gate's own rules — that the ask is readable by someone who has never seen our
 * code, that a decision carries `--options`, what tier a type defaults to — are the
 * CLI's and stay the CLI's. This does not pre-check them: a check here that drifted
 * from `need.sh` would refuse a gate the CLI would have taken, which is worse than no
 * check at all.
 */
export function gateDispatch(cli: string, args: string): Dispatch {
  const argv = splitArgs(args)
  if (argv === null) {
    return { refuse: 'Unterminated quote in the arguments — nothing was run.' }
  }
  if (argv.length === 0) {
    return {
      refuse:
        '/gate needs the row and the gate: `/gate DIVE-1234 --type=decision ' +
        '--ask="…" --recommend="…" --options="…|…"`.',
    }
  }
  return { argv: [cli, 'task', 'need', ...argv] }
}

/** How a finished dispatch presents: the person's line, and the model's note. */
export function dispatchResult(
  argv: readonly string[],
  exitCode: number,
  stdout: string,
  stderr: string,
): { text: string; context: readonly string[] } {
  const shown = `${stdout}${stdout !== '' && stderr !== '' ? '\n' : ''}${stderr}`.trimEnd()
  const line = argv.join(' ')
  const head = exitCode === 0 ? `$ ${line}` : `$ ${line}\n(exit ${exitCode})`
  return {
    text: shown === '' ? `${head}\n(no output)` : `${head}\n${shown}`,
    // The model reads the exit code explicitly: a 5dive verb that refuses prints its
    // reason on stdout and exits non-zero, and "it printed something" is not the same
    // fact as "it worked". The output itself rides the transcript row above.
    context: [
      `\`${line}\` exited ${exitCode}. The 5dive CLI is the authority on what it did; ` +
        'this command only ran it.',
    ],
  }
}

/** Whether this session serves `/task` and `/gate`, and with which CLI. */
type Commands = { on: true; cli: string } | { on: false }

/** Resolved once per session. */
let commands: Promise<Commands> | null = null

/** Each says its thing once per session, not once per command. */
let registerFailureLogged = false
let auditFailureLogged = false

/** The context-cost audit is one line per session, on the first completed turn. */
let auditDone = false

/**
 * Whether this session wants the context-cost line at all. Resolved ONCE, like
 * `state` and `commands`: audit-off is the default case, and read per turn it would
 * be a settings read on every turn of every telemetry seat that is not auditing.
 */
let audit: Promise<boolean> | null = null

/**
 * Reads AUDIT_FLAG once per session. A settings read that throws means off — the same
 * contract as everywhere else in this file. Declared at the top level because it
 * takes `$`.
 */
async function resolveAudit($: EngineInterface): Promise<boolean> {
  try {
    return String(envOf(await $.settings.read())[AUDIT_FLAG] ?? '') === '1'
  } catch {
    return false
  }
}

/**
 * Decides once whether this session serves the commands, and registers them.
 *
 * Gated independently of the telemetry FLAG: a seat may want the command surface with
 * no sink, or the sink with no commands. Failure is the same contract as everywhere
 * else in this file — one debug line, off for the session, the seat runs as before.
 * Declared at the top level because it takes `$`.
 */
async function resolveCommands($: EngineInterface): Promise<Commands> {
  try {
    const vars = envOf(await $.settings.read())
    if (String(vars[COMMANDS_FLAG] ?? '') !== '1') return { on: false }
    const cli = String(vars[CLI_KEY] ?? '') || DEFAULT_CLI

    await $.command.register({
      name: 'task',
      description: 'Run a 5dive task verb (show, ls, done, deliver, reject, assign, set-body).',
      argumentHint: 'verb [ident] [flags]',
    })
    await $.command.register({
      name: 'gate',
      description: 'File a 5dive human gate on a row (5dive task need).',
      argumentHint: 'ident --type=… --ask="…" --recommend="…"',
    })
    return { on: true, cli }
  } catch (err) {
    if (!registerFailureLogged) {
      registerFailureLogged = true
      try {
        $.ui.log(
          `5dive mod: could not register the /task and /gate commands on this build ` +
            `(verified against ${VERIFIED_AGAINST}): ${String(err)}. The seat keeps the ` +
            `5dive-cli skill and the Bash path; nothing else changes.`,
          { to: 'debug' },
        )
      } catch {}
    }
    return { on: false }
  }
}

/**
 * Runs one dispatched CLI call. Every failure — the binary missing, a timeout, a
 * non-zero exit — comes back as TEXT for the person, never as a thrown hook: a command
 * surface that can crash the composer is worse than one that can be wrong.
 *
 * Declared at the top level because it takes `$`.
 */
async function runCli(
  $: EngineInterface,
  d: Dispatch,
): Promise<{ text: string; context?: readonly string[] }> {
  if ('refuse' in d) return { text: d.refuse }
  try {
    const r = await $.process.run(d.argv, { timeoutMs: CLI_TIMEOUT_MS })
    return dispatchResult(d.argv, r.exitCode, r.stdout, r.stderr)
  } catch (err) {
    // `$.process.run` rejects when the command cannot start or is still running at the
    // timeout. Both are the person's to see, with the argv, because the argv is the
    // thing they would retype into Bash.
    return {
      text:
        `$ ${d.argv.join(' ')}\n(the command did not complete: ${String(err)})\n` +
        'Run it from Bash — this surface is a dispatch, not a second implementation.',
    }
  }
}

/**
 * DIVE-4693's measurement instrument: ONE line per session naming what the skill and
 * slash-command listings cost in the context window, as the engine counts them.
 *
 * Gated behind AUDIT_FLAG and off by default, and deliberately NOT per turn: a
 * breakdown counts with the token-count API (the no-argument `$.session.usage()` the
 * telemetry hooks use does not), so leaving this on would make the mod cost the thing
 * it is here to measure.
 *
 * Declared at the top level because it takes `$`.
 */
async function contextCost($: EngineInterface): Promise<ContextCost | undefined> {
  try {
    const u = await $.session.usage({ breakdown: 'full' })
    const b = u.context?.breakdown
    if (b === undefined) return undefined
    return {
      model: b.model,
      total_tokens: b.totalTokens,
      ...(b.skills === undefined
        ? {}
        : {
            skills: {
              total: b.skills.totalSkills,
              included: b.skills.includedSkills,
              tokens: b.skills.tokens,
              per_skill: b.skills.skillFrontmatter.map((f) => ({
                name: f.name,
                source: f.source,
                tokens: f.tokens,
              })),
            },
          }),
      ...(b.slashCommands === undefined
        ? {}
        : {
            slash_commands: {
              total: b.slashCommands.totalCommands,
              included: b.slashCommands.includedCommands,
              tokens: b.slashCommands.tokens,
            },
          }),
    }
  } catch (err) {
    if (!auditFailureLogged) {
      auditFailureLogged = true
      try {
        $.ui.log(
          `5dive mod: the context-cost audit failed on this build (verified against ` +
            `${VERIFIED_AGAINST}): ${String(err)}. No context_cost line this session.`,
          { to: 'debug' },
        )
      } catch {}
    }
    return undefined
  }
}

export const register: Register = (on) => {
  // Registration is unconditional: the engine statically scans the event names a
  // module registers and refuses an unknown one at load, so the gates cannot be
  // applied here. They are applied on the first hook, where `$` exists.

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
    // The command surface is gated independently of the sink, so it is resolved here
    // whatever the telemetry state says. `$.command.register` is what makes `/task`
    // and `/gate` appear in the typeahead; the hooks below are what serve them.
    commands ??= resolveCommands($)
    await commands
    if (s.on) {
      record($, s, {
        ts: Date.now(),
        event: 'session.start',
        reason: e.isInteractive ? 'interactive' : 'headless',
        usage: await usage($),
      })
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
    // The turn's OPENING boundary — the signal the reclaim and the pending-restart
    // sweep have never had. A seat between this line and its turn.complete is busy,
    // whatever its pane looks like.
    if (s.on) {
      record($, s, { ts: Date.now(), event: 'turn.start', turn_id: e.turnId, usage: await usage($) })
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
    // `reason` distinguishes an answered turn from an interrupted, refused or errored
    // one. An abort arrives HERE, as reason "aborted": this build has no `turn-abort`
    // EVENT — `turn.abort` is a call on `$` and "turn-abort" is an abort reason — so
    // turn.complete is where the pilot reads one.
    if (s.on) {
      record($, s, {
        ts: Date.now(),
        event: 'turn.complete',
        turn_id: e.turnId,
        reason: e.reason,
        usage: await usage($),
        // DIVE-4693's before/after is read off this field: ONE line, on the FIRST
        // completed turn, and only when the seat asked for it.
        //
        // The first COMPLETED turn and not `session.start`, and the difference is the
        // measurement: at session.start the breakdown is taken before a request has
        // been assembled, and it reports counts for listings whose token figures are
        // not yet the ones a turn pays (measured 2026-09-20 — two arms differing by
        // four listed commands both reported an identical slash-command token figure
        // there, while their skill counts disagreed for no reason the arms explain).
        // After a turn completes, the breakdown is over what was actually sent, which
        // is the only number this row is allowed to claim a per-turn saving from.
        //
        // The flag itself is resolved once per session (`audit`), not read here: with
        // the audit off — the default — `auditDone` never flips, so a settings read in
        // this expression would run on every turn of every telemetry seat forever.
        ...(auditDone || !(await (audit ??= resolveAudit($)))
          ? {}
          : ((auditDone = true), { context_cost: await contextCost($) })),
      })
    }
    return r
  })

  on('command.run', async ($, e, next) => {
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
    if (s.on) {
      record($, s, { ts: Date.now(), event: 'command.run', command: e.command, usage: await usage($) })
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    // OBSERVE. `next(e)` first and its result returned untouched: this hook can
    // neither deny a call nor change one. It carries no usage reading — a tool call is
    // frequent and `$.session.usage()` per call would be the one place this mod could
    // cost a turn real time.
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
    if (s.on) record($, s, { ts: Date.now(), event: 'tool.call', tool: e.tool })
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
    if (s.on) {
      record($, s, { ts: Date.now(), event: 'session.end', reason: e.reason, usage: await usage($) })
    }
    return r
  })

  // The two hooks that SERVE this plugin's own commands. Unlike every hook above they
  // answer with `{ text }` instead of calling `next(e)` — a command registered by
  // `$.command.register` has no core implementation to pass to, and `next` would
  // resolve to "no hook answered this". The matcher is the engine's, not an `if`: these
  // bodies are unreachable for any command but the two names registered above, and
  // neither can return `{ deny }`, so no other command and no tool call can be refused,
  // rewritten or delayed by this file.
  on('command.run', { command: 'task' }, async ($, e) => {
    const c = await (commands ??= resolveCommands($))
    if (!c.on) {
      return { text: 'The 5dive command surface is off on this seat. Run `5dive task …` from Bash.' }
    }
    return runCli($, taskDispatch(c.cli, e.args))
  })

  on('command.run', { command: 'gate' }, async ($, e) => {
    const c = await (commands ??= resolveCommands($))
    if (!c.on) {
      return { text: 'The 5dive command surface is off on this seat. Run `5dive task need …` from Bash.' }
    }
    return runCli($, gateDispatch(c.cli, e.args))
  })

  registerPanel(on)
}
