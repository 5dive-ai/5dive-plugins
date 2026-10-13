// DIVE-6121: the StopFailure usage-wall move reaches a STANDARD seat.
//
// A standard seat's sudo grant never held `agent rotation rotate`, so the
// hook's sudo call was refused and the seat waited hours for its reset with a
// fresh account in its pool. The move now runs on the seat's own uid first
// (`rotate <self> --wall=<reset>`, which the CLI crosses on its self-scoped
// rail); sudo is only the fallback for a CLI that predates it.
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { wallRotate, readActiveAccount, type Run } from '../plugins/telegram/hooks/lib/wall-rotate'

type Call = { cmd: string; args: string[] }
// fake(responses) — answers each call by its first matching rule, records it.
function fake(rules: Array<[(c: Call) => boolean, string | null]>) {
  const calls: Call[] = []
  const run: Run = (cmd, args) => {
    const c = { cmd, args }
    calls.push(c)
    const hit = rules.find(([m]) => m(c))
    return { stdout: hit ? hit[1] : null }
  }
  return { run, calls }
}
const bare = (c: Call) => c.cmd === '5dive'
const viaSudo = (c: Call) => c.cmd === 'sudo'
const REFUSED = '' // sudo -n on a scoped seat: refused, nothing on stdout
const RESET = 1791860400

test('standard seat: the bare wall move rotates, and sudo is never spawned', () => {
  const f = fake([
    [bare, JSON.stringify({ ok: true, data: { rotated: true, from: 'mp', to: 'mp-team', wall: true } })],
    [viaSudo, REFUSED],
  ])
  expect(wallRotate('chatseat', RESET, f.run)).toEqual({ kind: 'rotated', from: 'mp', to: 'mp-team' })
  expect(f.calls).toEqual([{ cmd: '5dive', args: ['--json', 'agent', 'rotation', 'rotate', 'chatseat', `--wall=${RESET}`] }])
})

test('NEGATIVE CONTROL — the pre-fix path on a standard seat: sudo only, refused, no move', () => {
  // What the hook did before: no bare call, the sudo call refused. The same
  // seat with the bare rail available must rotate (arm above); here it cannot.
  const f = fake([[viaSudo, REFUSED]])
  expect(wallRotate('chatseat', RESET, f.run)).toEqual({ kind: 'failed' })
})

test('no headroom: a declined wall move is final — never retried on the legacy sudo path', () => {
  const f = fake([
    [bare, JSON.stringify({ ok: true, data: { rotated: false, to: null, reason: 'no eligible account' } })],
    [viaSudo, JSON.stringify({ ok: true, data: { rotated: true, from: 'mp', to: 'mark' } })],
  ])
  expect(wallRotate('chatseat', RESET, f.run)).toEqual({ kind: 'declined', reason: 'no eligible account' })
  expect(f.calls.some(viaSudo)).toBe(false)
})

test('chain guard: a declined second move is final too', () => {
  const f = fake([
    [bare, JSON.stringify({ ok: true, data: { rotated: false, chainGuard: true, reason: 'already moved for a usage wall' } })],
    [viaSudo, JSON.stringify({ ok: true, data: { rotated: true, from: 'mark', to: 'weekly' } })],
  ])
  expect(wallRotate('chatseat', RESET, f.run).kind).toBe('declined')
  expect(f.calls.length).toBe(1)
})

test('a CLI that predates --wall: the bare call errors, the legacy sudo form still works on an admin seat', () => {
  const f = fake([
    [bare, JSON.stringify({ ok: false, error: { message: 'unknown flag: --wall=1791860400' } })],
    [viaSudo, JSON.stringify({ ok: true, data: { rotated: true, from: 'mp', to: 'mp-team' } })],
  ])
  expect(wallRotate('main', RESET, f.run)).toEqual({ kind: 'rotated', from: 'mp', to: 'mp-team' })
  expect(f.calls[1]).toEqual({
    cmd: 'sudo',
    args: ['-n', '5dive', '--json', 'agent', 'rotation', 'rotate', 'main', `--cooldown-current=${RESET}`],
  })
})

test('the active-account read is bare first; sudo only when the bare read fails', () => {
  const ok = fake([[bare, JSON.stringify({ ok: true, data: { active: 'mp' } })]])
  expect(readActiveAccount('chatseat', ok.run)).toBe('mp')
  expect(ok.calls.some(viaSudo)).toBe(false)
  const old = fake([
    [bare, null],
    [viaSudo, JSON.stringify({ ok: true, data: { active: 'mp' } })],
  ])
  expect(readActiveAccount('chatseat', old.run)).toBe('mp')
  expect(readActiveAccount('chatseat', fake([]).run)).toBe(null)
})

test('the StopFailure hook routes its rotate through the wall move, armed after the resume marker', () => {
  const src = readFileSync(join(import.meta.dir, '../plugins/telegram/hooks/stopfailure-notify.ts'), 'utf8')
  const fn = src.slice(src.indexOf('function tryRotate('))
  // No direct sudo rotate left in the hook: the only way it moves is wallRotate.
  expect(src.includes("'rotation', 'rotate'")).toBe(false)
  expect(fn.indexOf('wallRotate(')).toBeGreaterThan(-1)
  // The resume marker (which makes the new account answer the message that
  // hit the wall) is written BEFORE the move, so the restart picks it up.
  expect(fn.indexOf('renameSync(tmp, marker)')).toBeGreaterThan(-1)
  expect(fn.indexOf('renameSync(tmp, marker)')).toBeLessThan(fn.indexOf('wallRotate('))
  expect(fn.includes('resumePrompt()')).toBe(true)
})
