import { readFileSync } from 'fs'
import type { TranscriptContentBlock, TranscriptEntry } from './types'

// Read a JSONL transcript file into entries. Malformed lines are silently
// dropped — claude occasionally writes a partial line that we'll see again
// on the next read. Returns [] on file-not-found.
export function readEntries(transcriptPath: string): TranscriptEntry[] {
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const out: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip
    }
  }
  return out
}

// Find the most-recent rate-limit notice text. claude logs it as a
// synthetic assistant message tagged error="rate_limit" with
// isApiErrorMessage=true; the text content carries the verbatim
// "resets Xpm (TZ)" line claude received from the 429 response.
// Immune to the tmux alt-screen issue that hides the pane line when the
// "Stop and wait" menu is showing.
// How far back from the tail we'll trust a rate-limit reset line. The
// relevant message is always at the tail — claude emits the synthetic
// api-error and *stops*, which is what fires StopFailure — so a small window
// captures it. Critically, it must NOT reach rate-limit messages from an
// *earlier* limit episode in the same long-lived session: those carry a stale
// clock time (e.g. this morning's "resets 9:10am") that parseResetEpoch then
// bumps to *tomorrow*, producing an absurd ~18h wait. Bounding the scan also
// makes the flush race safe: if the current synthetic entry hasn't been
// written to the transcript yet when the hook fires, we return null (caller
// retries / falls back) instead of silently reusing a stale earlier line.
const RATE_LIMIT_LOOKBACK = 40

export function findRateLimitText(entries: TranscriptEntry[]): string | null {
  const from = Math.max(0, entries.length - RATE_LIMIT_LOOKBACK)
  // Primary: the synthetic message claude tags error="rate_limit". Most
  // reliable when present. Bounded to the recent window (see above).
  for (let i = entries.length - 1; i >= from; i--) {
    const e = entries[i]
    if (e.error !== 'rate_limit' || !e.isApiErrorMessage) continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
    }
  }
  // Fallback: the tag isn't guaranteed (weekly/5h-limit phrasings, upstream
  // changes). Scan the same recent window's text blocks for a line that
  // carries an actual reset clue — a clock time or a "reset/try again in …"
  // phrase — and return it for parseResetEpoch to interpret. Kept specific to
  // avoid returning unrelated prose.
  const RESET_TIME = /resets?\b|reset (?:at|in)\b|try again (?:at|in)\b|\bin\s+\d+\s*(?:h|m|hour|min|sec)|\d{1,2}(?::\d{2})?\s*(?:am|pm)/i
  for (let i = entries.length - 1; i >= from; i--) {
    const content = entries[i].message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && RESET_TIME.test(block.text)) {
        return block.text
      }
    }
  }
  return null
}

// Per-turn analysis for stop-reply-check. A turn starts at the most-recent
// entry where type=user AND .message.content is a STRING — that pattern is
// the initial real user/channel prompt (tool_result feedback also has
// type=user but content is an array, so it's excluded). Within the turn:
//   - hadInbound: any user content (initial OR system-reminder embedded in
//     a tool_result) contains a telegram <channel> block.
//   - hadTool: any assistant tool_use called one of the telegram MCP tools.
//   - hadSend: a strict subset of hadTool — reply or edit_message only
//     (react / download_attachment don't count as a text answer).
//   - texts: every non-empty assistant text block in turn order.
//   - lastChatId / lastMessageId / lastThreadId: from the most-recent inbound
//     (lastThreadId is the forum-topic id, null outside a non-General topic).
export type TurnAnalysis = {
  turnStart: number
  hadInbound: boolean
  hadTool: boolean
  hadSend: boolean
  texts: string[]
  lastChatId: string | null
  lastMessageId: string | null
  lastThreadId: string | null
  // DIVE-1323: this turn was triggered by an inter-agent (a2a) envelope
  // `[5dive-msg from=X ...]` (injected via UserPromptSubmit, carries no
  // telegram <channel> tag) AND no human telegram inbound landed in the turn.
  // Such a turn's reply belongs back on the a2a channel (`5dive agent send`),
  // NOT the paired human's DM — so both the silence-watchdog nag and the
  // stop-reply-check relay must be suppressed for it. A MIXED turn (a2a start
  // + a human DM arriving mid-turn) sets hadInbound=true → a2aTurn=false, so
  // the human is still answered.
  a2aTurn: boolean
}

// Matches the inter-agent envelope prefix that `5dive agent send` injects as
// the turn's opening user prompt, e.g. `[5dive-msg from=main id=abc tier=...]`.
// Anchored to `from=` so a stray literal in human prose can't false-positive.
export const A2A_ENVELOPE_RE = /\[5dive-msg\s+from=\S+/

// DIVE-3445: the <channel> tag is TEXT, so anything that can put text into a
// user entry can forge one. Measured 2026-08-16 (olivia, then reproduced here
// against this file): an a2a message whose BODY merely QUOTES the tag sets
// hadInbound, which flips `a2aTurn = a2aTurnStart && !hadInbound` to false and
// walks the turn straight past the a2a exemption in stop-reply-check — and, if
// the quoted tag carries a chat_id, hands that turn's transcript text to a chat
// the SENDER chose. The recipient calls no tool and never sees it happen.
//
// The discriminator available in the transcript is position: the harness injects
// a real inbound as the WHOLE opening prompt, so its tag sits at offset 0, while
// an a2a envelope by construction opens with `[5dive-msg from=…`. So inside an
// envelope only an anchored tag counts — and an envelope cannot start with both,
// which is what makes this exact.
//
// DELIBERATELY NOT anchoring every entry. A mid-turn human DM does not arrive at
// offset 0, and the MIXED-turn case — an a2a envelope opens the turn, a human DM
// lands during it — is a real path this must keep answering. Narrowing it would
// trade a content-injection hole for a SILENCE one, which is the strictly worse
// of the two (DIVE-3422).
//
// The embedded-in-a-tool_result half of that path did not work AT ALL until
// DIVE-3448: array content was normalised with JSON.stringify, which escapes the
// inner quotes, so `source="` never matched `source=\"`. It is now read by
// entryTexts below, block by block, so no escaping is in play. It was NOT fixed
// by teaching this pattern to match its own JSON encoding — that would make
// every tool_result quoting a tag an inbound with a sender-chosen destination,
// which is precisely the hole DIVE-3445 closed, re-entered from the other side.
//
// Provenance is still being INFERRED from text either way. A structural marker on
// the harness-injected entry is the real fix and needs the harness side; the
// allowlist check in ./telegram sendMessage is what holds until then.
const CHANNEL_TAG_RE_G = /source="plugin:telegram:telegram"[^>]*/g
const ANCHORED_TAG_RE = /^\s*<channel source="plugin:telegram:telegram"[^>]*>/

// The channel tags in this user-entry content that may be TRUSTED as harness
// provenance, in document order. Shared by analyzeTurn and access.getCallerChat
// so the two can never disagree about what counts as an inbound.
export function trustedChannelTags(content: string): string[] {
  if (A2A_ENVELOPE_RE.test(content) && !ANCHORED_TAG_RE.test(content)) return []
  return content.match(CHANNEL_TAG_RE_G) ?? []
}

// DIVE-3448: the readable texts of a user entry, as SEPARATE documents.
//
// A user entry's content is either a plain string (the turn-opening prompt) or
// an array of blocks — which is how a mid-turn human DM actually arrives: the
// harness appends a `{type:'text'}` block holding the <system-reminder> that
// wraps the <channel> tag. Both call sites used to normalise the array half
// with JSON.stringify, which ESCAPES the inner quotes, so the literal `source="`
// the pattern requires could never match `source=\"` and the embedded case that
// analyzeTurn's docblock claims to cover has never once fired.
//
// Fixed by reading the blocks instead of dumping them, so no escaping is in
// play. NOT by teaching the pattern to match its own JSON encoding — that would
// make any tool output quoting a tag an inbound with a sender-chosen chat id,
// which is DIVE-3445's hole re-entered from the other side. The ESCAPED-form arm
// in test/dive3445-tag-provenance.test.ts is the anchor that keeps it shut.
//
// ONLY `{type:'text'}` blocks. A tool_result's payload is arbitrary command
// output (a grep hit, a cat of this very file) and is deliberately left unread:
// widening to it would hand every tool that prints a tag the ability to set a
// turn's relay destination.
export function entryTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
}

// trustedChannelTags over a whole user-entry content, string or array.
//
// The a2a-envelope provenance rule is evaluated ACROSS the entry, not per block:
// if any text in it opens an inter-agent envelope, every text in that entry must
// carry its tag anchored at offset 0 to be trusted. Splitting the envelope and
// the tag into two blocks is otherwise a way to walk around DIVE-3445 layer 1.
// For string content this is byte-for-byte the old behaviour.
export function trustedChannelTagsForEntry(content: unknown): string[] {
  const texts = entryTexts(content)
  const inEnvelope = texts.some((t) => A2A_ENVELOPE_RE.test(t))
  const out: string[] = []
  for (const t of texts) {
    if (inEnvelope && !ANCHORED_TAG_RE.test(t)) continue
    out.push(...(t.match(CHANNEL_TAG_RE_G) ?? []))
  }
  return out
}

export function analyzeTurn(entries: TranscriptEntry[], tgPrefix: string): TurnAnalysis {
  // Find turn start.
  let turnStart = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'user' && typeof e.message?.content === 'string') {
      turnStart = i
      break
    }
  }
  const turn = entries.slice(turnStart)

  // DIVE-1323: capture the turn-opening prompt string to detect an a2a
  // envelope. turnStart is the most-recent type=user with STRING content —
  // exactly where `5dive agent send` drops its `[5dive-msg from=X]` header.
  const turnStartContent =
    typeof entries[turnStart]?.message?.content === 'string'
      ? (entries[turnStart].message!.content as string)
      : ''
  const a2aTurnStart = A2A_ENVELOPE_RE.test(turnStartContent)

  // Match the full opening tag, then pull chat_id / message_id /
  // message_thread_id from within it. chat_id is -?\d+ so negative group
  // ids match (a bare \d+ silently dropped the leading '-'); thread id is
  // optional and read from the SAME tag so it's always paired with its chat.
  // DIVE-3445: WHICH tags may be trusted is decided by trustedChannelTags
  // above, not by their shape — a quoted tag matches the shape just as well.

  let hadInbound = false
  let hadTool = false
  let hadSend = false
  const texts: string[] = []
  let lastChatId: string | null = null
  let lastMessageId: string | null = null
  let lastThreadId: string | null = null

  for (const e of turn) {
    if (e.type === 'user') {
      // DIVE-3448: array content is walked block-by-block, not JSON-dumped, so
      // a mid-turn DM embedded in a tool_result turn is actually seen.
      const tag = trustedChannelTagsForEntry(e.message?.content ?? '')[0]
      if (tag) {
        hadInbound = true
        const cm = /chat_id="(-?\d+)"/.exec(tag)
        if (cm) lastChatId = cm[1]
        const mm = /message_id="(\d+)"/.exec(tag)
        if (mm) lastMessageId = mm[1]
        const tm = /message_thread_id="(-?\d+)"/.exec(tag)
        lastThreadId = tm ? tm[1] : null
      }
    } else if (e.type === 'assistant') {
      const content = e.message?.content
      if (!Array.isArray(content)) continue
      // Join all text blocks in this assistant message and push as one entry
      // (matches the bash behavior: per-message text join, not per-block).
      const joined = content
        .filter((b: TranscriptContentBlock) => b.type === 'text' && typeof b.text === 'string')
        .map((b: TranscriptContentBlock) => b.text!)
        .join('\n')
      if (joined.length > 0) texts.push(joined)
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(tgPrefix)) {
          hadTool = true
          if (block.name === `${tgPrefix}reply` || block.name === `${tgPrefix}edit_message`) {
            hadSend = true
          }
        }
      }
    }
  }

  // a2a turn = opened by an a2a envelope AND no human telegram inbound landed
  // anywhere in the turn (a mid-turn human DM flips hadInbound → still reply).
  const a2aTurn = a2aTurnStart && !hadInbound

  return { turnStart, hadInbound, hadTool, hadSend, texts, lastChatId, lastMessageId, lastThreadId, a2aTurn }
}

// Scan transcript entries past a given line index for any telegram tool
// call. Used by stop-reply-check's re-entry path to decide whether the
// agent recovered after we blocked it.
export function hadTelegramToolCallAfter(entries: TranscriptEntry[], startIdx: number, tgPrefix: string): boolean {
  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(tgPrefix)) {
        return true
      }
    }
  }
  return false
}
