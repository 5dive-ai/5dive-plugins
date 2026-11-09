// DIVE-7950 — `5dive crew` (the CrewAI runtime) left the core CLI for this plugin,
// and its work receipt to the 5dive feed became OPT-IN (`crew run --receipt`).
//
// What this grades, by running the shipped plugins/crew/bin/crew as a child:
//   M  the manifest declares the `crew` verb, bin/crew is executable, the
//      marketplace lists the plugin — what core's `plugin add` needs to install it
//   I  `crew install` from a local git repo writes the same layout core wrote
//   R  `crew run` with no flag posts NOTHING (stub ingest sees zero requests)
//   S  `crew run --receipt` posts exactly one, to the configured ingest URL
//   L  local-only mode wins over --receipt: zero requests
//   P  the root refusal moved with the verb (core graded it in agent_isolation_unit)
//   J  --json: the run envelope carries the receipt status
//
// The box's toolchain is stubbed on PATH (python3/pip/npm/node), so no network,
// no CrewAI and no @5dive/openagent are needed. The node stub stands in for the
// receipt emitter: it POSTs to whatever --ingest= bin/crew hands it. That grades
// the plugin's half (whether and where a receipt is sent); the signing helper it
// writes is core's, moved byte for byte.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dir, '..')
const PLUGIN = join(ROOT, 'plugins', 'crew')
const BIN = join(PLUGIN, 'bin', 'crew')

let work = ''
let stubs = ''
let repo = ''
let posts: string[] = []
let server: ReturnType<typeof Bun.serve>

function stub(name: string, body: string) {
  const p = join(stubs, name)
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
}

// Async on purpose: the stub ingest runs in THIS process, so a spawnSync would
// block the event loop and the child's POST would hang forever.
async function crew(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(['bash', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: join(work, 'home'),
      CREW_HOME: join(work, 'crews'),
      ZEROHUMAN_INGEST_URL: `http://127.0.0.1:${server.port}/a2a/receipts`,
      FIVE_LOCAL_ONLY_FILE: join(work, 'local-only'),
      ...env,
    },
  })
  const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { rc, out, err }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'crew-plugin-'))
  stubs = join(work, 'stubs')
  mkdirSync(stubs)
  mkdirSync(join(work, 'home'))
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      posts.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`)
      return Response.json({ id: 'rcpt-1' })
    },
  })

  // python3 -m venv <dir> → a venv whose pip is a no-op and whose python prints
  // what the crew "returned".
  stub('python3', `
if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  printf '#!/usr/bin/env bash\\nexit 0\\n' >"$3/bin/pip"
  printf '#!/usr/bin/env bash\\necho "crew said: $3"\\n' >"$3/bin/python"
  chmod +x "$3/bin/pip" "$3/bin/python"
fi`)
  stub('npm', 'exit 0')
  // node <helper> …: mint writes an identity, emit POSTs to --ingest=.
  stub('node', `
case "$1" in
  *.mint-identity.js) [[ -e "$2" ]] || printf '{"did":"did:key:z6Mtest%s","priv":"x"}\\n' "$RANDOM" >"$2" ;;
  *.emit-receipt.js)
    for a in "$@"; do [[ "$a" == --ingest=* ]] && url="\${a#--ingest=}"; done
    curl -fsS -X POST -H 'content-type: application/json' --data '{"receipt":1}' "$url" >/dev/null \\
      && echo '{"status":"ingested","id":"rcpt-1"}' || echo '{"status":"signed (ingest unreachable)"}' ;;
esac`)

  // A minimal CrewAI project in a local git repo.
  repo = join(work, 'repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'crew.py'), 'class DemoCrew:\n    pass\n')
  const g = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
  g('init', '-q')
  g('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.')
  g('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init')
})

afterAll(() => {
  server?.stop(true)
  if (work) rmSync(work, { recursive: true, force: true })
})

describe('M: installable as a plugin', () => {
  const mf = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
  test('plugin.json declares the crew verb under contract 1', async () => {
    expect(mf.name).toBe('crew')
    expect(mf.fivedive.contract).toBe('1')
    expect(mf.fivedive.capabilities).toContain('verb')
    expect(mf.fivedive.verbs.map((v: any) => v.name)).toEqual(['crew'])
  })
  test('bin/crew exists and is executable (core dispatches it by exec)', async () => {
    expect(statSync(BIN).mode & 0o111).not.toBe(0)
  })
  test('the marketplace lists it', async () => {
    const mk = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
    const e = mk.plugins.find((p: any) => p.name === 'crew')
    expect(e?.source).toBe('./plugins/crew')
  })
  test('help names --receipt and no longer offers --no-receipt', async () => {
    const r = await crew(['help'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('--receipt')
    expect(r.out).not.toContain('--no-receipt')
  })
})

describe('I: crew install', () => {
  test('clones, makes the venv, mints the identity, detects the entry', async () => {
    const r = await crew(['install', repo, '--as=demo'])
    expect(r.rc).toBe(0)
    const dir = join(work, 'crews', 'demo')
    for (const f of ['repo/crew.py', 'venv/bin/python', 'storage', 'identity.json', '.crew_runner.py', '.emit-receipt.js', '.mint-identity.js'])
      expect(existsSync(join(dir, f))).toBe(true)
    expect(existsSync(join(work, 'crews', 'runtime-identity.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8')).entry).toBe('crew:DemoCrew')
    expect((await crew(['list'])).out).toContain('demo')
  })
  test('a second install of the same name is refused', async () => {
    expect((await crew(['install', repo, '--as=demo'])).rc).toBe(3)
  })
})

describe('R/S/L: the work receipt is opt-in', () => {
  test('R: a plain run posts nothing', async () => {
    posts = []
    const r = await crew(['run', 'demo'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('crew said')
    expect(r.out).toContain('receipt: skipped')
    expect(posts).toEqual([])
  })
  test('R: --no-receipt (the old opt-out) still parses and posts nothing', async () => {
    posts = []
    expect((await crew(['run', 'demo', '--no-receipt'])).rc).toBe(0)
    expect(posts).toEqual([])
  })
  test('S: --receipt posts exactly one, to the ingest URL', async () => {
    posts = []
    const r = await crew(['run', 'demo', '--receipt'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('receipt: ingested')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toStartWith('POST /a2a/receipts ')
  })
  test('L: local-only mode wins over --receipt', async () => {
    posts = []
    writeFileSync(join(work, 'local-only'), '')
    try {
      const r = await crew(['run', 'demo', '--receipt'])
      expect(r.rc).toBe(0)
      expect(r.err).toContain('local-only mode is on')
      expect(posts).toEqual([])
    } finally {
      rmSync(join(work, 'local-only'))
    }
  })
})

describe('P/J', () => {
  test('P: refuses root (it runs agent-authored code), help still answers', async () => {
    stub('id', '[[ "$1" == -u ]] && echo 0 || command id "$@"')
    try {
      const r = await crew(['run', 'demo', '--receipt'])
      expect(r.rc).toBe(10)
      expect(r.err).toContain('not root')
      expect((await crew(['help'])).rc).toBe(0)
    } finally {
      rmSync(join(stubs, 'id'))
    }
  })
  test('J: --json (forwarded by core as FIVEDIVE_JSON_MODE) carries the receipt status', async () => {
    posts = []
    const r = await crew(['run', 'demo'], { FIVEDIVE_JSON_MODE: '1' })
    expect(r.rc).toBe(0)
    const env = JSON.parse(r.out.trim().split('\n').pop()!)
    expect(env.ok).toBe(true)
    expect(env.data.receipt.status).toBe('skipped')
    const e = await crew(['show', 'nope', '--json'])
    expect(e.rc).toBe(4)
    expect(JSON.parse(e.out).error.class).toBe('not_found')
  })
})
