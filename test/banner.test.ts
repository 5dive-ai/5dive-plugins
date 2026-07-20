// DIVE-1503: pinned self-updating "needs-you" banner — pure decision logic.
//
// server.ts long-polls on import, so (like tna.ts) the banner state machine
// lives in an import-safe module we can drive headlessly here: no bot boot, no
// Telegram, no live board. We assert the full lifecycle (pin → edit → unpin) and
// that every fork ships a byte-identical banner.ts so a fork can never drift.

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  summarizeNeeds,
  humanizeAge,
  parseGateTs,
  formatNeedsBanner,
  bannerFingerprint,
  reconcileBanner,
  BANNER_CLEAR_TEXT,
  type BannerState,
} from '../plugins/telegram/banner'

const gate = (over: Record<string, unknown> = {}) => ({
  need_type: 'decision',
  need_answer: null,
  created_at: '2026-07-20 08:00:00',
  ...over,
})

describe('summarizeNeeds', () => {
  test('counts only unanswered gates and finds the oldest', () => {
    const s = summarizeNeeds([
      gate({ created_at: '2026-07-20 09:00:00' }),
      gate({ created_at: '2026-07-20 07:30:00' }), // oldest
      gate({ created_at: '2026-07-20 10:00:00' }),
    ])
    expect(s.count).toBe(3)
    expect(s.oldestCreatedAt).toBe('2026-07-20 07:30:00')
  })

  test('excludes answered gates and non-gate rows (mirrors buildInboxList filter)', () => {
    const s = summarizeNeeds([
      gate(),
      gate({ need_answer: 'yes' }), // already answered → not pending
      { need_type: null, created_at: '2026-07-20 06:00:00' }, // plain blocked task
      null,
      'garbage',
    ])
    expect(s.count).toBe(1)
    expect(s.oldestCreatedAt).toBe('2026-07-20 08:00:00')
  })

  test('empty / non-array → zero', () => {
    expect(summarizeNeeds([])).toEqual({ count: 0, oldestCreatedAt: null })
    expect(summarizeNeeds(undefined as unknown)).toEqual({ count: 0, oldestCreatedAt: null })
  })
})

describe('humanizeAge', () => {
  const t0 = parseGateTs('2026-07-20 08:00:00')!
  test('buckets seconds/minutes/hours/days', () => {
    expect(humanizeAge(t0, t0 + 30_000)).toBe('just now')
    expect(humanizeAge(t0, t0 + 5 * 60_000)).toBe('5m')
    expect(humanizeAge(t0, t0 + 3 * 3600_000)).toBe('3h')
    expect(humanizeAge(t0, t0 + 2 * 86_400_000)).toBe('2d')
  })
  test('null → unknown age; future stamp clamps to just now', () => {
    expect(humanizeAge(null, t0)).toBe('unknown age')
    expect(humanizeAge(t0, t0 - 5000)).toBe('just now')
  })
})

describe('formatNeedsBanner', () => {
  const now = parseGateTs('2026-07-20 11:00:00')!
  test('singular vs plural + oldest age, no em-dash', () => {
    const one = formatNeedsBanner({ count: 1, oldestCreatedAt: '2026-07-20 08:00:00' }, now)
    expect(one).toContain('1 gate needs you')
    expect(one).toContain('oldest 3h old')
    expect(one).toContain('clear it')
    const many = formatNeedsBanner({ count: 4, oldestCreatedAt: '2026-07-20 10:30:00' }, now)
    expect(many).toContain('4 gates need you')
    expect(many).toContain('clear them')
    for (const s of [one, many]) expect(s).not.toContain('—')
  })
})

describe('reconcileBanner state machine', () => {
  const now = parseGateTs('2026-07-20 11:00:00')!
  const summary = (count: number, oldest: string | null) => ({ count, oldestCreatedAt: oldest })

  test('first gate → send + pin', () => {
    const act = reconcileBanner(undefined, summary(1, '2026-07-20 10:00:00'), now)
    expect(act.kind).toBe('send')
    if (act.kind === 'send') expect(act.fingerprint).toBe(bannerFingerprint(summary(1, '2026-07-20 10:00:00'), now))
  })

  test('unchanged backlog → none (no edit storm)', () => {
    const s = summary(2, '2026-07-20 09:00:00')
    const prev: BannerState = { messageId: 42, fingerprint: bannerFingerprint(s, now) }
    expect(reconcileBanner(prev, s, now).kind).toBe('none')
  })

  test('backlog grows → edit in place (same message id)', () => {
    const prev: BannerState = { messageId: 42, fingerprint: bannerFingerprint(summary(1, '2026-07-20 09:00:00'), now) }
    const act = reconcileBanner(prev, summary(3, '2026-07-20 09:00:00'), now)
    expect(act.kind).toBe('edit')
    if (act.kind === 'edit') expect(act.messageId).toBe(42)
  })

  test('age label rolls over → edit', () => {
    const s = summary(1, '2026-07-20 10:59:30') // "just now" at `now`
    const prev: BannerState = { messageId: 7, fingerprint: bannerFingerprint(s, now) }
    const later = now + 5 * 60_000 // now "5m"
    const act = reconcileBanner(prev, s, later)
    expect(act.kind).toBe('edit')
  })

  test('drains to zero with a pin → unpin', () => {
    const prev: BannerState = { messageId: 99, fingerprint: 'anything' }
    const act = reconcileBanner(prev, summary(0, null), now)
    expect(act.kind).toBe('unpin')
    if (act.kind === 'unpin') {
      expect(act.messageId).toBe(99)
      expect(act.clearText).toBe(BANNER_CLEAR_TEXT)
    }
  })

  test('zero with no prior pin → none', () => {
    expect(reconcileBanner(undefined, summary(0, null), now).kind).toBe('none')
  })
})

// Fork parity tripwire: every telegram fork that adopts the banner MUST import a
// byte-identical banner.ts (same posture as tna-harness's four-way tna.ts check).
// This canonical pass ships base only; fork propagation is the split follow-up
// (grok base → generator regen codex/agy → hand-edit pi/opencode). The test is
// present-only so it's green now AND arms automatically as each fork adopts it —
// the moment a fork ships a drifted banner.ts, this fails.
describe('fork parity', () => {
  const FORKS = ['telegram-grok', 'telegram-codex', 'telegram-agy', 'telegram-pi', 'telegram-opencode'] as const
  const dir = (p: string) => join(import.meta.dir, '..', 'plugins', p, 'banner.ts')
  const base = readFileSync(dir('telegram'), 'utf8')
  const adopted = FORKS.filter(f => existsSync(dir(f)))
  for (const f of adopted) {
    test(`${f}/banner.ts is byte-identical to base`, () => {
      expect(readFileSync(dir(f), 'utf8')).toBe(base)
    })
  }
  test('base banner.ts is non-empty (parity anchor)', () => {
    expect(base.length).toBeGreaterThan(0)
  })
})

// DIVE-1568: the banner must pin on exactly ONE agent — the resolved org
// coordinator — or the founder gets the same open-gate reminder pinned across
// every paired agent's DM (base + forks). The gate lives at the reconcile call
// in each server.ts (banner.ts stays pure), so it can't live in banner.ts's
// byte-identity check above. This tripwire asserts every server.ts that arms the
// banner still carries the coordinator gate, so a fork can never silently drop
// it and re-spam the founder.
describe('DIVE-1568 coordinator gate', () => {
  const SERVERS = [
    'telegram', 'telegram-grok', 'telegram-codex', 'telegram-agy',
    'telegram-pi', 'telegram-opencode',
  ] as const
  const srv = (p: string) => join(import.meta.dir, '..', 'plugins', p, 'server.ts')
  for (const p of SERVERS) {
    test(`${p}/server.ts gates the banner on the resolved coordinator`, () => {
      const src = readFileSync(srv(p), 'utf8')
      // resolves the coordinator, compares it to this agent, and never pins when
      // it isn't the coordinator (empty summary → unpin any stale banner).
      expect(src).toContain('read5diveCoordinator')
      expect(src).toContain('iAmCoordinator')
      expect(src).toMatch(/task['"],\s*['"]coordinator/)
    })
  }
})
