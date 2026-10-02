// DIVE-5367: /account and /usage work on a standard seat. lodar, 2026-10-02:
// "our standard isolation tier doesn't have … slash account command".
//
// The CLI gives a standard seat ONE more exact-path sudoers line,
// `5dive _self_account`, which switches THIS seat (derived from the sudo caller)
// between accounts the box holds and reads the every-account limit board. The
// plugin never spawns that primitive: the ordinary verbs cross it from an
// unprivileged call. The plugin only has to ask — once, and only on a scoped
// standard seat — whether the line is there.
//
// Pins:
//   1. who is asked: only a seat whose grant is the scoped standard one (an
//      admin seat does not need it; a sandboxed seat has no sudoers entry, and
//      asking it would log/mail a "not in sudoers" line, DIVE-4397);
//   2. the ask is `sudo -n -l` of the exact line — it lists, it never runs;
//   3. server.ts: the picker, the switch and /usage take the granted path only
//      behind that ask, the switch goes unprivileged, the auto-rotate row and
//      the token-burn board (both root) are not read on a standard seat;
//   4. mutants: each goes red with the defect put back.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mayProbeSelfAccount, selfAccountGranted, createSudoGate, SELF_ACCOUNT_PROBE_ARGV,
  type SeatEntry, type SudoExecFn,
} from '../plugins/telegram/seatpriv'

const SERVER = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
const SUDO = '/usr/bin/sudo'
const FIVE = '/usr/local/bin/5dive'

const seat = (sudo: SeatEntry['sudo'], isolation?: string): SeatEntry => ({ name: 'tap', isolation, sudo })

describe('only a scoped standard seat is asked', () => {
  test('measured grant decides', () => {
    expect(mayProbeSelfAccount(seat({ measured: true, impliedIsolation: 'standard' }))).toBe(true)
    expect(mayProbeSelfAccount(seat({ measured: true, impliedIsolation: 'admin' }))).toBe(false)
    expect(mayProbeSelfAccount(seat({ measured: true, impliedIsolation: 'beyond-admin' }))).toBe(false)
    expect(mayProbeSelfAccount(seat({ measured: true, impliedIsolation: 'sandboxed' }))).toBe(false)
    expect(mayProbeSelfAccount(seat({ measured: true, impliedIsolation: 'custom' }))).toBe(false)
    // the measurement beats a stale label
    expect(mayProbeSelfAccount(seat({ measured: true, impliedIsolation: 'sandboxed' }, 'standard'))).toBe(false)
  })
  test('unmeasured falls back to the label', () => {
    expect(mayProbeSelfAccount(seat(undefined, 'standard'))).toBe(true)
    expect(mayProbeSelfAccount(seat({ measured: false }, 'sandboxed'))).toBe(false)
    expect(mayProbeSelfAccount(seat(undefined))).toBe(false)
    expect(mayProbeSelfAccount(null)).toBe(false)
  })
  test('a seat that may not be asked is never probed', async () => {
    let probed = 0
    const probe = async () => { probed++; return true }
    expect(await selfAccountGranted(seat({ measured: true, impliedIsolation: 'sandboxed' }), probe)).toBe(false)
    expect(await selfAccountGranted(null, probe)).toBe(false)
    expect(probed).toBe(0)
    expect(await selfAccountGranted(seat({ measured: true, impliedIsolation: 'standard' }), probe)).toBe(true)
    expect(probed).toBe(1)
  })
  test('a probe that throws is "no", never a crash', async () => {
    expect(await selfAccountGranted(seat(undefined, 'standard'), async () => { throw new Error('x') })).toBe(false)
  })
})

describe('the ask lists the exact line and runs nothing', () => {
  test('argv is sudo -n -l of the exact granted path', () => {
    expect(SELF_ACCOUNT_PROBE_ARGV).toEqual(['-n', '-l', FIVE, '_self_account'])
  })
  for (const [answer, want] of [['granted', true], ['refused', false]] as const) {
    test(`${answer} → ${want}`, async () => {
      const calls: { file: string; args: string[] }[] = []
      const exec: SudoExecFn = async (file, args) => {
        calls.push({ file, args })
        if (answer === 'refused') throw Object.assign(new Error('Command failed'), { stderr: '' })
        return { stdout: '', stderr: '' }
      }
      const gate = createSudoGate({ execFile: exec, sudoBin: SUDO, fiveBin: FIVE, seat: async () => 'no' })
      expect(await gate.probeSelfAccount()).toBe(want)
      expect(calls).toEqual([{ file: SUDO, args: ['-n', '-l', FIVE, '_self_account'] }])
    })
  }
})

const between = (a: string, b: string) => SERVER.slice(SERVER.indexOf(a), SERVER.indexOf(b, SERVER.indexOf(a)))
const MENU = between('async function buildAccountMenu(', 'async function buildRotationMenu(')
const APPLY = between('async function applyAccount(', 'function applyEffort(')
const USAGE = between('  usage: async ctx => {', '  goal: async ctx => {')

describe('server.ts', () => {
  test('the picker: read-only only when the seat is standard AND lacks the line', () => {
    expect(MENU).toContain('if (standard && !(await seatHasSelfAccount(agents))) {')
    expect(MENU.indexOf('seatHasSelfAccount(')).toBeLessThan(MENU.indexOf('read5diveAccountUsage()'))
  })
  test('the picker: no auto-rotate row on a standard seat (writing rotation is root)', () => {
    expect(MENU).toContain('standard ? Promise.resolve(null) : read5diveRotation(me)')
  })
  test('the switch: refused only without the line, and unprivileged with it', () => {
    expect(APPLY).toContain('if (standard && !(await seatHasSelfAccount())) {')
    expect(APPLY).toContain("standard ? 'plain' : 'refuse'")
    // an admin seat's spawn is unchanged: sudo, 5s
    expect(APPLY).toContain('timeout: standard ? 15000 : 5000')
  })
  test('/usage: the board over the line; the token-burn read (root) is skipped', () => {
    expect(USAGE).toContain("const selfAccount = seat === 'no' && await seatHasSelfAccount()")
    expect(USAGE).toContain("if (seat === 'no' && !selfAccount) {")
    expect(USAGE).toContain('selfAccount ? Promise.resolve(null) : read5diveUsageBoard()')
  })
  test('the probe is the gate\'s, so server.ts still spawns sudo nowhere but the gate', () => {
    expect(SERVER).toContain('sudoGate().probeSelfAccount()')
    expect(SERVER).not.toMatch(/execFileP\(\s*SUDO/)
  })
  test('the answer is cached like the tier, not asked per tap', () => {
    const fn = between('async function seatHasSelfAccount(', '// DIVE-5331: the ONLY way this file spawns sudo.')
    expect(fn).toContain('Date.now() - SELF_ACCOUNT.at < SEAT_TIER_TTL_MS')
  })
})

describe('MUTANTS go red', () => {
  test('the read-only branch made unconditional again would hide the picker', () => {
    const mutated = MENU.replace('if (standard && !(await seatHasSelfAccount(agents))) {', 'if (standard) {')
    expect(mutated).not.toBe(MENU)
    expect(mutated).not.toContain('seatHasSelfAccount(')
  })
  test('the switch sent to sudo on a standard seat would be refused by the gate', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: SudoExecFn = async (file, args) => { calls.push({ file, args }); return { stdout: '', stderr: '' } }
    const gate = createSudoGate({ execFile: exec, sudoBin: SUDO, fiveBin: FIVE, seat: async () => 'no' })
    await expect(gate.run(['5dive', 'agent', 'set-account', 'tap', 'mark'], {}, 'refuse')).rejects.toThrow()
    expect(calls).toEqual([])
    await gate.run(['5dive', 'agent', 'set-account', 'tap', 'mark'], {}, 'plain')
    expect(calls).toEqual([{ file: FIVE, args: ['agent', 'set-account', 'tap', 'mark'] }])
  })
})
