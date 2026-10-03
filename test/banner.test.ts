// DIVE-1503: pinned self-updating "needs-you" banner — pure decision logic.
//
// server.ts long-polls on import, so (like tna.ts) the banner state machine
// lives in an import-safe module we can drive headlessly here: no bot boot, no
// Telegram, no live board. We assert the full lifecycle (pin → edit → unpin) and
// that every fork ships a byte-identical banner.ts so a fork can never drift.

import { describe, test, expect } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeNeeds,
  humanizeAge,
  parseGateTs,
  formatNeedsBanner,
  bannerFingerprint,
  reconcileBanner,
  BANNER_CLEAR_TEXT,
  BANNER_RETIRED_TEXT,
  NEEDS_BANNER_EVERY_MS,
  needsBannerEnabled,
  armNeedsBanner,
  retireBannerStore,
  type BannerState,
  type BannerTimers,
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

  // DIVE-2041. The filter keyed on need_answer — the answer TEXT — while the CLI
  // and the dashboard both key on need_answered_at. An answered SECRET gate keeps
  // need_answer NULL BY DESIGN (the value is the secret; it is never written to
  // the row), so this is not a hypothetical column preference: it is a whole gate
  // type that reads as pending forever to the old predicate.
  //
  // The bug is invisible through the ONE current caller, which feeds this
  // `task inbox --json` — SQL that already excludes answered rows, so the list
  // never contains the row that would expose it. That is exactly the shape worth
  // a test: the module's correctness rested on a query two processes away, and
  // this arm feeds it the unfiltered list a future caller would.
  test('an ANSWERED SECRET gate (need_answered_at set, need_answer NULL) is not pending', () => {
    const s = summarizeNeeds([
      gate({ created_at: '2026-07-20 09:00:00' }), // live
      gate({
        need_type: 'secret',
        need_answer: null, // ← by design for a secret; the old filter saw "unanswered"
        need_answered_at: '2026-07-20 08:30:00',
        created_at: '2026-07-20 06:00:00', // older, so a wrong count ALSO moves the oldest
      }),
    ])
    expect(s.count).toBe(1)
    expect(s.oldestCreatedAt).toBe('2026-07-20 09:00:00')
  })

  test('need_answered_at excludes a row for every gate type, not just secret', () => {
    for (const need_type of ['decision', 'approval', 'manual', 'secret']) {
      const s = summarizeNeeds([gate({ need_type, need_answer: null, need_answered_at: '2026-07-20 08:30:00' })])
      expect({ need_type, ...s }).toEqual({ need_type, count: 0, oldestCreatedAt: null })
    }
  })

  // The disjunction can only ever exclude MORE, never fewer: withdraw NULLs
  // need_answer/at/by together (tna.ts), so keeping need_answer costs nothing and
  // guards a payload that carries the text without the timestamp.
  test('need_answer alone still excludes (belt-and-braces half kept)', () => {
    expect(summarizeNeeds([gate({ need_answer: 'yes', need_answered_at: null })]).count).toBe(0)
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

// DIVE-5447 (lodar, 2026-10-03: "disable inbox pinning, it feels too noisy"):
// the banner is off unless a seat opts in with TELEGRAM_NEEDS_BANNER=1, and off
// must also take down the pins already sitting in every DM, once.
describe('DIVE-5447 banner off by default', () => {
  const fakeTimers = () => {
    const timeouts: Array<{ fn: () => void; ms: number }> = []
    const intervals: Array<{ fn: () => void; ms: number }> = []
    const t: BannerTimers = {
      setTimeout: (fn, ms) => (timeouts.push({ fn, ms }), { unref() {} }),
      setInterval: (fn, ms) => (intervals.push({ fn, ms }), { unref() {} }),
    }
    return { t, timeouts, intervals }
  }
  const calls = () => {
    const c = { reconcile: 0, retire: 0 }
    return { c, run: { reconcile: async () => void c.reconcile++, retire: async () => void c.retire++ } }
  }

  test('only the exact value 1 opts in', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(needsBannerEnabled({ TELEGRAM_NEEDS_BANNER: v })).toBe(false)
    }
    expect(needsBannerEnabled({})).toBe(false)
    expect(needsBannerEnabled({ TELEGRAM_NEEDS_BANNER: '1' })).toBe(true)
  })

  test('env unset: no interval is armed and the one deferred tick retires, never reconciles', () => {
    const { t, timeouts, intervals } = fakeTimers()
    const { c, run } = calls()
    expect(armNeedsBanner({}, run, t)).toBe('retiring')
    expect(intervals.length).toBe(0)
    expect(timeouts.length).toBe(1)
    timeouts[0].fn()
    expect(c).toEqual({ reconcile: 0, retire: 1 })
  })

  test('opted in: the DIVE-1503 cadence comes back unchanged (3s first tick, then 60s)', () => {
    const { t, timeouts, intervals } = fakeTimers()
    const { c, run } = calls()
    expect(armNeedsBanner({ TELEGRAM_NEEDS_BANNER: '1' }, run, t)).toBe('armed')
    expect(timeouts.map(x => x.ms)).toEqual([3000])
    expect(intervals.map(x => x.ms)).toEqual([60_000])
    expect(NEEDS_BANNER_EVERY_MS).toBe(60_000)
    timeouts[0].fn()
    intervals[0].fn()
    expect(c).toEqual({ reconcile: 2, retire: 0 })
  })

  // The server glue is read -> retireBannerStore -> write (retireNeedsBanners in
  // each server.ts, asserted below); this drives the same three steps against a
  // real seeded needs-banner.json.
  test('a seeded needs-banner.json is unpinned and emptied once; the next boot does nothing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dive5447-')), 'needs-banner.json')
    writeFileSync(file, JSON.stringify({ '111': { messageId: 7, fingerprint: '2|x|3h' }, '222': { messageId: 9, fingerprint: '1|y|1d' } }))
    const log: string[] = []
    const api = {
      unpinChatMessage: async (chat: string, id: number) => void log.push(`unpin ${chat} ${id}`),
      editMessageText: async (chat: string, id: number, text: string) => void log.push(`edit ${chat} ${id} ${text}`),
    }
    const boot = async () => {
      const store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, BannerState>
      if (Object.keys(store).length === 0) return
      writeFileSync(file, JSON.stringify(await retireBannerStore(store, api)))
    }
    await boot()
    expect(log).toEqual([
      'unpin 111 7', `edit 111 7 ${BANNER_RETIRED_TEXT}`,
      'unpin 222 9', `edit 222 9 ${BANNER_RETIRED_TEXT}`,
    ])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
    await boot()
    expect(log.length).toBe(4)
  })

  test('a pin that is already gone is forgotten; a transient failure is kept for the next boot', async () => {
    const errs: Record<string, unknown> = {
      gone: { description: 'Bad Request: message to unpin not found' },
      blip: new Error('fetch failed: ECONNRESET'),
    }
    const edited: string[] = []
    const api = {
      unpinChatMessage: async (chat: string) => { if (errs[chat]) throw errs[chat] },
      editMessageText: async (chat: string) => { edited.push(chat); throw new Error('message is not modified') },
    }
    const left = await retireBannerStore({
      ok: { messageId: 1, fingerprint: 'a' },
      gone: { messageId: 2, fingerprint: 'b' },
      blip: { messageId: 3, fingerprint: 'c' },
    }, api)
    expect(left).toEqual({ blip: { messageId: 3, fingerprint: 'c' } })
    expect(edited).toEqual(['ok']) // a relabel failure never throws out of the retire
  })

  test('the retired label is not the "all caught up" claim', () => {
    expect(BANNER_RETIRED_TEXT).not.toBe(BANNER_CLEAR_TEXT)
    expect(BANNER_RETIRED_TEXT).not.toContain('caught up')
    expect(BANNER_RETIRED_TEXT).not.toContain('\u2014') // no em-dashes in user copy
  })

  const SERVERS = [
    'telegram', 'telegram-grok', 'telegram-codex', 'telegram-agy',
    'telegram-pi', 'telegram-opencode',
  ] as const
  const srv = (p: string) => join(import.meta.dir, '..', 'plugins', p, 'server.ts')
  for (const p of SERVERS) {
    test(`${p}/server.ts arms the banner only through the switch and retires through the store`, () => {
      const src = readFileSync(srv(p), 'utf8')
      expect(src).toContain('armNeedsBanner(process.env, { reconcile: reconcileNeedsBanner, retire: retireNeedsBanners })')
      expect(src).toContain('writeBannerStore(await retireBannerStore(store, bot.api))')
      // no raw timer left that would tick the reconcile with the switch off
      expect(src).not.toMatch(/set(Interval|Timeout)\(\(\) => void reconcileNeedsBanner\(\)/)
      // hazard-liveness: the reconcile it gates still exists in this fork
      expect(src).toContain('async function reconcileNeedsBanner(')
    })
  }
})
