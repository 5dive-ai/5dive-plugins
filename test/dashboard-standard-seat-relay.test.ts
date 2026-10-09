// DIVE-5894: since DIVE-5690 a standard seat cannot read /etc/5dive/connectord.env,
// and this adapter runs AS the seat. It exited 1 at boot ("connectord token not
// found") on every standard seat: claude seats lost dashboard chat silently, and
// a Codex dispatcher died with its adapter and never drained its inbox.
//
// These drive the REAL processes. The adapter, with a token file it cannot
// read, must reach the control plane through the root relay (a stand-in for
// `sudo -n 5dive _dashboard_relay` that records the ops it is handed) for all
// three calls: collect, ack and reply. Without the relay it must still refuse
// loudly. And a Codex dispatcher whose adapter keeps exiting must stay up and
// respawn it, not die.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'plugins')
const SERVER = join(ROOT, 'dashboard', 'server.ts')
const DISPATCHER = join(ROOT, 'telegram-codex', 'dispatcher.ts')
const BOOT_MS = 5_000

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

// The relay stand-in: NUL-separated ops on stdin, one JSON line per call in
// ops.log, "<status>\n<body>" on stdout, like the CLI's root half.
function writeRelay(dir: string, pingOk: boolean): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(dir + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') {
  if (!${pingOk}) { process.stderr.write('sudo: a password is required\\n'); process.exit(1) }
  process.stdout.write('200\\n{"ok":true}')
} else if (op[0] === 'pending') {
  let q = []
  try { q = JSON.parse(readFileSync(dir + '/queue.json', 'utf8')) } catch {}
  process.stdout.write('200\\n' + JSON.stringify({ pending: q }))
} else if (op[0] === 'ack') {
  const ids = op.slice(1).map(Number)
  let q = []
  try { q = JSON.parse(readFileSync(dir + '/queue.json', 'utf8')) } catch {}
  writeFileSync(dir + '/queue.json', JSON.stringify(q.filter(m => !ids.includes(m.id))))
  process.stdout.write('200\\n' + JSON.stringify({ ok: true, acked: ids.length }))
} else if (op[0] === 'event') {
  process.stdout.write('200\\n{"id":41}')
} else { process.stderr.write('unknown op\\n'); process.exit(1) }
`)
  return file
}

function ops(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function startAdapter(dir: string, relay: string) {
  // A token file that is THERE and unreadable: the standard seat's view.
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  const delivered: string[] = []
  const results: string[] = []
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      // An API the adapter must NOT reach on the relay path.
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', relay]),
      USER: 'agent-tap',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-test', version: '0' } } })
  void (async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method === 'notifications/claude/channel') delivered.push(String(msg.params?.content ?? ''))
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          if (msg.id === 7) results.push(JSON.stringify(msg.result ?? msg.error))
        } catch {}
      }
    }
  })()
  return { proc, delivered, results, send }
}

describe('dashboard adapter on a standard seat (DIVE-5894)', () => {
  test('an unreadable token file: collect, ack and reply all cross the root relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-relay-'))
    writeFileSync(join(dir, 'queue.json'), JSON.stringify([{ id: 12, text: 'hello from the dashboard', chat_id: '33' }]))
    const a = startAdapter(dir, writeRelay(dir, true))
    try {
      expect(await waitFor(() => a.delivered.includes('hello from the dashboard'), BOOT_MS + 8_000)).toBe(true)
      expect(await waitFor(() => ops(dir).some(o => o[0] === 'ack'), 5_000)).toBe(true)
      a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'reply', arguments: { chat_id: '33', text: 'hi owner' } } })
      expect(await waitFor(() => a.results.length > 0, 5_000)).toBe(true)
      expect(a.results[0]).toContain('sent (id: 41)')
      const seen = ops(dir)
      expect(seen[0]).toEqual(['ping'])
      expect(seen).toContainEqual(['pending'])
      expect(seen).toContainEqual(['ack', '12'])
      expect(seen).toContainEqual(['event', '33', 'hi owner'])
      // The seat names no agent and carries no token: root derives both.
      expect(JSON.stringify(seen)).not.toContain('agent')
      expect(JSON.stringify(seen)).not.toContain('never-read-by-the-seat')
      expect(a.proc.exitCode).toBeNull()
    } finally {
      a.proc.kill()
      await a.proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('no relay grant: the adapter still refuses loudly, naming the relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-relay-none-'))
    const a = startAdapter(dir, writeRelay(dir, false))
    try {
      const code = await a.proc.exited
      const err = await new Response(a.proc.stderr).text()
      expect(code).toBe(1)
      expect(err).toContain('connectord token not found')
      expect(err).toContain('root relay')
      expect(ops(dir)).toEqual([['ping']])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('codex dispatcher with a failing adapter (DIVE-5894)', () => {
  test('an adapter that keeps exiting is respawned; the dispatcher stays up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-degrade-'))
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex.ts')
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0) }
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id == null) return
  const result = request.method === 'thread/start' ? { thread: { id: 'thread-degrade-test' } } : {}
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
`)
    chmodSync(fakeCodex, 0o755)
    const child = Bun.spawn(['bun', DISPATCHER], {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_BIN: fakeCodex,
        CODEX_DISPATCHER_CHANNELS: 'dashboard',
        CODEX_DISPATCHER_STATE_DIR: stateDir,
        CODEX_DISPATCHER_WORKDIR: dir,
        CODEX_DISPATCHER_ADAPTER_RESPAWN_MS: '200',
        // The adapter exits 1 at boot: no token anywhere, the 0.81.0 shape.
        DASHBOARD_STATE_DIR: join(dir, 'dash'),
        CONNECTORD_ENV_FILE: join(dir, 'absent.env'),
        CONNECTORD_TOKEN: undefined as unknown as string,
        USER: 'agent-tap',
      },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      const record = join(stateDir, 'lifecycle.log')
      const exits = () => {
        try { return readFileSync(record, 'utf8').split('\n').filter(l => l.includes('\tcrash\tdashboard\t')).length } catch { return 0 }
      }
      expect(await waitFor(() => exits() >= 2, 15_000)).toBe(true)
      const body = readFileSync(record, 'utf8')
      expect(body).toContain('respawning in')
      expect(body).not.toContain('\tcrash\tcodex-dispatcher\t')
      expect(child.exitCode).toBeNull()
      const health = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8'))
      expect(health.failure?.channel).toBe('dashboard')
      expect(health.listening ?? []).not.toContain('dashboard')
    } finally {
      child.kill('SIGTERM')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 25_000)
})
