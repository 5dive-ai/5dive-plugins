// DIVE-3279 (lodar, 2026-08-11): "need to post it one by one when i call /inbox -
// not like a messy mesh list in one message".
//
// THE DEFECT. `buildActionableInbox` returned ONE {text, keyboard}: every gate's
// card concatenated by clampList into a single message, under a single merged
// keyboard carrying one ✅ per clearable gate. DIVE-2712 had already made exactly
// this fix on the CLI's PUSH path (`_task_inbox_send`), so the founder was getting a
// clean one-per-gate stack from the hard-gate digest DM and a mesh from /inbox in
// the same chat — the split never existed on the plugin's PULL path.
//
// Two properties are locked here, and the second is the one that is easy to lose:
//
//   1. the view is BUILT as one message per gate, and
//   2. the gclear tap does not REBUILD the whole view into the tapped message.
//
// Without (2) the split survives exactly one tap: the handler used to answer a
// clear by editing the tapped message with a freshly-rebuilt full inbox, which
// would re-mesh every remaining gate into the message the founder just cleared.
//
// WHY A SOURCE-TEXT LOCK. server.ts long-polls on import (see banner.test.ts), so
// buildActionableInbox cannot be called headlessly; inbox-source.test.ts and
// parity.test.ts set the precedent for grading fork text directly.
//
// WHY EVERY LINEAGE. telegram-{codex,pi} are hand-maintained forks and
// telegram-agy is generated from telegram-grok; the shared region is copied, not
// imported. Porting this change to the forks with an unscoped regex silently
// DELETED buildActionableInbox from 4 of the 5 lineages (`buildInboxList` sits
// directly above it and shares both anchor lines verbatim), and the only thing
// that caught it was inbox-source.test.ts's own per-lineage arms. The parity arm
// at the bottom is that guard, kept for this change too.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LINEAGES = ['telegram', 'telegram-grok', 'telegram-agy', 'telegram-codex', 'telegram-pi']

function source(fork: string): string {
  return readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
}

/** The body of buildActionableInbox, bounded at the next top-level declaration —
 *  same extractor as inbox-source.test.ts, so a later function's clampList call
 *  (buildInboxList legitimately has one) can never satisfy these arms. */
function actionableInbox(fork: string): string {
  const src = source(fork)
  const start = src.indexOf('async function buildActionableInbox(')
  expect(start, `${fork}: buildActionableInbox not found`).toBeGreaterThan(-1)
  const rest = src.slice(start + 1)
  const endRel = rest.search(/\n(async function|function|const|\/\/ ---) /)
  return rest.slice(0, endRel > -1 ? endRel : rest.length)
}

describe.each(LINEAGES)('DIVE-3279 /inbox posts one message per gate (%s)', (fork) => {
  const fn = actionableInbox(fork)

  test('returns an ARRAY of messages, not a single view', () => {
    expect(fn).toContain('Promise<{ text: string; keyboard?: InlineKeyboard }[]>')
    // The pre-fix signature, which is what a careless revert would restore.
    expect(fn).not.toContain('Promise<{ text: string; keyboard?: InlineKeyboard }> {')
  })

  test('builds one message per gate from pending', () => {
    expect(fn).toContain('const messages: { text: string; keyboard?: InlineKeyboard }[] = pending.map(')
    expect(fn).toContain('return messages')
  })

  test('no merged keyboard: each clearable gate carries its own single ✅', () => {
    expect(fn).toContain('new InlineKeyboard().text(`✅ ${t.ident}: ${recShort}`, `gclear:${t.id}`)')
    // The merged-keyboard shape: N buttons accumulated onto one markup with .row()
    // separators. That is what made one tap able to retire every other gate's button.
    expect(fn).not.toContain('keyboard!.row()')
    expect(fn).not.toContain('soft.forEach(')
  })

  test('does not clampList across gates — a large inbox must not hide gates behind "(+N more)"', () => {
    // clampList DROPS overflow lines. Across gates that silently hides the very
    // thing this view exists to surface; per-message there is no cap pressure.
    expect(fn).not.toContain('clampList(')
    expect(fn).not.toContain('const cards = pending.map(')
  })

  test('the set-level trailer is its own message, not hung off the last gate', () => {
    expect(fn).toContain('messages.push(')
    // DIVE-3224/3228 regression guard: the withheld count must still be reported.
    expect(fn).toContain('routedNote')
    expect(fn).toContain('digestNote')
  })
})

describe.each(LINEAGES)('DIVE-3279 the split is not undone downstream (%s)', (fork) => {
  const src = source(fork)

  test('gclear retires only the tapped message — it does not rebuild the view into it', () => {
    // The exact pre-fix shape: ack the clear, then rebuild the whole inbox and
    // edit it into the one message that carried the tapped gate.
    expect(src).not.toMatch(
      /answerCallbackQuery\(\{ text: '✅ Applied your recommendation' \}\)[\s\S]{0,400}?buildActionableInbox\(senderId\)/,
    )
    expect(src).toContain('✅ Cleared — your recommendation was applied.')
  })

  test('the send site iterates the messages and pings only on the first', () => {
    expect(src).toContain('const views = await buildActionableInbox(')
    expect(src).toContain('for (const [i, view] of views.entries())')
    // The push-count trade DIVE-2712 made: N gates cost one buzz, not N.
    expect(src).toContain('...(i > 0 ? { disable_notification: true } : {})')
    // The pre-fix single send, which would now only ever deliver message[0].
    expect(src).not.toContain('await ctx.reply(view.text, view.keyboard ?')
  })

  // Raised by main at review of 65975db: with one message per gate the send is a
  // BURST, and an unguarded loop that throws on any one of them delivers the
  // first K gates and no trailer. A partial inbox that does not say it is partial
  // is the failure this whole command exists to prevent, and the trailer's
  // absence is the only tell. A property of N, not of the render — which is why
  // it is locked here rather than left to be noticed once the open set grows.
  test('a failed send does not abort the stack, and the trailer reports what was lost', () => {
    expect(src).toContain('let undelivered = 0')
    expect(src).toContain('undelivered++')
    expect(src).toContain('could not be delivered — re-run /inbox')
    // A 429 carries its own backoff; ignoring it just compounds the limit for
    // every remaining gate in the stack.
    expect(src).toContain("Number((err as any)?.parameters?.retry_after ?? 0)")
  })

  // Main, on the residual's own residual: every gate message is counted and
  // reported by the trailer, and NOTHING counts the trailer. A 429 on it alone
  // restores the original failure mode — a partial inbox with no tell — narrowed
  // to one message. It is the only message that gets a retry, and deliberately so:
  // re-sending a gate message into a limit you just hit is the worse trade.
  test('the trailer — the message that reports the others — gets one bounded retry', () => {
    expect(src).toContain('if (isTrailer) {')
    expect(src).toContain('one bounded retry, then stop rather than spin on the limit')
    // The shape that would silently drop it: counting non-trailers and doing
    // nothing whatsoever for the trailer's own failure.
    expect(src).not.toContain('if (!isTrailer) undelivered++\n')
  })
})

test('DIVE-3279 every lineage got the same patch (no fork left behind)', () => {
  const shapes = LINEAGES.map((f) => {
    const fn = actionableInbox(f)
    const src = source(f)
    return [
      fn.includes('Promise<{ text: string; keyboard?: InlineKeyboard }[]>'),
      fn.includes('const messages: { text: string; keyboard?: InlineKeyboard }[] = pending.map('),
      !fn.includes('clampList('),
      !fn.includes('keyboard!.row()'),
      fn.includes('messages.push('),
      src.includes('for (const [i, view] of views.entries())'),
      src.includes('✅ Cleared — your recommendation was applied.'),
      src.includes('one bounded retry, then stop rather than spin on the limit'),
    ].join('/')
  })
  expect(new Set(shapes).size).toBe(1)
  expect(shapes[0]).toBe('true/true/true/true/true/true/true/true')
})
