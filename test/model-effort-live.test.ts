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
import {
  switchLine, paneConfirms, classifySwitch, switchAck, switchPending,
  SWITCH_POLL_MS, SWITCH_POLL_STEP_MS,
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

// A pane that has just answered an /effort switch, as Claude Code renders it.
const EFFORT_DONE = [
  '> /effort medium',
  '  ⎿ Set effort level to medium (saved as your default for new sessions)',
  '',
  '◐ medium · /effort',
  '❯ ',
].join('\n')

const MODEL_DONE = ['> /model claude-sonnet-5', '  ⎿ Set model to claude-sonnet-5', '❯ '].join('\n')
const MODEL_KEPT = ['> /model claude-sonnet-5', '  ⎿ Kept model as claude-sonnet-5', '❯ '].join('\n')
const MID_TURN_A = ['✶ Spelunking… (1m 55s · ↓ 6.4k tokens)', '❯ '].join('\n')
const MID_TURN_B = ['✶ Spelunking… (1m 58s · ↓ 6.9k tokens)', '❯ '].join('\n')
const IDLE_PANE = ['✛ Worked for 9m 11s · done 8:09 AM', '❯ '].join('\n')

describe('the line typed into the pane', () => {
  test('/model carries the resolved model ID, not the alias', () => {
    // A bare alias in the TUI is not the same string settings.json takes, and
    // the caller resolves it through MODEL_ALIASES before it gets here.
    expect(switchLine('model', 'claude-sonnet-5')).toBe('/model claude-sonnet-5')
  })
  test('/effort carries the level verbatim', () => {
    expect(switchLine('effort', 'medium')).toBe('/effort medium')
  })
})

describe('paneConfirms — what counts as the session answering', () => {
  test('the effort line Claude Code actually prints', () => {
    expect(paneConfirms('effort', 'medium', EFFORT_DONE)).toBe(true)
  })
  test('"Set model to <id>"', () => {
    expect(paneConfirms('model', 'claude-sonnet-5', MODEL_DONE)).toBe(true)
  })
  test('"Kept model as <id>" is a confirmation too — the TUI read the line and had nothing to do', () => {
    expect(paneConfirms('model', 'claude-sonnet-5', MODEL_KEPT)).toBe(true)
  })
  test('a mid-turn pane confirms nothing', () => {
    expect(paneConfirms('effort', 'medium', MID_TURN_A)).toBe(false)
    expect(paneConfirms('model', 'claude-sonnet-5', MID_TURN_A)).toBe(false)
  })
  // THE NEGATIVE THAT MATTERS: the phrase alone must not confirm a DIFFERENT
  // value. Without the value check, one switch's leftover line on screen would
  // confirm the next switch to anything at all.
  test('the right phrase for the WRONG value does not confirm', () => {
    expect(paneConfirms('effort', 'high', EFFORT_DONE)).toBe(false)
    expect(paneConfirms('model', 'claude-opus-5', MODEL_DONE)).toBe(false)
  })
  test('the value alone, with no phrase, does not confirm', () => {
    expect(paneConfirms('effort', 'medium', '◐ medium · /effort\n❯ ')).toBe(false)
  })
  test('the kinds do not cross-confirm', () => {
    expect(paneConfirms('model', 'medium', EFFORT_DONE)).toBe(false)
  })
})

describe('classifySwitch — the three outcomes', () => {
  test('LIVE: any capture in the window carries the confirmation', () => {
    expect(classifySwitch('effort', 'medium', [MID_TURN_A, EFFORT_DONE])).toBe('live')
  })
  test('QUEUED: no confirmation and the pane is still moving — a turn is in flight', () => {
    expect(classifySwitch('effort', 'medium', [MID_TURN_A, MID_TURN_B])).toBe('queued')
  })
  test('UNCONFIRMED: no confirmation and the pane went still', () => {
    expect(classifySwitch('effort', 'medium', [IDLE_PANE, IDLE_PANE])).toBe('unconfirmed')
  })
  // One sample cannot tell "still moving" from "at rest", so it must not claim
  // either. `unconfirmed` is the wording that stays true whichever it was.
  test('a single capture reports unconfirmed rather than guessing', () => {
    expect(classifySwitch('effort', 'medium', [MID_TURN_A])).toBe('unconfirmed')
  })
  test('no captures at all — no tmux, no pane — is unconfirmed, never live', () => {
    expect(classifySwitch('model', 'claude-sonnet-5', [])).toBe('unconfirmed')
    expect(classifySwitch('model', 'claude-sonnet-5', [])).not.toBe('live')
  })
  test('a confirmation on the FIRST sample still reads live', () => {
    expect(classifySwitch('model', 'claude-sonnet-5', [MODEL_DONE])).toBe('live')
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

// ------------------------------------------------------------------- MUTANT
// Put the restart hook back and require the wiring arms above to go red. The
// mutation is asserted to have changed the text first: a strike-out assertion
// passes vacuously against a no-op edit.
describe('MUTANT: the restart hook, restored', () => {
  const mutate = (text: string) =>
    text.replace(
      "    after: () => { void liveSwitch('model', MODEL_ALIASES[alias]!, alias, chatId) },",
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
