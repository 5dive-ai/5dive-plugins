// Guards the failure modes that do not announce themselves. Imports the PURE
// module on purpose: repo CI runs a bare `bun test` with no plugin deps
// installed, so a test that reached these functions through server.ts could not
// run there at all.
import { expect, test } from 'bun:test'
import { npubEncode, encoderIsSane, mentionsUs, NIP19_VECTOR, type BuzzEvent } from './mention.ts'

const OURS = '0ed5b831af702446a9f4e90b3c43137a07f80140e3926a13687f2736d6083297'
const OUR_NPUB = npubEncode(OURS)
const THEIRS = 'e2dc53e55e3c577743e6d33e52e17c770ba4bde0c49c68613403257d342efbdc'
const ev = (o: Partial<BuzzEvent>): BuzzEvent =>
  ({ id: 'x', pubkey: THEIRS, kind: 9, content: '', created_at: 0, tags: [], ...o }) as BuzzEvent

test('npub encoder matches the published NIP-19 vector', () => {
  expect(npubEncode(NIP19_VECTOR.hex)).toBe(NIP19_VECTOR.npub)
  expect(encoderIsSane()).toBe(true)
})

test('a wrong bech32 expansion is caught by the checksum, not by the shape', () => {
  // The interleaved expansion this plugin shipped with produced a string that
  // still starts npub1 and still has the exact right length — only the six
  // checksum characters differ. So assert the whole string; a prefix or length
  // assertion is an assertion on the axis the bug does not move.
  const bad = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwse59lw6'
  expect(bad.startsWith('npub1')).toBe(true)
  expect(bad.length).toBe(NIP19_VECTOR.npub.length)
  expect(bad).not.toBe(NIP19_VECTOR.npub)
})

test('detects a p tag, the NIP-27 form, and raw hex — and nothing else', () => {
  expect(mentionsUs(ev({ tags: [['p', OURS]] }), OURS, OUR_NPUB, true)).toBe(true)
  expect(mentionsUs(ev({ content: `hi nostr:${OUR_NPUB} there` }), OURS, OUR_NPUB, true)).toBe(true)
  expect(mentionsUs(ev({ content: `raw ${OURS} inline` }), OURS, OUR_NPUB, true)).toBe(true)
  // the control that makes the three above mean something
  expect(mentionsUs(ev({ content: 'nobody is mentioned here' }), OURS, OUR_NPUB, true)).toBe(false)
  // a p tag for someone else is not a mention of us
  expect(mentionsUs(ev({ tags: [['p', THEIRS]] }), OURS, OUR_NPUB, true)).toBe(false)
})

test('never self-delivers, even when our own post mentions us', () => {
  expect(mentionsUs(ev({ pubkey: OURS, tags: [['p', OURS]] }), OURS, OUR_NPUB, true)).toBe(false)
})

test('an unsound encoder disables ONLY the NIP-27 path', () => {
  const nip27 = ev({ content: `hi nostr:${OUR_NPUB}` })
  expect(mentionsUs(nip27, OURS, OUR_NPUB, false)).toBe(false)
  expect(mentionsUs(ev({ tags: [['p', OURS]] }), OURS, OUR_NPUB, false)).toBe(true)
  expect(mentionsUs(ev({ content: `raw ${OURS}` }), OURS, OUR_NPUB, false)).toBe(true)
})

// --- DIVE-3560: DM inbound ---------------------------------------------------
import { shouldDeliver, parseDmList } from './mention.ts'

test('a DM from someone else is delivered even with no mention markers at all', () => {
  const plain = ev({ content: 'hey, can you look at the deploy?' })
  // the channel path is unchanged: no mention, no delivery
  expect(shouldDeliver(plain, OURS, OUR_NPUB, true, false)).toBe(false)
  // the DM path: addressed to us by construction
  expect(shouldDeliver(plain, OURS, OUR_NPUB, true, true)).toBe(true)
})

test('a DM never self-delivers our own message back into the session', () => {
  expect(shouldDeliver(ev({ pubkey: OURS, content: 'my own reply' }), OURS, OUR_NPUB, true, true)).toBe(false)
})

test('shouldDeliver on a channel is exactly mentionsUs', () => {
  for (const e of [ev({ tags: [['p', OURS]] }), ev({ content: 'nothing' }), ev({ pubkey: OURS, tags: [['p', OURS]] })]) {
    expect(shouldDeliver(e, OURS, OUR_NPUB, true, false)).toBe(mentionsUs(e, OURS, OUR_NPUB, true))
  }
})

test('parseDmList extracts dm ids and drops junk, self-only and malformed rows', () => {
  const raw = JSON.stringify([
    { dm_id: '539f753f-0615-4331-bd56-0a3e2b5a4724', participants: [OURS, THEIRS] },
    { dm_id: '', participants: [THEIRS] },
    { participants: [THEIRS] },
    { dm_id: 'd6e3c523-f446-4d7e-871a-438368e5d07e', participants: [OURS] }, // note-to-self, still ours
    'garbage',
  ])
  expect(parseDmList(raw)).toEqual([
    '539f753f-0615-4331-bd56-0a3e2b5a4724',
    'd6e3c523-f446-4d7e-871a-438368e5d07e',
  ])
})

test('parseDmList on non-JSON and on a non-array returns empty, never throws', () => {
  expect(parseDmList('{"error":"network_error"}')).toEqual([])
  expect(parseDmList('not json at all')).toEqual([])
  expect(parseDmList('')).toEqual([])
})

test('parseDmList dedupes a repeated dm id', () => {
  const id = '539f753f-0615-4331-bd56-0a3e2b5a4724'
  expect(parseDmList(JSON.stringify([{ dm_id: id }, { dm_id: id }]))).toEqual([id])
})
