// Live /model and /effort switching — the decision half, kept pure.
//
// WHY THIS IS ITS OWN FILE. server.ts long-polls Telegram on import, so nothing
// in test/ can import it; the repo's settled answer is to put the decision in a
// module of its own and leave the I/O in the server (commands.ts, autoattach.ts,
// banner.ts, lifecycle.ts all do this). Everything here is a pure function of
// text the caller captured, so the arms in test/model-effort-live.test.ts run
// with no tmux, no bot and no pane.
//
// WHAT CHANGED UPSTREAM OF IT. /model and /effort used to patch settings.json
// and then RESTART the seat, because an older Claude Code answered `/model` with
// an interactive "Switch model?" picker that the bridge could not reliably drive
// over Telegram — server.ts still carries that note. Claude Code now takes the
// argument directly (`/model <id>`, `/effort <level>`), applies it to the
// RUNNING session and persists the choice itself, so the restart buys nothing
// and costs whatever turn was in flight.
//
// AND A LINE TYPED MID-TURN IS NOT LOST. The TUI queues it and applies it when
// the turn ends. That is the third outcome below, and it is the reason this
// module reports three states rather than success/failure: "queued" is a correct
// outcome the human needs different words for, not a failure.

export type SwitchKind = 'model' | 'effort'

/**
 * live        — the pane acknowledged the switch inside the poll window.
 * queued      — no acknowledgement yet and the pane was still moving, i.e. a
 *               turn is in flight and the TUI is holding the line for it.
 * unconfirmed — no acknowledgement and the pane stopped moving. The line went
 *               to an idle composer and nothing answered it; settings.json is
 *               still correct, so the change lands at the next start.
 */
export type SwitchOutcome = 'live' | 'queued' | 'unconfirmed'

/** Poll budget, shared with confirmMenuIfPresent's shape in server.ts. */
export const SWITCH_POLL_MS = 5_000
export const SWITCH_POLL_STEP_MS = 250

/** The line typed into the pane. `value` is the model ID, not the alias. */
export function switchLine(kind: SwitchKind, value: string): string {
  return `/${kind} ${value}`
}

/**
 * Did this capture acknowledge the switch?
 *
 * The phrases are Claude Code's own, and both halves matter:
 *
 *   effort — "Set effort level to medium (saved as your default for new
 *            sessions)", observed first-hand on a live pane.
 *   model  — "Set model to …", and "Kept model as …" for the case where the
 *            requested model was ALREADY active. The second is a confirmation
 *            too: the TUI read the line and decided nothing needed doing. It is
 *            the same string server.ts's own picker comment records.
 *
 * The value must appear as well, so a stale line from an EARLIER switch cannot
 * confirm this one. That is a narrowing, not a guarantee — re-selecting the
 * value that is already on screen is indistinguishable from a fresh
 * acknowledgement, and it resolves to the same state either way.
 */
export function paneConfirms(kind: SwitchKind, value: string, pane: string): boolean {
  if (!pane.includes(value)) return false
  return kind === 'effort'
    ? /set\s+effort\s+level\s+to/i.test(pane)
    : /set\s+model\s+to|kept\s+model\s+as/i.test(pane)
}

/**
 * Classify a poll from the captures it produced, oldest first.
 *
 * `captures` are the pane samples taken AFTER the line was sent. Two or more
 * identical trailing samples mean the pane stopped moving — the repo's existing
 * at-rest signal (clearAfterCarryover waits for exactly that before it sends
 * /clear). A pane still changing at the end of the window is a turn in flight.
 *
 * A single capture cannot tell the two apart, so it reports `unconfirmed`
 * rather than guessing: that wording is the one that stays true either way
 * (settings.json is written, so the change lands at the next start regardless).
 */
export function classifySwitch(
  kind: SwitchKind,
  value: string,
  captures: readonly string[],
): SwitchOutcome {
  if (captures.some(c => paneConfirms(kind, value, c))) return 'live'
  if (captures.length < 2) return 'unconfirmed'
  const last = captures[captures.length - 1]
  const prev = captures[captures.length - 2]
  return last === prev ? 'unconfirmed' : 'queued'
}

/**
 * The ack the human reads. The value is shown as the human named it (the alias
 * for /model), not the model ID typed into the pane.
 *
 * Every branch says what is true of the RUNNING session, because that is the
 * thing the old "restarting to apply it — back in ~20-30s" text got wrong: it
 * promised a restart the seat no longer performs.
 */
export function switchAck(kind: SwitchKind, shown: string, outcome: SwitchOutcome): string {
  const head = kind === 'model' ? `Model → ${shown}` : `Effort → ${shown}`
  switch (outcome) {
    case 'live':
      return `✅ ${head} (live — the running session already has it)`
    case 'queued':
      return `⏳ ${head} — queued, applies when the current turn ends. Nothing was interrupted.`
    case 'unconfirmed':
      return `⚠️ ${head} — saved, but the pane did not confirm it. It applies at the next restart.`
  }
}

/**
 * The immediate ack, sent before the poll has an answer. Deliberately makes no
 * claim about the running session — the follow-up from switchAck() is what
 * reports that, and a first message that promised "live" would be the same
 * unverified claim the restart text used to make.
 */
export function switchPending(kind: SwitchKind, shown: string): string {
  const head = kind === 'model' ? `Model → ${shown}` : `Effort → ${shown}`
  return `${head}\n\n⏳ applying to the running session…`
}
