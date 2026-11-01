// DIVE-7478: the box greets the owner the moment the bot is connected, before any
// bridge polls (`5dive agent _tg_connect_greet`, CLI), and records the chats it
// greeted in connect-greeted.json. lodar, 2026-11-01: /start, "hey" x3, ~40 s of
// silence, then the greeting. Now the greeting comes at connect, so the bridge
// that boots later must not say hello again: one greeting per chat.
//
// The claude plugin: connectGreetedChats + the `held` arm of makeGreetClaims,
// replayed like DIVE-5411's queued /starts. The forks (grok base, agy generated
// from it, codex, opencode, pi): their /start reply skips a chat the box greeted;
// each fork's own helper is transpiled out of its server.ts and run.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeGreetClaims, connectGreetedChats, bootGreetTargets, CONNECT_GREET_HOLD_MS, CONNECT_GREETED_FILE } from '../plugins/telegram/bootgreet.ts'

const OWNER = '1234567890'
const BOT = '7000000001'
const NOW = 1_800_000_000_000
const marker = (o: Record<string, unknown>) => JSON.stringify({ botId: BOT, at: NOW - 30_000, chats: [OWNER], ...o })

describe('connectGreetedChats: which chats the box already greeted', () => {
  test('this bot, inside the hold: the chats', () => {
    expect(connectGreetedChats(marker({}), BOT, NOW)).toEqual([OWNER])
  })
  test('another bot (a rotated token) holds nothing', () => {
    expect(connectGreetedChats(marker({ botId: '7000000002' }), BOT, NOW)).toEqual([])
  })
  test('past the hold, a /start greets as before', () => {
    expect(connectGreetedChats(marker({ at: NOW - CONNECT_GREET_HOLD_MS }), BOT, NOW)).toEqual([])
    expect(connectGreetedChats(marker({ at: NOW - CONNECT_GREET_HOLD_MS + 1 }), BOT, NOW)).toEqual([OWNER])
  })
  test('no file, no token, garbage, a future stamp, non-private ids: nothing', () => {
    expect(connectGreetedChats(null, BOT, NOW)).toEqual([])
    expect(connectGreetedChats(marker({}), null, NOW)).toEqual([])
    expect(connectGreetedChats('{not json', BOT, NOW)).toEqual([])
    expect(connectGreetedChats(marker({ at: NOW + 3_600_000 }), BOT, NOW)).toEqual([])
    expect(connectGreetedChats(marker({ chats: [OWNER, '-100123', 'x', 42] }), BOT, NOW)).toEqual([OWNER, '42'])
  })
})

describe('the claude plugin: one greeting per chat across the box and the bridge', () => {
  // The box greeted OWNER at connect; the bridge boots with `queued` /starts from
  // the owner, then runs its boot greeting. Returns the bridge's greetings.
  function bridgeGreets(queued: number, held: boolean): number {
    const raw = marker({})
    const claims = makeGreetClaims(() => NOW, undefined, held ? c => connectGreetedChats(raw, BOT, NOW).includes(c) : undefined)
    const plan = bootGreetTargets({ botId: BOT, marker: null, heardHuman: false, wiredRecently: true, owners: [OWNER], allowFrom: [OWNER] }).greet
    let sent = 0
    for (let i = 0; i < queued; i++) if (claims.claim(OWNER)) sent++
    for (const o of plan) if (claims.claim(o)) sent++
    return sent
  }
  test('box greeted + /start + "hey" queued + boot greeting: the bridge adds none (without the hold: one more)', () => {
    expect(bridgeGreets(1, true)).toBe(0)
    expect(bridgeGreets(1, false)).toBe(1)
  })
  test('the hold covers only the chats the box greeted', () => {
    const claims = makeGreetClaims(() => NOW, undefined, c => connectGreetedChats(marker({}), BOT, NOW).includes(c))
    expect(claims.claim(OWNER)).toBe(false)
    expect(claims.claim('555')).toBe(true)
  })
  test('server.ts reads connect-greeted.json in the claims every greeting goes through', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
    const decl = /const greetClaims = makeGreetClaims\(Date\.now, GREET_WINDOW_MS, chat => \{[\s\S]*?CONNECT_GREETED_FILE[\s\S]*?connectGreetedChats\(raw, botIdOf\(TOKEN\), Date\.now\(\)\)\.includes\(chat\)/
    expect(server).toMatch(decl)
    expect(server.match(/makeGreetClaims\(/g)?.length).toBe(1)
    expect(CONNECT_GREETED_FILE).toBe('connect-greeted.json')
  })
})

const FORKS = ['telegram-grok', 'telegram-agy', 'telegram-codex', 'telegram-opencode', 'telegram-pi']

/** The fork's own connectGreeted, transpiled out of its server.ts, over `dir` and `token`. */
function forkHelper(fork: string, dir: string, token: string): (chat: string) => boolean {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
  const m = /const CONNECT_GREETED_FILE = [\s\S]*?\n\}\n/.exec(src)
  if (!m) throw new Error(`${fork}: no connectGreeted helper`)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(m[0] + '\nexport {}')
    .replace(/export\s*\{\s*\};?/, '')
  // eslint-disable-next-line no-new-func
  return new Function('join', 'readFileSync', 'STATE_DIR', 'TOKEN', `${js}\nreturn connectGreeted`)(join, readFileSync, dir, token)
}

describe('the forks: /start is not answered again for a chat the box greeted', () => {
  for (const fork of FORKS) {
    test(`${fork}: the helper reads this bot's marker, and /start checks it first`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'dive7478-'))
      const has = forkHelper(fork, dir, `${BOT}:AAH-secret`)
      expect(has(OWNER)).toBe(false) // no file yet
      writeFileSync(join(dir, CONNECT_GREETED_FILE), JSON.stringify({ botId: BOT, at: Date.now() - 5_000, chats: [OWNER] }))
      expect(has(OWNER)).toBe(true)
      expect(has('555')).toBe(false)
      expect(forkHelper(fork, dir, '7000000002:AAH-other')(OWNER)).toBe(false) // a rotated token
      writeFileSync(join(dir, CONNECT_GREETED_FILE), JSON.stringify({ botId: BOT, at: Date.now() - CONNECT_GREET_HOLD_MS - 1, chats: [OWNER] }))
      expect(has(OWNER)).toBe(false) // stale
      const src = readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
      expect(src).toMatch(/case 'start':\n\s*\/\/ DIVE-7478[^\n]*\n\s*if \(connectGreeted\(chat_id\)\) return true\n/)
    })
  }
})
