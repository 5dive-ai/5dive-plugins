// DIVE-3969 (P10): the Codex channel bridge's compatibility handshake, its
// state migration, its canary/rollback script, and the packaged artifact.
//
// Everything here runs under a bare `bun test` with no plugin dependencies:
// compat.ts imports nothing, `dispatcher.ts --check` exits before any adapter
// or app-server is started, and release.sh is plain bash.
import { describe, expect, test } from 'bun:test'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  CODEX_MIN_VERSION, CODEX_TESTED_MAX, DISPATCHER_STATE_SCHEMA,
  checkCodex, compareVersions, migrateState, parseCodexVersion,
} from '../plugins/telegram-codex/compat.ts'
import {
  ChannelDispatcher, type DispatcherState, type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'
import { HEALTH_SCHEMA, classifyHealth, readHealth } from '../plugins/telegram-codex/health.ts'

const PLUGIN = join(import.meta.dir, '..', 'plugins', 'telegram-codex')
const read = (p: string) => readFileSync(join(PLUGIN, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('Codex version handshake', () => {
  test('parses both `codex --version` and an app-server userAgent', () => {
    expect(parseCodexVersion('codex-cli 0.156.1\n')).toBe('0.156.1')
    expect(parseCodexVersion('5dive_channel_dispatcher/0.145.0 (Ubuntu 24.4.0; x86_64) tmux/3.4')).toBe('0.145.0')
    expect(parseCodexVersion('codex-cli 0.157.0-alpha.3')).toBe('0.157.0')
    expect(parseCodexVersion('garbage')).toBeNull()
    expect(parseCodexVersion(null)).toBeNull()
  })

  test('compares numerically, not lexically', () => {
    expect(compareVersions('0.99.0', '0.136.0')).toBe(-1)
    expect(compareVersions('0.136.0', '0.136.0')).toBe(0)
    expect(compareVersions('1.0.0', '0.156.1')).toBe(1)
  })

  test('the measured boundary: 0.135.0 refused, 0.136.0 accepted', () => {
    const old = checkCodex('codex-cli 0.135.0')
    expect(old.ok).toBe(false)
    expect(old.detail).toContain('0.135.0')
    expect(old.detail).toContain(CODEX_MIN_VERSION)
    expect(old.detail).toContain('--stdio')
    const floor = checkCodex('codex-cli 0.136.0')
    expect(floor.ok).toBe(true)
    expect(floor.tested).toBe(true)
  })

  test('newer than tested is allowed and labelled untested; a Codex that cannot run is refused', () => {
    const next = checkCodex('codex-cli 9.0.0')
    expect(next.ok).toBe(true)
    expect(next.tested).toBe(false)
    expect(next.detail).toContain(CODEX_TESTED_MAX)
    expect(checkCodex(null).ok).toBe(false)
    expect(checkCodex('no version here').ok).toBe(false)
  })

  test('the canary override admits a below-floor Codex, still marked untested', () => {
    const v = checkCodex('codex-cli 0.120.0', true)
    expect(v.ok).toBe(true)
    expect(v.tested).toBe(false)
  })
})

describe('dispatcher state migration', () => {
  const legacy = { threadId: 't-1', seen: ['a', 'b'], pending: [{ id: 'p' }], cleanExit: true }

  test('a pre-schema file migrates to the current schema, keeping every field', () => {
    const m = migrateState<DispatcherState>(structuredClone(legacy))
    expect(m.migrated).toBe(true)
    expect(m.quarantine).toBeUndefined()
    expect(m.state).toEqual({ ...legacy, schema: DISPATCHER_STATE_SCHEMA } as any)
  })

  test('idempotent: migrating the output again changes nothing', () => {
    const once = migrateState<DispatcherState>(structuredClone(legacy)).state
    const twice = migrateState<DispatcherState>(structuredClone(once))
    expect(twice.migrated).toBe(false)
    expect(twice.state).toEqual(once)
    expect(migrateState<DispatcherState>(structuredClone(twice.state)).state).toEqual(once)
  })

  test('malformed arrays are repaired, not trusted', () => {
    const m = migrateState<DispatcherState>({ schema: 1, seen: ['ok', 7], pending: 'x' })
    expect(m.migrated).toBe(true)
    expect(m.state.seen).toEqual(['ok'])
    expect(m.state.pending).toEqual([])
  })

  test('no file is a fresh state, not a quarantine', () => {
    const m = migrateState<DispatcherState>(null)
    expect(m.quarantine).toBeUndefined()
    expect(m.state).toEqual({ schema: DISPATCHER_STATE_SCHEMA, seen: [], pending: [] })
  })

  test('a newer schema (a rollback) and an unparseable file are quarantined', () => {
    const newer = migrateState<DispatcherState>({ schema: DISPATCHER_STATE_SCHEMA + 1, threadId: 'from-the-future', seen: [], pending: [] })
    expect(newer.quarantine).toContain('newer bridge')
    expect(newer.state.threadId).toBeUndefined()
    expect(migrateState<DispatcherState>('{not json').quarantine).toContain('not a JSON object')
    expect(migrateState<DispatcherState>({ schema: 'one', seen: [], pending: [] }).quarantine).toContain('invalid schema')
  })

  test('the dispatcher sets a quarantined file aside, starts a fresh thread, and says so on the next turn', async () => {
    const requests: Array<{ method: string; params: any }> = []
    const rpc: RpcPort = {
      async request(method, params) {
        requests.push({ method, params })
        if (method === 'thread/start') return { thread: { id: 'fresh' } }
        if (method === 'turn/start') return { turn: { id: 'turn-1' } }
        return {}
      },
    }
    const quarantined: string[] = []
    let saved: any = null
    const d = new ChannelDispatcher(rpc, {
      load: () => ({ schema: 99, threadId: 'from-the-future', seen: [], pending: [] }),
      save: s => { saved = structuredClone(s) },
      quarantine: r => { quarantined.push(r) },
    }, { publish: async () => {} }, '/tmp')
    await d.initialize()
    expect(quarantined).toHaveLength(1)
    expect(requests.some(r => r.method === 'thread/resume')).toBe(false)
    expect(saved.threadId).toBe('fresh')
    expect(saved.schema).toBe(DISPATCHER_STATE_SCHEMA)
    await d.submit({ id: 'm1', text: 'hello', route: { source: 'telegram', chat_id: '1' } })
    const turn = requests.find(r => r.method === 'turn/start')!
    expect(turn.params.input[0].text).toContain('[5dive recovery]')
    expect(turn.params.input[0].text).toContain('newer bridge')
  })
})

// ── the live entrypoint, driven as a process ───────────────────────────────

function fakeCodex(dir: string, version: string | null): string {
  const bin = join(dir, `codex-${version ?? 'broken'}`)
  writeFileSync(bin, version === null
    ? '#!/bin/sh\nexit 3\n'
    : `#!/bin/sh\n[ "$1" = --version ] && { echo "codex-cli ${version}"; exit 0; }\nexit 2\n`)
  chmodSync(bin, 0o755)
  return bin
}

function runDispatcher(dir: string, codex: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, join(PLUGIN, 'dispatcher.ts'), ...args], {
    cwd: dir,
    env: { ...process.env, CODEX_BIN: codex, CODEX_DISPATCHER_STATE_DIR: join(dir, 'state'), CODEX_DISPATCHER_CHANNELS: '', ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('dispatcher.ts --check and the startup refusal', () => {
  test('--check passes a supported pair and reports the state migration without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3969-check-'))
    try {
      mkdirSync(join(dir, 'state'))
      const stateFile = join(dir, 'state', 'state.json')
      writeFileSync(stateFile, JSON.stringify({ threadId: 't', seen: [], pending: [] }))
      const r = runDispatcher(dir, fakeCodex(dir, '0.156.1'), ['--check'])
      expect(r.code).toBe(0)
      const report = JSON.parse(r.out.trim())
      expect(report.ok).toBe(true)
      expect(report.bridgeVersion).toBe(pkg.version)
      expect(report.codex.version).toBe('0.156.1')
      expect(report.state.migrated).toBe(true)
      // a preflight must not rewrite what it inspected
      expect(JSON.parse(readFileSync(stateFile, 'utf8')).schema).toBeUndefined()
      expect(existsSync(join(dir, 'state', 'inbox'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('--check refuses Codex 0.135.0 with the floor in the message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3969-check-'))
    try {
      const r = runDispatcher(dir, fakeCodex(dir, '0.135.0'), ['--check'])
      expect(r.code).toBe(1)
      expect(JSON.parse(r.out.trim()).ok).toBe(false)
      expect(r.err).toContain('REFUSED')
      expect(r.err).toContain(CODEX_MIN_VERSION)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a real start on an unsupported pair exits 78 and leaves a named failure the classifier REPORTS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3969-refuse-'))
    try {
      const r = runDispatcher(dir, fakeCodex(dir, '0.120.0'), [])
      expect(r.code).toBe(78)
      expect(r.err).toContain('refusing to start')
      const health = readHealth(join(dir, 'state'))!
      expect(health.schema).toBe(HEALTH_SCHEMA)
      expect(health.bound).toBe(false)
      expect(health.codex?.version).toBe('0.120.0')
      expect(health.failure?.cause).toContain(CODEX_MIN_VERSION)
      const verdict = classifyHealth({ health, declared: ['telegram'], serviceActive: true, now: new Date() })
      expect(verdict.state).toBe('failed')
      expect(verdict.repair).toBe('report')
      expect(readFileSync(join(dir, 'state', 'lifecycle.log'), 'utf8')).toContain('unsupported pair')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a Codex that cannot run at all is refused, not crash-looped on an exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3969-refuse-'))
    try {
      const r = runDispatcher(dir, fakeCodex(dir, null), [])
      expect(r.code).toBe(78)
      expect(readHealth(join(dir, 'state'))!.failure?.cause).toContain('could not be run')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── release.sh: canary, promote, rollback ──────────────────────────────────

function tree(root: string, name: string, version: string): string {
  const t = join(root, name)
  mkdirSync(t, { recursive: true })
  for (const f of ['dispatcher.ts', 'dispatcher-core.ts', 'compat.ts', 'health.ts', 'lifecycle.ts', 'release.sh']) {
    cpSync(join(PLUGIN, f), join(t, f))
  }
  writeFileSync(join(t, 'package.json'), JSON.stringify({ name: 'x', version }))
  return t
}

function release(root: string, codex: string, args: string[]) {
  const r = Bun.spawnSync(['bash', join(PLUGIN, 'release.sh'), ...args], {
    env: { ...process.env, LIB_DIR: join(root, 'lib'), BUN: process.execPath, CODEX_BIN: codex, CODEX_DISPATCHER_STATE_DIR: join(root, 'state') },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

const liveVersion = (root: string) => JSON.parse(readFileSync(join(root, 'lib', 'telegram-codex', 'package.json'), 'utf8')).version

describe('release.sh', () => {
  test('promote keeps the old tree; rollback swaps back; rollback again rolls forward', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive3969-release-'))
    try {
      const codex = fakeCodex(root, '0.156.1')
      mkdirSync(join(root, 'lib'))
      expect(release(root, codex, ['promote', tree(root, 'v1', '1.0.0')]).code).toBe(0)
      expect(liveVersion(root)).toBe('1.0.0')
      const p2 = release(root, codex, ['promote', tree(root, 'v2', '2.0.0')])
      expect(p2.code).toBe(0)
      expect(p2.out).toContain('previous 1.0.0')
      expect(liveVersion(root)).toBe('2.0.0')
      expect(release(root, codex, ['rollback']).code).toBe(0)
      expect(liveVersion(root)).toBe('1.0.0')
      expect(release(root, codex, ['status']).out).toContain('prev 2.0.0')
      expect(release(root, codex, ['rollback']).code).toBe(0)
      expect(liveVersion(root)).toBe('2.0.0')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('promote on an unsupported pair changes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive3969-release-'))
    try {
      mkdirSync(join(root, 'lib'))
      expect(release(root, fakeCodex(root, '0.156.1'), ['promote', tree(root, 'v1', '1.0.0')]).code).toBe(0)
      const bad = release(root, fakeCodex(root, '0.130.0'), ['promote', tree(root, 'v2', '2.0.0')])
      expect(bad.code).not.toBe(0)
      expect(bad.err).toContain('nothing was changed')
      expect(liveVersion(root)).toBe('1.0.0')
      expect(existsSync(join(root, 'lib', 'telegram-codex.prev'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a tree that predates --check is never executed (it would start a live bridge)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive3969-release-'))
    try {
      const old = join(root, 'old')
      mkdirSync(old)
      const marker = join(root, 'ran')
      writeFileSync(join(old, 'dispatcher.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`)
      writeFileSync(join(old, 'package.json'), JSON.stringify({ version: '0.5.19' }))
      const r = release(root, fakeCodex(root, '0.156.1'), ['check', old])
      expect(r.code).toBe(2)
      expect(r.err).toContain('predates --check')
      expect(existsSync(marker)).toBe(false)
      mkdirSync(join(root, 'lib'))
      expect(release(root, fakeCodex(root, '0.156.1'), ['promote', old]).code).not.toBe(0)
      expect(existsSync(join(root, 'lib', 'telegram-codex'))).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('rolling back to a pre-0.5.20 tree does not execute it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive3969-release-'))
    try {
      const marker = join(root, 'ran')
      const prev = join(root, 'lib', 'telegram-codex.prev')
      mkdirSync(prev, { recursive: true })
      writeFileSync(join(prev, 'dispatcher.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`)
      writeFileSync(join(prev, 'package.json'), JSON.stringify({ version: '0.5.19' }))
      cpSync(tree(root, 'v2', '0.5.20'), join(root, 'lib', 'telegram-codex'), { recursive: true })
      const r = release(root, fakeCodex(root, '0.156.1'), ['rollback'])
      expect(r.code).toBe(0)
      expect(liveVersion(root)).toBe('0.5.19')
      expect(existsSync(marker)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('rollback with nothing to roll back to fails clearly', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive3969-release-'))
    try {
      mkdirSync(join(root, 'lib'))
      const r = release(root, fakeCodex(root, '0.156.1'), ['rollback'])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('nothing to roll back to')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── the packaged artifact and the docs that describe it ────────────────────

function localImports(file: string): string[] {
  const src = readFileSync(join(PLUGIN, file), 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
    let target = relative(PLUGIN, join(PLUGIN, dirname(file), m[1]!))
    if (!/\.[cm]?[tj]s$/.test(target)) target += '.ts'
    out.push(target)
  }
  return out
}

function covered(path: string, files: string[]): boolean {
  return files.some(f => f === path || (f.endsWith('/') && path.startsWith(f)))
}

describe('packaged artifact', () => {
  const files: string[] = pkg.files

  test('every file reachable from a bin entry or hook is listed in package.json `files`', () => {
    const roots = [
      ...Object.values(pkg.bin as Record<string, string>).map(p => p.replace(/^\.\//, '')),
      ...readdirSync(join(PLUGIN, 'hooks')).filter(f => f.endsWith('.ts')).map(f => `hooks/${f}`),
    ]
    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length) {
      const f = queue.shift()!
      if (seen.has(f)) continue
      seen.add(f)
      // `../dashboard/server.ts` is spawned, not imported, and ships as its own tree.
      for (const dep of localImports(f)) if (!dep.startsWith('..')) queue.push(dep)
    }
    const missing = [...seen].filter(f => !covered(f, files))
    expect(missing).toEqual([])
  })

  test('every `files` entry and bin target exists', () => {
    for (const f of files) expect(existsSync(join(PLUGIN, f))).toBe(true)
    for (const b of Object.values(pkg.bin as Record<string, string>)) expect(existsSync(join(PLUGIN, b))).toBe(true)
  })

  test('the Codex plugin manifest ships the package version', () => {
    expect(JSON.parse(read('.codex-plugin/plugin.json')).version).toBe(pkg.version)
  })

  test('the npm pin in .mcp.json is exact (no range, no latest)', () => {
    const args: string[] = JSON.parse(read('.mcp.json')).mcpServers.telegram.args
    const spec = args.find(a => a.startsWith('@5dive/telegram-codex-mcp@'))!
    expect(spec).toMatch(/@\d+\.\d+\.\d+$/)
  })

  test('the minimum Codex in the docs is the one the code enforces', () => {
    expect(read('README.md')).toContain(`>= ${CODEX_MIN_VERSION}`)
    expect(read('README.md')).toContain(CODEX_TESTED_MAX)
  })
})

describe('docs match the shipped package', () => {
  test('README roadmap and TODO name the current version', () => {
    expect(read('README.md')).toContain(`v${pkg.version}`)
    expect(read('TODO.md')).toContain(`v${pkg.version}`)
  })

  test('every `bun run <script>` the README names is a package script', () => {
    const readme = read('README.md')
    for (const m of readme.matchAll(/bun run ([a-z][\w:-]*)/g)) {
      expect(Object.keys(pkg.scripts)).toContain(m[1]!)
    }
    expect(pkg.scripts.start).toContain('dispatcher.ts')
  })

  test('every plugin file the README or AGENTS.md tells you to run exists', () => {
    for (const doc of ['README.md', 'AGENTS.md']) {
      const text = read(doc)
      const refs = new Set<string>()
      for (const m of text.matchAll(/bun (?:\/absolute\/path\/to\/5dive-plugins\/plugins\/telegram-codex\/)?([\w/-]+\.ts)\b/g)) refs.add(m[1]!)
      for (const m of text.matchAll(/release\.sh/g)) refs.add('release.sh')
      for (const ref of refs) expect(existsSync(join(PLUGIN, ref))).toBe(true)
    }
  })

  test('every bot command in the README table is registered by server.ts', () => {
    const table = read('README.md').split('\n').find(l => l.startsWith('| Slash commands'))!
    const server = read('server.ts')
    for (const m of table.matchAll(/`\/(\w+)`/g)) {
      if (m[1]!.startsWith('telegram')) continue
      expect(server).toContain(`command: '${m[1]}'`)
    }
  })
})
