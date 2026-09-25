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
import {
  taskStateLines, cardGateAction, resolveCardTap, optionsTag, relTime, deliveryUrl, isParked,
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

async function card(task: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const envelope = JSON.stringify({ ok: true, data: { task, subtasks: [], blocked_by: [], ...extra } })
  const realNow = Date.now
  Date.now = () => NOW
  try {
    const make = new Function(
      'read5diveStdout', 'taskAssignedToMe', 'InlineKeyboard',
      'taskStateLines', 'cardGateAction', 'deliveryUrl', 'isParked', 'DASHBOARD_TASKS_URL',
      `${FN_JS}\nreturn buildTaskDetail`,
    )
    const buildTaskDetail = make(
      async () => envelope, () => false, KB,
      taskStateLines, cardGateAction, deliveryUrl, isParked, DASHBOARD_TASKS_URL,
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
    expect(text).toContain('answer it right here')
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
    expect(text).toContain('hard gate')
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

describe('DIVE-4949: gates with no card control', () => {
  test('secret and manual: text route only', async () => {
    for (const need_type of ['secret', 'manual']) {
      const { kb } = await card({ ...DECISION_T1, need_type, need_options: null })
      expect(kb!.flat.some(b => /^(gans|gresend):/.test(b.callback_data ?? ''))).toBe(false)
    }
  })
  test('a gate routed to an agent (needs_human=0): not his to answer', async () => {
    const { kb } = await card({ ...DECISION_T1, needs_human: 0, routed_reviewer: 'ops' })
    expect(kb!.flat.some(b => /^(gans|gresend):/.test(b.callback_data ?? ''))).toBe(false)
  })
})

describe('DIVE-4949 arm (c): a parked row says why and when, and can be woken', () => {
  test('reason + relative and absolute wake time render', async () => {
    const { text } = await card(PARKED)
    expect(text).toContain('⏸ parked — wakes in 5h (2026-09-25 11:00:00 UTC)')
    expect(text).toContain('why: floor 1.10.4 merged; boxes converge at their nightly pass')
  })
  test('⏰ Wake now is offered, and routes to `task unpark`', async () => {
    const { kb } = await card(PARKED)
    expect(kb!.flat.find(b => b.callback_data === 'twake:5200')?.text).toBe('⏰ Wake now')
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
    expect(text).toContain('gate: ANSWERED approve (lead:ops, 2026-09-24 09:28:23) — CARD RETIRED by park at 2026-09-24 11:47:27')
    expect(text).not.toContain('Full record:')
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
