import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// DIVE-6549: messages the agent-inbox drop already put in front of the session.
//
// The control plane offers a collected message on /pending again once its
// 10-minute TTL runs out (DIVE-3809), and nothing retired a message the drop
// had delivered live, so each one came back up to three more times, a fresh
// model turn every time (exact-swallow, 2026-10-19: ten answered voice notes,
// each pushed back into the session four more times). The drop and /pending
// describe one message with the same chat_id and ts (the row's conversation id
// and created_at), so a re-offer of a message the drop delivered is acked and
// not pushed. The record outlives the control plane's last re-offer
// (5 attempts, 10 minutes apart) with room to spare.
export const LIVE_RETENTION_MS = 24 * 60 * 60_000

// key -> when the drop delivered it (epoch ms)
export type LiveDeliveryState = Record<string, number>

export function liveKey(chatId: unknown, ts: unknown): string | null {
  if (typeof chatId !== 'string' || !chatId || typeof ts !== 'string' || !ts) return null
  return `${chatId} ${ts}`
}

export function recordLiveDelivery(
  state: LiveDeliveryState,
  key: string,
  now: number,
  retentionMs = LIVE_RETENTION_MS,
): void {
  state[key] = now
  for (const [k, at] of Object.entries(state)) {
    if (now - at > retentionMs) delete state[k]
  }
}

export function deliveredLive(state: LiveDeliveryState, key: string | null): boolean {
  return key !== null && Object.prototype.hasOwnProperty.call(state, key)
}

export function loadLiveDeliveries(path: string): LiveDeliveryState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state: LiveDeliveryState = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (Number.isFinite(v)) state[k] = Number(v)
    }
    return state
  } catch {
    return {}
  }
}

export function saveLiveDeliveries(path: string, state: LiveDeliveryState): void {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Losing this record costs a duplicate push, never a lost message.
  }
}
