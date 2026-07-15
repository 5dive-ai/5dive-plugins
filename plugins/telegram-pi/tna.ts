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

// A tapped inline button lands as `tna:<numericTaskId>:<token>`. Numeric id + a
// short token keeps callback_data under Telegram's 64-byte cap; the value is
// always re-resolved from the live gate below, never trusted from the payload.
export const TNA_RE = /^tna:(\d+):(.+)$/

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

export interface ParsedOption { marker: string; label: string; recommended?: boolean }

export type QuestionRenderSpec =
  | { kind: 'none'; stripped: string }
  | { kind: 'boolean'; stripped: string }
  | {
      kind: 'options'
      stripped: string
      options: ParsedOption[]
      vertical: boolean
      recommendation?: string
    }
  | { kind: 'free_text'; stripped: string; placeholder: string }

// callback_data stays tiny (`opt:<index>`); the label is re-resolved from the
// tapped message at tap time, so it never has to fit Telegram's 64-byte cap.
export const OPT_RE = /^opt:(\d+)$/

const OPTION_LINE_RE = /^\s*(?:[-*>•]\s*)?([a-zA-Z]|\d{1,2})[).]\s+(\S.*?)\s*$/
const CHOICE_CUE_RE = /\?|\b(choose|choices?|pick|select|which|option|options|prefer|either)\b/i
const MAX_OPTION_LABEL = 90
const MAX_INLINE_OPTIONS = 8
const MAX_PARSED_OPTIONS = 20
const RECOMMENDED_SUFFIX_RE = /\s*(?:\((?:recommended|best choice)\)|\[(?:recommended|best choice)\])\s*$/i
const EXPLICIT_RECOMMENDATION_RE = /(?:^|\n)\s*(?:✅\s*)?recommended\s*:\s*([^\n]+)/i
const BOOLEAN_QUESTION_RE = /^(?:(?:is|are|am|was|were|do|does|did|can|could|will|would|should|shall|may|might|must|have|has|had)\b|(?:yes\s+or\s+no|true\s+or\s+false)\b)/i

function scanOptions(text: string): ParsedOption[] {
  const opts: ParsedOption[] = []
  for (const line of (text ?? '').split('\n')) {
    const m = OPTION_LINE_RE.exec(line)
    if (!m) continue
    const rawLabel = m[2]!
    const recommended = RECOMMENDED_SUFFIX_RE.test(rawLabel)
    const label = recommended ? rawLabel.replace(RECOMMENDED_SUFFIX_RE, '').trimEnd() : rawLabel
    opts.push({ marker: m[1]!.toLowerCase(), label, ...(recommended ? { recommended: true } : {}) })
  }
  if (opts.length < 2 || opts.length > MAX_PARSED_OPTIONS) return []
  const numeric = /^\d+$/.test(opts[0]!.marker)
  for (let i = 0; i < opts.length; i++) {
    const expected = numeric ? String(i + 1) : String.fromCharCode(97 + i)
    if (opts[i]!.marker !== expected) return []
  }
  return opts
}

// Parse the raw option lines (no cue gate) — exported for the tap-side resolve.
// Returns [] unless the markers form a clean a,b,c… OR 1,2,3… sequence of 2–8
// entries, each a single short line. Letters are lowercased; order = display order.
export function parseOptions(text: string): ParsedOption[] {
  const opts = scanOptions(text)
  if (opts.length < 2 || opts.length > MAX_INLINE_OPTIONS) return []
  if (opts.some(o => o.label.length > MAX_OPTION_LABEL)) return []
  return opts
}

// Send-side: the option list IF the message also reads as a choice (cue gate).
// [] → no option buttons (caller falls back to the Yes/No detector).
export function optionChoices(text: string): ParsedOption[] {
  const opts = parseOptions(text)
  if (!opts.length) return []
  return CHOICE_CUE_RE.test(text ?? '') ? opts : []
}

// DIVE-1272: one pure decision point shared by every Telegram bridge. Structured
// options win; Yes/No is reserved for genuinely boolean grammar; a free-text
// question gets Telegram ForceReply instead of two invented answers. Large or
// overlong option lists intentionally fall back to a numbered typed reply.
export function questionRenderSpec(text: string): QuestionRenderSpec {
  const stripped = (text ?? '').replace(/\s*<!--\s*no-?(?:yn|buttons)\s*-->\s*$/i, '')
  if (stripped !== (text ?? '')) return { kind: 'none', stripped }

  const scanned = scanOptions(stripped)
  if (scanned.length && CHOICE_CUE_RE.test(stripped)) {
    if (scanned.length > MAX_INLINE_OPTIONS || scanned.some(o => o.label.length > MAX_OPTION_LABEL)) {
      return {
        kind: 'free_text',
        stripped,
        placeholder: `Reply with an option number (1-${scanned.length})`,
      }
    }
    const explicit = EXPLICIT_RECOMMENDATION_RE.exec(stripped)?.[1]?.trim()
    const recommended = scanned.find(o => o.recommended)
      ?? (explicit ? scanned.find(o => o.label.toLowerCase() === explicit.toLowerCase()) : undefined)
    const recommendation = recommended?.label
    const withRecommendation = recommendation && !explicit
      ? `${stripped}\n\n✅ Recommended: ${recommendation}`
      : stripped
    return {
      kind: 'options',
      stripped: withRecommendation,
      options: scanned,
      vertical: scanned.length > 3 || scanned.some(o => o.label.length > 24),
      ...(recommendation ? { recommendation } : {}),
    }
  }

  const trimmed = stripped.trimEnd()
  if (!trimmed.endsWith('?')) return { kind: 'none', stripped }
  if ((trimmed.match(/\?/g) ?? []).length !== 1) {
    return { kind: 'free_text', stripped, placeholder: 'Reply to this message with your answer' }
  }
  const lastQuestion = trimmed.split(/[\n.!]/).filter(s => s.trim()).pop()?.trim() ?? ''
  const explicitBooleanPair = /\b(?:yes\s+or\s+no|true\s+or\s+false)\b/i.test(lastQuestion)
  if (BOOLEAN_QUESTION_RE.test(lastQuestion) && (!/\bor\b/i.test(lastQuestion) || explicitBooleanPair)) {
    return { kind: 'boolean', stripped }
  }
  return { kind: 'free_text', stripped, placeholder: 'Reply to this message with your answer' }
}
