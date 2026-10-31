// DIVE-6876: the envelope itself (protocol v1, docs/chat-e2e.md). Moved here from
// the DIVE-6875 prototype unchanged; E6 goes red when the wrap stops binding
// the body hash.
import { describe, expect, test } from 'bun:test'
import * as E from '../plugins/dashboard/e2e.ts'

async function party() {
  const kp = await E.newIdentity()
  return { kp, raw: await E.exportPublic(kp.publicKey) }
}

describe('chat e2e envelope v1', async () => {
  const box = await party(), phone = await party(), laptop = await party(), relay = await party()

  const inbound = (text = 'hello box') => E.seal({
    senderId: 'dev-phone', senderPriv: phone.kp.privateKey,
    recipients: [{ id: 'box', pub: box.kp.publicKey }, { id: 'dev-laptop', pub: laptop.kp.publicKey }],
    conv: '42', msgId: 'c-1', dir: 'in', plaintext: text,
  })
  const boxOpens = (env: E.Envelope, senderPub = phone.kp.publicKey) =>
    E.openText({ env, myId: 'box', myPriv: box.kp.privateKey, senderPub, expect: { conv: '42', dir: 'in' } })

  test('E1 every recipient reads it; the relay sees none of it', async () => {
    const env = await inbound('the plan is 🍵')
    expect(await boxOpens(env)).toBe('the plan is 🍵')
    expect(await E.openText({ env, myId: 'dev-laptop', myPriv: laptop.kp.privateKey, senderPub: phone.kp.publicKey, expect: { conv: '42', dir: 'in' } })).toBe('the plan is 🍵')
    expect(JSON.stringify(env)).not.toContain('plan')
  })

  test('E2 a non-recipient key cannot open it', async () => {
    const env = await inbound()
    await expect(E.openText({ env, myId: 'box', myPriv: relay.kp.privateKey, senderPub: phone.kp.publicKey, expect: { conv: '42', dir: 'in' } })).rejects.toThrow()
  })

  test('E3 a message forged by the relay with its own key fails against the trusted sender key', async () => {
    const forged = await E.seal({ senderId: 'dev-phone', senderPriv: relay.kp.privateKey, recipients: [{ id: 'box', pub: box.kp.publicKey }], conv: '42', msgId: 'c-9', dir: 'in', plaintext: 'rm -rf' })
    await expect(boxOpens(forged)).rejects.toThrow()
  })

  test('E4 moving it to another conversation, flipping direction, or editing the header fails', async () => {
    const env = await inbound()
    await expect(boxOpens({ ...env, h: { ...env.h, c: '43' } })).rejects.toThrow('conversation mismatch')
    await expect(E.openText({ env, myId: 'box', myPriv: box.kp.privateKey, senderPub: phone.kp.publicKey, expect: { conv: '42', dir: 'out' } })).rejects.toThrow('direction mismatch')
    await expect(boxOpens({ ...env, h: { ...env.h, m: 'c-2' } })).rejects.toThrow()
    await expect(boxOpens({ ...env, h: { ...env.h, t: env.h.t + 1 } })).rejects.toThrow()
  })

  test('E5 one flipped bit anywhere in the body or a wrap fails', async () => {
    const env = await inbound()
    const ct = E.unb64u(env.ct); ct[3] ^= 1
    await expect(boxOpens({ ...env, ct: E.b64u(ct) })).rejects.toThrow()
    const w = E.unb64u(env.k.box.w); w[0] ^= 1
    await expect(boxOpens({ ...env, k: { ...env.k, box: { ...env.k.box, w: E.b64u(w) } } })).rejects.toThrow()
  })

  test('E6 a co-recipient who knows K cannot swap the body under the others\' wraps', async () => {
    const env = await inbound('pay 10')
    const laptopView = { env, myId: 'dev-laptop', myPriv: laptop.kp.privateKey, senderPub: phone.kp.publicKey, expect: { conv: '42', dir: 'in' as const } }
    const kRaw = await E.unwrap(laptopView)
    const k = await crypto.subtle.importKey('raw', kRaw, 'AES-GCM', false, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const aad = new TextEncoder().encode(JSON.stringify([env.h.v, env.h.s, env.h.c, env.h.m, env.h.d, env.h.t, env.h.salt]))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, new TextEncoder().encode('pay 10000'))
    await expect(boxOpens({ ...env, iv: E.b64u(iv), ct: E.b64u(ct) })).rejects.toThrow()
  })

  test('E7 the box writes once for every device', async () => {
    const env = await E.seal({ senderId: 'box', senderPriv: box.kp.privateKey, recipients: [{ id: 'dev-phone', pub: phone.kp.publicKey }, { id: 'dev-laptop', pub: laptop.kp.publicKey }], conv: '42', msgId: 'r-1', dir: 'out', plaintext: 'done' })
    for (const [id, kp] of [['dev-phone', phone.kp], ['dev-laptop', laptop.kp]] as const)
      expect(await E.openText({ env, myId: id, myPriv: kp.privateKey, senderPub: box.kp.publicKey, expect: { conv: '42', dir: 'out' } })).toBe('done')
  })

  test('E8 pairing: the link-line secret proves both keys; a swapped key fails', async () => {
    const s = E.newPairingSecret()
    const proof = await E.pairProof(s, 'box', 'srv-7', box.raw)
    expect(await E.pairVerify(s, 'box', 'srv-7', box.raw, proof)).toBe(true)
    expect(await E.pairVerify(s, 'box', 'srv-7', relay.raw, proof)).toBe(false)
    expect(await E.pairVerify(s, 'device', 'srv-7', box.raw, proof)).toBe(false)
    expect(await E.pairVerify(E.newPairingSecret(), 'box', 'srv-7', box.raw, proof)).toBe(false)
  })

  test('E9 a browser key is not extractable', async () => {
    await expect(crypto.subtle.exportKey('jwk', phone.kp.privateKey)).rejects.toThrow()
  })

  test('E10 fingerprint is stable, 4x5 groups, and differs per key', async () => {
    const f = await E.fingerprint(box.raw)
    expect(f).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/)
    expect(await E.fingerprint(box.raw)).toBe(f)
    expect(await E.fingerprint(phone.raw)).not.toBe(f)
  })

  test('E11 a 5 MB file body seals and opens', async () => {
    const big = crypto.getRandomValues(new Uint8Array(65536))
    const file = new Uint8Array(5 * 1024 * 1024); for (let i = 0; i < file.length; i += big.length) file.set(big.subarray(0, Math.min(big.length, file.length - i)), i)
    const env = await E.seal({ senderId: 'box', senderPriv: box.kp.privateKey, recipients: [{ id: 'dev-phone', pub: phone.kp.publicKey }], conv: '42', msgId: 'f-1', dir: 'out', plaintext: file })
    const back = await E.open({ env, myId: 'dev-phone', myPriv: phone.kp.privateKey, senderPub: box.kp.publicKey, expect: { conv: '42', dir: 'out' } })
    expect(back.length).toBe(file.length)
    expect(back[12345]).toBe(file[12345])
  })
})
