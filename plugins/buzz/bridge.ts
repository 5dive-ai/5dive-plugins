// plugins/buzz/bridge.ts — the pure half of the DIVE-3573 buzz BRIDGE: turning
// the host's routing verdict into a delivery decision.
//
// Pure and dependency-free for the same reason mention.ts and poller.ts are:
// repo CI runs a bare `bun test` with no plugin deps installed, so anything only
// reachable through server.ts (which imports the MCP SDK and @noble/curves)
// cannot execute there at all. A trust decision nothing runs is not a decision.
//
// WHAT THE BRIDGE IS, and what it deliberately is not. lodar's steer
// (2026-08-18, ratified): "it's on the 5dive layer … our agents use 5dive to a2a
// comm and we just mirror that to telegram". So this plugin does NOT become a
// trust authority. It does not read the registry, it does not decide who a key
// belongs to, and it does not promote anything. It asks the host
// (`5dive agent buzz inbound`), which re-derives the identity from the PUBLIC KEY
// against the registry, and it obeys the answer. The untrusted-by-default channel
// logic below is untouched: `untrusted` is what every unrecognised, ambiguous and
// UNMEASURABLE outcome maps to, which is also what happens when the host call
// fails outright.
//
// See community/wiki/the-trust-decision-does-not-live-in-the-plugin-it-rides-the-5dive-layer.md

/** What the plugin must do with an inbound event after the host has ruled. */
export type Route =
  /** Already delivered on the a2a rail by the host. Do NOT deliver again. */
  | 'a2a'
  /** This key is THIS seat's paired owner. Deliver as a trusted human message. */
  | 'owner'
  /** Everything else. Today's behaviour, byte for byte: untrusted channel data. */
  | 'untrusted'

export type Verdict = {
  route: Route
  reason: string
  /** Seat the key maps to, when the host named one. */
  seat?: string
  /** Provenance label the host relayed under (`buzz-<seat>`), for logging. */
  from?: string
}

/**
 * Read the host verdict.
 *
 * FAIL-CLOSED IS THE WHOLE POINT, and "closed" here means UNTRUSTED, not
 * "dropped". A message we could not classify must still reach the session — as
 * untrusted data, exactly as it does today — because silently swallowing it
 * would be a second bug wearing the first one's clothes: the sender sees no
 * reply and cannot tell a refusal from a message that was never delivered. That
 * ambiguity is precisely what made DIVE-3559's original measurement unusable.
 *
 * So: only an explicit, well-formed `a2a` or `owner` from a rc=0 call is
 * honoured. A non-zero rc, unparseable output, a missing route, an unknown route
 * string, or `ok:false` all land on untrusted with a reason that says which.
 */
export function readVerdict(rc: number, stdout: string): Verdict {
  // A NON-ZERO rc CAN NEVER PROMOTE — but it can still carry a reason, and it
  // does. The host exits non-zero on exactly one classified outcome: `refused`,
  // where it recognised the key, took the a2a branch, and the rail bounced (no
  // pane, round cap, credential guard). Throwing the body away there would
  // relabel a rail refusal as the same `host-rc=1` we report for a missing sudo
  // grant, and those want different fixes. So: parse it, keep the reason, and
  // pin the route to untrusted regardless of what the body claims.
  if (rc !== 0) {
    const reason = reasonFrom(stdout)
    return { route: 'untrusted', reason: reason ? `host-rc=${rc}:${reason}` : `host-rc=${rc}` }
  }
  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { route: 'untrusted', reason: 'unparseable-verdict' }
  }
  if (!parsed || parsed.ok !== true || !parsed.data) {
    return { route: 'untrusted', reason: 'verdict-not-ok' }
  }
  const d = parsed.data
  const reason = typeof d.reason === 'string' && d.reason ? d.reason : 'no-reason'
  const seat = typeof d.seat === 'string' && d.seat ? d.seat : undefined
  const from = typeof d.from === 'string' && d.from ? d.from : undefined
  if (d.route === 'a2a') return { route: 'a2a', reason, seat, from }
  if (d.route === 'owner') return { route: 'owner', reason, seat }
  if (d.route === 'untrusted') return { route: 'untrusted', reason, seat }
  // `refused` (the host took the a2a branch and the rail bounced it — no pane,
  // round cap, credential guard) and any route a newer host speaks that this
  // build does not know about both land HERE, on untrusted.
  //
  // The tempting alternative is to drop them, and it is wrong in the direction
  // that matters. Untrusted is the WEAKEST class in the table, not a back door
  // around the refusal: it is what this message would have got before this row
  // existed, it confers no authority, and it cannot mint one. Dropping, by
  // contrast, re-creates the exact ambiguity that made DIVE-3559's measurement
  // unusable — the sender sees silence and cannot tell a refusal from a message
  // that never arrived. So the message still reaches the session, as data, and
  // the reason token records which rail said no.
  return { route: 'untrusted', reason: `undeliverable:${String(d.route)}` }
}

/**
 * The reason token out of a verdict body, or '' when there is nothing readable.
 *
 * Deliberately reads ONLY `reason` and never `route`: this is used on the
 * non-zero path, where the route the host printed must not influence anything.
 */
function reasonFrom(stdout: string): string {
  try {
    const p = JSON.parse(stdout)
    const r = p?.data?.reason
    const route = p?.data?.route
    if (typeof r !== 'string' || !r) return ''
    return typeof route === 'string' && route ? `${route}/${r}` : r
  } catch {
    return ''
  }
}

/** True when the plugin must NOT deliver this event itself. */
export function hostAlreadyDelivered(v: Verdict): boolean {
  return v.route === 'a2a'
}

/**
 * The `trust` attribute stamped into the channel meta of a delivered event.
 *
 * It is the ONLY thing the bridge adds to the class-(d) path, and it adds a
 * field rather than changing one: a session that has never heard of it reads
 * exactly the message it reads today.
 */
export function trustLabel(v: Verdict): 'owner' | 'unknown' {
  return v.route === 'owner' ? 'owner' : 'unknown'
}
