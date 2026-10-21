// DIVE-6675: the app's "In groups, answer: when called by name · every message".
// `agent telegram-access groups` (the CLI) sets requireMention on every group
// and stores `groupsRequireMention`. The plugin owes two things:
//   1. A group the owner adds later answers as that setting says, and the key
//      survives the plugin's own saves (normalizeAccess drops unknown keys).
//   2. The hello says how she answers: "Call me by name when you need me", or,
//      in a group set to every message, that she answers its messages. A
//      non-admin privacy-mode bot keeps its reply-only line (it sees neither).
//
// server.ts long-polls Telegram on import, so it is read as TEXT; groupjoin.ts
// is pure and imported.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitOnJoin, groupJoinLines, type JoinInput } from '../plugins/telegram/groupjoin'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

const base: JoinInput = {
  lite: true,
  lang: 'en',
  name: 'Olivia',
  username: 'olivia_x1_bot',
  title: 'Family',
  chatId: '-100123',
  approved: true,
  announce: false,
  privacyOn: false,
  fivedive: true,
}

const owner = (extra: Record<string, unknown> = {}) => ({ owners: ['111'], allowFrom: ['111'], groups: {} as Record<string, unknown>, ...extra })

describe('a group the owner adds answers as the setting says', () => {
  test('no setting stored: by name, as before', () => {
    const a = owner()
    expect(admitOnJoin(a, '-1001', { id: 111 })).toBe(true)
    expect(a.groups['-1001']).toEqual({ requireMention: true, allowFrom: [] })
  })
  test('set to every message: the new group answers every message', () => {
    const a = owner({ groupsRequireMention: false })
    expect(admitOnJoin(a, '-1001', { id: 111 })).toBe(true)
    expect(a.groups['-1001']).toEqual({ requireMention: false, allowFrom: [] })
  })
  test('set to by name: by name', () => {
    const a = owner({ groupsRequireMention: true })
    admitOnJoin(a, '-1001', { id: 111 })
    expect(a.groups['-1001']).toEqual({ requireMention: true, allowFrom: [] })
  })
  test("someone else's group still waits, whatever the setting", () => {
    const a = owner({ groupsRequireMention: false })
    expect(admitOnJoin(a, '-1001', { id: 222 })).toBe(false)
    expect(a.groups).toEqual({})
  })
  test('the plugin keeps the key when it saves access.json', () => {
    expect(SERVER).toContain('groupsRequireMention: parsed.groupsRequireMention,')
    expect(SERVER).toMatch(/\n {2}groupsRequireMention\?: boolean\n/)
  })
  test('the join hello is told whether the group answers every message', () => {
    const a = SERVER.indexOf('const approved = admitOnJoin(access, chatId, ctx.from)')
    const b = SERVER.indexOf('const lines = groupJoinLines({', a)
    const c = SERVER.indexOf('})', b)
    expect(a).toBeGreaterThan(0)
    expect(SERVER.slice(b, c)).toContain('everyMessage: access.groups[chatId]?.requireMention === false,')
  })
  test('a group set to every message passes the gate untagged (the gate the setting drives)', () => {
    expect(SERVER).toContain('const requireMention = policy.requireMention ?? true')
  })
})

describe('the hello says how she answers', () => {
  test('by name, English and Russian, lite and default profile', () => {
    expect(groupJoinLines(base)).toEqual(["Hi, I'm Olivia. Call me by name when you need me."])
    expect(groupJoinLines({ ...base, lang: 'ru' })).toEqual(['Привет, я Olivia. Позовите меня по имени, когда понадоблюсь.'])
    expect(groupJoinLines({ ...base, lite: false })).toEqual(["👋 Hi, I'm Olivia. Call me by name when you need me."])
  })
  test('every message: never tells people to call her by name', () => {
    expect(groupJoinLines({ ...base, everyMessage: true })).toEqual(["Hi, I'm Olivia. I answer messages in this group."])
    expect(groupJoinLines({ ...base, lang: 'ru', everyMessage: true })).toEqual(['Привет, я Olivia. Я отвечаю на сообщения в этой группе.'])
    expect(groupJoinLines({ ...base, lite: false, everyMessage: true })).toEqual(["👋 Hi, I'm Olivia. I answer messages in this group."])
    for (const lang of ['en', 'ru'] as const)
      for (const lite of [true, false])
        expect(groupJoinLines({ ...base, lang, lite, everyMessage: true }).join(' ')).not.toMatch(/by name|по имени|Mention|Упомяните/)
  })
  test('the old "Mention me (@bot)" line is gone in both languages', () => {
    for (const lang of ['en', 'ru'] as const)
      for (const lite of [true, false])
        expect(groupJoinLines({ ...base, lang, lite }).join(' ')).not.toMatch(/Mention me|Упомяните меня|@olivia_x1_bot/)
  })
  test('a non-admin privacy-mode bot keeps the reply-only line in either mode', () => {
    for (const everyMessage of [true, false]) {
      expect(groupJoinLines({ ...base, privacyOn: true, everyMessage })[0]).toBe("Hi, I'm Olivia. Reply to one of my messages to ask something.")
      expect(groupJoinLines({ ...base, lang: 'ru', privacyOn: true, everyMessage })[0]).toBe('Привет, я Olivia. Чтобы задать вопрос, ответьте на одно из моих сообщений.')
    }
  })
})
