// DIVE-1494 (3): unit matrix for the read-only Council renderers (pure logic in
// plugins/telegram/council.ts). Asserts each view formats the sealed governance
// record correctly, fails closed / soft on missing data, and — the load-bearing
// safety property — that NO raw nonce or tap ever rides in these read-only views
// (the founder-veto TAP is a separate authenticated path, DIVE-1546).
import { describe, test, expect } from 'bun:test'
import {
  renderRoster, renderLog, renderLineage, renderVerify, shortDigest, COUNCIL_BUTTONS, parseVetoTap,
} from '../plugins/telegram/council'

const ROSTER = {
  council: 'council',
  seats: [{ id: 'main', lens: 'main — seat', chair: true }, { id: 'codex', lens: 'codex — seat' }],
  seatCount: 2,
  threshold: 2,
  thresholdSpec: { rule: 'majority' },
  quorum: 2,
  veto: { principal: 'human:main', resolved: '433634012' },
  lineage: { seq: 0, headDigest: 'dQtU1Z_iCpWuT3Ggu6RyV3TnwDkWb_YdtmS1n6qXL10', records: 1 },
}

describe('renderRoster', () => {
  test('renders header, seats, threshold, veto holder, lineage head', () => {
    const out = renderRoster(ROSTER)
    expect(out).toContain('🏛️ Council: council')
    expect(out).toContain('main (chair)')
    expect(out).toContain('codex')
    expect(out).toContain('majority (2/2)')
    expect(out).toContain('quorum 2')
    expect(out).toContain('founder veto: human:main')
    expect(out).toContain('seq 0')
    expect(out).toContain('dQtU1Z_iCpWu…')
    expect(out).toContain('1 record')
  })
  test('never leaks the resolved veto recipient id (only the principal handle)', () => {
    expect(renderRoster(ROSTER)).not.toContain('433634012')
  })
  test('fails soft on a null / uninitialized council', () => {
    expect(renderRoster(null)).toContain('not initialized')
    expect(renderRoster({})).toContain('🏛️ Council')
  })
})

describe('renderLog', () => {
  const ENTRIES = [
    { seq: 0, kind: 'genesis', stampedAt: '2026-07-19T14:18:53Z', digest: 'aaaaaaaaaaaaaaaa' },
    { seq: 2, kind: 'veto', stampedAt: '2026-07-19T16:00:00Z', digest: 'cccccccccccccccc' },
    { seq: 1, kind: 'motion:promote', stampedAt: '2026-07-19T15:00:00Z', digest: 'bbbbbbbbbbbbbbbb' },
  ]
  test('newest-first, limited, one line per verdict', () => {
    const out = renderLog(ENTRIES, 5)
    const lines = out.split('\n')
    expect(lines[0]).toContain('last 3')
    expect(lines[1]).toContain('seq 2 · veto')
    expect(lines[2]).toContain('seq 1 · motion:promote')
    expect(lines[3]).toContain('seq 0 · genesis')
  })
  test('respects the limit', () => {
    expect(renderLog(ENTRIES, 1).split('\n')).toHaveLength(2) // header + 1
  })
  test('empty / missing → soft message', () => {
    expect(renderLog([])).toContain('empty')
    expect(renderLog(null)).toContain('empty')
  })
})

describe('renderLineage', () => {
  test('head + record count + seq/kind ladder', () => {
    const out = renderLineage([
      { seq: 0, kind: 'genesis', digest: 'g0000000000000000' },
      { seq: 1, kind: 'veto', digest: 'v1111111111111111' },
    ])
    expect(out).toContain('2 records')
    expect(out).toContain('head v111111111111…'.slice(0, 12)) // head is the highest seq
    expect(out).toContain('seq 1 veto ← seq 0 genesis')
  })
})

describe('renderVerify', () => {
  test('GREEN when verified', () => {
    const out = renderVerify({ verified: true, records: 1, chain: { head: 'dQtU1Z_iCpWuT3Gg' } })
    expect(out).toContain('✅ Council verify: GREEN')
    expect(out).toContain('1 record')
  })
  test('RED names the failing leg (fail-closed)', () => {
    const out = renderVerify({ verified: false, chainOk: true, resealOk: false, resealBad: 'deadbeef00000000', constitutionOk: false })
    expect(out).toContain('🛑 Council verify: RED')
    expect(out).toContain('reseal FAILED')
    expect(out).toContain('constitution DRIFTED')
  })
  test('null → fail-closed message', () => {
    expect(renderVerify(null)).toContain('fail-closed')
  })
})

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

describe('shortDigest', () => {
  test('truncates long digests, passes through short, dashes empty', () => {
    expect(shortDigest('dQtU1Z_iCpWuT3Ggu6RyV3TnwDkWb')).toBe('dQtU1Z_iCpWu…')
    expect(shortDigest('abc')).toBe('abc')
    expect(shortDigest('')).toBe('none')
    expect(shortDigest(undefined)).toBe('none')
  })
})
