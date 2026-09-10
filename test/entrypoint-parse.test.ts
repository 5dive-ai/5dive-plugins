// DIVE-3752 iteration 2 — NOTHING IN THIS REPO PARSES AN ENTRY POINT.
//
// Iteration 1 shipped a `plugins/telegram/server.ts` whose new import had been
// inserted INSIDE another import's brace list. Every existing gate was green:
//
//   * `bun test` — 933/0, but no test imports any `plugins/*/server.ts`
//     (repo CI runs with no plugin deps, so a server import would explode on
//     `grammy` long before it ever reached a syntax error).
//   * `bun generator/generate.ts --check` — byte-exact, because the generator
//     is a TEXT TRANSFORM. It never parses what it copies.
//   * parity — the only workflow, and it is those two steps.
//
// And the defect hid from a differential the way only this repo's shape allows:
// the five generated forks parsed FINE at the same line, because the generator
// deletes the whole msglog/council/gatereply block for forks and swallowed the
// orphaned `import {` opener on the way through. 7 clean / 1 broken, and the
// broken one is the BASE the other five are generated from.
//
// So the gate has to be a real parse, it has to cover the base and not just its
// derivatives, and it has to be runnable with ZERO plugin dependencies
// installed — which `bun build --no-bundle` is: it transpiles without resolving
// a single import specifier. Measured on a worktree with no node_modules in any
// of the eight plugin dirs.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PLUGINS = join(import.meta.dir, '..', 'plugins')

// Transpile-only. Returns null on success, the compiler's stderr on failure.
// No bundling, so no import is resolved and no dependency needs to exist.
function parseError(file: string): string | null {
  const r = Bun.spawnSync(['bun', 'build', '--no-bundle', file, '--outfile=/dev/null'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (r.exitCode === 0) return null
  return (r.stderr.toString() + r.stdout.toString()).trim() || `exit ${r.exitCode}`
}

function tsFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(PLUGINS)
  return out.sort()
}

const PLUGIN_DIRS = readdirSync(PLUGINS, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name !== 'node_modules')
  .map(e => e.name)
  .sort()

// DIVE-4202 — WHAT MUST HAVE A server.ts IS DERIVED, NOT "every directory".
//
// The must-have set used to be PLUGIN_DIRS itself. That was true only while
// every plugin in this repo was a bun plugin. `browser` and `voice` arrived
// from the CLI repo as BASH plugins — `bin/<name>`, no package.json, not one
// .ts file — so "every directory ships plugins/<d>/server.ts" went red on
// exactly the two that are correct as they are.
//
// A plugin is graded as a TypeScript plugin when it DECLARES one: a
// package.json whose `start` script is what the launcher runs, naming a .ts
// file. That declaration is the thing that makes a server.ts owed. Deriving it
// this way also closes a hole the directory listing had: deleting a plugin's
// package.json used to change nothing, and now drops it out of the derived set
// — so the floor assertions below fail if the set ever empties or shrinks
// under the population that exists on disk. DIVE-3752 stands: the loop is not
// deleted, and every plugin that declares a TS launcher is still asserted to
// ship the server.ts whose broken base was invisible.
type TsPlugin = { dir: string; entries: string[] }

function declaredTsEntries(dir: string): string[] {
  const pkgPath = join(PLUGINS, dir, 'package.json')
  if (!existsSync(pkgPath)) return []
  const start = String(JSON.parse(readFileSync(pkgPath, 'utf8'))?.scripts?.start ?? '')
  return [...start.matchAll(/bun\s+([A-Za-z0-9_.\-/]+\.ts)/g)].map(m => m[1])
}

const TS_PLUGINS: TsPlugin[] = PLUGIN_DIRS
  .map(dir => ({ dir, entries: declaredTsEntries(dir) }))
  .filter(p => p.entries.length > 0)

// The complement: a plugin that declares no TS launcher must be a real bash
// plugin, i.e. ship an executable bin/<name>. Without this a TS plugin could
// lose its package.json and fall silently out of TS_PLUGINS instead of failing.
const BASH_PLUGINS = PLUGIN_DIRS.filter(d => !TS_PLUGINS.some(p => p.dir === d))

// ── the gate itself ─────────────────────────────────────────────────────────

describe('every plugin TypeScript file parses', () => {
  const files = tsFiles()

  test('the sweep is not vacuous — it found the servers it is supposed to grade', () => {
    expect(files.length).toBeGreaterThan(20)
    // FLOOR: an empty or collapsed derived set fails here rather than passing
    // by grading nothing. Every plugin dir is accounted for as TS or bash.
    expect(TS_PLUGINS.length).toBeGreaterThanOrEqual(5)
    expect(TS_PLUGINS.length + BASH_PLUGINS.length).toBe(PLUGIN_DIRS.length)
    for (const p of TS_PLUGINS) {
      expect(files).toContain(join(PLUGINS, p.dir, 'server.ts'))
      for (const rel of p.entries) expect(files).toContain(join(PLUGINS, p.dir, rel))
    }
  })

  test('a plugin with no declared TS entry point is a real bash plugin', () => {
    for (const d of BASH_PLUGINS) {
      const bin = join(PLUGINS, d, 'bin', d)
      expect(existsSync(bin)).toBe(true)
      // executable, or the CLI's verb dispatcher refuses it (DIVE-4035)
      expect(statSync(bin).mode & 0o111).toBeGreaterThan(0)
      // and it really ships no TypeScript, which is why it owes no server.ts
      expect(files.filter(f => f.startsWith(join(PLUGINS, d) + '/'))).toEqual([])
    }
  })

  for (const f of tsFiles()) {
    test(f.slice(f.indexOf('plugins/')), () => {
      expect(parseError(f)).toBeNull()
    })
  }
})

// ── the entry points specifically, derived from what actually launches ──────
//
// Not a hardcoded list: the launcher runs `bun run start`, so the file named by
// each package.json's `start` script IS the entry point. A plugin that renames
// its entry point must not be able to fall out of this gate silently.

describe('the file each plugin actually launches parses', () => {
  test('at least one plugin declares a TypeScript entry point', () => {
    expect(TS_PLUGINS.length).toBeGreaterThanOrEqual(5)
  })

  for (const { dir: d, entries: named } of TS_PLUGINS) {
    for (const rel of named) {
      test(`${d}: ${rel} parses`, () => {
        const abs = join(PLUGINS, d, rel)
        expect(existsSync(abs)).toBe(true)
        expect(parseError(abs)).toBeNull()
      })
    }
  }
})

// ── positive control: prove the gate can FAIL ───────────────────────────────
//
// A sweep that returns "all clean" is worth nothing until the same command has
// been shown to reject the exact defect it exists for. This reproduces
// iteration 1's shape — an `import` statement inside another import's brace
// list — and requires the gate to reject it.

describe('the gate can fire', () => {
  test('an import nested inside another import\'s brace list is REJECTED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3752-parse-'))
    try {
      const bad = join(dir, 'bad.ts')
      writeFileSync(bad, [
        `import { summarizeNeeds } from './banner'`,
        `import {`,
        `import { installLifecycle } from './lifecycle.ts'`,
        `  appendMessage as msglogAppend,`,
        `} from './msglog'`,
        ``,
      ].join('\n'))
      const err = parseError(bad)
      expect(err).not.toBeNull()
      expect(err).toContain('error')

      // ...and the well-formed version of the same file passes, so the control
      // is grading the DEFECT and not merely the temp directory.
      const good = join(dir, 'good.ts')
      writeFileSync(good, [
        `import { summarizeNeeds } from './banner'`,
        `import { installLifecycle } from './lifecycle.ts'`,
        `import {`,
        `  appendMessage as msglogAppend,`,
        `} from './msglog'`,
        ``,
      ].join('\n'))
      expect(parseError(good)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
