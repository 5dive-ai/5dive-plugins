/**
 * DIVE-7422: mid-turn inbound, surfaced to a push-less runtime.
 *
 * A Telegram message that lands while the agent is busy with tool calls sits in
 * the server's inboxQueue until the turn's next wait_for_message — the model has
 * no way to see it during the turn (box report 598: the owner sent three
 * messages over ~1.5 min and the agent answered the stale question). The
 * runtime's hook contract gives exactly one mid-turn surface: a PreToolUse hook
 * may `deny` with a `reason`, and that reason is the only text a hook can put in
 * front of the model during a turn (PostToolUse stdout is ignored).
 *
 * So the server writes a small state file whenever its queue changes, and the
 * PreToolUse hook (hooks/inbound-surface.ts) denies ONE tool call per new batch
 * with a reason telling the model to call wait_for_message. The state lives here
 * so both sides read and write the same shape, and so the decision is testable
 * without booting a server (importing server.ts long-polls Telegram).
 *
 * Pure module: no tokens, copied byte-exact by the generator.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'

export const PENDING_FILE = 'pending-inbound.json'
export const SURFACED_FILE = 'pending-inbound.surfaced'
const PREVIEW_MAX = 80

export type PendingInbound = {
  pid: number      // the server that wrote it — a dead pid means the file is stale
  count: number    // messages queued right now
  seq: number      // monotonic id of the newest queued message (a new batch has a higher seq)
  oldest_ts: string
  preview: string  // newest message, one line, capped
}

export function previewOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  return one.length > PREVIEW_MAX ? one.slice(0, PREVIEW_MAX - 1) + '…' : one
}

/** Server side: mirror the queue to disk. An empty queue removes the file. */
export function writePending(stateDir: string, state: PendingInbound | null): void {
  const file = join(stateDir, PENDING_FILE)
  try {
    if (!state || state.count <= 0) { unlinkSync(file); return }
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, file)
  } catch { /* best-effort: a missing file only means no mid-turn surface */ }
}

export function readPending(stateDir: string): PendingInbound | null {
  try {
    const s = JSON.parse(readFileSync(join(stateDir, PENDING_FILE), 'utf8'))
    if (typeof s?.seq !== 'number' || typeof s?.count !== 'number' || s.count <= 0) return null
    return s as PendingInbound
  } catch { return null }
}

export function readSurfaced(stateDir: string): number {
  try { return Number(readFileSync(join(stateDir, SURFACED_FILE), 'utf8')) || 0 } catch { return 0 }
}

export function writeSurfaced(stateDir: string, seq: number): void {
  try { writeFileSync(join(stateDir, SURFACED_FILE), String(seq), { mode: 0o600 }) } catch {}
}

/**
 * Never deny the tools the model needs to READ the messages. MCP tools arrive
 * namespaced as `<server>__<tool>` (telegram__wait_for_message), directly or via
 * the runtime's `use_tool` wrapper; `search_tool` is how the model discovers them.
 */
export function isTelegramToolCall(toolName: string, toolInput: unknown): boolean {
  if (/(^|_)telegram__/.test(toolName)) return true
  if (toolName === 'search_tool') return true
  if (toolName === 'use_tool') {
    try { return JSON.stringify(toolInput ?? '').includes('telegram__') } catch { return false }
  }
  return false
}

export function denyReason(p: PendingInbound): string {
  const n = p.count === 1 ? '1 new Telegram message' : `${p.count} new Telegram messages`
  return `${n} arrived while you were working (latest: "${p.preview}"). `
    + 'Call wait_for_message now to read them, answer briefly, then retry this call.'
}

export type SurfaceDecision = { deny: false } | { deny: true; seq: number; reason: string }

/**
 * Deny once per batch: only when the newest queued message is newer than the
 * last one already surfaced, the writer is alive, and the call is not one of the
 * telegram tools. Everything else allows — this hook must never wedge a turn.
 */
export function decideSurface(
  pending: PendingInbound | null,
  surfacedSeq: number,
  toolName: string,
  toolInput: unknown,
  pidAlive: (pid: number) => boolean,
): SurfaceDecision {
  if (!pending) return { deny: false }
  if (isTelegramToolCall(toolName, toolInput)) return { deny: false }
  if (pending.seq <= surfacedSeq) return { deny: false }
  if (!pidAlive(pending.pid)) return { deny: false }
  return { deny: true, seq: pending.seq, reason: denyReason(pending) }
}

/**
 * Fallback surface on telegram tool results, for a runtime that does not show
 * the deny reason to the model: fires only when the model touches Telegram.
 */
export function pendingNotice(count: number): string {
  const n = count === 1 ? '1 new Telegram message is' : `${count} new Telegram messages are`
  return `<telegram-pending count=${count}/> ${n} waiting: call wait_for_message now to read them.`
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}
