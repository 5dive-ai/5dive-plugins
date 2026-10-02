// DIVE-5368: the owner shares an agent from the Mini App ("Who can talk to
// {name}"). Three things the plugin owes that screen:
//   1. A group the OWNER adds the bot to is approved at once, mention-only, and
//      the agent says hello. A group anyone else adds waits, and its line points
//      at the app, not the dashboard or a terminal (negative control).
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
import { addedByOwner, groupJoinLines, ASK_OWNER, GROUP_STRINGS, type JoinInput } from '../plugins/telegram/groupjoin'

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
  test('the owner (already in allowFrom) → approved', () => {
    expect(addedByOwner(['111', '222'], { id: 222 })).toBe(true)
    expect(addedByOwner(['111'], { id: '111' })).toBe(true)
  })
  test('negative control: anyone else, a bot, or no adder → not approved', () => {
    expect(addedByOwner(['111'], { id: 333 })).toBe(false)
    expect(addedByOwner([], { id: 111 })).toBe(false)
    expect(addedByOwner(['111'], { id: 111, is_bot: true })).toBe(false)
    expect(addedByOwner(['111'], undefined)).toBe(false)
  })
  test('the join handler approves mention-only, only on an owner add, and saves before any network wait', () => {
    const h = between("bot.on('my_chat_member'", "bot.on('message:text'")
    expect(h).toContain("const approved = !(chatId in access.groups) && addedByOwner(access.allowFrom, ctx.from)")
    expect(h).toContain("if (approved) access.groups[chatId] = { requireMention: true, allowFrom: [] }")
    // the group is live before getMe / the version probe / the send
    expect(h.indexOf('saveAccess(access)', h.indexOf('const announce'))).toBeLessThan(h.indexOf('getMe()'))
    // the one-time announce is stamped on a FRESH read, never the stale copy
    expect(h).toContain('const fresh = loadAccess()')
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
