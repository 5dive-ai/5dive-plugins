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
// THE MENU DID NOT GO AWAY, IT SHRANK. What survives is a one-key confirmation
// that the switch will invalidate the conversation cache, and only when the
// pane is idle with a cached conversation — see SWITCH_MENU_RE, which is what
// answers it. The picker the restart was built around, the one with no
// argument and no reliable rendering, is what went.
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
 * The cache-invalidation menu Claude Code raises BEFORE it applies the switch.
 *
 * Measured on 2.1.278, idle pane, conversation already cached — both halves pop
 * a modal instead of applying the line:
 *
 *     Switch model?                     |  Change effort level?
 *     Your next response will be slower and use more tokens
 *     This conversation is cached for the current model. Switching to Sonnet 5
 *     means the full history gets re-read on your next message.
 *     > 1. Yes, switch to Sonnet 5
 *       2. No, go back
 *
 * Left unanswered it does two things, and the second is the worse one: the
 * switch never happens, AND the pane stays modal, so the next line the bridge
 * types into the seat is eaten as a menu keystroke. server.ts has carried the
 * answer all along — proxyToClaudeTUI(line, re) polls the pane and presses "1"
 * on a match — but the argument had no caller until this path started typing
 * /model and /effort into a live pane again.
 *
 * Yes is the right answer: the human asked for the switch, and the restart this
 * replaced invalidated the whole conversation cache anyway.
 *
 * ONLY FOR A MENU THIS LINE RAISED. A modal already standing when we arrive
 * belongs to whoever is at the seat, and pressing "1" on it answers a question
 * nobody here asked. An old modal and a new one render identically, so the only
 * moment they can be told apart is BEFORE the send — see liveSwitch(), which
 * reads the pane first and withholds the regex if one is already up.
 *
 * MID-TURN THE MENU DOES NOT RENDER — the line applies straight away. That is
 * why measurements taken mid-turn, which is the case this change was built for,
 * never saw it.
 */
export const SWITCH_MENU_RE = /(?:Switch model|Change effort level)\?/

/**
 * Did this capture acknowledge the switch?
 *
 * `shown` is WHAT THE HUMAN TYPED — the alias for /model, the level for
 * /effort. It is not the model ID switchLine() types into the pane, and that
 * difference was a defect: asked for `/model claude-opus-5`, the pane answers
 *
 *     |  Set model to Opus 5 and saved as your default for new sessions
 *
 * with the DISPLAY NAME. `claude-opus-5` appears nowhere in it, so a narrowing
 * on the ID could never confirm a model switch however long the poll ran — and
 * the human was told "saved, applies at the next restart" about a change the
 * running session had already taken. The alias survives the display name:
 * "Opus 5" contains "opus", case-insensitively.
 *
 * The phrases are Claude Code's own, measured on 2.1.278 rather than recalled:
 *
 *   effort — "Set effort level to xhigh (saved as your default for new
 *            sessions): <description>", the description wrapping onto the
 *            following line.
 *   model  — "Set model to <Display Name> and saved as your default for new
 *            sessions", and that is the whole list. Same line in the transcript
 *            at idle, same line as an ephemeral toast mid-turn, same line after
 *            the menu below is confirmed, and same line again when the model
 *            asked for is ALREADY the active one — re-selecting it in the bare
 *            `/model` picker prints it too. server.ts's picker note remembered
 *            a "Kept model as …" for that last case and this file used to match
 *            on it; typing every form of the command at a live pane produced it
 *            zero times, so the alternative is gone rather than renamed. A
 *            version that does emit it resolves to `unconfirmed`, which is
 *            true — settings.json is written — where matching a phrase nobody
 *            has seen is the habit that put the ID narrowing here.
 *
 * PHRASE AND VALUE MUST BE ON THE SAME LINE. Searching the pane as a whole
 * would confirm the wrong switch: an idle pane keeps the previous "Set model to
 * Sonnet 5" in its transcript, and the echo of the line just typed puts the new
 * alias on screen too, so `/model opus` behind an unanswered menu would match a
 * phrase from one line and a value from another and report a switch that never
 * happened. Line-scoped, a stale acknowledgement can only confirm the value it
 * actually names. The cost is a miss if a narrow pane wraps the display name
 * off the phrase line: that resolves to `unconfirmed`, which is true (the
 * settings.json write stands), where the false positive would be a lie.
 */
export function paneConfirms(kind: SwitchKind, shown: string, pane: string): boolean {
  const phrase = kind === 'effort'
    ? /^.*set\s+effort\s+level\s+to.*$/gim
    : /^.*set\s+model\s+to.*$/gim
  const needle = shown.toLowerCase()
  return (pane.match(phrase) ?? []).some(line => line.toLowerCase().includes(needle))
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
 *
 * `shown` is the human's own word, the same thing paneConfirms() narrows on —
 * the alias for /model, the level for /effort. Handing it the resolved model ID
 * is the defect this parameter is named against.
 */
export function classifySwitch(
  kind: SwitchKind,
  shown: string,
  captures: readonly string[],
): SwitchOutcome {
  if (captures.some(c => paneConfirms(kind, shown, c))) return 'live'
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
