// DIVE-7250: the app's third "In groups, answer" row, "When I call it by name".
// `agent telegram-access groups --answer=owner` (the CLI) stores
// `groupsOwnerOnly: true` and gives every group `allowFrom: [<owners>]`. The
// plugin owes three things:
//   1. In a group, a message from anyone but an owner is DROPPED, before the
//      'listen' branch, so its text never reaches the agent or the group log it
//      reads when the owner calls it (lodar 08:35Z: no one gets into his
//      account through it). The owner calling it by name still wakes it.
//   2. A group the owner adds later lets in its owners only, by name.
//   3. The key survives the plugin's own saves; the hello tells nobody else to call her.
//
// server.ts long-polls Telegram on import, so it is read as TEXT; groupjoin.ts
// is pure and imported.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitOnJoin, groupJoinLines, groupOwnerIds, ownerOnlyDrops } from '../plugins/telegram/groupjoin'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

// 111 = the owner, 222 = a guest the owner let DM the agent, 333 = a stranger in the group.
const access = (extra: Record<string, unknown> = {}) =>
  ({ owners: ['111'], allowFrom: ['111', '222'], groups: {} as Record<string, unknown>, ...extra })

describe('owner only: who reaches the agent in a group', () => {
  test("the owner's message gets through", () => {
    expect(ownerOnlyDrops(access({ groupsOwnerOnly: true }), '111')).toBe(false)
  })
  test('anyone else is dropped: a guest the owner lets DM it, a stranger, another bot', () => {
    for (const id of ['222', '333', '999'])
      expect(ownerOnlyDrops(access({ groupsOwnerOnly: true }), id)).toBe(true)
  })
  test('negative control: off, or unset, drops nobody (by name / every message unchanged)', () => {
    for (const extra of [{}, { groupsOwnerOnly: false }])
      for (const id of ['111', '222', '333'])
        expect(ownerOnlyDrops(access(extra), id)).toBe(false)
  })
  test('an owner the bot no longer answers is not an owner here', () => {
    expect(ownerOnlyDrops(access({ groupsOwnerOnly: true, allowFrom: ['222'] }), '111')).toBe(true)
    expect(groupOwnerIds({ owners: ['111', 'x'], allowFrom: ['111'] })).toEqual(['111'])
  })
  test('no owners record yet: nobody gets through (it fails closed)', () => {
    expect(ownerOnlyDrops({ allowFrom: ['111'], groupsOwnerOnly: true }, '111')).toBe(true)
  })
})

describe('the gate drops it before listen, so the text never reaches the agent', () => {
  const gate = SERVER.slice(SERVER.indexOf('function gate(ctx: Context): GateResult {'), SERVER.indexOf('function dmCommandGate('))
  test('people: the drop sits after the group allowFrom check and before the listen branch', () => {
    const human = gate.slice(gate.indexOf("if (chatType === 'group' || chatType === 'supergroup') {\n    const groupId"))
    const drop = human.indexOf("if (ownerOnlyDrops(access, senderId)) return { action: 'drop' }")
    expect(drop).toBeGreaterThan(human.indexOf('if (groupAllowFrom.length > 0'))
    expect(drop).toBeLessThan(human.indexOf("return { action: 'listen' }"))
  })
  test('bots in a group too', () => {
    const bots = gate.slice(gate.indexOf('if (from.is_bot) {'), gate.indexOf("if (chatType === 'private') {\n    if (access.allowFrom"))
    expect(bots).toContain("if (ownerOnlyDrops(access, senderId)) return { action: 'drop' }")
  })
  test("a non-owner's edit is not logged either", () => {
    const edit = SERVER.slice(SERVER.indexOf('function logGroupEdit('), SERVER.indexOf('appendGroupLine(GROUPLOG_DIR, chatId, {', SERVER.indexOf('function logGroupEdit(')))
    expect(edit).toContain('if (ownerOnlyDrops(access, String(m.from.id))) return')
  })
  test('the plugin keeps the key when it saves access.json', () => {
    expect(SERVER).toContain('groupsOwnerOnly: parsed.groupsOwnerOnly,')
    expect(SERVER).toMatch(/\n {2}groupsOwnerOnly\?: boolean\n/)
  })
})

describe('a group the owner adds later', () => {
  test('owner only: by name, its owners let in', () => {
    const a = access({ groupsOwnerOnly: true, groupsRequireMention: false })
    expect(admitOnJoin(a, '-1001', { id: 111 })).toBe(true)
    expect(a.groups['-1001']).toEqual({ requireMention: true, allowFrom: ['111'] })
  })
  test('not owner only: as before', () => {
    const a = access()
    admitOnJoin(a, '-1001', { id: 111 })
    expect(a.groups['-1001']).toEqual({ requireMention: true, allowFrom: [] })
  })
  test("a guest's add still waits", () => {
    const a = access({ groupsOwnerOnly: true })
    expect(admitOnJoin(a, '-1001', { id: 222 })).toBe(false)
    expect(a.groups).toEqual({})
  })
})

describe('the hello tells nobody else to call her', () => {
  const base = { lite: true, lang: 'en' as const, name: 'Olivia', username: 'o_bot', title: 'Family', chatId: '-1', approved: true, announce: false, privacyOn: false, fivedive: true }
  test('English and Russian, lite and default profile', () => {
    expect(groupJoinLines({ ...base, ownerOnly: true })).toEqual(["Hi, I'm Olivia. I answer only the person who added me."])
    expect(groupJoinLines({ ...base, lang: 'ru', ownerOnly: true })).toEqual(['Привет, я Olivia. Я отвечаю только тому, кто меня добавил.'])
    expect(groupJoinLines({ ...base, lite: false, ownerOnly: true })).toEqual(["👋 Hi, I'm Olivia. I answer only the person who added me."])
  })
  test('the join passes the setting to the hello', () => {
    expect(SERVER).toContain('ownerOnly: access.groupsOwnerOnly === true,')
  })
})
