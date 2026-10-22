// DIVE-6684: "Also answers to" — extra names that call an agent in a Telegram
// group, in any language — and a name in a script written without spaces (Han,
// kana, Thai) found anywhere in the line (lodar 2026-10-21 09:58Z on DIVE-6673:
// "or chinese names too, maybe some future chinese users").
//
// Before: grouplog.ts matched only the bot's own display name, as a whole run of
// letters. "奥利维亚帮我算一下" is ONE run, so a bot named 奥利维亚 never heard it,
// and an owner had no way to add "Оля" or "奥利维亚" short of a regex.
// server.ts is read as TEXT (it long-polls Telegram on import).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callNames, isCallName, isNoSpaceName, nameMentioned, CALL_NAMES_MAX } from '../plugins/telegram/grouplog'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

describe('a name in a script without spaces', () => {
  test('a Chinese display name triggers with a comma after it and with none', () => {
    for (const t of ['奥利维亚，总共多少？', '奥利维亚帮我算一下', '请奥利维亚看看', '奥利维亚'])
      expect(nameMentioned(t, '奥利维亚')).toBe(true)
  })
  test('Japanese and Thai names match anywhere too', () => {
    expect(nameMentioned('オリビアさん、お願いします', 'オリビア')).toBe(true)
    expect(nameMentioned('โอลิเวียช่วยหน่อย', 'โอลิเวีย')).toBe(true)
  })
  test('negative: another name, or a line without hers', () => {
    expect(nameMentioned('小明帮我算一下', '奥利维亚')).toBe(false)
    expect(nameMentioned('利维帮我', '奥利维亚')).toBe(false)
    expect(isNoSpaceName('Olivia')).toBe(false)
    expect(isNoSpaceName('Оля')).toBe(false)
  })
})

describe('extra call names', () => {
  test('a Latin-named bot with ["奥利维亚"] answers 奥利维亚', () => {
    expect(nameMentioned('奥利维亚，总共多少？', 'Olivia', ['奥利维亚'])).toBe(true)
    expect(nameMentioned('奥利维亚，总共多少？', 'Olivia')).toBe(false)
  })
  test('"Оля" triggers on "Оля, привет" and its forms, not on "Ольга"', () => {
    for (const t of ['Оля, привет', 'спроси Олю', 'у Оли есть итог?', 'Olia, hi'])
      expect(nameMentioned(t, 'Olivia', ['Оля'])).toBe(true)
    for (const t of ['Ольга, привет', 'Олег тут', 'оливки'])
      expect(nameMentioned(t, 'Olivia', ['Оля'])).toBe(false)
  })
  test('"Liv" is a whole word: not inside "live" or "Liverpool"', () => {
    expect(nameMentioned('Liv, what is the total?', 'Olivia', ['Liv'])).toBe(true)
    expect(nameMentioned('we live here, Liverpool won', 'Olivia', ['Liv'])).toBe(false)
  })
  test('a two-word or hyphenated name needs its words together', () => {
    expect(nameMentioned('Mary Ann, hi', 'Olivia', ['Mary Ann'])).toBe(true)
    expect(nameMentioned('спроси Анну-Марию', 'Olivia', ['Анна-Мария'])).toBe(true)
    expect(nameMentioned('Mary, Ann is here', 'Olivia', ['Mary Ann'])).toBe(false)
    expect(nameMentioned('Ann Mary', 'Olivia', ['Mary Ann'])).toBe(false)
  })
  test('the DIVE-6673 negative controls hold with names on the list', () => {
    for (const t of ['купи оливки', 'оливковое масло', 'оливы и маслины', 'ask @olivia_bot', 'just chatting'])
      expect(nameMentioned(t, 'Olivia', ['Оля', 'Liv', '奥利维亚'])).toBe(false)
  })
  test('the list from access.json: names only, at most 10, never a pattern', () => {
    expect(callNames(['Оля', 'Liv', '奥利维亚'])).toEqual(['Оля', 'Liv', '奥利维亚'])
    expect(callNames(['.*', 'a', ' Liv', 'Liv2', 'x'.repeat(33), 42, 'Оля'])).toEqual(['Оля'])
    expect(callNames(Array.from({ length: 12 }, (_, i) => 'Name' + 'abcdefghijkl'[i]))).toHaveLength(CALL_NAMES_MAX)
    expect(callNames('Оля')).toEqual([])
    expect(callNames(undefined)).toEqual([])
    expect(isCallName('Анна-Мария')).toBe(true)
    expect(isCallName('--')).toBe(false)
    for (const n of ['a -', '- a', 'Liv a', 'a-Liv', '-Liv', 'Liv-']) expect(isCallName(n)).toBe(false)
    for (const n of ['Mary Ann', 'Jo-Jo', '李明']) expect(isCallName(n)).toBe(true)
    expect(nameMentioned('anything at all', 'Olivia', callNames(['.*']))).toBe(false)
  })
})

describe('server.ts', () => {
  test('the gate passes the owner\'s names, validated, from access.json', () => {
    expect(SERVER).toContain('isMentioned(ctx, access.mentionPatterns, callNames(access.groupsCallNames)')
    const m = SERVER.slice(SERVER.indexOf('function isMentioned('), SERVER.indexOf('function groupLineFor('))
    expect(m).toContain('botFirstName, alsoNames)')
  })
  test('the plugin keeps groupsCallNames when it saves access.json', () => {
    const n = SERVER.slice(SERVER.indexOf('function normalizeAccess('), SERVER.indexOf('function normalizeAccess(') + 1500)
    expect(n).toContain('groupsCallNames: parsed.groupsCallNames')
  })
})
