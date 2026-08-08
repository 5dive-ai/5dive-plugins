// plugins/buzz/mention.ts — the pure half of the Buzz bridge: npub encoding and
// mention detection, with NO imports.
//
// Deliberately dependency-free and side-effect-free. Repo CI runs a bare
// `bun test` with no plugin deps installed and no servers booted, so a test that
// reaches these functions through `server.ts` cannot run there: it would pull in
// @modelcontextprotocol/sdk and then boot an MCP server on stdio at import time.
// Keeping the logic here is what makes it testable at all.

export const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values: number[]) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i]
  }
  return chk
}

// BIP-173 expansion: every high-bit group, then a 0 separator, then every
// low-bit group. Interleaving the two per character (the obvious-looking
// flatMap) yields a checksum wrong in only its last six characters — so the
// npub still LOOKS like an npub and the NIP-27 mention path silently never
// matches. Guarded by encoderIsSane().
function bech32Expand(hrp: string) {
  const hi = [...hrp].map(c => c.charCodeAt(0) >> 5)
  const lo = [...hrp].map(c => c.charCodeAt(0) & 31)
  return [...hi, 0, ...lo]
}

function convertBits(bytes: number[], from: number, to: number, pad = true) {
  let acc = 0,
    bits = 0,
    out: number[] = []
  const maxv = (1 << to) - 1
  for (const b of bytes) {
    acc = (acc << from) | b
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv)
  return out
}

export function npubEncode(pubhex: string) {
  const bytes: number[] = []
  for (let i = 0; i < pubhex.length; i += 2) bytes.push(parseInt(pubhex.slice(i, i + 2), 16))
  const data = convertBits(bytes, 8, 5)
  const values = [...bech32Expand('npub'), ...data, 0, 0, 0, 0, 0, 0]
  const mod = bech32Polymod(values) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31)
  return 'npub1' + [...data, ...checksum].map(v => BECH32[v]).join('')
}

// A wrong encoder does not throw — it returns a plausible npub whose checksum is
// wrong, and the NIP-27 branch is then dead for the whole life of the process.
// So encode the published NIP-19 vector and let the caller say so out loud,
// rather than letting one of three detection paths go quietly missing.
export const NIP19_VECTOR = {
  hex: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
  npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
}

export function encoderIsSane(): boolean {
  try {
    return npubEncode(NIP19_VECTOR.hex) === NIP19_VECTOR.npub
  } catch {
    return false
  }
}

export type BuzzEvent = {
  id: string
  pubkey: string
  kind: number
  content: string
  created_at: number
  tags: string[][]
}

// Three detection paths, measured against the live relay on 2026-08-08:
//   - p tag carrying our pubkey hex — what the relay writes for BOTH an explicit
//     `--mention <hex>` and a real NIP-27 `nostr:npub1…` in content;
//   - the NIP-27 form matched in content ourselves, as a belt-and-braces path
//     for a relay that does not resolve it (skipped when the encoder is unsound,
//     since a bad npub would silently match nothing);
//   - raw 64-hex in content, the only form the relay does NOT resolve.
export function mentionsUs(
  ev: BuzzEvent,
  ourPubkeyHex: string,
  ourNpub: string,
  encoderSane: boolean,
): boolean {
  if (!ourPubkeyHex) return false
  if (ev.pubkey === ourPubkeyHex) return false // never self-deliver
  if ((ev.tags || []).some(t => t[0] === 'p' && t[1] === ourPubkeyHex)) return true
  if (encoderSane && ourNpub && ev.content.includes('nostr:' + ourNpub)) return true
  if (ev.content.includes(ourPubkeyHex)) return true
  return false
}
