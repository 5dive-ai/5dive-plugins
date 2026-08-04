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
// It runs the matrix against the REAL resolver each plugin ships (every telegram
// plugin imports the same tna.ts), and asserts they are byte-identical so a fork
// can never silently drift from base.
//
// DIVE-2374: PLUGINS is DISCOVERED, not listed. It used to be the literal
// ['telegram','telegram-grok','telegram-codex','telegram-agy'] — so telegram-pi
// and telegram-opencode, which also ship a tna.ts, were never asserted against.
// Both had drifted to a greedy TNA_RE, both were missing tapEvidenceArgs, and
// worse, neither server.ts ROUTED `tna:` at all: no gate of any type was
// clearable from Telegram on those runtimes, and had never been. A parity fence
// that works by naming its members cannot fail for a member it does not name,
// which makes the omission invisible rather than red. Globbing plugins/*/tna.ts
// means adding a plugin enrolls it in its own test; the only way out is to not
// ship a tna.ts. See also assertRoutesTna below — file-level parity alone would
// still have passed here, because the missing piece was in server.ts.

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS_DIR = join(import.meta.dir, '..', 'plugins')
const TNA_DIR = (p: string) => join(PLUGINS_DIR, p, 'tna.ts')
const SERVER_TS = (p: string) => join(PLUGINS_DIR, p, 'server.ts')

// Every plugin that ships a tna.ts is in scope, base first so parity diffs read
// as "fork drifted from base". Sorted for a stable test order.
const DISCOVERED = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(TNA_DIR(d.name)))
  .map(d => d.name)
  .sort()
const PLUGINS = ['telegram', ...DISCOVERED.filter(p => p !== 'telegram')] as const

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
    // DIVE-2467: the stale-tap copy is no longer mirrored here. server.ts now
    // renders r.toast/r.edit verbatim, so passing them through means these
    // assertions grade the text each plugin SHIPS. A mirror can only ever pin
    // what the test believes the adapter says (see assertRendersSettledDetail,
    // which pins that the adapter really does defer to these fields).
    case 'already':
      return { matched: true as const, taskId, kind: r.kind, toast: r.toast, edit: r.edit }
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
  need_answered_by: null,
  ...over,
})

// DIVE-2374: the discovery above is an INPUT to every loop in this file, so an
// empty or wrong resolution would make the whole suite pass vacuously — a bug
// class we have shipped before (a control that reads "I was given nothing" as
// "there is nothing"). These two assertions are the floor: the base must be
// found, and the plugins known to ship a tna.ts must all be enrolled. Adding a
// plugin does NOT require touching this list; removing one from disk without
// deleting it here is the only way to red, which is the intended direction.
const MUST_BE_ENROLLED = [
  'telegram', 'telegram-grok', 'telegram-codex', 'telegram-agy',
  'telegram-pi', 'telegram-opencode',
] as const

describe('DIVE-2374: the plugin list is discovered, and discovery actually resolved', () => {
  test('discovery found the telegram base', () => {
    expect(DISCOVERED, 'plugins/*/tna.ts resolved to nothing — every loop below would pass vacuously')
      .toContain('telegram')
    expect(PLUGINS[0]).toBe('telegram')
  })

  test('every plugin known to ship a tna.ts is enrolled', () => {
    for (const p of MUST_BE_ENROLLED) {
      expect(PLUGINS, `${p} ships a tna.ts but is not enrolled in the tna harness`).toContain(p)
    }
    expect(mods.length).toBe(PLUGINS.length)
  })
})

// DIVE-2374: file-level parity of tna.ts is NOT enough, and this is the check
// whose absence let the real defect live. telegram-pi/opencode both shipped a
// tna.ts, so a parity test over those files would have graded them (had they
// been named) — but their server.ts never IMPORTED TNA_RE and never called
// resolveTnaAnswer, so the module was dead code and every gate tap fell through
// the callback router unanswered. Shipping the module is not wiring the route.
// server.ts long-polls on import, so this is a deliberate STATIC assertion —
// the strongest thing available without booting a bot.
function assertRoutesTna(plugin: string) {
  const src = readFileSync(SERVER_TS(plugin), 'utf8')
  for (const symbol of ['TNA_RE', 'resolveTnaAnswer', 'tapEvidenceArgs']) {
    expect(src.includes(symbol), `${plugin}/server.ts never references ${symbol} — the tna: gate route is not wired`)
      .toBe(true)
  }
  expect(/TNA_RE\.exec\(/.test(src), `${plugin}/server.ts imports TNA_RE but never execs it`).toBe(true)
  expect(/resolveTnaAnswer\(/.test(src), `${plugin}/server.ts never calls resolveTnaAnswer`).toBe(true)
  expect(/tapEvidenceArgs\(/.test(src), `${plugin}/server.ts never calls tapEvidenceArgs — taps would record agent provenance`)
    .toBe(true)
  // The answer must be re-resolved from the LIVE gate, not the payload.
  expect(/task['"],\s*['"]show['"]|task show/.test(src), `${plugin}/server.ts tna route never re-reads the gate`)
    .toBe(true)
}

describe('DIVE-2374: every plugin WIRES the tna: route in server.ts, not just ships tna.ts', () => {
  for (const p of PLUGINS) {
    test(`${p}: server.ts routes tna: taps through the shipped resolver`, () => {
      assertRoutesTna(p)
    })
  }
})

describe('tna.ts parity across base + forks', () => {
  test('every plugin tna.ts is byte-identical to the base', () => {
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
      // No-nonce taps (decision index / approval / secret / manual) — 3rd group undefined.
      expect(mod.TNA_RE.exec('tna:42:provided')?.slice(1, 4)).toEqual(['42', 'provided', undefined])
      expect(mod.TNA_RE.exec('tna:7:2')?.slice(1, 4)).toEqual(['7', '2', undefined])
      // DIVE-916: a hard-gate tap carries the per-gate nonce as an optional 3rd
      // field (32 lowercase hex); the token itself stays colon-free.
      expect(mod.TNA_RE.exec('tna:9:approved:0123456789abcdef0123456789abcdef')?.slice(1, 4))
        .toEqual(['9', 'approved', '0123456789abcdef0123456789abcdef'])
      expect(mod.TNA_RE.exec('tna:3:provided:00112233445566778899aabbccddeeff')?.[3])
        .toBe('00112233445566778899aabbccddeeff')
      // DIVE-2369: the same shape with a numeric OPTION INDEX as the token — what a
      // tier-2 `decision` tap actually sends since the CLI began appending the nonce
      // to the decision buttons too. Every case above pairs the nonce with a WORD
      // token (approved/provided), and an index parsed correctly without a nonce, so
      // no assertion here ever pinned index-AND-nonce together. That is precisely the
      // combination the old greedy `/^tna:(\d+):(.+)$/` got wrong: it yields the token
      // '0:<nonce>', which resolves against no option and silently drops the tap.
      expect(mod.TNA_RE.exec('tna:42:0:0123456789abcdef0123456789abcdef')?.slice(1, 4))
        .toEqual(['42', '0', '0123456789abcdef0123456789abcdef'])
      expect(mod.TNA_RE.exec('tna:42:11:00112233445566778899aabbccddeeff')?.slice(1, 4))
        .toEqual(['42', '11', '00112233445566778899aabbccddeeff'])
      expect(mod.TNA_RE.exec('yn:yes')).toBeNull()
      expect(mod.TNA_RE.exec('model:opus')).toBeNull()
      expect(mod.TNA_RE.exec('tna:abc:x')).toBeNull()       // non-numeric id
      expect(mod.TNA_RE.exec('tna:1:')).toBeNull()          // empty token
      expect(mod.TNA_RE.exec('tna:9:approved:notavalidnonce')).toBeNull() // malformed nonce → fail closed
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
    | { kind: 'already'; prior: string; edit: string; toast: string }
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
  // DIVE-2410/2467: a stale tap names WHEN and WHO settled the gate. These two
  // carry need_answered_by, which is what a real `task show --json` returns
  // alongside need_answered_at (measured on DIVE-2400: 'human:marketing').
  { name: 'already answered (decision) → already w/ prior value, when + who', gate: { need_type: 'decision', need_answer: 'Ship now', need_answered_at: '2026-06-14 07:00:00', need_answered_by: 'human:marketing' }, token: '0',
    expect: { kind: 'already', prior: 'Ship now',
      toast: 'Already answered 2026-06-14 07:00 UTC by human:marketing.',
      edit: '✅ already answered: Ship now (2026-06-14 07:00 UTC by human:marketing)' } },
  { name: 'already answered (secret) → already, prior masked, when + who', gate: { need_type: 'secret', need_answered_at: '2026-06-14 07:00:00', need_answered_by: 'auto:ttl' }, token: 'provided',
    expect: { kind: 'already', prior: '(provided)',
      toast: 'Already answered 2026-06-14 07:00 UTC by auto:ttl.',
      edit: '✅ already answered: (provided) (2026-06-14 07:00 UTC by auto:ttl)' } },
  // A degraded row must still answer distinguishably: a gate answered before
  // need_answered_by existed names the when alone, with no dangling 'by'.
  { name: 'already answered, no provenance → names the when only', gate: { need_type: 'approval', need_answer: 'approved', need_answered_at: '2026-06-14 07:00:00' }, token: 'approved',
    expect: { kind: 'already', prior: 'approved',
      toast: 'Already answered 2026-06-14 07:00 UTC.',
      edit: '✅ already answered: approved (2026-06-14 07:00 UTC)' } },
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
          // DIVE-2467: BOTH surfaces are pinned. The toast is the only thing a
          // human who never scrolls back actually sees, and it was the surface
          // DIVE-2410 reported as indistinguishable from silence.
          expect(tap.edit).toBe(c.expect.edit)
          expect(tap.toast).toBe(c.expect.toast)
          expect(tap.edit).toContain(c.expect.prior)
        }
      })
    }
  }
})

// DIVE-2467: settledDetail is the whole of the when/who rendering, so its edges
// are pinned directly rather than only through the two matrix rows above. The
// degraded cases matter most: every one of them used to be the string
// 'Already answered.', which is what a human reads as nothing having happened.
describe('DIVE-2467: settledDetail names when + who, and degrades without lying', () => {
  for (const mod of mods) {
    test(`${mod.name}: renders, drops seconds, and labels UTC`, () => {
      const d = mod.settledDetail as (a?: string | null, b?: string | null) => string
      // The CLI's own format (date -u '+%Y-%m-%d %H:%M:%S'), measured on DIVE-2400.
      expect(d('2026-07-30 04:28:04', 'human:marketing')).toBe('2026-07-30 04:28 UTC by human:marketing')
      // Either half alone still says something a human can act on.
      expect(d('2026-07-30 04:28:04', null)).toBe('2026-07-30 04:28 UTC')
      expect(d(null, 'auto:reject')).toBe('by auto:reject')
      // Nothing to say → empty, so the caller falls back to the bare sentence
      // rather than emitting a dangling '()' or the word 'by' with no subject.
      expect(d(null, null)).toBe('')
      expect(d('   ', '  ')).toBe('')
      // A shape we did NOT verify as UTC is passed through verbatim: labelling an
      // unknown timestamp ' UTC' would be inventing a fact about the record.
      expect(d('yesterday', 'human:olivia')).toBe('yesterday by human:olivia')
      expect(d('2026-07-30T04:28:04Z', 'human:olivia')).toBe('2026-07-30 04:28 UTC by human:olivia')
      // The raw provenance prefix survives: 'human:marketing' must not become
      // 'marketing', which would credit the relaying agent with the human's answer.
      expect(d('2026-07-30 04:28:04', 'human:marketing')).toContain('human:')
    })

    test(`${mod.name}: a long provenance token cannot blow the 200-char toast cap`, () => {
      // answerCallbackQuery rejects text over 200 chars and every call site is
      // .catch(() => {}) — an over-long toast would restore the exact silence
      // this change removes, so the truncation is load-bearing, not cosmetic.
      const r = mod.resolveTnaAnswer(
        gate({ need_type: 'approval', need_answer: 'approved', need_answered_at: '2026-07-30 04:28:04', need_answered_by: `lead:standing:${'x'.repeat(300)}` }),
        'approved',
      )
      expect(r.kind).toBe('already')
      expect(r.toast.length).toBeLessThanOrEqual(200)
      expect(r.toast).toContain('2026-07-30 04:28 UTC')
    })
  }
})

// DIVE-2623: base shells `task answer` via execFileP, which REJECTS the promise
// on any non-zero exit, so its catch block (the fallback that DIVE-2260 taught
// to render the closed-row detail) fires correctly. The 5 run5dive-based forks
// instead call a local helper that RESOLVES with the CLI's {ok:false,...} JSON
// envelope even on a refusal (`fail()` in 5dive-cli writes it to stdout under
// --json) — so a bare `await run5dive(['task','answer',...])` with no result
// check swallows every task-answer failure and tells the human "✅ answered" as
// if the tap succeeded, with the catch block never running. Static fence, same
// reasoning as assertRoutesTna: server.ts long-polls on import, so this is the
// strongest check available without booting a bot.
const RUN5DIVE_PLUGINS = PLUGINS.filter(p => p !== 'telegram')

function assertChecksAnswerResult(plugin: string) {
  const src = readFileSync(SERVER_TS(plugin), 'utf8')
  const idx = src.indexOf("run5dive(['task', 'answer'")
  expect(idx, `${plugin}/server.ts has no run5dive(['task','answer'...]) call`).toBeGreaterThan(-1)
  const window = src.slice(idx, idx + 300)
  expect(/\.ok\)\s*throw/.test(window),
    `${plugin}/server.ts calls run5dive(['task','answer'...]) but never checks .ok and throws — ` +
    `a CLI refusal resolves as success and the tna catch block never fires`)
    .toBe(true)
}

describe('DIVE-2623: every run5dive-based plugin throws on an ok:false task-answer envelope', () => {
  for (const p of RUN5DIVE_PLUGINS) {
    test(`${p}: server.ts checks .ok after run5dive(['task','answer'...]) so the catch block can fire`, () => {
      assertChecksAnswerResult(p)
    })
  }
})

// DIVE-2467: the copy now lives in tna.ts, which only helps if every adapter
// actually defers to it. Same reasoning as assertRoutesTna — shipping the module
// is not wiring it — applied to rendering: a fork that quietly reverted to the
// hardcoded 'Already answered.' would pass the whole matrix above, because the
// matrix drives tna.ts directly and never reads server.ts.
function assertRendersSettledDetail(plugin: string) {
  const src = readFileSync(SERVER_TS(plugin), 'utf8')
  expect(src.includes('text: r.toast'), `${plugin}/server.ts stale-tap toast does not use r.toast — the when/who detail is dropped`)
    .toBe(true)
  expect(src.includes('ctx.editMessageText(r.edit)'), `${plugin}/server.ts stale-tap edit does not use r.edit`)
    .toBe(true)
  expect(src.includes('`✅ already answered: ${r.prior}`'), `${plugin}/server.ts still formats the stale-tap message itself — it drifted back off the shared copy`)
    .toBe(false)
}

describe('DIVE-2467: every plugin RENDERS the stale-tap detail, not just resolves it', () => {
  for (const p of PLUGINS) {
    test(`${p}: server.ts defers the stale-tap copy to the shared resolver`, () => {
      assertRendersSettledDetail(p)
    })
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

// DIVE-1115: the evidence flags a verified-human tap attaches to `task answer`.
// The bug this guards: the tap handler used to push --human ONLY for
// approval/secret/manual, so a `decision`/`manual` tap recorded a BARE AGENT
// name in need_answered_by — invisible to the digest's zero-human KPI (it counts
// only `human:*`) and unprovable as human on tier-2 gates. The fix marks EVERY
// tap --human (allowFrom already vetted the tapper as a human upstream).
describe('DIVE-1115: tapEvidenceArgs — every verified-human tap is --human', () => {
  for (const mod of mods) {
    test(`${mod.name}: exports tapEvidenceArgs`, () => {
      expect(typeof mod.tapEvidenceArgs, mod.name).toBe('function')
    })

    test(`${mod.name}: a decision tap (no nonce) still carries --human`, () => {
      // The regression: decision gates mint no nonce, so humanProof is empty.
      // Pre-fix this produced [] → bare agent provenance. Post-fix: ['--human'].
      for (const noNonce of [undefined, null, '']) {
        expect(mod.tapEvidenceArgs(noNonce), `humanProof=${JSON.stringify(noNonce)}`)
          .toEqual(['--human'])
      }
    })

    test(`${mod.name}: a hard gate tap forwards --human-proof alongside --human`, () => {
      const nonce = '0123456789abcdef0123456789abcdef'
      expect(mod.tapEvidenceArgs(nonce)).toEqual(['--human', `--human-proof=${nonce}`])
    })
  }
})
