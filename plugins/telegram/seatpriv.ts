// DIVE-5220 — WHAT THIS SEAT MAY DO, SAID HONESTLY.
//
// A standard-isolation seat's sudoers grant covers a handful of named verbs
// (_deliver, _capture, _self_restart, …). `agent set-account`, `account usage`
// and `usage` are not among them, and must not be (DIVE-4397: widening a
// seat's grant to make a bot button work is an access change the button does
// not justify — a standard seat that can set-account can bind itself to ANY
// account's credentials).
//
// Before this file the bot did not know that, and lied twice on such a seat:
//   /account → "✅ Account → mark … restarting" was sent BEFORE set-account ran,
//              then "❌ Failed to switch account: sudo: a password is required".
//   /usage   → the refusal came back as null and was rendered as "your 5dive
//              CLI may be out of date", which was false.
// (lodar, 2026-09-29 15:35Z, on a partner's agent.)
//
// DIVE-5367 (lodar, 2026-10-02: "slash account … cannot work") reverses the
// "must not be" above ON PURPOSE and narrowly: the CLI now writes ONE more
// exact-path line for a standard seat, `5dive _self_account`, which reads the
// every-account usage board and switches THIS seat (derived root-side from the
// sudo caller) between accounts the box already holds. Still no other seat, and
// nothing box-wide. The plugin never spawns that primitive itself: the ordinary
// `agent set-account <me>` / `account usage` verbs cross it from an unprivileged
// call, and the plugin only asks, once, whether this seat holds the line.
//
// Everything here is pure so the suite can drive it without importing
// server.ts, which long-polls Telegram on import.

import { TAP_STRINGS, type Lang } from './hooks/lib/lite.ts'

export type SeatSudo = { measured?: boolean; impliedIsolation?: string; grant?: string }
export type SeatEntry = { name: string; isolation?: string; sudo?: SeatSudo }
export type SeatAdmin = 'yes' | 'no' | 'unknown'

// Isolation levels whose grant includes the 5dive CLI as root.
const ADMIN_LEVELS = new Set(['admin', 'beyond-admin'])

// Can this seat run root-only 5dive verbs (set-account, account usage)?
//   - A sudo refusal already latched in this process is decisive: 'no'.
//   - Otherwise the MEASURED grant (`agent list --json` → sudo.impliedIsolation)
//     beats the stored label — the CLI itself says "trust the grant".
//   - Otherwise the stored `isolation` label.
//   - No entry at all (list unreadable, not an agent user): 'unknown', and the
//     caller keeps the old try-it path — but never an optimistic ✅.
export function seatCanAdmin(entry: SeatEntry | null | undefined, sudoDenied: boolean): SeatAdmin {
  if (sudoDenied) return 'no'
  if (!entry) return 'unknown'
  const s = entry.sudo
  if (s?.measured && typeof s.impliedIsolation === 'string' && s.impliedIsolation) {
    return ADMIN_LEVELS.has(s.impliedIsolation) ? 'yes' : 'no'
  }
  if (typeof entry.isolation === 'string' && entry.isolation) {
    return ADMIN_LEVELS.has(entry.isolation) ? 'yes' : 'no'
  }
  return 'unknown'
}

// The CLI's own "must run as root" answer, as the unprivileged attempt returns it:
// {"ok":false,"error":{"class":"permission",…}}.
export function isPermissionRefusal(envelope: unknown): boolean {
  const j = envelope as { ok?: unknown; error?: { class?: unknown } } | null | undefined
  return !!j && typeof j === 'object' && j.ok === false && j.error?.class === 'permission'
}

export type AccountUsageRead<T> =
  | { kind: 'ok'; data: T[] }
  | { kind: 'refused' }
  | { kind: 'failed' }

// Sort a `5dive account usage --json` read into the three answers /usage can
// honestly give. `envelope` is null when nothing parseable came back.
export function classifyAccountUsage<T>(
  envelope: unknown,
  seat: SeatAdmin,
  sudoDenied: boolean,
): AccountUsageRead<T> {
  const j = envelope as { ok?: unknown; data?: unknown } | null | undefined
  if (j && j.ok === true && Array.isArray(j.data)) return { kind: 'ok', data: j.data as T[] }
  if (seat === 'no' || sudoDenied || isPermissionRefusal(envelope)) return { kind: 'refused' }
  return { kind: 'failed' }
}

// DIVE-5331: was DIVE-5220's own "Usage isn't available on this agent" string.
// A standard seat now has ONE refusal for everything that needs root.
export const USAGE_NOT_AVAILABLE_TEXT = TAP_STRINGS.en.adminTier

// Only for a seat that COULD read it and still got nothing usable back.
export const USAGE_READ_FAILED_TEXT =
  `Couldn't read usage — your 5dive CLI may be out of date. Update to the latest 5dive CLI, then try again.`

// DIVE-5331: what /account shows a standard seat — the account it is on (that
// read needs no root), then the one admin-tier message in place of a picker.
export function accountReadOnlyText(current: string, lang: Lang = 'en'): string {
  return [TAP_STRINGS[lang].currentAccount(current), ``, adminTierText(lang)].join('\n')
}

// Shown in place of the picker the moment a switch is tapped. Deliberately no ✅:
// nothing has happened yet.
export function accountSwitchPendingText(name: string): string {
  return `⏳ Switching account → ${name}…`
}

// Sent only once set-account has returned ok.
export function accountSwitchDoneText(name: string): string {
  return `✅ Account → ${name}\n\n⚠️  Claude is restarting to apply it — back in ~20-30s once the new session loads.`
}

// The one message a failed switch produces. A sudo refusal is not an error the
// owner can fix from Telegram, so it says who can, instead of quoting sudo.
export function accountSwitchFailedText(name: string, refused: boolean, detail: string, lang: Lang = 'en'): string {
  if (refused) return `❌ ${adminTierText(lang)}`
  return `❌ Couldn't switch account → ${name}: ${detail || 'unknown error'}\n\nThis agent is still on its current account.`
}

// ── DIVE-5331: the full profile on a standard-tier seat ─────────────────────
//
// lodar, 2026-10-01: "make it work as much as possible" and "tell proper you
// need to be admin tier error if not possible". Before this, 5220 had fixed
// /account and /usage one string at a time; every other command still spawned
// `sudo -n 5dive …` on a seat whose grant does not cover it, and the owner read
// "sudo: a password is required" (or nothing, behind a generic toast).
//
// Two pieces, both pure:
//   1. standardSeatRoute() — what each full-profile command does on a standard
//      seat. The dispatcher refuses an 'admin' command up front, with the one
//      message, BEFORE any side effect (no half-done /update, no auth session).
//   2. createSudoGate() — the ONLY way server.ts spawns sudo. On a standard seat
//      a verb in the seat's grant runs exactly as today; a verb the CLI serves
//      to an unprivileged caller runs as the seat's own uid; anything else
//      throws AdminTierRequired and sudo is never spawned (DIVE-4397: a refused
//      sudo mails root). On an admin seat, and on 'unknown', the argv is
//      byte-identical to the old `execFileP(SUDO, ['-n', …])` — never refuse on
//      a guess.
//
// No grant is widened here, or may be to make a button work (DIVE-4397).

/** The one refusal, in the human's language. */
export function adminTierText(lang: Lang): string {
  return TAP_STRINGS[lang].adminTier
}

/** Thrown by the sudo gate instead of spawning a sudo a standard seat would be
 *  refused. Its message is the English admin-tier text, so a caller that only
 *  prints `err.message` still says the right thing. */
export class AdminTierRequired extends Error {
  constructor(public readonly argv: string[]) {
    super(TAP_STRINGS.en.adminTier)
    this.name = 'AdminTierRequired'
  }
}
export function isAdminTierRequired(e: unknown): e is AdminTierRequired {
  return e instanceof AdminTierRequired || (e as { name?: unknown } | null)?.name === 'AdminTierRequired'
}

// The standard seat's sudoers grant, as 5dive-cli render_standard_sudoers
// writes it (src/cmd_agent_create.sh). Only the verbs the PLUGIN itself spawns
// matter here; _deliver/_task_channel/_task_answer are crossed by the CLI
// internally, from an unprivileged call. Exact argv, no wildcard — the grant is
// exact-path with no args.
const STANDARD_SUDO_GRANT: string[][] = [
  ['5dive', 'agent', '_self_restart'],
]
const sameArgv = (g: string[], argv: string[]) => g.length === argv.length && g.every((w, i) => w === argv[i])
export function standardSeatMaySudo(argv: string[]): boolean {
  return STANDARD_SUDO_GRANT.some(g => sameArgv(g, argv))
}

// DIVE-5495: lines a standard seat MAY hold, depending on which CLI rendered its
// sudoers (and on a hand-added line, as on chill-gorge before the CLI wrote it).
// The plugin itself spawns these, so a static entry above would spawn a refused
// sudo on a seat without the line (DIVE-4397: that mails root). Instead the gate
// asks `sudo -n -l` for the exact line once per TTL, and only on a seat whose
// grant is the scoped standard one (mayProbe), and spawns only on a yes.
//   browser _connect: the privileged half of an agent's Connect/captcha tap.
//     Root re-checks the one-time code, that the tap came through this seat's
//     bot and that the tapper is its paired owner (5dive-cli browser _connect).
export const BROWSER_CONNECT_PROBE_ARGV = ['-n', '-l', '/usr/local/bin/5dive', 'browser', '_connect']
const PROBED_STANDARD_GRANTS: { argv: string[]; probe: string[] }[] = [
  { argv: ['5dive', 'browser', '_connect'], probe: BROWSER_CONNECT_PROBE_ARGV },
]
export function standardSeatMayHold(argv: string[]): boolean {
  return PROBED_STANDARD_GRANTS.some(g => sameArgv(g.argv, argv))
}

// Verbs the CLI serves to an UNPRIVILEGED caller (5dive-cli origin/main,
// audited for this row — the table is on the PR). Matched on the verb words
// only, ignoring global flags (`--json`) and the arguments after the verb.
//   task add/show/start/done/cancel/escalate/unpark: tasks dir is group-writable
//     "used by every agent without sudo" (lib/state.sh); no require_root.
//   task answer: only with --channel-proof, which the CLI carries over its
//     exact-path _task_channel grant (answer.sh _task_channel_try). A bare
//     --value would land as the AGENT's answer, not the human's — refused.
//   agent send: re-execs over the seat's `_deliver` grant (cmd_agent_runtime.sh).
//   agent set-account: DIVE-5367 — crosses the seat's `_self_account` grant when
//     the target is the caller itself; any other target stays on the root path
//     and is refused there. Call sites ask for 'plain' only after
//     selfAccountGranted() said yes.
const UNPRIVILEGED_VERBS: string[][] = [
  ['task', 'add'], ['task', 'show'], ['task', 'start'], ['task', 'done'],
  ['task', 'cancel'], ['task', 'escalate'], ['task', 'unpark'],
  ['task', 'answer'],
  ['agent', 'send'],
  ['agent', 'set-account'],
]
function verbWords(argv: string[]): string[] {
  // argv[0] is the binary word ('5dive'); drop global flags before the verb.
  return argv.slice(1).filter(w => !w.startsWith('-')).slice(0, 2)
}
export function standardSeatMayRunPlain(argv: string[]): boolean {
  if (argv[0] !== '5dive') return false
  const [a, b] = verbWords(argv)
  if (!UNPRIVILEGED_VERBS.some(([x, y]) => x === a && y === b)) return false
  if (a === 'task' && b === 'answer') return argv.some(w => w.startsWith('--channel-proof='))
  return true
}

// ── DIVE-5367: the self-account grant ───────────────────────────────────────
//
// The CLI path `sudo -n -l` probes for the line. Only a seat whose grant is the
// scoped standard one is ever asked: an admin seat does not need the rail, and a
// sandboxed seat holds no sudoers entry at all, so asking it would only log (and
// on a stock sudo, mail) a "not in sudoers" line for nothing (DIVE-4397).
export const SELF_ACCOUNT_PROBE_ARGV = ['-n', '-l', '/usr/local/bin/5dive', '_self_account']
export function mayProbeSelfAccount(entry: SeatEntry | null | undefined): boolean {
  if (!entry) return false
  const s = entry.sudo
  if (s?.measured) return s.impliedIsolation === 'standard'
  return entry.isolation === 'standard'
}
/** Does this seat hold the `_self_account` line? `probe` runs the sudo -l. */
export async function selfAccountGranted(
  entry: SeatEntry | null | undefined,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  if (!mayProbeSelfAccount(entry)) return false
  try { return await probe() } catch { return false }
}
// The same "who may be asked" rule serves every probed line (DIVE-5495).
export const mayProbeStandardGrant = mayProbeSelfAccount

export type SudoExecFn = (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>

export type SudoGate = {
  /**
   * Run `argv` the way this seat may. `argv[0]` is the word handed to sudo
   * ('5dive', or an absolute script path), exactly as the old call site wrote it.
   * `standard: 'plain'` asks for the unprivileged path on a standard seat; it is
   * honoured only for a verb in UNPRIVILEGED_VERBS, so a call site cannot route a
   * root-only verb to a raw CLI error by asking for it.
   */
  run(argv: string[], opts?: unknown, standard?: 'plain' | 'refuse'): Promise<{ stdout: string; stderr: string }>
  /** Throws AdminTierRequired when this seat may not run `argv` at all. For a
   *  spawn the gate does not own (a streaming child). */
  check(argv: string[]): Promise<void>
  /** DIVE-5367: `sudo -n -l` for the seat's `_self_account` line. Lists, never
   *  runs. Callers ask only through selfAccountGranted(), i.e. only on a seat
   *  whose grant is the scoped standard one. */
  probeSelfAccount(): Promise<boolean>
}

// How long a probed line's answer stands. The line lands at the nightly
// update's sudoers reconcile (or by hand), not mid-conversation.
export const GRANT_PROBE_TTL_MS = 10 * 60 * 1000

export function createSudoGate(o: {
  execFile: SudoExecFn
  sudoBin: string
  /** absolute path of the bare binary, for the unprivileged path */
  fiveBin: string
  seat: () => Promise<SeatAdmin>
  /** DIVE-5495: may this seat be asked `sudo -n -l` at all (mayProbeStandardGrant
   *  of its agent-list entry)? Absent → a probed line is never asked, so refused. */
  mayProbe?: () => Promise<boolean>
  now?: () => number
}): SudoGate {
  const now = o.now ?? Date.now
  const held = new Map<string, { v: boolean; at: number }>()
  const holds = async (argv: string[]): Promise<boolean> => {
    const g = PROBED_STANDARD_GRANTS.find(x => sameArgv(x.argv, argv))
    if (!g || !o.mayProbe) return false
    const key = g.argv.join(' ')
    const c = held.get(key)
    if (c && now() - c.at < GRANT_PROBE_TTL_MS) return c.v
    let v = false
    try {
      if (await o.mayProbe()) v = await o.execFile(o.sudoBin, g.probe, { timeout: 5000 }).then(() => true, () => false)
    } catch { v = false }
    held.set(key, { v, at: now() })
    return v
  }
  const allowed = async (argv: string[], standard: 'plain' | 'refuse'): Promise<'sudo' | 'plain'> => {
    // The seat's own grant needs no lookup: it is the same on every tier.
    if (standardSeatMaySudo(argv)) return 'sudo'
    if ((await o.seat()) !== 'no') return 'sudo'
    if (standard === 'plain' && standardSeatMayRunPlain(argv)) return 'plain'
    if (await holds(argv)) return 'sudo'
    throw new AdminTierRequired(argv)
  }
  return {
    async run(argv, opts, standard = 'refuse') {
      const how = await allowed(argv, standard)
      if (how === 'plain') return o.execFile(o.fiveBin, argv.slice(1), opts)
      return o.execFile(o.sudoBin, ['-n', ...argv], opts)
    },
    async check(argv) {
      await allowed(argv, 'refuse')
    },
    probeSelfAccount() {
      return o.execFile(o.sudoBin, SELF_ACCOUNT_PROBE_ARGV, { timeout: 5000 }).then(() => true, () => false)
    },
  }
}

export type StandardRoute =
  /** same handler as an admin seat; nothing in it needs root */
  | 'works'
  /** the handler takes its own no-root branch on a standard seat */
  | 'own'
  /** the dispatcher answers with the one admin-tier message */
  | 'admin'

// What each full-profile command does on a standard seat. Every entry of
// COMMAND_REGISTRY must be named here (the suite enforces it); an unnamed
// command falls to 'admin', because a command nobody audited must not reach a
// sudo prompt.
const STANDARD_ROUTES: Record<string, StandardRoute | ((arg: string) => StandardRoute)> = {
  start: 'works', help: 'works', status: 'works', context: 'works',
  stop: 'works', clear: 'works', goal: 'works', model: 'works', effort: 'works',
  checkpoint: 'works',
  // `_self_restart` is in the standard grant.
  restart: 'works', resume: 'works',
  tasks: 'works', heartbeat: 'works', org: 'works',
  // the list is a read; start/stop/restart of a seat take the registry lock (root).
  agents: arg => /^(start|stop|restart)\b/i.test(arg.trim()) ? 'admin' : 'works',
  team: arg => /^(start|stop|restart)\b/i.test(arg.trim()) ? 'admin' : 'works',
  // the gate list is a read; only the tap-button digest (`inbox --send`) is root.
  inbox: 'own',
  // `task add` runs unprivileged; the handler drops sudo for it.
  task: 'own',
  // DIVE-5367: the picker and the switch cross the seat's `_self_account`
  // grant; a seat without it (CLI not updated yet) keeps the read-only view.
  account: 'own',
  // DIVE-5367: the every-account limit board over the same grant; without it,
  // this seat's own 5h/1w.
  usage: 'own',
  // reading the state works; turning it on/off writes a root-owned file.
  digest: arg => (arg.trim() === '' || arg.trim().toLowerCase() === 'status') ? 'works' : 'admin',
  // the refresh script runs as root (sudo -u <seat> claude plugin …, root writes).
  update: 'admin',
  // `agent auth start` requires root (require_auth_session_root).
  login: 'admin',
}
export function standardSeatRoute(cmd: string, arg: string = ''): StandardRoute {
  const r = STANDARD_ROUTES[cmd]
  if (r === undefined) return 'admin'
  return typeof r === 'function' ? r(arg) : r
}
export const STANDARD_ROUTED_COMMANDS: readonly string[] = Object.keys(STANDARD_ROUTES)

export type StatuslineLimits = {
  rate_limits?: {
    five_hour?: { used_percentage?: unknown; resets_at?: unknown }
    seven_day?: { used_percentage?: unknown; resets_at?: unknown }
  }
}

/** /usage on a standard seat: this agent's own 5h/1w from its own statusline
 *  cache (~/.claude/statusline-last.json — no root, no other seat's data), then
 *  one line on where the every-account board lives. `fmt` renders a duration. */
export function ownUsageText(lang: Lang, cache: StatuslineLimits | null, nowMs: number, fmt: (ms: number) => string): string {
  const s = TAP_STRINGS[lang]
  const line = (w: { used_percentage?: unknown; resets_at?: unknown } | undefined, render: (p: string, r?: string) => string): string | null => {
    if (!w || typeof w.used_percentage !== 'number') return null
    const resets = typeof w.resets_at === 'number' && w.resets_at * 1000 > nowMs ? fmt(w.resets_at * 1000 - nowMs) : undefined
    return render(`${Math.round(w.used_percentage)}%`, resets)
  }
  const lines = [
    line(cache?.rate_limits?.five_hour, s.ownUsage5h),
    line(cache?.rate_limits?.seven_day, s.ownUsage1w),
  ].filter((l): l is string => l !== null)
  return [s.ownUsageTitle, '', ...(lines.length ? lines : [s.ownUsageNone]), '', s.ownUsageBoard].join('\n')
}
