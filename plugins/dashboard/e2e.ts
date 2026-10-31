// DIVE-6876 (designed on DIVE-6875): the 5dive chat end-to-end envelope, v1.
//
// WebCrypto only (browser, Telegram webview, Bun), no dependency, so the app
// and the box can run byte-identical copies.
//
//   identity   ECDH P-256 per party: one for the box, one per browser/phone.
//              P-256, not X25519: older Android webviews lack X25519 in
//              WebCrypto, and the Telegram Mini App runs in one.
//   message    one random content key K, AES-256-GCM over the plaintext,
//              then K wrapped once per recipient under a key derived from
//              ECDH(sender static, recipient static) + HKDF-SHA256.
//   binding    the header (version, sender, conversation, message id,
//              direction, time, salt) is the AAD of the body; the wrap's AAD
//              is the header plus SHA-256 of the body ciphertext, so a
//              recipient who knows K cannot swap the body under the other
//              recipients' wraps.
//   pairing    the secret in the link line keys an HMAC over each side's
//              public key, so the API (which carries the keys) cannot swap one.
//
// Static-static: no forward secrecy in v1. A stolen box key reads past
// ciphertext the relay kept. That is a named item for the outside review.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const VERSION = 1
const INFO_WRAP = '5dive-chat-e2e-v1 wrap'
const INFO_PAIR = '5dive-chat-e2e-v1 pair'

export type Direction = 'in' | 'out'
export interface Header {
  v: number
  s: string // sender id: 'box' or a device id
  c: string // conversation id
  m: string // message id (client id), the receiver's replay key
  d: Direction
  t: number // sender's clock, ms
  salt: string
}
export interface Envelope {
  h: Header
  iv: string
  ct: string
  k: Record<string, { iv: string; w: string }>
}

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unb64u(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

/** Canonical bytes of the header: fixed key order, no whitespace. */
function canon(h: Header): Uint8Array {
  return enc.encode(JSON.stringify([h.v, h.s, h.c, h.m, h.d, h.t, h.salt]))
}

export async function newIdentity(extractable = false): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits'])
}
export async function exportPublic(pub: CryptoKey): Promise<string> {
  return b64u(await crypto.subtle.exportKey('raw', pub))
}
export async function importPublic(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', unb64u(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

/** What a person compares on two screens: 20 base32 chars of SHA-256(pub). */
export async function fingerprint(pubRaw: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64u(pubRaw)))
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let bits = 0, acc = 0, out = ''
  for (const b of d) {
    acc = (acc << 8) | b; bits += 8
    while (bits >= 5 && out.length < 20) { out += A[(acc >> (bits - 5)) & 31]; bits -= 5 }
    if (out.length >= 20) break
  }
  return out.match(/.{4}/g)!.join('-')
}

async function kek(priv: CryptoKey, pub: CryptoKey, salt: Uint8Array, from: string, to: string, header: Header): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${INFO_WRAP}|${from}|${to}|${header.c}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

function wrapAad(h: Header, ctHash: Uint8Array): Uint8Array {
  const a = canon(h)
  const out = new Uint8Array(a.length + ctHash.length)
  out.set(a); out.set(ctHash, a.length)
  return out
}

export interface SealArgs {
  senderId: string
  senderPriv: CryptoKey
  recipients: { id: string; pub: CryptoKey }[]
  conv: string
  msgId: string
  dir: Direction
  plaintext: Uint8Array | string
  now?: number
}

export async function seal(a: SealArgs): Promise<Envelope> {
  if (a.recipients.length === 0) throw new Error('no recipients')
  const salt = rand(16)
  const h: Header = { v: VERSION, s: a.senderId, c: a.conv, m: a.msgId, d: a.dir, t: a.now ?? Date.now(), salt: b64u(salt) }
  const kRaw = rand(32)
  const k = await crypto.subtle.importKey('raw', kRaw, 'AES-GCM', false, ['encrypt'])
  const iv = rand(12)
  const pt = typeof a.plaintext === 'string' ? enc.encode(a.plaintext) : a.plaintext
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: canon(h) }, k, pt))
  const ctHash = new Uint8Array(await crypto.subtle.digest('SHA-256', ct))
  const wraps: Envelope['k'] = {}
  for (const r of a.recipients) {
    if (wraps[r.id]) throw new Error(`duplicate recipient ${r.id}`)
    const key = await kek(a.senderPriv, r.pub, salt, a.senderId, r.id, h)
    const wiv = rand(12)
    const w = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wiv, additionalData: wrapAad(h, ctHash) }, key, kRaw)
    wraps[r.id] = { iv: b64u(wiv), w: b64u(w) }
  }
  kRaw.fill(0)
  return { h, iv: b64u(iv), ct: b64u(ct), k: wraps }
}

export interface OpenArgs {
  env: Envelope
  myId: string
  myPriv: CryptoKey
  /** The sender's key from the reader's OWN trusted roster, never from the envelope or the API. */
  senderPub: CryptoKey
  expect: { conv: string; dir: Direction }
}

/** The content key for `a.myId`. Exported for the co-recipient test only; callers use open(). */
export async function unwrap(a: OpenArgs, ct = unb64u(a.env.ct)): Promise<Uint8Array> {
  const { h } = a.env
  const mine = a.env.k[a.myId]
  if (!mine) throw new Error('not a recipient')
  const ctHash = new Uint8Array(await crypto.subtle.digest('SHA-256', ct))
  const key = await kek(a.myPriv, a.senderPub, unb64u(h.salt), h.s, a.myId, h)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(mine.iv), additionalData: wrapAad(h, ctHash) }, key, unb64u(mine.w)))
}

/** Throws on anything off: wrong version, conversation, direction, key, or a single flipped bit. */
export async function open(a: OpenArgs): Promise<Uint8Array> {
  const { h } = a.env
  if (h.v !== VERSION) throw new Error(`unknown version ${h.v}`)
  if (h.c !== a.expect.conv) throw new Error('conversation mismatch')
  if (h.d !== a.expect.dir) throw new Error('direction mismatch')
  const ct = unb64u(a.env.ct)
  const kRaw = await unwrap(a, ct)
  const k = await crypto.subtle.importKey('raw', kRaw, 'AES-GCM', false, ['decrypt'])
  kRaw.fill(0)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(a.env.iv), additionalData: canon(h) }, k, ct))
}
export const openText = async (a: OpenArgs) => dec.decode(await open(a))

async function pairKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', unb64u(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(INFO_PAIR) },
    ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'],
  )
}
/** 32 random bytes, made in the browser, carried only in the link line the owner pastes on the server. */
export const newPairingSecret = () => b64u(rand(32))
const pairMsg = (role: string, boxId: string, pubRaw: string) => enc.encode(`${role}|${boxId}|${pubRaw}`)
export async function pairProof(secret: string, role: 'box' | 'device', boxId: string, pubRaw: string): Promise<string> {
  return b64u(await crypto.subtle.sign('HMAC', await pairKey(secret), pairMsg(role, boxId, pubRaw)))
}
export async function pairVerify(secret: string, role: 'box' | 'device', boxId: string, pubRaw: string, proof: string): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await pairKey(secret), unb64u(proof), pairMsg(role, boxId, pubRaw))
}
