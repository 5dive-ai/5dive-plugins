// DIVE-8513: on the default profile the three group-join lines (the hello, the
// waiting line, the Group Privacy hint) follow the adder's Telegram language,
// in every language the 5dive app ships, as lite's already did. An unknown or
// missing language_code still gets English.
//
// server.ts long-polls Telegram on import, so it is read as TEXT; groupjoin.ts
// is pure and imported.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupJoinLines, joinLang, JOIN_LANGS, JOIN_STRINGS, type JoinInput } from '../plugins/telegram/groupjoin'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const CYRILLIC = /[а-яё]/i

const base: JoinInput = {
  lite: false,
  lang: 'en',
  name: 'Olivia',
  username: 'olivia_x1_bot',
  title: 'Family',
  chatId: '-100123',
  approved: false,
  announce: false,
  privacyOn: false,
  fivedive: true,
}

describe('a Russian-language owner adds the agent on a regular box', () => {
  const ru = { ...base, lang: 'ru' as const, code: 'ru' }

  test('approved (the owner added it): the hello is Russian, with the wave', () => {
    expect(groupJoinLines({ ...ru, approved: true })).toEqual(['👋 Привет, я Olivia. Позовите меня по имени, когда понадоблюсь.'])
  })

  test("waiting (someone else's group): Russian, keeps the group id and the app's menu names in Russian", () => {
    const [line] = groupJoinLines({ ...ru, announce: true })
    expect(line).toBe(
      '👋 Привет! Меня добавили в «Family» — id группы: -100123. ' +
        'Я буду молчать, пока владелец не одобрит эту группу в приложении 5dive (настройки агента → «Кто может писать агенту Olivia»).',
    )
    expect(line).not.toMatch(/I'll stay quiet|Who can talk to/)
  })

  test('waiting off 5dive (the OSS fork): Russian, still points at /telegram:access', () => {
    const [line] = groupJoinLines({ ...ru, announce: true, fivedive: false })
    expect(line).toMatch(CYRILLIC)
    expect(line).toContain('/telegram:access')
    expect(line).toContain('-100123')
  })

  test('privacy on, not admin: the hint is Russian, keeps the warning sign and the @BotFather path', () => {
    const lines = groupJoinLines({ ...ru, approved: true, privacyOn: true })
    expect(lines).toEqual([
      '👋 Привет, я Olivia. Чтобы задать вопрос, ответьте на одно из моих сообщений.',
      '⚠️ Важно: Telegram передаёт мне здесь только ответы на мои сообщения, а не упоминания. ' +
        'Чтобы я отвечал на упоминания, сделайте меня администратором группы. ' +
        '(Или выключите Group Privacy в @BotFather → Bot Settings, затем удалите меня из группы и добавьте снова.)',
    ])
  })

  test('a language code with a country suffix reads the same', () => {
    expect(joinLang('ru-RU')).toBe('ru')
    expect(joinLang('RU')).toBe('ru')
  })
})

describe('an unknown or missing language still gets English', () => {
  const english = {
    hello: "👋 Hi, I'm Olivia. Call me by name when you need me.",
    waiting:
      '👋 Hi! I\'ve been added to "Family" — group id: -100123. ' +
      "I'll stay quiet until my owner approves this group in the 5dive app (the agent's settings → Who can talk to).",
    privacy:
      "⚠️ Heads-up: Telegram only passes me replies to my own messages here, not mentions. " +
      'To answer when someone mentions me, make me an admin of this group. ' +
      '(Or turn Group Privacy off in @BotFather → Bot Settings, then remove me and add me back.)',
  }
  for (const code of ['xx', 'uk', 'it', '', null, undefined]) {
    test(`language_code ${JSON.stringify(code)}: all three lines are the English ones, unchanged`, () => {
      expect(groupJoinLines({ ...base, code, approved: true })).toEqual([english.hello])
      expect(groupJoinLines({ ...base, code, announce: true })).toEqual([english.waiting])
      expect(groupJoinLines({ ...base, code, approved: true, privacyOn: true })[1]).toBe(english.privacy)
    })
  }
})

describe('every language the app ships', () => {
  test('the list matches the app: en ru zh tr es ar pt de fr ja ko', () => {
    expect([...JOIN_LANGS]).toEqual(['en', 'ru', 'zh', 'tr', 'es', 'ar', 'pt', 'de', 'fr', 'ja', 'ko'])
  })
  test("Telegram's longer language codes map to the base language", () => {
    expect(joinLang('pt-br')).toBe('pt')
    expect(joinLang('zh-hans')).toBe('zh')
    expect(joinLang('de_AT')).toBe('de')
  })
  for (const lang of JOIN_LANGS) {
    test(`${lang}: three lines, each with the emoji, the id, and no English left over`, () => {
      const code = lang
      const hello = groupJoinLines({ ...base, code, approved: true })
      const [waiting] = groupJoinLines({ ...base, code, announce: true })
      const privacy = groupJoinLines({ ...base, code, approved: true, privacyOn: true })
      expect(hello).toHaveLength(1)
      expect(hello[0]).toStartWith('👋 ')
      expect(hello[0]).toContain('Olivia')
      expect(waiting).toStartWith('👋 ')
      expect(waiting).toContain('-100123')
      expect(waiting).toContain('Family')
      expect(waiting).toContain('5dive')
      expect(privacy).toHaveLength(2)
      expect(privacy[1]).toStartWith('⚠️ ')
      expect(privacy[1]).toContain('@BotFather')
      expect(privacy[1]).toContain('Group Privacy')
      if (lang !== 'en') {
        for (const line of [hello[0], waiting, privacy[0], privacy[1]])
          expect(line).not.toMatch(/Hi, I'm|I'll stay quiet|Heads-up|Who can talk to|remove me and add me back/)
        // The app's own name for the access sheet, with the agent's name in it.
        expect(waiting).toContain('Olivia')
      }
    })
    test(`${lang}: privacy on never promises that being called by name works (DIVE-5454)`, () => {
      for (const everyMessage of [true, false]) {
        const [line] = groupJoinLines({ ...base, code: lang, approved: true, privacyOn: true, everyMessage })
        expect(line).toBe(`👋 ${JOIN_STRINGS[lang].hello('Olivia', true)}`)
      }
    })
    test(`${lang}: the four hellos differ (reply-only, owner-only, every message, by name)`, () => {
      const h = JOIN_STRINGS[lang].hello
      expect(new Set([h('O', true), h('O', false, false, true), h('O', false, true), h('O')]).size).toBe(4)
    })
  }
})

describe('lite is untouched', () => {
  test('a lite line never takes the default profile wording, whatever the code', () => {
    expect(groupJoinLines({ ...base, lite: true, lang: 'en', code: 'de', approved: true })).toEqual(["Hi, I'm Olivia. Call me by name when you need me."])
    expect(groupJoinLines({ ...base, lite: true, lang: 'ru', code: 'ru', approved: true })).toEqual(['Привет, я Olivia. Позовите меня по имени, когда понадоблюсь.'])
  })
})

describe('the join handler passes the adder\'s raw language', () => {
  test('server.ts hands groupJoinLines ctx.from.language_code as code', () => {
    const call = SERVER.slice(SERVER.indexOf('const lines = groupJoinLines({'), SERVER.indexOf('const lines = groupJoinLines({') + 400)
    expect(call).toContain('code: ctx.from?.language_code,')
    expect(call).toContain('lang: liteLang(ctx.from?.language_code),')
  })
})
