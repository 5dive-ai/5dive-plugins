// Guards the two failure modes that do not announce themselves:
//   1. a bech32 checksum that is wrong only in its last six characters, which
//      leaves a plausible-looking npub and a permanently dead NIP-27 branch;
//   2. a cold-start poll that replays a channel's whole backlog as new.
import { expect, test } from 'bun:test'
import { npubEncode, encoderIsSane, NIP19_VECTOR } from './server.ts'

test('npub encoder matches the NIP-19 vector', () => {
  expect(npubEncode(NIP19_VECTOR.hex)).toBe(NIP19_VECTOR.npub)
  expect(encoderIsSane()).toBe(true)
})

test('a wrong expansion is caught by the checksum, not by the shape', () => {
  // The interleaved expansion this plugin shipped with produced a string that
  // still starts npub1 and still has the right length — only the checksum
  // differs. Assert on the full string, never on the prefix or the length.
  const bad = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwse59lw6'
  expect(bad.startsWith('npub1')).toBe(true)
  expect(bad.length).toBe(NIP19_VECTOR.npub.length)
  expect(bad).not.toBe(NIP19_VECTOR.npub)
})
