import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const PENDING_MAX_LOCAL_ATTEMPTS = 3
export const PENDING_RETRY_BASE_MS = 5 * 60_000

export type PendingRetryRecord = {
  attempts: number
  lastAttemptAt: number
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
      next: { attempts, lastAttemptAt: previous?.lastAttemptAt ?? now, parkedLogged: true },
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
    next: { attempts: attempt, lastAttemptAt: now },
  }
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
