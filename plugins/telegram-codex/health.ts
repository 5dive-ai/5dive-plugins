// plugins/telegram-codex/health.ts — the Codex channel bridge's HANDSHAKE, and
// the verdict a reader derives from it (DIVE-3964, P05).
//
// WHY THIS EXISTS.
// Until now the only measurable thing about a Codex seat's channels was the
// REFUSAL banner in the session pane (`5dive-cli:agent_channels_binding`,
// DIVE-2766). That probe is honest but one-sided by construction: the binary
// prints no success banner, the refusal line rolls off the scrollback, and the
// whole reading is gone the moment the pane is unreadable. So the fleet had
// exactly two answers — `refused` and `unknown` — and `unknown` covered
// "bound and working" and "silently deaf for 2.2 days" (DIVE-4036) alike.
//
// A banner is a side effect of a session. A handshake is a fact the bridge
// itself asserts, on an interval, in a file a reader can stat. The difference
// that matters is AGE: an assertion that stopped being refreshed is positive
// evidence of a dead bridge, where a missing banner is evidence of nothing.
//
// WHY THE DECISIONS ARE PURE (same reason as lifecycle.ts):
// repo CI runs a bare `bun test` with no plugin dependencies installed, so
// anything importing grammy or the MCP SDK is unexecutable there. This file
// imports node builtins ONLY — `classifyHealth` is therefore actually executed
// by CI rather than grepped for, and 5dive-cli can re-implement the same
// verdict in shell against a format that has a test.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HEALTH_FILE = 'health.json'

/** Bump when a field's MEANING changes. A reader that does not know the schema
 *  must report unknown rather than guess — an old CLI reading a new file is the
 *  ordinary case on a fleet where the plugin and the CLI ship separately. */
export const HEALTH_SCHEMA = 1

/** Heartbeat cadence. Written INTO the record so a reader never hardcodes it:
 *  the bridge is the only thing that knows how often it promised to write. */
export const HEALTH_HEARTBEAT_MS = 15_000

/** How many missed heartbeats before the record is stale. Three, because a
 *  single missed write under load must not restart a working bridge — the bias
 *  is false-negative, like every other threshold the supervisor acts on. */
export const HEALTH_STALE_FACTOR = 3

/** Floor on the staleness window, so a bridge that declares an absurdly small
 *  cadence cannot make itself permanently stale. */
export const HEALTH_STALE_FLOOR_MS = 60_000

export type HealthFailure = {
  at: string
  /** The channel that failed, or `bridge` for the dispatcher itself. */
  channel: string
  /** Actionable cause, in the words the operator needs. Never just "error". */
  cause: string
}

export type ChannelHealth = {
  schema: number
  bridge: string
  bridgeVersion: string
  pid: number
  startedAt: string
  /** Refreshed every HEALTH_HEARTBEAT_MS. This field IS the liveness signal. */
  updatedAt: string
  heartbeatMs: number
  /** Channels this bridge was told to run. */
  declared: string[]
  /** Channels whose adapter is up RIGHT NOW. Disagreement with `declared` is
   *  the mismatch the supervisor acts on. */
  listening: string[]
  /** The app-server handshake completed and a thread is live. */
  bound: boolean
  threadId?: string
  lastInboundAt?: string
  lastOutboundAt?: string
  /** Messages accepted and not yet started. */
  queueDepth: number
  active?: { turnId: string; source: string; startedAt: string }
  failure?: HealthFailure
}

export type HealthState =
  | 'healthy'
  | 'absent'
  | 'stale'
  | 'mismatched'
  | 'unbound'
  | 'failed'

/** What a supervisor should DO. `restart` is only ever proposed for a cause a
 *  restart can plausibly fix; a named failure cause (a dead token, a refused
 *  account) survives every restart, so it is reported, not retried. */
export type HealthRepair = 'none' | 'restart' | 'report'

export type HealthVerdict = {
  state: HealthState
  detail: string
  repair: HealthRepair
}

export type ClassifyInput = {
  /** Parsed health record, or null when the file is absent/unparseable. */
  health: ChannelHealth | null
  /** What the REGISTRY says this agent should be running. The handshake alone
   *  cannot detect a channel that was declared and never even attempted. */
  declared: string[]
  /** Whether the agent's service unit is up. An absent handshake under a dead
   *  unit is expected, not a defect. */
  serviceActive: boolean
  now: Date
  /** Restarts already spent on this condition without healing it. */
  repairAttempts?: number
  /** Ceiling on those restarts. Past it the answer is a report, not another
   *  restart — a restart loop is how a broken bridge becomes a broken box. */
  maxRepairs?: number
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort()
  const y = [...new Set(b)].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

export function staleAfterMs(health: ChannelHealth): number {
  const cadence = Number.isFinite(health.heartbeatMs) && health.heartbeatMs > 0
    ? health.heartbeatMs
    : HEALTH_HEARTBEAT_MS
  return Math.max(HEALTH_STALE_FLOOR_MS, cadence * HEALTH_STALE_FACTOR)
}

/**
 * The whole verdict, as one pure function. Order is deliberate: a reading we
 * cannot trust (absent, wrong schema, stale) is settled BEFORE any field inside
 * the record is believed, because a stale record's `bound: true` is exactly the
 * lie this ticket exists to stop reporting.
 */
export function classifyHealth(input: ClassifyInput): HealthVerdict {
  const { health, declared, serviceActive, now } = input
  const attempts = input.repairAttempts ?? 0
  const max = input.maxRepairs ?? 2
  // A restart is only offered while restarts are still plausibly useful.
  const restartOrReport: HealthRepair = attempts >= max ? 'report' : 'restart'
  const exhausted = (detail: string): string =>
    attempts >= max
      ? `${detail}; ${attempts} restart(s) did not heal it — this needs a person, not another restart`
      : detail

  if (declared.length === 0) {
    return { state: 'healthy', detail: 'no channels declared, nothing to bind', repair: 'none' }
  }

  if (!health) {
    if (!serviceActive) {
      return {
        state: 'absent',
        detail: 'no handshake and the agent service is not running — start the agent first',
        repair: 'none',
      }
    }
    const d = 'the agent is running but its Codex channel bridge has never written a handshake — the bridge did not start'
    return { state: 'absent', detail: exhausted(d), repair: restartOrReport }
  }

  if (health.schema !== HEALTH_SCHEMA) {
    return {
      state: 'absent',
      detail: `handshake schema ${health.schema} is not readable by this build (expected ${HEALTH_SCHEMA}) — upgrade the CLI or the plugin`,
      repair: 'report',
    }
  }

  const updated = Date.parse(health.updatedAt)
  if (!Number.isFinite(updated)) {
    return {
      state: 'stale',
      detail: `handshake has an unreadable updatedAt (${health.updatedAt})`,
      repair: 'report',
    }
  }
  const ageMs = now.getTime() - updated
  const window = staleAfterMs(health)
  if (ageMs > window) {
    const d = `handshake last refreshed ${Math.round(ageMs / 1000)}s ago, past its ${Math.round(window / 1000)}s window — the bridge is wedged or gone (pid ${health.pid})`
    return { state: 'stale', detail: exhausted(d), repair: restartOrReport }
  }

  // Fresh from here down, so the record's own fields are believable.

  if (health.failure && !health.bound) {
    return {
      state: 'failed',
      detail: `${health.failure.channel}: ${health.failure.cause} (at ${health.failure.at})`,
      repair: 'report',
    }
  }

  if (!health.bound) {
    const d = 'the bridge is running but has no live Codex thread — the app-server handshake has not completed'
    return { state: 'unbound', detail: exhausted(d), repair: restartOrReport }
  }

  if (!sameSet(declared, health.listening)) {
    const missing = declared.filter(c => !health.listening.includes(c))
    const extra = health.listening.filter(c => !declared.includes(c))
    const parts: string[] = []
    if (missing.length) parts.push(`declared but not listening: ${missing.join(',')}`)
    if (extra.length) parts.push(`listening but not declared: ${extra.join(',')}`)
    const cause = health.failure ? ` (last failure — ${health.failure.channel}: ${health.failure.cause})` : ''
    const d = `${parts.join('; ')}${cause}`
    // A channel that is declared and not listening is exactly what a restart
    // re-attempts; a named failure cause is not, and says so in `detail`.
    return { state: 'mismatched', detail: exhausted(d), repair: health.failure ? 'report' : restartOrReport }
  }

  return {
    state: 'healthy',
    detail: `bound, listening on ${health.listening.join(',')}${health.active ? `, turn ${health.active.turnId} from ${health.active.source}` : ''}${health.queueDepth ? `, ${health.queueDepth} queued` : ''}`,
    repair: 'none',
  }
}

/** One line for a human, from the verdict plus the record it came from. */
export function renderHealth(v: HealthVerdict, health: ChannelHealth | null): string {
  if (!health) return `${v.state} — ${v.detail}`
  const bits = [
    `bridge ${health.bridgeVersion}`,
    `queue ${health.queueDepth}`,
    `in ${health.lastInboundAt ?? 'never'}`,
    `out ${health.lastOutboundAt ?? 'never'}`,
  ]
  return `${v.state} — ${v.detail} [${bits.join(' · ')}]`
}

// ── the writer ──────────────────────────────────────────────────────────────

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Write the handshake. Never throws: a bridge must not die because its own
 * health file is unwritable — an unwritable file already reads as `absent`,
 * which is the correct answer and reaches the operator through the reader.
 */
export function writeHealth(stateDir: string, health: ChannelHealth): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    atomicWrite(join(stateDir, HEALTH_FILE), JSON.stringify(health) + '\n')
  } catch {}
}

/** Read + parse, with every failure collapsing to null (= `absent`). */
export function readHealth(stateDir: string): ChannelHealth | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, HEALTH_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as ChannelHealth : null
  } catch {
    return null
  }
}
