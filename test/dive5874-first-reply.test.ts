// DIVE-5874: the first job picked at hire comes back as the agent's first message.
//
// The box writes STATE_DIR/first-reply.json {token,text,at}; FiveDiveBot sends the
// owner one "Open <Name>" button, t.me/<bot>?start=fj-<token>. The owner's /start
// (either profile), the boot greeting, or a poll sends the stored text in place of
// the greeting, once, to an owner's DM only; a failed send keeps the file. The arms
// below drive firstreply.ts with a fake send, and read server.ts as TEXT (it
// long-polls Telegram on import) to check it is wired in.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGreetClaims } from '../plugins/telegram/bootgreet.ts'
import {
  makeFirstReplier, readFirstReply, readFirstReplyState, consumeFirstReply, stampSecond, splitForTelegram,
  isFirstJobPayload, firstReplyOwners, lastHumanChatId, FIRST_REPLY_FILE, FIRST_REPLY_STATE_FILE,
  FIRST_REPLY_POLL_BACKOFF_MS, FIRST_REPLY_POLL_MS, TG_TEXT_LIMIT,
} from '../plugins/telegram/firstreply.ts'
import { liteStartPayload } from '../plugins/telegram/hooks/lib/lite.ts'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const OWNER = '1234567890'
const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-' // 22 chars of base64url, as the API mints

const dirs: string[] = []
function stateDir(reply?: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'dive5874-'))
  dirs.push(d)
  if (reply !== undefined) writeFileSync(join(d, FIRST_REPLY_FILE), typeof reply === 'string' ? reply : JSON.stringify(reply))
  return d
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

/** A replier over `dir` whose send records each part, and fails while `fail` is set. */
function rig(dir: string, o: { owners?: string[]; fail?: () => boolean; now?: () => number } = {}) {
  const sent: { chat: string; text: string }[] = []
  const claims = makeGreetClaims(o.now)
  const r = makeFirstReplier({
    dir,
    claims,
    owners: () => o.owners ?? [OWNER],
    send: async (chat, text) => {
      if (o.fail?.()) throw new Error('Forbidden: bot was blocked by the user')
      sent.push({ chat, text })
    },
    now: o.now,
  })
  return { r, sent, claims }
}

describe('the file', () => {
  test("reads the CLI's shape, and nothing else", () => {
    expect(readFirstReply(stateDir({ token: TOKEN, text: 'Here is your plan', at: '2026-10-08T10:00:00Z' })))
      .toEqual({ token: TOKEN, text: 'Here is your plan', at: '2026-10-08T10:00:00Z' })
    expect(readFirstReply(stateDir())).toBeNull()
    expect(readFirstReply(stateDir('{not json'))).toBeNull()
    expect(readFirstReply(stateDir({ token: TOKEN, text: '   ' }))).toBeNull()
    expect(readFirstReply(stateDir({ token: '../../etc', text: 'x' }))).toBeNull()
  })
  test('consume drops the file and records startAt; a newer job written meanwhile survives', () => {
    const d = stateDir({ token: TOKEN, text: 'a' })
    consumeFirstReply(d, TOKEN, new Date('2026-10-08T10:00:00Z'))
    expect(existsSync(join(d, FIRST_REPLY_FILE))).toBe(false)
    expect(readFirstReplyState(d)).toEqual({ token: TOKEN, startAt: '2026-10-08T10:00:00.000Z' })
    const d2 = stateDir({ token: 'ZZZZZZZZZZZZZZZZZZZZZZ', text: 'newer' })
    consumeFirstReply(d2, TOKEN)
    expect(readFirstReply(d2)?.token).toBe('ZZZZZZZZZZZZZZZZZZZZZZ')
  })
  test('secondAt is stamped once, and only after the result went out', () => {
    const d = stateDir()
    expect(stampSecond(d)).toBe('none')
    consumeFirstReply(d, TOKEN, new Date('2026-10-08T10:00:00Z'))
    expect(stampSecond(d, new Date('2026-10-08T10:05:00Z'))).toBe('stamped')
    expect(stampSecond(d, new Date('2026-10-08T11:00:00Z'))).toBe('done')
    expect(JSON.parse(readFileSync(join(d, FIRST_REPLY_STATE_FILE), 'utf8')))
      .toEqual({ token: TOKEN, startAt: '2026-10-08T10:00:00.000Z', secondAt: '2026-10-08T10:05:00.000Z' })
  })
})

describe('splitting at the 4096 limit', () => {
  test('short text is one message', () => expect(splitForTelegram('hello')).toEqual(['hello']))
  test('every part fits, and nothing but the cut whitespace is lost', () => {
    const para = 'word '.repeat(300).trim()
    const text = Array.from({ length: 12 }, () => para).join('\n\n')
    const parts = splitForTelegram(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TG_TEXT_LIMIT)
    expect(parts.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
    expect(parts[0].endsWith('word')).toBe(true) // cut at a paragraph, not mid-word
  })
  test('no whitespace at all: a hard cut that never splits an emoji', () => {
    const text = 'a'.repeat(TG_TEXT_LIMIT - 1) + '😀' + 'b'.repeat(10)
    const parts = splitForTelegram(text)
    expect(parts[0]).toBe('a'.repeat(TG_TEXT_LIMIT - 1))
    expect(parts[1]).toBe('😀' + 'b'.repeat(10))
  })
})

describe('who gets it', () => {
  test('owners (else the allowlist), private ids only', () => {
    expect(firstReplyOwners({ owners: [OWNER, '77'], allowFrom: [OWNER, '-100555', '88'] })).toEqual([OWNER])
    expect(firstReplyOwners({ allowFrom: [OWNER, '-100555'] })).toEqual([OWNER])
  })
  test('a guest on the allowlist and a group chat get the greeting path, the file stays', async () => {
    const d = stateDir({ token: TOKEN, text: 'result' })
    const { r, sent } = rig(d)
    expect(await r.deliver('88')).toBe('none')
    expect(await r.deliver('-100555')).toBe('none')
    expect(sent).toEqual([])
    expect(existsSync(join(d, FIRST_REPLY_FILE))).toBe(true)
  })
  test('last-human-chat.json gives the chat id; absent or junk is null', () => {
    const d = stateDir()
    writeFileSync(join(d, 'lhc.json'), JSON.stringify({ chatId: OWNER, messageThreadId: null, at: 'x' }))
    expect(lastHumanChatId(join(d, 'lhc.json'))).toBe(OWNER)
    expect(lastHumanChatId(join(d, 'missing.json'))).toBeNull()
  })
})

describe('the owner gets the result once, in place of the greeting', () => {
  test('a /start with the file waiting: the result goes out, the greeting claim is taken', async () => {
    const d = stateDir({ token: TOKEN, text: 'Your plan:\n1. a\n2. b' })
    const { r, sent, claims } = rig(d)
    expect(await r.deliver(OWNER)).toBe('sent')
    expect(sent).toEqual([{ chat: OWNER, text: 'Your plan:\n1. a\n2. b' }])
    expect(claims.claim(OWNER)).toBe(false) // a /start queued behind it greets nobody
    expect(existsSync(join(d, FIRST_REPLY_FILE))).toBe(false)
    expect(readFirstReplyState(d)?.token).toBe(TOKEN)
    expect(await r.deliver(OWNER)).toBe('none') // the second /start: back to greeting rules
    expect(sent.length).toBe(1)
  })
  test('nothing waiting: none, and the claim is untouched for the greeting', async () => {
    const { r, claims } = rig(stateDir())
    expect(await r.deliver(OWNER)).toBe('none')
    expect(claims.claim(OWNER)).toBe(true)
  })
  test('a greeting sent seconds ago does not hold the result back', async () => {
    const d = stateDir({ token: TOKEN, text: 'result' })
    const { r, sent, claims } = rig(d)
    expect(claims.claim(OWNER)).toBe(true) // the boot greeting
    expect(await r.deliver(OWNER)).toBe('sent')
    expect(sent.length).toBe(1)
  })
  test('a long result goes out as several messages, all before the file is dropped', async () => {
    const d = stateDir({ token: TOKEN, text: 'x'.repeat(TG_TEXT_LIMIT * 2 + 5) })
    const { r, sent } = rig(d)
    expect(await r.deliver(OWNER)).toBe('sent')
    expect(sent.map(s => s.text.length)).toEqual([TG_TEXT_LIMIT, TG_TEXT_LIMIT, 5])
  })
  test('a failed send (403) releases the claim and keeps the file for the next /start', async () => {
    const d = stateDir({ token: TOKEN, text: 'result' })
    let fail = true
    const { r, sent, claims } = rig(d, { fail: () => fail })
    expect(await r.deliver(OWNER)).toBe('failed')
    expect(existsSync(join(d, FIRST_REPLY_FILE))).toBe(true)
    expect(readFirstReplyState(d)).toBeNull()
    expect(claims.claim(OWNER)).toBe(true)
    claims.release(OWNER)
    fail = false
    expect(await r.deliver(OWNER)).toBe('sent')
    expect(sent.length).toBe(1)
  })
  test('the poll and a /start landing together send it once', async () => {
    const d = stateDir({ token: TOKEN, text: 'result' })
    const { r, sent } = rig(d)
    const [a, b] = await Promise.all([r.poll(OWNER), r.deliver(OWNER)])
    expect([a, b].sort()).toEqual(['busy', 'sent'])
    expect(sent.length).toBe(1)
  })
})

describe('the poll', () => {
  test('at most every 20 s', () => expect(FIRST_REPLY_POLL_MS).toBeLessThanOrEqual(20_000))
  test('the owner has not opened the bot (no last-human-chat): nothing', async () => {
    const d = stateDir({ token: TOKEN, text: 'result' })
    const { r, sent } = rig(d)
    expect(await r.poll(null)).toBe('none')
    expect(sent).toEqual([])
  })
  test('the last human chat is the owner: sent unasked', async () => {
    const { r, sent } = rig(stateDir({ token: TOKEN, text: 'result' }))
    expect(await r.poll(OWNER)).toBe('sent')
    expect(sent).toEqual([{ chat: OWNER, text: 'result' }])
  })
  test('a 403 keeps the file and rests the poll, but not a /start', async () => {
    let t = 1_000
    let fail = true
    const d = stateDir({ token: TOKEN, text: 'result' })
    const { r, sent } = rig(d, { fail: () => fail, now: () => t })
    expect(await r.poll(OWNER)).toBe('failed')
    t += FIRST_REPLY_POLL_MS
    fail = false
    expect(await r.poll(OWNER)).toBe('none')
    t += FIRST_REPLY_POLL_BACKOFF_MS
    expect(await r.poll(OWNER)).toBe('sent')
    expect(sent.length).toBe(1)
  })
})

describe('secondAt from the next inbound', () => {
  test("the owner's next message stamps it; a guest's does not", async () => {
    const d = stateDir({ token: TOKEN, text: 'result' })
    let t = Date.parse('2026-10-08T10:00:00Z')
    const { r } = rig(d, { now: () => t })
    r.noteInbound(OWNER) // before the result: nothing to stamp
    expect(readFirstReplyState(d)).toBeNull()
    await r.deliver(OWNER)
    t += 60_000
    r.noteInbound('88')
    expect(readFirstReplyState(d)?.secondAt).toBeUndefined()
    r.noteInbound(OWNER)
    t += 60_000
    r.noteInbound(OWNER)
    expect(readFirstReplyState(d)).toEqual({ token: TOKEN, startAt: '2026-10-08T10:00:00.000Z', secondAt: '2026-10-08T10:01:00.000Z' })
  })
})

describe('the fj- payload', () => {
  test('the "Open <Name>" button payload is recognised; any other payload is not', () => {
    expect(isFirstJobPayload(liteStartPayload(`/start fj-${TOKEN}`))).toBe(true)
    expect(isFirstJobPayload(liteStartPayload(`/start@agent_bot fj-${TOKEN}`))).toBe(true)
    expect(isFirstJobPayload(liteStartPayload('/start ref123'))).toBe(false)
    expect(isFirstJobPayload(liteStartPayload('/start'))).toBe(false)
  })
})

/** The lite /start arm: result first, and an fj- payload never reaches handleInbound. */
function liteArmWired(src: string): boolean {
  const lite = src.slice(src.indexOf('async function liteCommand('))
  const arm = lite.slice(lite.indexOf("if (cmd === 'start')"), lite.indexOf("if (cmd === 'usage')"))
  const deliver = arm.indexOf('await firstReplier.deliver(chatId)')
  const fjGuard = arm.indexOf('if (firstJob) return')
  const inbound = arm.indexOf('await handleInbound(ctx, text, undefined)')
  return deliver > -1 && deliver < arm.indexOf('greetClaims.claim(chatId)')
    && fjGuard > -1 && fjGuard < inbound
    && /const firstJob = isFirstJobPayload\(liteStartPayload\(text\)\)\n\s*if \(firstJob\) text = '\/start'/.test(arm)
}
/** The default /start, bootGreet, handleInbound and the poller all go through firstReplier. */
function restWired(src: string): boolean {
  const def = src.slice(src.indexOf('  start: async (ctx, { access, senderId }) => {'))
  const defArm = def.slice(0, def.indexOf('\n  help:'))
  const boot = src.slice(src.indexOf('async function bootGreet('), src.indexOf('async function liteCommand('))
  const inbound = src.slice(src.indexOf('async function handleInbound('))
  const onStart = src.slice(src.indexOf('onStart: info => {'), src.indexOf('return // bot.stop() was called'))
  return defArm.indexOf('await firstReplier.deliver(chat)') > -1
    && defArm.indexOf('await firstReplier.deliver(chat)') < defArm.indexOf('greetClaims.claim(chat)')
    && boot.indexOf('await firstReplier.deliver(owner)') > -1
    && boot.indexOf('await firstReplier.deliver(owner)') < boot.indexOf('greetClaims.claim(owner)')
    && inbound.slice(0, inbound.indexOf('checkDemoKey')).includes('firstReplier.noteInbound(chat_id)')
    && /setInterval\([\s\S]*?firstReplier\.poll\(lastHumanChatId\(LAST_HUMAN_CHAT_FILE\)\)[\s\S]*?FIRST_REPLY_POLL_MS\)/.test(onStart)
    && /owners: \(\) => firstReplyOwners\(loadAccess\(\)\)/.test(src)
}

describe('server.ts', () => {
  test('the lite /start sends the result first and keeps fj- from the model', () => expect(liteArmWired(SERVER)).toBe(true))
  test('the default /start, the boot greeting, inbound and the poll are wired', () => expect(restWired(SERVER)).toBe(true))
  test('negative control: the checks go red without the wiring', () => {
    expect(liteArmWired(SERVER.replace('if (firstJob) return', ''))).toBe(false)
    expect(liteArmWired(SERVER.replace("if (firstJob) text = '/start'", ''))).toBe(false)
    expect(restWired(SERVER.split('await firstReplier.deliver(chat)').join('noop()'))).toBe(false)
    expect(restWired(SERVER.replace('firstReplier.noteInbound(chat_id)', ''))).toBe(false)
  })
})
