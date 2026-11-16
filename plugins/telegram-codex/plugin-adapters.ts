// DIVE-8464: channel plugins as dispatcher adapters.
//
// Telegram and the dashboard are built in. Any other channel joins by the same
// file contract (inbox/<id>.json in, outbox/<source>/<n>.json out; see the
// teams plugin's dispatch.ts) as a child process this dispatcher spawns:
//
//   CODEX_DISPATCHER_PLUGIN_ADAPTERS='{"teams":"/abs/teams/codex-adapter.ts","email":"/abs/email/codex-adapter.ts"}'
//
// 5dive-agent-start writes it from each enabled plugin's manifest
// (`fivedive.codex_adapter`). A channel listed in CODEX_DISPATCHER_CHANNELS
// with no entry gets the sibling plugin in this checkout when one exists (teams,
// the dashboard's pattern); otherwise it is not started and its source is not
// accepted. Pure, so the parse and the inbox's source check are unit-tested.

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const BUILTIN_SOURCES = ['telegram', 'dashboard', 'agent'] as const
const NAME = /^[a-z][a-z0-9-]{1,23}$/
// Sibling plugins of this checkout that can run as an adapter, and their entry.
export const SIBLING_ADAPTERS: Record<string, string> = { teams: 'codex-adapter.ts' }

export function resolvePluginAdapters(opts: {
  raw: string | undefined
  channels: Set<string>
  pluginDir: string
  exists?: (p: string) => boolean
}): { adapters: Record<string, string>; warnings: string[] } {
  const exists = opts.exists ?? existsSync
  const warnings: string[] = []
  let map: Record<string, unknown> = {}
  if (opts.raw && opts.raw.trim()) {
    try {
      const parsed = JSON.parse(opts.raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
      else warnings.push('CODEX_DISPATCHER_PLUGIN_ADAPTERS is not a JSON object; ignored')
    } catch {
      warnings.push('CODEX_DISPATCHER_PLUGIN_ADAPTERS is not valid JSON; ignored')
    }
  }
  const adapters: Record<string, string> = {}
  for (const [name, path] of Object.entries(map)) {
    if (!NAME.test(name) || (BUILTIN_SOURCES as readonly string[]).includes(name)) {
      warnings.push(`plugin adapter "${name}": not an adapter channel name; ignored`)
      continue
    }
    if (typeof path !== 'string' || !isAbsolute(path)) {
      warnings.push(`plugin adapter "${name}": its entry must be an absolute path; ignored`)
      continue
    }
    if (opts.channels.has(name)) adapters[name] = path
  }
  for (const [name, entry] of Object.entries(SIBLING_ADAPTERS)) {
    if (!opts.channels.has(name) || adapters[name]) continue
    const p = join(opts.pluginDir, '..', name, entry)
    if (exists(p)) adapters[name] = p
    else warnings.push(`channel ${name} is on but no adapter entry was given and ${p} does not exist; not started`)
  }
  return { adapters, warnings }
}

/** The inbox's allowed sources: the built-ins plus every adapter actually configured. */
export function allowedSources(adapters: Record<string, string>): Set<string> {
  return new Set([...BUILTIN_SOURCES, ...Object.keys(adapters)])
}
