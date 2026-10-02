// DIVE-5368: the owner shares an agent from the Mini App ("Who can talk to
// {name}"). Three things the plugin owes that screen:
//   1. A group the OWNER adds the bot to is approved at once, mention-only, and
//      the agent says hello. A group anyone else adds waits, and its line points
//      at the app, not the dashboard or a terminal (negative control). Owner is
//      the plugin's `owners` record, NOT allowFrom: a guest the app let in is in
//      allowFrom and must not be able to share the agent (quinn, iteration 1).
//   2. Under the lite profile a group the owner shared reaches the gate at all
//      (the lite front door dropped every non-private update), and a stranger's
//      DM is recorded for the app's approve list with one plain line, no code.
//   3. A pending entry carries the sender's name, so the app lists who it is.
//
// server.ts long-polls Telegram on import, so it is read as TEXT (as in
// dive5121-lite-profile.test.ts); groupjoin.ts is pure and imported.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addedByOwner, admitOnJoin, nextOwners, groupJoinLines, ASK_OWNER, GROUP_STRINGS, type JoinInput } from '../plugins/telegram/groupjoin'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const LEAK = /5dive|claude|anthropic|openrouter|\bmodel|token|context|server|\bbox\b|\bcost|\$|сервер|токен|модел|контекст/i
const EMOJI = /\p{Extended_Pictographic}/u

const base: JoinInput = {
  lite: true,
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

// The slice of server.ts between two markers, so a check reads one handler.
function between(from: string, to: string): string {
  const a = SERVER.indexOf(from)
  const b = SERVER.indexOf(to, a + from.length)
  expect(a).toBeGreaterThan(0)
  expect(b).toBeGreaterThan(a)
  return SERVER.slice(a, b)
}

describe('who added the bot decides whether the group is approved', () => {
  test('a recorded owner the bot still answers → approved', () => {
    expect(addedByOwner(['111'], ['111', '222'], { id: 111 })).toBe(true)
    expect(addedByOwner(['111', '222'], ['111', '222'], { id: '222' })).toBe(true)
  })
  test('negative control: anyone else, a bot, no adder, no record, or an owner since removed → not approved', () => {
    expect(addedByOwner(['111'], ['111'], { id: 333 })).toBe(false)
    expect(addedByOwner(['111'], ['111'], { id: 111, is_bot: true })).toBe(false)
    expect(addedByOwner(['111'], ['111'], undefined)).toBe(false)
    expect(addedByOwner(undefined, ['111'], { id: 111 })).toBe(false)
    expect(addedByOwner(['111'], [], { id: 111 })).toBe(false)
  })
  test('a GUEST (in allowFrom, not an owner) adds the bot: the group stays in discovered and is not added to groups', () => {
    const access = {
      owners: ['111'],
      allowFrom: ['111', '222'],
      groups: {} as Record<string, unknown>,
      discovered: { '-100777': { title: 'Strangers', type: 'supergroup', addedBy: '222', firstSeenAt: 1 } },
    }
    expect(admitOnJoin(access, '-100777', { id: 222 })).toBe(false)
    expect(access.groups).toEqual({})
    expect(Object.keys(access.discovered)).toEqual(['-100777'])
  })
  test('the owner adds it: in groups, mention-only, nobody else listed', () => {
    const access = { owners: ['111'], allowFrom: ['111', '222'], groups: {} as Record<string, unknown> }
    expect(admitOnJoin(access, '-100888', { id: 111 })).toBe(true)
    expect(access.groups).toEqual({ '-100888': { requireMention: true, allowFrom: [] } })
    // an approved group's own settings are never reset by a re-add
    access.groups['-100888'] = { requireMention: false, allowFrom: ['5'] }
    expect(admitOnJoin(access, '-100888', { id: 111 })).toBe(false)
    expect(access.groups['-100888']).toEqual({ requireMention: false, allowFrom: ['5'] })
  })
  test('the join handler decides with admitOnJoin and saves before any network wait', () => {
    const h = between("bot.on('my_chat_member'", "bot.on('message:text'")
    expect(h).toContain('const approved = admitOnJoin(access, chatId, ctx.from)')
    expect(h).not.toContain('addedByOwner(access.allowFrom')
    // the group is live before getMe / the version probe / the send
    expect(h.indexOf('saveAccess(access)', h.indexOf('const announce'))).toBeLessThan(h.indexOf('getMe()'))
    // the one-time announce is stamped on a FRESH read, never the stale copy
    expect(h).toContain('const fresh = loadAccess()')
    // a blocked group post falls back to an owner's DM, never a guest's
    expect(h).toContain('(access.owners ?? access.allowFrom).filter((id) => access.allowFrom.includes(id))')
  })
})

describe('the owners record: seeded once, grown only by an owner-level pairing', () => {
  test('first sight seeds from allowFrom (numeric user ids only)', () => {
    expect(nextOwners(undefined, ['111', '-100500', 'x'], [])).toEqual(['111'])
    expect(nextOwners(undefined, [], [])).toEqual([])
  })
  test('an approved/<id> pairing adds that id; a guest the app adds to allowFrom later is NOT added', () => {
    expect(nextOwners(['111'], ['111', '222'], [])).toBeNull()
    expect(nextOwners(['111'], ['111', '333'], ['333'])).toEqual(['111', '333'])
    expect(nextOwners(['111'], ['111'], ['111'])).toBeNull()
    expect(nextOwners(['111'], ['111'], ['../x', '-5'])).toBeNull()
  })
  test('server keeps the record: typed, carried by the loader, written at boot and on each pairing', () => {
    expect(SERVER).toContain('owners?: string[]')
    expect(SERVER).toContain('owners: parsed.owners,')
    const c = between('function checkApprovals(): void {', 'for (const senderId of files)')
    expect(c).toContain('recordOwners(files)')
    const r = between('function recordOwners(', '\nrecordOwners()\n')
    expect(r).toContain('nextOwners(a.owners, a.allowFrom, paired)')
    expect(r).toContain('!existsSync(ACCESS_FILE)')
  })
})

describe('what the group is told', () => {
  test('owner add, lite: one hello that says to mention it, nothing else', () => {
    expect(groupJoinLines({ ...base, approved: true })).toEqual(["Hi, I'm Olivia. Mention me (@olivia_x1_bot) to ask something."])
  })
  test('someone else adds it, lite: it waits for the owner, said once', () => {
    expect(groupJoinLines({ ...base, announce: true })).toEqual(["Hi, I'm Olivia. I'll stay quiet here until my owner lets this group in."])
    expect(groupJoinLines({ ...base })).toEqual([]) // re-add after the announce: quiet
  })
  test('Group Privacy on (DIVE-246) is still said, in plain words', () => {
    const lines = groupJoinLines({ ...base, approved: true, privacyOn: true })
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(GROUP_STRINGS.en.privacy)
    expect(lines[1]).toContain('make me an admin')
  })
  test('Russian for a Russian adder', () => {
    expect(groupJoinLines({ ...base, lang: 'ru', approved: true })[0]).toStartWith('Привет, я Olivia.')
  })
  test('no lite line names the platform or carries an emoji', () => {
    const all: string[] = [ASK_OWNER.en, ASK_OWNER.ru]
    for (const lang of ['en', 'ru'] as const)
      for (const approved of [true, false])
        all.push(...groupJoinLines({ ...base, lang, approved, announce: !approved, privacyOn: true }))
    expect(all.filter(t => LEAK.test(t) || EMOJI.test(t))).toEqual([])
  })
  test('default profile on a 5dive host: the waiting line points at the app, not the dashboard or a terminal', () => {
    const [line] = groupJoinLines({ ...base, lite: false, announce: true })
    expect(line).toContain('5dive app')
    expect(line).toContain('-100123') // the id stays, for the dashboard modal and the CLI
    expect(line).not.toMatch(/dashboard|\/telegram:access|terminal/)
  })
  test('default profile off 5dive (the OSS fork): /telegram:access is the only way in, so it stays', () => {
    const [line] = groupJoinLines({ ...base, lite: false, announce: true, fivedive: false })
    expect(line).toContain('/telegram:access')
  })
  test('default profile, owner add: the hello', () => {
    expect(groupJoinLines({ ...base, lite: false, approved: true })).toEqual(["👋 Hi, I'm Olivia. Mention me (@olivia_x1_bot) to ask something."])
  })
})

describe('the lite front door lets the shared group and the invite through', () => {
  const door = between('if (LITE) {\n  bot.use(', '\nfor (const def of COMMAND_REGISTRY)')
  test('a join/leave reaches the my_chat_member handler; group text reaches the gate; commands do not', () => {
    expect(door).toContain('if (ctx.myChatMember) return next()')
    expect(door).toContain("if (text !== undefined && !text.startsWith('/') && ctx.from && !ctx.from.is_bot) await handleInbound(ctx, text, undefined)")
    // the group branch ends in a return, so nothing in a group reaches the org commands
    const g = door.slice(door.indexOf("ctx.chat?.type === 'group'"), door.indexOf("if (ctx.chat?.type !== 'private'"))
    expect(g.trimEnd().endsWith('return\n    }')).toBe(true)
  })
  test("a stranger's DM goes to the gate only under dmPolicy=pairing; allowlist stays silent", () => {
    expect(door).toContain("if (access.dmPolicy === 'pairing' && ctx.message?.text !== undefined) await handleInbound(ctx, ctx.message.text, undefined)")
  })
  test('lite pairing reply is the plain line, once, never the code', () => {
    const pair = between('async function replyPair(', 'const lead = result.isResend')
    expect(pair).toContain('if (LITE) {')
    expect(pair).toContain('if (!result.isResend) await ctx.reply(ASK_OWNER[liteLang(ctx.from?.language_code)])')
    expect(pair).not.toContain('result.code')
  })
  test('a pending entry carries the sender name for the approve list', () => {
    const g = between('function gate(ctx: Context): GateResult {', '// Like gate() but for bot commands')
    expect(g).toContain("name: [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined,")
    expect(g).toContain('username: from.username,')
  })
})

describe("the app can say when Telegram hides group messages from the bot", () => {
  test('getMe\'s privacy bit is recorded at start and on every join, and survives the loader', () => {
    expect(SERVER).toContain('recordGroupPrivacy(info.can_read_all_group_messages)')
    expect(between("bot.on('my_chat_member'", "bot.on('message:text'")).toContain('recordGroupPrivacy(me.can_read_all_group_messages)')
    // normalizeAccess keeps only the keys it names; a key it drops is gone on the next save
    expect(between('function normalizeAccess(', '\n}\n')).toContain('canReadAllGroupMessages: parsed.canReadAllGroupMessages,')
  })
})
