// plugins/buzz/poller.ts — the inbound poller's overlap guard, kept PURE and
// dependency-free on purpose.
//
// It lives here rather than inline in server.ts for the same reason mention.ts
// does: repo CI runs a bare `bun test` with no plugin deps installed, so
// anything only reachable through server.ts (which imports the MCP SDK and
// @noble/curves) cannot execute there at all. A guard nothing runs is not a
// guard.
//
// DIVE-3486. The shipped poller was:
//
//   const tick = () => { for (const ch of cfg.channels) void pollChannel(ch, seen) }
//   tick(); setInterval(tick, interval)
//
// Fire-and-forget under setInterval: a new tick was scheduled every `interval`
// whether or not the previous one had finished, and every channel in a tick was
// launched in parallel. Each poll spawns a `buzz` child process holding ~10 file
// descriptors, so the moment any poll runs long the spawns COMPOUND — measured
// on this plugin at a compressed cadence, the server pinned at 248 concurrent
// children and 1005 open descriptors (the 1024 RLIMIT_NOFILE soft limit), and
// interactive tool calls sharing that process then took 15-25s or never returned
// at all. That is the reported symptom: a buzz_read/buzz_post the client
// backgrounds at 120s while the relay and the CLI both answer in ~30ms.
//
// The guard is the fix rather than a longer interval because it makes the
// compounding arithmetically impossible instead of merely unlikely: at most ONE
// cycle is in flight, and channels within a cycle run in sequence, so the
// process holds at most one polling child at any instant no matter how slow the
// relay gets or how many channels are watched.

export type GuardedTick = {
  /** Runs one poll cycle, or returns immediately if one is already running. */
  tick: () => Promise<void>
  /** How many ticks were dropped because a cycle was already in flight. */
  dropped: () => number
  /** True while a cycle is running. */
  busy: () => boolean
}

/**
 * Wrap a per-channel poll into a non-overlapping cycle.
 *
 * A tick that arrives while one is running is DROPPED, not queued. Queuing
 * would only defer the pile-up: the backlog still has to be worked off with one
 * child process each. Dropping loses nothing — the next tick is one interval
 * away and each poll re-reads the last 50 events, so a skipped cycle's messages
 * are picked up by the following one.
 */
export function makeGuardedTick(
  channels: readonly string[],
  poll: (channel: string) => Promise<void>,
): GuardedTick {
  let inFlight = false
  let dropped = 0
  const tick = async () => {
    if (inFlight) {
      dropped++
      return
    }
    inFlight = true
    try {
      // Sequential on purpose. `Promise.all` here would put one child per
      // channel in flight at once, which is the same unbounded-spawn shape one
      // level down: two channels doubles the descriptor cost of a stuck relay,
      // ten channels multiplies it by ten.
      for (const channel of channels) await poll(channel)
    } finally {
      inFlight = false
    }
  }
  return { tick, dropped: () => dropped, busy: () => inFlight }
}
