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

// ---------------------------------------------------------------------------
// DIVE-3178: the tap must SEND the attribution, not merely be able to receive it.
//
// The defect this pins is the one measured in the wild on 2026-08-10 (DIVE-3150):
// lodar tapped a tier-2 approval relayed through an agent's bot, the tap was real
// (nonce_valid=1, enforce=on), and the row recorded `unattributed:marketing` —
// proven human and unattributable at once, wearing the exact costume of an agent
// self-clear. It cost a held merge and two questions he should not have been asked.
//
// The CLI half (DIVE-3128) had shipped and was installed: `--tap-uid`,
// `--tap-username`, `--tap-msg` and `--relay-agent` all parsed. NOTHING SENT THEM.
// So `tap_uid=none` in that audit line is this argv builder emitting nothing, and
// the assertions below are on the ARGV — the artifact that was empty — rather than
// on the CLI's stamp, which was already correct and is covered on its own side.
//
// THE POSITIVE CONTROL IS `tapEvidenceArgs(nonce)` WITH NO SECOND ARGUMENT. That
// is not a convenience overload: it is byte-for-byte the call every server.ts made
// before this change, so the first test below IS the reverted plugin, and it must
// keep coming back with no attribution flags at all. A suite that only asserted
// the new path would pass just as well if the old path had never been the cause.
describe('DIVE-3178: tapEvidenceArgs — the tap SENDS who pressed it', () => {
  const NONCE = '0123456789abcdef0123456789abcdef'
  // Reserved fakes only (5dive CLAUDE.md): never a real person's Telegram id.
  const UID = '1234567890'

  for (const mod of mods) {
    test(`${mod.name}: CONTROL — the pre-fix call shape still emits NO attribution`, () => {
      // The exact argv that produced `unattributed:<agent>` in the wild.
      const args: string[] = mod.tapEvidenceArgs(NONCE)
      expect(args).toEqual(['--human', `--human-proof=${NONCE}`])
      expect(args.some((a: string) => a.startsWith('--tap-uid=')),
        'reverted call shape must NOT carry --tap-uid — otherwise this suite cannot tell the fix from its absence').toBe(false)
    })

    test(`${mod.name}: a full tap forwards uid, handle, message and relay`, () => {
      expect(mod.tapEvidenceArgs(NONCE, {
        uid: UID, username: 'tapper_person', messageId: 4242, osUser: 'agent-marketing',
      })).toEqual([
        '--human', `--human-proof=${NONCE}`,
        `--tap-uid=${UID}`, '--tap-username=tapper_person', '--tap-msg=4242',
        '--relay-agent=marketing',
      ])
    })

    test(`${mod.name}: a decision tap (no nonce) still carries the attribution`, () => {
      // Decisions mint no nonce. Pre-fix they were the WORST case: --human with a
      // bare agent name and nothing to correct it with.
      expect(mod.tapEvidenceArgs('', { uid: UID, osUser: 'agent-marketing' }))
        .toEqual(['--human', `--tap-uid=${UID}`, '--relay-agent=marketing'])
    })

    test(`${mod.name}: the relay is the agent name, never the OS user verbatim`, () => {
      expect(mod.relayAgentName('agent-marketing')).toBe('marketing')
      expect(mod.relayAgentName('claude')).toBe('claude')
      expect(mod.relayAgentName(undefined)).toBe('')
      // The relay must land in --relay-agent and NOWHERE else: folding it into the
      // human stamp is precisely the failure DIVE-3128 refuses.
      const args: string[] = mod.tapEvidenceArgs(NONCE, { uid: UID, osUser: 'agent-marketing' })
      expect(args.filter((a: string) => a.includes('marketing'))).toEqual(['--relay-agent=marketing'])
    })

    test(`${mod.name}: a '@handle' is normalised; junk fields are DROPPED, not forwarded`, () => {
      expect(mod.tapEvidenceArgs(null, { username: '@tapper_person', osUser: 'agent-dev' }))
        .toEqual(['--human', '--tap-username=tapper_person', '--relay-agent=dev'])
      // Each malformed field drops on its own without taking the others with it —
      // a relay must never ship a malformed identity into a provenance column, and
      // must never lose a good one because a neighbour was bad.
      expect(mod.tapEvidenceArgs(null, {
        uid: '12; rm -rf /', username: 'no', messageId: 'x9', osUser: 'agent-dev',
      })).toEqual(['--human', '--relay-agent=dev'])
      // Absent context is the legacy caller: unchanged, and still no attribution.
      expect(mod.tapEvidenceArgs(null, undefined)).toEqual(['--human'])
      expect(mod.tapEvidenceArgs(null, {})).toEqual(['--human'])
    })
  }

  // File-level fence, in the shape DIVE-2374 forced: a parity test that names its
  // members cannot fail for a member it does not name. Every DISCOVERED plugin's
  // server.ts must actually PASS a tap context — exporting the capability and never
  // calling it with one is exactly the two-artifact half-landing this row is about.
  for (const plugin of DISCOVERED) {
    test(`${plugin}/server.ts passes the tap context to tapEvidenceArgs`, () => {
      const src = readFileSync(SERVER_TS(plugin), 'utf8')
      const call = /tapEvidenceArgs\(([^)]*(?:\{[\s\S]*?\})?[^)]*)\)/.exec(src)
      expect(call, `${plugin}/server.ts never calls tapEvidenceArgs`).toBeTruthy()
      const argv = call![1]
      for (const field of ['uid:', 'username:', 'messageId:', 'osUser:']) {
        expect(argv.includes(field), `${plugin}/server.ts tap context is missing ${field}`).toBe(true)
      }
      expect(/uid:\s*ctx\.callbackQuery\.from/.test(argv),
        `${plugin}/server.ts must read the tapper off callback_query.from — anything the relay CHOOSES is not attribution`).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// DIVE-2846: a tap that reports "Couldn't apply" must leave a record naming the
// exception, name the REAL ident, and not assert a failure it never confirmed.
//
// The regression it pins: `catch {` with no binding. Two of lodar's taps failed
// on 2026-08-06 and the cause is gone for good — no exception kept, no plugin
// log to fall back on. The error shapes below are MEASURED (2026-08-09) off the
// real CLI on this box, not invented: an execFile timeout kill, an ENOENT, and
// `sudo -n 5dive --json task answer` refusing with exit 4 / not_found and exit
// 5 / conflict, each carrying its envelope on STDOUT while exiting non-zero.
// ---------------------------------------------------------------------------

// Measured: `sudo -n 5dive --json task answer 999999 --value=zzz`
const REFUSAL_ENVELOPE = '{"ok":false,"error":{"code":4,"class":"not_found","message":"no such task: 999999"}}\n'
const MEASURED_REFUSAL = {
  code: 4,
  killed: false,
  signal: null,
  message: 'Command failed: sudo -n 5dive --json task answer 999999 --value=zzz\nerror: no such task: 999999\n',
  stdout: REFUSAL_ENVELOPE,
  stderr: 'error: no such task: 999999\n',
}
// Measured: execFileP('sleep', ['3'], { timeout: 300 })
const MEASURED_TIMEOUT = { code: null, killed: true, signal: 'SIGTERM', message: 'Command failed: sleep 3', stdout: '', stderr: '' }
// Measured: execFileP('/nonexistent/5dive', ...)
const MEASURED_ENOENT = { code: 'ENOENT', message: "ENOENT: no such file or directory, posix_spawn '/nonexistent/5dive'", stdout: '', stderr: '' }

describe('DIVE-2846: describeTapError keeps the exception and names a cause', () => {
  for (const mod of mods) {
    test(`${mod.name}: classifies the measured CLI failure shapes`, () => {
      expect(mod.describeTapError(MEASURED_TIMEOUT).kind).toBe('timeout')
      expect(mod.describeTapError(MEASURED_ENOENT).kind).toBe('missing')
      expect(mod.describeTapError(MEASURED_REFUSAL).kind).toBe('refused')
      expect(mod.describeTapError({ code: 1, stderr: 'sudo: a password is required\n' }).kind).toBe('sudo')
      expect(mod.describeTapError(new SyntaxError('Unexpected token < in JSON at position 0')).kind).toBe('unreadable')
    })

    test(`${mod.name}: a refusal's short line carries the CLI's OWN reason`, () => {
      // The whole point: 'sudo failed' vs 'gate already answered' vs 'timeout'
      // are three different things for the human to do next.
      expect(mod.describeTapError(MEASURED_REFUSAL).short).toContain('no such task: 999999')
      const conflict = {
        code: 5,
        stdout: '{"ok":false,"error":{"code":5,"class":"conflict","message":"DIVE-2659 has no pending human gate (nothing to answer)"}}\n',
        stderr: 'error: DIVE-2659 has no pending human gate (nothing to answer)\n',
        message: 'Command failed',
      }
      expect(mod.describeTapError(conflict).short).toContain('no pending human gate')
      expect(mod.describeTapError({ code: 1, stderr: 'sudo: a password is required\n' }).short).toContain('sudo:')
    })

    test(`${mod.name}: the forks' DIVE-2623 bare-Error shape still yields a reason`, () => {
      // run5dive RESOLVES on ok:false, so the forks re-throw `new Error(msg)`
      // with no code, no stdout, no stderr. A classifier that only reads
      // structured fields would report 'unknown error' on five of six plugins.
      const info = mod.describeTapError(new Error('DIVE-2659 has no pending human gate (nothing to answer)'))
      expect(info.short).toContain('no pending human gate')
      expect(info.detail).toContain('no pending human gate')
    })

    test(`${mod.name}: detail is never empty — that is the record the old catch never kept`, () => {
      for (const e of [MEASURED_TIMEOUT, MEASURED_ENOENT, MEASURED_REFUSAL, new Error('boom'), undefined, null, 'raw string']) {
        expect(mod.describeTapError(e).detail.length, `empty detail for ${JSON.stringify(e)}`).toBeGreaterThan(0)
      }
      // The envelope must survive into the log even though `short` is clamped.
      expect(mod.describeTapError(MEASURED_REFUSAL).detail).toContain('not_found')
    })
  }
})

describe('DIVE-2846: tapRef never mints an ident out of an internal id', () => {
  for (const mod of mods) {
    test(`${mod.name}: unknown ident degrades to task #<id>, known ident is used verbatim`, () => {
      // The measured harm: callback_data carries id 3018, and `DIVE-3018` is not
      // that task. On this box id 2846 IS ident DIVE-2659 — a different REAL row,
      // which is worse than a 404 because it looks up fine.
      for (const unknown of [undefined, null, '', 'dive-2831', '2831', 'DIVE-']) {
        expect(mod.tapRef('3018', unknown), `ident=${JSON.stringify(unknown)}`).toBe('task #3018')
      }
      expect(mod.tapRef('3018', 'DIVE-2831')).toBe('DIVE-2831')
      expect(mod.tapRef('2846', 'DIVE-2659')).toBe('DIVE-2659')
    })
  }
})

describe('DIVE-2846: tapLanding — "did not apply" is a re-read, not an assumption', () => {
  const open = { need_type: 'decision', need_options: 'A|B' }
  const answered = { need_type: 'decision', need_options: 'A|B', need_answer: 'B', need_answered_at: '2026-08-06 04:01:55' }
  for (const mod of mods) {
    test(`${mod.name}: applied / open / unknown`, () => {
      expect(mod.tapLanding(true, answered)).toBe('applied')
      expect(mod.tapLanding(true, open)).toBe('open')
      // Re-read failed → we do not know, and must not claim either way.
      expect(mod.tapLanding(false, open)).toBe('unknown')
      expect(mod.tapLanding(false, null)).toBe('unknown')
      expect(mod.tapLanding(true, null)).toBe('unknown')
      // Gate withdrawn/deleted between tap and re-read: not open, not applied.
      expect(mod.tapLanding(true, {})).toBe('unknown')
    })
  }
})

describe('DIVE-2846: tapFailureCopy — three distinct outcomes, and a toast that fits', () => {
  const err = (mod: any) => mod.describeTapError(MEASURED_TIMEOUT)
  for (const mod of mods) {
    test(`${mod.name}: an applied tap is never reported as a failure`, () => {
      const c = mod.tapFailureCopy({ taskId: '3018', ident: 'DIVE-2831', err: err(mod), landing: 'applied', answer: 'B' })
      expect(c.chat).toContain('DIVE-2831')
      expect(c.chat).toContain('B')
      expect(c.chat).not.toContain("Couldn't apply that tap")
      // Must NOT push a human toward answering a gate that is already answered.
      expect(c.chat).not.toContain('task answer 3018')
    })

    test(`${mod.name}: an open gate says it did not apply AND how to answer`, () => {
      const c = mod.tapFailureCopy({ taskId: '3018', ident: 'DIVE-2831', err: err(mod), landing: 'open' })
      expect(c.chat).toContain('DIVE-2831')
      expect(c.chat).toContain('STILL OPEN')
      expect(c.chat).toContain('sudo 5dive task answer 3018')  // id is fine in the COMMAND
      expect(c.chat).toContain('timed out')                    // the reason, not just the failure
    })

    test(`${mod.name}: an unconfirmed tap says unknown, and does not claim failure`, () => {
      const c = mod.tapFailureCopy({ taskId: '3018', ident: null, err: err(mod), landing: 'unknown', recheckDetail: 'recheck blew up' })
      expect(c.chat).toContain('task #3018')
      expect(c.chat).not.toContain('DIVE-3018')  // the exact prose bug this row was filed for
      expect(c.chat).toContain("can't tell whether it applied")
      expect(c.chat).toContain('sudo 5dive task show 3018')
      expect(c.log).toContain('recheck_err=recheck blew up')
    })

    test(`${mod.name}: the three landings do not render identically`, () => {
      const of = (landing: string) => mod.tapFailureCopy({ taskId: '3018', ident: 'DIVE-2831', err: err(mod), landing }).chat
      expect(new Set(['applied', 'open', 'unknown'].map(of)).size).toBe(3)
    })

    test(`${mod.name}: every toast clears Telegram's 200-char answerCallbackQuery cap`, () => {
      // Over the cap, answerCallbackQuery throws and the .catch(() => {}) around
      // it restores exactly the silence this row exists to remove.
      const long = mod.describeTapError({ code: 7, stderr: 'error: ' + 'x'.repeat(4000) })
      for (const landing of ['applied', 'open', 'unknown']) {
        const c = mod.tapFailureCopy({ taskId: '3018', ident: 'D'.repeat(300) + '-1', err: long, landing })
        expect(c.toast.length, `${landing} toast too long`).toBeLessThanOrEqual(200)
      }
      expect(long.short.length).toBeLessThanOrEqual(120)
    })

    test(`${mod.name}: the log row names the exception, the landing, and the task`, () => {
      const c = mod.tapFailureCopy({ taskId: '3018', ident: 'DIVE-2831', err: mod.describeTapError(MEASURED_REFUSAL), landing: 'open' })
      expect(c.log).toContain('DIVE-2831')
      expect(c.log).toContain('id 3018')
      expect(c.log).toContain('kind=refused')
      expect(c.log).toContain('landing=open')
      expect(c.log).toContain('no such task: 999999')  // the exception itself, verbatim
    })
  }
})

// Same lesson as assertRoutesTna above: the pure module can be perfect while the
// adapter that calls it still swallows the error. This is globbed over PLUGINS,
// not a named list, so a new fork enrolls itself (DIVE-2374).
describe('DIVE-2846: every plugin server.ts BINDS the tap error and records it', () => {
  for (const p of PLUGINS) {
    test(`${p}: the tna catch binds, re-reads, and records`, () => {
      const src = readFileSync(SERVER_TS(p), 'utf8')
      for (const symbol of ['describeTapError', 'tapLanding', 'tapFailureCopy', 'recordTapFailure']) {
        expect(src.includes(symbol), `${p}/server.ts never calls ${symbol} — a failed tap leaves no record`).toBe(true)
      }
      // The exact regression: a bare `catch {` on the tap path keeps nothing.
      expect(/\} catch \(err\) \{[\s\S]{0,900}?describeTapError\(err\)/.test(src),
        `${p}/server.ts tna catch does not bind its exception`).toBe(true)
      // And the prose bug: never format the internal id as an ident.
      expect(src.includes('that tap for DIVE-${'), `${p}/server.ts still prints DIVE-<internal id> in the fallback`).toBe(false)
      expect(/process\.stderr\.write\(`telegram tna: /.test(src), `${p}/server.ts never writes the failure to stderr`).toBe(true)
    })
  }
})
