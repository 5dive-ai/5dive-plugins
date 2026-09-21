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

import { afterAll, describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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
const MOD_PATHSPEC = 'plugins/mod/'
const REPO = join(import.meta.dir, '..')

function git(args: string[], cwd: string = REPO): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

/**
 * A name THIS tree can use for main's tip, or null when it cannot reach main at all.
 *
 * Split out of the old `versionOnMain()` (DIVE-4747) because the scoping half below
 * needs the REF, not the version string it happens to point at.
 *
 * A CI checkout is shallow and single-ref (actions/checkout@v4 gives depth 1 on the
 * PR merge ref), so neither local name resolves there. Fetching main is the whole
 * difference between grading the collision and skipping it in the one place that would
 * have caught DIVE-4720's.
 */
function mainRef(cwd: string = REPO): string | null {
  for (const ref of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)) return ref
  }
  // Full fetch FIRST (DIVE-4747). `--depth=1` hands back a tip with no ancestry, and
  // `modChangedSinceMain` then has no merge base to scope against — it degrades to a
  // tip diff, under which a branch that bumped to a number main has since published
  // reads as "unchanged" and the collision goes silent. The workflow checks out full
  // history (pinned by an arm below), so this fetch is incremental there; the shallow
  // form stays as a last resort because a vacuous skip is worse than a degraded scope.
  for (const args of [
    ['fetch', '--no-tags', 'origin', 'main'],
    ['fetch', '--no-tags', '--depth=1', 'origin', 'main'],
  ]) {
    if (
      git(args, cwd) !== null &&
      git(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], cwd)
    ) {
      return 'FETCH_HEAD'
    }
  }
  return null
}

/** The manifest version at a ref, or null when that ref has no manifest to read. */
function versionAt(ref: string, cwd: string = REPO): string | null {
  const raw = git(['show', `${ref}:${MANIFEST_REL}`], cwd)
  return raw ? JSON.parse(raw).version : null
}

/** main's manifest version, or null when this tree genuinely cannot reach main. */
function versionOnMain(cwd: string = REPO): string | null {
  const ref = mainRef(cwd)
  return ref === null ? null : versionAt(ref, cwd)
}

/**
 * Did THIS tree change anything under `plugins/mod/` since it diverged from main?
 *
 * The scoping DIVE-4747 is about. "Our version is strictly above main's" is a statement
 * about the DISTANCE between two trees, and on `main` that distance is zero — so the
 * unscoped arm was false by construction the moment the branch it guarded merged, and
 * stayed false on `main` and on every PR that had since taken `main` in. It made the
 * repository's only CI signal permanently red, which is worse than blocking: the next
 * real regression arrives indistinguishable from the standing one.
 *
 * The merge BASE, not main's tip, is what makes the answer about this branch's own work:
 * a branch sitting on a base that predates someone else's `mod` release has not touched
 * `mod`, and must not be asked to out-rank it. The tip is the fallback for a shallow CI
 * checkout with no common history to compute — correct there because `pull_request` hands
 * us the PR MERGED INTO main, so the tip-diff IS the PR's own effect, and `push` on main
 * hands us main, where it is empty.
 *
 * Diffed against the WORKING TREE (one-commit form), so an uncommitted bump counts.
 * Returns null when neither base resolves: an unknown, never a silent "no".
 */
function modChangedSinceMain(ref: string, cwd: string = REPO): boolean | null {
  const base =
    git(['merge-base', ref, 'HEAD'], cwd)?.trim() ||
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)?.trim()
  if (!base) return null
  const out = git(['diff', '--name-only', base, '--', MOD_PATHSPEC], cwd)
  return out === null ? null : out.trim().length > 0
}

/**
 * The three readings the scoped guard can produce, as one pure function so the control
 * arms can drive it over histories this checkout cannot be made to have.
 *
 * `skipped` is a real verdict and not an escape: the arm has nothing to say about a
 * plugin this branch never touched, and asserting anyway is asserting about someone
 * else's work.
 */
function versionVerdict(changed: boolean, ours: string, onMain: string): string {
  if (!changed) return 'skipped'
  return cmpVersion(ours, onMain) > 0 ? 'above' : 'NOT above'
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

  test('a tree that CHANGED plugins/mod carries a version strictly above the one published on main', () => {
    const ref = mainRef()
    // Null means no ref AND no fetch — a tree that cannot see main at all. Passing
    // here would make the arm vacuous in precisely the environment where nobody is
    // watching, so it reds and says why.
    expect(ref === null ? 'could not read main' : 'read main').toBe('read main')
    const onMain = versionAt(ref as string)
    expect(onMain === null ? 'could not read main' : 'read main').toBe('read main')
    // Same reasoning one level down: an unscopable diff is an unknown, and an unknown
    // that reads as "unchanged" would switch the guard off silently.
    const changed = modChangedSinceMain(ref as string)
    expect(changed === null ? 'could not scope to the diff' : 'scoped to the diff').toBe(
      'scoped to the diff',
    )
    const ours = MANIFEST.version
    const scope = changed ? 'changed' : 'unchanged'
    const verdict = versionVerdict(changed as boolean, ours, onMain as string)
    expect(`plugins/mod ${scope}: ${ours} vs main's ${onMain} -> ${verdict}`).toBe(
      `plugins/mod ${scope}: ${ours} vs main's ${onMain} -> ${changed ? 'above' : 'skipped'}`,
    )
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

describe('mod: the version guard is scoped to the diff, so it survives its own merge (DIVE-4747)', () => {
  // Controls, and they are the point of the row rather than a courtesy. The arm above
  // grades whatever history this checkout happens to have, so on `main` it is green by
  // skipping and on a bump it is green by comparing — one reading each, never both, and
  // an arm that cannot be shown to fail is zero evidence. These build the histories the
  // live arm cannot be made to have, and ask it the same two functions.
  //
  // Each fixture is a throwaway repo: two or three commits and a manifest with nothing
  // in it but a name and a version, because the predicate reads only the version.

  const made: string[] = []

  function g(dir: string, ...args: string[]): string {
    const out = git(args, dir)
    if (out === null) throw new Error(`fixture: git ${args.join(' ')} failed in ${dir}`)
    return out
  }

  function writeManifest(dir: string, version: string): void {
    mkdirSync(join(dir, 'plugins', 'mod', '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, 'plugins', 'mod', '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'mod', version }, null, 2)}\n`,
    )
  }

  function writeOther(dir: string, body: string): void {
    mkdirSync(join(dir, 'plugins', 'telegram'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'telegram', 'server.ts'), body)
  }

  /** A repo whose `main` publishes `version`, checked out on `main`. */
  function repoOnMain(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mod-version-guard-'))
    made.push(dir)
    g(dir, 'init', '--quiet', '--initial-branch=main')
    g(dir, 'config', 'user.email', 'fixture@example.com')
    g(dir, 'config', 'user.name', 'fixture')
    writeManifest(dir, version)
    writeOther(dir, 'export const seed = 1\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '--quiet', '-m', `main: mod ${version}`)
    return dir
  }

  function commitAll(dir: string, message: string): void {
    g(dir, 'add', '-A')
    g(dir, 'commit', '--quiet', '-m', message)
  }

  /** What the arm reads: the scope, and the verdict that scope produces. */
  function grade(dir: string): { scope: string; verdict: string; ours: string; onMain: string } {
    const ref = mainRef(dir)
    if (ref === null) throw new Error('fixture: cannot reach main')
    const onMain = versionAt(ref, dir) as string
    const ours = JSON.parse(
      readFileSync(join(dir, 'plugins', 'mod', '.claude-plugin', 'plugin.json'), 'utf8'),
    ).version as string
    const changed = modChangedSinceMain(ref, dir)
    if (changed === null) throw new Error('fixture: cannot scope the diff')
    return {
      scope: changed ? 'changed' : 'unchanged',
      verdict: versionVerdict(changed, ours, onMain),
      ours,
      onMain,
    }
  }

  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  test('GREEN on main itself — the regression this row exists for', () => {
    // The unscoped predicate was false by construction here: ours EQUALS main's, because
    // ours IS main's. That single arm made the repo red on every head from 04:08Z onward.
    const dir = repoOnMain('0.6.0')
    expect(grade(dir)).toMatchObject({ scope: 'unchanged', verdict: 'skipped' })
    // ...and the pre-fix predicate is pinned as red on the same tree, so this arm cannot
    // be passing for some reason other than the scoping.
    expect(cmpVersion('0.6.0', '0.6.0') > 0).toBe(false)
  })

  test('RED on a branch that edits plugins/mod without bumping the version', () => {
    const dir = repoOnMain('0.6.0')
    g(dir, 'checkout', '--quiet', '-b', 'edits-mod')
    mkdirSync(join(dir, 'plugins', 'mod', 'hooks'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'mod', 'hooks', 'register.ts'), 'export const x = 2\n')
    commitAll(dir, 'edit mod, forget the bump')
    expect(grade(dir)).toMatchObject({ scope: 'changed', verdict: 'NOT above' })
  })

  test('RED on a version merely EQUAL to main’s — the DIVE-4720 collision', () => {
    // Branch bumps 0.6.0 -> 0.7.0 on a base that predates main publishing 0.7.0 itself.
    // Both trees now say 0.7.0, so the second build can never install: a strictly higher
    // number is what moves a box. This is the defect the arm was written for and it must
    // survive the scoping.
    const dir = repoOnMain('0.6.0')
    g(dir, 'checkout', '--quiet', '-b', 'bumps-into-a-collision')
    writeManifest(dir, '0.7.0')
    commitAll(dir, 'bump mod to 0.7.0')
    g(dir, 'checkout', '--quiet', 'main')
    writeManifest(dir, '0.7.0')
    commitAll(dir, 'main publishes mod 0.7.0')
    g(dir, 'checkout', '--quiet', 'bumps-into-a-collision')
    expect(grade(dir)).toMatchObject({ scope: 'changed', verdict: 'NOT above', ours: '0.7.0', onMain: '0.7.0' })
  })

  test('GREEN on a branch that edits plugins/mod AND bumps above main', () => {
    const dir = repoOnMain('0.6.0')
    g(dir, 'checkout', '--quiet', '-b', 'bumps-properly')
    writeManifest(dir, '0.7.0')
    commitAll(dir, 'bump mod to 0.7.0')
    expect(grade(dir)).toMatchObject({ scope: 'changed', verdict: 'above' })
  })

  test('GREEN on a branch that never touched plugins/mod while main bumped it — stale base', () => {
    const dir = repoOnMain('0.6.0')
    g(dir, 'checkout', '--quiet', '-b', 'touches-another-plugin')
    writeOther(dir, 'export const seed = 2\n')
    commitAll(dir, 'change a plugin that is not mod')
    g(dir, 'checkout', '--quiet', 'main')
    writeManifest(dir, '0.7.0')
    commitAll(dir, 'main publishes mod 0.7.0')
    g(dir, 'checkout', '--quiet', 'touches-another-plugin')
    const graded = grade(dir)
    expect(graded).toMatchObject({ scope: 'unchanged', verdict: 'skipped', ours: '0.6.0', onMain: '0.7.0' })
    // The pre-fix predicate on the very same tree: 0.6.0 is NOT above 0.7.0, so it red on
    // a branch whose diff contains no file under plugins/mod at all.
    expect(cmpVersion(graded.ours, graded.onMain) > 0).toBe(false)
  })

  test('GREEN on a branch that TOOK MAIN IN and still never touched plugins/mod', () => {
    // The exact shape that presented: a one-hunk conflict resolution pulled main in, the
    // versions became equal, and a PR touching zero files under plugins/mod went red.
    const dir = repoOnMain('0.6.0')
    g(dir, 'checkout', '--quiet', '-b', 'took-main-in')
    writeOther(dir, 'export const seed = 3\n')
    commitAll(dir, 'change a plugin that is not mod')
    g(dir, 'checkout', '--quiet', 'main')
    writeManifest(dir, '0.7.0')
    commitAll(dir, 'main publishes mod 0.7.0')
    g(dir, 'checkout', '--quiet', 'took-main-in')
    g(dir, 'merge', '--quiet', '--no-edit', 'main')
    const graded = grade(dir)
    expect(graded).toMatchObject({ scope: 'unchanged', verdict: 'skipped', ours: '0.7.0', onMain: '0.7.0' })
    expect(cmpVersion(graded.ours, graded.onMain) > 0).toBe(false)
  })

  test('the parity workflow checks out full history, because the scoping needs a merge base', () => {
    // Not a style pin. `fetch-depth: 0` is the precondition for the arm above having
    // any discrimination at all in CI: delete it and the guard silently degrades to a
    // tip diff, which cannot see the DIVE-4720 collision. The degradation is invisible
    // — every arm stays green — so it is pinned here rather than trusted.
    const wf = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'parity.yml'), 'utf8')
    expect(/uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*fetch-depth: 0/.test(wf)).toBe(true)
  })

  test('mod-telemetry is still the ONLY test that compares this tree against main', () => {
    // The class, not the instance. A second cross-tree guard written the unscoped way
    // would red on main the same day it merged, and nothing else in the suite would
    // notice. If this arm reds, scope the new comparison before shipping it — the
    // question to ask is: what does this arm say when it runs ON main?
    const dir = join(import.meta.dir)
    const comparers = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      // The tell of a cross-TREE read, not the word "main": a ref name, a fetched head,
      // or a merge base. `council.test.ts` says "main" about a model and is not one.
      .filter((f) => /origin\/main|FETCH_HEAD|merge-base/.test(readFileSync(join(dir, f), 'utf8')))
      .sort()
    expect(comparers).toEqual(['mod-telemetry.test.ts'])
  })
})
