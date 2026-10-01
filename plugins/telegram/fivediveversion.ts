// DIVE-5327 — A SLOW `5dive --version` IS NOT AN OLD 5dive CLI.
//
// THE BUG. server.ts probed `5dive --version` with a 2s timeout on EVERY
// paired-5dive command (/tasks, /heartbeat, /task …) and returned null on any
// throw. The dispatcher reads null as "no or old CLI", so lodar's /tasks on a
// box at load ~15 on 4 cores (2026-10-01 05:56Z, CLI 0.65.1, current) got
// "/tasks needs a newer 5dive CLI … Update to the latest 5dive CLI". Idle, the
// same call takes 0.09–0.22s; a busy box pushes the fork/exec past 2s. The
// same probe gates the inbox banner and /status, which dropped out silently.
//
// THE FIX, in three parts:
//   1. CACHE the last good read for the life of the process. The CLI only
//      changes on an upgrade, and an upgrade restarts the session; a TTL
//      (default 10 min) re-reads anyway. A re-read that fails for any reason
//      short of "the binary is gone" keeps the cached value.
//   2. A COLD read (nothing cached) gets 10s, not 2s. A re-read with a value
//      already in hand keeps the short budget, since a miss costs nothing.
//   3. A FAILED read is not an OLD read. `probe()` answers `busy` when the
//      exec timed out, was killed, or could not fork, so the caller can say
//      "couldn't check" instead of "update your CLI". `absent` is reserved for
//      evidence: no binary, a binary that exits non-zero, or output that is not
//      `5dive X.Y.Z`.
//
// Kept in its own module because server.ts long-polls Telegram on import and so
// cannot be imported by a unit test (see cliexec.ts). The exec function, the
// binary path and the clock are parameters, so the suite drives the real logic
// against a stub binary that sleeps.

export type ExecFn = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>

export type VersionProbe = { kind: 'ok'; version: string } | { kind: 'absent' } | { kind: 'busy' }

export const COLD_READ_MS = 10_000
export const WARM_READ_MS = 2_000
export const VERSION_TTL_MS = 10 * 60_000

// The binary ran and answered (or does not exist): a real negative. Anything
// else — a timeout kill, a signal, EAGAIN/ENOMEM on fork — says nothing about
// the CLI's version and must not be reported as one.
export function isDefinitiveMiss(e: unknown): boolean {
  const err = e as { code?: unknown; killed?: unknown; signal?: unknown }
  if (err?.killed || err?.signal) return false
  if (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'ENOTDIR') return true
  return typeof err?.code === 'number'
}

export function createVersionReader(opts: {
  bin: string
  exec: ExecFn
  now?: () => number
  ttlMs?: number
  coldMs?: number
  warmMs?: number
}) {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? VERSION_TTL_MS
  const coldMs = opts.coldMs ?? COLD_READ_MS
  const warmMs = opts.warmMs ?? WARM_READ_MS
  let cached: { version: string; at: number } | null = null
  let inflight: Promise<VersionProbe> | null = null

  async function read(): Promise<VersionProbe> {
    const had = cached
    try {
      const { stdout } = await opts.exec(opts.bin, ['--version'], { timeout: had ? warmMs : coldMs })
      const m = String(stdout).trim().match(/^5dive\s+(\S+)$/)
      if (!m) {
        cached = null
        return { kind: 'absent' }
      }
      cached = { version: m[1], at: now() }
      return { kind: 'ok', version: m[1] }
    } catch (e) {
      if (isDefinitiveMiss(e)) {
        cached = null
        return { kind: 'absent' }
      }
      return had ? { kind: 'ok', version: had.version } : { kind: 'busy' }
    }
  }

  // Concurrent callers (a /tasks plus the banner timer) share one exec.
  async function probe(): Promise<VersionProbe> {
    if (cached && now() - cached.at < ttlMs) return { kind: 'ok', version: cached.version }
    if (!inflight) inflight = read().finally(() => { inflight = null })
    return inflight
  }

  // The legacy shape: the version, or null when there is none to report.
  async function version(): Promise<string | null> {
    const p = await probe()
    return p.kind === 'ok' ? p.version : null
  }

  return { probe, version }
}
