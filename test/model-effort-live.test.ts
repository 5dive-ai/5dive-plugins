// /model and /effort switch the RUNNING session — they no longer restart it.
//
// THE DEFECT. Both commands patched settings.json and then fired
// `sudo -n 5dive agent _self_restart`, which bounced the seat's unit ~1s later.
// Whatever turn was in flight died with it: a tool call was killed, its results
// were never written, and the human saw only "Claude is restarting to apply it".
// The restart existed because an older Claude Code answered `/model` with an
// interactive "Switch model?" picker this bridge could not reliably drive — a
// note server.ts still carried. `/model <id>` and `/effort <level>` now take the
// argument directly, apply it live and persist it, so the restart bought nothing.
//
// WHAT IS GRADED, AND WHY IT IS SPLIT IN TWO. server.ts long-polls Telegram on
// import, so no test can import it (see test/model-aliases.test.ts, which says
// the same). The repo's settled answer is a pure module plus a source-text arm
// on the wiring, which is what autoattach.ts / commands.ts / banner.ts all do:
//
//   * the DECISION — which of three outcomes a pane poll means, and the words
//     the human reads for each — is plugins/telegram/liveswitch.ts, imported
//     and exercised directly here.
//   * the WIRING — that applyModel/applyEffort actually send the line and no
//     longer reach _self_restart — is graded as text, with a MUTANT arm that
//     puts the restart hook back and requires the wiring arms to go red.
//
// THREE OUTCOMES, NOT TWO, is the part worth keeping. A line typed while a turn
// is running is QUEUED by the TUI, not lost — so "queued" is a correct result
// the human needs different words for, never a failure.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { patchSettingsFile } from '../plugins/telegram/settingsfile'
import { MODEL_ALIASES } from '../plugins/telegram/commands'
import {
  switchLine, paneConfirms, classifySwitch, switchAck, switchPending,
  SWITCH_POLL_MS, SWITCH_POLL_STEP_MS, SWITCH_MENU_RE,
} from '../plugins/telegram/liveswitch'

const SERVER = join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts')
const src = () => readFileSync(SERVER, 'utf8')

/** The body of one function, from its `function <name>(` to the next column-0 `}`. */
function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

// ------------------------------------------------------------------ fixtures
// Every string below is a VERBATIM `tmux capture-pane -p` slice from Claude
// Code 2.1.278, taken on 2026-09-20 by typing these lines into a live pane.
// The two this file used to carry for /model were written from memory —
// `  ⎿ Set model to claude-sonnet-5` — and the TUI has never printed that. A
// fixture invented from the argument you sent cannot catch a check that looks
// for the wrong thing, because it contains whatever you looked for. These are
// the pane's own bytes; the model half of paneConfirms is red against them
// unless it narrows on what the human typed.

/** `/model opus` at an idle prompt: the transcript keeps the echo, and the
 *  acknowledgement names the model by DISPLAY NAME. Re-running it when Opus 5
 *  is already the active model prints this same line — 2.1.278 has no separate
 *  "Kept model as" wording, so there is no second fixture for that case. */
const MODEL_DONE = [
  '❯ /model opus',
  '  ⎿  Set model to Opus 5 and saved as your default for new sessions',
  '                                                             ◉ xhigh · /effort',
].join('\n')

/** THE CASE THE CHANGE EXISTS FOR. Sent mid-turn, there is no echo and no
 *  transcript entry — only this toast on the line above the composer, for about
 *  five seconds. Captured while the pane was streaming a numbered list; the
 *  status line flipped to Sonnet 5 at the same moment, so the switch was
 *  already live in the running session. */
const MODEL_TOAST = [
  '  270',
  '  271',
  '              Set model to Sonnet 5 and saved as your default for new sessions',
].join('\n')

/** The cache-invalidation menu, idle pane, conversation already cached. It
 *  replaces the composer and the status line, so a pane showing it has NOT
 *  switched anything yet. */
const MODEL_MENU = [
  '✻ Cooked for 9s · done 8:09 AM',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Switch model?',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current model. Switching to Opus 5',
  '   means the full history gets re-read on your next message.',
  '',
  '   ❯ 1. Yes, switch to Opus 5',
  '     2. No, go back',
].join('\n')

/** /effort raises the same menu under the same conditions — measured, not
 *  assumed, which is why SWITCH_MENU_RE covers both headings. */
const EFFORT_MENU = [
  '   Change effort level?',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current effort level. Switching to',
  '   medium means the full history gets re-read on your next message.',
  '',
  '   ❯ 1. Yes, switch to medium',
  '     2. No, go back',
].join('\n')

/** A pane that has just answered an /effort switch. The level is on the phrase
 *  line; what follows the colon is a description that wraps onto the next line
 *  and happens to name two other models — which is why the model half must not
 *  read this as an answer to anything. */
const EFFORT_DONE = [
  '❯ /effort xhigh',
  '  ⎿  Set effort level to xhigh (saved as your default for new sessions): Deeper',
  '     reasoning than high, just below maximum (Fable 5, Opus 4.7+, Sonnet 5)',
].join('\n')

/** TWO MEASURED CAPTURES SPLICED, and the only fixture here that is: an
 *  acknowledgement from the PREVIOUS switch, still in the transcript, above the
 *  menu for the switch now being asked about. Nothing has changed yet, but
 *  pane-wide matching finds "Set model to" on one line and "opus" on another
 *  and calls it live. The narrowing has to be line-scoped to say no. */
const MODEL_STALE_ABOVE_MENU = [
  '❯ /model sonnet',
  '  ⎿  Set model to Sonnet 5 and saved as your default for new sessions',
  MODEL_MENU,
].join('\n')

/** Two samples of a pane mid-turn, streaming a numbered list. */
const MID_TURN_A = ['  182', '  183', '  184', '❯ '].join('\n')
const MID_TURN_B = ['  254', '  255', '  256', '❯ '].join('\n')
const IDLE_PANE = ['✻ Cogitated for 39s · done 8:11 AM', '❯ '].join('\n')

describe('the line typed into the pane', () => {
  test('/model carries the value verbatim — the caller hands it the bare alias', () => {
    // DIVE-4860: `/model <x>` persists x itself, so the caller passes the alias
    // (see the "floats with Claude releases" arms below), never a claude-* id.
    expect(switchLine('model', 'sonnet')).toBe('/model sonnet')
  })
  test('/effort carries the level verbatim', () => {
    expect(switchLine('effort', 'medium')).toBe('/effort medium')
  })
})

describe('paneConfirms — what counts as the session answering', () => {
  // THE DEFECT, PINNED. `/model <alias>` is sent as `/model <id>`, and the pane
  // answers with the display name. Narrowed on the ID — which is what the
  // caller used to pass — no capture can ever confirm a model switch, so one
  // the running session had already taken was reported as queued, or at rest as
  // "saved, but the pane did not confirm it. It applies at the next restart",
  // which was simply false.
  test('the resolved model ID appears nowhere in the pane', () => {
    expect(MODEL_DONE).not.toContain('claude-opus-5')
    expect(paneConfirms('model', 'claude-opus-5', MODEL_DONE)).toBe(false)
    expect(paneConfirms('model', 'claude-sonnet-5', MODEL_TOAST)).toBe(false)
  })
  test('the alias the human typed does — that is the narrowing that works', () => {
    expect(paneConfirms('model', 'opus', MODEL_DONE)).toBe(true)
    expect(paneConfirms('model', 'sonnet', MODEL_TOAST)).toBe(true)
  })
  test('case-insensitively, because the pane title-cases it', () => {
    expect(MODEL_DONE).toContain('Opus 5')
    expect(paneConfirms('model', 'OPUS', MODEL_DONE)).toBe(true)
  })
  test('mid-turn there is no echo to fall back on — only the toast confirms', () => {
    expect(MODEL_TOAST).not.toContain('/model')
    expect(paneConfirms('model', 'sonnet', MODEL_TOAST)).toBe(true)
  })
  test('the effort line Claude Code actually prints', () => {
    expect(paneConfirms('effort', 'xhigh', EFFORT_DONE)).toBe(true)
  })
  test('a mid-turn pane confirms nothing', () => {
    expect(paneConfirms('effort', 'xhigh', MID_TURN_A)).toBe(false)
    expect(paneConfirms('model', 'opus', MID_TURN_A)).toBe(false)
  })
  // THE NEGATIVE THAT MATTERS: the phrase alone must not confirm a DIFFERENT
  // value. Without the value check, one switch's leftover line on screen would
  // confirm the next switch to anything at all.
  test('the right phrase for the WRONG value does not confirm', () => {
    expect(paneConfirms('effort', 'low', EFFORT_DONE)).toBe(false)
    expect(paneConfirms('model', 'sonnet', MODEL_DONE)).toBe(false)
  })
  test('the value alone, with no phrase, does not confirm', () => {
    expect(paneConfirms('effort', 'medium', '◐ medium · /effort\n❯ ')).toBe(false)
  })
  test('the kinds do not cross-confirm', () => {
    // EFFORT_DONE's wrapped description names Opus and Sonnet outright.
    expect(EFFORT_DONE).toContain('Sonnet 5')
    expect(paneConfirms('model', 'sonnet', EFFORT_DONE)).toBe(false)
    expect(paneConfirms('effort', 'xhigh', MODEL_DONE)).toBe(false)
  })

  // THE MENU IS A QUESTION, NOT AN ANSWER. It names the model it is offering to
  // switch to, so it carries the alias; it must not be read as the switch
  // having happened, because on this pane nothing has.
  test('the cache-invalidation menu is not a confirmation', () => {
    expect(MODEL_MENU).toContain('Opus 5')
    expect(paneConfirms('model', 'opus', MODEL_MENU)).toBe(false)
    expect(EFFORT_MENU).toContain('medium')
    expect(paneConfirms('effort', 'medium', EFFORT_MENU)).toBe(false)
  })
  // ...and not even with a real acknowledgement from the previous switch
  // sitting above it, which is the shape a second /model on a live seat
  // produces. Phrase and value have to land on the SAME line.
  test('a stale acknowledgement above the menu does not confirm the new value', () => {
    expect(MODEL_STALE_ABOVE_MENU).toContain('Set model to')
    expect(MODEL_STALE_ABOVE_MENU.toLowerCase()).toContain('opus')
    expect(paneConfirms('model', 'opus', MODEL_STALE_ABOVE_MENU)).toBe(false)
    // the switch it DID answer still reads, so this is a narrowing, not a mute
    expect(paneConfirms('model', 'sonnet', MODEL_STALE_ABOVE_MENU)).toBe(true)
  })
})

describe('SWITCH_MENU_RE — the menu that has to be answered, not waited out', () => {
  test('it matches both headings the TUI actually prints', () => {
    expect(SWITCH_MENU_RE.test(MODEL_MENU)).toBe(true)
    expect(SWITCH_MENU_RE.test(EFFORT_MENU)).toBe(true)
  })
  test('and nothing on a pane that simply answered', () => {
    expect(SWITCH_MENU_RE.test(MODEL_DONE)).toBe(false)
    expect(SWITCH_MENU_RE.test(EFFORT_DONE)).toBe(false)
    expect(SWITCH_MENU_RE.test(MODEL_TOAST)).toBe(false)
    expect(SWITCH_MENU_RE.test(MID_TURN_A)).toBe(false)
    expect(SWITCH_MENU_RE.test(IDLE_PANE)).toBe(false)
  })
  // It is handed to proxyToClaudeTUI, which presses "1". Option 1 has to be the
  // yes — pressing it on a menu whose first option were "No, go back" would
  // cancel every switch the human asked for.
  test('option 1 is the yes on both', () => {
    expect(MODEL_MENU).toContain('1. Yes, switch to')
    expect(EFFORT_MENU).toContain('1. Yes, switch to')
  })
  test('it is not global — a lastIndex carried between polls would skip matches', () => {
    expect(SWITCH_MENU_RE.flags).not.toContain('g')
    expect(SWITCH_MENU_RE.test(MODEL_MENU)).toBe(true)
    expect(SWITCH_MENU_RE.test(MODEL_MENU)).toBe(true)
  })
})

describe('classifySwitch — the three outcomes', () => {
  test('LIVE: any capture in the window carries the confirmation', () => {
    expect(classifySwitch('effort', 'xhigh', [MID_TURN_A, EFFORT_DONE])).toBe('live')
  })
  test('QUEUED: no confirmation and the pane is still moving — a turn is in flight', () => {
    expect(classifySwitch('effort', 'xhigh', [MID_TURN_A, MID_TURN_B])).toBe('queued')
  })
  test('UNCONFIRMED: no confirmation and the pane went still', () => {
    expect(classifySwitch('effort', 'xhigh', [IDLE_PANE, IDLE_PANE])).toBe('unconfirmed')
  })
  // One sample cannot tell "still moving" from "at rest", so it must not claim
  // either. `unconfirmed` is the wording that stays true whichever it was.
  test('a single capture reports unconfirmed rather than guessing', () => {
    expect(classifySwitch('effort', 'xhigh', [MID_TURN_A])).toBe('unconfirmed')
  })
  test('no captures at all — no tmux, no pane — is unconfirmed, never live', () => {
    expect(classifySwitch('model', 'sonnet', [])).toBe('unconfirmed')
    expect(classifySwitch('model', 'sonnet', [])).not.toBe('live')
  })
  test('a confirmation on the FIRST sample still reads live', () => {
    expect(classifySwitch('model', 'opus', [MODEL_DONE])).toBe('live')
  })
  // The mid-turn poll end to end: pane streaming, the toast lands, the toast
  // expires. This is the sequence the old narrowing scored as `queued` — for a
  // switch that was already live — and the second half of this arm is the only
  // place that difference is graded as a whole poll rather than one capture.
  test('the mid-turn poll reads live — the case the change exists for', () => {
    const poll = [MID_TURN_A, MODEL_TOAST, MID_TURN_B]
    expect(classifySwitch('model', 'sonnet', poll)).toBe('live')
    expect(classifySwitch('model', 'claude-sonnet-5', poll)).toBe('queued')
  })
  // A menu still standing at the end of the window is not a switch. The poll
  // says so; proxyToClaudeTUI's autoConfirm is what stops it standing.
  test('a pane parked on the menu is never live', () => {
    // at rest behind the menu: unconfirmed — settings.json is what carries it
    expect(classifySwitch('model', 'opus', [MODEL_MENU, MODEL_MENU])).toBe('unconfirmed')
    expect(classifySwitch('model', 'opus', [MODEL_MENU, MODEL_MENU])).not.toBe('live')
    // and the same for the effort menu, which names its level just as plainly
    expect(classifySwitch('effort', 'medium', [EFFORT_MENU, EFFORT_MENU])).toBe('unconfirmed')
    expect(classifySwitch('effort', 'medium', [EFFORT_MENU, EFFORT_MENU])).not.toBe('live')
    // a menu that arrives while the pane is still moving reads as queued, which
    // is the honest word for it — but never as live
    expect(classifySwitch('model', 'opus', [MID_TURN_A, MODEL_MENU])).toBe('queued')
    expect(classifySwitch('model', 'opus', [MID_TURN_A, MODEL_MENU])).not.toBe('live')
  })
  test('...and the answer that follows the menu is', () => {
    expect(classifySwitch('model', 'opus', [MODEL_MENU, MODEL_DONE])).toBe('live')
  })
})

describe('the words the human reads', () => {
  test('live says the running session already has it', () => {
    const t = switchAck('effort', 'medium', 'live')
    expect(t).toContain('Effort → medium')
    expect(t).toContain('live')
    expect(t).toMatch(/^✅/)
  })
  test('queued says nothing was interrupted — that is the whole point of the change', () => {
    const t = switchAck('model', 'sonnet', 'queued')
    expect(t).toContain('queued')
    expect(t).toContain('when the current turn ends')
    expect(t).toContain('Nothing was interrupted')
  })
  test('unconfirmed does not claim the switch landed, and says where it did land', () => {
    const t = switchAck('model', 'sonnet', 'unconfirmed')
    expect(t).toMatch(/^⚠️/)
    expect(t).toContain('saved')
    expect(t).toContain('next restart')
    expect(t).not.toContain('live')
  })
  test('/model is acked with the ALIAS the human typed, not the resolved id', () => {
    expect(switchAck('model', 'sonnet', 'live')).toContain('Model → sonnet')
    expect(switchAck('model', 'sonnet', 'live')).not.toContain('claude-sonnet-5')
  })
  // THE REGRESSION ARM. Not one of the four strings a human can now see may
  // promise a restart — that sentence is the defect's own user-facing half.
  test('no ack promises a restart or a 20-30s wait', () => {
    for (const outcome of ['live', 'queued', 'unconfirmed'] as const) {
      for (const kind of ['model', 'effort'] as const) {
        const t = switchAck(kind, 'x', outcome)
        expect(t).not.toMatch(/restarting/i)
        expect(t).not.toContain('20-30s')
      }
    }
    expect(switchPending('model', 'sonnet')).not.toMatch(/restarting/i)
    expect(switchPending('effort', 'low')).not.toContain('20-30s')
  })
  test('the immediate ack claims nothing about the running session yet', () => {
    const t = switchPending('effort', 'low')
    expect(t).toContain('Effort → low')
    expect(t).toContain('applying')
    expect(t).not.toContain('live')
  })
})

describe('the poll budget is bounded', () => {
  test('5s in 250ms steps, matching confirmMenuIfPresent', () => {
    expect(SWITCH_POLL_MS).toBe(5_000)
    expect(SWITCH_POLL_STEP_MS).toBe(250)
    expect(SWITCH_POLL_MS / SWITCH_POLL_STEP_MS).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------- the wiring
// Everything above grades a pure module. These grade that server.ts USES it, so
// the file cannot pass against dead code. The mutant block below proves they are
// not vacuous.
describe('server.ts wiring', () => {
  test('applyModel no longer reaches _self_restart', () => {
    expect(fnBody(src(), 'applyModel')).not.toMatch(/\[\s*'-n',\s*'5dive',\s*'agent',\s*'_self_restart'\s*\]/)
  })
  test('applyEffort no longer reaches _self_restart', () => {
    expect(fnBody(src(), 'applyEffort')).not.toMatch(/\[\s*'-n',\s*'5dive',\s*'agent',\s*'_self_restart'\s*\]/)
  })
  test('both hand off to the live switch instead', () => {
    expect(fnBody(src(), 'applyModel')).toContain("liveSwitch('model'")
    expect(fnBody(src(), 'applyEffort')).toContain("liveSwitch('effort'")
  })
  test('patchSettings STAYS — it is what makes the unconfirmed branch true', () => {
    expect(fnBody(src(), 'applyModel')).toContain('patchSettings')
    expect(fnBody(src(), 'applyEffort')).toContain('patchSettings')
  })
  test('both still return an `after`, which the callback flow reads as success', () => {
    // server.ts answers the button tap with `r.after ? 'Switching…' : 'Failed'`,
    // so dropping `after` would report every successful switch as a failure.
    expect(fnBody(src(), 'applyModel')).toContain('after:')
    expect(fnBody(src(), 'applyEffort')).toContain('after:')
  })
  test('liveSwitch types the line and polls the pane before it acks', () => {
    const body = fnBody(src(), 'liveSwitch')
    expect(body).toContain('proxyToClaudeTUI(switchLine(')
    expect(body).toContain('capture-pane')
    expect(body).toContain('classifySwitch(')
    expect(body).toContain('switchAck(')
  })
  // WHICH STRING IT SEARCHES THE PANE FOR is the whole defect. liveSwitch holds
  // both — `value` is typed, `shown` is what the human said — and the pane only
  // ever prints the second. Handing classifySwitch `value` is the bug.
  test('liveSwitch narrows the pane on `shown`, never on the id it typed', () => {
    const body = fnBody(src(), 'liveSwitch')
    expect(body).toContain('switchLine(kind, value)')
    expect(body).toContain('classifySwitch(kind, shown,')
    expect(body).not.toContain('classifySwitch(kind, value,')
  })
  // ONLY A MENU THIS LINE RAISED. A modal already standing belongs to whoever
  // is at the seat; the two are identical on screen, so the pane has to be read
  // BEFORE the send and the regex withheld when one is already up.
  test('liveSwitch reads the pane before it types, and withholds the answer', () => {
    const body = fnBody(src(), 'liveSwitch')
    const preRead = body.indexOf('menuAlreadyUp = SWITCH_MENU_RE.test(')
    const send = body.indexOf('proxyToClaudeTUI(switchLine(')
    expect(preRead).toBeGreaterThan(-1)
    expect(preRead).toBeLessThan(send)
    expect(body).toContain('menuAlreadyUp ? undefined : SWITCH_MENU_RE')
  })
  test('liveSwitch hands proxyToClaudeTUI the menu to answer', () => {
    expect(fnBody(src(), 'liveSwitch')).toContain('SWITCH_MENU_RE')
    const imported = src().match(/import \{([^}]*)\} from '\.\/liveswitch'/)?.[1] ?? ''
    expect(imported).toContain('SWITCH_MENU_RE')
  })
  // proxyToClaudeTUI only polls for a menu when it is GIVEN one to look for.
  test('...and proxyToClaudeTUI still acts on it', () => {
    const body = fnBody(src(), 'proxyToClaudeTUI')
    expect(body).toContain('if (autoConfirm) void confirmMenuIfPresent(')
  })
  // Restart is still correct for the things a live slash command cannot do.
  test('the restart paths that ARE needed are untouched', () => {
    const text = src()
    for (const verb of ['restart', 'resume', 'update']) {
      expect(text).toContain(`  ${verb}: async ctx => {`)
    }
    // Five callers remain: /restart, /resume, /update, ho:restart and /login
    // (credentials are read only at boot). Model and effort are no longer among
    // them — a count, so a sixth creeping back is visible here.
    const calls = text.match(/'-n', '5dive', 'agent', '_self_restart'/g) ?? []
    expect(calls.length).toBe(5)
  })
})

// ---------------------------------------------------- MUTANT: the narrowings
// paneConfirms is pure, so its mutants are written out here rather than patched
// into a file: each one is the rejected implementation, run against the same
// measured capture, and required to disagree.
describe('MUTANT: narrowing on the model ID', () => {
  /** What the caller passed before: MODEL_ALIASES[alias], not the alias. */
  const asShipped = (pane: string, id: string) =>
    pane.includes(id) && /set\s+model\s+to|kept\s+model\s+as/i.test(pane)

  test('it is false on every real pane a model switch produces', () => {
    expect(asShipped(MODEL_DONE, 'claude-opus-5')).toBe(false)
    expect(asShipped(MODEL_TOAST, 'claude-sonnet-5')).toBe(false)
    // ...while the shipped code says yes to both, on the same bytes
    expect(paneConfirms('model', 'opus', MODEL_DONE)).toBe(true)
    expect(paneConfirms('model', 'sonnet', MODEL_TOAST)).toBe(true)
  })
  // Structurally unreachable, not merely unlucky: `live` needs a capture the
  // poll can never take, so the outcome is decided before the first sample.
  test('no poll of any length can rescue it', () => {
    const everyPane = [MODEL_DONE, MODEL_TOAST, MODEL_MENU, MID_TURN_A, IDLE_PANE]
    expect(everyPane.some(c => asShipped(c, 'claude-opus-5'))).toBe(false)
  })
})

describe('MUTANT: matching the pane instead of the line', () => {
  /** The same phrase and value test, pane-wide — the obvious way to write it. */
  const paneWide = (pane: string, shown: string) =>
    pane.toLowerCase().includes(shown.toLowerCase()) &&
    /set\s+model\s+to|kept\s+model\s+as/i.test(pane)

  test('it calls a blocked switch live; line-scoped says no', () => {
    expect(paneWide(MODEL_STALE_ABOVE_MENU, 'opus')).toBe(true)
    expect(paneConfirms('model', 'opus', MODEL_STALE_ABOVE_MENU)).toBe(false)
  })
  test('the two agree everywhere the pane is not stale', () => {
    for (const [pane, shown] of [[MODEL_DONE, 'opus'], [MODEL_TOAST, 'sonnet']] as const) {
      expect(paneWide(pane, shown)).toBe(paneConfirms('model', shown, pane))
    }
  })
})

// ------------------------------------------------------------------- MUTANT
// Put the restart hook back and require the wiring arms above to go red. The
// mutation is asserted to have changed the text first: a strike-out assertion
// passes vacuously against a no-op edit.
describe('MUTANT: the restart hook, restored', () => {
  const mutate = (text: string) =>
    text.replace(
      "    after: () => { void liveSwitch('model', alias, alias, chatId) },",
      "    after: () => { void execFileP(SUDO, ['-n', '5dive', 'agent', '_self_restart'], { timeout: 5000 }) },",
    )

  test('the mutation actually changes the file', () => {
    expect(mutate(src())).not.toBe(src())
  })
  test('with it back, the applyModel wiring arm is RED — the defect, live', () => {
    const body = fnBody(mutate(src()), 'applyModel')
    expect(body).toMatch(/\[\s*'-n',\s*'5dive',\s*'agent',\s*'_self_restart'\s*\]/)
    expect(body).not.toContain("liveSwitch('model'")
  })
  test('...and the caller count arm is RED too', () => {
    const calls = mutate(src()).match(/'-n', '5dive', 'agent', '_self_restart'/g) ?? []
    expect(calls.length).toBe(6)
  })

  // The same mutation on the OTHER half, because the two hooks were separate
  // lines and removing only one would have left half the defect shipping.
  const mutateEffort = (text: string) =>
    text.replace(
      "    after: () => { void liveSwitch('effort', level, level, chatId) },",
      "    after: () => { void execFileP(SUDO, ['-n', '5dive', 'agent', '_self_restart'], { timeout: 5000 }) },",
    )
  test('the effort mutation actually changes the file', () => {
    expect(mutateEffort(src())).not.toBe(src())
  })
  test('with it back, the applyEffort wiring arm is RED', () => {
    const body = fnBody(mutateEffort(src()), 'applyEffort')
    expect(body).toMatch(/\[\s*'-n',\s*'5dive',\s*'agent',\s*'_self_restart'\s*\]/)
    expect(body).not.toContain("liveSwitch('effort'")
  })
})

// ------------------------------------------- MUTANT: the confirmation path
// The two wiring lines this review round changed, put back the way they
// shipped, with the arms above required to go red. Each mutation is asserted to
// have changed the file first: a strike-out assertion passes vacuously against
// an edit that matched nothing.
describe('MUTANT: the confirmation path, as it shipped', () => {
  /** Search the pane for the model ID again — the narrowing that never matched. */
  const backToId = (text: string) =>
    text.replaceAll('classifySwitch(kind, shown,', 'classifySwitch(kind, value,')
  /** Send the line with nothing watching for the cache-invalidation menu. */
  const dropMenu = (text: string) =>
    text.replace(
      'proxyToClaudeTUI(switchLine(kind, value), menuAlreadyUp ? undefined : SWITCH_MENU_RE)',
      'proxyToClaudeTUI(switchLine(kind, value))',
    )
  /** Answer any matching menu, including one that was already on screen. */
  const answerAnyMenu = (text: string) =>
    text.replace('menuAlreadyUp ? undefined : SWITCH_MENU_RE', 'SWITCH_MENU_RE')

  test('all three mutations actually change the file', () => {
    expect(backToId(src()) === src()).toBe(false)
    expect(dropMenu(src()) === src()).toBe(false)
    expect(answerAnyMenu(src()) === src()).toBe(false)
  })
  test('narrowing on the id again turns the narrowing arm RED', () => {
    const body = fnBody(backToId(src()), 'liveSwitch')
    expect(body).toContain('classifySwitch(kind, value,')
    expect(body).not.toContain('classifySwitch(kind, shown,')
  })
  test('dropping the menu regex turns the menu arm RED', () => {
    const body = fnBody(dropMenu(src()), 'liveSwitch')
    expect(body).toContain('proxyToClaudeTUI(switchLine(kind, value))')
  })
  test('answering a menu we did not raise turns the pre-read arm RED', () => {
    const body = fnBody(answerAnyMenu(src()), 'liveSwitch')
    expect(body).not.toContain('menuAlreadyUp ? undefined : SWITCH_MENU_RE')
    expect(body).toContain('proxyToClaudeTUI(switchLine(kind, value), SWITCH_MENU_RE)')
  })
})

// ---------------------------------- the seat floats with Claude releases
// DIVE-4860. `/model opus` over Telegram used to type `/model claude-opus-5`
// into the pane, and Claude Code persisted THAT to settings.json — overwriting
// the alias patchSettings had just written. The seat was then pinned to a dated
// model forever: the nightly heal only fills an absent key, and a picker-written
// id is indistinguishable from a deliberate pin. Both values applyModel hands
// on — to settings.json and to the pane — must be the bare alias.
describe('/model <alias> writes and types the BARE alias', () => {
  const body = () => fnBody(src(), 'applyModel')

  test('settings.json gets the alias', () => {
    expect(body()).toContain('patchSettings({ model: alias })')
  })
  test('the pane gets the alias — the line Claude Code persists', () => {
    expect(body()).toContain("liveSwitch('model', alias, alias, chatId)")
    expect(body()).not.toMatch(/liveSwitch\('model',\s*MODEL_ALIASES\[/)
    expect(switchLine('model', 'opus')).toBe('/model opus')
  })
  test('no claude-* id reaches either value', () => {
    const b = body()
    expect(b).not.toMatch(/patchSettings\(\{\s*model:\s*MODEL_ALIASES/)
    expect(b).not.toMatch(/'claude-[a-z0-9-]+'/)
  })

  // Read back from a real file: the helper patchSettings delegates to.
  test('settings.json reads back "opus", not a claude-* id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive4860-'))
    try {
      const f = join(dir, 'settings.json')
      writeFileSync(f, JSON.stringify({ model: 'claude-opus-5', effortLevel: 'high' }))
      patchSettingsFile(f, { model: 'opus' }, true)
      const back = JSON.parse(readFileSync(f, 'utf8'))
      expect(back.model).toBe('opus')
      expect(back.model).not.toMatch(/^claude-/)
      expect(back.effortLevel).toBe('high')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('server.ts routes patchSettings through that helper', () => {
    expect(fnBody(src(), 'patchSettings')).toContain("patchSettingsFile(join(homedir(), '.claude', 'settings.json'), patch, /*addNewKeys*/ true)")
    expect(src()).toContain("import { patchSettingsFile } from './settingsfile.ts'")
  })
  // The alias map is still the guard and the picker; it is just not the value.
  test('MODEL_ALIASES still guards the alias', () => {
    expect(body()).toContain('if (!(alias in MODEL_ALIASES))')
    expect(Object.keys(MODEL_ALIASES)).toContain('opus')
  })
})

describe('MUTANT: the full id, typed again', () => {
  const backToId = (text: string) =>
    text.replace(
      "    after: () => { void liveSwitch('model', alias, alias, chatId) },",
      "    after: () => { void liveSwitch('model', MODEL_ALIASES[alias]!, alias, chatId) },",
    )
  const settingsToId = (text: string) =>
    text.replace('patchSettings({ model: alias })', 'patchSettings({ model: MODEL_ALIASES[alias] })')

  test('both mutations actually change the file', () => {
    expect(backToId(src()) === src()).toBe(false)
    expect(settingsToId(src()) === src()).toBe(false)
  })
  test('typing MODEL_ALIASES[alias] turns the pane arm RED', () => {
    const b = fnBody(backToId(src()), 'applyModel')
    expect(b).not.toContain("liveSwitch('model', alias, alias, chatId)")
    expect(b).toMatch(/liveSwitch\('model',\s*MODEL_ALIASES\[/)
  })
  test('writing MODEL_ALIASES[alias] turns the settings arm RED', () => {
    const b = fnBody(settingsToId(src()), 'applyModel')
    expect(b).not.toContain('patchSettings({ model: alias })')
    expect(b).toMatch(/patchSettings\(\{\s*model:\s*MODEL_ALIASES/)
  })
  test('and the value it would type is a claude-* id', () => {
    expect(switchLine('model', MODEL_ALIASES.opus!)).toMatch(/^\/model claude-/)
  })
})
