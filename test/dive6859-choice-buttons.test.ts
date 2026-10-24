// DIVE-6859: on OINOA's box an agent ended with «Делаем так?» and «Какой берём?»
// as plain text. Three causes, one arm each: (b) the Yes/No detector knew only
// English, so «Какой берём?» or «A или B?» got ✅Да/❌Нет on a 5dive box; (c) a
// lite (partner) box never got the pair at all; (a) neither instructions block
// told the agent that a numbered list becomes buttons.
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { yesNoChoice, optionChoices } from '../plugins/telegram/tna'
import { LITE_INSTRUCTIONS } from '../plugins/telegram/hooks/lib/lite'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const SERVER = readFileSync(join(PLUGINS, 'telegram', 'server.ts'), 'utf8')

describe('yesNoChoice — Russian open questions get no Yes/No (b)', () => {
  const NO = [
    'Какой берём?',
    'Два пути, какой берём?',
    'Какую версию оставить?',
    'Что дальше?',
    'Готово. Кто это проверит?',
    'Где лежит файл?',
    'Когда тебе нужно?',
    'Куда отправить?',
    'Откуда эти цифры?',
    'Почему упало?',
    'Зачем это нужно?',
    'Как тебе?',
    'Сколько ставим?',
    'Чей это проект?',
    'Оставляем A или B?',
    'Шлём сейчас или ждём?',
    'Если всё ок, что дальше?',
    // The lead-in clause applies to English too.
    'Two paths, which one?',
  ]
  test.each(NO)('no keyboard: %j', q => expect(yesNoChoice(q)).toBe(false))
})

describe('yesNoChoice — Russian polar questions get Yes/No (b)', () => {
  const YES = [
    'Делаем так?',
    'Готово. Отправляю?',
    'Можно запускать?',
    // Words that only START like an opener or «или» are not one.
    'Какао берём?',
    'Илья, запускаем?',
    'Скопировал, что нужно, отправляю?',
  ]
  test.each(YES)('keyboard: %j', q => expect(yesNoChoice(q)).toBe(true))
})

describe('the screenshot cases', () => {
  test('«Делаем так?» → Yes/No', () => expect(yesNoChoice('Предлагаю начать с лендинга. Делаем так?')).toBe(true))
  test('«Какой берём?» → no Yes/No', () => expect(yesNoChoice('Есть два варианта. Какой берём?')).toBe(false))
  test('a numbered Russian choice still gets option buttons', () => {
    const msg = 'Какой берём?\n1. Лендинг\n2. Бот в Telegram'
    expect(optionChoices(msg).map(o => o.label)).toEqual(['Лендинг', 'Бот в Telegram'])
  })
})

describe('lite boxes get the Yes/No pair (c)', () => {
  test('yesNoButtons no longer reads the profile', () => {
    const fn = SERVER.slice(SERVER.indexOf('function yesNoButtons('), SERVER.indexOf('// DIVE-708: when an agent message presents'))
    expect(fn).toContain('if (!yesNoChoice(text)) return { stripped: text }')
    expect(fn.split('\n').filter(l => /\bLITE\b/.test(l) && !/^\s*\/\//.test(l))).toEqual([])
  })
  test('the yn: tap handler is not profile-gated either', () => {
    const at = SERVER.indexOf("const ynM = /^yn:(yes|no)$/.exec(data)")
    expect(at).toBeGreaterThan(0)
    expect(SERVER.slice(at, SERVER.indexOf('\n  }\n', at))).not.toMatch(/\bLITE\b/)
  })
})

describe('both instructions blocks say how to get choice buttons (a)', () => {
  const block = (() => {
    const lines = SERVER.split('\n')
    const start = lines.indexOf('    instructions: [')
    const end = lines.findIndex((l, i) => i > start && /^    \]\.join/.test(l))
    return lines.slice(start + 1, end).join('\n')
  })()
  test.each([['default', block], ['lite', LITE_INSTRUCTIONS]])('%s', (_, text) => {
    expect(text).toContain('numbered list')
    expect(text).toContain('2 to 8 answers, each under 90 characters')
    expect(text).toMatch(/becomes a (tap )?button/)
  })
})

describe('tna.ts stays byte-identical across every telegram plugin', () => {
  test('one content', () => {
    const all = readdirSync(PLUGINS).filter(p => /^telegram/.test(p)).flatMap(p => {
      try { return [readFileSync(join(PLUGINS, p, 'tna.ts'), 'utf8')] } catch { return [] }
    })
    expect(all.length).toBeGreaterThanOrEqual(6)
    expect(new Set(all).size).toBe(1)
  })
})
