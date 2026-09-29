// DIVE-1566 / DIVE-1546: unit matrix for the council's authenticated Telegram taps
// (pure parsers in plugins/telegram/council.ts), and the proof that the retired
// read-only cl:* verbs are never taken for a veto or a ballot.
// DIVE-5164 removed /council and its renderers (lodar); their arms went with them.
import { describe, test, expect } from 'bun:test'
import { COUNCIL_BUTTONS, parseVetoTap, parseCvoteTap } from '../plugins/telegram/council'

describe('read-only safety (no nonce / no mutating tap)', () => {
  test('the /council buttons are static read-only verbs — no nonce, under 64 bytes', () => {
    const datas = COUNCIL_BUTTONS.map(b => b.callback_data)
    expect(datas).toEqual(['cl:log', 'cl:lin', 'cl:ver'])
    for (const d of datas) {
      expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64)
      // no long hex run that could be a leaked bearer token / nonce
      expect(d).not.toMatch(/[0-9a-f]{16,}/)
    }
  })
})

describe('parseVetoTap (DIVE-1546 authenticated founder-veto tap)', () => {
  const NONCE = '0123456789abcdef0123456789abcdef' // openssl rand -hex 16 shape (32 hex)
  const PREFIX = 'dQtU1Z_iCpWu'                    // 12-char unique receipt prefix
  test('parses veto:<receiptPrefix>:<nonce>', () => {
    const r = parseVetoTap(`veto:${PREFIX}:${NONCE}`)
    expect(r).toEqual({ receipt: PREFIX, nonce: NONCE })
  })
  test('the read-only cl:* verbs are NOT parsed as a veto (no nonce confusion)', () => {
    for (const b of COUNCIL_BUTTONS) expect(parseVetoTap(b.callback_data)).toBeNull()
  })
  test('rejects malformed / truncated payloads (fail-closed)', () => {
    expect(parseVetoTap('veto:onlyreceipt')).toBeNull()        // no nonce
    expect(parseVetoTap('veto::' + NONCE)).toBeNull()          // empty receipt
    expect(parseVetoTap(`veto:${PREFIX}:`)).toBeNull()         // empty nonce
    expect(parseVetoTap(`veto:${PREFIX}:NOTHEXNOTHEXNOTHEXNOTHEXNOTHEX00`)).toBeNull() // non-hex nonce
    expect(parseVetoTap('tna:1234:abcde')).toBeNull()          // a different tap prefix
    expect(parseVetoTap('')).toBeNull()
  })
  test('the whole callback_data (prefix form) stays under Telegram\'s 64-byte cap', () => {
    // A full base64url digest (43) + nonce (32) would be 81 bytes > 64 — hence the receipt PREFIX.
    const data = `veto:${PREFIX}:${NONCE}`
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    expect(parseVetoTap(data)).not.toBeNull()
  })
})

describe('parseCvoteTap (DIVE-1566 authenticated human-as-seat ballot tap)', () => {
  const NONCE = '0123456789abcdef0123456789abcdef' // randomBytes(16).toString('hex') shape (32 hex)
  const REF = 'DIVE-1566'                          // ballot task-id prefix (taskId.slice(0,12))
  test('parses cvote:<ref>:<code>:<nonce> for each vote code', () => {
    expect(parseCvoteTap(`cvote:${REF}:a:${NONCE}`)).toEqual({ ref: REF, code: 'a', nonce: NONCE })
    expect(parseCvoteTap(`cvote:${REF}:r:${NONCE}`)).toEqual({ ref: REF, code: 'r', nonce: NONCE })
    expect(parseCvoteTap(`cvote:${REF}:e:${NONCE}`)).toEqual({ ref: REF, code: 'e', nonce: NONCE })
  })
  test('a numeric ref prefix (non-DIVE ident) parses', () => {
    expect(parseCvoteTap(`cvote:1706:a:${NONCE}`)).toEqual({ ref: '1706', code: 'a', nonce: NONCE })
  })
  test('the read-only cl:* verbs and a veto tap are NOT parsed as a cvote (no confusion)', () => {
    for (const b of COUNCIL_BUTTONS) expect(parseCvoteTap(b.callback_data)).toBeNull()
    expect(parseCvoteTap(`veto:dQtU1Z_iCpWu:${NONCE}`)).toBeNull()
  })
  test('rejects malformed / truncated payloads (fail-closed)', () => {
    expect(parseCvoteTap(`cvote:${REF}:${NONCE}`)).toBeNull()        // missing code group
    expect(parseCvoteTap(`cvote::a:${NONCE}`)).toBeNull()            // empty ref
    expect(parseCvoteTap(`cvote:${REF}:x:${NONCE}`)).toBeNull()      // bad vote code (not a|r|e)
    expect(parseCvoteTap(`cvote:${REF}:a:`)).toBeNull()              // empty nonce
    expect(parseCvoteTap(`cvote:${REF}:a:NOTHEXNOTHEXNOTHEXNOTHEXNOTHEX00`)).toBeNull() // non-hex nonce
    expect(parseCvoteTap(`cvote:${REF}:a:${NONCE}0`)).toBeNull()     // nonce too long (33 hex)
    expect(parseCvoteTap(`cvote:WAYTOOLONGAREF:a:${NONCE}`)).toBeNull() // ref > 12 chars
    expect(parseCvoteTap('tna:1234:abcde')).toBeNull()              // a different tap prefix
    expect(parseCvoteTap('')).toBeNull()
  })
  test('the whole callback_data stays under Telegram\'s 64-byte cap', () => {
    const data = `cvote:${REF}:a:${NONCE}`
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    expect(parseCvoteTap(data)).not.toBeNull()
  })
})
