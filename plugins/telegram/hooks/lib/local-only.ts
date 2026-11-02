// DIVE-7559: local-only mode. /etc/5dive/local-only (root 0644, EXISTS = ON) is
// the one switch every 5dive component reads (the CLI's `sudo 5dive config
// local-only on` writes it, DIVE-7557). While it is on, nothing on the box may
// open a connection outside the office network, so every hook that would call
// api.telegram.org or openrouter.ai stays silent instead. Absent = today's
// behaviour, unchanged.
//
// Read on every call, never cached: a hook is a short process, and a switch
// turned on while a session runs must silence the very next hook.
// FIVE_LOCAL_ONLY_FILE is the same test seam the CLI honours.

import { existsSync } from 'fs'

export function localOnlyFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.FIVE_LOCAL_ONLY_FILE || '/etc/5dive/local-only'
}

export function localOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(localOnlyFile(env))
}
