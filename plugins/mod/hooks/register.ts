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
//   1. OBSERVE ONLY. Every hook calls `next(e)` FIRST and returns exactly what the
//      chain resolved to. No hook returns `{ deny }`, rewrites `e`, or awaits
//      anything before `next`. The guard capability (a `tool.call` deny list) and
//      the wall-handling capability are deliberately NOT here; they are separate rows.
//   2. FAIL OPEN. The surface below is EARLY ACCESS and may change between Claude Code
//      releases. Every `$` call the mod makes sits inside a try/catch, and the FIRST
//      failure disables the mod for the rest of the session after logging one line —
//      it does not retry per event and it never propagates. A seat whose Claude Code
//      no longer has one of these calls runs exactly as a seat with no mod.
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
// fallback today and could drop lines of the same shape into the same directory
// later without any consumer changing.

import type { EngineInterface, Register } from 'claude-code'

/** The schema version of a sink line. Bump only on a breaking change. */
const SCHEMA = 1

/** The plugin's own version; kept in step with plugin.json by test/mod-telemetry.test.ts. */
const VERSION = '0.1.0'

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

/** Where the sink lands unless DIR_KEY says otherwise. One file per session. */
const DEFAULT_DIR = '/var/lib/5dive/mod-telemetry'

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

    const dir = String(vars[DIR_KEY] ?? '') || DEFAULT_DIR
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
  } catch {
    return undefined
  }
}

/**
 * Appends one line to the session's file. `$.fs.write` replaces a file rather than
 * appending, so the session's lines are held here and the whole file is rewritten;
 * one session owns one file, so there is no second writer to race with. Writes are
 * chained so two events in the same tick cannot interleave, and every failure is
 * swallowed: telemetry must never be able to fail a turn.
 */
function record($: EngineInterface, s: Live, f: Fields): void {
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
    () => {},
  )
}

export const register: Register = (on) => {
  // Registration is unconditional: the engine statically scans the event names a
  // module registers and refuses an unknown one at load, so the gates cannot be
  // applied here. They are applied on the first hook, where `$` exists.

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    state ??= resolveState($)
    const s = await state
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
}
