import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const PENDING_MAX_LOCAL_ATTEMPTS = 3
export const PENDING_RETRY_BASE_MS = 5 * 60_000
// DIVE-5924: how long a record outlives the control plane's last offer of its
// id. An ack must NOT end a record: since DIVE-3809 the control plane hides a
// collected row for a TTL (10 min) and then offers it again, up to 5 times, so
// "absent from this fetch" is the normal state of every acked row between two
// offers. Only a long silence means the control plane is done with the id.
export const PENDING_RETRY_RETENTION_MS = 24 * 60 * 60_000

export type PendingRetryRecord = {
  attempts: number
  lastAttemptAt: number
  // When a /pending fetch last offered this id (DIVE-5924).
  lastSeenAt?: number
  parkedLogged?: boolean
}

export type PendingRetryState = Record<string, PendingRetryRecord>

export type PendingAttemptDecision =
  | { kind: 'deliver'; attempt: number; deliveredAt: string; redelivery: boolean; next: PendingRetryRecord }
  | { kind: 'backoff'; retryAt: number }
  | { kind: 'park'; log: boolean; next: PendingRetryRecord }

export function nextPendingAttempt(
  previous: PendingRetryRecord | undefined,
  now: number,
  baseMs = PENDING_RETRY_BASE_MS,
  maxAttempts = PENDING_MAX_LOCAL_ATTEMPTS,
): PendingAttemptDecision {
  const attempts = Math.max(0, previous?.attempts ?? 0)
  if (attempts >= maxAttempts) {
    return {
      kind: 'park',
      log: !previous?.parkedLogged,
      next: {
        attempts,
        lastAttemptAt: previous?.lastAttemptAt ?? now,
        ...(previous?.lastSeenAt !== undefined ? { lastSeenAt: previous.lastSeenAt } : {}),
        parkedLogged: true,
      },
    }
  }
  if (attempts > 0) {
    const delay = baseMs * 2 ** (attempts - 1)
    const retryAt = (previous?.lastAttemptAt ?? 0) + delay
    if (now < retryAt) return { kind: 'backoff', retryAt }
  }
  const attempt = attempts + 1
  return {
    kind: 'deliver',
    attempt,
    deliveredAt: new Date(now).toISOString(),
    redelivery: attempts > 0,
    next: { attempts: attempt, lastAttemptAt: now, lastSeenAt: now },
  }
}

// DIVE-5924 — the one place a retry record ends. Called with the ids of every
// successful /pending fetch (an empty one included). An offered id is stamped
// as seen; an id the control plane has not offered for `retentionMs` is
// dropped. The ack never deletes a record: it used to, so each re-offer of an
// acked row started again at attempt 1 — `redelivery` was always false and
// the 3-attempt park never fired. Returns whether the state changed.
export function observePendingOffer(
  state: PendingRetryState,
  offeredIds: Iterable<number | string>,
  now: number,
  retentionMs = PENDING_RETRY_RETENTION_MS,
): boolean {
  const offered = new Set(Array.from(offeredIds, String))
  let changed = false
  for (const [id, record] of Object.entries(state)) {
    if (offered.has(id)) {
      if (record.lastSeenAt !== now) { record.lastSeenAt = now; changed = true }
      continue
    }
    if (now - Math.max(record.lastSeenAt ?? 0, record.lastAttemptAt) > retentionMs) {
      delete state[id]
      changed = true
    }
  }
  return changed
}

export function loadPendingRetryState(path: string): PendingRetryState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state: PendingRetryState = {}
    for (const [id, value] of Object.entries(parsed)) {
      const v = value as Partial<PendingRetryRecord>
      if (!/^\d+$/.test(id) || !Number.isInteger(v.attempts) || Number(v.attempts) < 0 || !Number.isFinite(v.lastAttemptAt)) continue
      state[id] = {
        attempts: Number(v.attempts),
        lastAttemptAt: Number(v.lastAttemptAt),
        ...(Number.isFinite(v.lastSeenAt) ? { lastSeenAt: Number(v.lastSeenAt) } : {}),
        ...(v.parkedLogged === true ? { parkedLogged: true } : {}),
      }
    }
    return state
  } catch {
    return {}
  }
}

export function savePendingRetryState(path: string, state: PendingRetryState): void {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Delivery must keep working if its diagnostic state cannot be persisted.
  }
}

// DIVE-4841 — the delivery tags that ride a pending push's channel `meta`.
//
// Claude Code validates `notifications/claude/channel` params with
// `meta: Record<string, string>` and DROPS a notification that fails the
// schema — silently: `notification()` resolves either way. DIVE-4125 put
// `attempt` (number) and `redelivery` (boolean) on the meta as-is, so from
// plugin 0.4.3 onward EVERY dashboard pending message was pushed, logged as
// pushed, acked to the control plane, and never seen by the model, while the
// agent-inbox drop path (all-string meta) kept working — which is how it was
// found (a probe through the drop-dir answered "OK" 20 s after a pending push
// of the same session was ignored). Every value here is a string, by type.
export function pendingDeliveryMeta(
  decision: Extract<PendingAttemptDecision, { kind: 'deliver' }>,
): { delivered_at: string; delivery_attempt: string; redelivery: string } {
  return {
    delivered_at: String(decision.deliveredAt),
    delivery_attempt: String(decision.attempt),
    redelivery: String(decision.redelivery),
  }
}
