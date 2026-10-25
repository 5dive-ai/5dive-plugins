// DIVE-6930: the owner lets someone talk to the agent from chat. The agent
// PROPOSES (access_request); only the owner's tap, or the owner's pick on
// Telegram's pick-a-person button, applies it, in plugin code.
//
// Negative controls the row names:
//   - the agent told "add @x" by anything (a planted email, a web page) gets at
//     most a button: the tool's path never writes access.json;
//   - a tap from a non-owner allowFrom user does nothing;
//   - the name the owner reads comes from Telegram, never from the agent.
//
// server.ts long-polls Telegram on import, so it is read as TEXT (as in
// dive5368-share-agent.test.ts); accessreq.ts is pure and imported.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAccessTap, ownerIds, isOwner, guestIds, resolveTarget, planTap, applyAdd, applyRemove,
  personLabel, readStore, writeStore, pruneStore, findOpen, openCount, newRequestId, newPickId,
  ACCESS_STRINGS, agentNote, type AccessLike, type AccessRequest,
} from '../plugins/telegram/accessreq'
import { standardSeatMayHold, TELEGRAM_OPEN_PROBE_ARGV } from '../plugins/telegram/seatpriv'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const LEAK = /5dive|claude|anthropic|openrouter|\bmodel|token|context|server|\bbox\b|\bcost|\$|сервер|токен|модел|контекст/i
const NOW = 1_800_000_000_000
const OWNER = '1111111111'
const GUEST = '2222222222'
const MASHA = '3333333333'

function access(over: Partial<AccessLike> = {}): AccessLike {
  return {
    allowFrom: [OWNER, GUEST],
    owners: [OWNER],
    pending: {
      abc123: { senderId: MASHA, chatId: MASHA, expiresAt: NOW + 3_600_000, name: 'Masha', username: 'masha_k' },
    },
    ...over,
  }
}
function req(over: Partial<AccessRequest> = {}): AccessRequest {
  return { id: 'aaaaaaaaaaaa', op: 'add', person: { userId: MASHA, name: 'Masha', username: 'masha_k' }, createdAt: NOW, expiresAt: NOW + 1000, ...over }
}
// The slice of server.ts between two markers, so a check reads one handler.
function between(from: string, to: string): string {
  const a = SERVER.indexOf(from)
  const b = SERVER.indexOf(to, a + from.length)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return SERVER.slice(a, b)
}
function fnBody(name: string): string {
  const a = SERVER.indexOf(`function ${name}(`)
  expect(a).toBeGreaterThan(-1)
  const b = SERVER.indexOf('\n}\n', a)
  return SERVER.slice(a, b)
}

describe('the button grammar', () => {
  test('acc:<12hex>:y|n|g<idx> parses; anything else acc: is ours and malformed', () => {
    expect(parseAccessTap('acc:0123456789ab:y')).toEqual({ id: '0123456789ab', verb: 'y' })
    expect(parseAccessTap('acc:0123456789ab:n')).toEqual({ id: '0123456789ab', verb: 'n' })
    expect(parseAccessTap('acc:0123456789ab:g3')).toEqual({ id: '0123456789ab', verb: 'g', idx: 3 })
    expect(parseAccessTap('acc:0123456789ab:add')).toBe('malformed')
    expect(parseAccessTap(`acc:${MASHA}:y`)).toBe('malformed')
    expect(parseAccessTap('yn:yes')).toBeNull()
    expect(`acc:${newRequestId()}:g7`.length).toBeLessThanOrEqual(64)
    expect(parseAccessTap(`acc:${newRequestId()}:y`)).not.toBe('malformed')
    const pick = newPickId()
    expect(Number.isInteger(pick) && pick > 0 && pick <= 0x7fffffff).toBe(true)
  })
})

describe('who decides: the owners record, never all of allowFrom', () => {
  test('owners within allowFrom; a guest in allowFrom is not an owner', () => {
    expect(ownerIds(access())).toEqual([OWNER])
    expect(isOwner(access(), GUEST)).toBe(false)
    expect(guestIds(access())).toEqual([GUEST])
  })
  test('no owners record yet: the first paired user only (the DIVE-5867 seed)', () => {
    expect(ownerIds(access({ owners: undefined }))).toEqual([OWNER])
  })
  test('an owner who is no longer in allowFrom decides nothing', () => {
    expect(isOwner(access({ allowFrom: [GUEST] }), OWNER)).toBe(false)
  })
})

describe('who is meant comes from Telegram', () => {
  test('empty or "last": the newest person who tried to write', () => {
    expect(resolveTarget('', access(), {}, NOW)).toEqual({ kind: 'person', person: { userId: MASHA, name: 'Masha', username: 'masha_k' } })
    expect(resolveTarget(undefined, access(), {}, NOW).kind).toBe('person')
    expect(resolveTarget('last', access({ pending: {} }), {}, NOW)).toEqual({ kind: 'unknown' })
  })
  test('an @username a pending entry carries resolves to that sender, case-insensitively', () => {
    expect(resolveTarget('@Masha_K', access(), {}, NOW)).toEqual({ kind: 'person', person: { userId: MASHA, name: 'Masha', username: 'masha_k' } })
  })
  test('an expired pending entry is not used', () => {
    const a = access()
    a.pending.abc123!.expiresAt = NOW - 1
    expect(resolveTarget('@masha_k', a, {}, NOW)).toEqual({ kind: 'unknown' })
  })
  test('an @username nobody here has seen: the owner picks the person', () => {
    expect(resolveTarget('@stranger_x', access(), {}, NOW)).toEqual({ kind: 'unknown' })
  })
  test('someone let in this way before is known by username for a later remove', () => {
    expect(resolveTarget('@lena_p', access(), { [GUEST]: { name: 'Lena', username: 'lena_p' } }, NOW))
      .toEqual({ kind: 'person', person: { userId: GUEST, name: 'Lena', username: 'lena_p' } })
  })
  test('a bare id with nothing known: the server asks getChat', () => {
    expect(resolveTarget('4444444444', access(), {}, NOW)).toEqual({ kind: 'id', userId: '4444444444' })
  })
  test('anything else is refused', () => {
    expect(resolveTarget('Masha', access(), {}, NOW).kind).toBe('unknown') // a 5+ char word reads as a handle
    expect(resolveTarget('-100123', access(), {}, NOW).kind).toBe('invalid')
    expect(resolveTarget('rm -rf', access(), {}, NOW).kind).toBe('invalid')
  })
  test('the tool takes no name at all: its schema has who and action only', () => {
    const tool = between("name: 'access_request',", "name: 'edit_message',")
    expect(tool).toContain('who:')
    expect(tool).toContain('action:')
    expect(tool).not.toMatch(/\bname:\s*\{/)
  })
})

describe('a tap', () => {
  test('NEGATIVE CONTROL: a non-owner allowFrom user tapping Allow changes nothing', () => {
    expect(planTap({ id: 'aaaaaaaaaaaa', verb: 'y' }, req(), access(), {}, GUEST, NOW)).toEqual({ kind: 'not_owner' })
  })
  test("the owner's Allow adds the person the REQUEST stored", () => {
    expect(planTap({ id: 'aaaaaaaaaaaa', verb: 'y' }, req(), access(), {}, OWNER, NOW))
      .toEqual({ kind: 'add', person: { userId: MASHA, name: 'Masha', username: 'masha_k' } })
  })
  test('No declines; a missing or expired request is expired', () => {
    expect(planTap({ id: 'aaaaaaaaaaaa', verb: 'n' }, req(), access(), {}, OWNER, NOW)).toEqual({ kind: 'decline' })
    expect(planTap({ id: 'aaaaaaaaaaaa', verb: 'y' }, undefined, access(), {}, OWNER, NOW)).toEqual({ kind: 'expired' })
    expect(planTap({ id: 'aaaaaaaaaaaa', verb: 'y' }, req({ expiresAt: NOW }), access(), {}, OWNER, NOW)).toEqual({ kind: 'expired' })
  })
  test("a guest button removes the id it named when sent, and only while that id is still a guest", () => {
    const r = req({ op: 'remove', person: undefined, guests: [GUEST] })
    expect(planTap({ id: r.id, verb: 'g', idx: 0 }, r, access(), {}, OWNER, NOW)).toEqual({ kind: 'remove', person: { userId: GUEST } })
    // allowFrom changed since: index 0 is now someone else; the stored id is gone.
    expect(planTap({ id: r.id, verb: 'g', idx: 0 }, r, access({ allowFrom: [OWNER, MASHA] }), {}, OWNER, NOW)).toEqual({ kind: 'expired' })
    expect(planTap({ id: r.id, verb: 'g', idx: 5 }, r, access(), {}, OWNER, NOW)).toEqual({ kind: 'expired' })
    // a guest button on an add request is not a remove
    expect(planTap({ id: r.id, verb: 'g', idx: 0 }, req({ guests: [GUEST] }), access(), {}, OWNER, NOW)).toEqual({ kind: 'expired' })
  })
  test('an add with no stored person (a pick request) cannot be applied by a y tap', () => {
    expect(planTap({ id: 'aaaaaaaaaaaa', verb: 'y' }, req({ person: undefined, pickId: 7 }), access(), {}, OWNER, NOW)).toEqual({ kind: 'expired' })
  })
})

describe('the edit', () => {
  test('add: into allowFrom once, and the pending entry is dropped (never pair: no owner is made)', () => {
    const a = access()
    expect(applyAdd(a, MASHA)).toBe('added')
    expect(a.allowFrom).toEqual([OWNER, GUEST, MASHA])
    expect(a.owners).toEqual([OWNER])
    expect(a.pending).toEqual({})
    expect(applyAdd(a, MASHA)).toBe('already')
    expect(a.allowFrom.filter(x => x === MASHA).length).toBe(1)
  })
  test('remove: a guest goes; an owner never does', () => {
    const a = access()
    expect(applyRemove(a, OWNER)).toBe('owner')
    expect(a.allowFrom).toContain(OWNER)
    expect(applyRemove(a, GUEST)).toBe('removed')
    expect(a.allowFrom).toEqual([OWNER])
    expect(applyRemove(a, GUEST)).toBe('absent')
  })
})

describe('the store', () => {
  test('round-trips, prunes expired asks, finds an open duplicate, counts open asks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-'))
    try {
      const file = join(dir, 'sub', 'access-requests.json')
      expect(readStore(file)).toEqual({ requests: {}, known: {} })
      const s = readStore(file)
      s.requests.a = req({ id: 'a' })
      s.requests.b = req({ id: 'b', expiresAt: NOW - 1 })
      writeStore(file, s)
      const t = readStore(file)
      pruneStore(t, NOW)
      expect(Object.keys(t.requests)).toEqual(['a'])
      expect(findOpen(t, 'add', MASHA, NOW)?.id).toBe('a')
      expect(findOpen(t, 'remove', MASHA, NOW)).toBeUndefined()
      expect(openCount(t, NOW)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('strings', () => {
  test('neutral (a lite box shows them too), ru and en carry the same keys', () => {
    expect(Object.keys(ACCESS_STRINGS.ru).sort()).toEqual(Object.keys(ACCESS_STRINGS.en).sort())
    for (const lang of ['ru', 'en'] as const) {
      for (const v of Object.values(ACCESS_STRINGS[lang])) {
        const text = typeof v === 'function' ? (v as (w: string) => string)('Masha (@masha_k)') : v
        expect(text).not.toMatch(LEAK)
        expect(text.length).toBeLessThan(200)
      }
    }
    expect(ACCESS_STRINGS.ru.allow).toBe('Разрешить')
  })
  test("a label is Telegram's name and username, else the id", () => {
    expect(personLabel({ userId: MASHA, name: 'Masha', username: 'masha_k' })).toBe('Masha (@masha_k)')
    expect(personLabel({ userId: MASHA })).toBe(MASHA)
  })
  test("the agent's note says the owner decided and never that the agent did", () => {
    expect(agentNote('added', { userId: MASHA, name: 'Masha' }, true)).toMatch(/^\[access\] Your owner tapped Allow/)
    expect(agentNote('added', { userId: MASHA }, false)).toContain('the owner was told how')
    expect(agentNote('declined', undefined, null)).toContain('Nothing changed')
  })
})

describe('server wiring', () => {
  test('NEGATIVE CONTROL: the tool path never writes access.json and never applies', () => {
    const tool = between("case 'access_request': {", "case 'download_attachment': {")
    expect(tool).toContain('proposeAccess(args)')
    const propose = fnBody('proposeAccess')
    for (const banned of ['saveAccess', 'applyAdd', 'applyRemove', 'applyAccessDecision', 'ACCESS_FILE', 'openOwnBotLock', '_telegram_open']) {
      expect(propose).not.toContain(banned)
    }
    // It only reads access and sends the owner a message.
    expect(propose).toContain('loadAccess()')
    expect(propose).toContain('bot.api.sendMessage(ownerChat')
  })
  test('the only callers of the apply step are the tap handler and the pick handler', () => {
    const calls = [...SERVER.matchAll(/await applyAccessDecision\(/g)].map(m => m.index!)
    expect(calls.length).toBe(2)
    const tap = SERVER.indexOf('async function handleAccessTap(')
    const pick = SERVER.indexOf("bot.on('message:users_shared'")
    const inTap = (i: number) => i > tap && i < SERVER.indexOf('\n}\n', tap)
    const inPick = (i: number) => i > pick && i < SERVER.indexOf('\n})\n', pick)
    expect(calls.every(i => inTap(i) || inPick(i))).toBe(true)
    // applyAdd/applyRemove appear only inside applyAccessDecision.
    const dec = fnBody('applyAccessDecision')
    const adds = [...SERVER.matchAll(/applyAdd\(|applyRemove\(/g)].length
    expect(adds).toBe([...dec.matchAll(/applyAdd\(|applyRemove\(/g)].length)
  })
  test('the tap handler decides with planTap on a FRESH access read and the tapper Telegram says', () => {
    const h = fnBody('handleAccessTap')
    expect(h).toContain('planTap(tap, store.requests[tap.id], readAccessFile(), store.known, senderId, Date.now())')
    // not_owner answers and returns before anything is edited or applied
    const notOwner = h.indexOf("plan.kind === 'not_owner'")
    expect(notOwner).toBeGreaterThan(-1)
    expect(notOwner).toBeLessThan(h.indexOf('applyAccessDecision'))
    expect(notOwner).toBeLessThan(h.indexOf('editMessageReplyMarkup'))
  })
  test('the router reaches the tap handler after the allowFrom check and before the bridge into the agent', () => {
    const router = between("bot.on('callback_query:data', async ctx => {", "[callback_query data=${data}]")
    const allow = router.indexOf('access.allowFrom.includes(senderId)')
    const ours = router.indexOf('parseAccessTap(data)')
    expect(allow).toBeGreaterThan(-1)
    expect(ours).toBeGreaterThan(allow)
    expect(router.indexOf('handleAccessTap(ctx, accessTap, senderId)')).toBeGreaterThan(ours)
    // first of the special buttons: nothing before it can hand acc: to the agent
    expect(ours).toBeLessThan(router.indexOf('parseConnectTap(data)'))
  })
  test("a pick applies only from an owner, in a private chat, for that request's pick id", () => {
    const pick = between("bot.on('message:users_shared'", "bot.on('message:text'")
    const priv = pick.indexOf("ctx.chat.type !== 'private'")
    const owner = pick.indexOf('isOwner(access, String(from.id))')
    const apply = pick.indexOf('applyAccessDecision(')
    expect(priv).toBeGreaterThan(-1)
    expect(owner).toBeGreaterThan(priv)
    expect(apply).toBeGreaterThan(owner)
    expect(pick).toContain('r.pickId === shared.request_id')
    expect(pick).toContain('remove_keyboard: true')
  })
  test('the pick button asks for one human, never a bot', () => {
    expect(fnBody('proposeAccess')).toContain('request_users: { request_id: req.pickId!, user_is_bot: false, max_quantity: 1')
  })
  test("the lock is lifted with the seat's exact no-args line, after the add", () => {
    const lock = fnBody('openOwnBotLock')
    expect(lock).toContain("sudo5dive(['5dive', 'agent', '_telegram_open'], { timeout: 30_000 })")
    expect(standardSeatMayHold(['5dive', 'agent', '_telegram_open'])).toBe(true)
    expect(standardSeatMayHold(['5dive', 'agent', '_telegram_open', 'other'])).toBe(false)
    expect(TELEGRAM_OPEN_PROBE_ARGV).toEqual(['-n', '-l', '/usr/local/bin/5dive', 'agent', '_telegram_open'])
    const dec = fnBody('applyAccessDecision')
    expect(dec.indexOf('saveAccess(fresh)')).toBeLessThan(dec.indexOf('openOwnBotLock()'))
    expect(dec).toContain("r === 'added' ? await openOwnBotLock() : null")
  })
  test('static and team-bot modes refuse instead of sending a button nobody can apply', () => {
    const propose = fnBody('proposeAccess')
    expect(propose).toContain('if (STATIC) throw')
    expect(propose).toContain('if (SEND_ONLY) throw')
  })
  test('the channel instructions name the tool and the tap', () => {
    expect(SERVER).toContain('call access_request. It only sends your owner a button; nothing changes until they tap it')
  })
})
