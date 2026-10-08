// DIVE-5867: a bug report from an OSS box (host `harmony`, plugin 0.5.90). The
// DIVE-5368 migration seeded `owners` with EVERY allowFrom id, so a client the
// owner had let DM the agent became an owner, and an owner's group add is
// approved at once (admitOnJoin): the client could put the agent in any group.
//
//   1. The seed is the first paired user only (allowFrom keeps pairing order).
//   2. A record the old seed wrote (no `ownersSeed`) is trimmed ONCE, to the
//      first paired user it held; afterwards it only grows by pairing.
//   3. Either decision names the ids it left out, for the operator.
//   4. A chat_id that is really a message id is refused with a text that says so.
//
// server.ts long-polls Telegram on import, so it is read as TEXT; groupjoin.ts
// and chatguard.ts are pure and imported.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitOnJoin, nextOwners, OWNERS_SEED } from '../plugins/telegram/groupjoin'
import { notAllowlistedMessage } from '../plugins/telegram/chatguard'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const OWNER = '1234567890'
const CLIENT = '1234567891'

describe('the seed: first paired user only', () => {
  test('the reported box: owner then client in allowFrom → only the owner is seeded', () => {
    const p = nextOwners(undefined, undefined, [OWNER, CLIENT], [])!
    expect(p.owners).toEqual([OWNER])
    expect(p.seed).toBe(OWNERS_SEED)
    expect(p.note).toContain(`owner = ${OWNER}`)
    expect(p.note).toContain(`NOT owners: ${CLIENT}`)
  })
  test('groups and junk in allowFrom are never the owner', () => {
    expect(nextOwners(undefined, undefined, ['-100500', 'x', OWNER, CLIENT], [])!.owners).toEqual([OWNER])
  })
  test('an empty allowFrom seeds an empty record (the app needs it to exist)', () => {
    const p = nextOwners(undefined, undefined, [], [])!
    expect(p.owners).toEqual([])
    expect(p.note).toContain('nobody yet')
  })
  test('one paired user: seeded, nobody listed as left out', () => {
    expect(nextOwners(undefined, undefined, [OWNER], [])!.note).not.toContain('NOT owners')
  })
  test('a pairing seen on the same pass as the seed is a DM user, and the note says so', () => {
    const p = nextOwners(undefined, undefined, [OWNER, CLIENT, '777'], ['777'])!
    expect(p.owners).toEqual([OWNER])
    expect(p.note).toContain('paired 777 as DM users, not owners')
  })
})

describe('after the seed, pairing does not make owners (the OSS skill pairs clients the same way)', () => {
  test('a client paired later through /telegram:access is a DM user; the note names them and the way to promote', () => {
    const p = nextOwners([OWNER], OWNERS_SEED, [OWNER, CLIENT], [CLIENT])!
    expect(p.owners).toEqual([OWNER])
    expect(p.note).toContain(`paired ${CLIENT} as DM users, not owners (owner: ${OWNER})`)
    expect(p.note).toContain('/telegram:access owner add <id>')
  })
  test('a record with no owner takes the first one paired, and only that one', () => {
    expect(nextOwners([], OWNERS_SEED, [OWNER, CLIENT], [OWNER, CLIENT])!.owners).toEqual([OWNER])
  })
  test('an owner re-pairing (already recorded) writes nothing', () => {
    expect(nextOwners([OWNER], OWNERS_SEED, [OWNER], [OWNER])).toBeNull()
  })
  test('an owner added on purpose (owner add) stays', () => {
    expect(nextOwners([OWNER, CLIENT], OWNERS_SEED, [OWNER, CLIENT], [])).toBeNull()
  })
  test('the access skill documents owner add/rm and stamps ownersSeed so the trim does not undo it', () => {
    const skill = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'skills', 'access', 'SKILL.md'), 'utf8')
    expect(skill).toContain('### `owner add <senderId>` / `owner rm <senderId>`')
    expect(skill).toContain('set `ownersSeed` to `2`')
    expect(OWNERS_SEED).toBe(2)
  })
})

describe('an already-seeded box is corrected once', () => {
  test('the reported record ["owner","client"] with no ownersSeed → ["owner"], stamped', () => {
    const p = nextOwners([OWNER, CLIENT], undefined, [OWNER, CLIENT], [])!
    expect(p.owners).toEqual([OWNER])
    expect(p.seed).toBe(OWNERS_SEED)
    expect(p.note).toContain('trimmed')
    expect(p.note).toContain(CLIENT)
  })
  test('and the next pass leaves it alone', () => {
    expect(nextOwners([OWNER], OWNERS_SEED, [OWNER, CLIENT], [])).toBeNull()
  })
  test('a single-owner legacy record keeps its owner and is only stamped', () => {
    const p = nextOwners([OWNER], undefined, [CLIENT, OWNER], [])!
    expect(p.owners).toEqual([OWNER])
    expect(p.note).not.toContain('NOT owners')
  })
  test('the trim never promotes someone the old record did not hold', () => {
    // CLIENT paired first but the app added them after the seed: not an owner then, not now.
    expect(nextOwners([OWNER], undefined, [CLIENT, OWNER], [])!.owners).toEqual([OWNER])
    expect(nextOwners([], undefined, [CLIENT], [])!.owners).toEqual([])
  })
  test('an owner no longer in allowFrom is not kept, and not listed as a DM user', () => {
    const p = nextOwners(['5550123', OWNER, CLIENT], undefined, [OWNER, CLIENT], [])!
    expect(p.owners).toEqual([OWNER])
    expect(p.note).not.toContain('5550123')
  })
})

describe('the consequence the report is about', () => {
  test('after the trim, a group the client adds is NOT approved; the owner\'s still is', () => {
    const owners = nextOwners([OWNER, CLIENT], undefined, [OWNER, CLIENT], [])!.owners
    const a = { owners, allowFrom: [OWNER, CLIENT], groups: {} as Record<string, unknown> }
    expect(admitOnJoin(a, '-1001', { id: Number(CLIENT) })).toBe(false)
    expect('-1001' in a.groups).toBe(false)
    expect(admitOnJoin(a, '-1002', { id: Number(OWNER) })).toBe(true)
  })
  test('server logs the decision with the access file path', () => {
    const r = SERVER.slice(SERVER.indexOf('function recordOwners('), SERVER.indexOf('\nrecordOwners()\n'))
    expect(r).toContain('if (next.note) process.stderr.write(`telegram channel: ${next.note} (${ACCESS_FILE})\\n`)')
  })
})

describe('a message id passed as chat_id', () => {
  test('the reported call (chat 979, message 979) says it looks like a message_id', () => {
    const m = notAllowlistedMessage('979', '979')
    expect(m).toContain('looks like a message_id')
    expect(m).toContain("equals this call's message id")
    expect(m).toContain('not allowlisted')
  })
  test('a short id with no message id still gets the hint', () => {
    expect(notAllowlistedMessage('42')).toContain('looks like a message_id')
  })
  test('a real-looking user or group id keeps the plain access text', () => {
    expect(notAllowlistedMessage(CLIENT, '979')).toBe(`chat ${CLIENT} is not allowlisted — add via /telegram:access`)
    expect(notAllowlistedMessage('-1001234567890')).toBe('chat -1001234567890 is not allowlisted — add via /telegram:access')
  })
  test('server passes the call\'s message id on reply, react and edit_message', () => {
    expect(SERVER).toContain('throw new Error(notAllowlistedMessage(chat_id, messageId))')
    expect(SERVER).toContain('assertAllowedChat(chat_id, args.reply_to as string | undefined)')
    expect(SERVER).toContain('assertAllowedChat(args.chat_id as string, args.message_id as string | undefined)')
    expect(SERVER).toContain('assertAllowedChat(chat_id, args.message_id as string | undefined)')
  })
})
