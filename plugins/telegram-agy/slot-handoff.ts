/**
 * DIVE-7460: hand the getUpdates slot to a NEWER sibling server.ts that its own
 * session parent is talking to.
 *
 * A runtime TUI can re-spawn its Telegram MCP server WITHOUT closing the old
 * one (box report, chill-gorge 2026-11-01: a second server.ts under the same
 * TUI pid, the old one's stdio pipes still held open by that TUI). Nothing
 * then retires the old server: stdin never hits EOF (DIVE-1251), its parent is
 * alive so the ppid clause never fires (DIVE-3752), and its heartbeat stays
 * fresh so the newcomer parks in acquireSlot() forever (DIVE-818). The TUI
 * sends wait_for_message to the NEW server while Telegram delivers to the OLD
 * one: the seat is deaf with every process "running".
 *
 * The handoff:
 *   1. A PARKED server that has received a real tool call (proof its parent is
 *      routing to it — a transient enumeration spawn never makes one, so the
 *      DIVE-818 "never stomp a healthy incumbent" guarantee still holds for
 *      them) and whose incumbent shares its session parent AND is older writes
 *      a request file naming itself.
 *   2. The incumbent sees the request on its next heartbeat, stops polling,
 *      writes its undelivered queue to a hand-over file, and releases the
 *      PID/heartbeat files. It does NOT exit: killing it makes the TUI re-spawn
 *      it (measured on the same box), and a stepped-down server simply parks
 *      again, so it takes the slot back only if the newcomer dies.
 *   3. The newcomer claims the free slot and drains the hand-over file.
 * Only a YOUNGER server may ask, so two siblings can never ping-pong.
 *
 * Pure module: no tokens, copied byte-exact by the generator.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'

export const HANDOFF_REQUEST_FILE = 'bot.handoff'
export const HANDOFF_QUEUE_FILE = 'bot.handoff-queue.json'

// A request older than this is ignored: its writer may have died or already
// got the slot some other way.
export const HANDOFF_REQUEST_TTL_MS = 60_000

export type ProcStat = { pid: number; comm: string; ppid: number; startTicks: number }

/** Parse a /proc/<pid>/stat line. comm may contain spaces and parens. */
export function parseProcStat(line: string): ProcStat | null {
  const open = line.indexOf('(')
  const close = line.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = parseInt(line.slice(0, open), 10)
  const comm = line.slice(open + 1, close)
  // Fields after comm: state(3) ppid(4) … starttime(22) — index 0 here is state.
  const rest = line.slice(close + 2).split(' ')
  const ppid = parseInt(rest[1] ?? '', 10)
  const startTicks = parseInt(rest[19] ?? '', 10)
  if (!(pid > 0) || !(ppid >= 0) || !(startTicks >= 0)) return null
  return { pid, comm, ppid, startTicks }
}

export type StatReader = (pid: number) => ProcStat | null

export const readProcStat: StatReader = pid => {
  try { return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return null }
}

/**
 * The session that owns this server: the nearest ancestor that is not a `bun`
 * wrapper. The manifest launches us as `bun run … start` → `bun server.ts`, and
 * whether that leaves an intermediate `bun` between us and the TUI depends on
 * the bun version — two spawns under one TUI must compare equal either way.
 * 0 = unknown, which never matches (fail closed to the old, wait-it-out path).
 */
export function sessionParent(pid: number, read: StatReader = readProcStat): number {
  let p = read(pid)?.ppid ?? 0
  for (let hops = 0; p > 1 && hops < 3; hops++) {
    const st = read(p)
    if (!st) return 0
    if (st.comm !== 'bun') return p
    p = st.ppid
  }
  return p > 1 ? p : 0
}

/**
 * True when `younger` and `older` are two servers of ONE session and `younger`
 * really started later. Both conditions are needed: a different session's
 * spawn (`<cli> mcp list`) must never take the slot, and the age order is what
 * makes the handoff one-way.
 */
export function siblingYounger(younger: number, older: number, read: StatReader = readProcStat): boolean {
  if (!(younger > 1) || !(older > 1) || younger === older) return false
  const y = read(younger)
  const o = read(older)
  if (!y || !o) return false
  const sy = sessionParent(younger, read)
  if (sy === 0 || sy !== sessionParent(older, read)) return false
  return y.startTicks > o.startTicks || (y.startTicks === o.startTicks && younger > older)
}

export type HandoffRequest = { pid: number; at: number }

function atomicWrite(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, file)
}

export function writeHandoffRequest(stateDir: string, pid: number, now = Date.now()): void {
  try { atomicWrite(join(stateDir, HANDOFF_REQUEST_FILE), JSON.stringify({ pid, at: now })) } catch {}
}

export function readHandoffRequest(stateDir: string, now = Date.now()): HandoffRequest | null {
  try {
    const r = JSON.parse(readFileSync(join(stateDir, HANDOFF_REQUEST_FILE), 'utf8'))
    if (typeof r?.pid !== 'number' || typeof r?.at !== 'number') return null
    if (now - r.at > HANDOFF_REQUEST_TTL_MS) return null
    return r as HandoffRequest
  } catch { return null }
}

export function clearHandoffRequest(stateDir: string): void {
  try { unlinkSync(join(stateDir, HANDOFF_REQUEST_FILE)) } catch {}
}

/** Incumbent side: park the undelivered queue for the next slot holder. */
export function writeHandoffQueue<T>(stateDir: string, msgs: T[]): void {
  if (msgs.length === 0) return
  // Append to anything a previous step-down left undrained, never overwrite it.
  const prior = takeHandoffQueue<T>(stateDir)
  try { atomicWrite(join(stateDir, HANDOFF_QUEUE_FILE), JSON.stringify([...prior, ...msgs])) } catch {}
}

/** New slot holder: take (read + remove) the hand-over queue. */
export function takeHandoffQueue<T>(stateDir: string): T[] {
  const file = join(stateDir, HANDOFF_QUEUE_FILE)
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  try { unlinkSync(file) } catch {}
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v as T[] : []
  } catch { return [] }
}
