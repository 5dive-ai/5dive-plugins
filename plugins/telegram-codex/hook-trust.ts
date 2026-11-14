// DIVE-8464: trust the Codex hooks 5dive itself wired, so they actually run.
//
// Measured live on Codex 0.169 (dispatcher seat, 2026-11-14): `hooks/list`
// reported the email plugin's PreToolUse guard as `trustStatus: "untrusted"`,
// and a shell command the model ran never reached it. The TUI path passes
// `--dangerously-bypass-hook-trust`; `codex app-server` has no such flag, so on
// a dispatcher seat every hook in config.toml was silently skipped. That made a
// channel guard (no root commands while the turn is an email) a no-op.
//
// The fix is Codex's own persisted trust: `hooks.state."<key>".trusted_hash`
// set to the hook's `currentHash`, written through app-server
// `config/value/write`. Only hooks whose command is EXACTLY one 5dive-agent-start
// wired (CODEX_DISPATCHER_TRUST_HOOKS, a JSON array of command strings) and that
// come from the seat's own config.toml are trusted. Anything else a user or a
// prompt added stays untrusted, as Codex intends. Re-run each boot: a plugin
// update re-points a command, which changes its hash.

export type ListedHook = {
  key?: unknown
  command?: unknown
  source?: unknown
  sourcePath?: unknown
  currentHash?: unknown
  trustStatus?: unknown
}

export function parseTrustList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && c.length > 0) : []
  } catch {
    return []
  }
}

/** The hooks to trust: wired by 5dive, from this seat's config.toml, not trusted at this hash. */
export function hooksToTrust(listed: unknown, wired: string[], configPath: string): { key: string; hash: string }[] {
  const want = new Set(wired)
  const out: { key: string; hash: string }[] = []
  const groups = Array.isArray((listed as any)?.data) ? (listed as any).data : []
  for (const g of groups) {
    for (const h of (Array.isArray(g?.hooks) ? g.hooks : []) as ListedHook[]) {
      if (typeof h.key !== 'string' || typeof h.currentHash !== 'string' || typeof h.command !== 'string') continue
      if (!want.has(h.command) || h.source !== 'user' || h.sourcePath !== configPath) continue
      if (h.trustStatus === 'trusted') continue
      if (!/^[^"\\\n]+$/.test(h.key)) continue
      if (!out.some(o => o.key === h.key)) out.push({ key: h.key, hash: h.currentHash })
    }
  }
  return out
}

type Rpc = { request(method: string, params: unknown): Promise<any> }

/** Returns how many hooks were trusted; never throws (a failure is logged by the caller). */
export async function trustWiredHooks(rpc: Rpc, opts: { wired: string[]; configPath: string; cwd: string }): Promise<number> {
  if (!opts.wired.length) return 0
  const listed = await rpc.request('hooks/list', { cwds: [opts.cwd] })
  const todo = hooksToTrust(listed, opts.wired, opts.configPath)
  for (const t of todo) {
    const res = await rpc.request('config/value/write', {
      keyPath: `hooks.state."${t.key}".trusted_hash`,
      value: t.hash,
      mergeStrategy: 'replace',
    })
    if (res?.status !== 'ok' && res?.status !== 'okOverridden') throw new Error(`Codex did not confirm trusting ${t.key}`)
  }
  return todo.length
}
