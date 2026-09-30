// DIVE-5298: a bare /start on a my.5dive agent's bot answers AT ONCE, with no
// model turn, on the lite profile AND on the default one (builder seats).
//
// Before: lite sent the pack's welcome (DIVE-5173), but no 5dive-marketplace
// pack had one, so /start went to the model — and a box with no AI account
// never answers it (lodar, 2026-09-30: Dude silent after /start). The default
// profile answered a paired owner with the stock "To pair: DM me anything".
// Now: the pack's welcome, else a greeting from the persona's (or bot's) name
// and the bot's short description (5dive-api sets it from the catalogue
// tagline, DIVE-5296).
// server.ts long-polls Telegram on import, so it is read as TEXT here.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liteGreeting, personaName, startGreeting } from '../plugins/telegram/hooks/lib/lite.ts'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

const dirs: string[] = []
function box(persona?: string): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), 'dive5298-'))
  dirs.push(d)
  mkdirSync(join(d, 'claude'))
  if (persona !== undefined) writeFileSync(join(d, 'claude', 'persona.yaml'), persona)
  return { CLAUDE_CONFIG_DIR: join(d, 'claude'), TELEGRAM_STATE_DIR: join(d, 'state') }
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const TAGLINE = 'answers your community, sorts real bugs from noise, keeps it calm.'

describe('the greeting', () => {
  test('name + a verb-phrase tagline reads as one sentence, then the ask', () => {
    expect(liteGreeting('en', 'Dude', TAGLINE)).toBe(
      "Hi, I'm Dude.\nDude answers your community, sorts real bugs from noise, keeps it calm.\n\nTell me what you need, and I will get on it.",
    )
  })
  test('a full-sentence description stands on its own, and gets its full stop', () => {
    expect(liteGreeting('en', 'Maya', 'Your executive assistant')).toBe(
      "Hi, I'm Maya.\nYour executive assistant.\n\nTell me what you need, and I will get on it.",
    )
  })
  test('no description, no name: still a greeting, never empty', () => {
    expect(liteGreeting('en', 'Dude', '')).toBe("Hi, I'm Dude.\n\nTell me what you need, and I will get on it.")
    expect(liteGreeting('en', null, null)).toBe('Hi!\n\nTell me what you need, and I will get on it.')
    expect(liteGreeting('ru', '  ', undefined)).toBe('Здравствуйте!\n\nНапишите, что нужно сделать, и я возьмусь.')
  })
  test('Russian frame', () => {
    expect(liteGreeting('ru', 'Dude', 'Отвечает сообществу')).toBe(
      'Здравствуйте, я Dude.\nОтвечает сообществу.\n\nНапишите, что нужно сделать, и я возьмусь.',
    )
  })
})

describe('startGreeting: the pack welcome, else the greeting', () => {
  test("the pack's welcome wins", () => {
    const env = box('name: "Maya"\next:\n  5dive:\n    welcome:\n      en: "Hi, I am Maya. Try: what is on today?"\n')
    expect(startGreeting('en', { name: 'MayaBot', about: TAGLINE }, env)).toBe('Hi, I am Maya. Try: what is on today?')
  })
  test("no welcome: the persona's name over the bot's, plus the bot's description", () => {
    const env = box('openagent: "0.2"\nid: dude\nname: "Dude"\n')
    expect(personaName(env)).toBe('Dude')
    expect(startGreeting('en', { name: 'dude_e96a', about: TAGLINE }, env)).toStartWith("Hi, I'm Dude.\nDude answers your community")
  })
  test('no persona at all: the bot name, never null', () => {
    const env = box()
    expect(personaName(env)).toBeNull()
    expect(startGreeting('en', { name: 'Dude', about: '' }, env)).toBe("Hi, I'm Dude.\n\nTell me what you need, and I will get on it.")
  })
})

/** The lite /start arm greets through startGreetingFor (welcome OR greeting). */
function liteStartGreets(src: string): boolean {
  const body = src.slice(src.indexOf('async function liteCommand('))
  const arm = body.slice(body.indexOf("if (cmd === 'start')"), body.indexOf("if (cmd === 'usage')"))
  return /const welcome = await startGreetingFor\(ctx, lang\)/.test(arm) && arm.includes('ctx.reply(welcome)')
}
/** The default /start greets a paired owner before (and instead of) the pairing text. */
function defaultStartGreets(src: string): boolean {
  const start = src.indexOf('  start: async (ctx, { access, senderId }) => {')
  if (start < 0) return false
  const arm = src.slice(start, src.indexOf('\n  help:', start))
  const owner = arm.indexOf('if (access.allowFrom.includes(senderId)) {')
  const greet = arm.indexOf('await ctx.reply(await startGreetingFor(ctx, liteLang(ctx.from?.language_code)))')
  const ret = arm.indexOf('return', greet)
  const pairing = arm.indexOf('To pair:')
  return owner > -1 && greet > owner && ret > greet && pairing > ret
}

describe('server.ts', () => {
  test('lite /start: welcome or greeting, sent at once', () => expect(liteStartGreets(SERVER)).toBe(true))
  test('default /start: the paired owner is greeted; others still get pairing', () => expect(defaultStartGreets(SERVER)).toBe(true))
  test('negative control: the checks go red on the pre-fix shapes', () => {
    const liteWelcomeOnly = SERVER.replace('const welcome = await startGreetingFor(ctx, lang)', 'const welcome = liteWelcome(lang)')
    const noOwnerArm = SERVER.replace('if (access.allowFrom.includes(senderId)) {', 'if (false) {')
    const greetAfterPairing = SERVER.replace('  start: async (ctx, { access, senderId }) => {', '  start: async ctx => {')
    expect(liteStartGreets(liteWelcomeOnly)).toBe(false)
    expect(defaultStartGreets(noOwnerArm)).toBe(false)
    expect(defaultStartGreets(greetAfterPairing)).toBe(false)
  })
})
