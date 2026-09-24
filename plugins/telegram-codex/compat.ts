// plugins/telegram-codex/compat.ts — which Codex and which saved state this
// bridge can run against, decided BEFORE anything is started (DIVE-3969, P10).
//
// WHY THIS EXISTS.
// The dispatcher spawns `codex app-server --stdio`. Codex 0.135.0 and older
// reject that flag ("unexpected argument '--stdio' found"), so on those builds
// the app-server exits at once and the only visible symptom was the generic
// "app-server exited code=2", restarted forever by the run-loop. Measured
// 2026-09-24 against the published linux-x64 builds, one initialize request
// each over stdio:
//
//   0.100.0 0.120.0 0.134.0 0.135.0   -> unexpected argument '--stdio'
//   0.136.0 0.137.0 0.138.0 0.139.0
//   0.140.0 0.142.0 0.143.0 0.144.0
//   0.145.0                           -> initialize answered (userAgent .../<ver>)
//   0.153.3 0.156.1                   -> the same, and 0.156.1 is the live seat
//
// Every app-server method and notification the dispatcher uses (thread/start,
// thread/resume, turn/start, turn/steer, item/agentMessage/delta,
// item/completed, turn/completed) is already in 0.100.0's generated protocol
// schema, so the transport flag is the binding constraint, not the protocol.
//
// WHY THE DECISIONS ARE PURE (same reason as health.ts and lifecycle.ts):
// repo CI runs a bare `bun test` with no plugin dependencies, so this file
// imports nothing at all and every verdict below is executed by CI.

/** Oldest Codex whose app-server accepts `--stdio`. Below it the dispatcher
 *  cannot start, so it refuses with this number instead of crash-looping. */
export const CODEX_MIN_VERSION = '0.136.0'

/** Newest Codex this bridge has been run against. Newer builds are ALLOWED —
 *  refusing a newer Codex would turn every upstream release into an outage —
 *  but the handshake records that the pair is untested. */
export const CODEX_TESTED_MAX = '0.156.1'

/** The dispatcher's `state.json` format. Bump only when a field's MEANING
 *  changes; an added optional field is not a bump. Files written before this
 *  number existed carry no `schema` and are read as the same format. */
export const DISPATCHER_STATE_SCHEMA = 1

/** Opt-out for a canary against a Codex below the floor. Never set it on a
 *  seat: below the floor the app-server exits before the first request. */
export const ALLOW_UNSUPPORTED_ENV = 'CODEX_DISPATCHER_ALLOW_UNSUPPORTED'

/** The first `x.y.z` in the text. Accepts `codex --version` output
 *  (`codex-cli 0.156.1`) and an app-server userAgent
 *  (`5dive_channel_dispatcher/0.156.1 (Ubuntu ...)`). */
export function parseCodexVersion(text: string | null | undefined): string | null {
  const m = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export type CodexCompat = {
  /** False means: do not start the app-server. */
  ok: boolean
  version: string | null
  minimum: string
  testedMax: string
  /** Inside [minimum, testedMax]. */
  tested: boolean
  detail: string
}

/**
 * The verdict on the Codex half of the pair. `probe` is whatever
 * `codex --version` printed, or null when it could not be run at all.
 */
export function checkCodex(probe: string | null, allowUnsupported = false): CodexCompat {
  const version = parseCodexVersion(probe)
  const base = { version, minimum: CODEX_MIN_VERSION, testedMax: CODEX_TESTED_MAX }
  if (probe === null) {
    return {
      ...base, ok: false, tested: false,
      detail: 'the Codex CLI could not be run (`codex --version` failed) — install Codex or set CODEX_BIN',
    }
  }
  if (!version) {
    return {
      ...base, ok: allowUnsupported, tested: false,
      detail: `could not read a Codex version from \`${probe.trim().slice(0, 80)}\` — this bridge needs Codex >= ${CODEX_MIN_VERSION}`,
    }
  }
  if (compareVersions(version, CODEX_MIN_VERSION) < 0) {
    return {
      ...base, ok: allowUnsupported, tested: false,
      detail: `Codex ${version} is older than ${CODEX_MIN_VERSION}, the first release whose app-server accepts --stdio — upgrade Codex (npm i -g @openai/codex)`,
    }
  }
  const tested = compareVersions(version, CODEX_TESTED_MAX) <= 0
  return {
    ...base, ok: true, tested,
    detail: tested
      ? `Codex ${version} is supported (tested ${CODEX_MIN_VERSION}–${CODEX_TESTED_MAX})`
      : `Codex ${version} is newer than the newest tested release (${CODEX_TESTED_MAX}) — allowed, untested`,
  }
}

// ── the saved state ─────────────────────────────────────────────────────────

export type MigratedState<S> = {
  state: S
  /** True when the input was not already the current format. */
  migrated: boolean
  /** Set when the file must be moved aside, not read: a newer bridge wrote it
   *  (the ordinary shape of a rollback) or it is not a state record at all. */
  quarantine?: string
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Bring a parsed `state.json` to the current format. Idempotent by
 * construction: its own output is already current, so a second pass returns
 * the same state with `migrated: false`. Never throws.
 *
 * A file written by a NEWER bridge is not guessed at. The fields may mean
 * something else there, and resuming a thread or replaying a queue on a
 * misread is worse than starting clean — so the caller moves the file aside
 * (kept, not deleted, so a roll-forward can restore it) and the person in the
 * chat is told the earlier conversation is not in context.
 */
export function migrateState<S extends { seen: string[]; pending: unknown[]; schema?: number }>(
  raw: unknown,
): MigratedState<S> {
  const fresh = { schema: DISPATCHER_STATE_SCHEMA, seen: [], pending: [] } as unknown as S
  if (raw === null || raw === undefined) return { state: fresh, migrated: false }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: fresh, migrated: true, quarantine: 'the saved dispatcher state is not a JSON object' }
  }
  const rec = raw as Record<string, unknown>
  const schema = rec.schema
  if (schema !== undefined && (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1)) {
    return { state: fresh, migrated: true, quarantine: `the saved dispatcher state has an invalid schema (${JSON.stringify(schema)})` }
  }
  if (typeof schema === 'number' && schema > DISPATCHER_STATE_SCHEMA) {
    return {
      state: fresh, migrated: true,
      quarantine: `the saved dispatcher state is schema ${schema}, written by a newer bridge than this one (reads ${DISPATCHER_STATE_SCHEMA})`,
    }
  }
  const seen = stringArray(rec.seen)
  const pending = Array.isArray(rec.pending) ? rec.pending : []
  const migrated = schema === undefined
    || !Array.isArray(rec.seen) || seen.length !== (rec.seen as unknown[]).length
    || !Array.isArray(rec.pending)
  const state = { ...rec, schema: DISPATCHER_STATE_SCHEMA, seen, pending } as unknown as S
  return { state, migrated }
}
