// DIVE-3573 — the bridge's verdict reader, graded on the failure directions.
//
// WHAT THIS IS FOR. Every arm below is a way the host can fail to give a usable
// answer, and the property under test is the same one each time: NOTHING is
// promoted out of `untrusted` except an explicit, well-formed, rc=0 verdict that
// names a route this build knows. A promotion is the only mistake here that
// cannot be walked back — it is the plugin obeying a stranger.
//
// The POSITIVE CONTROLS are load-bearing, not padding: a reader that returned
// `untrusted` unconditionally would pass every negative arm on this page. The
// a2a and owner arms are what prove the negatives measure something.

import { test, expect } from 'bun:test'
import { readVerdict, hostAlreadyDelivered, trustLabel } from './bridge.ts'

const wrap = (data: unknown) => JSON.stringify({ ok: true, data })

// --- positive controls ------------------------------------------------------
test('a known teammate key is reported as delivered on the a2a rail', () => {
  const v = readVerdict(0, wrap({ route: 'a2a', reason: 'delivered', seat: 'olivia', from: 'buzz-olivia' }))
  expect(v.route).toBe('a2a')
  expect(v.seat).toBe('olivia')
  expect(v.from).toBe('buzz-olivia')
  // The whole point of the a2a route: the plugin must NOT deliver it a second
  // time. A double delivery is how one teammate message becomes two.
  expect(hostAlreadyDelivered(v)).toBe(true)
  expect(trustLabel(v)).toBe('unknown')
})

test("the seat's own paired owner is routed as owner, and the plugin still delivers it", () => {
  const v = readVerdict(0, wrap({ route: 'owner', reason: 'paired-owner', seat: 'dev' }))
  expect(v.route).toBe('owner')
  expect(hostAlreadyDelivered(v)).toBe(false)
  expect(trustLabel(v)).toBe('owner')
})

test('an explicit untrusted verdict keeps its reason token', () => {
  const v = readVerdict(0, wrap({ route: 'untrusted', reason: 'no-match' }))
  expect(v.route).toBe('untrusted')
  expect(v.reason).toBe('no-match')
  expect(trustLabel(v)).toBe('unknown')
})

// --- the failure directions -------------------------------------------------
test('a non-zero host rc is untrusted, whatever the body claims', () => {
  // The sudo grant is missing, the verb does not exist on this build, the seat
  // is not provisioned — all of them arrive here, and none may promote. Not even
  // a body that says `a2a`: on the non-zero path the route is pinned.
  const v = readVerdict(1, wrap({ route: 'a2a', reason: 'delivered', seat: 'olivia' }))
  expect(v.route).toBe('untrusted')
  expect(hostAlreadyDelivered(v)).toBe(false)
})

test('a non-zero rc still keeps the reason the host printed', () => {
  // `refused` is the one classified outcome the host exits non-zero on, so
  // without this the rail bouncing a teammate's message would be reported as the
  // same `host-rc=1` a missing sudo grant gets — and those want different fixes.
  const v = readVerdict(1, wrap({ route: 'refused', reason: 'a2a-send-rc=7', seat: 'olivia' }))
  expect(v.route).toBe('untrusted')
  expect(v.reason).toBe('host-rc=1:refused/a2a-send-rc=7')
})

test('a non-zero rc with no readable body still reports the rc alone', () => {
  expect(readVerdict(1, 'sudo: a password is required').reason).toBe('host-rc=1')
  expect(readVerdict(3, '').reason).toBe('host-rc=3')
})

test('unparseable output is untrusted', () => {
  expect(readVerdict(0, 'sudo: a password is required').route).toBe('untrusted')
  expect(readVerdict(0, '').reason).toBe('unparseable-verdict')
})

test('ok:false is untrusted even when it carries a route', () => {
  const v = readVerdict(0, JSON.stringify({ ok: false, data: { route: 'owner' } }))
  expect(v.route).toBe('untrusted')
  expect(v.reason).toBe('verdict-not-ok')
})

test('a route this build does not know is untrusted, never a guess', () => {
  const v = readVerdict(0, wrap({ route: 'trusted-teammate', reason: 'x' }))
  expect(v.route).toBe('untrusted')
  expect(v.reason).toBe('undeliverable:trusted-teammate')
})

test('a refused a2a send still reaches the session, as untrusted data', () => {
  // NOT dropped. Untrusted is the weakest class, so this is never an escalation
  // — and a dropped message is a silence the sender cannot read, which is the
  // ambiguity DIVE-3559 was undone by.
  const v = readVerdict(0, wrap({ route: 'refused', reason: 'a2a-send-rc=7', seat: 'olivia' }))
  expect(v.route).toBe('untrusted')
  expect(v.reason).toBe('undeliverable:refused')
  expect(hostAlreadyDelivered(v)).toBe(false)
})

test('a verdict with no route at all is untrusted', () => {
  expect(readVerdict(0, wrap({ reason: 'x' })).route).toBe('untrusted')
})

test('a non-string seat/from is dropped rather than rendered', () => {
  const v = readVerdict(0, wrap({ route: 'a2a', reason: 'delivered', seat: 42, from: null }))
  expect(v.seat).toBeUndefined()
  expect(v.from).toBeUndefined()
})

// THE LABEL THE HOST RELAYS UNDER HAS TO BE SPELLABLE ON THE RAIL IT RIDES.
// Iteration 1 shipped `buzz:<seat>`, which cmd_send's valid_sender_label
// (^[a-z][a-z0-9-]{0,31}$) rejects, so every known-teammate inbound bounced
// inside the host and arrived here as untrusted data instead — the feature
// degrading to today's behaviour with a sudo round trip in front of it. The
// plugin cannot enforce the host's validator, but it CAN refuse to describe a
// route as a2a-delivered under a label that rail could never have accepted, and
// this arm keeps the two halves' idea of the label from drifting apart again.
const A2A_SENDER_LABEL = /^[a-z][a-z0-9-]{0,31}$/

test('the from label the host reports is spellable as an a2a sender label', () => {
  const v = readVerdict(0, wrap({ route: 'a2a', reason: 'delivered', seat: 'olivia', from: 'buzz-olivia' }))
  expect(v.route).toBe('a2a')
  expect(A2A_SENDER_LABEL.test(v.from!)).toBe(true)
})

test('NEGATIVE CONTROL: the iteration-1 colon label is not spellable on that rail', () => {
  // Proves the arm above measures the validator rather than restating a constant.
  expect(A2A_SENDER_LABEL.test('buzz:olivia')).toBe(false)
})
