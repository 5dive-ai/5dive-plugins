// DIVE-369: pure, import-safe core of the `tna:` (tap-to-answer) callback flow.
// Extracted from server.ts so the synthetic-tap harness (test/tna-harness.test.ts)
// can drive the FULL decision matrix headless — no bot boot, no Telegram round-trip,
// no live DB (server.ts long-polls on import, so importing it in a test is unsafe;
// this module imports cleanly). server.ts stays the thin I/O adapter: re-read the
// live gate -> resolveTnaAnswer() -> answer + ack.
//
// Keep this file byte-identical across EVERY telegram plugin. The parity test
// GLOBS plugins/*/tna.ts instead of naming a list, because DIVE-2374 was caused
// by a named list: telegram-pi and telegram-opencode were simply absent from it,
// so their stale greedy TNA_RE -- and the far worse fact that their server.ts
// never routed `tna:` at all, i.e. no gate was tappable on those runtimes -- was
// never observable to CI. A fence that works by NAMING its members cannot fail
// for a member it does not name. The only per-runtime difference lives in
// server.ts (how the gate is fetched: execFileP+JSON.parse on base, run5dive on
// the forks).

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
  // DIVE-2467: provenance of the settling answer — `human:<agent>` for a verified
  // human path, `lead:*` for a lead clear, `auto:t0|precedent|reject|ttl` for a
  // machine one, or a bare agent name on the legacy path. `task show --json` is a
  // `SELECT *`, so this rides along with need_answered_at at no fetch cost.
  need_answered_by?: string | null
}

export type TnaResolution =
  | { kind: 'nogate' }                              // task gone or gate already cleared of its type
  // answered by dashboard/CLI/double-tap mid-flight. toast/edit are the FINAL
  // user-facing copy (see settledDetail) rather than data the caller formats,
  // so all six server.ts adapters render a stale tap identically and the parity
  // test pins the wording itself, not just the branch.
  | { kind: 'already'; prior: string; toast: string; edit: string }
  | { kind: 'invalid' }                            // token doesn't map to a valid answer for this gate
  | { kind: 'answer'; answerArgs: string[]; ack: string } // ready to `task answer ...answerArgs`

// DIVE-2410/2467: a stale tap must name WHEN and WHO settled the gate, not just
// that it is settled. "Already answered." tells a human their tap did nothing but
// leaves them unable to tell a gate they themselves cleared minutes ago from one
// an auto-rule closed on their behalf — which is the same believed-vs-recorded
// divergence DIVE-2410 was filed for, one step further in.
//
// The CLI stamps need_answered_at as UTC `YYYY-MM-DD HH:MM:SS` (`date -u`), so the
// ' UTC' label is asserted, not assumed — but only when the value actually parses
// as that shape; anything else passes through verbatim rather than being labelled
// with a zone we did not verify. Seconds are dropped: this is a "was it already
// settled when I tapped" read, not forensics.
//
// `who` is the RAW provenance token (`human:marketing`, not `marketing`): the
// prefix is the decision-relevant half — a person answered vs a timeout did — and
// stripping it would attribute a human's answer to the agent whose channel relayed
// it. Capped so a long token cannot push the toast past Telegram's 200-char limit,
// where answerCallbackQuery would fail and .catch(() => {}) would restore exactly
// the silence this fixes.
const SETTLED_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/
const MAX_SETTLED_BY = 48

export function settledDetail(at?: string | null, by?: string | null): string {
  const rawAt = String(at ?? '').trim()
  const m = SETTLED_TS_RE.exec(rawAt)
  const when = m ? `${m[1]} ${m[2]} UTC` : rawAt
  let who = String(by ?? '').trim()
  if (who.length > MAX_SETTLED_BY) who = `${who.slice(0, MAX_SETTLED_BY - 1)}…`
  if (when && who) return `${when} by ${who}`
  if (when) return when
  return who ? `by ${who}` : ''
}

// Resolve a tapped token against the LIVE gate (never the payload). A secret
// answers with NO --value (the key never enters chat/DB — `answer` only records
// need_answered_at); manual answers --value=done; a decision resolves the option
// by index into need_options; approval takes approved/denied. Anything else is
// 'invalid'. Pure: same inputs -> same output, no I/O — the unit the harness pins.
// DIVE-6433: the owner's language for the copy a human reads. `en` (the default)
// is byte-identical to before; `ru` translates the copy and the ack, never the
// value `task answer` records — callback_data and --value stay language-neutral.
const TNA_ACK_RU: Record<string, string> = { approved: 'одобрено', denied: 'отклонено', done: 'готово', provided: 'передано' }
export function tnaAck(ack: string, lang: 'en' | 'ru' = 'en'): string {
  return lang === 'ru' ? (TNA_ACK_RU[ack] ?? ack) : ack
}

export function resolveTnaAnswer(task: TnaGate | null | undefined, token: string, lang: 'en' | 'ru' = 'en'): TnaResolution {
  // DIVE-2467: 'nogate' deliberately stays generic. It fires when the task is gone
  // or the gate was WITHDRAWN, and withdraw NULLs need_answer/at/by together (one
  // UPDATE in the CLI) — so on this branch there is no when/who to name. Measured
  // on DIVE-2407, a withdrawn gate: need_type and all three need_answered_* absent.
  if (!task || !task.need_type) return { kind: 'nogate' }
  if (task.need_answered_at) {
    const prior = task.need_type === 'secret' ? '(provided)' : (task.need_answer ?? '—')
    const detail = settledDetail(task.need_answered_at, task.need_answered_by)
    if (lang === 'ru') {
      const p = task.need_type === 'secret' ? '(передано)' : tnaAck(prior, 'ru')
      const d = detail.replace(' by ', ', ').replace(/^by /, '')
      return {
        kind: 'already',
        prior,
        toast: d ? `Ответ уже получен: ${d}.` : 'Ответ уже получен.',
        edit: d ? `✅ ответ уже получен: ${p} (${d})` : `✅ ответ уже получен: ${p}`,
      }
    }
    return {
      kind: 'already',
      prior,
      toast: detail ? `Already answered ${detail}.` : 'Already answered.',
      edit: detail ? `✅ already answered: ${prior} (${detail})` : `✅ already answered: ${prior}`,
    }
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

// DIVE-7032: `pick` is the agent's own recommendation, marked with a leading ⭐
// ("1. ⭐ Your own server", or "⭐ 1. …"). The star is cut from the label, so the
// tapped answer comes back clean and the star never counted toward the old 90-char
// limit; the keyboard puts it back on that one button, the way gate keyboards
// star their recommendation. At most one pick: a second star is dropped.
export interface ParsedOption { marker: string; label: string; pick: boolean }

// callback_data stays tiny (`opt:<index>`); the label is re-resolved from the
// tapped message at tap time, so it never has to fit Telegram's 64-byte cap.
export const OPT_RE = /^opt:(\d+)$/

const OPTION_LINE_RE = /^\s*(?:[-*>•]\s*)?(⭐\uFE0F?\s*)?([a-zA-Z]|\d{1,2})[).]\s+(\S.*?)\s*$/
const PICK_STAR_RE = /^⭐\uFE0F?\s*/
const CHOICE_CUE_RE = /\?|\b(choose|choices?|pick|select|which|option|options|prefer|either|recommend\w*|suggest\w*|go with)\b/i
// DIVE-6995: the pick line counts as a cue, in Russian too. Since DIVE-6963 the
// line before the list names the agent's own pick, often a statement with no '?'
// («Советую первый.» / "I recommend the first."), and a partner agent's 3-option choice to
// lodar went out as plain text. Russian words end on the not-a-letter lookahead
// DIVE-6859 uses, because JS `\b` is ASCII-only. A step list with none of these
// words still gets no buttons.
const CHOICE_CUE_RU_RE = /(?<![\p{L}\p{N}])(совет\p{L}*|рекоменд\p{L}*|предлага\p{L}*|предлож\p{L}*|выб[иое]р\p{L}*|выбра\p{L}*|вариант\p{L}*|какой|какая|какое|какие|какую)(?![\p{L}\p{N}])/iu
const hasChoiceCue = (text: string): boolean => CHOICE_CUE_RE.test(text) || CHOICE_CUE_RU_RE.test(text)

// Parse the raw option lines (no cue gate) — exported for the tap-side resolve.
// Returns [] unless the markers form a clean a,b,c… OR 1,2,3… sequence of 2–8
// entries, each a single line. Letters are lowercased; order = display order.
//
// DIVE-7286: a long line no longer kills the keyboard. creative's two reply drafts
// to lodar (one 119 characters) went out as plain text because one label passed
// MAX_OPTION_LABEL. Choosing between drafts is the normal case for creative and
// marketing, and drafts run long. Each bridge's optionButtons() already cuts the
// BUTTON text, and the tap brings back the full label from here, so the length
// check only ever cost the buttons. A step list is still kept out by the cue gate
// in optionChoices(), not by length.
//
// DIVE-7321: a ```fenced``` block is text to copy, not a choice. main sent lodar a
// numbered Reddit reply draft inside a code block, and the draft's own "which agent
// is asking" passed the cue gate, so it went out with two option buttons. Lines in
// a fence are dropped here (so a real list below a fenced draft still parses), and
// optionChoices() reads its cue from the same unfenced text. An unclosed fence runs
// to the end. yesNoChoice() empties fences the same way (DIVE-6988).
// After a restart the tap re-parses Telegram's rendered text, where a MarkdownV2
// fence is already gone: a draft list plus a real list then reads 1,2,1,2, which
// is not a clean sequence, so the tap says the option is gone instead of guessing.
const FENCE_RE = /```[\s\S]*?(?:```|$)/g
const unfenced = (text: string): string => text.replace(FENCE_RE, '\n')
export function parseOptions(text: string): ParsedOption[] {
  const opts: ParsedOption[] = []
  let picked = false
  for (const line of unfenced(text ?? '').split('\n')) {
    const m = OPTION_LINE_RE.exec(line)
    if (!m) continue
    const star = !!m[1] || PICK_STAR_RE.test(m[3]!)
    const label = m[3]!.replace(PICK_STAR_RE, '')
    if (!label) continue
    opts.push({ marker: m[2]!.toLowerCase(), label, pick: star && !picked })
    picked ||= star
  }
  if (opts.length < 2 || opts.length > 8) return []
  const numeric = /^\d+$/.test(opts[0]!.marker)
  for (let i = 0; i < opts.length; i++) {
    const expected = numeric ? String(i + 1) : String.fromCharCode(97 + i)
    if (opts[i]!.marker !== expected) return []
  }
  return opts
}

// Send-side: the option list IF the message also reads as a choice (cue gate).
// [] → no option buttons (caller falls back to the Yes/No detector).
// DIVE-7061: a ⭐ on an option IS the cue. marketing's pick line "I'd keep 22,
// because …" matched no cue word, so its starred choice to lodar went out as
// plain text. A step list never carries the agent's ⭐, and the star needs no
// word list in any language.
export function optionChoices(text: string): ParsedOption[] {
  const opts = parseOptions(text)
  if (!opts.length) return []
  return hasChoiceCue(unfenced(text ?? '')) || opts.some(o => o.pick) ? opts : []
}

// DIVE-332 / DIVE-1429: pure core of the Yes/No detector (sibling of optionChoices).
// True when a message reads as a POLAR (yes/no) question, so server.ts should attach
// the ✅Yes / ❌No keyboard. Fires ONLY on a single trailing '?', with no "A or B?"
// choice and no wh-word opener (what/which/who/where/when/why/how). Wh-questions are
// OPEN — a Yes/No answer can't address them — so 'here. what's up?' must NOT get
// buttons (DIVE-1429: lodar hit that false keyboard three times). The suppress marker
// (<!-- no-buttons -->) is handled by the caller, which strips it around this check.
//
// DIVE-6859: Russian too. «Какой берём?» and «A или B?» got ✅Да/❌Нет. JS `\b` is
// ASCII-only, so the Russian words end on a not-a-letter lookahead instead. The
// opener is checked at the start of the question AND of its last clause, so a
// lead-in («Два пути, какой берём?», "Two paths, which one?") is caught as well.
const WH_OPENER_RE = /^(what|which|who|whom|whose|where|when|why|how)\b/i
const WH_OPENER_RU_RE = /^(какой|какая|какое|какие|какую|каком|каким|какими|каких|какого|какому|что|чего|чем|кто|кого|кому|где|когда|куда|откуда|почему|зачем|как|сколько|чей|чья|чьё|чье|чьи)(?![\p{L}\p{N}])/iu
const OR_RU_RE = /(?<![\p{L}\p{N}])или(?![\p{L}\p{N}])/iu
const isWhOpener = (s: string): boolean => WH_OPENER_RE.test(s) || WH_OPENER_RU_RE.test(s)
// DIVE-6988: a QUOTED question is not a question to the reader. main's 'ask "what
// should Olivia do first?" before the card. Want dev2 to mock that order?' held two
// '?' and got no buttons, so lodar skimmed past it. Every rule below reads the text
// with quoted spans emptied ("…", “…”, «…», `…`, ```…```, '…'). A single quote counts
// only when it does not touch a letter on its outer side, so the apostrophes in
// "don't … we're" never pair up and swallow a real '?'. Spans stay on one line.
const QUOTED_RE = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu
const unquoted = (text: string): string =>
  text.replace(QUOTED_RE, m => m.startsWith('```') ? '``````' : m[0]! + m[m.length - 1]!)
export function yesNoChoice(text: string): boolean {
  const trimmed = unquoted(text ?? '').trimEnd()
  if (!trimmed.endsWith('?')) return false
  if ((trimmed.match(/\?/g) ?? []).length !== 1) return false
  // Isolate the trailing question (last sentence/line) and skip "... or ...?".
  const lastQ = (trimmed.split(/[\n.!?]/).filter(s => s.trim()).pop() ?? '').trim()
  if (/\bor\b/i.test(lastQ) || OR_RU_RE.test(lastQ)) return false
  const lastClause = (lastQ.split(/[,;:—–]/).filter(s => s.trim()).pop() ?? '').trim()
  if (isWhOpener(lastQ) || isWhOpener(lastClause)) return false
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
//
// DIVE-3178: WHO PRESSED IT, AND WHOSE BOT CARRIED IT — the half that SENDS.
//
// DIVE-3128 taught the CLI to receive `--tap-uid` / `--tap-username` / `--tap-msg`
// / `--relay-agent`, and nothing installed ever sent them. So the CLI reached its
// human stamp with only its own process identity — an AGENT name — correctly
// refused to write `human:<agent>`, and had nothing to put in its place: every
// channel-relayed tier-2 clear on this fleet recorded `unattributed:<agent>`,
// proven human and unattributable at once (measured 2026-08-10 on DIVE-3150, a
// real tap of lodar's that held a merge). `tap_uid=none` was the fix RECEIVING
// NOTHING, not the fix failing — the defect lives on this side of the wire.
//
// The fields come off Telegram's `callback_query`, which the relaying agent does
// not author: `.from.id` and `.from.username` are the person who pressed the
// button, `.message.message_id` is the ping they pressed. The relay names ITSELF
// separately, so the carrier lands in its own column (`need_answered_relay`)
// instead of being what the `human:` prefix attaches to.
//
// SANITISED BEFORE THEY BECOME ARGV, on the same grammars cmd_agent_teambot.sh
// uses: a Telegram id is digits (negative for channels), a handle is Telegram's
// own 5-32 char rule, a message id is digits. Anything else is DROPPED rather
// than forwarded — the CLI re-validates, but a relay must not be the thing that
// ships a malformed identity into a provenance field. Dropping is also why a
// missing field cannot degrade the answer: the tap still lands with exactly the
// evidence it had before, and only the attribution is poorer.
export interface TapContext {
  /** `callback_query.from.id` — the human who pressed the button. */
  uid?: string | number | null
  /** `callback_query.from.username` — their handle, with or without a leading '@'. */
  username?: string | null
  /** `callback_query.message.message_id` — which ping was tapped. */
  messageId?: string | number | null
  /** `process.env.USER` on the box running this bridge — the RELAY, never the decider. */
  osUser?: string | null
}

const TAP_UID_RE = /^-?\d{1,20}$/
const TAP_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/
const TAP_MSG_RE = /^\d{1,19}$/
const RELAY_AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/

// The bridge runs as `agent-<name>` (or `claude`); the roster name is the suffix.
// Pure and exported so the harness pins it without an environment — the six
// server.ts adapters pass `process.env.USER` and nothing else.
export function relayAgentName(osUser?: string | null): string {
  return String(osUser ?? '').trim().replace(/^agent-/, '')
}

export function tapEvidenceArgs(humanProof?: string | null, tap?: TapContext | null): string[] {
  const args = ['--human']
  if (humanProof) args.push(`--human-proof=${humanProof}`)
  if (!tap) return args
  const uid = String(tap.uid ?? '').trim()
  if (TAP_UID_RE.test(uid)) args.push(`--tap-uid=${uid}`)
  const username = String(tap.username ?? '').trim().replace(/^@/, '')
  if (TAP_USERNAME_RE.test(username)) args.push(`--tap-username=${username}`)
  const messageId = String(tap.messageId ?? '').trim()
  if (TAP_MSG_RE.test(messageId)) args.push(`--tap-msg=${messageId}`)
  const relay = relayAgentName(tap.osUser)
  if (RELAY_AGENT_RE.test(relay)) args.push(`--relay-agent=${relay}`)
  return args
}

// ---------------------------------------------------------------------------
// DIVE-2846: what a FAILED tap tells the human, and what it leaves behind.
//
// The old catch was `catch {` with no binding: five plausible causes named in a
// comment and not one of them kept anywhere. A tap that reported failure to a
// human left NO record of why, and the plugin has no journal to fall back on, so
// the cause was unrecoverable after the fact (measured 2026-08-06: two of lodar's
// taps failed and the reason is gone for good).
//
// Three pure pieces, so all six server.ts adapters render a failure identically
// and the harness can pin the wording without a bot, a box, or a live gate:
//   describeTapError() — turn the thrown thing into a kind + one human line.
//   tapLanding()       — what the post-failure re-read says actually happened.
//   tapFailureCopy()   — the toast, the chat fallback, and the log row.
// ---------------------------------------------------------------------------

// A failure line must stay short enough that toast + prefix clears Telegram's
// 200-char answerCallbackQuery cap, where a throw would be swallowed by the
// .catch(() => {}) and restore exactly the silence this fixes.
const MAX_TAP_REASON = 110

export type TapErrorKind =
  | 'timeout'     // execFile killed the CLI on its own timeout budget
  | 'refused'     // the CLI ran and said no (--json ok:false, or a non-zero exit)
  | 'sudo'        // sudo -n could not elevate at all
  | 'missing'     // no 5dive on PATH
  | 'unreadable'  // the CLI answered with something that is not our envelope
  | 'error'       // anything else, message preserved verbatim

export interface TapErrorInfo {
  kind: TapErrorKind
  /** One clause a human can act on: 'timed out', 'sudo refused', the CLI's own refusal. */
  short: string
  /** Everything we know, for the log row — never truncated. */
  detail: string
}

function clampReason(s: string): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= MAX_TAP_REASON ? t : t.slice(0, MAX_TAP_REASON - 1) + '…'
}

// `5dive --json` prints its refusal as {ok:false,error:{code,class,message}} on
// STDOUT while exiting non-zero — so on base (execFileP rejects) the useful text
// is on the rejection's .stdout, not its .message. Measured 2026-08-09:
// exit 4 / not_found and exit 5 / conflict both carry a full envelope.
function envelopeError(raw: unknown): { cls: string; message: string } | null {
  const s = String(raw ?? '')
  const i = s.indexOf('{')
  if (i < 0) return null
  try {
    const j = JSON.parse(s.slice(i))
    if (j && j.ok === false && j.error) {
      return { cls: String(j.error.class ?? j.error.code ?? ''), message: String(j.error.message ?? '') }
    }
  } catch {
    return null // not an envelope; caller falls through to the coarser signals
  }
  return null
}

// DIVE-4445: the CLI's own silent-exit backstop (`_report_silent_exit`, src/lib/
// output.sh) prints a CONTENTLESS envelope on STDOUT — measured on this box:
// {"ok":false,"error":{"code":126,"class":"generic","message":"5dive task exited
// 126 without reporting a reason. This is a bug in the CLI, not a refusal: …"}}
// — while the actual cause rides on STDERR. On 2026-09-13 a >128KB row made
// `task show --json` die with `/usr/bin/jq: Argument list too long`; the envelope
// branch won and lodar's tap told him "exited 126 without reporting a reason"
// with the reason in hand (DIVE-4419's incident, item 3). An envelope that states
// it has no reason is not evidence; a stderr line is.
const SILENT_EXIT_RE = /exited \d+ without reporting a reason/i

// The first line that actually says something. Skips the backstop's own stderr
// echo of that same contentless message (the trap prints it AFTER the real
// cause) and execFile's `Command failed: <argv>` preamble, which is our own
// command line, not a diagnosis.
function firstCause(raw: unknown): string {
  return String(raw ?? '')
    .split('\n')
    .map(l => l.trim().replace(/^error:\s*/i, ''))
    .find(l => l && !SILENT_EXIT_RE.test(l) && !/^Command failed:/i.test(l)) ?? ''
}

// Classify the thrown thing. Deliberately signal-driven rather than
// message-sniffing where a signal exists: `killed`/`signal` is how Node reports
// its own timeout kill, and 'ENOENT' is a code, not prose. Prose is only read
// where nothing structured survives — notably the forks, whose run5dive() throws
// `new Error(envelope.error.message)` (DIVE-2623) and keeps no code or stdout.
export function describeTapError(err: unknown): TapErrorInfo {
  const e = (err ?? {}) as Record<string, any>
  const message = String(e?.message ?? err ?? '').trim()
  const stdout = String(e?.stdout ?? '')
  const stderr = String(e?.stderr ?? '')
  const code = e?.code
  const parts = [message, stdout && `stdout: ${stdout.trim()}`, stderr && `stderr: ${stderr.trim()}`]
  const detail = parts.filter(Boolean).join(' | ') || 'unknown error'

  if (e?.killed === true || e?.signal === 'SIGTERM' || /ETIMEDOUT|timed? ?out/i.test(message)) {
    return { kind: 'timeout', short: 'the 5dive CLI timed out', detail }
  }
  if (code === 'ENOENT') {
    return { kind: 'missing', short: 'the 5dive CLI was not found on this box', detail }
  }
  if (/^sudo:/m.test(stderr) || /^sudo:/m.test(message)) {
    const line = (stderr || message).split('\n').find(l => l.startsWith('sudo:')) ?? 'sudo refused'
    return { kind: 'sudo', short: clampReason(line), detail }
  }
  const env = envelopeError(stdout) ?? envelopeError(message)
  const silent = !!env && SILENT_EXIT_RE.test(env.message)
  const why = firstCause(stderr) || firstCause(message)
  if (env && !silent) {
    return { kind: 'refused', short: clampReason(`5dive refused: ${env.message || env.cls || 'no reason given'}`), detail }
  }
  // DIVE-4445: a backstop envelope says, in prose, that it has no reason — so it
  // must not outrank a stderr line that has one. This branch also has to come
  // BEFORE the JSON sniff below: the failing command line itself contains
  // `--json`, so /JSON/i matches every tap read and would re-bury the cause as
  // 'something unreadable'.
  if (why && (silent || typeof code === 'number')) {
    return { kind: silent ? 'error' : 'refused', short: clampReason(`5dive exited ${code ?? '?'}: ${why}`), detail }
  }
  if (env) {
    // A backstop envelope and no cause anywhere: its prose is all anyone has.
    // Still ahead of the sniff below, which our own `--json` argv would trip.
    return { kind: 'error', short: clampReason(`5dive exited ${code ?? '?'}: ${env.message || env.cls || 'no reason given'}`), detail }
  }
  if (err instanceof SyntaxError || /JSON|Unexpected token/i.test(message)) {
    return { kind: 'unreadable', short: 'the 5dive CLI answered with something unreadable', detail }
  }
  if (typeof code === 'number') {
    return { kind: 'refused', short: clampReason(`5dive exited ${code}`), detail }
  }
  return { kind: 'error', short: clampReason(message || 'unknown error'), detail }
}

// What the gate says AFTER the failure. 'unknown' is a first-class answer, not a
// fallback: telling a human "did not apply" when we could not re-read is the same
// unproven claim the old copy made, one step further in.
export type TapLanding =
  | 'applied' // the gate is answered now — the tap landed, the confirmation didn't
  | 'open'    // the gate is still open and unanswered — nothing was recorded
  | 'unknown' // the re-read failed, or the gate is gone: we cannot say either way

export function tapLanding(recheckOk: boolean, task: TnaGate | null | undefined): TapLanding {
  if (!recheckOk || !task) return 'unknown'
  if (task.need_answered_at) return 'applied'
  // No gate at all: withdrawn or deleted between tap and re-read. Not 'open', and
  // not evidence the tap applied — so say so rather than pick the flattering one.
  if (!task.need_type) return 'unknown'
  return 'open'
}

// A task ident is what a human can look up; the numeric id is what `task answer`
// takes. Printing `DIVE-<internal id>` conflated the two and named a task that
// either does not exist or, worse, is a REAL DIFFERENT task: measured 2026-08-09,
// internal id 2846 is ident DIVE-2659. So an unknown ident degrades to `task #<id>`
// rather than minting a plausible-looking one.
const IDENT_RE = /^[A-Z][A-Z0-9]*-\d+$/
export function tapRef(taskId: string, ident?: string | null): string {
  const t = String(ident ?? '').trim()
  return IDENT_RE.test(t) ? t : `task #${taskId}`
}

export interface TapFailureCopy {
  /** answerCallbackQuery text — under Telegram's 200-char cap by construction. */
  toast: string
  /** The chat fallback the human actually reads. */
  chat: string
  /** One line for stderr + the durable tap-failure record. */
  log: string
}

export function tapFailureCopy(o: {
  taskId: string
  ident?: string | null
  err: TapErrorInfo
  landing: TapLanding
  /** need_answer as re-read — only meaningful when landing === 'applied'. */
  answer?: string | null
  /** How the re-read itself failed, if it did. */
  recheckDetail?: string | null
}): TapFailureCopy {
  const ref = tapRef(o.taskId, o.ident)
  const onBox = `sudo 5dive task answer ${o.taskId} --value="<your choice>"` +
    `  (approval: approved|denied · secret gate: omit --value)`
  const value = String(o.answer ?? '').trim()

  let toast: string
  let chat: string
  if (o.landing === 'applied') {
    toast = 'Applied after all — details in chat.'
    chat =
      `✅ That tap DID land on ${ref}${value ? ` (gate now reads: ${value})` : ''} — nothing to redo.\n` +
      `The bot lost the confirmation, not the answer: ${o.err.short}.`
  } else if (o.landing === 'open') {
    toast = "Couldn't apply — fallback sent in chat."
    chat =
      `Couldn't apply that tap for ${ref} — ${o.err.short}.\n` +
      `Re-read just now: the gate is STILL OPEN, so nothing was recorded.\n` +
      `On the box (as claude/root):\n${onBox}`
  } else {
    toast = "Couldn't confirm — fallback sent in chat."
    chat =
      `Couldn't apply that tap for ${ref} — ${o.err.short}.\n` +
      `Re-reading the gate also failed, so I can't tell whether it applied — check before re-answering.\n` +
      `On the box (as claude/root):\nsudo 5dive task show ${o.taskId}\n${onBox}`
  }

  const log = [
    `tap failed for ${ref} (id ${o.taskId})`,
    `kind=${o.err.kind}`,
    `landing=${o.landing}`,
    `err=${o.err.detail}`,
    o.recheckDetail ? `recheck_err=${o.recheckDetail}` : '',
  ].filter(Boolean).join(' · ')

  return { toast, chat, log }
}
