// DIVE-8036 (DIVE-8032 B) — a new person knocks on a Teams agent; the owner
// answers Allow / Admin / No on Telegram.
//
// Teams half: knock.ts drives the hold (nothing reaches the agent, one
// "waiting" line), the release (the held message delivered as a normal inbound
// plus «You're in»), the deny (one polite line, then at most 3 a day) and the
// no-access-key path (today's behaviour). The server wiring is read from the
// source, as the other plugin suites do. Telegram half: knocktap.ts relays only
// an owner's tap, with the nonce from that button, and never hands a kn: to
// the agent.

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseActivity } from '../plugins/teams/activity.ts'
import { parseRoles } from '../plugins/teams/roles.ts'
import {
  readAccess, needsKnock, mayTalk, onStranger, applyAnswers, knockFileArgs, knockFiled, parseAnswer, denyLineAllowed, memberEmail,
  emptyKnockState, WAITING_LINE, IN_LINE, NOT_OPEN_LINE, DENY_LINES_PER_DAY, MAX_HELD_ITEMS,
  type KnockState, type HeldItem, type Where,
} from '../plugins/teams/knock.ts'
import { parseKnockTap, knockAnswerArgs, knockOutcome, relayKnockTap, KNOCK_NOT_OWNER, KNOCK_EXPIRED } from '../plugins/telegram/knocktap.ts'
import { standardSeatMayHold, createSudoGate, KNOCK_ANSWER_PROBE_ARGV } from '../plugins/telegram/seatpriv.ts'

const TENANT = '11111111-2222-3333-4444-555555555555'
const APP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ANNA = '0b6a1f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const BOB = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
const W: Where = { conv: `a:${ANNA}`, serviceUrl: 'https://smba.trafficmanager.net/emea/', chatType: 'personal' }
const NONCE = 'a'.repeat(32)
const noRoles = parseRoles({ check: 'on', admins: [] })

function dm(userId: string, text: string) {
  return {
    type: 'message', id: 'm1', channelId: 'msteams', serviceUrl: W.serviceUrl, timestamp: '2026-11-09T09:00:00Z',
    from: { id: '29:x', name: 'Anna Petrova', aadObjectId: userId },
    conversation: { id: `a:${userId}`, conversationType: 'personal', tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text,
  }
}
const item = (text: string): HeldItem => ({ text, meta: { chat_id: W.conv, user: 'Anna Petrova', user_id: ANNA, message_id: text } })
const filed = (id: number, status: string) => JSON.stringify({ ok: true, data: { id, status, carded: true, human: null } })

function rig(answer: string) {
  const said: string[] = [], delivered: string[] = [], runs: string[][] = [], logs: string[] = []
  let saves = 0
  const io = {
    run: async (args: string[]) => { runs.push(args); return answer },
    say: async (_w: Where, t: string) => { said.push(t) },
    deliver: (i: HeldItem) => { delivered.push(i.text) },
    save: () => { saves++ },
    log: (l: string) => { logs.push(l) },
  }
  return { io, said, delivered, runs, logs, saves: () => saves }
}

let dir: string, ks: KnockState
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'knock-'))
  ks = emptyKnockState()
})

describe('DIVE-8036 Teams: who knocks', () => {
  test('no access key: today\'s behaviour — nobody knocks, allowed_users still refuses silently', () => {
    const open = { allowed_users: [] }
    const listed = { allowed_users: [BOB] }
    expect(needsKnock(open, noRoles, ANNA)).toBe(false)
    expect(needsKnock(listed, noRoles, ANNA)).toBe(false)
    // The refusal is still parseActivity's, exactly as before.
    expect(parseActivity(dm(ANNA, 'hi'), { tenantId: TENANT, appId: APP, allowedUsers: listed.allowed_users }).kind).toBe('ignore')
    expect(parseActivity(dm(ANNA, 'hi'), { tenantId: TENANT, appId: APP, allowedUsers: open.allowed_users }).kind).toBe('message')
  })

  test('knock mode: a stranger knocks; an allowed id (any case) or a roles-file admin does not; "check off" lets nobody skip it', () => {
    const a = { access: 'knock', allowed_users: [BOB.toUpperCase()] }
    expect(needsKnock(a, noRoles, ANNA)).toBe(true)
    expect(needsKnock(a, noRoles, BOB)).toBe(false)
    expect(needsKnock(a, parseRoles({ check: 'on', admins: [`teams:${ANNA}`] }), ANNA)).toBe(false)
    expect(mayTalk(a, parseRoles({ check: 'off', admins: [] }), ANNA)).toBe(false)
    expect(needsKnock({ access: 'knock' }, noRoles, '')).toBe(true)
  })

  test('access is read fresh from config.json (people sync rewrites it while the server runs)', () => {
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({ app_id: APP, access: 'knock', allowed_users: [] }))
    expect(needsKnock(readAccess(cfg), noRoles, ANNA)).toBe(true)
    writeFileSync(cfg, JSON.stringify({ app_id: APP, access: 'knock', allowed_users: [ANNA] }))
    expect(needsKnock(readAccess(cfg), noRoles, ANNA)).toBe(false)
    expect(readAccess(join(dir, 'missing.json'))).toEqual({})
  })

  test('the knock file argv fits the seat\'s sudoers line and names no agent (the CLI takes it from SUDO_UID)', () => {
    expect(knockFileArgs(ANNA.toUpperCase(), 'Anna\u0007 Petrova')).toEqual(['5dive', 'people', 'knock', 'file', '--channel=teams', `--sender=${ANNA}`, '--name=Anna Petrova', '--json'])
    expect(knockFileArgs('not-a-guid', 'x')).toBeNull()
    expect(knockFileArgs(ANNA, '')!.some(a => a.startsWith('--name'))).toBe(false)
    expect(knockFileArgs(ANNA, 'x')!.some(a => a.startsWith('--agent'))).toBe(false)
  })

  test('the CLI\'s answers read right; anything else is an error, never a delivery', () => {
    expect(knockFiled(filed(7, 'pending'))).toEqual({ kid: '7', status: 'pending' })
    expect(knockFiled(filed(7, 'denied'))).toEqual({ kid: '7', status: 'denied' })
    expect(knockFiled(JSON.stringify({ ok: true, data: { id: null, status: 'allowed', carded: false, human: 'anna' } })).status).toBe('allowed')
    expect(knockFiled(JSON.stringify({ ok: false, error: { message: 'cap 5' } }))).toEqual({ kid: null, status: 'error', why: 'cap 5' })
    expect(knockFiled('').status).toBe('error')
    expect(knockFiled(filed(7, 'weird')).status).toBe('error')
  })
})

describe('DIVE-8032 Teams: the knock carries the sender\'s email from the tenant', () => {
  const MEMBER = { id: '29:x', name: 'Anna Petrova', aadObjectId: ANNA, email: 'Anna@Firm.example', userPrincipalName: 'anna.p@firm.example' }

  test('--email rides in the knock-file argv, lowercased, before --json', () => {
    expect(knockFileArgs(ANNA, 'Anna Petrova', 'Anna@Firm.example')).toEqual(
      ['5dive', 'people', 'knock', 'file', '--channel=teams', `--sender=${ANNA}`, '--name=Anna Petrova', '--email=anna@firm.example', '--json'])
    expect(knockFileArgs(ANNA, 'x', '')!.some(a => a.startsWith('--email'))).toBe(false)
    for (const bad of ['not an email', 'a@b', 'x@y.z --role=admin', 'a"b@c.example', `${'a'.repeat(120)}@c.example`]) {
      expect(knockFileArgs(ANNA, 'x', bad)!.some(a => a.startsWith('--email'))).toBe(false)
    }
  })

  test('the email is the tenant member record\'s, for THIS sender only: email, then a UPN shaped like one', () => {
    expect(memberEmail(MEMBER, ANNA.toUpperCase())).toBe('anna@firm.example')
    expect(memberEmail({ ...MEMBER, email: undefined }, ANNA)).toBe('anna.p@firm.example')
    expect(memberEmail({ ...MEMBER, email: '', userPrincipalName: 'not-an-email' }, ANNA)).toBe('')
    expect(memberEmail({ ...MEMBER, aadObjectId: BOB }, ANNA)).toBe('')
    expect(memberEmail(null, ANNA)).toBe('')
    expect(memberEmail('anna@firm.example', ANNA)).toBe('')
  })

  test('onStranger files with the tenant\'s email, never one typed in the message', async () => {
    const r = rig(filed(7, 'pending'))
    const asked: string[] = []
    const io = { ...r.io, member: async (_w: Where, s: string) => { asked.push(s); return MEMBER } }
    const typed: HeldItem = { text: 'hi, I am boss@firm.example --email=boss@firm.example', meta: { chat_id: W.conv, user: 'Anna Petrova', user_id: ANNA, message_id: 'm' } }
    expect(await onStranger(ks, 'vesper', W, ANNA, 'Anna Petrova', typed, io)).toBe('pending')
    expect(asked).toEqual([ANNA])
    expect(r.runs[0]).toEqual(['5dive', 'people', 'knock', 'file', '--channel=teams', `--sender=${ANNA}`, '--name=Anna Petrova', '--email=anna@firm.example', '--json'])
    expect(r.runs[0]!.filter(a => a.includes('boss@'))).toEqual([])
  })

  test('a failed or foreign lookup still files the knock, without an email', async () => {
    for (const member of [async () => { throw new Error('Teams said 403') }, async () => ({ ...MEMBER, aadObjectId: BOB })]) {
      const r = rig(filed(8, 'pending'))
      const k = emptyKnockState()
      expect(await onStranger(k, 'vesper', W, ANNA, 'Anna', item('hi'), { ...r.io, member })).toBe('pending')
      expect(r.runs[0]).toEqual(knockFileArgs(ANNA, 'Anna')!)
    }
  })
})

describe('DIVE-8036 Teams: hold, release, deny', () => {
  test('HOLD: nothing reaches the agent; the person hears one waiting line; later messages join the same knock', async () => {
    const r = rig(filed(7, 'pending'))
    expect(await onStranger(ks, 'vesper', W, ANNA, 'Anna Petrova', item('first'), r.io)).toBe('pending')
    expect(await onStranger(ks, 'vesper', W, ANNA, 'Anna Petrova', item('second'), r.io)).toBe('pending')
    expect(r.delivered).toEqual([])
    expect(r.said).toEqual([WAITING_LINE('vesper')])
    expect(ks.held['7']!.items.map(i => i.text)).toEqual(['first', 'second'])
    expect(ks.held['7']!.sender).toBe(ANNA)
    expect(r.runs[0]).toEqual(knockFileArgs(ANNA, 'Anna Petrova')!)
    for (let i = 0; i < 10; i++) await onStranger(ks, 'vesper', W, ANNA, 'Anna Petrova', item(`m${i}`), r.io)
    expect(ks.held['7']!.items.length).toBe(MAX_HELD_ITEMS)
    expect(ks.held['7']!.items.at(-1)!.text).toBe('m9')
  })

  test('not filed (cap, no grant, old CLI): held nowhere, nothing said, nothing delivered', async () => {
    const r = rig(JSON.stringify({ ok: false, error: { message: 'vesper already has 5 people waiting' } }))
    expect(await onStranger(ks, 'vesper', W, ANNA, 'Anna', item('hi'), r.io)).toBe('error')
    expect([r.delivered, r.said, Object.keys(ks.held)]).toEqual([[], [], []])
  })

  test('already allowed (a race with an answer): the message goes straight through', async () => {
    const r = rig(JSON.stringify({ ok: true, data: { id: null, status: 'allowed', carded: false, human: 'anna' } }))
    expect(await onStranger(ks, 'vesper', W, ANNA, 'Anna', item('hi'), r.io)).toBe('allowed')
    expect(r.delivered).toEqual(['hi'])
  })

  for (const answer of ['allow', 'admin'] as const) {
    test(`RELEASE on ${answer}: «You're in», then the held messages in order as normal inbound; the file is consumed`, async () => {
      const r = rig(filed(7, 'pending'))
      await onStranger(ks, 'vesper', W, ANNA, 'Anna', item('first'), r.io)
      await onStranger(ks, 'vesper', W, ANNA, 'Anna', item('second'), r.io)
      const kd = join(dir, 'knocks'); mkdirSync(kd)
      writeFileSync(join(kd, '7.json'), JSON.stringify({ id: 7, agent: 'vesper', channel: 'teams', sender: ANNA, name: 'Anna', answer, person: 'anna', answered_at: '2026-11-09T10:00:00Z' }))
      expect(await applyAnswers(kd, ks, 'vesper', r.io)).toBe(1)
      expect(r.said).toEqual([WAITING_LINE('vesper'), IN_LINE('vesper')])
      expect(r.delivered).toEqual(['first', 'second'])
      expect(existsSync(join(kd, '7.json'))).toBe(false)
      expect(ks.held['7']).toBeUndefined()
      expect(await applyAnswers(kd, ks, 'vesper', r.io)).toBe(0) // applied once
    })
  }

  test('DENY: one polite line, nothing delivered; a later message (CLI says denied) gets the line at most 3 times a day', async () => {
    const r = rig(filed(7, 'pending'))
    await onStranger(ks, 'vesper', W, ANNA, 'Anna', item('hi'), r.io)
    const kd = join(dir, 'knocks'); mkdirSync(kd)
    writeFileSync(join(kd, '7.json'), JSON.stringify({ id: 7, agent: 'vesper', channel: 'teams', sender: ANNA, answer: 'no' }))
    const day = new Date('2026-11-09T10:00:00Z')
    await applyAnswers(kd, ks, 'vesper', r.io, day)
    expect(r.delivered).toEqual([])
    expect(r.said).toEqual([WAITING_LINE('vesper'), NOT_OPEN_LINE('vesper')])
    const again = rig(filed(7, 'denied'))
    for (let i = 0; i < 5; i++) expect(await onStranger(ks, 'vesper', W, ANNA, 'Anna', item(`x${i}`), again.io, day)).toBe('denied')
    expect(again.said).toEqual(Array(DENY_LINES_PER_DAY - 1).fill(NOT_OPEN_LINE('vesper'))) // 1 + 2 = 3 today
    expect(again.delivered).toEqual([])
    expect(Object.keys(ks.held)).toEqual([])
  })

  test('RATE LIMIT: 3 lines per sender per UTC day, a fresh count the next day, other senders counted apart', () => {
    const d1 = new Date('2026-11-09T23:00:00Z'), d2 = new Date('2026-11-10T00:30:00Z')
    expect([1, 2, 3, 4].map(() => denyLineAllowed(ks, ANNA, d1))).toEqual([true, true, true, false])
    expect(denyLineAllowed(ks, BOB, d1)).toBe(true)
    expect(denyLineAllowed(ks, ANNA.toUpperCase(), d2)).toBe(true)
  })

  test('an answer file that matches nothing held, names another sender or is misnamed is dropped and delivers nothing', async () => {
    const r = rig(filed(7, 'pending'))
    await onStranger(ks, 'vesper', W, ANNA, 'Anna', item('hi'), r.io)
    const kd = join(dir, 'knocks'); mkdirSync(kd)
    writeFileSync(join(kd, '7.json'), JSON.stringify({ id: 7, channel: 'teams', sender: BOB, answer: 'admin' }))
    writeFileSync(join(kd, '8.json'), JSON.stringify({ id: 7, channel: 'teams', sender: ANNA, answer: 'allow' }))
    writeFileSync(join(kd, '9.json'), JSON.stringify({ id: 9, channel: 'teams', sender: ANNA, answer: 'allow' }))
    writeFileSync(join(kd, 'junk.txt'), 'x')
    expect(await applyAnswers(kd, ks, 'vesper', r.io)).toBe(0)
    expect(r.delivered).toEqual([])
    expect(ks.held['7']!.items.length).toBe(1)
    expect(parseAnswer(JSON.stringify({ id: 7, channel: 'telegram', sender: ANNA, answer: 'allow' }))).toBeNull()
    expect(parseAnswer(JSON.stringify({ id: 7, channel: 'teams', sender: ANNA, answer: 'yes' }))).toBeNull()
    expect(applyAnswers(join(dir, 'none'), ks, 'vesper', r.io)).resolves.toBe(0)
  })
})

describe('DIVE-8036 Teams: server wiring', () => {
  const src = readFileSync(join(import.meta.dir, '../plugins/teams/server.ts'), 'utf8')
  const handle = src.slice(src.indexOf('async function handle('), src.indexOf('// ── DIVE-8036: knocks'))
  test('a held stranger never reaches deliver() or the conversations map before the owner says yes', () => {
    const gate = handle.indexOf('needsKnock(access')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(handle.indexOf('state.conversations[parsed.conversationId]'))
    expect(gate).toBeLessThan(handle.indexOf('deliver('))
    expect(handle).toContain("allowedUsers: knock ? undefined : access.allowed_users")
    expect(src).toMatch(/async function sayTo\(w: Where, text: string\) \{\s+await connector\('POST', w\.serviceUrl/)
  })
  test('DIVE-8032: the knock IO asks the tenant for the member record (GET conversations/{id}/members/{aadObjectId}), with a timeout', () => {
    expect(src).toMatch(/const knockIO = \{[^}]*member: memberOf/)
    const fn = src.slice(src.indexOf('async function memberOf('), src.indexOf('async function sudoRun('))
    expect(fn).toContain("connector('GET', w.serviceUrl, `/v3/conversations/${encodeURIComponent(w.conv)}/members/${encodeURIComponent(sender)}`")
    expect(fn).toMatch(/undefined, 5_000\)/)
  })
  test('the answer dir is watched and polled', () => {
    expect(src).toContain("const KNOCKS_DIR = join(STATE_DIR, 'knocks')")
    expect(src).toMatch(/watchKnocks\(\)\n\}/)
  })
})

describe('DIVE-8036 Telegram: the owner\'s tap', () => {
  const OWNER = '111111111', GUEST = '222222222'
  function tg(stdout: string) {
    const runs: string[][] = [], answers: string[] = [], edits: string[] = [], logs: string[] = []
    let dropped = 0
    const io = {
      isOwner: (u: string) => u === OWNER,
      run: async (a: string[]) => { runs.push(a); return stdout },
      answer: async (t: string) => { answers.push(t) },
      edit: async (t: string) => { edits.push(t); return true },
      dropButtons: async () => { dropped++ },
      log: (l: string) => { logs.push(l) },
    }
    return { io, runs, answers, edits, dropped: () => dropped }
  }
  const ok = (answer: string) => JSON.stringify({ ok: true, data: { id: 7, status: answer === 'no' ? 'denied' : 'allowed', answer, agent: 'vesper', person: 'anna' } })

  test('grammar: kn:<kid>:<choice>:<32 hex>; a bad kn: is still ours; other data is not', () => {
    expect(parseKnockTap(`kn:7:admin:${NONCE}`)).toEqual({ kid: '7', choice: 'admin', nonce: NONCE })
    expect(parseKnockTap(`kn:7:root:${NONCE}`)).toBe('malformed')
    expect(parseKnockTap('kn:7:allow:short')).toBe('malformed')
    expect(parseKnockTap('acc:abcdefabcdef:y')).toBeNull()
  })

  test('the owner\'s tap runs `people knock answer` with THAT button\'s choice and nonce and its own id, then edits the card', async () => {
    const t = tg(ok('admin'))
    expect(await relayKnockTap(`kn:7:admin:${NONCE}`, OWNER, 'Anna wants to talk to Vesper', t.io)).toBe(true)
    expect(t.runs).toEqual([['5dive', 'people', 'knock', 'answer', '7', 'admin', `--proof=${NONCE}`, `--by=telegram:${OWNER}`, '--json']])
    expect(t.edits[0]).toContain('Anna wants to talk to Vesper\n\n✅ Admin')
    expect(t.answers[0]).toContain('Admin')
  })

  test('a guest\'s tap (allowed to DM, not an owner) runs nothing', async () => {
    const t = tg(ok('allow'))
    expect(await relayKnockTap(`kn:7:allow:${NONCE}`, GUEST, 'card', t.io)).toBe(true)
    expect(t.runs).toEqual([])
    expect(t.edits).toEqual([])
    expect(t.answers).toEqual([KNOCK_NOT_OWNER])
  })

  test('a malformed kn: or a refused answer edits nothing; the refusal is said to the tapper', async () => {
    const m = tg(ok('allow'))
    expect(await relayKnockTap('kn:7:allow:zz', OWNER, 'card', m.io)).toBe(true)
    expect([m.runs, m.answers]).toEqual([[], [KNOCK_EXPIRED]])
    const r = tg(JSON.stringify({ ok: false, error: { message: 'knock #7 is already answered (allowed)' } }))
    await relayKnockTap(`kn:7:no:${NONCE}`, OWNER, 'card', r.io)
    expect(r.edits).toEqual([])
    expect(r.answers).toEqual(['knock #7 is already answered (allowed)'])
    expect(knockOutcome('garbage')).toEqual({ applied: false, text: KNOCK_EXPIRED })
    expect(knockAnswerArgs({ kid: '7', choice: 'no', nonce: NONCE }, 'x1')).toBeNull()
  })

  test('not a kn: tap: the router carries on', async () => {
    const t = tg(ok('allow'))
    expect(await relayKnockTap('q:1:0', OWNER, 'card', t.io)).toBe(false)
    expect(t.runs).toEqual([])
  })

  test('the router answers kn: before the generic bridge, with the owners record', () => {
    const src = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
    const router = src.slice(src.indexOf("bot.on('callback_query:data'"))
    expect(router.indexOf('relayKnockTap(data, senderId')).toBeGreaterThan(0)
    expect(router.indexOf('relayKnockTap(data, senderId')).toBeLessThan(router.indexOf('parseConnectTap(data)'))
    expect(router).toContain('isOwner: uid => isOwner(access, uid)')
  })

  test('a standard seat reaches the answer only through its probed `people knock answer *` line', async () => {
    const argv = ['5dive', 'people', 'knock', 'answer', '7', 'allow', `--proof=${NONCE}`, '--by=telegram:1', '--json']
    expect(standardSeatMayHold(argv)).toBe(true)
    expect(standardSeatMayHold(['5dive', 'people', 'knock', 'answer'])).toBe(false)
    expect(standardSeatMayHold(['5dive', 'people', 'knock', 'file', '--channel=teams'])).toBe(false)
    expect(standardSeatMayHold(['5dive', 'people', 'add', 'x'])).toBe(false)
    const calls: string[][] = []
    const gate = (has: boolean) => createSudoGate({
      execFile: (async (_b: string, a: string[]) => { calls.push(a); if (a[1] === '-l' && !has) throw new Error('no'); return { stdout: '{}', stderr: '' } }) as any,
      sudoBin: 'sudo', fiveBin: '5dive', seat: async () => 'no', mayProbe: async () => true,
    })
    await gate(true).run(argv)
    expect(calls).toEqual([KNOCK_ANSWER_PROBE_ARGV, ['-n', ...argv]])
    calls.length = 0
    await expect(gate(false).run(argv)).rejects.toThrow()
    expect(calls).toEqual([KNOCK_ANSWER_PROBE_ARGV])
  })
})
