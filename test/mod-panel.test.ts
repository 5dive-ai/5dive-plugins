// Static + pure-function suite for the `mod` plugin's above-prompt seat panel
// (DIVE-4694). The companion of test/mod-telemetry.test.ts, and the same reasoning
// about what CI can own applies: the hooks only run inside a real Claude Code process
// with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS set, so the end-to-end evidence (a session
// drawing the band, at two widths) is the pane capture on the row and the command in
// the plugin's README. What CI CAN own is everything decidable from the source, plus
// every pure cell-builder — and the cell builders are where this panel's bugs live,
// because each one turns four nullable columns into one word an operator will believe.
//
// The three classes this file guards, each one a bug that was actually written:
//
//   1. THE LAYOUT DEGRADING INTO MUSH. The first draw was a flex row of Texts with
//      `wrap: truncate-end` and no width discipline, so an overflow shrank every child
//      at once: `5dive d… ·DIVE-46… · in_progr… · gate no… ·grader te…`. Eight
//      truncated words on a terminal with room for six whole ones. `cellsOf` now fits
//      the line itself, and `fits` below is the assertion that it does.
//   2. ABSENT RENDERED AS ZERO. A row with no attributed usage window must draw `—`,
//      not `0`; a figure the dispatch cross-check did not verify must draw with its
//      `~ … unverified` tell and not as the row's own. This is DIVE-3343/DIVE-4430's
//      whole decision record expressed as three assertions.
//   3. THE HOOK GROWING A WAY TO AFFECT THE SESSION. Same class the telemetry suite
//      guards: an early return, a `deny`, a rewritten `e`. A panel that can fail a
//      draw is a panel that can take the composer down with it.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  burnOf,
  cellsOf,
  clip,
  envOf,
  gateOf,
  graderOf,
  pickRow,
  scaleTokens,
  seatFromRoot,
  windowsOf,
  PANEL_VERSION,
  type Panel,
  type TaskRow,
} from '../plugins/mod/hooks/panel'

const ROOT = join(import.meta.dir, '..', 'plugins', 'mod')
const SRC = readFileSync(join(ROOT, 'hooks', 'panel.ts'), 'utf8')
/**
 * The module with its comments removed. Every "does the source do X?" assertion reads
 * THIS and not SRC: the first version of this file asserted `SRC` does not contain
 * `$.clock`, and went red on the module's own sentence saying it deliberately never
 * touches `$.clock`. A prose mention is not a call, and a guard that cannot tell them
 * apart makes the file unwritable rather than the module safe.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const REGISTER = readFileSync(join(ROOT, 'hooks', 'register.ts'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
const HOOKS_JSON = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))

/** The joined width `cellsOf` promises to keep inside. Mirrors the module's own. */
const AFFORDANCE = 4
const width = (cells: readonly (readonly [string, string])[]): number =>
  cells.reduce((n, [, t]) => n + t.length, 0) + Math.max(0, cells.length - 1) * 3

const ROW: TaskRow = {
  ident: 'DIVE-4694',
  title: 'Function-hook mod: above-prompt seat panel (row, gate, budget burn, verifier state)',
  status: 'in_progress',
  assignee: 'dev',
  gate_live: 0,
  needs_human: 0,
  review_mode: 'temp',
}

const PANEL: Panel = {
  seat: 'dev',
  ident: 'DIVE-4694',
  title: ROW.title as string,
  status: 'in_progress',
  gate: 'none',
  grader: 'temp',
  burn: '9.7M/150.0M*',
}

describe('mod panel: the module stays wired to the one module hooks.json admits', () => {
  test('hooks.json still names exactly one module, and register.ts calls the panel', () => {
    // `claude plugin validate` refuses a second "modules" entry, which is why the panel
    // is a FILE imported by register.ts rather than a module of its own. If a later
    // change splits them, this fails before a session silently loads half the plugin.
    expect(HOOKS_JSON.modules).toEqual(['./register.ts'])
    expect(REGISTER).toContain("import { registerPanel } from './panel'")
    expect(REGISTER).toContain('registerPanel(on)')
  })

  test('the version in the source matches the manifest', () => {
    expect(PANEL_VERSION).toBe(MANIFEST.version)
  })

  test('the panel registers ui.render and nothing else', () => {
    // The engine refuses a second unmatched registration of an event the plugin already
    // hooks, and the telemetry half owns session.start / turn.complete / command.run.
    // The panel takes its turn boundary off the band's own isWorking prop instead.
    const events = [...CODE.matchAll(/^\s*on\(\s*'([^']+)'/gm)].map((m) => m[1])
    expect(events).toEqual(['ui.render'])
    expect(CODE).toContain('isWorking')
  })

  test('the panel never touches the clock', () => {
    // "refresh on the session and turn boundaries, not on a timer" (DIVE-4694).
    expect(CODE).not.toContain('$.clock')
    expect(CODE).not.toContain('setInterval')
    expect(CODE).not.toContain('setTimeout')
  })
})

describe('mod panel: the draw cannot affect the session', () => {
  test('the render hook awaits next(e) first and never rewrites e', () => {
    expect(CODE).toContain('const drawn = await next(e)')
    // A rewrite would be `next({ ...e`; the panel only ever passes `e` through.
    expect(CODE).not.toMatch(/next\(\s*\{/)
    expect(CODE).not.toContain('deny')
  })

  test('every early return from the render hook returns the chain result', () => {
    const body = CODE.slice(CODE.indexOf("on('ui.render'"))
    // `return <name>` on its own line — `return Box(...)` is a call, not a pass-through,
    // and is asserted separately below.
    const returns = [...body.matchAll(/^\s{4,}return (\w+)\s*$/gm)].map((m) => m[1])
    // `drawn` (pass through) or the Box it built. Nothing else may be returned.
    expect(new Set(returns)).toEqual(new Set(['drawn']))
    expect(body).toContain('return Box(')
  })

  test('no subprocess is spawned inside a draw', () => {
    // A draw runs on every width change; a draw that shells out is a stalled terminal.
    const body = CODE.slice(CODE.indexOf("on('ui.render'"))
    expect(body).not.toContain('$.process.run')
    expect(body).not.toContain('$.fs.read')
  })
})

describe('mod panel: which row the seat is "on"', () => {
  test('an in_progress row beats a delivered one and a gated one', () => {
    const rows: TaskRow[] = [
      { ident: 'A', status: 'todo', gate_live: 1 },
      { ident: 'B', status: 'todo', delivery_ref: 'https://…/1' },
      { ident: 'C', status: 'in_progress' },
    ]
    expect(pickRow(rows)?.ident).toBe('C')
  })

  test('a delivered row beats a gated one — the maker looks idle and is not', () => {
    const rows: TaskRow[] = [
      { ident: 'A', status: 'todo', gate_live: 1 },
      { ident: 'B', status: 'todo', delivery_ref: 'https://…/1' },
    ]
    expect(pickRow(rows)?.ident).toBe('B')
  })

  test('with nothing else, the first row ls ordered by priority then age', () => {
    expect(pickRow([{ ident: 'A' }, { ident: 'B' }])?.ident).toBe('A')
    expect(pickRow([])).toBeUndefined()
  })
})

describe('mod panel: the gate cell', () => {
  test('no live gate reads none, whatever the stale need_type says', () => {
    expect(gateOf({ gate_live: 0, need_type: 'decision' })).toBe('none')
  })

  test('a human gate is named as one', () => {
    expect(gateOf({ gate_live: 1, needs_human: 1, need_type: 'approval' })).toBe('HUMAN:approval')
  })

  test('an agent gate says agent, not a seat we did not read', () => {
    // `ls --json` does not carry the routed seat. Naming one would be the more useful
    // line and the wrong one; `show` supplies the exact header when a gate is live.
    expect(gateOf({ gate_live: 1, needs_human: 0, need_type: 'decision' })).toBe('agent:decision')
  })
})

describe('mod panel: the verifier cell', () => {
  test('a bound grader with a delivery is waiting on it', () => {
    expect(graderOf({ verifier: 'quinn', delivery_ref: 'https://…/1' })).toBe('quinn waiting')
  })
  test('a bound grader with nothing delivered is merely bound', () => {
    expect(graderOf({ verifier: 'quinn' })).toBe('quinn bound')
  })
  test('a delivery with no grader seat names the mode the pool will draw from', () => {
    expect(graderOf({ delivery_ref: 'https://…/1', review_mode: 'temp' })).toBe('delivered→temp')
  })
  test('a row that books nobody says none', () => {
    expect(graderOf({ review_mode: 'none' })).toBe('none')
    expect(graderOf({})).toBe('none')
  })
  test('a command-graded row names the command mode', () => {
    expect(graderOf({ review_mode: 'check' })).toBe('check')
  })
})

describe('mod panel: burn is absent, never zero', () => {
  const snap = {
    data: {
      tasks: [
        { ident: 'DIVE-4694', quota: 9700000, dispatched: true },
        { ident: 'DIVE-0001', quota: 5, dispatched: true },
      ],
    },
  }

  test('a row with no attributed window answers undefined, not 0', () => {
    // THE bug this whole file exists to stop: a row that has just started has no window
    // in the snapshot, and `0/150.0M` reads as "this row is free".
    expect(burnOf(snap, 'DIVE-9999', undefined)).toBeUndefined()
  })

  test('a verified figure is the row’s own and carries no tell', () => {
    expect(burnOf(snap, 'DIVE-4694', undefined)).toEqual({ text: '9.7M/150.0M*', unverified: false })
  })

  test('the * says the denominator is the box default, not the row’s own budget', () => {
    expect(burnOf(snap, 'DIVE-4694', '20000000')).toEqual({ text: '9.7M/20.0M', unverified: false })
  })

  test('an UNVERIFIED figure is shown and marked, never charged silently', () => {
    // DIVE-4430: the heartbeat parks only on dispatched === true, because an attributed
    // window with no /goal dispatch of that ident inside it is likely another row's
    // tokens. The panel shows it — an operator wants to see it — as what it is.
    const u = { data: { tasks: [{ ident: 'X', quota: 3_000_000, dispatched: false }] } }
    expect(burnOf(u, 'X', undefined)).toEqual({ text: '3.0M/150.0M*', unverified: true })
  })

  test('a row exempted with the literal `none` says so instead of showing a ratio', () => {
    expect(burnOf(snap, 'DIVE-4694', 'none')).toEqual({ text: 'exempt', unverified: false })
  })

  test('a dollar budget is not read as tokens', () => {
    // cmd_heartbeat.sh skips these for the same reason: reading $ as tokens compares
    // dollars to tokens. The panel falls back to the token default and marks it *.
    expect(burnOf(snap, 'DIVE-4694', '$40')?.text).toBe('9.7M/150.0M*')
  })

  test('an unreadable snapshot answers undefined rather than throwing', () => {
    expect(burnOf(null, 'X', undefined)).toBeUndefined()
    expect(burnOf({ data: {} }, 'X', undefined)).toBeUndefined()
    expect(burnOf({ data: { tasks: 'nope' } }, 'X', undefined)).toBeUndefined()
  })

  test('the scale matches _hb_tok_scale, so the panel and the park print one figure one way', () => {
    expect(scaleTokens(0)).toBe('0')
    expect(scaleTokens(999)).toBe('999')
    expect(scaleTokens(1500)).toBe('1k')
    expect(scaleTokens(9_700_000)).toBe('9.7M')
    expect(scaleTokens(150_000_000)).toBe('150.0M')
    expect(scaleTokens(1_250_000_000)).toBe('1.2B')
  })
})

describe('mod panel: the account cell says only what the status line cannot', () => {
  // DIVE-4665 already prints 5h/7d on the status line one row below. Repeating the
  // figures here is the duplication DIVE-4694's SIBLING clause forbids, so the cell
  // exists only for the two states the status line renders as plain absence.
  test('healthy windows produce NO cell at all', () => {
    expect(
      windowsOf([
        { kind: 'five_hour', percentUsed: 26 },
        { kind: 'seven_day', percentUsed: 25.4 },
      ]),
    ).toBeUndefined()
    expect(cellsOf(PANEL, 200).some(([, t]) => t.startsWith('acct'))).toBe(false)
  })

  test('a window at or past the warn band names itself, and only itself', () => {
    expect(
      windowsOf([
        { kind: 'five_hour', percentUsed: 92 },
        { kind: 'seven_day', percentUsed: 25 },
      ]),
    ).toBe('5h 92%!')
    expect(windowsOf([{ kind: 'five_hour', percentUsed: 80 }])).toBe('5h 80%!')
    expect(windowsOf([{ kind: 'five_hour', percentUsed: 79.4 }])).toBeUndefined()
    const cells = cellsOf({ ...PANEL, windows: '5h 92%!' }, 200)
    expect(cells.find(([, t]) => t.startsWith('acct'))).toEqual(['red', 'acct 5h 92%!'])
  })

  test('a blind meter answers null, and the cell says so out loud', () => {
    // This is the state the pacing floor holds rows on, and the one the status line
    // cannot express: no reading looks exactly like the field being switched off.
    expect(windowsOf([])).toBeNull()
    expect(windowsOf(undefined)).toBeNull()
    expect(windowsOf([{ kind: 'five_hour' }])).toBeNull()
    const cells = cellsOf({ ...PANEL, windows: null }, 200)
    expect(cells.find(([, t]) => t.startsWith('acct'))).toEqual(['yellow', 'acct —'])
  })
})

describe('mod panel: the line fits, and degrades by dropping fields', () => {
  const fits = (columns: number) => {
    const cells = cellsOf(PANEL, columns)
    expect(width(cells)).toBeLessThanOrEqual(columns - AFFORDANCE)
    return cells.map(([, t]) => t)
  }

  test('at every width from 20 to 220 the joined line fits the band', () => {
    // The mush bug, as a property: no width may produce a line the layout has to shrink.
    for (let c = 20; c <= 220; c += 1) fits(c)
  })

  test('a wide band carries every field including the title', () => {
    const texts = fits(200)
    expect(texts[0]).toBe('5dive dev')
    expect(texts).toContain('DIVE-4694')
    expect(texts).toContain('in_progress')
    expect(texts).toContain('gate none')
    expect(texts).toContain('grader temp')
    expect(texts).toContain('burn 9.7M/150.0M*')
    expect(texts[texts.length - 1]).toContain('Function-hook mod')
  })

  test('the title is the first field dropped, the identity the last', () => {
    const narrow = fits(70)
    expect(narrow.some((t) => t.includes('Function-hook mod'))).toBe(false)
    expect(narrow).toContain('DIVE-4694')
    expect(narrow).toContain('gate none')
  })

  test('the fields drop in priority order as the band narrows', () => {
    const seen = (c: number, needle: string) => fits(c).some((t) => t.startsWith(needle))
    expect(seen(200, 'grader')).toBe(true)
    expect(seen(48, 'grader')).toBe(false)
    // A blind meter is the LAST thing dropped before the head, ahead of the title.
    const blind = (c: number) =>
      cellsOf({ ...PANEL, windows: null }, c).some(([, t]) => t === 'acct —')
    expect(blind(200)).toBe(true)
    // The row's identity survives to the narrowest band the loop covers.
    for (let c = 20; c <= 220; c += 1) {
      expect(cellsOf(PANEL, c).some(([, t]) => t === 'DIVE-4694' || t.startsWith('DIVE'))).toBe(true)
    }
  })

  test('a human gate is drawn red and bold; nothing else is', () => {
    const tones = cellsOf({ ...PANEL, gate: 'HUMAN:approval' }, 200)
    expect(tones.find(([, t]) => t.startsWith('gate'))?.[0]).toBe('red')
    expect(cellsOf({ ...PANEL, gate: 'quinn:decision' }, 200).find(([, t]) => t.startsWith('gate'))?.[0])
      .toBe('yellow')
    expect(cellsOf(PANEL, 200).find(([, t]) => t.startsWith('gate'))?.[0]).toBe('dim')
  })

  test('an unverified burn is drawn with its tell, in the colour that earns a look', () => {
    const cells = cellsOf({ ...PANEL, burn: '3.0M/150.0M*', burnUnverified: true }, 200)
    const burn = cells.find(([, t]) => t.startsWith('burn'))
    expect(burn?.[1]).toBe('burn ~3.0M/150.0M* unverified')
    expect(burn?.[0]).toBe('yellow')
  })

  test('a seat with no open row says so rather than drawing an empty skeleton', () => {
    expect(cellsOf({ seat: 'dev', note: 'no open row' }, 200).map(([, t]) => t)).toEqual([
      '5dive dev',
      'no open row',
    ])
  })

  test('nothing read yet draws nothing at all', () => {
    expect(cellsOf(null, 200)).toEqual([])
  })
})

describe('mod panel: the gates and the seat name', () => {
  test('the seat comes off the plugin root, and an unknown root answers null', () => {
    expect(seatFromRoot('/home/agent-dev/.claude/plugins/mod')).toBe('dev')
    expect(seatFromRoot('/home/claude/.claude/plugins/mod')).toBe('claude')
    expect(seatFromRoot('/opt/mod')).toBeNull()
    expect(seatFromRoot('/home/agent-/x')).toBeNull()
  })

  test('the flag is read out of the settings env block and defaults off', () => {
    expect(envOf({ env: { FIVEDIVE_MOD_PANEL: '1' } })['FIVEDIVE_MOD_PANEL']).toBe('1')
    expect(envOf({})['FIVEDIVE_MOD_PANEL']).toBeUndefined()
    expect(envOf(null)['FIVEDIVE_MOD_PANEL']).toBeUndefined()
    // The check is an exact "1": a truthiness test would turn "0" and "false" on.
    expect(CODE).toContain(`String(vars[FLAG] ?? '') !== '1'`)
  })

  test('clip never returns more than it was given room for', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 10)).toBe('abc')
    expect(clip('abc', 1)).toBe('')
  })
})
