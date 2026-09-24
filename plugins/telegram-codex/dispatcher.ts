#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  unlinkSync, watch, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ChannelDispatcher, parseOutboundMessage, type DispatchMessage, type DispatchRoute,
} from './dispatcher-core.ts'
import { installLifecycle, recordLifecycle } from './lifecycle.ts'
import {
  HEALTH_HEARTBEAT_MS, HEALTH_SCHEMA, writeHealth,
  type ChannelHealth, type HealthFailure,
} from './health.ts'
import {
  ALLOW_UNSUPPORTED_ENV, DISPATCHER_STATE_SCHEMA, checkCodex, migrateState, parseCodexVersion,
} from './compat.ts'

const STATE_DIR = process.env.CODEX_DISPATCHER_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'dispatcher')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')
const STATE_FILE = join(STATE_DIR, 'state.json')
const WORKDIR = process.env.CODEX_DISPATCHER_WORKDIR ?? process.cwd()
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'
const BUN_BIN = process.execPath
const CHANNELS = new Set((process.env.CODEX_DISPATCHER_CHANNELS ?? 'telegram').split(',').filter(Boolean))

const BRIDGE_VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(import.meta.dir, 'package.json'), 'utf8')).version ?? 'unknown')
  } catch { return 'unknown' }
})()

// ── the compatibility handshake (DIVE-3969) ─────────────────────────────────
//
// Settled before anything is started: a Codex this bridge cannot drive is
// refused by name, instead of surfacing as an app-server exit code that the
// run-loop restarts forever. The table and the measurements are in compat.ts.

function probeCodexVersion(): string | null {
  const r = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (r.error || r.status !== 0) return null
  return String(r.stdout ?? '')
}

/** The saved state as found: null when there is none, the raw text when it
 *  does not parse (migrateState sets that aside rather than overwrite it). */
function readStateRaw(): unknown {
  let text: string
  try { text = readFileSync(STATE_FILE, 'utf8') } catch { return null }
  try { return JSON.parse(text) } catch { return text }
}

const codexCompat = checkCodex(probeCodexVersion(), process.env[ALLOW_UNSUPPORTED_ENV] === '1')

// `--check`: the canary/upgrade preflight. Reports whether THIS tree can run
// against THIS Codex and THIS saved state, then exits without starting,
// creating or rewriting anything. release.sh runs it before every promote.
if (process.argv.includes('--check')) {
  const loaded = migrateState(readStateRaw())
  const report = {
    ok: codexCompat.ok,
    bridgeVersion: BRIDGE_VERSION,
    codex: codexCompat,
    state: {
      file: STATE_FILE,
      schema: DISPATCHER_STATE_SCHEMA,
      migrated: loaded.migrated,
      ...(loaded.quarantine ? { quarantine: loaded.quarantine } : {}),
    },
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.stderr.write(`codex-dispatcher --check: ${codexCompat.ok ? 'ok' : 'REFUSED'} — bridge ${BRIDGE_VERSION}; ${codexCompat.detail}`
    + `${loaded.quarantine ? `; ${loaded.quarantine} (would be set aside)` : ''}\n`)
  process.exit(codexCompat.ok ? 0 : 1)
}

for (const dir of [STATE_DIR, INBOX_DIR, OUTBOX_DIR, join(OUTBOX_DIR, 'telegram'), join(OUTBOX_DIR, 'dashboard')]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

// ── the handshake (DIVE-3964) ───────────────────────────────────────────────
//
// Everything a reader needs to tell a bound bridge from a deaf one, asserted by
// the bridge itself on an interval. `updatedAt` is the liveness signal: a
// record that stopped moving is positive evidence of a dead bridge, which is
// the reading the pane-banner probe could never produce. See health.ts.

const health: ChannelHealth = {
  schema: HEALTH_SCHEMA,
  bridge: 'codex-dispatcher',
  bridgeVersion: BRIDGE_VERSION,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  heartbeatMs: HEALTH_HEARTBEAT_MS,
  declared: [...CHANNELS],
  listening: [],
  bound: false,
  queueDepth: 0,
  codex: {
    version: codexCompat.version,
    minimum: codexCompat.minimum,
    testedMax: codexCompat.testedMax,
    tested: codexCompat.tested,
  },
}

// An unsupported pair is a NAMED failure: written to the handshake (which the
// classifier reports rather than restarts) and to the lifecycle log, then exit.
if (!codexCompat.ok) {
  process.stderr.write(`codex-dispatcher: refusing to start: ${codexCompat.detail}\n`)
  recordLifecycle(STATE_DIR, 'crash', 'codex-dispatcher', `unsupported pair: ${codexCompat.detail}`)
  health.failure = { at: new Date().toISOString(), channel: 'bridge', cause: codexCompat.detail }
  writeHealth(STATE_DIR, health)
  process.exit(78) // EX_CONFIG
}
if (!codexCompat.tested) process.stderr.write(`codex-dispatcher: warning: ${codexCompat.detail}\n`)

function publishHealth(): void {
  health.updatedAt = new Date().toISOString()
  // Read the queue and the active turn off the dispatcher rather than
  // maintaining a second copy: a counter that drifts from the state it claims
  // to describe is worse than no counter.
  try {
    const snap = dispatcher.snapshot()
    health.threadId = snap.threadId
    health.queueDepth = snap.pending.length
    health.active = snap.active
      ? { turnId: snap.active.turnId, source: snap.active.route.source, startedAt: health.active?.turnId === snap.active.turnId ? health.active.startedAt : new Date().toISOString() }
      : undefined
  } catch {}
  writeHealth(STATE_DIR, health)
}

function markFailure(channel: string, cause: string): void {
  const failure: HealthFailure = { at: new Date().toISOString(), channel, cause }
  health.failure = failure
  publishHealth()
}

class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  onNotification: (method: string, params: any) => void = () => {}

  constructor() {
    this.child = spawn(CODEX_BIN, [
      'app-server',
      // Channel adapters own both directions. An empty table prevents a
      // configured legacy MCP bridge from starting a second channel consumer;
      // replacing the table also avoids parsing stale MCP transport settings.
      '-c', 'mcp_servers={}',
      '--stdio',
    ], {
      cwd: WORKDIR,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      buf += chunk
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: any
        try { msg = JSON.parse(line) } catch {
          process.stderr.write(`codex-dispatcher: invalid app-server JSON: ${line.slice(0, 200)}\n`)
          continue
        }
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const waiter = this.pending.get(Number(msg.id))
          if (!waiter) continue
          this.pending.delete(Number(msg.id))
          if (msg.error) waiter.reject(new Error(String(msg.error.message ?? 'app-server request failed')))
          else waiter.resolve(msg.result)
        } else if (msg.id != null && typeof msg.method === 'string') {
          // The dispatcher has no local approval UI. Preserve the configured
          // app-server policy and fail closed instead of overriding it to
          // danger-full-access or leaving a server request hanging forever.
          let result: Record<string, unknown> | null = null
          if (msg.method === 'item/commandExecution/requestApproval'
            || msg.method === 'item/fileChange/requestApproval') result = { decision: 'decline' }
          if (msg.method === 'execCommandApproval' || msg.method === 'applyPatchApproval') {
            result = { decision: { denied: { rejection: 'dispatcher has no interactive approval client' } } }
          }
          const response = result
            ? { id: msg.id, result }
            : { id: msg.id, error: { code: -32601, message: 'dispatcher does not handle this server request' } }
          this.child.stdin.write(`${JSON.stringify(response)}\n`)
        } else if (typeof msg.method === 'string') {
          this.onNotification(msg.method, msg.params)
        }
      }
    })
    this.child.stderr.pipe(process.stderr)
    this.child.once('exit', (code, signal) => {
      const err = new Error(`app-server exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
      for (const waiter of this.pending.values()) waiter.reject(err)
      this.pending.clear()
      if (!shuttingDown) {
        process.stderr.write(`codex-dispatcher: ${err.message}; supervisor will restart\n`)
        process.exit(code || 1)
      }
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, err => {
        if (err) { this.pending.delete(id); reject(err) }
      })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  stop(): void { this.child.kill('SIGTERM') }
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function stateStore() {
  return {
    load: readStateRaw,
    quarantine(reason: string) {
      const aside = `${STATE_FILE}.quarantined-${Date.now()}`
      try { renameSync(STATE_FILE, aside) } catch {}
      process.stderr.write(`codex-dispatcher: ${reason}; moved to ${aside}\n`)
    },
    save(state: unknown) {
      atomicJson(STATE_FILE, state)
      try { chmodSync(STATE_FILE, 0o600) } catch {}
    },
  }
}

let outSeq = 0
async function publish(route: DispatchRoute, text: string, meta: Record<string, unknown>): Promise<void> {
  const outbound = parseOutboundMessage(text)
  health.lastOutboundAt = new Date().toISOString()
  process.stdout.write(`${outbound.text}\n`)
  if (route.source === 'agent') return
  if (!outbound.text) throw new Error('dispatcher reply has no text after attachment directives')
  const dir = join(OUTBOX_DIR, route.source)
  const file = join(dir, `${Date.now()}-${process.pid}-${outSeq++}.json`)
  atomicJson(file, { ...route, text: outbound.text, ...(outbound.files.length ? { files: outbound.files } : {}), ...meta })
}

const rpc = new JsonRpcProcess()
const dispatcher = new ChannelDispatcher(rpc, stateStore(), { publish }, WORKDIR)
rpc.onNotification = (method, params) => {
  void dispatcher.notification(method, params).catch(err => fatal(`event ${method} failed: ${err}`))
}

async function initialize(): Promise<void> {
  const init = await rpc.request('initialize', {
    clientInfo: { name: '5dive_channel_dispatcher', title: '5dive Channel Dispatcher', version: BRIDGE_VERSION },
    capabilities: null,
  })
  // The app-server's own word on its version beats `codex --version`: it is
  // the process actually serving this bridge.
  const served = parseCodexVersion(init?.userAgent)
  if (served && health.codex) {
    health.codex.version = served
    health.codex.tested = checkCodex(served).tested
  }
  rpc.notify('initialized', {})
  await dispatcher.initialize()
  // BOUND means a live Codex thread, not "the process started". Everything
  // above can succeed and still leave the bridge unable to run a turn.
  health.bound = Boolean(dispatcher.snapshot().threadId)
  health.failure = undefined
  publishHealth()
  process.stderr.write(`codex-dispatcher: ready thread=${dispatcher.snapshot().threadId} cwd=${WORKDIR}\n`)
}

function ingest(name: string): void {
  if (!name.endsWith('.json')) return
  const full = join(INBOX_DIR, name)
  let raw = ''
  try { raw = readFileSync(full, 'utf8') } catch { return }
  let msg: DispatchMessage
  try { msg = JSON.parse(raw) } catch {
    process.stderr.write(`codex-dispatcher: invalid inbox JSON ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  if (!msg?.id || !msg?.text?.trim() || !msg?.route?.source || !msg?.route?.chat_id) {
    process.stderr.write(`codex-dispatcher: incomplete inbox message ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  if (!['telegram', 'dashboard', 'agent'].includes(msg.route.source)) {
    process.stderr.write(`codex-dispatcher: invalid inbox source ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  health.lastInboundAt = new Date().toISOString()
  void dispatcher.submit(msg).then(outcome => {
    publishHealth()
    try { unlinkSync(full) } catch {}
    process.stderr.write(`codex-dispatcher: ${outcome} ${msg.id} source=${msg.route.source}\n`)
  }).catch(err => {
    // Keep the file: a run-loop restart will retry it after app-server recovers.
    process.stderr.write(`codex-dispatcher: dispatch failed for ${msg.id}: ${err}\n`)
    markFailure(msg.route.source, `dispatch failed for ${msg.id}: ${err}`)
    setTimeout(() => ingest(name), 1000).unref?.()
  })
}

function startInbox(): void {
  const drain = () => { try { for (const f of readdirSync(INBOX_DIR)) ingest(f) } catch {} }
  drain()
  watch(INBOX_DIR, (_event, name) => { if (name) ingest(String(name)) })
  setInterval(drain, 15_000).unref?.()
}

const children: ChildProcessWithoutNullStreams[] = []
function startAdapter(file: string, channel: string, extraEnv: Record<string, string>): void {
  const child = spawn(BUN_BIN, [file], {
    cwd: WORKDIR,
    env: { ...process.env, CODEX_DISPATCHER_STATE_DIR: STATE_DIR, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  children.push(child)
  // Listening is claimed at spawn and RETRACTED on exit. The retraction is the
  // load-bearing half: a dead telegram adapter beside a live dispatcher is
  // precisely the `mismatched` state, and without it the record would keep
  // asserting a channel nobody is serving.
  if (!health.listening.includes(channel)) health.listening.push(channel)
  publishHealth()
  child.once('exit', (code, signal) => {
    health.listening = health.listening.filter(c => c !== channel)
    const why = `adapter exited code=${code ?? 'null'} signal=${signal ?? 'none'}`
    markFailure(channel, why)
    if (!shuttingDown) fatal(`channel adapter ${file} exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
  })
}

let shuttingDown = false
function fatal(message: string): never {
  process.stderr.write(`codex-dispatcher: ${message}\n`)
  recordLifecycle(STATE_DIR, 'crash', 'codex-dispatcher', message)
  health.bound = false
  markFailure('bridge', message)
  shutdown(1)
  throw new Error(message)
}
function shutdown(code = 0): void {
  if (!shuttingDown) {
    shuttingDown = true
    // DIVE-3965: a deliberate stop must be distinguishable from a kill on the
    // next boot. Synchronous and best-effort — an exit path cannot await, and a
    // dispatcher must not fail to exit because its own state file is unwritable.
    try { dispatcher.markCleanShutdown() } catch {}
    for (const child of children) child.kill('SIGTERM')
    rpc.stop()
  }
  setTimeout(() => process.exit(code), 100)
}

// The dispatcher owns the channel lifetime in the primary mode. Keep the
// lifecycle record, stdin-EOF handlers, and real-ppid orphan watchdog on that
// owner rather than on the adapter children it supervises.
installLifecycle({
  channel: 'codex-dispatcher',
  stateDir: STATE_DIR,
  cleanup: () => shutdown(0),
})

publishHealth()
const beat = setInterval(publishHealth, HEALTH_HEARTBEAT_MS)
beat.unref?.()

await initialize()
startInbox()
if (CHANNELS.has('telegram')) {
  startAdapter(join(import.meta.dir, 'server.ts'), 'telegram', { CODEX_DISPATCHER_ADAPTER: 'telegram' })
}
if (CHANNELS.has('dashboard')) {
  startAdapter(join(import.meta.dir, '..', 'dashboard', 'server.ts'), 'dashboard', {
    CODEX_DISPATCHER_ADAPTER: 'dashboard',
    DASHBOARD_STATE_DIR: process.env.DASHBOARD_STATE_DIR
      // The control plane and shelld use this compatibility path for every
      // runtime. Reusing it lets a Codex adapter recover drops made offline.
      ?? join(homedir(), '.claude', 'channels', 'dashboard'),
  })
}
