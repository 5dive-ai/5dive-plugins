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
// The end-to-end evidence (a session loading the module, the sink lines, the two
// negative controls) is on DIVE-4692 and is reproduced by the command in the plugin's
// README.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'plugins', 'mod')
const SRC = readFileSync(join(ROOT, 'hooks', 'register.ts'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
const HOOKS_JSON = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))

/** The events the mod is allowed to register. A new one is a deliberate decision. */
const EVENTS = [
  'session.start',
  'turn.start',
  'turn.complete',
  'command.run',
  'tool.call',
  'session.end',
] as const

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
  const registered = [...SRC.matchAll(/^  on\('([^']+)'/gm)].map((m) => m[1])

  test('the set matches, with no extras', () => {
    expect(registered.sort()).toEqual([...EVENTS].sort())
  })

  test('no event is registered twice', () => {
    expect(new Set(registered).size).toBe(registered.length)
  })
})

describe('mod: it cannot affect the session it measures', () => {
  // The safety property, asserted against the source because there is no cheaper way
  // to assert it: this plugin runs on every seat that enables it, inside every turn.

  test('no hook can deny, rewrite or answer a call', () => {
    expect(SRC).not.toMatch(/\bdeny\b\s*:/)
    // `next(e)` is always the untouched event; a rewrite would spread into it.
    expect(SRC).not.toMatch(/next\(\s*\{\s*\.\.\.e/)
  })

  test('every hook awaits next(e) before it does anything else', () => {
    const bodies = [...SRC.matchAll(/^  on\('[^']+', async \(\$, e, next\) => \{\n(.*?)^  \}\)/gms)]
    expect(bodies.length).toBe(EVENTS.length)
    for (const [, body] of bodies) {
      const first = body.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('//'))
      expect(first).toBe('const r = await next(e)')
      // and the hook hands back exactly what the chain resolved to
      expect(body.trimEnd().endsWith('return r')).toBe(true)
    }
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
  const { seatFromRoot, safe, envOf, sinkPath, lineFor, producerFor } = await import(
    join(ROOT, 'hooks', 'register.ts')
  )

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
