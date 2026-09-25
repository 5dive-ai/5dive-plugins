// DIVE-4982 — the owner's Approve / Decline tap on a browser ask.
// Pure half (the button grammar, the CLI argv, the CLI's answer), the relay
// driven with a fake CLI, and the wiring arms that decide who the tap reaches:
// the relay runs after the allowFrom check and before the generic
// agent-keyboard bridge. If that bridge ran first, it would put the owner's
// nonce into the agent's session. The MUTANT arms put that defect back.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as shipped from '../plugins/telegram/owner-ask.ts'

const { BAP_RE, OWNER_ASK_EXPIRED, parseOwnerAskTap, ownerAskArgs, ownerAskOutcome, relayOwnerAskTap } = shipped
type Relay = typeof relayOwnerAskTap

const HEX = '0123456789ab'
const NONCE = 'f'.repeat(32)
const BAP = `bap:${HEX}:${NONCE}`
const BDN = `bdn:${HEX}:${NONCE}`
const UID = '111'
const ID = `agent-seat-${HEX}`
const ASK = 'Send to ann@example.com — "Invoice 42"?'
const OK_APPROVED = JSON.stringify({ ok: true, data: { result: 'approved', id: ID, seat: 'agent-seat' } })
const OK_DECLINED = JSON.stringify({ ok: true, data: { result: 'declined', id: ID, seat: 'agent-seat' } })
const REFUSED = JSON.stringify({ ok: false, error: { code: 3, class: 'permission', message: `only the box owner can answer ask ${ID}` } })

function fakeIO(stdout = OK_APPROVED, editOk = true) {
  const calls = { run: [] as string[][], answer: [] as string[], edit: [] as string[], drop: 0, log: [] as string[] }
  const io = {
    run: async (args: string[]) => { calls.run.push(args); return stdout },
    answer: async (t: string) => { calls.answer.push(t) },
    edit: async (t: string) => { calls.edit.push(t); return editOk },
    dropButtons: async () => { calls.drop++ },
    log: (l: string) => { calls.log.push(l) },
  }
  return { io, calls }
}

// The router in server.ts, reduced to the one decision under test: the relay
// takes the tap, or it falls through to the DIVE-279 bridge, whose content is
// `[callback_query data=<data>]` in the agent's session.
async function route(relay: Relay, data: string, stdout = OK_APPROVED) {
  const f = fakeIO(stdout)
  const handled = await relay(data, UID, ASK, f.io)
  return { ...f, handled, bridged: handled ? null : `[callback_query data=${data}]` }
}

// The relay's contract, as a list of what is wrong. Shipped: []. The mutant
// arms run the same list and must get something back.
async function relayFaults(relay: Relay): Promise<string[]> {
  const faults: string[] = []
  const r = await route(relay, BAP)
  if (!r.handled) faults.push(`bap tap fell through to the agent bridge as ${r.bridged}`)
  if (r.calls.run.length !== 1) faults.push(`CLI ran ${r.calls.run.length} times, want 1`)
  else if (JSON.stringify(r.calls.run[0]) !== JSON.stringify(['--json', 'owner-ask', 'tap', BAP, `--tap-uid=${UID}`])) {
    faults.push(`CLI argv ${JSON.stringify(r.calls.run[0])}`)
  }
  if (r.calls.answer[0] !== `✅ Approved — ${ID}`) faults.push(`answer ${JSON.stringify(r.calls.answer)}`)
  const bad = await route(relay, 'bap:zz')
  if (!bad.handled) faults.push('a malformed bap fell through to the agent bridge')
  return faults
}

const serverPath = join(import.meta.dir, '../plugins/telegram/server.ts')
const SERVER = readFileSync(serverPath, 'utf8')
// The handler itself; a comment earlier in server.ts names it too.
const ROUTER = "bot.on('callback_query:data', async ctx => {"

// Where the relay sits in the callback router, as a list of what is wrong.
function wiringFaults(src: string): string[] {
  const faults: string[] = []
  const router = src.slice(src.indexOf(ROUTER))
  const allow = router.indexOf('access.allowFrom.includes(senderId)')
  const relay = router.indexOf('relayOwnerAskTap(data, senderId,')
  if (relay < 0) return ['the router never calls relayOwnerAskTap']
  if (relay < allow) faults.push('relay runs before the allowFrom check')
  if (relay < router.indexOf('parseConnectTap(data)')) faults.push('relay runs before the Connect branch')
  for (const later of ['/^q:', 'TNA_RE.exec(data)', '[callback_query data=']) {
    if (relay > router.indexOf(later)) faults.push(`relay runs after ${later}`)
  }
  if (!/if \(ownerAsked\) return\n/.test(router)) faults.push('a relayed tap does not stop the router')
  return faults
}

describe('BAP_RE', () => {
  test('Approve and Decline parse', () => {
    expect(BAP_RE.exec(BAP)?.slice(1)).toEqual(['bap', HEX, NONCE])
    expect(BAP_RE.exec(BDN)?.slice(1)).toEqual(['bdn', HEX, NONCE])
    expect(parseOwnerAskTap(BAP)).toEqual({ verb: 'bap', hex: HEX, nonce: NONCE, data: BAP })
    expect(parseOwnerAskTap(BDN)).toEqual({ verb: 'bdn', hex: HEX, nonce: NONCE, data: BDN })
  })
  test('a 31- or 33-hex nonce, a non-hex id or a third field is refused', () => {
    for (const d of [
      `bap:${HEX}:${NONCE.slice(1)}`,
      `bap:${HEX}:${NONCE}0`,
      `bap:${HEX.slice(1)}g:${NONCE}`,
      `bap:${HEX.toUpperCase()}:${NONCE}`,
      `bap:${HEX}0:${NONCE}`,
      `bap:${HEX}:${NONCE}:x`,
      `bdn:${HEX}:${NONCE}:${NONCE}`,
      `bap:${HEX}`,
      `bap:${HEX}:${NONCE}\n`,
    ]) {
      expect(BAP_RE.test(d)).toBe(false)
      expect(parseOwnerAskTap(d)).toBe('malformed')
    }
  })
  test('other buttons are not ours', () => {
    for (const d of [`tna:12:approved:${NONCE}`, `bconn:${'c'.repeat(48)}`, `bdone:${'d'.repeat(48)}`, `xap:${HEX}:${NONCE}`, 'bapx', '']) {
      expect(parseOwnerAskTap(d)).toBeNull()
    }
  })
  test("callback_data fits Telegram's 64-byte cap", () => {
    expect(Buffer.byteLength(BAP)).toBe(49)
  })
})

describe('ownerAskArgs and ownerAskOutcome', () => {
  test('the CLI gets the tapped data and the tapper id, nothing else', () => {
    const tap = parseOwnerAskTap(BDN) as shipped.OwnerAskTap
    expect(ownerAskArgs(tap, UID)).toEqual(['--json', 'owner-ask', 'tap', `${tap.verb}:${tap.hex}:${tap.nonce}`, `--tap-uid=${UID}`])
  })
  test('a tapper id outside the CLI grammar never reaches the CLI', () => {
    const tap = parseOwnerAskTap(BAP) as shipped.OwnerAskTap
    for (const uid of ['', 'ann', '1 2', '1;id', '1'.repeat(21)]) expect(ownerAskArgs(tap, uid)).toBeNull()
  })
  test("the CLI's answer is what the tapper sees", () => {
    expect(ownerAskOutcome(OK_APPROVED)).toEqual({ applied: true, text: `✅ Approved — ${ID}` })
    expect(ownerAskOutcome(OK_DECLINED)).toEqual({ applied: true, text: `❌ Declined — ${ID}` })
    expect(ownerAskOutcome(REFUSED)).toEqual({ applied: false, text: `only the box owner can answer ask ${ID}` })
  })
  test('anything else says nothing was applied, under the 200-char cap', () => {
    for (const s of ['', 'sudo: a password is required', '{"ok":true,"data":{"result":"maybe"}}']) {
      expect(ownerAskOutcome(s)).toEqual({ applied: false, text: "Couldn't apply — answer on the box: sudo 5dive browser approve <id>" })
    }
    const long = JSON.stringify({ ok: false, error: { message: 'x'.repeat(500) } })
    expect(ownerAskOutcome(long).text.length).toBeLessThanOrEqual(190)
  })
})

describe('relayOwnerAskTap', () => {
  test('Approve: the CLI runs once, the message gets the stamp, the tap gets the line', async () => {
    const r = await route(relayOwnerAskTap, BAP)
    expect(r.handled).toBe(true)
    expect(r.calls.run).toEqual([['--json', 'owner-ask', 'tap', BAP, '--tap-uid=111']])
    expect(r.calls.edit).toEqual([`${ASK}\n\n✅ Approved — ${ID}`])
    expect(r.calls.answer).toEqual([`✅ Approved — ${ID}`])
    expect(r.calls.drop).toBe(0)
  })
  test('Decline goes to the same verb; the CLI tells them apart', async () => {
    const r = await route(relayOwnerAskTap, BDN, OK_DECLINED)
    expect(r.calls.run).toEqual([['--json', 'owner-ask', 'tap', BDN, '--tap-uid=111']])
    expect(r.calls.answer).toEqual([`❌ Declined — ${ID}`])
  })
  test("a refusal answers with the CLI's reason, leaves the message alone and is logged", async () => {
    const r = await route(relayOwnerAskTap, BAP, REFUSED)
    expect(r.handled).toBe(true)
    expect(r.calls.answer).toEqual([`only the box owner can answer ask ${ID}`])
    expect(r.calls.edit).toEqual([])
    expect(r.calls.drop).toBe(0)
    expect(r.calls.log).toEqual([`owner-ask tap from 111 refused: only the box owner can answer ask ${ID}`])
  })
  test('a malformed bap/bdn gets the expired answer and never reaches the CLI', async () => {
    for (const d of ['bap:', `bdn:${HEX}:${NONCE}0`, `bap:${HEX}:${NONCE}:x`]) {
      const r = await route(relayOwnerAskTap, d)
      expect(r.handled).toBe(true)
      expect(r.calls.run).toEqual([])
      expect(r.calls.answer).toEqual([OWNER_ASK_EXPIRED])
    }
  })
  test('a tapper id the CLI would refuse gets the expired answer, no CLI', async () => {
    const f = fakeIO()
    expect(await relayOwnerAskTap(BAP, 'ann', ASK, f.io)).toBe(true)
    expect(f.calls.run).toEqual([])
    expect(f.calls.answer).toEqual([OWNER_ASK_EXPIRED])
  })
  test('when the message cannot be edited the buttons are dropped', async () => {
    const f = fakeIO(OK_APPROVED, false)
    await relayOwnerAskTap(BAP, UID, ASK, f.io)
    expect(f.calls.drop).toBe(1)
    const g = fakeIO()
    await relayOwnerAskTap(BAP, UID, undefined, g.io)
    expect(g.calls.edit).toEqual([])
    expect(g.calls.drop).toBe(1)
  })
  test('any other button is left to the router, untouched', async () => {
    const r = await route(relayOwnerAskTap, 'tna:12:approved')
    expect(r.handled).toBe(false)
    expect(r.calls).toEqual({ run: [], answer: [], edit: [], drop: 0, log: [] })
  })
  test('the nonce goes to the CLI and nowhere a person or a log can read it', async () => {
    for (const out of [OK_APPROVED, REFUSED, '']) {
      const r = await route(relayOwnerAskTap, BAP, out)
      expect(JSON.stringify([r.calls.answer, r.calls.edit, r.calls.log])).not.toContain(NONCE)
    }
  })
  test('the relay holds no file access: it cannot open the approval files', () => {
    const src = readFileSync(join(import.meta.dir, '../plugins/telegram/owner-ask.ts'), 'utf8')
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toMatch(/\brequire\(|\bBun\.file\b|readFile|writeFile|browser-approvals\//)
  })
  test('the contract holds on the shipped relay', async () => {
    expect(await relayFaults(relayOwnerAskTap)).toEqual([])
  })
})

describe('wiring in the Claude Code bridge', () => {
  test('the relay runs after allowFrom and Connect, before every other branch and the agent bridge', () => {
    expect(wiringFaults(SERVER)).toEqual([])
  })
  test("the tapper id is Telegram's from.id, and root is reached by the bare sudoers word", () => {
    const router = SERVER.slice(SERVER.indexOf(ROUTER))
    expect(router).toMatch(/const senderId = String\(ctx\.from\.id\)/)
    expect(SERVER).toContain("execFileP(SUDO, ['-n', '5dive', ...args], { timeout: 45_000 })")
  })
  test('the relay branch and its runner hold no file access', () => {
    const runner = SERVER.slice(SERVER.indexOf('async function runOwnerAsk('), SERVER.indexOf(ROUTER))
    const branch = SERVER.slice(SERVER.indexOf('const ownerAsked = await relayOwnerAskTap('), SERVER.indexOf('if (ownerAsked) return'))
    expect(runner.length).toBeGreaterThan(0)
    expect(branch.length).toBeGreaterThan(0)
    expect(runner + branch).not.toMatch(/readFile|writeFile|renameSync|unlink|rmSync|Bun\.file/)
  })
})

// --- MUTANTS: put the defect back -------------------------------------------
// BEFORE/AFTER on each edit, because a replace that matched nothing would make
// the red below a vacuous pass on the shipped code.
describe('MUTANT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dive4982-owner-ask-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('a relay that ignores bap: lets the tap fall through, nonce and all, to the agent bridge', async () => {
    const src = readFileSync(join(import.meta.dir, '../plugins/telegram/owner-ask.ts'), 'utf8')
    const guard = '  if (!OWNER_ASK_PREFIX_RE.test(data)) return null\n'
    expect(src).toContain(guard)                                  // BEFORE
    const mutant = src.replace(guard, '  return null\n')
    expect(mutant).not.toContain(guard)                           // AFTER: the replace matched
    const file = join(dir, 'owner-ask.mutant.ts')
    writeFileSync(file, mutant)
    const m = (await import(file)) as typeof shipped
    const faults = await relayFaults(m.relayOwnerAskTap)
    expect(faults).toContain(`bap tap fell through to the agent bridge as [callback_query data=${BAP}]`)
    expect(faults).toContain('CLI ran 0 times, want 1')
  })

  test('a router without the relay branch goes red on the wiring check', () => {
    const start = SERVER.indexOf('  // DIVE-4982: Approve / Decline on a browser ask.')
    const end = SERVER.indexOf('  if (ownerAsked) return\n') + '  if (ownerAsked) return\n'.length
    expect(start).toBeGreaterThan(0)                              // BEFORE
    expect(end).toBeGreaterThan(start)
    const mutant = SERVER.slice(0, start) + SERVER.slice(end)
    expect(mutant).not.toContain('relayOwnerAskTap(data')         // AFTER: the cut matched
    expect(wiringFaults(mutant)).toEqual(['the router never calls relayOwnerAskTap'])
  })
})
