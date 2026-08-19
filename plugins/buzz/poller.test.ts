// DIVE-3486. Guards the property that the inbound poller cannot pile up
// concurrent `buzz` child processes when the relay is slow.
//
// Imports the PURE module for the reason mention.test.ts states: repo CI runs a
// bare `bun test` with no plugin deps installed, so a test that reached this
// through server.ts could not execute here at all.
import { expect, test } from 'bun:test'
import { makeGuardedTick, mergeTargets } from './poller.ts'

/** A poll that blocks until released, recording peak concurrency. */
function blockingPoll() {
  let live = 0
  let peak = 0
  const releases: Array<() => void> = []
  const poll = (_channel: string) =>
    new Promise<void>(resolve => {
      live++
      if (live > peak) peak = live
      releases.push(() => {
        live--
        resolve()
      })
    })
  return {
    poll,
    peak: () => peak,
    pending: () => releases.length,
    releaseAll: async () => {
      while (releases.length) releases.shift()!()
      await Promise.resolve()
    },
  }
}

test('a tick arriving while one is in flight is dropped, never stacked', async () => {
  const p = blockingPoll()
  const g = makeGuardedTick(['a', 'b'], p.poll)

  void g.tick()
  await Promise.resolve()
  // Nine more interval firings land while the first cycle is still blocked —
  // the shape that produced 248 concurrent children in the field.
  for (let i = 0; i < 9; i++) void g.tick()
  await Promise.resolve()

  expect(g.busy()).toBe(true)
  expect(g.dropped()).toBe(9)
  // ONE outstanding poll, not ten and not twenty: this is the whole fix. The
  // assertion is on concurrency, not on the drop count, because the drop count
  // is bookkeeping while the concurrency is the resource that ran out.
  expect(p.peak()).toBe(1)
})

test('the unguarded shape this replaced really does stack — the assertion above has power', async () => {
  // Non-vacuity control. Reproduce the OLD code (`for (const ch of channels)
  // void poll(ch)` under a repeating timer) against the same instrument. If
  // this control ever stopped stacking, the test above would be passing for a
  // reason that has nothing to do with the guard.
  const p = blockingPoll()
  const channels = ['a', 'b']
  const unguardedTick = () => {
    for (const ch of channels) void p.poll(ch)
  }
  for (let i = 0; i < 10; i++) unguardedTick()
  await Promise.resolve()

  expect(p.peak()).toBe(20)
})

test('channels within one cycle run in sequence, not in parallel', async () => {
  const order: string[] = []
  const g = makeGuardedTick(['a', 'b', 'c'], async ch => {
    order.push(`start:${ch}`)
    await Promise.resolve()
    order.push(`end:${ch}`)
  })
  await g.tick()
  // Parallel channels would interleave the starts; two channels doubling the
  // descriptor cost of a stuck relay is the same defect one level down.
  expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
})

test('the guard reopens after a cycle finishes — it cannot wedge the poller shut', async () => {
  const p = blockingPoll()
  const g = makeGuardedTick(['a'], p.poll)

  const first = g.tick()
  await Promise.resolve()
  expect(g.busy()).toBe(true)
  await p.releaseAll()
  await first
  expect(g.busy()).toBe(false)

  // A stuck `inFlight` would silence inbound delivery permanently — a quieter
  // failure than the pile-up it replaces, so assert the reopen explicitly.
  const second = g.tick()
  await Promise.resolve()
  expect(g.busy()).toBe(true)
  await p.releaseAll()
  await second
  expect(g.dropped()).toBe(0)
})

test('a throwing poll releases the guard', async () => {
  let calls = 0
  const g = makeGuardedTick(['a'], async () => {
    calls++
    throw new Error('relay exploded')
  })
  await expect(g.tick()).rejects.toThrow('relay exploded')
  expect(g.busy()).toBe(false)
  // Without the `finally`, one relay error would wedge the poller for the life
  // of the process and inbound messaging would go silent with no error anywhere.
  await expect(g.tick()).rejects.toThrow('relay exploded')
  expect(calls).toBe(2)
})

// DIVE-3560 — the poll set is resolved per cycle, and DMs merge into it.

test('a resolver form is re-resolved every cycle, so a newly opened DM is picked up', async () => {
  let round = 0
  const polled: string[][] = []
  const { tick } = makeGuardedTick<string>(
    () => (round++ === 0 ? ['a'] : ['a', 'new-dm']),
    async ch => {
      polled[round - 1] = [...(polled[round - 1] || []), ch]
    },
  )
  await tick()
  await tick()
  expect(polled).toEqual([['a'], ['a', 'new-dm']])
})

test('the resolver runs INSIDE the guard — a dropped tick never resolves', async () => {
  let resolves = 0
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const { tick, dropped } = makeGuardedTick<string>(
    () => {
      resolves++
      return ['a']
    },
    async () => gate,
  )
  const first = tick()
  await tick() // arrives mid-cycle
  expect(dropped()).toBe(1)
  expect(resolves).toBe(1) // the dropped tick did NOT spawn a discovery child
  release()
  await first
})

test('an async resolver that rejects surfaces to the caller and releases the guard', async () => {
  const { tick, busy } = makeGuardedTick<string>(
    async () => {
      throw new Error('dms list exploded')
    },
    async () => {},
  )
  await expect(tick()).rejects.toThrow('dms list exploded')
  expect(busy()).toBe(false)
})

test('mergeTargets flags DMs and leaves configured channels as channels', () => {
  expect(mergeTargets(['chan-1'], ['dm-1'])).toEqual([
    { id: 'dm-1', isDm: true },
    { id: 'chan-1', isDm: false },
  ])
})

test('a uuid in BOTH lists is polled once, as a DM', () => {
  const out = mergeTargets(['both', 'chan-1'], ['both'])
  expect(out.filter(t => t.id === 'both')).toEqual([{ id: 'both', isDm: true }])
  expect(out).toHaveLength(2)
})

test('no DMs discovered leaves the channel poll set exactly as it was', () => {
  expect(mergeTargets(['a', 'b'], [])).toEqual([
    { id: 'a', isDm: false },
    { id: 'b', isDm: false },
  ])
})
