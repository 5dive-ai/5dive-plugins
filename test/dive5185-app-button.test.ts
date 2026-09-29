// DIVE-5185: /app — an existing 5dive customer opens the my.5dive.ai Mini App
// from their own agent's bot, signed into their existing account.
//
//   1. ADDITIVE. The default registry gains exactly one entry (/app, paired-5dive,
//      last), and every other command keeps its place; a lite (partner) bot routes
//      /app to its own /help and never reaches the handler.
//   2. THE BUTTON. Only a well-formed t.me startapp=link_<43> URL becomes a button,
//      and it is a URL button, never web_app (which would sign initData with the
//      agent's bot token, which 5dive's sign-in refuses).
//   3. THE COPY. Every status the CLI can answer maps to a plain sentence; an
//      unreadable CLI says to wait for the nightly update.
//   4. THE WIRING. The handler asks the CLI for the SENDER's id (the paired chat),
//      not a chat id or a typed argument.
//
// server.ts long-polls Telegram on import, so it is read as TEXT here.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMAND_REGISTRY, botFatherCommands, renderHelpBody } from '../plugins/telegram/commands'
import { appReply, isMiniAppLink, APP_BUTTON_TEXT } from '../plugins/telegram/appbutton'
import { liteRoute } from '../plugins/telegram/hooks/lib/lite'

const TG = join(import.meta.dir, '..', 'plugins', 'telegram')
const SERVER = readFileSync(join(TG, 'server.ts'), 'utf8')
const CODE = 'a'.repeat(43)
const LINK = `https://t.me/FiveDiveBot?startapp=link_${CODE}`

describe('1. additive', () => {
  test('/app is one new paired-5dive entry, appended; the rest is untouched', () => {
    const app = COMMAND_REGISTRY.find(c => c.name === 'app')
    expect(app).toEqual(expect.objectContaining({ name: 'app', scope: 'paired-5dive', description: 'Open 5dive in Telegram' }))
    expect(COMMAND_REGISTRY.at(-1)?.name).toBe('app')
    expect(botFatherCommands(undefined, true).map(c => c.command)).toContain('app')
    expect(renderHelpBody(COMMAND_REGISTRY, true)).toContain('/app — Open 5dive in Telegram')
  })
  test('a non-5dive host neither lists nor advertises it', () => {
    expect(botFatherCommands(undefined, false).map(c => c.command)).not.toContain('app')
    expect(renderHelpBody(COMMAND_REGISTRY, false)).not.toContain('/app')
  })
  test('a lite (partner) bot answers /app with its own help, not this handler', () => {
    expect(liteRoute('/app')).toBe('help')
  })
  test('the handler is registered under the same key as the registry entry', () => {
    expect(SERVER).toMatch(/\n  app: async \(ctx, gate\) => \{/)
  })
})

describe('2. the button', () => {
  test('only a 5dive Mini App link_ deep link is accepted', () => {
    expect(isMiniAppLink(LINK)).toBe(true)
    for (const bad of [
      undefined, '', 'http://t.me/FiveDiveBot?startapp=link_' + CODE, 'https://evil.example.com/?startapp=link_' + CODE,
      'https://t.me/FiveDiveBot?startapp=ref_' + CODE, 'https://t.me/FiveDiveBot?startapp=link_short',
      `${LINK}&x=1`, 'javascript:alert(1)', 'tg://resolve?domain=FiveDiveBot',
    ]) expect(isMiniAppLink(bad)).toBe(false)
  })
  test('a ready answer carries the URL; the handler sends it as a URL button, never web_app', () => {
    expect(appReply({ ok: true, data: { status: 'ready', url: LINK } }).url).toBe(LINK)
    expect(SERVER).toContain('new InlineKeyboard().url(APP_BUTTON_TEXT, r.url)')
    const handler = SERVER.slice(SERVER.indexOf('\n  app: async (ctx, gate) => {'), SERVER.indexOf('\n  usage: async ctx => {'))
    expect(handler).not.toContain('webApp')
    expect(APP_BUTTON_TEXT).toBe('Open 5dive')
  })
  test('ready with a bad URL is not a button', () => {
    expect(appReply({ ok: true, data: { status: 'ready', url: 'https://evil.example.com/' } }).url).toBeUndefined()
  })
})

describe('3. the copy', () => {
  const cases: [unknown, RegExp][] = [
    [{ ok: true, data: { status: 'off', url: null } }, /turned off on this server/],
    [{ ok: true, data: { status: 'not_paired', url: null } }, /paired owner/],
    [{ ok: true, data: { status: 'partner_box', url: null } }, /provider/],
    [{ ok: true, data: { status: 'other_telegram', url: null } }, /different Telegram account/],
    [{ ok: true, data: { status: 'taken', url: null } }, /different 5dive account/],
    [{ ok: true, data: { status: 'unavailable', url: null } }, /isn't available on this server yet/],
    [{ ok: true, data: { status: 'error', url: null } }, /Try again in a minute/],
    [{ ok: false, error: { code: 10, message: 'needs root' } }, /Try again in a minute/],
    [null, /newer 5dive CLI/],
  ]
  for (const [j, want] of cases) {
    test(`${JSON.stringify(j)} -> ${want}`, () => {
      const r = appReply(j)
      expect(r.text).toMatch(want)
      expect(r.url).toBeUndefined()
    })
  }
})

describe('4. the wiring', () => {
  test("asks the CLI for the SENDER's Telegram id, with the link budget", () => {
    expect(SERVER).toContain("read5diveJson(['telegram-app', 'link', `--telegram-id=${gate.senderId}`, '--json'], APP_LINK_TIMEOUT_MS)")
  })
})
