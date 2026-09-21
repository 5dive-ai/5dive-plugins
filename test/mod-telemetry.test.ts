// Static + pure-function suite for the `mod` plugin (DIVE-4692).
//
// What this can and cannot grade. The mod's hooks only run inside a real Claude Code
// process with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS set, so booting one here is out of
// scope for `bun test` (and the parity CI job runs with no Claude Code at all). What CI
// CAN own is everything that is decidable from the source, and the two classes of bug
// that have actually bitten plugins in this repo are both in that set:
//
//   1. a manifest and its module drifting apart (the version string, the hooks.json
//      that names the module at all — without it the engine loads the plugin and
//      silently runs no hooks, which looks exactly like a working install);
//   2. a hook growing a way to affect the session — an early return, a `deny`, a
//      rewritten `e` — which is the one change that turns this from a measurement into
//      a thing that can lose a turn.
//
// A third class was added in iteration 2, and it is the one that bounced the delivery:
//
//   3. the WRITE PATH swallowing its own failure. The pure helpers were covered and the
//      write was not, so an empty rejection handler at a default path no seat could
//      write shipped as green: the mod loaded, wrote nothing, and said nothing, which
//      is the same observable as being switched off. `record` takes `$` as its first
//      argument (a host rule — see the module), so a stub engine is all it takes to
//      grade both halves of fail-open: the failure does not propagate, AND it is
//      legible.
//
// The end-to-end evidence (a session loading the module, the sink lines, the two
// negative controls) is on DIVE-4692 and is reproduced by the command in the plugin's
// README.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'plugins', 'mod')
const SRC = readFileSync(join(ROOT, 'hooks', 'register.ts'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
const HOOKS_JSON = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))

/**
 * The manifest version PUBLISHED on main, and the comparison against it (DIVE-4720
 * iteration 2).
 *
 * Why this cannot be done with the source-vs-manifest arm below. That arm compares two
 * files inside the working tree, so a branch that bumps both to a number main already
 * shipped is green on both. That is exactly what happened here: #96 took 0.5.0 at
 * 00:47Z, this branch opened ten minutes later and bumped 0.4.0 -> 0.5.0 on a base that
 * predated it, and every version arm in the suite passed. A plugin only moves a box on
 * a STRICTLY HIGHER number, so two builds sharing one number means the second can never
 * be installed — the collision is not a tidiness defect, it strands the release.
 */
const MANIFEST_REL = 'plugins/mod/.claude-plugin/plugin.json'
const REPO = join(import.meta.dir, '..')

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

/** main's manifest version, or null when this tree genuinely cannot reach main. */
function versionOnMain(): string | null {
  for (const ref of ['origin/main', 'main']) {
    const raw = git(['show', `${ref}:${MANIFEST_REL}`])
    if (raw) return JSON.parse(raw).version
  }
  // A CI checkout is shallow and single-ref (actions/checkout@v4 gives depth 1 on the
  // PR merge ref), so neither name above resolves there. Fetching main is the whole
  // difference between grading the collision and skipping it in the one place that
  // would have caught this one.
  if (git(['fetch', '--depth=1', 'origin', 'main']) !== null) {
    const raw = git(['show', `FETCH_HEAD:${MANIFEST_REL}`])
    if (raw) return JSON.parse(raw).version
  }
  return null
}

/** -1 / 0 / 1 on the numeric semver triple. Equal is a FAILING comparison here. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** The events the mod is allowed to register. A new one is a deliberate decision. */
const EVENTS = [
  'session.start',
  'turn.start',
  'turn.complete',
  'command.run',
  'tool.call',
  'session.measure',
  'session.compact',
  'session.end',
] as const

/**
 * The hooks that observe and nothing else. DIVE-4695 added the first two hooks that
 * are NOT in this set, and the exemption is spelled out one place only — here — so
 * that a third one cannot appear without editing this line:
 *
 *   - `session.measure` still returns the chain's value untouched, but it may START
 *     a compaction. It does so on the sink's own promise chain and never awaits it,
 *     so it can neither delay a turn nor fail one; what it can do is change the
 *     conversation the NEXT turn runs over, which is the point of that row.
 *   - `session.compact` is the only hook in the module that returns something other
 *     than `r`, and the arms in mod-boundary-compact.test.ts pin the direction: it
 *     may only APPEND messages the compaction dropped, never remove or rewrite one.
 */
const OBSERVE_ONLY = EVENTS.filter(
  (e) => e !== 'session.measure' && e !== 'session.compact',
)

describe('mod: manifest and module stay wired together', () => {
  test('hooks/hooks.json names the module', () => {
    // Without "modules" the engine loads the plugin, registers no hooks, and logs
    // nothing at default verbosity: the install looks healthy and produces no data.
    // This assertion is the whole reason the file exists.
    expect(HOOKS_JSON.modules).toEqual(['./register.ts'])
  })

  test('the version in the source matches the manifest', () => {
    const inSource = /const VERSION = '([^']+)'/.exec(SRC)?.[1]
    expect(inSource).toBe(MANIFEST.version)
  })

  test('the manifest version is strictly above the one published on main', () => {
    const onMain = versionOnMain()
    // Null means no ref AND no fetch — a tree that cannot see main at all. Passing
    // here would make the arm vacuous in precisely the environment where nobody is
    // watching, so it reds and says why.
    expect(onMain === null ? 'could not read main' : 'read main').toBe('read main')
    const ours = MANIFEST.version
    const verdict = cmpVersion(ours, onMain as string) > 0 ? 'above' : 'NOT above'
    expect(`${ours} is ${verdict} main's ${onMain}`).toBe(`${ours} is above main's ${onMain}`)
  })

  test('the comparison reds on a version merely EQUAL to main, not just a lower one', () => {
    // The collision that bounced iteration 1 was an EQUAL number, not a lower one, so
    // a >= comparison would have shipped it. Pinned here rather than left implicit.
    const onMain = versionOnMain()
    expect(cmpVersion(onMain as string, onMain as string)).toBe(0)
    expect(cmpVersion('0.5.0', '0.5.0')).toBe(0)
    expect(cmpVersion('0.4.0', '0.5.0')).toBe(-1)
    expect(cmpVersion('0.6.0', '0.5.0')).toBe(1)
    expect(cmpVersion('0.10.0', '0.9.0')).toBe(1)
  })

  test('the manifest records the Claude Code build the mod was verified against', () => {
    const verified = /const VERIFIED_AGAINST = '([^']+)'/.exec(SRC)?.[1]
    expect(verified).toBeDefined()
    // plugin.json has no version-pin field, so the build is carried as a keyword and
    // on every emitted line. If the source is re-verified against a newer Claude Code,
    // both move together or this fails.
    expect(MANIFEST.keywords).toContain(`claude-code-${verified}`)
  })
})

describe('mod: it registers exactly the events it claims', () => {
  // Two shapes of registration live in this module and they are graded apart, because
  // they carry different promises (DIVE-4693):
  //   - MATCHER-LESS: the telemetry hooks. Observe-only, asserted below.
  //   - MATCHED: the hooks that serve this plugin's OWN slash commands. They answer
  //     with `{ text }` and never call `next`, which is correct for a command with no
  //     core implementation — and would be a bug on any other event, so the matcher
  //     set is pinned here rather than left to grow.
  const observing = [...SRC.matchAll(/^  on\('([^']+)', async/gm)].map((m) => m[1])
  const matched = [...SRC.matchAll(/^  on\('([^']+)', \{ command: '([^']+)' \}/gm)].map(
    (m) => [m[1], m[2]] as const,
  )

  test('the observe-only set matches, with no extras', () => {
    expect(observing.sort()).toEqual([...EVENTS].sort())
  })

  test('no event is registered twice as an observer', () => {
    expect(new Set(observing).size).toBe(observing.length)
  })

  test('the served commands are exactly the ones the module registers', () => {
    // The names it serves...
    expect(matched.map(([event]) => event)).toEqual(['command.run', 'command.run'])
    const served = matched.map(([, name]) => name).sort()
    // ...and the names it declares to the engine. A hook serving a name never
    // registered is dead code; a name registered with no hook prints "no hook answered"
    // at the person, which reads exactly like a broken install.
    const declared = [...SRC.matchAll(/\$\.command\.register\(\{\s*name: '([^']+)'/g)]
      .map((m) => m[1])
      .sort()
    expect(served).toEqual(declared)
    expect(served).toEqual(['gate', 'task'])
  })
})

describe('mod: it cannot affect the session it measures', () => {
  // The safety property, asserted against the source because there is no cheaper way
  // to assert it: this plugin runs on every seat that enables it, inside every turn.

  test('exactly ONE site in the module can deny, and its reason is the policy\'s', () => {
    // DIVE-4696 made this a counted exception rather than an absolute. The count is
    // the assertion: a second deny site added anywhere in this file — in a command
    // hook, in a telemetry hook, on a tool the policy file does not mention — is a
    // rule this plugin enforces that `policy/guard.json` does not state, which is the
    // one thing the data-driven shape exists to prevent.
    const denies = [...SRC.matchAll(/return \{ deny: ([^}]+) \}/g)].map((m) => m[1]!.trim())
    expect(denies).toEqual(['v.reason'])
    // `v` is the verdict the policy document produced. A literal string here would be
    // a rule living in code.
    expect(SRC).toContain('const v = await verdictFor($, e.tool, e)')
    // `next(e)` is always the untouched event; a rewrite would spread into it.
    expect(SRC).not.toMatch(/next\(\s*\{\s*\.\.\.e/)
  })

  test('every hook awaits next(e) before it does anything else', () => {
    const bodies = [
      ...SRC.matchAll(/^  on\('([^']+)', async \(\$, e, next\) => \{\n(.*?)^  \}\)/gms),
    ]
    expect(bodies.length).toBe(EVENTS.length)
    for (const [, name, body] of bodies) {
      const first = body!.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('//'))
      if (name === 'tool.call') {
        // DIVE-4696 — the guard's hook, and the ONE exemption from the rule below.
        // What it may do before `next` is pinned to the single call: anything else
        // here would be a side effect on the path of every tool call on the seat.
        expect(first).toBe('const v = await verdictFor($, e.tool, e)')
        // ...and when it does NOT deny, it is the observe-only hook DIVE-4692
        // shipped: next(e) first, and the chain's own result handed back.
        expect(body!).toContain('const r = await next(e)')
        expect(body!.trimEnd().endsWith('return r')).toBe(true)
        continue
      }
      // No other hook does ANYTHING — not a settings read, not a threshold check —
      // before the chain below it has resolved.
      expect(first).toBe('const r = await next(e)')
      if ((OBSERVE_ONLY as readonly string[]).includes(name!)) {
        // and the observe-only hooks hand back exactly what the chain resolved to
        expect(body!.trimEnd().endsWith('return r')).toBe(true)
      }
    }
  })

  test('exactly TWO hooks return anything other than the chain\'s own value', () => {
    // The exemption list is the assertion. `session.compact` may ADD a message back;
    // `tool.call` may REFUSE the call outright (DIVE-4696). A third name appearing
    // here is a hook that started changing what the engine does, and it must be
    // argued for rather than discovered.
    const bodies = [
      ...SRC.matchAll(/^  on\('([^']+)', async \(\$, e, next\) => \{\n(.*?)^  \}\)/gms),
    ]
    const rewriting = bodies
      .filter(([, , body]) => /^\s*return (?!r\b)/m.test(body!))
      .map(([, name]) => name)
    expect(rewriting.sort()).toEqual(['session.compact', 'tool.call'])
  })

  test('the compact hook can only ADD messages, never drop or rewrite one', () => {
    // `pinKept` is the only thing that builds the list it returns, and its own arms
    // are in mod-boundary-compact.test.ts. What is asserted from the source is that
    // the hook has no OTHER way to produce a message list: no filter, no slice, no
    // map over `r.messages`, and the returned object is `r` with only `messages`
    // replaced.
    const body = /^  on\('session\.compact'.*?^  \}\)/gms.exec(SRC)?.[0] ?? ''
    expect(body).not.toBe('')
    expect(body).toContain('const { messages, pinned } = pinKept(livePin, e.messages, r.messages)')
    expect(body).toContain('return { ...r, messages }')
    expect(body).not.toMatch(/r\.messages\.(filter|slice|map|splice)/)
    // and a seat that has not opted in never reaches any of it
    expect(body).toContain('if (livePin === null || r.skip !== undefined) return r')
  })

  test('the guard is ON unless the seat opts out, and opting out is the old hook', () => {
    // REVERSED BY DIVE-4720, deliberately. The arm this replaces pinned the opposite
    // default and gave the reason: "a guard that is on by default would refuse calls
    // on 18 seats the moment the plugin updates." That reason was measured and found
    // to be the wrong way round — off-by-default refused calls on ZERO seats, which is
    // why the six CLAUDE.md rules the policies replace could not be deleted and the
    // fleet went on paying for them on every turn. A rule nothing enforces is not a
    // rule. The default still has to be legible from the source; it is the value that
    // changed, not the requirement to state it.
    expect(SRC).toContain("const GUARD_FLAG = 'FIVEDIVE_MOD_GUARD'")
    // Absent is ON: only a named opt-out answers `{ on: false }`.
    expect(SRC).toMatch(/flag === '0' \|\| flag === 'off' \|\| flag === 'false' \|\| flag === 'no'\) return \{ on: false \}/)
    // And the old predicate is GONE, not merely shadowed by a second one.
    expect(SRC).not.toMatch(/GUARD_FLAG\] \?\? ''\) !== '1'/)
  })

  test('on by default, every policy carries a named escape', () => {
    // The blast radius of the flip rests on this: a seat that hits a false positive
    // has a one-setting exit that is not "edit the file all 18 seats read". Off by
    // default, a policy with no escape cost nobody anything; on by default it is an
    // outage with a reason attached. Read from the DOCUMENT, so a policy added later
    // without an escape reds here rather than on a seat.
    const doc = JSON.parse(readFileSync(join(ROOT, 'policy', 'guard.json'), 'utf8'))
    const naked = doc.policies
      .filter((p: { unless_env?: string }) => typeof p.unless_env !== 'string' || p.unless_env === '')
      .map((p: { id: string }) => p.id)
    expect(naked).toEqual([])
  })

  test('the module never binds $ to a name', () => {
    // The engine's own scan refuses this at load; asserting it here turns a
    // fleet-visible load failure into a red test. Every use is $.noun.member(...) and
    // every function that takes $ is declared at the top level.
    expect(SRC).not.toMatch(/=\s*\$\s*$/m)
    expect(SRC).not.toMatch(/\(\s*\$\s*\)\s*=>/)
  })
})

describe('mod: the pure helpers the sink path and line schema rest on', async () => {
  const { seatFromRoot, homeFromRoot, safe, envOf, sinkPath, lineFor, producerFor } =
    await import(join(ROOT, 'hooks', 'register.ts'))

  test('a seat is named from the plugin directory, or not at all', () => {
    expect(seatFromRoot('/home/agent-dev/.claude/plugins/cache/5dive-plugins/mod/0.1.0')).toBe('dev')
    expect(seatFromRoot('/home/agent-main/x/y')).toBe('main')
    expect(seatFromRoot('/home/claude/.claude/plugins/cache/x')).toBe('claude')
    // A path the rule does not cover records NOTHING rather than guessing a seat: an
    // unattributable line on disk is worse than a missing one, because a consumer
    // cannot tell the two apart afterwards.
    expect(seatFromRoot('/opt/somewhere/mod')).toBeNull()
    expect(seatFromRoot('/home/agent-/x')).toBeNull()
    expect(seatFromRoot('/home/nobody/x')).toBeNull()
    // A bare home directory with no trailing slash is still that seat's home.
    expect(seatFromRoot('/home/agent-dev')).toBe('dev')
  })

  test('a session id cannot escape the sink directory', () => {
    expect(safe('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sinkPath('/var/lib/5dive/mod-telemetry', 'dev', '../x')).toBe(
      '/var/lib/5dive/mod-telemetry/dev-.._x.jsonl',
    )
  })

  test('the default sink is under the seat home the plugin is installed in', () => {
    // Iteration 1's default was a fixed /var/lib/5dive/mod-telemetry. That tree is
    // `drwxr-s--- root:claude`: no seat can create a subdirectory in it, so the mod
    // wrote nothing at its own documented default. The default is now derived from the
    // same path the seat name is, which is a directory the seat owns by construction.
    expect(homeFromRoot('/home/agent-dev/.claude/plugins/cache/5dive-plugins/mod/0.1.0')).toBe(
      '/home/agent-dev',
    )
    expect(homeFromRoot('/home/claude/projects/5dive/5dive-plugins/plugins/mod')).toBe(
      '/home/claude',
    )
    expect(homeFromRoot('/home/agent-dev')).toBe('/home/agent-dev')
    expect(homeFromRoot('/opt/somewhere/mod')).toBeNull()
    expect(homeFromRoot('/home')).toBeNull()
    // The pair the sink path is actually built from.
    const root = '/home/agent-dev/.claude/plugins/cache/5dive-plugins/mod/0.1.0'
    expect(sinkPath(`${homeFromRoot(root)}/.5dive/mod-telemetry`, seatFromRoot(root), 's1')).toBe(
      '/home/agent-dev/.5dive/mod-telemetry/dev-s1.jsonl',
    )
    // And nothing anywhere in the module still defaults to the unwritable tree.
    expect(SRC).not.toContain("'/var/lib/5dive/mod-telemetry'")
  })

  test('the gate block is read defensively', () => {
    expect(envOf({ env: { A: '1' } })).toEqual({ A: '1' })
    expect(envOf({})).toEqual({})
    expect(envOf(null)).toEqual({})
    expect(envOf({ env: 'nonsense' })).toEqual({})
  })

  test('a line carries its schema version, seat, harness and provenance', () => {
    const s = {
      on: true as const,
      seat: 'dev',
      path: '/tmp/x.jsonl',
      producer: producerFor('mod'),
      sessionId: 'abc',
    }
    const line = JSON.parse(lineFor(s, { ts: 1, event: 'turn.start', turn_id: 't1' }))
    expect(line.v).toBe(1)
    expect(line.seat).toBe('dev')
    expect(line.harness).toBe('claude-code')
    expect(line.session_id).toBe('abc')
    expect(line.event).toBe('turn.start')
    expect(line.turn_id).toBe('t1')
    expect(line.producer).toContain('claude-code 2.1.278')
  })

  test('an absent usage reading stays absent, and is never zeroed', () => {
    // The blind-meter bug in one assertion: a consumer must be able to tell "no
    // reading" from "0% used", so a line with no reading has no `usage` key at all.
    const s = {
      on: true as const,
      seat: 'dev',
      path: '/tmp/x.jsonl',
      producer: producerFor('mod'),
      sessionId: 'abc',
    }
    const line = JSON.parse(lineFor(s, { ts: 1, event: 'tool.call', tool: 'Bash' }))
    expect('usage' in line).toBe(false)
  })
})

describe('mod: the sink write fails loudly, once, and then the mod is off', async () => {
  // The arms in this block share the module's session state (`stopped`, the "said it
  // once" latches, the flush chain) BY DESIGN — latching is the property under test, so
  // they run in order and each one depends on the one before it.
  const { record, producerFor, startCompaction } = await import(
    join(ROOT, 'hooks', 'register.ts')
  )

  const live = (path: string) => ({
    on: true as const,
    seat: 'dev',
    path,
    producer: producerFor('mod'),
    sessionId: 'sess1',
  })

  const writes: Array<{ path: string; text: string }> = []
  const logs: string[] = []
  let failWrites = false

  // A stub engine. `record` takes `$` as an argument (the host scan admits that for a
  // top-level function), which is what makes the write path gradeable at all.
  const engine = {
    fs: {
      write: async (path: string, text: string) => {
        if (failWrites) throw new Error('EACCES: permission denied')
        writes.push({ path, text })
      },
    },
    ui: {
      log: (text: string) => {
        logs.push(text)
      },
    },
  } as unknown as Parameters<typeof record>[0]

  /** Let the chained write promise settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0))

  test('a healthy write reaches the sink and says nothing', async () => {
    record(engine, live('/tmp/dev-sess1.jsonl'), { ts: 1, event: 'turn.start', turn_id: 't1' })
    await settle()
    expect(writes.length).toBe(1)
    expect(writes[0]!.path).toBe('/tmp/dev-sess1.jsonl')
    expect(JSON.parse(writes[0]!.text.trim()).event).toBe('turn.start')
    expect(logs).toEqual([])
  })

  test('an in-flight compaction does NOT park the sink (DIVE-4695 iteration 2)', async () => {
    // The regression this forbids, and it shipped in iteration 1: the ~50s
    // $.session.compact() call was queued on `flush`, the SAME chain every telemetry
    // write is queued on. Nothing was lost and no turn was delayed, but for the length
    // of a compaction (51.5s and 50.3s in the live lab run) no line reached the file —
    // including the NEXT turn.start. The heartbeat, the pacing floor and the
    // pending-restart sweep read idle/busy off that sink, so a compacting seat read as
    // a silent one. The fix is a second chain; this arm is the proof, not the comment.
    //
    // It runs BEFORE the failing-write arm below on purpose: that arm latches the
    // recorder off for the rest of the block.
    const before = writes.length
    let released: (v: unknown) => void = () => {}
    const compacting = {
      ...(engine as object),
      session: {
        // A compaction that never finishes — the worst case of the ~50s call.
        compact: () => new Promise((r) => (released = r)),
      },
    } as unknown as Parameters<typeof record>[0]

    startCompaction(compacting, live('/tmp/dev-sess1.jsonl') as never, 60)
    record(engine, live('/tmp/dev-sess1.jsonl'), { ts: 9, event: 'turn.start', turn_id: 't2' })
    await settle()

    // On the shared chain this was 0: the write sat behind the model call.
    expect(writes.length).toBe(before + 1)
    expect(JSON.parse(writes[writes.length - 1]!.text.trim().split('\n').pop()!).turn_id).toBe('t2')
    released({ skip: 'test' })
    await settle()
  })

  test('a rejected write logs ONE line naming the path and the error', async () => {
    // This is the arm iteration 1 did not have. The handler there was `() => {}`: every
    // event failed identically and silently forever, and the only observable — no sink
    // file — is the same one the two negative controls produce when the mod is OFF.
    failWrites = true
    // TWO events in the same tick, which is what a real turn does: both are already in
    // the flush chain before the first rejection lands, so both reject. The line is
    // said ONCE per session — a per-event line would bury the debug log of every seat
    // that ever misconfigures the directory.
    record(engine, live('/var/lib/5dive/mod-telemetry/dev-sess1.jsonl'), {
      ts: 2,
      event: 'turn.complete',
      turn_id: 't1',
      reason: 'answer',
    })
    record(engine, live('/var/lib/5dive/mod-telemetry/dev-sess1.jsonl'), {
      ts: 3,
      event: 'command.run',
      command: 'status',
    })
    await settle()
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('5dive mod')
    expect(logs[0]).toContain('/var/lib/5dive/mod-telemetry/dev-sess1.jsonl')
    expect(logs[0]).toContain('EACCES')
  })

  test('the mod is latched off: no further write, and it does not say it twice', async () => {
    failWrites = false
    const before = writes.length
    record(engine, live('/tmp/dev-sess1.jsonl'), { ts: 3, event: 'tool.call', tool: 'Bash' })
    await settle()
    expect(writes.length).toBe(before)
    expect(logs.length).toBe(1)
  })

  test('nothing propagated: the recorder never throws and never returns a promise', () => {
    // record() is called from inside a hook that has already resolved `next(e)`. If it
    // could throw or be awaited, telemetry could fail or delay a turn.
    expect(record(engine, live('/tmp/x.jsonl'), { ts: 4, event: 'session.end' })).toBeUndefined()
  })
})
