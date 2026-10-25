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

// DIVE-4692 — A THIRD KIND, derived the same way: declared, not listed.
//
// `mod` is a Claude Code FUNCTION-HOOK plugin. It launches no server and ships
// no bin/<name>: the harness loads its module in-process, and the module it
// loads is the one hooks/hooks.json names in "modules". That declaration is
// what makes it this kind, exactly as package.json's start script is what
// makes a plugin a TS plugin above — so losing the hooks.json drops the plugin
// out of this set and into the bash complement, where it fails for want of a
// bin/. Which is the point: a hooks plugin whose hooks.json goes missing loads
// with no hooks at all and looks perfectly healthy on the seat.
function declaredHooksModules(dir: string): string[] {
  const p = join(PLUGINS, dir, 'hooks', 'hooks.json')
  if (!existsSync(p)) return []
  const mods = JSON.parse(readFileSync(p, 'utf8'))?.modules
  return Array.isArray(mods) ? mods.map(String) : []
}

type ModPlugin = { dir: string; modules: string[] }

const MOD_PLUGINS: ModPlugin[] = PLUGIN_DIRS
  .filter(d => !TS_PLUGINS.some(p => p.dir === d))
  .map(dir => ({ dir, modules: declaredHooksModules(dir) }))
  .filter(p => p.modules.length > 0)

// DIVE-6935 — A FOURTH KIND: a CORE-MODULE plugin. `devteam` launches nothing
// and ships no bin/: the 5dive CLI sources its core/<module>.sh files into its
// own process, and only because .claude-plugin/plugin.json declares the `core`
// capability. That declaration is what makes it this kind. Losing it drops the
// plugin into the bash complement, where it fails for want of a bin/. That is
// right, because the CLI would then never read the plugin at all.
function declaresCore(pluginDir: string): boolean {
  const p = join(pluginDir, '.claude-plugin', 'plugin.json')
  if (!existsSync(p)) return false
  const caps = JSON.parse(readFileSync(p, 'utf8'))?.fivedive?.capabilities
  return Array.isArray(caps) && caps.includes('core')
}

// What a core-module plugin owes, as a list of problems (empty = sound): at
// least one core/**/*.sh, a core/SOURCE naming every one of them (the CLI's
// loader and devteam_core_unit.sh both read it), and no TypeScript.
function coreModuleProblems(pluginDir: string): string[] {
  const core = join(pluginDir, 'core')
  if (!existsSync(core) || !statSync(core).isDirectory()) return ['no core/ directory']
  const sh: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), r)
      else if (e.name.endsWith('.sh')) sh.push(r)
    }
  }
  walk(core, '')
  const problems: string[] = []
  if (sh.length === 0) problems.push('core/ has no .sh module')
  const src = join(core, 'SOURCE')
  const listed = existsSync(src)
    ? readFileSync(src, 'utf8').split('\n')
        .map(l => l.match(/^[0-9a-f]{64}\s+(\S+)$/)?.[1])
        .filter((x): x is string => !!x)
    : null
  if (listed === null) problems.push('no core/SOURCE')
  else for (const f of sh) if (!listed.includes(f)) problems.push(`core/${f} not in core/SOURCE`)
  const ts: string[] = []
  const walkTs = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      if (e.isDirectory()) walkTs(join(dir, e.name))
      else if (e.name.endsWith('.ts')) ts.push(e.name)
    }
  }
  walkTs(pluginDir)
  if (ts.length) problems.push(`ships TypeScript: ${ts.join(', ')}`)
  return problems
}

const CORE_PLUGINS = PLUGIN_DIRS.filter(
  d => !TS_PLUGINS.some(p => p.dir === d) && !MOD_PLUGINS.some(p => p.dir === d)
    && declaresCore(join(PLUGINS, d)),
)

// The complement: a plugin that declares neither a TS launcher, a hooks
// module nor the core capability must be a real bash plugin, i.e. ship an
// executable bin/<name>. Without this a TS plugin could lose its package.json
// and fall silently out of TS_PLUGINS instead of failing.
const BASH_PLUGINS = PLUGIN_DIRS.filter(
  d => !TS_PLUGINS.some(p => p.dir === d) && !MOD_PLUGINS.some(p => p.dir === d)
    && !CORE_PLUGINS.includes(d),
)

// ── the gate itself ─────────────────────────────────────────────────────────

describe('every plugin TypeScript file parses', () => {
  const files = tsFiles()

  test('the sweep is not vacuous — it found the servers it is supposed to grade', () => {
    expect(files.length).toBeGreaterThan(20)
    // FLOOR: an empty or collapsed derived set fails here rather than passing
    // by grading nothing. Every plugin dir is accounted for as TS or bash.
    expect(TS_PLUGINS.length).toBeGreaterThanOrEqual(5)
    expect(TS_PLUGINS.length + MOD_PLUGINS.length + CORE_PLUGINS.length + BASH_PLUGINS.length)
      .toBe(PLUGIN_DIRS.length)
    for (const p of TS_PLUGINS) {
      expect(files).toContain(join(PLUGINS, p.dir, 'server.ts'))
      for (const rel of p.entries) expect(files).toContain(join(PLUGINS, p.dir, rel))
    }
  })

  test('a hooks-module plugin ships the module its hooks.json names', () => {
    for (const p of MOD_PLUGINS) {
      for (const rel of p.modules) {
        // "./register.ts" is relative to the hooks/ folder the manifest sits in.
        const abs = join(PLUGINS, p.dir, 'hooks', rel)
        expect(existsSync(abs)).toBe(true)
        // and it is graded by the parse loop below like every other plugin .ts
        if (abs.endsWith('.ts')) expect(files).toContain(abs)
      }
    }
  })

  test('a core-module plugin ships the modules it declares, and no TypeScript', () => {
    expect(CORE_PLUGINS).toContain('devteam')
    for (const d of CORE_PLUGINS) expect([d, coreModuleProblems(join(PLUGINS, d))]).toEqual([d, []])
  })

  test('the core-module check can fail (mutants)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive6935-core-'))
    try {
      const mk = (name: string, files: Record<string, string>, caps = ['core']) => {
        const dir = join(root, name)
        Bun.spawnSync(['mkdir', '-p', join(dir, '.claude-plugin')])
        writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name, fivedive: { capabilities: caps } }))
        for (const [rel, body] of Object.entries(files)) {
          Bun.spawnSync(['mkdir', '-p', join(dir, rel, '..')])
          writeFileSync(join(dir, rel), body)
        }
        return dir
      }
      const sha = 'a'.repeat(64)
      const good = mk('good', { 'core/x.sh': ':\n', 'core/task/y.sh': ':\n',
        'core/SOURCE': `from x\n${sha}  x.sh\n${sha}  task/y.sh\n` })
      expect(declaresCore(good)).toBe(true)
      expect(coreModuleProblems(good)).toEqual([])
      // no core/ at all
      expect(coreModuleProblems(mk('nocore', {}))).toEqual(['no core/ directory'])
      // core/ with only SOURCE
      expect(coreModuleProblems(mk('empty', { 'core/SOURCE': '' }))).toContain('core/ has no .sh module')
      // a module SOURCE does not name
      expect(coreModuleProblems(mk('unlisted', { 'core/x.sh': ':\n', 'core/z.sh': ':\n',
        'core/SOURCE': `${sha}  x.sh\n` }))).toEqual(['core/z.sh not in core/SOURCE'])
      // no SOURCE
      expect(coreModuleProblems(mk('nosource', { 'core/x.sh': ':\n' }))).toEqual(['no core/SOURCE'])
      // TypeScript smuggled in
      expect(coreModuleProblems(mk('ts', { 'core/x.sh': ':\n', 'core/SOURCE': `${sha}  x.sh\n`,
        'server.ts': '' }))).toEqual(['ships TypeScript: server.ts'])
      // without the capability it is not this kind (and falls to the bash check)
      expect(declaresCore(mk('nocap', { 'core/x.sh': ':\n' }, ['verb']))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
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
