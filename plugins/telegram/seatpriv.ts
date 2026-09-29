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
// (lodar, 2026-09-29 15:35Z, on agent oinoa.)
//
// Everything here is pure so the suite can drive it without importing
// server.ts, which long-polls Telegram on import.

export type SeatSudo = { measured?: boolean; impliedIsolation?: string }
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

export const USAGE_NOT_AVAILABLE_TEXT =
  `Usage isn't available on this agent — its access is limited to its own work, ` +
  `and reading account limits needs an admin. An admin agent's /usage or the dashboard shows it.`

// Only for a seat that COULD read it and still got nothing usable back.
export const USAGE_READ_FAILED_TEXT =
  `Couldn't read usage — your 5dive CLI may be out of date. Update to the latest 5dive CLI, then try again.`

export function accountReadOnlyText(current: string): string {
  return [
    `Current account: ${current}`,
    ``,
    `Only an admin switches this agent's account — its access is limited to its own work. ` +
      `Ask an admin agent, or use the dashboard.`,
  ].join('\n')
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
export function accountSwitchFailedText(name: string, refused: boolean, detail: string): string {
  if (refused) {
    return `❌ Account not switched — this agent is still on its current account. ` +
      `Only an admin switches this agent's account (its access is limited to its own work). ` +
      `Ask an admin agent, or use the dashboard.`
  }
  return `❌ Couldn't switch account → ${name}: ${detail || 'unknown error'}\n\nThis agent is still on its current account.`
}
