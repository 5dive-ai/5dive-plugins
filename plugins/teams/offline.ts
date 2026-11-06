// plugins/teams/offline.ts — the local-only switch, read on every message (DIVE-7658).
//
// A local-only box is fully offline. Its IT may open Teams alone with
// `sudo 5dive config local-only allow teams`, which writes `teams` into
// /etc/5dive/local-only.allow (5dive core, src/lib/local_only.sh). Read fresh
// each time, so `deny teams` shuts the endpoint at once: no inbound is taken,
// and nothing goes to Microsoft (keys, token, replies, files).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function localOnlyPaths(env: Record<string, string | undefined> = process.env) {
  const flag = env.FIVE_LOCAL_ONLY_FILE || '/etc/5dive/local-only'
  const allow = env.FIVE_LOCAL_ONLY_ALLOW_FILE || join(dirname(flag), 'local-only.allow')
  return { flag, allow }
}

/** True when this box is local-only and its IT has not opened Teams. */
export function teamsShut(paths = localOnlyPaths()): boolean {
  if (!existsSync(paths.flag)) return false
  try {
    return !readFileSync(paths.allow, 'utf8').split('\n').some(l => l.trim() === 'teams')
  } catch {
    return true // no allow file, or unreadable: shut (fail closed)
  }
}

export const SHUT_LINE =
  "Teams is shut on this local-only box. Your IT opens it alone: sudo 5dive config local-only allow teams"

export function assertTeamsOpen(paths = localOnlyPaths()) {
  if (teamsShut(paths)) throw new Error(SHUT_LINE)
}
