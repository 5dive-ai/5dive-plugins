// DIVE-5411: a freshly wired agent bot greets its owner once, with no /start.
//
// Measured 2026-10-02 (row body, from the boxes): the manager bot says "@bot is
// ready, <Name> greets you in a moment" at bot creation, but the seat's poller
// comes up ~10 s later (13:53:41 → 13:53:51 on divine-owl). The plugin greeted
// only in reply to /start, so the owner tapped Start twice and the poller then
// answered BOTH queued /starts within 100 ms (msglog: two "Hi, I'm Olivia").
// The arms below replay that sequence against the decision functions, and check
// server.ts (read as TEXT: it long-polls Telegram on import) wires them in.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeGreetClaims, botIdOf, bootGreetTargets, GREET_WINDOW_MS, BOOT_GREET_DELAY_MS } from '../plugins/telegram/bootgreet.ts'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const OWNER = '1234567890'

/**
 * The divine-owl sequence: the poller boots with `queued` /starts from the owner
 * in its first getUpdates batch, then the boot greeting runs. `claims` null is the
 * pre-fix plugin (every /start greets, no boot greeting). Returns greetings sent.
 */
function replayBoot(queued: number, claims: ReturnType<typeof makeGreetClaims> | null, plan: string[]): number {
  let sent = 0
  for (let i = 0; i < queued; i++) if (!claims || claims.claim(OWNER)) sent++
  if (claims) for (const owner of plan) if (claims.claim(owner)) sent++
  return sent
}
const fresh = () => bootGreetTargets({ botId: '8123', marker: null, heardHuman: false, wiredRecently: true, owners: [OWNER], allowFrom: [OWNER] }).greet

describe('the owner gets exactly one greeting when the bot goes live', () => {
  test('two /starts queued during wiring: one greeting (pre-fix: two)', () => {
    expect(replayBoot(2, makeGreetClaims(), fresh())).toBe(1)
    expect(replayBoot(2, null, [])).toBe(2)
  })
  test('no /start at all: the boot greeting still arrives (pre-fix: none)', () => {
    expect(replayBoot(0, makeGreetClaims(), fresh())).toBe(1)
    expect(replayBoot(0, null, [])).toBe(0)
  })
  test('a failed send releases the chat, so the next /start greets', () => {
    const c = makeGreetClaims()
    expect(c.claim(OWNER)).toBe(true)
    c.release(OWNER)
    expect(c.claim(OWNER)).toBe(true)
  })
  test('the window is per chat and expires', () => {
    let t = 0
    const c = makeGreetClaims(() => t)
    expect(c.claim(OWNER)).toBe(true)
    expect(c.claim('42')).toBe(true)
    t = GREET_WINDOW_MS - 1
    expect(c.claim(OWNER)).toBe(false)
    t = GREET_WINDOW_MS
    expect(c.claim(OWNER)).toBe(true)
  })
})

describe('who is greeted on boot', () => {
  test('a just-wired bot greets its allowlisted owners, private ids only', () => {
    expect(bootGreetTargets({ botId: '8123', marker: null, heardHuman: false, wiredRecently: true, owners: [OWNER, '-100555', '77'], allowFrom: [OWNER, '-100555'] }))
      .toEqual({ greet: [OWNER], record: true })
  })
  test('no owners record: the allowlist stands in', () => {
    expect(bootGreetTargets({ botId: '8123', marker: null, heardHuman: false, wiredRecently: true, owners: undefined, allowFrom: [OWNER] }).greet).toEqual([OWNER])
  })
  test('the same bot again (any restart): nothing', () => {
    expect(bootGreetTargets({ botId: '8123', marker: '8123', heardHuman: false, wiredRecently: true, owners: [OWNER], allowFrom: [OWNER] }))
      .toEqual({ greet: [], record: false })
  })
  test('a seat that already heard a human (token rotation, plugin upgrade): record, greet nobody', () => {
    expect(bootGreetTargets({ botId: '8123', marker: null, heardHuman: true, wiredRecently: true, owners: [OWNER], allowFrom: [OWNER] }))
      .toEqual({ greet: [], record: true })
    expect(bootGreetTargets({ botId: '9999', marker: '8123', heardHuman: true, wiredRecently: true, owners: [OWNER], allowFrom: [OWNER] }))
      .toEqual({ greet: [], record: true })
  })
  test('a token not written just now (the plugin upgrade itself, any old seat): record, greet nobody', () => {
    expect(bootGreetTargets({ botId: '8123', marker: null, heardHuman: false, wiredRecently: false, owners: [OWNER], allowFrom: [OWNER] }))
      .toEqual({ greet: [], record: true })
  })
  test('the bot id is the part before the colon, never the secret', () => {
    expect(botIdOf('8123456:AAH-secret')).toBe('8123456')
    expect(botIdOf(undefined)).toBeNull()
    expect(botIdOf('garbage')).toBeNull()
  })
})

/** Both /start arms take a claim before greeting, and give it back on a failed send. */
function startArmsClaim(src: string): boolean {
  const lite = src.slice(src.indexOf('async function liteCommand('))
  const liteArm = lite.slice(lite.indexOf("if (cmd === 'start')"), lite.indexOf("if (cmd === 'usage')"))
  const def = src.slice(src.indexOf('  start: async (ctx, { access, senderId }) => {'))
  const defArm = def.slice(0, def.indexOf('\n  help:'))
  const liteOk = liteArm.indexOf('greetClaims.claim(chatId)') > -1
    && liteArm.indexOf('greetClaims.claim(chatId)') < liteArm.indexOf('ctx.reply(welcome)')
    && liteArm.includes('greetClaims.release(chatId)')
  const defOk = defArm.indexOf('greetClaims.claim(chat)') > -1
    && defArm.indexOf('greetClaims.claim(chat)') < defArm.indexOf('await ctx.reply(await startGreetingFor(')
    && defArm.includes('greetClaims.release(chat)')
  return liteOk && defOk
}
/** Polling start schedules bootGreet after the backlog delay, and bootGreet greets through the claims. */
function bootGreetWired(src: string): boolean {
  const onStart = src.slice(src.indexOf('onStart: info => {'), src.indexOf('return // bot.stop() was called'))
  const fn = src.slice(src.indexOf('async function bootGreet('), src.indexOf('async function liteCommand('))
  return /setTimeout\(\(\) => \{ void bootGreet\(\)[\s\S]*?BOOT_GREET_DELAY_MS\)/.test(onStart)
    && fn.includes('bootGreetTargets(') && /statSync\(ENV_FILE\)\.mtimeMs < WIRED_RECENTLY_MS/.test(fn) && fn.includes('greetClaims.claim(owner)')
    && fn.includes('bot.api.sendMessage(Number(owner), text)') && fn.includes('greetClaims.release(owner)')
}

describe('server.ts', () => {
  test('both /start arms share the per-chat claim', () => expect(startArmsClaim(SERVER)).toBe(true))
  test('polling start schedules the boot greeting after the backlog', () => {
    expect(bootGreetWired(SERVER)).toBe(true)
    expect(BOOT_GREET_DELAY_MS).toBeGreaterThan(0)
  })
  test('negative control: the checks go red on the pre-fix shapes', () => {
    const noClaim = SERVER.split('greetClaims.claim(').join('noop(')
    const noBoot = SERVER.replace(/setTimeout\(\(\) => \{ void bootGreet\(\)/, 'void (() => {')
    expect(startArmsClaim(noClaim)).toBe(false)
    expect(bootGreetWired(noBoot)).toBe(false)
  })
})
