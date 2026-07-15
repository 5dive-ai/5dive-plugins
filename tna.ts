// Pure, import-safe option-list detection for the Telegram bridge. Kept in its
// own module so it imports cleanly into tests without booting the bot.
//
// Detect a lettered/numbered CHOICE list in an assistant's message so each option
// becomes a tappable button. server.ts turns the parsed spec into an InlineKeyboard
// and re-runs parseOptions() on the tapped message to resolve the choice, so the
// button payload is never trusted.
//
// Conservative by design: a false button on a numbered STEP list ("1. do x
// 2. do y") is worse than a missed one (the miss just falls back to typing).
// So we fire ONLY on a clean sequence of 2 to 8 short options (a,b,c… or 1,2,3…)
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
// Returns [] unless the markers form a clean a,b,c… OR 1,2,3… sequence of 2 to 8
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
