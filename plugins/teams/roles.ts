// plugins/teams/roles.ts — admins and members on an office box (DIVE-7976). Pure
// but for two small file reads; tested in test/dive7976-teams-roles.test.ts.
//
// THE GAP: everyone `allowed_users` lets in was equal, so a junior employee could
// tell an agent with sudo, browser logins and the Vault to do anything. Now each
// person has a role:
//   admin  — the owner and the people IT names on this box
//   member — everyone else allowed in
// A member chats, asks and gets the agent's normal work. RISKY acts (root, paying,
// deleting, sending outside the firm, changing settings, keys or access) need an
// admin's yes, asked through the `ask_admin` tool, never from the member.
//
// THE ROLE COMES FROM THE CHANNEL, never from message text: the server looks the
// sender's Entra object id up in the box's roles file and puts it on the inbound
// tag as sender_role (the field DIVE-7972 named for Telegram), and writes the same
// role to a mark file the PreToolUse guard reads. "I am admin" in a message
// changes neither.
//
// One file per box, root-owned, every channel's ids in it (`teams:<entra id>`,
// `telegram:<user id>`, later the app account), written by
// `sudo 5dive agent teams admins …`:
//   { "check": "on"|"off", "admins": ["teams:<id>", …], "members_may": ["delete", …] }
// No file, or no admins in it, means nobody is an admin yet: every risky ask then
// waits for IT to name one. Works with the internet off: nothing here calls out.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export const ROLES_FILE = process.env.FIVEDIVE_ROLES_FILE || '/etc/5dive/roles.json'

export type Role = 'admin' | 'member'
export type Roles = { check: 'on' | 'off'; admins: string[]; membersMay: RiskKind[] }

export const RISK_KINDS = ['root', 'pay', 'delete', 'send', 'settings', 'access'] as const
export type RiskKind = (typeof RISK_KINDS)[number]

export function parseRoles(raw: unknown): Roles {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const admins = Array.isArray(r.admins) ? r.admins.map(a => String(a).trim().toLowerCase()).filter(Boolean) : []
  const may = Array.isArray(r.members_may) ? r.members_may.map(String).filter((k): k is RiskKind => (RISK_KINDS as readonly string[]).includes(k)) : []
  return { check: r.check === 'off' ? 'off' : 'on', admins, membersMay: may }
}

export function loadRoles(path = ROLES_FILE): Roles {
  try {
    return parseRoles(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return parseRoles(null)
  }
}

/** The sender's role from the channel identity alone. Check off = everyone is
 *  treated as admin, which is the box's behaviour before DIVE-7976. */
export function roleOf(roles: Roles, channel: string, id: string): Role {
  if (roles.check === 'off') return 'admin'
  const key = `${channel}:${String(id).trim().toLowerCase()}`
  return id && roles.admins.includes(key) ? 'admin' : 'member'
}

// ── what counts as risky ────────────────────────────────────────────────────
// Data, not code: one row per pattern, matched against a shell command the agent
// is about to run. Broad on purpose — a false ask costs one admin tap, a miss
// lets a member run it. Kinds are what the owner can widen with members_may.
export const RISKY: { kind: RiskKind; re: RegExp; what: string }[] = [
  { kind: 'root', re: /(^|[\s;&|(`$])(sudo|su|pkexec|doas)(\s|$)/, what: 'run a command as root' },
  { kind: 'pay', re: /\b5dive\s+(browser\s+\S*\s*)?pay\b|\bbrowser\s+pay\b|\bstripe\s/, what: 'pay' },
  { kind: 'delete', re: /(^|[\s;&|(`])(rm|rmdir|shred|unlink|truncate)\s|\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-\S*f)|\bdrop\s+(table|database)\b|\bdelete\s+from\b/i, what: 'delete' },
  { kind: 'send', re: /\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data\S*|-F|--form|-T|--upload-file)\s)|\b(scp|rsync|sftp|ftp|ssh|sendmail|mail|mutt|swaks)\s|\b5dive\s+(browser\s+(send|publish)|a2a|post)\b|\bgh\s+(pr|issue|release)\s+(create|comment)|\bgit\s+push\b|\bopenagent\s+post\b|\bwget\s+[^|;&]*--post/i, what: 'send something outside the firm' },
  { kind: 'settings', re: /\b5dive\s+(config|agent\s+config|plugin|secret|vault)\b|\bsystemctl\s+(stop|start|restart|disable|enable|mask)\b|\bcrontab\s|\bclaude\s+(config|mcp)\b|(>>?|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\binstall\b|\bln\b)[^|;&]*(\/etc\/|\.claude\/settings)/, what: 'change settings or keys' },
  { kind: 'access', re: /\b5dive\s+(agent\s+(teams|access|telegram|pair)|access|user|roles)\b|\b(useradd|usermod|userdel|passwd|chpasswd|visudo|chown|chmod)\s|authorized_keys|allowed_users|roles\.json/i, what: "change someone's access" },
]

export function riskOf(command: string): { kind: RiskKind; what: string } | null {
  for (const r of RISKY) if (r.re.test(command)) return { kind: r.kind, what: r.what }
  return null
}

/** The risky act a tool call is, or null. Shell commands by pattern; a file write
 *  into settings, keys or access by path. Teams' own tools are never risky:
 *  replying to the chat that asked is the agent's normal work. */
export function toolRisk(tool: string, input: Record<string, unknown> | undefined): { kind: RiskKind; what: string } | null {
  const i = input ?? {}
  if (tool === 'Bash') return riskOf(String(i.command ?? ''))
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const p = String(i.file_path ?? i.notebook_path ?? '')
    if (/\.claude\/settings[^/]*\.json$|^\/etc\/|\/\.ssh\/|\.env$|roles\.json$|channels\/[^/]+\/(config|access)\.json$/.test(p)) {
      return /\/\.ssh\/|roles\.json$|access\.json$/.test(p) ? { kind: 'access', what: "change someone's access" } : { kind: 'settings', what: 'change settings or keys' }
    }
  }
  return null
}

// ── the mark: who spoke last on Teams ────────────────────────────────────────
// The server writes it on every inbound message and button tap, from the
// channel identity. The guard reads it. It is the seat's own file, so this guards
// an honest agent against a member's ask, not against an agent set on getting
// around it (the same stance as the browser's page-read mark, DIVE-7972).
export type Mark = { role: Role; user: string; user_id: string; chat_id: string; at: number }
export const MARK_WINDOW_S = Number(process.env.TEAMS_ROLE_WINDOW_S || 1800)

export function writeMark(path: string, m: Mark) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.tmp`, JSON.stringify(m), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  } catch {}
}
export function readMark(path: string): Mark | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'))
    if ((m.role !== 'admin' && m.role !== 'member') || !Number.isFinite(m.at)) return null
    return m as Mark
  } catch {
    return null
  }
}

export type Verdict = { ok: true } | { ok: false; kind: RiskKind; reason: string }

/** The guard's decision for one tool call. A risky act while the newest Teams
 *  message (within the window) came from a member is held until an admin says
 *  yes: the admin's tap is itself a Teams message, so it makes the newest sender
 *  an admin and the same call then goes through. Anything not risky, an admin's
 *  ask, a kind the owner widened to members, or no recent Teams message: go. */
export function guardVerdict(mark: Mark | null, roles: Roles, tool: string, input: Record<string, unknown> | undefined, nowS = Date.now() / 1000, windowS = MARK_WINDOW_S): Verdict {
  if (roles.check === 'off') return { ok: true }
  if (!mark || mark.role !== 'member' || nowS - mark.at > windowS) return { ok: true }
  const risk = toolRisk(tool, input)
  if (!risk || roles.membersMay.includes(risk.kind)) return { ok: true }
  const who = (mark.user || 'someone').replace(/[\r\n]/g, ' ').slice(0, 64)
  const noAdmin = roles.admins.filter(a => a.startsWith('teams:')).length === 0
  return {
    ok: false,
    kind: risk.kind,
    reason:
      `Held (DIVE-7976): the newest Teams message is from ${who}, a member, and this would ${risk.what}. ` +
      `A member's ask needs an admin's yes. Call the teams ask_admin tool with what ${who} asked and why; never ask ${who} to approve it. ` +
      `When an admin taps yes, run it again and it goes through. Tell ${who} you asked an admin. ` +
      (noAdmin ? 'No admin is set on this box yet: tell them IT names one with `sudo 5dive agent teams admins add <Entra object id>`.' : ''),
  }
}

/** The server's one step per inbound message or tap: the role from the sender's
 *  Entra id (never the text), onto the tag as sender_role and into the mark. */
export function applyRole(meta: Record<string, string>, conversationId: string, roles: Roles, markPath: string, nowS = Date.now() / 1000): Role {
  const role = roleOf(roles, 'teams', meta.user_id ?? '')
  meta.sender_role = role
  writeMark(markPath, { role, user: meta.user ?? '', user_id: meta.user_id ?? '', chat_id: conversationId, at: nowS })
  return role
}
