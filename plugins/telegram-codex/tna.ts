// DIVE-369: pure, import-safe core of the `tna:` (tap-to-answer) callback flow.
// Extracted from server.ts so the synthetic-tap harness (test/tna-harness.test.ts)
// can drive the FULL decision matrix headless — no bot boot, no Telegram round-trip,
// no live DB (server.ts long-polls on import, so importing it in a test is unsafe;
// this module imports cleanly). server.ts stays the thin I/O adapter: re-read the
// live gate -> resolveTnaAnswer() -> answer + ack.
//
// Keep this file byte-identical across telegram base + grok/codex/agy forks; the
// parity test asserts it. The only per-runtime difference lives in server.ts (how
// the gate is fetched: execFileP+JSON.parse on base, run5dive on the forks).

// A tapped inline button lands as `tna:<numericTaskId>:<token>` and, on a hard
// human gate (approval/secret/manual), an optional `:<nonce>` — the DIVE-916
// per-gate HUMAN proof the CLI composed as root into this callback_data (the
// agent LLM never sees it). server.ts forwards it as `--human-proof` so
// `task answer` can tell a real tap (SUDO_UID=agent, but carries the nonce) from
// an agent forging one. Numeric id + short token + 32-hex nonce stays under
// Telegram's 64-byte cap; the answer VALUE is still re-resolved from the live
// gate below, never trusted from the payload.
export const TNA_RE = /^tna:(\d+):([^:]+)(?::([0-9a-f]{32}))?$/

// The fields resolveTnaAnswer reads off a live `5dive task show` gate. Loosely
// typed on purpose — it's whatever the CLI emits, narrowed to what we use.
export interface TnaGate {
  need_type?: string | null
  need_options?: string | null
  need_answer?: string | null
  need_answered_at?: string | null
}

export type TnaResolution =
  | { kind: 'nogate' }                              // task gone or gate already cleared of its type
  | { kind: 'already'; prior: string }             // answered by dashboard/CLI/double-tap mid-flight
  | { kind: 'invalid' }                            // token doesn't map to a valid answer for this gate
  | { kind: 'answer'; answerArgs: string[]; ack: string } // ready to `task answer ...answerArgs`

// Resolve a tapped token against the LIVE gate (never the payload). A secret
// answers with NO --value (the key never enters chat/DB — `answer` only records
// need_answered_at); manual answers --value=done; a decision resolves the option
// by index into need_options; approval takes approved/denied. Anything else is
// 'invalid'. Pure: same inputs -> same output, no I/O — the unit the harness pins.
export function resolveTnaAnswer(task: TnaGate | null | undefined, token: string): TnaResolution {
  if (!task || !task.need_type) return { kind: 'nogate' }
  if (task.need_answered_at) {
    const prior = task.need_type === 'secret' ? '(provided)' : (task.need_answer ?? '—')
    return { kind: 'already', prior }
  }
  if (task.need_type === 'decision') {
    const opts = String(task.need_options ?? '')
      .split('|')
      .map((s: string) => s.trim())
      .filter(Boolean)
    const value = opts[Number(token)]
    if (value !== undefined) return { kind: 'answer', answerArgs: [`--value=${value}`], ack: value }
  } else if (task.need_type === 'approval') {
    if (token === 'approved' || token === 'denied') return { kind: 'answer', answerArgs: [`--value=${token}`], ack: token }
  } else if (task.need_type === 'secret') {
    // DIVE-356: secret gate cleared with no value (CLI rejects --value here).
    if (token === 'provided') return { kind: 'answer', answerArgs: [], ack: 'provided' }
  } else if (task.need_type === 'manual') {
    // DIVE-356: manual gate cleared as done.
    if (token === 'done') return { kind: 'answer', answerArgs: ['--value=done'], ack: 'done' }
  }
  return { kind: 'invalid' }
}

// DIVE-708: detect a lettered/numbered CHOICE list in an agent's chat message so
// each option becomes a tappable button (the multi-option sibling of the DIVE-332
// Yes/No detector). Pure + parity-pinned here; server.ts turns the spec into an
// InlineKeyboard and re-runs parseOptions on the tapped message to resolve the
// choice — never trusting the payload, same philosophy as resolveTnaAnswer.
//
// Conservative by design: a false button on a numbered STEP list ("1. do x
// 2. do y") is worse than a missed one (the miss just falls back to typing).
// So we fire ONLY on a clean sequence of 2–8 short options (a,b,c… or 1,2,3…)
// AND only when the message carries a choice cue (a '?' or a word like
// choose/pick/which/option), which plain instructions almost never do.

export interface ParsedOption { marker: string; label: string }

// callback_data stays tiny (`opt:<index>`); the label is re-resolved from the
// tapped message at tap time, so it never has to fit Telegram's 64-byte cap.
export const OPT_RE = /^opt:(\d+)$/

const OPTION_LINE_RE = /^\s*(?:[-*>•]\s*)?([a-zA-Z]|\d{1,2})[).]\s+(\S.*?)\s*$/
const CHOICE_CUE_RE = /\?|\b(choose|choices?|pick|select|which|option|options|prefer|either)\b/i
const MAX_OPTION_LABEL = 90

// Parse the raw option lines (no cue gate) — exported for the tap-side resolve.
// Returns [] unless the markers form a clean a,b,c… OR 1,2,3… sequence of 2–8
// entries, each a single short line. Letters are lowercased; order = display order.
export function parseOptions(text: string): ParsedOption[] {
  const opts: ParsedOption[] = []
  for (const line of (text ?? '').split('\n')) {
    const m = OPTION_LINE_RE.exec(line)
    if (m) opts.push({ marker: m[1]!.toLowerCase(), label: m[2]! })
  }
  if (opts.length < 2 || opts.length > 8) return []
  if (opts.some(o => o.label.length > MAX_OPTION_LABEL)) return []
  const numeric = /^\d+$/.test(opts[0]!.marker)
  for (let i = 0; i < opts.length; i++) {
    const expected = numeric ? String(i + 1) : String.fromCharCode(97 + i)
    if (opts[i]!.marker !== expected) return []
  }
  return opts
}

// Send-side: the option list IF the message also reads as a choice (cue gate).
// [] → no option buttons (caller falls back to the Yes/No detector).
export function optionChoices(text: string): ParsedOption[] {
  const opts = parseOptions(text)
  if (!opts.length) return []
  return CHOICE_CUE_RE.test(text ?? '') ? opts : []
}

// DIVE-332 / DIVE-1429: pure core of the Yes/No detector (sibling of optionChoices).
// True when a message reads as a POLAR (yes/no) question, so server.ts should attach
// the ✅Yes / ❌No keyboard. Fires ONLY on a single trailing '?', with no "A or B?"
// choice and no wh-word opener (what/which/who/where/when/why/how). Wh-questions are
// OPEN — a Yes/No answer can't address them — so 'here. what's up?' must NOT get
// buttons (DIVE-1429: lodar hit that false keyboard three times). The suppress marker
// (<!-- no-buttons -->) is handled by the caller, which strips it around this check.
const WH_OPENER_RE = /^(what|which|who|whom|whose|where|when|why|how)\b/i
export function yesNoChoice(text: string): boolean {
  const trimmed = (text ?? '').trimEnd()
  if (!trimmed.endsWith('?')) return false
  if ((trimmed.match(/\?/g) ?? []).length !== 1) return false
  // Isolate the trailing question (last sentence/line) and skip "... or ...?".
  const lastQ = (trimmed.split(/[\n.!?]/).filter(s => s.trim()).pop() ?? '').trim()
  if (/\bor\b/i.test(lastQ)) return false
  if (WH_OPENER_RE.test(lastQ)) return false
  return true
}

// DIVE-1115: evidence flags a verified-human tap attaches to `5dive task answer`.
// The caller (server.ts callback handler) only reaches here AFTER allowFrom has
// vetted the tapper as an allow-listed human, so EVERY tap is marked --human for
// provenance — including `decision`/`manual` gates, which previously fell through
// and recorded a bare AGENT name in need_answered_by. That hid real human taps
// from the zero-human KPI (digest counts only `human:*`) and left tier-2 answers
// unprovable as human. --human-proof rides along ONLY when the callback carried a
// per-gate nonce (hard gates mint one; decision mints none), so an older CLI on
// the same box never sees an unknown flag.
export function tapEvidenceArgs(humanProof?: string | null): string[] {
  const args = ['--human']
  if (humanProof) args.push(`--human-proof=${humanProof}`)
  return args
}
