// DIVE-5495: an agent's Connect/captcha button did nothing when tapped on a
// standard seat (lodar, 2026-10-04, chill-gorge head). The sudo gate allowed a
// standard seat exactly one verb, `agent _self_restart`, so the tap threw
// AdminTierRequired before sudo — even on a seat that held the
// `5dive browser _connect` line.
//
// Pins:
//   1. a standard seat that HOLDS the line: the gate asks `sudo -n -l` for the
//      exact line, says yes, and the tap's check passes;
//   2. negative control: a standard seat WITHOUT the line is refused with
//      AdminTierRequired and the only sudo spawned is the -l listing, never the
//      verb; a seat that may not be asked (sandboxed, unknown entry) spawns
//      nothing at all (DIVE-4397);
//   3. the answer is cached for the TTL, not asked per tap;
//   4. only the probed line rides the probe — no other root verb does;
//   5. server.ts wires mayProbe from the seat's own agent-list entry.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSudoGate, standardSeatMayHold, isAdminTierRequired, BROWSER_CONNECT_PROBE_ARGV,
  GRANT_PROBE_TTL_MS, type SudoExecFn,
} from '../plugins/telegram/seatpriv'

const SERVER = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
const SUDO = '/usr/bin/sudo'
const FIVE = '/usr/local/bin/5dive'
const CONNECT = ['5dive', 'browser', '_connect']

function rig(o: { holds: boolean; mayProbe?: boolean; seat?: 'yes' | 'no' | 'unknown' }) {
  const calls: { file: string; args: string[] }[] = []
  let t = 1_000_000
  const exec: SudoExecFn = async (file, args) => {
    calls.push({ file, args })
    if (!o.holds) throw Object.assign(new Error('Command failed'), { stderr: '' })
    return { stdout: '', stderr: '' }
  }
  const gate = createSudoGate({
    execFile: exec, sudoBin: SUDO, fiveBin: FIVE, seat: async () => o.seat ?? 'no',
    mayProbe: o.mayProbe === undefined ? async () => true : async () => o.mayProbe!,
    now: () => t,
  })
  return { gate, calls, tick: (ms: number) => { t += ms } }
}

describe('a standard seat holding the line', () => {
  test('the tap check passes after one sudo -n -l of the exact line', async () => {
    const r = rig({ holds: true })
    await r.gate.check(CONNECT)
    expect(r.calls).toEqual([{ file: SUDO, args: ['-n', '-l', FIVE, 'browser', '_connect'] }])
  })
  test('run spawns the verb over sudo', async () => {
    const r = rig({ holds: true })
    await r.gate.run(CONNECT)
    expect(r.calls.at(-1)).toEqual({ file: SUDO, args: ['-n', ...CONNECT] })
  })
  test('the probe argv is the exact granted path, listing only', () => {
    expect(BROWSER_CONNECT_PROBE_ARGV).toEqual(['-n', '-l', FIVE, 'browser', '_connect'])
  })
})

describe('negative control: a standard seat without the line', () => {
  test('refused with AdminTierRequired; only the listing ran, never the verb', async () => {
    const r = rig({ holds: false })
    const e = await r.gate.check(CONNECT).then(() => null, x => x)
    expect(isAdminTierRequired(e)).toBe(true)
    expect(r.calls).toEqual([{ file: SUDO, args: BROWSER_CONNECT_PROBE_ARGV }])
    await expect(r.gate.run(CONNECT)).rejects.toThrow()
    expect(r.calls.some(c => c.args[1] !== '-l')).toBe(false)
  })
  test('a seat that may not be asked spawns nothing at all', async () => {
    const r = rig({ holds: true, mayProbe: false })
    expect(isAdminTierRequired(await r.gate.check(CONNECT).then(() => null, x => x))).toBe(true)
    expect(r.calls).toEqual([])
  })
  test('no mayProbe wired → refused, nothing spawned (the pre-5495 behaviour)', async () => {
    const calls: unknown[] = []
    const gate = createSudoGate({
      execFile: async (f, a) => { calls.push([f, a]); return { stdout: '', stderr: '' } },
      sudoBin: SUDO, fiveBin: FIVE, seat: async () => 'no',
    })
    expect(isAdminTierRequired(await gate.check(CONNECT).then(() => null, x => x))).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('cache and scope', () => {
  test('asked once per TTL, then again', async () => {
    const r = rig({ holds: true })
    await r.gate.check(CONNECT); await r.gate.check(CONNECT); await r.gate.check(CONNECT)
    expect(r.calls.length).toBe(1)
    r.tick(GRANT_PROBE_TTL_MS + 1)
    await r.gate.check(CONNECT)
    expect(r.calls.length).toBe(2)
  })
  test('an admin/unknown seat is never probed (argv unchanged)', async () => {
    for (const seat of ['yes', 'unknown'] as const) {
      const r = rig({ holds: false, seat })
      await r.gate.check(CONNECT)
      expect(r.calls).toEqual([])
    }
  })
  test('only the probed line rides the probe', async () => {
    expect(standardSeatMayHold(CONNECT)).toBe(true)
    expect(standardSeatMayHold(['5dive', 'browser', '_connect', '--x'])).toBe(false)
    expect(standardSeatMayHold(['5dive', 'browser', 'connect'])).toBe(false)
    expect(standardSeatMayHold(['5dive', 'agent', 'set-account', 'x', 'y'])).toBe(false)
    const r = rig({ holds: true })
    await expect(r.gate.run(['5dive', 'update'])).rejects.toThrow()
    expect(r.calls).toEqual([])
  })
})

describe('server.ts', () => {
  test('the gate is built with mayProbe from the seat\'s own agent-list entry', () => {
    const build = SERVER.slice(SERVER.indexOf('return SUDO_GATE ??= createSudoGate('), SERVER.indexOf('function sudo5dive('))
    expect(build).toContain('mayProbe: async () => {')
    expect(build).toContain('mayProbeStandardGrant(list?.find(a => a.name === me) ?? null)')
  })
  test('the tap still checks the gate before spawning', () => {
    const tap = SERVER.slice(SERVER.indexOf('async function handleBrowserConnectTap('))
    expect(tap.indexOf("sudoGateCheck(['5dive', 'browser', '_connect'])")).toBeLessThan(tap.indexOf('runConnectPriv('))
  })
})
