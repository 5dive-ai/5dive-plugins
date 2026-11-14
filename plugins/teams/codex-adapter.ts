// plugins/teams/codex-adapter.ts — the entry the Codex dispatcher spawns (DIVE-8464).
//
// Claude Code starts this plugin with `bun run start`, whose script installs the
// dependencies first. The telegram-codex dispatcher spawns `bun <entry>` directly,
// and on a Codex seat Claude Code may never have started the plugin, so this
// entry does that one step itself: no node_modules → `bun install` (skipped on a
// local-only box, where the offline mirror ships them), then the usual launcher.
// It imports nothing but node builtins until the dependencies are there.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

process.env.CODEX_DISPATCHER_ADAPTER ||= 'teams'
const dir = import.meta.dir
if (!existsSync(join(dir, 'node_modules')) && !existsSync('/etc/5dive/local-only')) {
  const r = spawnSync(process.execPath, ['install', '--no-summary'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'], timeout: 180_000 })
  if (r.status !== 0) process.stderr.write(`teams: bun install exited ${r.status ?? r.signal}; starting anyway\n`)
}
await import('./start.ts')
