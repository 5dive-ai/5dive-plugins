// DIVE-4949 (lodar, 2026-09-25): the /task_<id> card answers gates with buttons and
// says why a row is blocked, what it delivered, who grades it and how old it is.
//
// TWO LAYERS, both executed rather than text-locked:
//   1. taskcard.ts is pure, so its functions are imported and called directly.
//   2. buildTaskDetail is EXTRACTED from server.ts (which long-polls on import, see
//      banner.test.ts) and run against fixture `task show --json` envelopes with its
//      free names stubbed. That grades the card a reader actually receives — text AND
//      keyboard — for each of the row's four "done when" arms.
// Plus the router: each new callback prefix must be handled, and must shell the verb
// the row names (answer over --channel-proof / inbox --send --only / task unpark).
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as TC from '../plugins/telegram/taskcard.ts'
import {
  taskStateLines, cardGateAction, resolveCardTap, optionsTag, relTime, deliveryUrl, isParked,
  resultSummary, stripMarkdown, fitCard, cronWords, CARD_BUDGET,
  DASHBOARD_TASKS_URL, GANS_RE, GRESEND_RE, TWAKE_RE,
} from '../plugins/telegram/taskcard.ts'

const SRC = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const NOW = Date.parse('2026-09-25T06:00:00Z')

// ---------------------------------------------------------------------------
// Minimal InlineKeyboard: CI has no plugin deps, and the card only uses these four.
class KB {
  rows: { text: string; callback_data?: string; url?: string }[][] = [[]]
  text(text: string, data: string) { this.rows[this.rows.length - 1]!.push({ text, callback_data: data }); return this }
  url(text: string, url: string) { this.rows[this.rows.length - 1]!.push({ text, url }); return this }
  row() { if (this.rows[this.rows.length - 1]!.length) this.rows.push([]); return this }
  get flat() { return this.rows.flat() }
}

/** The whole buildTaskDetail declaration, brace-balanced from its signature. */
function extractFn(src: string, sig: string): string {
  const start = src.indexOf(sig)
  expect(start, `${sig} not found`).toBeGreaterThan(-1)
  const open = src.indexOf('> {', start) + 2 // past the Promise<{…}> return type
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(start, k + 1) }
  }
  throw new Error('unbalanced')
}

// Transpiled, because the function carries TS annotations `new Function` cannot parse.
const FN_JS = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  extractFn(SRC, 'async function buildTaskDetail(') + '\nexport { buildTaskDetail }',
).replace(/export\s*\{[^}]*\};?\s*$/, '')

async function card(task: Record<string, unknown>, extra: Record<string, unknown> = {}, humans: unknown[] = []) {
  const envelope = JSON.stringify({ ok: true, data: { task, subtasks: [], blocked_by: [], ...extra } })
  const realNow = Date.now
  Date.now = () => NOW
  try {
    // Every taskcard export is in scope, as it is in server.ts via the import.
    const names = Object.keys(TC)
    const make = new Function(
      'read5diveStdout', 'read5diveJson', 'taskAssignedToMe', 'InlineKeyboard', ...names,
      `${FN_JS}\nreturn buildTaskDetail`,
    )
    const buildTaskDetail = make(
      async () => envelope,
      async (args: string[]) => (args[0] === 'human' ? { ok: true, data: { humans } } : null),
      () => false, KB, ...names.map(n => (TC as any)[n]),
    )
    const r = await buildTaskDetail(task.id)
    return { text: r.text as string, kb: r.keyboard as KB | undefined }
  } finally {
    Date.now = realNow
  }
}

const BASE = {
  id: 5200, ident: 'DIVE-5200', title: 'fixture row', status: 'in_progress', priority: 'high',
  assignee: 'dev', created_by: 'main', created_at: '2026-09-24 06:00:00', updated_at: '2026-09-25 05:00:00',
}
const DECISION_T1 = {
  ...BASE, status: 'blocked', need_type: 'decision', need_answered_at: null, tier: 1, gate_live: 1, needs_human: 1,
  ask: 'which surface ships first?', need_options: 'Ship the card first|Ship the inbox first', recommend: 'Ship the card first',
}
const APPROVAL_T1 = { ...DECISION_T1, need_type: 'approval', need_options: null, recommend: 'approved' }
const APPROVAL_T2 = { ...APPROVAL_T1, tier: 2 }
const PARKED = {
  ...BASE, status: 'blocked', parked_at: '2026-09-24 11:47:27', wake_at: '2026-09-25 11:00:00',
  park_reason: 'floor 1.10.4 merged; boxes converge at their nightly pass', gate_live: 0, needs_human: 0,
}
const DELIVERED = {
  ...BASE, status: 'todo', delivery_ref: 'https://github.com/5dive-ai/5dive-plugins/pull/116',
  delivered_at: '2026-09-24 10:50:36', graded_verdict: 'pass', graded_by: 'quinn',
  merge_landed_at: '2026-09-24 11:44:44', verifier: 'quinn', gate_live: 0, needs_human: 0,
  gate: "ANSWERED approve (lead:ops, 2026-09-24 09:28:23) — CARD RETIRED by park at 2026-09-24 11:47:27; the live row carries no gate. Full record: 5dive task gate-history DIVE-5200",
  result: 'RESULT-LINE shipped the card', body: 'B'.repeat(3000),
}

// ---------------------------------------------------------------------------
describe('DIVE-4949 arm (a): a tier<2 decision gate answers from the card', () => {
  test('one button per option, ⭐ on the recommendation, index + options tag in callback_data', async () => {
    const { text, kb } = await card(DECISION_T1)
    const gans = kb!.flat.filter(b => b.callback_data?.startsWith('gans:'))
    expect(gans.map(b => b.text)).toEqual(['⭐ Ship the card first', 'Ship the inbox first'])
    const tag = optionsTag(DECISION_T1.need_options)
    expect(gans.map(b => b.callback_data)).toEqual([`gans:5200:0:${tag}`, `gans:5200:1:${tag}`])
    expect(text).toContain('answer it right here — tap below')
    // the DIVE-3340 gate block still renders above it
    expect(text).toContain('PENDING DECISION GATE')
  })

  test('the tap resolves the index against the LIVE options into --value=<option text>', () => {
    const r = resolveCardTap(DECISION_T1, '1', optionsTag(DECISION_T1.need_options))
    expect(r).toEqual({ kind: 'answer', answerArgs: ['--value=Ship the inbox first'], ack: 'Ship the inbox first' })
  })

  test('a stale card is refused: options changed, gate answered, raised to tier 2, re-routed to an agent', () => {
    const tag = optionsTag(DECISION_T1.need_options)
    expect(resolveCardTap({ ...DECISION_T1, need_options: 'Ship the inbox first|Ship the card first' }, '1', tag).kind).toBe('stale')
    expect(resolveCardTap({ ...DECISION_T1, gate_live: 0, need_answered_at: '2026-09-25 05:00:00', need_answer: 'x' }, '0', tag).kind).toBe('stale')
    expect(resolveCardTap({ ...DECISION_T1, tier: 2 }, '0', tag).kind).toBe('stale')
    expect(resolveCardTap({ ...DECISION_T1, needs_human: 0 }, '0', tag).kind).toBe('stale')
    expect(resolveCardTap({ ...DECISION_T1 }, '7', tag).kind).toBe('stale')
  })

  test('a tier<2 approval gets Approve / Deny on the same rail', async () => {
    const { kb } = await card(APPROVAL_T1)
    const tag = optionsTag(null)
    expect(kb!.flat.filter(b => b.callback_data?.startsWith('gans:')).map(b => b.callback_data))
      .toEqual([`gans:5200:approved:${tag}`, `gans:5200:denied:${tag}`])
    expect(resolveCardTap(APPROVAL_T1, 'approved', tag)).toMatchObject({ kind: 'answer', answerArgs: ['--value=approved'] })
  })

  test('the router answers over --channel-proof, re-reads the row first, and never passes --channel-msg', () => {
    const i = SRC.indexOf('const gansM = GANS_RE.exec(data)')
    expect(i).toBeGreaterThan(-1)
    const block = SRC.slice(i, SRC.indexOf('const grsM = GRESEND_RE.exec(data)'))
    expect(block).toMatch(/'task', 'show', taskId\]/)
    expect(block).toContain('resolveCardTap(')
    expect(block).toMatch(/'task', 'answer', taskId, \.\.\.r\.answerArgs/)
    expect(block).toContain('`--channel-proof=${senderId}`')
    expect(block).toContain('tapEvidenceArgs(null')
    expect(block).not.toMatch(/--channel-msg=/)
    expect(block).toContain('buildTaskDetail(Number(taskId))')
  })
})

describe('DIVE-4949 arm (b): a tier-2 gate gets its CLI-minted card re-sent', () => {
  test('no plugin-minted answer control; one resend button instead', async () => {
    const { text, kb } = await card(APPROVAL_T2)
    expect(kb!.flat.some(b => b.callback_data?.startsWith('gans:'))).toBe(false)
    expect(kb!.flat.find(b => b.callback_data === 'gresend:5200')?.text).toContain('Send the answer buttons')
    expect(text).toContain('Send the answer buttons": the gate')
  })

  test('an UNKNOWN tier reads as hard (the CLI fail-safe direction), never as tier<2', () => {
    expect(cardGateAction({ ...APPROVAL_T1, tier: null }, true, true).kind).toBe('resend')
    expect(cardGateAction({ ...APPROVAL_T1, tier: '' }, true, true).kind).toBe('resend')
  })

  test('the router shells `task inbox --send --only=<id>` with the channel proof', () => {
    const i = SRC.indexOf('const grsM = GRESEND_RE.exec(data)')
    const block = SRC.slice(i, SRC.indexOf('const twM = TWAKE_RE.exec(data)'))
    expect(block).toMatch(/\['task', 'inbox', '--send', `--only=\$\{taskId\}`, `--channel-proof=\$\{senderId\}`/)
    expect(block).not.toContain("'answer'")
  })
})

describe('DIVE-4949: gates the card does not answer itself', () => {
  // Amendment 2 §5: the phone reader has no terminal, so a secret/manual gate gets the
  // CLI's own alert re-sent (its `provided` / `done` taps are nonce-sealed) — never a
  // plugin-minted answer, and never a value.
  test('secret and manual: the re-send button, no plugin-minted answer', async () => {
    for (const need_type of ['secret', 'manual']) {
      const { text, kb } = await card({ ...DECISION_T1, need_type, need_options: null })
      expect(kb!.flat.some(b => b.callback_data?.startsWith('gans:'))).toBe(false)
      expect(kb!.flat.some(b => b.callback_data === 'gresend:5200')).toBe(true)
      expect(text).not.toContain('5dive task answer')
    }
  })
  test('a free-text decision (no options) gets the re-send, not an empty button row', () => {
    expect(cardGateAction({ ...DECISION_T1, need_options: null }, true, true).kind).toBe('resend')
  })
  test('a gate routed to an agent (needs_human=0): not his to answer', async () => {
    const { kb } = await card({ ...DECISION_T1, needs_human: 0, routed_reviewer: 'ops' })
    expect(kb!.flat.some(b => /^(gans|gresend):/.test(b.callback_data ?? ''))).toBe(false)
  })
})

describe('DIVE-4949 arm (c): a parked row says why and when, and can be woken', () => {
  test('reason + relative and absolute wake time render', async () => {
    const { text } = await card(PARKED)
    expect(text).toContain('⏸ parked: floor 1.10.4 merged; boxes converge at their nightly pass · wakes in 5h')
  })
  test('⏰ Wake now REPLACES Do now on a parked row, and routes to `task unpark`', async () => {
    const { kb } = await card(PARKED)
    expect(kb!.flat.find(b => b.callback_data === 'twake:5200')?.text).toBe('⏰ Wake now')
    expect(kb!.flat.some(b => b.callback_data?.startsWith('donow:'))).toBe(false)
    const i = SRC.indexOf('const twM = TWAKE_RE.exec(data)')
    expect(i).toBeGreaterThan(-1)
    expect(SRC.slice(i, i + 800)).toMatch(/'task', 'unpark', taskId\]/)
  })
  test('an unparked row has no Wake now; open blockers are named', async () => {
    const { text, kb } = await card(BASE, { blocked_by: [{ ident: 'DIVE-9', status: 'in_progress' }, { ident: 'DIVE-8', status: 'done' }] })
    expect(kb!.flat.some(b => b.callback_data?.startsWith('twake:'))).toBe(false)
    expect(text).toContain('⛓ waiting on: DIVE-9 [in_progress]')
    expect(text).not.toContain('DIVE-8')
  })
})

describe('DIVE-4949 arm (d): a delivered row shows PR, grade and merge state', () => {
  test('one delivery line, verifier, last gate outcome, age', async () => {
    const { text } = await card(DELIVERED)
    expect(text).toContain('📦 5dive-plugins#116 · graded pass by quinn · merged 18h ago · owed a close')
    expect(text).toContain('verifier: quinn')
    expect(text).toContain('last gate: ANSWERED approve (lead:ops, 21h ago) — CARD RETIRED by park 18h ago')
    expect(text).not.toContain('Full record:')
    expect(text).not.toContain('gate-history')
    expect(text).toContain('age: created 24h ago · updated 1h ago')
  })
  test('Open PR + Dashboard URL buttons', async () => {
    const { kb } = await card(DELIVERED)
    expect(kb!.flat.find(b => b.text === '🔗 Open PR')?.url).toBe('https://github.com/5dive-ai/5dive-plugins/pull/116')
    expect(kb!.flat.find(b => b.text === '🗂 Dashboard')?.url).toBe(DASHBOARD_TASKS_URL)
  })
  test('the RESULT renders above the body, so the body clamp can no longer push it off', async () => {
    const { text } = await card(DELIVERED)
    expect(text.indexOf('result: RESULT-LINE')).toBeGreaterThan(-1)
    expect(text.indexOf('result: RESULT-LINE')).toBeLessThan(text.indexOf('BBBB'))
    expect(text.length).toBeLessThan(4096)
  })
  test('a closed row keeps its link buttons and gets no close/answer controls', async () => {
    const { kb } = await card({ ...DELIVERED, status: 'done' })
    expect(kb!.flat.map(b => b.text)).toEqual(['🔗 Open PR', '🗂 Dashboard'])
  })
  test('graded but not merged: no "owed a close"', () => {
    const l = taskStateLines({ ...DELIVERED, merge_landed_at: null }, [], false, NOW)
    expect(l.find(x => x.startsWith('📦'))).toBe('📦 5dive-plugins#116 · graded pass by quinn')
  })
})

describe('DIVE-4949 pure helpers', () => {
  test('relTime reads CLI UTC stamps', () => {
    expect(relTime('2026-09-25 11:00:00', NOW)).toBe('in 5h')
    expect(relTime('2026-09-25 05:59:30', NOW)).toBe('just now')
    expect(relTime('2026-09-22 06:00:00', NOW)).toBe('3d ago')
    expect(relTime('garbage', NOW)).toBeNull()
  })
  test('a past wake reads as due, not as "in"', () => {
    const l = taskStateLines({ ...PARKED, wake_at: '2026-09-25 04:00:00' }, [], false, NOW)
    expect(l[0]).toContain('wake was due 2h ago')
  })
  test('resultSummary keeps the first paragraph only', () => {
    expect(resultSummary('Shipped it. Works.\nCHANGED: a.ts\nCHECKED: 3/3')).toBe('Shipped it. Works.')
    expect(resultSummary('First para.\n\nSecond para.')).toBe('First para.')
    expect(resultSummary('One.\n--- appended 2026-09-24 by a later write ---\nMore')).toBe('One.')
    expect(resultSummary('x'.repeat(900)).length).toBe(400)
  })
  test('stripMarkdown drops heading, bold and fence markers but keeps the words', () => {
    expect(stripMarkdown('## Ask\n**Axis:** org\n```\ncode\n```')).toBe('Ask\nAxis: org\n\ncode')
  })
  test('cronWords: simple shapes in words with a next run; anything else raw, no next run', () => {
    expect(cronWords('0 10 * * 1', NOW)).toEqual({ words: 'every Monday 10:00 UTC', next: Date.parse('2026-09-28T10:00:00Z') })
    expect(cronWords('30 7 * * *', NOW)).toEqual({ words: 'every day 07:30 UTC', next: Date.parse('2026-09-25T07:30:00Z') })
    expect(cronWords('*/15 * * * *', NOW)).toEqual({ words: 'cron `*/15 * * * *` (UTC)', next: null })
  })
  test('deliveryUrl ignores a bare sha', () => {
    expect(deliveryUrl({ delivery_ref: 'c6dfc756' })).toBeNull()
    expect(isParked({ ...PARKED, status: 'done' })).toBe(false)
  })
  test('every minted callback_data fits Telegram’s 64-byte cap and matches its router regex', () => {
    const big = { ...DECISION_T1, id: 999999999, need_options: Array.from({ length: 8 }, (_, i) => `option ${i} `.repeat(20)).join('|') }
    const a = cardGateAction(big, true, true)
    expect(a.kind).toBe('buttons')
    for (const b of (a as any).buttons) {
      expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64)
      expect(GANS_RE.test(b.data)).toBe(true)
    }
    expect(GRESEND_RE.test('gresend:999999999')).toBe(true)
    expect(TWAKE_RE.test('twake:999999999')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Amendments 1–4 (lodar + main, 2026-09-25 00:08–00:16Z).
const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/

describe('DIVE-4949 arm (e): a plain row (no PR, no verifier, no park) is no taller than before', () => {
  test('none of the delivery, verifier, park or Open PR elements; one age line added', async () => {
    const { text, kb } = await card({ ...BASE, body: 'short body' })
    expect(text).not.toContain('📦')
    expect(text).not.toContain('verifier:')
    expect(text).not.toContain('parked')
    expect(text).not.toContain('last gate:')
    expect(kb!.flat.some(b => b.text === '🔗 Open PR')).toBe(false)
    expect(text.split('\n')).toEqual([
      'DIVE-5200 (/task_5200) · fixture row', '',
      'status: in_progress  ·  priority: high', 'assignee: dev', 'created by: main', '',
      'age: created 24h ago · updated 1h ago', '',
      'short body', '', 'back to list: /tasks',
    ])
  })
})

// Modelled on /task_5114 and /task_5119 (7,181 and 8,903 chars through the old card):
// a long multi-section body and a result that accumulated appended deliveries and grades.
const LONG_BODY = ['## Ask', '**Axis:** org layer', 'x'.repeat(2400), '## Findings', 'y'.repeat(2400), '## Park note 12:45Z', 'WHY-PARKED ' + 'z'.repeat(2000)].join('\n\n')
const LONG_RESULT = 'SUMMARY-SENTENCE the fix has a version of its own.\nCHANGED: ' + 'c'.repeat(1500) +
  '\n\n--- appended 2026-09-24 09:59:45Z by a later write (DIVE-2483) ---\n' + 'g'.repeat(2500)
const ROW_5114_LIKE = { ...PARKED, ...DELIVERED, status: 'blocked', parked_at: '2026-09-24 11:47:27', wake_at: '2026-09-25 11:00:00',
  park_reason: 'floor merged; boxes converge nightly', body: LONG_BODY, result: LONG_RESULT, title: 'T'.repeat(190) }
const ROW_5119_LIKE = { ...DELIVERED, status: 'done', body: LONG_BODY + LONG_BODY, result: LONG_RESULT }

describe('DIVE-4949 arm (f): long rows fit a 3,900-char budget with the park line and the result summary', () => {
  test.each([['5114-like', ROW_5114_LIKE], ['5119-like', ROW_5119_LIKE]] as const)('%s', async (_n, row) => {
    const { text } = await card(row)
    expect(text.length).toBeLessThanOrEqual(CARD_BUDGET)
    expect(text).toContain('result: SUMMARY-SENTENCE the fix has a version of its own.')
    expect(text).not.toContain('CHANGED:')
    expect(text).not.toContain('--- appended')
    expect(text.endsWith('back to list: /tasks')).toBe(true)
    expect(text).toContain('…(truncated)')
    expect(text).not.toContain('## ')
    expect(text).not.toContain('**')
  })
  test('the park line survives on the 5114-like row, above the result', async () => {
    const { text } = await card(ROW_5114_LIKE)
    expect(text).toContain('⏸ parked: floor merged; boxes converge nightly · wakes in 5h')
    expect(text.indexOf('⏸ parked')).toBeLessThan(text.indexOf('result:'))
  })
  test('the title is clamped at 120 chars in the header', async () => {
    const { text } = await card(ROW_5114_LIKE)
    expect(text.split('\n')[0]).toBe(`DIVE-5200 (/task_5200) · ${'T'.repeat(119)}…`)
  })
  test('fitCard never exceeds its budget, even when the head alone overruns', () => {
    expect(fitCard(['h'.repeat(5000)], 'r', 'b', ['', 'back']).length).toBeLessThanOrEqual(CARD_BUDGET)
  })
})

describe('DIVE-4949 arm (g): every time on the card is relative', () => {
  test.each([
    ['parked', PARKED], ['delivered', DELIVERED], ['5114-like', ROW_5114_LIKE],
    ['recurring', { ...BASE, status: 'todo', kind: 'recurring', schedule: '0 10 * * 1', last_fired_at: '2026-09-21 10:00:15' }],
    ['answered gate', { ...BASE, gate: 'ANSWERED A (human:dev, 2026-09-24 20:00:00)' }],
  ] as const)('%s: no absolute timestamp outside the body', async (_n, row) => {
    const { text } = await card({ ...row, body: undefined, result: undefined })
    expect(text).not.toMatch(STAMP)
  })
})

describe('DIVE-4949 arm (h): "human owner" only on a box with two or more humans', () => {
  const OWNED = { ...BASE, human_owner: 'h-ana', human_owner_name: 'Ana' }
  const H = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h${i}` }))
  test('two humans: "human owner: <name>"', async () => {
    expect((await card(OWNED, {}, H(2))).text).toContain('human owner: Ana')
  })
  test.each([0, 1])('%i human(s): no line', async (n) => {
    expect((await card(OWNED, {}, H(n))).text).not.toContain('human owner')
  })
  test('owner unset on a two-human box: no line, never "none"', async () => {
    const { text } = await card(BASE, {}, H(2))
    expect(text).not.toContain('human owner')
  })
  test('an owner with no display name falls back to the id', async () => {
    expect((await card({ ...OWNED, human_owner_name: undefined }, {}, H(3))).text).toContain('human owner: h-ana')
  })
})

describe('DIVE-4949 arm (i): a recurring template shows its schedule and offers nothing that ends it', () => {
  const TPL = { ...BASE, status: 'todo', kind: 'recurring', schedule: '0 10 * * 1', last_fired_at: '2026-09-21 10:00:15' }
  test('schedule in words, last run, next run', async () => {
    const { text } = await card(TPL)
    expect(text).toContain('🔁 recurring template: every Monday 10:00 UTC · last run 4d ago · next run in 3d')
  })
  test('no Done, Cancel, Do now or Escalate — Dashboard link only', async () => {
    const { kb } = await card(TPL)
    expect(kb!.flat.map(b => b.text)).toEqual(['🗂 Dashboard'])
  })
})

describe('DIVE-4949: a live gate hides Done and Cancel', () => {
  test('gated row: no tdone/tcancel; ungated open row: both', async () => {
    const gated = await card(DECISION_T1)
    expect(gated.kb!.flat.some(b => /^(tdone|tcancel):/.test(b.callback_data ?? ''))).toBe(false)
    const plain = await card(BASE)
    expect(plain.kb!.flat.filter(b => /^(tdone|tcancel):/.test(b.callback_data ?? '')).length).toBe(2)
  })
})
