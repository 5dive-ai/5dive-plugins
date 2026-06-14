// DIVE-369: synthetic-tap harness for the `tna:` (tap-to-answer) callback line.
//
// WHY THIS EXISTS: tap-button features (DIVE-117/332/335/356) used to need a
// human finger in Telegram to confirm "does the button actually fire" — there
// was no headless way to simulate an inline-button tap (callback_query). That
// human-in-the-loop check gated the whole tap line. This harness kills that
// bottleneck: it injects a synthetic tap (a `tna:<id>:<token>` callback_data
// string + a live-gate snapshot) and asserts the FULL round-trip the bot would
// run — parse the callback_data, resolve against the gate, and emit the exact
// `5dive task answer` argv + the user-facing ack/UI text — with no bot boot, no
// Telegram, and no live DB.
//
// It runs the matrix against the REAL resolver each plugin ships (telegram base +
// grok/codex/agy forks import the same tna.ts), and asserts the four tna.ts are
// byte-identical so a fork can never silently drift from base.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = ['telegram', 'telegram-grok', 'telegram-codex', 'telegram-agy'] as const
const TNA_DIR = (p: string) => join(import.meta.dir, '..', 'plugins', p, 'tna.ts')

// Import each plugin's shipped resolver so the matrix runs against real code,
// not a copy. (Importing server.ts is unsafe — it long-polls on import — which
// is exactly why the logic was extracted into the import-safe tna.ts.)
const mods = await Promise.all(
  PLUGINS.map(async p => ({ name: p, ...(await import(TNA_DIR(p))) })),
)

// Mirror server.ts's thin I/O adapter: turn a parsed resolution into the exact
// side effects the bot performs (the `5dive task answer` argv + the ack toast +
// the edited message text). This is the "round-trip" a real tap produces. Base
// shells `sudo -n 5dive --json task answer <id> ...`; forks call `5dive task
// answer <id> ... --json` — both reduce to the same answer argv tail, which is
// what we assert.
function simulateTap(mod: any, gate: any, callbackData: string) {
  const m = mod.TNA_RE.exec(callbackData)
  if (!m) return { matched: false as const }
  const taskId = m[1]
  const token = m[2]
  const r = mod.resolveTnaAnswer(gate, token)
  switch (r.kind) {
    case 'nogate':
      return { matched: true as const, taskId, kind: r.kind, toast: 'This task no longer has a gate.' }
    case 'already':
      return { matched: true as const, taskId, kind: r.kind, toast: 'Already answered.', edit: `✅ already answered: ${r.prior}` }
    case 'invalid':
      return { matched: true as const, taskId, kind: r.kind, toast: 'That option is no longer valid.' }
    case 'answer':
      return {
        matched: true as const,
        taskId,
        kind: r.kind,
        // The full CLI invocation the tap fires (transport-agnostic tail).
        cliArgs: ['task', 'answer', taskId, ...r.answerArgs],
        answerArgs: r.answerArgs,
        toast: `Answered: ${r.ack}`,
        edit: `✅ answered: ${r.ack}`,
      }
  }
}

const gate = (over: Record<string, unknown> = {}) => ({
  need_type: null,
  need_options: null,
  need_answer: null,
  need_answered_at: null,
  ...over,
})

describe('tna.ts parity across base + forks', () => {
  test('all four tna.ts are byte-identical', () => {
    const texts = PLUGINS.map(p => readFileSync(TNA_DIR(p), 'utf8'))
    for (let i = 1; i < texts.length; i++) {
      expect(texts[i], `${PLUGINS[i]}/tna.ts drifted from ${PLUGINS[0]}/tna.ts`).toBe(texts[0])
    }
  })

  test('every plugin exports TNA_RE + resolveTnaAnswer', () => {
    for (const mod of mods) {
      expect(typeof mod.resolveTnaAnswer, mod.name).toBe('function')
      expect(mod.TNA_RE instanceof RegExp, mod.name).toBe(true)
    }
  })
})

describe('TNA_RE callback_data parsing', () => {
  for (const mod of mods) {
    test(`${mod.name}: parses tna:<id>:<token>, rejects foreign data`, () => {
      expect(mod.TNA_RE.exec('tna:42:provided')?.slice(1, 3)).toEqual(['42', 'provided'])
      expect(mod.TNA_RE.exec('tna:7:2')?.slice(1, 3)).toEqual(['7', '2'])
      // Tokens with separators survive (decision values can contain colons/spaces).
      expect(mod.TNA_RE.exec('tna:9:ship it: now')?.slice(1, 3)).toEqual(['9', 'ship it: now'])
      expect(mod.TNA_RE.exec('yn:yes')).toBeNull()
      expect(mod.TNA_RE.exec('model:opus')).toBeNull()
      expect(mod.TNA_RE.exec('tna:abc:x')).toBeNull() // non-numeric id
      expect(mod.TNA_RE.exec('tna:1:')).toBeNull()    // empty token
    })
  }
})

// The decision matrix — every gate type × token, asserted on every plugin so a
// fork can't diverge. Each case names the synthetic tap and its expected effect.
const CASES: Array<{
  name: string
  gate: Record<string, unknown>
  token: string
  expect:
    | { kind: 'answer'; answerArgs: string[]; ack: string }
    | { kind: 'nogate' | 'invalid' }
    | { kind: 'already'; prior: string }
}> = [
  // secret — the DIVE-356 keystone: NO --value ever (key must not enter chat/db).
  { name: 'secret + provided → answer with no --value', gate: { need_type: 'secret' }, token: 'provided',
    expect: { kind: 'answer', answerArgs: [], ack: 'provided' } },
  { name: 'secret + garbage token → invalid', gate: { need_type: 'secret' }, token: 'leaked-key-value',
    expect: { kind: 'invalid' } },
  // manual — answers --value=done.
  { name: 'manual + done → answer --value=done', gate: { need_type: 'manual' }, token: 'done',
    expect: { kind: 'answer', answerArgs: ['--value=done'], ack: 'done' } },
  { name: 'manual + wrong token → invalid', gate: { need_type: 'manual' }, token: 'finished',
    expect: { kind: 'invalid' } },
  // decision — token is an INDEX resolved against the live need_options.
  { name: 'decision idx 0 → first option', gate: { need_type: 'decision', need_options: 'Ship now|Wait|Cancel' }, token: '0',
    expect: { kind: 'answer', answerArgs: ['--value=Ship now'], ack: 'Ship now' } },
  { name: 'decision idx 2 → third option', gate: { need_type: 'decision', need_options: 'Ship now|Wait|Cancel' }, token: '2',
    expect: { kind: 'answer', answerArgs: ['--value=Cancel'], ack: 'Cancel' } },
  { name: 'decision trims + drops empties before indexing', gate: { need_type: 'decision', need_options: ' A | B || C ' }, token: '2',
    expect: { kind: 'answer', answerArgs: ['--value=C'], ack: 'C' } },
  { name: 'decision out-of-range index → invalid', gate: { need_type: 'decision', need_options: 'A|B' }, token: '5',
    expect: { kind: 'invalid' } },
  // approval — approved/denied only.
  { name: 'approval + approved', gate: { need_type: 'approval' }, token: 'approved',
    expect: { kind: 'answer', answerArgs: ['--value=approved'], ack: 'approved' } },
  { name: 'approval + denied', gate: { need_type: 'approval' }, token: 'denied',
    expect: { kind: 'answer', answerArgs: ['--value=denied'], ack: 'denied' } },
  { name: 'approval + foreign token → invalid', gate: { need_type: 'approval' }, token: 'maybe',
    expect: { kind: 'invalid' } },
  // race / lifecycle guards.
  { name: 'no gate (task closed) → nogate', gate: { need_type: null }, token: 'provided',
    expect: { kind: 'nogate' } },
  { name: 'already answered (decision) → already w/ prior value', gate: { need_type: 'decision', need_answer: 'Ship now', need_answered_at: '2026-06-14 07:00:00' }, token: '0',
    expect: { kind: 'already', prior: 'Ship now' } },
  { name: 'already answered (secret) → already, prior masked', gate: { need_type: 'secret', need_answered_at: '2026-06-14 07:00:00' }, token: 'provided',
    expect: { kind: 'already', prior: '(provided)' } },
]

describe('synthetic tap → resolution matrix (all plugins)', () => {
  for (const mod of mods) {
    for (const c of CASES) {
      test(`${mod.name}: ${c.name}`, () => {
        const tap = simulateTap(mod, gate(c.gate), `tna:13:${c.token}`)!
        expect(tap.matched).toBe(true)
        expect(tap.kind).toBe(c.expect.kind)
        if (c.expect.kind === 'answer') {
          expect(tap.answerArgs).toEqual(c.expect.answerArgs)
          expect(tap.cliArgs).toEqual(['task', 'answer', '13', ...c.expect.answerArgs])
          expect(tap.toast).toBe(`Answered: ${c.expect.ack}`)
        } else if (c.expect.kind === 'already') {
          expect(tap.edit).toBe(`✅ already answered: ${c.expect.prior}`)
        }
      })
    }
  }
})

describe('security invariants the tap line must hold', () => {
  for (const mod of mods) {
    test(`${mod.name}: a secret answer never carries a --value`, () => {
      // No token, however crafted, may turn a secret gate into a value-bearing
      // answer — the raw key must never reach the CLI/db via callback_data.
      for (const token of ['provided', 'KEY=hunter2', 'sk-live-abc', '--value=leak', '']) {
        const r = mod.resolveTnaAnswer(gate({ need_type: 'secret' }), token)
        if (r.kind === 'answer') {
          expect(r.answerArgs, `secret leaked via token "${token}"`).toEqual([])
        }
      }
    })

    test(`${mod.name}: callback_data value is re-resolved from the gate, never trusted`, () => {
      // A decision tap carries only an index; the value comes from live need_options.
      // Tamper the index payload → still resolves to the gate's option, or invalid.
      const g = gate({ need_type: 'decision', need_options: 'Approve refund|Deny refund' })
      expect(mod.resolveTnaAnswer(g, '0').ack).toBe('Approve refund')
      expect(mod.resolveTnaAnswer(g, '99').kind).toBe('invalid')
    })
  }
})
