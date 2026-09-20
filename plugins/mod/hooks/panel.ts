// 5dive `mod` — the above-prompt SEAT PANEL (DIVE-4694).
//
// Why this exists: lodar reads seats through tmux panes and `5dive watch`. The seat's
// OWN view shows nothing about the row it holds — not which row, not whether a gate is
// open on it, not how much of its budget the row has burned, not whether its delivery
// is sitting with a grader. Everything an operator needs to answer "what is this seat
// doing and is it stuck?" is in the runtime, and none of it is on the seat's screen.
//
// A `ui.render` hook on the `AbovePrompt` band draws one compact line there. It costs
// the MODEL nothing: a render hook's tree is drawn by the terminal and is never part of
// the prompt, so no token of this reaches the context window. That is the whole point
// of putting it here rather than in a `/goal` preamble or a skill.
//
// Four hard properties, in the order they matter:
//
//   1. IT DRAWS, IT DOES NOT DECIDE. The render hook awaits `next(e)` first and never
//      rewrites `e`. It reads a cache filled outside the draw and never runs a
//      subprocess inside one: a draw happens on every width change and every
//      invalidate, and a draw that shells out is a draw that can stall the terminal.
//   2. ABSENT IS NOT ZERO. Every field the refresh could not read renders as `—` and
//      says why on hover-free plain text (`row ?`), never as a plausible zero. The
//      burn figure in particular: `pace-usage.json` marks a row's attributed tokens
//      `dispatched:false` when the cross-check could not tie them to a dispatch of
//      that row, and DIVE-3343/DIVE-4430 is the decision record for why an unverified
//      per-row figure must never be shown as if it were the row's. Unverified renders
//      with a `~` and the word `unverified`.
//   3. FAIL OPEN, AND FAIL LEGIBLY. Same contract as the telemetry half (see
//      register.ts): every `$` call sits in a try/catch, every catch emits once, and a
//      failure leaves the band exactly as it is with no mod — the hook returns what
//      the chain resolved to.
//   4. OFF BY DEFAULT, behind the pilot's own gates: the harness's
//      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1, and 5dive's `FIVEDIVE_MOD_PANEL=1` in the
//      seat's settings `env` block. Absent means off, and off means the hook passes
//      the band through untouched.
//
// WHAT THIS CARRIES AND WHAT DIVE-4665 CARRIES. DIVE-4665 (5dive-api
// scripts/inc/statusline.sh, merged 2026-09-20) put the model, the effort, the context
// fill, the session's cost AND the account's 5h/7d window percentages on the seat's
// STATUS LINE — one line below this band. So the split is by OWNER of the fact:
//   * statusline: everything that belongs to the SESSION and the ACCOUNT;
//   * this panel:  everything that belongs to the ROW — ident, status, gate, grader,
//                  and the row's token burn against the row's budget, none of which
//                  the statusline payload knows or can know.
// The account windows are therefore NOT repeated here as figures. They appear in one
// case, because it is the case the statusline cannot express: a window at or past
// ACCT_WARN_PCT draws `acct 5h 92%!`, and NO reading at all draws `acct —`. A blind
// meter renders on the status line as simply absent, which is the same pixels as "this
// field is off" — and a blind meter is precisely what holds rows on the pacing floor.
// Saying it out loud is the one thing worth a cell. (DIVE-4694's SCOPE asked for the
// account window unconditionally; its SIBLING clause asked for no duplication of 4665,
// and 4665 landed first. This is that clause taken literally, and it is recorded on
// both rows.)
//
// WHERE THE NUMBERS COME FROM, and why not from `5dive usage --json`. That verb is
// root-only, and a seat is not root. The heartbeat already runs it once a tick and
// publishes the result at /var/lib/5dive/pace-usage.json (mode 0664, group `claude`,
// which every seat is in). Reading that file is a few kB off the page cache and it is
// the SAME figure DIVE-4430's park enforces, so the panel shows the operator the
// number the guard will act on rather than a second, differently-derived one.
//
// HOST RULE, the same one register.ts is shaped by: the engine statically scans this
// module's SOURCE and `$` may never be bound to a name — no `const e = $`, no passing
// `$` into a closure, no walking it. Every use is spelled literally `$.noun.member(…)`
// at the call site, and a function that takes `$` is declared at the TOP LEVEL. That
// is why the helpers below are top-level declarations and the pure ones (which are
// most of them) take no `$` at all and are exported for the test suite.

import type { EngineInterface, On, RenderElement, RenderInputOf } from 'claude-code'

/** The plugin's own version; kept in step with plugin.json by test/mod-panel.test.ts. */
const VERSION = '0.5.0'

/** The Claude Code build this file was written and verified against. */
const VERIFIED_AGAINST = '2.1.278'

/** The settings key that turns the PANEL on for a seat. Independent of the telemetry
 * half's flag: a seat may want the screen without the sink, or the sink without the
 * screen, and one flag for both would make "it is off" ambiguous. */
const FLAG = 'FIVEDIVE_MOD_PANEL'

/** Optional overrides, same `env` block as FLAG. */
const SEAT_KEY = 'FIVEDIVE_MOD_PANEL_SEAT'
const USAGE_KEY = 'FIVEDIVE_MOD_PANEL_USAGE_FILE'

/** The heartbeat's published usage snapshot. See the header for why this and not the verb. */
const DEFAULT_USAGE_FILE = '/var/lib/5dive/pace-usage.json'

/** The built-in per-row token budget (`_HB_TASK_BUDGET_DEFAULT`, src/cmd_heartbeat.sh).
 * Shown only as the denominator when the row itself carries none; a row whose budget is
 * the literal `none` is exempt and renders as such. */
const DEFAULT_ROW_BUDGET = 150000000

/** How long a `5dive` call may take before the refresh gives up on it. A refresh runs
 * outside the draw, so a slow one costs a stale line, never a stalled terminal. */
const CLI_TIMEOUT_MS = 5000

/** Do not re-shell within this of the last refresh: `command.run` and `turn.complete`
 * can land in the same second, and the row cannot have changed twice in it. */
const MIN_REFRESH_MS = 1500

// ── the row, as the panel needs it ───────────────────────────────────────────────────

/** One row of `5dive task ls --json`, narrowed to the fields the panel reads. */
export type TaskRow = {
  ident?: unknown
  title?: unknown
  status?: unknown
  priority?: unknown
  assignee?: unknown
  gate_live?: unknown
  needs_human?: unknown
  need_type?: unknown
  verifier?: unknown
  review_mode?: unknown
  delivery_ref?: unknown
  handoff_state?: unknown
  handoff_delivered_at?: unknown
}

/** What one refresh produced; every field is a rendered STRING or undefined, because
 * "could not read it" has to survive all the way to the draw. */
export type Panel = {
  seat: string
  ident?: string
  title?: string
  status?: string
  gate?: string
  grader?: string
  burn?: string
  burnUnverified?: boolean
  /** `undefined` = nothing worth a cell; `null` = the blind meter; a string = a warning. */
  windows?: string | null
  note?: string
}

type Live = { on: true; seat: string; usageFile: string }
const OFF = { on: false } as const
type State = Live | typeof OFF

/** Resolved once per session; `null` until the first hook runs. */
let state: Promise<State> | null = null

/** The last refresh's result, which is what every draw reads. */
let panel: Panel | null = null
let lastRefreshAt = 0
let refreshing = false

/** Each of these says its thing once per session, not once per event. */
let refreshFailureLogged = false
let usageFailureLogged = false
let drawFailureLogged = false

/** The band's last `isWorking`; its edges are the turn boundary (see registerPanel). */
let working: boolean | null = null

/** The drawn row's budget, so the second subprocess is not paid on every refresh. */
let budgetCache: { ident: string | undefined; budget: string | undefined } | null = null

// ── pure helpers (no `$`): everything the test suite can grade without an engine ──────

/**
 * The seat's name from the plugin's own directory, which lives under the seat's home.
 * Identical rule to the telemetry half's, and deliberately duplicated rather than
 * imported: the host scan reads each module's source, and a shared helper that took
 * `$` could not cross a module boundary anyway. This one takes no `$`, but keeping the
 * two modules independently loadable is worth six lines.
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

/** The `env` block of a settings snapshot, which is where the gate lives. */
export function envOf(settings: unknown): Record<string, unknown> {
  const block = (settings as Record<string, unknown> | null)?.['env']
  return block !== null && typeof block === 'object'
    ? (block as Record<string, unknown>)
    : {}
}

/** A field that may be null, a number or a string, as one string — or undefined. */
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v
  if (typeof v === 'number') return String(v)
  return undefined
}

/** SQLite's booleans arrive as 0/1 and jq may hand them back as booleans. */
function truthy(v: unknown): boolean {
  return v === 1 || v === '1' || v === true
}

/**
 * WHICH row the seat is "on". A seat can hold several open rows and the panel has one
 * line, so the choice is explicit rather than "the first one `ls` printed":
 *
 *   1. a row it is actually working (`in_progress`);
 *   2. failing that, a row it has DELIVERED and not closed — on this board `task done`
 *      on a verified row leaves status `todo` with a delivery bound, and that state is
 *      exactly the one an operator most often cannot see (the maker looks idle);
 *   3. failing that, a row holding a live gate, because a gated row is why a seat is
 *      not working one;
 *   4. failing that, the first open row, which `ls` has already ordered by priority
 *      then age.
 *
 * Exported so the test suite can grade the order without an engine.
 */
export function pickRow(rows: readonly TaskRow[]): TaskRow | undefined {
  return (
    rows.find((r) => r.status === 'in_progress') ??
    rows.find((r) => str(r.delivery_ref) !== undefined) ??
    rows.find((r) => truthy(r.gate_live)) ??
    rows[0]
  )
}

/**
 * The gate cell, in the board's own vocabulary: `HUMAN:<type>` when a person owes the
 * answer, `agent:<type>` when a seat does, `none` when nothing is open.
 *
 * `ls --json` carries the two verdict booleans and the type but not the ROUTED seat's
 * name (the human-readable `gate` column that `task show` composes is not on this
 * surface). `agent:<type>` is therefore what can be said truthfully here; naming a seat
 * we did not read would be the more useful line and the wrong one.
 */
export function gateOf(row: TaskRow): string {
  if (!truthy(row.gate_live)) return 'none'
  const type = str(row.need_type) ?? 'gate'
  return truthy(row.needs_human) ? `HUMAN:${type}` : `agent:${type}`
}

/**
 * The same cell after the second subprocess, which is the only thing that can name the
 * seat a routed gate sits with: `show --json` carries `routed_reviewer`, so `ops:approval`
 * replaces the `agent:approval` that `ls` alone could say. That upgrade is ALL that is
 * taken from it.
 *
 * What is deliberately NOT taken is `show`'s own `gate` field. That field is the board's
 * VERBOSE HEADER (`_task_gate_header_sql`), a sentence written for a human reading a
 * `task show`, and it is composed for a DEAD gate as readily as a live one:
 *
 *   gate_live 0 -> `ANSWERED approve (lead:ops, 2026-09-20 19:17:24)`
 *   gate_live 1 -> `PENDING — awaiting a HUMAN (approval, tier 1, asked 2026-09-20
 *                   18:57:59) — the ask is in the 'human gate:' block below`
 *
 * The first is a gate that is OVER, and an earlier cut of this panel pasted it into the
 * cell: the first live capture on this box drew `DIVE-4694 · in_progress · gate ANSWERED
 * approve (lead:ops, 2026-09-20 19:17:24)` and nothing else — the seat name, the grader,
 * the burn and the title all pushed off a 120-column band by a gate that was not open.
 * The second is 110 characters and would do the same while one is. The board's COMPACT
 * cell is not on `--json`; the two columns that compose it are, so the panel composes it
 * and stays inside its own documented vocabulary.
 */
export function gateWithRouting(row: TaskRow, shown: unknown): string {
  const base = gateOf(row)
  if (base === 'none' || truthy(row.needs_human)) return base
  if (shown === null || typeof shown !== 'object') return base
  const seat = str((shown as Record<string, unknown>)['routed_reviewer'])
  if (seat === undefined) return base
  const type = str((shown as Record<string, unknown>)['need_type']) ?? str(row.need_type) ?? 'gate'
  return `${seat}:${type}`
}

/**
 * The verifier cell. The board keeps this in four columns and none of them alone says
 * it, so the panel composes:
 *
 *   `none`            — the row books no grader (`review_mode` none, or verify optout);
 *   `check`/`rubric`  — a command or the cheap fixed pass grades it, no seat involved;
 *   `<seat> waiting`  — a grader is bound and a delivery is with it;
 *   `<seat> bound`    — a grader is bound and nothing is delivered yet;
 *   `delivered`       — a delivery is bound and no grader seat is named (the pool
 *                       attaches one at delivery: `temp`).
 *
 * This is the field the row calls "verifier state", and it is the one an operator
 * cannot get from a pane at all.
 */
export function graderOf(row: TaskRow): string {
  const verifier = str(row.verifier)
  const mode = str(row.review_mode)
  const delivered = str(row.delivery_ref) !== undefined
  if (verifier !== undefined) return delivered ? `${verifier} waiting` : `${verifier} bound`
  if (delivered) return mode === undefined ? 'delivered' : `delivered→${mode}`
  if (mode === undefined || mode === 'none') return 'none'
  return mode
}

/** A token count as an operator reads it. Mirrors `_hb_tok_scale` in cmd_heartbeat.sh,
 * because the panel and the park message must not print one figure two ways. */
export function scaleTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  const i = Math.floor(n)
  if (i >= 1_000_000_000) return `${Math.floor(i / 1e9)}.${Math.floor((i % 1e9) / 1e8)}B`
  if (i >= 1_000_000) return `${Math.floor(i / 1e6)}.${Math.floor((i % 1e6) / 1e5)}M`
  if (i >= 1_000) return `${Math.floor(i / 1e3)}k`
  return String(i)
}

/**
 * The row's burn against its budget, out of the heartbeat's published snapshot.
 *
 * Returns `undefined` when there is no attributed figure for this row at all — absent,
 * never zero (a row that has just started genuinely has no window in the snapshot, and
 * rendering that as `0` would read as "this row is free").
 *
 * `unverified` is the DIVE-4430 distinction and it is carried, not flattened: the
 * heartbeat charges a row ONLY on `dispatched === true`, because an attributed window
 * with no `/goal` dispatch of that ident inside it is likely another row's tokens. The
 * panel shows such a figure — an operator wants to see it — marked as what it is.
 */
export function burnOf(
  snapshot: unknown,
  ident: string,
  rowBudget: string | undefined,
): { text: string; unverified: boolean } | undefined {
  if (rowBudget === 'none' || rowBudget === 'NONE') return { text: 'exempt', unverified: false }
  const data = (snapshot as { data?: unknown })?.data ?? snapshot
  const tasks = (data as { tasks?: unknown })?.tasks
  if (!Array.isArray(tasks)) return undefined
  const mine = tasks.filter(
    (t): t is Record<string, unknown> =>
      t !== null && typeof t === 'object' && (t as Record<string, unknown>)['ident'] === ident,
  )
  if (mine.length === 0) return undefined
  const verified = mine.filter((t) => t['dispatched'] === true)
  const used = verified.length > 0 ? verified : mine
  let spent = 0
  for (const t of used) {
    const q = t['quota']
    if (typeof q === 'number' && Number.isFinite(q)) spent += q
  }
  // A dollar budget belongs to the per-AGENT cost guard, not to this row's token
  // figure; reading it here would compare dollars to tokens (cmd_heartbeat.sh says so
  // in the same words). Fall back to the built-in default, which is what the sweep
  // itself does for a row with no budget of its own.
  const explicit = rowBudget !== undefined && /^[1-9][0-9]*$/.test(rowBudget)
  const budget = explicit ? Number(rowBudget) : DEFAULT_ROW_BUDGET
  const suffix = explicit ? '' : '*'
  return {
    text: `${scaleTokens(spent)}/${scaleTokens(budget)}${suffix}`,
    unverified: verified.length === 0,
  }
}

/**
 * The account cell, from `$.session.usage().rateLimits` — and only when it says
 * something the status line below does not (see the header note on DIVE-4665).
 *
 * `undefined`  — every window read fine and none is near its wall. The figures are on
 *                the status line; repeating them here would cost a cell and add nothing.
 * `5h 92%!`    — at least one window is at or past ACCT_WARN_PCT. Only those are named.
 * `null`       — NO window has a reading at all: the blind meter, which renders on the
 *                status line as absence and is indistinguishable there from "off".
 */
export function windowsOf(limits: unknown): string | null | undefined {
  if (!Array.isArray(limits)) return null
  const label: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
  const hot: string[] = []
  let readings = 0
  for (const l of limits) {
    if (l === null || typeof l !== 'object') continue
    const r = l as Record<string, unknown>
    const kind = typeof r['kind'] === 'string' ? (r['kind'] as string) : ''
    const pct = r['percentUsed']
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue
    readings += 1
    if (pct >= ACCT_WARN_PCT) hot.push(`${label[kind] ?? kind} ${Math.round(pct)}%!`)
  }
  if (readings === 0) return null
  return hot.length > 0 ? hot.join(' · ') : undefined
}

/** The title, cut to fit whatever the band is wide, with an ellipsis that is one cell. */
export function clip(text: string, max: number): string {
  if (max <= 1) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// ── the `$` half ─────────────────────────────────────────────────────────────────────

/**
 * Decides once whether this session draws. Every failure answers OFF. Declared at the
 * top level because it takes `$` (see the HOST RULE note at the top of the file).
 */
async function resolveState($: EngineInterface): Promise<State> {
  try {
    const vars = envOf(await $.settings.read())
    if (String(vars[FLAG] ?? '') !== '1') return OFF
    const seat = String(vars[SEAT_KEY] ?? '') || seatFromRoot($.plugin.root)
    if (seat === null || seat === '') {
      $.ui.log(
        `5dive panel off: cannot name this seat from ${$.plugin.root}; set ${SEAT_KEY} ` +
          `in the seat's settings to draw anyway.`,
        { to: 'debug' },
      )
      return OFF
    }
    return {
      on: true,
      seat,
      usageFile: String(vars[USAGE_KEY] ?? '') || DEFAULT_USAGE_FILE,
    }
  } catch (err) {
    try {
      $.ui.log(
        `5dive panel disabled: this Claude Code build refused a call the panel needs ` +
          `(verified against ${VERIFIED_AGAINST}): ${String(err)}. The band is untouched.`,
        { to: 'debug' },
      )
    } catch {}
    return OFF
  }
}

/**
 * One `5dive` call, parsed. Answers `undefined` on any failure — a non-zero exit, an
 * unparseable body, an `{ok:false}` envelope — because every one of them means the same
 * thing to the panel: this cell has no reading, and a cell with no reading draws `—`.
 */
async function cliJson($: EngineInterface, argv: readonly string[]): Promise<unknown> {
  try {
    const r = await $.process.run(argv, { timeoutMs: CLI_TIMEOUT_MS })
    if (r.exitCode !== 0) return undefined
    const parsed = JSON.parse(r.stdout) as { ok?: unknown; data?: unknown }
    if (parsed?.ok !== true) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

/**
 * Fills the cache the draw reads. Runs OUTSIDE any draw, never awaited by the hook that
 * triggers it, and repaints through `$.ui.invalidate` when it lands.
 *
 * It shells out exactly once in the common case (`task ls`), twice only when the chosen
 * row holds a live gate or needs its own budget read (`task show --no-body`) — the
 * refresh cost is on the row's PR, measured, not asserted.
 */
async function refresh($: EngineInterface): Promise<void> {
  if (refreshing) return
  const now = Date.now()
  if (now - lastRefreshAt < MIN_REFRESH_MS) return
  refreshing = true
  lastRefreshAt = now
  try {
    const s = await (state ??= resolveState($))
    if (!s.on) return

    const next: Panel = { seat: s.seat }

    const lsData = await cliJson($, ['5dive', 'task', 'ls', `--assignee=${s.seat}`, '--json'])
    const rows = (lsData as { tasks?: unknown })?.tasks
    const row = Array.isArray(rows) ? pickRow(rows as TaskRow[]) : undefined

    if (row === undefined) {
      next.note = Array.isArray(rows) ? 'no open row' : 'row ?'
    } else {
      next.ident = str(row.ident)
      next.title = str(row.title)
      next.status = str(row.status)
      next.gate = gateOf(row)
      next.grader = graderOf(row)

      // `ls --json` carries neither `task_budget` nor the composed gate header; `show`
      // carries both. It is a SECOND subprocess, so it is not run on every refresh:
      // measured on this box, `task ls` and `task show` are ~0.6 s of CPU each, and the
      // refresh fires twice a turn. The budget of a row changes only when somebody runs
      // `task set-budget`, and the header only matters while a gate is live — so the
      // call is made when the drawn row CHANGES, and on any refresh where the row holds
      // a live gate. Steady state is one subprocess per refresh.
      const cached = budgetCache
      let budget: string | undefined =
        cached !== null && cached.ident === next.ident ? cached.budget : undefined
      const needShow =
        next.ident !== undefined &&
        (cached === null || cached.ident !== next.ident || truthy(row.gate_live))
      if (needShow && next.ident !== undefined) {
        const showData = await cliJson($, [
          '5dive', 'task', 'show', next.ident, '--json', '--no-body',
        ])
        const t = (showData as { task?: unknown })?.task
        if (t !== null && typeof t === 'object') {
          budget = str((t as Record<string, unknown>)['task_budget'])
          budgetCache = { ident: next.ident, budget }
          // `show` names the ROUTED seat where `ls` can only say "an agent". That, and
          // nothing else from it, reaches the cell — see gateWithRouting for what the
          // `gate` field on that payload actually is and what pasting it drew.
          next.gate = gateWithRouting(row, t)
        }
      }

      if (next.ident !== undefined) {
        try {
          const snap = JSON.parse(await $.fs.read(s.usageFile)) as unknown
          const b = burnOf(snap, next.ident, budget)
          if (b !== undefined) {
            next.burn = b.text
            next.burnUnverified = b.unverified
          }
        } catch (err) {
          if (!usageFailureLogged) {
            usageFailureLogged = true
            try {
              $.ui.log(
                `5dive panel: could not read the heartbeat's usage snapshot at ` +
                  `${s.usageFile}: ${String(err)}. The burn cell reads "—" (absent, ` +
                  `never zero) until it can.`,
                { to: 'debug' },
              )
            } catch {}
          }
        }
      }
    }

    // The account's windows come from the harness, not from a file: it is the process
    // that owns the meter, and it is fresher than any snapshot on disk.
    try {
      next.windows = windowsOf((await $.session.usage()).rateLimits)
    } catch {
      next.windows = null
      // Absent, not zero. The one-line tell for this call already lives in the
      // telemetry half; a second copy per session would be noise.
    }

    panel = next
    $.ui.invalidate('ui.render')
  } catch (err) {
    if (!refreshFailureLogged) {
      refreshFailureLogged = true
      try {
        $.ui.log(
          `5dive panel: a refresh failed (verified against ${VERIFIED_AGAINST}): ` +
            `${String(err)}. The band keeps whatever it last drew.`,
          { to: 'debug' },
        )
      } catch {}
    }
  } finally {
    refreshing = false
  }
}

/**
 * Fire-and-forget. A hook calls this AFTER `next(e)` has resolved and does not await it:
 * the panel must never be able to delay a turn, a command or a session, and `refresh`
 * swallows everything it can throw.
 */
function kick($: EngineInterface): void {
  void refresh($)
}

/**
 * At or past this, an account window is worth a cell of its own even though the status
 * line below already prints the figure: it is the band where a seat is about to stop.
 */
const ACCT_WARN_PCT = 80

/** How many cells the engine's own collapse affordance (`[-]`) takes at the right. */
const AFFORDANCE = 4

/** The separator drawn between cells. */
const SEP = ' · '

/**
 * The band's cells, as `[tone, text]`, ALREADY NARROWED TO FIT `columns`.
 *
 * Fitting is done here and not left to the layout, because the layout's answer is the
 * wrong one: a flex row of Texts that overflows shrinks EVERY child, so the first draw
 * of this panel came out as `5dive d… ·DIVE-46… · in_progr… · gate no… ·grader te…` —
 * eight truncated words, none of them readable, on a 150-column terminal with room for
 * six whole ones. A panel that degrades by making every field unreadable is worse than
 * one that degrades by dropping fields, so the cells are chosen to fit and the ones
 * that do are drawn whole.
 *
 * The order the tail is dropped in IS the priority order, and it is a judgement: the
 * row's identity and whether a person owes it an answer survive to the narrowest
 * terminal; the title is the first thing to go, because it is the one field an operator
 * can get from anywhere else.
 */
export function cellsOf(p: Panel | null, columns: number): readonly (readonly [string, string])[] {
  if (p === null) return []
  const head: (readonly [string, string])[] = [['dim', `5dive ${p.seat}`]]
  if (p.ident === undefined) {
    head.push(['dim', p.note ?? 'row ?'])
    return head
  }
  const gate = p.gate ?? 'none'
  head.push(['cyan', p.ident])
  head.push(['plain', p.status ?? '?'])
  head.push([gate === 'none' ? 'dim' : gate.startsWith('HUMAN') ? 'red' : 'yellow', `gate ${gate}`])

  const tail: (readonly [string, string])[] = [
    ['dim', `grader ${p.grader ?? '?'}`],
    [
      p.burnUnverified === true ? 'yellow' : 'dim',
      `burn ${p.burn === undefined ? '—' : p.burnUnverified === true ? `~${p.burn} unverified` : p.burn}`,
    ],
  ]
  // The account cell exists only when it says something the status line cannot.
  if (p.windows === null) tail.push(['yellow', 'acct —'])
  else if (p.windows !== undefined) tail.push(['red', `acct ${p.windows}`])
  if (p.title !== undefined) tail.push(['dim', p.title])

  const room = columns - AFFORDANCE
  const width = (cs: readonly (readonly [string, string])[]): number =>
    cs.reduce((n, [, t]) => n + t.length, 0) + Math.max(0, cs.length - 1) * SEP.length

  // Drop from the tail until the line fits whole.
  let n = tail.length
  while (n > 0 && width([...head, ...tail.slice(0, n)]) > room) n -= 1
  const kept = [...head, ...tail.slice(0, n)]

  // The title is the one cell worth keeping in clipped form: at n === tail.length it is
  // the last kept cell, and a half-title is still orientation. Everything else is
  // present or absent, never a stub.
  if (n === tail.length - 1 && p.title !== undefined) {
    const left = room - width(kept) - SEP.length
    if (left >= 12) kept.push(['dim', clip(p.title, left)])
  }

  if (width(kept) <= room) return kept

  // A band too narrow even for the head. The head is NOT clipped cell by cell — that is
  // the mush again — it is given up a cell at a time, in reverse priority, down to the
  // row's ident alone, which is the one thing a panel with no room is still for. Only
  // that last survivor is ever clipped.
  const fallbacks: (readonly (readonly [string, string])[])[] = [
    [head[0]!, head[1]!, head[2]!, head[3]!],
    [head[1]!, head[2]!, head[3]!],
    [head[1]!, head[3]!],
    [head[1]!],
  ]
  for (const f of fallbacks) {
    if (width(f) <= room) return f
  }
  const ident = head[1]!
  const only = clip(ident[1], room)
  return only === '' ? [] : [[ident[0], only]]
}

/**
 * The panel's hooks, registered from the plugin's one hooks module (register.ts).
 *
 * It is a separate FILE and not a separate MODULE on purpose: `hooks.json` takes
 * exactly one `modules` entry per plugin — `claude plugin validate` refuses a second —
 * while a module may import any .ts file inside the plugin, and the engine's scan reads
 * those imports too. So the telemetry producer and the panel stay in their own files,
 * with their own state and their own flag, and register.ts calls both.
 */
/**
 * The panel's hooks, registered from the plugin's one hooks module (register.ts).
 *
 * It is a separate FILE and not a separate MODULE on purpose: `hooks.json` takes
 * exactly one `modules` entry per plugin — `claude plugin validate` refuses a second —
 * while a module may import any .ts file inside the plugin, and the engine's scan reads
 * those imports too. So the telemetry producer and the panel keep their own files,
 * their own state and their own flag, and register.ts calls both.
 *
 * ONE HOOK, and the refresh rides the band's own props. The row asked for a refresh on
 * the session and turn boundaries "and not on a timer", and the first shape of this
 * file hooked `session.start` / `command.run` / `turn.complete` for it. That shape is
 * REFUSED, and the refusal is the useful part: `claude plugin validate` rejects a
 * second registration of an event the plugin already hooks without a matcher, and the
 * telemetry half owns all three. It turned out not to be a constraint worth working
 * around, because the band already carries the boundary: `AbovePrompt.props.isWorking`
 * is true exactly while a model turn runs, and the engine re-renders the band when it
 * flips. Watching that edge IS the turn boundary, delivered by the surface, with no
 * second hook, no matcher and no clock — and a plugin-load draw covers the session
 * start. `$.clock` is deliberately never touched in this file.
 */
export const registerPanel = (on: On): void => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawn = await next(e)
    try {
      const s = await (state ??= resolveState($))
      if (!s.on) return drawn

      // A survey owns the band while it is up; a hook yields to it rather than fighting
      // for the rows. The panel returns on its own at the next draw.
      if (e.props.hasSurvey) return drawn

      // The turn boundary, for free: this is the edge `turn.start`/`turn.complete` would
      // have given, minus the hook. A refresh at the FALLING edge (a turn just ended) is
      // the one that matters — the row's status, gate and burn are what the turn changed
      // — and the rising edge is cheap and keeps a long turn's panel from going stale.
      if (working !== e.props.isWorking) {
        working = e.props.isWorking
        kick($)
      } else if (panel === null) {
        // The first draw happens before any refresh has landed.
        kick($)
      }

      if (panel === null) return drawn
      const { Box, Text } = $.ui.resolve(e)
      const cells = cellsOf(panel, e.props.bodyColumns)
      if (cells.length === 0) return drawn
      const children: RenderElement[] = []
      for (const [tone, text] of cells) {
        if (children.length > 0) children.push(Text({ dimColor: true, children: ' · ' }))
        children.push(
          Text({
            ...(tone === 'dim' ? { dimColor: true } : {}),
            ...(tone === 'cyan' || tone === 'red' || tone === 'yellow' ? { color: tone } : {}),
            ...(tone === 'red' || tone === 'yellow' ? { bold: true } : {}),
            wrap: 'truncate-end',
            children: text,
          }),
        )
      }
      return Box({ flexDirection: 'row', children })
    } catch (err) {
      // A draw that throws is a band the engine redraws without us: say it once, and
      // carry on drawing nothing.
      if (!drawFailureLogged) {
        drawFailureLogged = true
        try {
          $.ui.log(
            `5dive panel: the band draw failed (verified against ${VERIFIED_AGAINST}): ` +
              `${String(err)}. The band is drawn as it would be with no mod.`,
            { to: 'debug' },
          )
        } catch {}
      }
      return drawn
    }
  })
}

/** Narrowing aid for the render hook's event; exported for the test suite. */
export type BandEvent = RenderInputOf<'AbovePrompt', 'terminal'>

/** The plugin version this module was built at, asserted against plugin.json in tests. */
export const PANEL_VERSION = VERSION
