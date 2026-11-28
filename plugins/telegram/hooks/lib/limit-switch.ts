// DIVE-9477 (lodar 2026-11-28: «when limit hit and account has second account can give button to switch
// to second account?», then «feels too complex. pls dont make new bugs on this»): ONE button on the usage-limit
// notice, «Switch to <account>», in Telegram and in the 5dive app chat, and only when the box holds another
// account of the same AI with room left. A tap moves this agent once, through the existing `agent
// set-account` path, and resumes the same conversation on the new account. Nothing switches without the tap;
// rotation and its defaults are untouched. With no such account the notice is exactly what it was.
//
// The one place both channels read (Telegram's hook and server, and the dashboard's, which run a byte-identical
// copy of this file: plugins/dashboard/hooks/SHARED.txt). It decides WHICH account is offered, the button's
// words, and arms the resume marker a tap needs. Pure where it can be: the CLI reads come in through `Read`.

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** An account's 5h or 7d reading, as `5dive account usage --json` prints it. */
type Window = { pct?: unknown } | null | undefined
export type UsageRow = {
  name?: unknown
  usage?: { fiveHour?: Window; sevenDay?: Window; asOf?: unknown; pollError?: unknown } | null
}
/** `5dive account list --json`: the AIs each account holds a sign-in for. */
export type AccountRow = { name?: unknown; types?: unknown }

/** Under this on both windows is «room left» (the rotation path's own threshold, stopfailure-notify.ts). */
export const SWITCH_HEADROOM_PCT = 90
/** A reading older than this says nothing about the account now: no button. */
export const SWITCH_FRESH_S = 6 * 3600

const NAME_RE = /^([a-z][a-z0-9_-]{0,31})$/

function pct(w: Window): number | null {
  return w && typeof w.pct === 'number' && Number.isFinite(w.pct) ? w.pct : null
}

/**
 * The other account to offer at the limit, or null (then the notice carries no button). Every doubt is a null:
 * an unknown current account, an unreadable list, an account without a sign-in for this AI, no reading, a
 * failed or stale reading, or one at 90% or more on either window. Of several, the one with the most room.
 */
export function pickSwitchAccount(o: {
  active: string | null
  type: string
  accounts: AccountRow[] | null
  usage: UsageRow[] | null
  nowSec: number
}): string | null {
  if (!o.active || !Array.isArray(o.accounts) || !Array.isArray(o.usage)) return null
  const sameAi = new Set(
    o.accounts
      .filter(a => typeof a?.name === 'string' && Array.isArray(a.types) && a.types.includes(o.type))
      .map(a => a.name as string),
  )
  let best: { name: string; five: number } | null = null
  for (const r of o.usage) {
    const name = typeof r?.name === 'string' ? r.name : ''
    if (!NAME_RE.test(name) || name === o.active || !sameAi.has(name)) continue
    const u = r.usage
    if (!u || u.pollError) continue
    const asOf = typeof u.asOf === 'number' ? u.asOf : 0
    if (!asOf || o.nowSec - asOf > SWITCH_FRESH_S) continue
    const five = pct(u.fiveHour)
    if (five === null || five >= SWITCH_HEADROOM_PCT) continue
    const seven = pct(u.sevenDay)
    if (seven !== null && seven >= SWITCH_HEADROOM_PCT) continue
    if (!best || five < best.five) best = { name, five }
  }
  return best?.name ?? null
}

/** The button's words, in the notice's language. */
export function switchLabel(account: string, lang: 'en' | 'ru' = 'en'): string {
  return lang === 'ru' ? `Перейти на ${account}` : `Switch to ${account}`
}

/** Telegram's callback data for the tap (≤ 64 bytes: 4 + a 32-character name). */
export const SWITCH_CALLBACK_PREFIX = 'lsw:'
export function switchCallbackData(account: string): string {
  return SWITCH_CALLBACK_PREFIX + account
}
/** The account a tap names, or null for anything that is not one. */
export function parseSwitchCallback(data: string): string | null {
  if (!data.startsWith(SWITCH_CALLBACK_PREFIX)) return null
  const m = NAME_RE.exec(data.slice(SWITCH_CALLBACK_PREFIX.length))
  return m ? m[1]! : null
}

export type Read = (args: string[], timeoutMs: number) => Promise<unknown>

function parse(stdout: unknown): unknown {
  try { return JSON.parse(String(stdout ?? '').trim()) } catch { return null }
}
function run(cmd: string, args: string[], timeoutMs: number): Promise<unknown> {
  // The CLI prints its envelope on stdout even when it exits nonzero, so stdout is read either way.
  return new Promise(res => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, (_err, stdout) => res(parse(stdout)))
  })
}
/**
 * A 5dive read as this seat's own uid first (a standard seat's `account list|usage` crosses its own grant),
 * and `sudo -n` only when that did not answer ok: the same order as wall-rotate.ts.
 */
export const cliRead: Read = async (args, timeoutMs) => {
  const bare = await run('5dive', args, timeoutMs)
  if ((bare as { ok?: unknown } | null)?.ok === true) return bare
  return run('sudo', ['-n', '5dive', ...args], timeoutMs)
}

function dataArray(j: unknown): unknown[] | null {
  const e = j as { ok?: unknown; data?: unknown } | null
  return e && e.ok === true && Array.isArray(e.data) ? e.data : null
}

/**
 * The hook's read: the account list and the usage board, side by side, inside `budgetMs`. A read that has not
 * answered by then is a null, so the notice goes out on time and without a button.
 */
export async function readSwitchAccount(o: {
  active: string | null
  type: string
  read: Read
  budgetMs: number
  nowSec?: number
}): Promise<string | null> {
  if (!o.active) return null
  const timeout = new Promise<null>(res => setTimeout(() => res(null), o.budgetMs).unref?.())
  const both = Promise.all([
    o.read(['--json', 'account', 'list'], o.budgetMs).catch(() => null),
    o.read(['--json', 'account', 'usage'], o.budgetMs).catch(() => null),
  ])
  const got = await Promise.race([both, timeout])
  if (!got) return null
  return pickSwitchAccount({
    active: o.active,
    type: o.type,
    accounts: dataArray(got[0]) as AccountRow[] | null,
    usage: dataArray(got[1]) as UsageRow[] | null,
    nowSec: o.nowSec ?? Math.floor(Date.now() / 1000),
  })
}

/** Where 5dive-agent-start looks for a one-shot `claude --resume` (whatever channel armed it). */
export function resumeMarkerPath(home: string = homedir()): string {
  return join(home, '.claude', 'channels', 'telegram', 'resume-next')
}

/** This seat's newest conversation: projects/<project>/<session-id>.jsonl (subagent transcripts sit deeper). */
export function newestSessionId(home: string = homedir()): string | null {
  const root = join(home, '.claude', 'projects')
  let best: { id: string; at: number } | null = null
  let dirs: string[]
  try { dirs = readdirSync(root) } catch { return null }
  for (const d of dirs) {
    let names: string[]
    try { names = readdirSync(join(root, d)) } catch { continue }
    for (const n of names) {
      const m = /^([0-9a-fA-F-]{36})\.jsonl$/.exec(n)
      if (!m) continue
      try {
        const at = statSync(join(root, d, n)).mtimeMs
        if (!best || at > best.at) best = { id: m[1]!, at }
      } catch {}
    }
  }
  return best?.id ?? null
}

/**
 * Before a tapped switch restarts the agent: arm the same one-shot resume the rotation path arms, so the agent
 * comes back in this conversation on the new account and answers the message that hit the limit. Returns the
 * marker's path, or null when there is no conversation to resume (the switch still happens, on a fresh start).
 */
export function armSwitchResume(home: string = homedir()): string | null {
  const id = newestSessionId(home)
  if (!id) return null
  const marker = resumeMarkerPath(home)
  try {
    mkdirSync(join(home, '.claude', 'channels', 'telegram'), { recursive: true, mode: 0o700 })
    const tmp = `${marker}.tmp.${process.pid}`
    writeFileSync(tmp, `${id}\ncontinue and reply to the latest message\n`, { mode: 0o600 })
    renameSync(tmp, marker)
    return marker
  } catch {
    return null
  }
}

/** A switch that did not happen leaves no marker behind for a later, unrelated restart to resume from. */
export function disarmSwitchResume(marker: string | null): void {
  if (!marker) return
  try { if (existsSync(marker)) unlinkSync(marker) } catch {}
}
