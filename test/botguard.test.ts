// Bot-to-bot loop + rate guard unit tests (DIVE-162).
//
// The guard is the mandatory backend safety layer in front of any cross-box
// auto-reply path: it stops two auto-replying bots from ping-ponging forever and
// keeps a chatty mesh under Telegram's per-group rate ceiling. It's pure +
// dependency-free precisely so it can be exercised here without booting the
// long-polling server.

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  botGuardShouldDrop,
  _resetBotGuard,
  BOT_RATE_DEFAULT_PER_MIN,
} from '../plugins/telegram/botguard'

const CHAT = '-100123'
const BOT = 'sibling_bot'

beforeEach(() => _resetBotGuard())

describe('default-deny', () => {
  test('drops bot senders when config absent', () => {
    expect(botGuardShouldDrop(undefined, CHAT, BOT, 'hi', 1000)).toBe(true)
  })
  test('drops bot senders when explicitly disabled', () => {
    expect(botGuardShouldDrop({ enabled: false }, CHAT, BOT, 'hi', 1000)).toBe(true)
  })
  test('accepts the first message when enabled', () => {
    expect(botGuardShouldDrop({ enabled: true }, CHAT, BOT, 'hi', 1000)).toBe(false)
  })
})

describe('allowFrom whitelist', () => {
  const cfg = { enabled: true, allowFrom: ['@sibling_bot'] }
  test('accepts a whitelisted sender (@ on either side)', () => {
    expect(botGuardShouldDrop(cfg, CHAT, 'sibling_bot', 'x', 1000)).toBe(false)
  })
  test('drops a non-whitelisted sender', () => {
    expect(botGuardShouldDrop(cfg, CHAT, 'stranger_bot', 'x', 1000)).toBe(true)
  })
})

describe('dedupe', () => {
  test('drops an identical message inside the window', () => {
    const cfg = { enabled: true, dedupeWindowMs: 10_000 }
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'ping', 1000)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'ping', 5000)).toBe(true) // echo
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'ping', 12_000)).toBe(false) // window passed
  })
  test('different text is not deduped', () => {
    const cfg = { enabled: true }
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'a', 1000)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'b', 1001)).toBe(false)
  })
})

describe('per-group rate cap', () => {
  test('trips after maxPerMin distinct messages in one rolling minute', () => {
    const cfg = { enabled: true, maxPerMin: 3, dedupeWindowMs: 0 }
    // 3 accepted (distinct text so dedupe never fires), then capped.
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'm1', 1000)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'm2', 1100)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'm3', 1200)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'm4', 1300)).toBe(true) // capped
  })

  test('window slides — old entries expire after 60s', () => {
    const cfg = { enabled: true, maxPerMin: 2, dedupeWindowMs: 0 }
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'a', 0)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'b', 1000)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'c', 2000)).toBe(true) // capped
    // 61s after the first two, the window has drained — accept again.
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'd', 62_000)).toBe(false)
  })

  test('rate cap is per-chat, not global', () => {
    const cfg = { enabled: true, maxPerMin: 1, dedupeWindowMs: 0 }
    expect(botGuardShouldDrop(cfg, 'chatA', BOT, 'x', 1000)).toBe(false)
    expect(botGuardShouldDrop(cfg, 'chatA', BOT, 'y', 1100)).toBe(true) // A capped
    expect(botGuardShouldDrop(cfg, 'chatB', BOT, 'z', 1200)).toBe(false) // B independent
  })

  test('a dropped (capped) message does not consume window budget', () => {
    const cfg = { enabled: true, maxPerMin: 2, dedupeWindowMs: 0 }
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'a', 1000)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'b', 1100)).toBe(false)
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'c', 1200)).toBe(true) // dropped, not recorded
    // 61s after 'a' (not after 'c'): 'a' expired, 'b' still in window → 1 slot free.
    expect(botGuardShouldDrop(cfg, CHAT, BOT, 'd', 61_050)).toBe(false)
  })
})

describe('ping-pong simulation', () => {
  test('a runaway echo loop is shut off within the cap', () => {
    const cfg = { enabled: true } // defaults: dedupe 60s, 12/min
    let accepted = 0
    // Two bots echoing the SAME text — dedupe alone kills it after the first.
    for (let i = 0; i < 100; i++) {
      if (!botGuardShouldDrop(cfg, CHAT, BOT, 'loop!', 1000 + i * 10)) accepted++
    }
    expect(accepted).toBe(1)
  })

  test('counter-appending loop is bounded by the rate cap', () => {
    const cfg = { enabled: true } // 12/min default
    let accepted = 0
    // Each round mutates the text (defeats dedupe) but the rate cap holds.
    for (let i = 0; i < 100; i++) {
      if (!botGuardShouldDrop(cfg, CHAT, BOT, `round ${i}`, 1000 + i * 100)) accepted++
    }
    expect(accepted).toBe(BOT_RATE_DEFAULT_PER_MIN)
  })
})
