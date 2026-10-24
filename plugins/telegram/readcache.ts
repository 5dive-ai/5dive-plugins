// DIVE-6867 — /account OPENS FROM WHAT WE ALREADY READ.
//
// The picker sat on four 5dive reads: `agent list`, then `account list`,
// `account usage` and `rotation get` in parallel. Each is a full run of the CLI,
// measured on poke-two (4 cores, load ~3.7) at 0.6s, 1.4-1.8s, 1.9-2.5s and
// 0.4s, so a tap waited ~2.6s on a calm box and several times that on a busy
// one (lodar saw ~10s). Nothing in those answers changes between two taps: the
// bound account only moves with a restart of this process, the account list with
// a sign-in, the usage dots every few minutes.
//
// So the picker reads through a stale-while-revalidate cache. A fresh value is
// served as is; a value past `freshMs` but inside `maxStaleMs` is served at once
// and re-read in the background, so the NEXT tap sees it; nothing (or a value
// past `maxStaleMs`) waits for the read, as before. A read that answers with
// something `keep` refuses (null: the CLI could not be read) is never cached, so
// a failure is retried on the next tap instead of being remembered.
//
// Pure (takes its clock), so the suite drives it without importing server.ts,
// which long-polls Telegram on import.

export type SwrRead<T> = {
  /** The value, from cache when it is young enough; see the header. */
  get(): Promise<T>
  /** Drop the cached value: the next get() waits for a fresh read. */
  clear(): void
}

export function createSwrRead<T>(
  load: () => Promise<T>,
  o: { freshMs: number; maxStaleMs: number; now?: () => number; keep?: (v: T) => boolean },
): SwrRead<T> {
  const now = o.now ?? (() => Date.now())
  const keep = o.keep ?? ((v: T) => v != null)
  let cached: { v: T; at: number } | null = null
  let inflight: Promise<T> | null = null
  // A clear() while a read is out must not let that (older) answer land after it.
  let gen = 0
  const refresh = (): Promise<T> => {
    if (inflight) return inflight
    const mine = gen
    const p = load().then(
      v => {
        if (mine === gen && keep(v)) cached = { v, at: now() }
        return v
      },
    ).finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
  }
  return {
    async get() {
      if (cached) {
        const age = now() - cached.at
        if (age < o.freshMs) return cached.v
        if (age < o.maxStaleMs) {
          void refresh().catch(() => {})
          return cached.v
        }
      }
      return refresh()
    },
    clear() {
      cached = null
      inflight = null
      gen++
    },
  }
}
