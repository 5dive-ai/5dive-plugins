// DIVE-5331: the FULL (default) Telegram profile on a standard-tier seat. lodar,
// 2026-10-01: "make it work as much as possible" and "tell proper you need to be
// admin tier error if not possible".
//
// Pins:
//   1. every full-profile command has an audited route on a standard seat
//      (works / own no-root path / the one admin-tier refusal), and an
//      unaudited command is refused rather than sent to a sudo prompt;
//   2. the sudo gate, driven with EVERY argv server.ts hands it, against a fake
//      that behaves like a real standard seat (sudo refuses everything outside
//      the grant, the CLI refuses root-only verbs with its permission envelope):
//        admin / unknown → byte-identical `sudo -n <argv>`, as before;
//        standard        → the grant, the unprivileged path, or AdminTierRequired
//                          with nothing spawned — never a sudo prompt and never a
//                          raw CLI refusal reaching the user;
//   3. server.ts spawns sudo nowhere except through that gate;
//   4. the refusal is ONE message, en and ru, and /usage shows the seat's own
//      5h/1w;
//   5. mutants: each of the above goes red with the defect put back.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMAND_REGISTRY, botFatherCommands } from '../plugins/telegram/commands'
import {
  standardSeatRoute, STANDARD_ROUTED_COMMANDS, createSudoGate, isAdminTierRequired,
  AdminTierRequired, adminTierText, standardSeatMaySudo, standardSeatMayRunPlain,
  ownUsageText, accountReadOnlyText, accountSwitchFailedText, accountSwitchDoneText,
  USAGE_NOT_AVAILABLE_TEXT, type SeatAdmin, type SudoExecFn,
} from '../plugins/telegram/seatpriv'
import { TAP_STRINGS } from '../plugins/telegram/hooks/lib/lite'

const SERVER = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
const SUDO = '/usr/bin/sudo'
const FIVE = '/usr/local/bin/5dive'

// ── the argv server.ts actually hands the gate ──────────────────────────────
// Read off the source, so a new call site is graded the day it lands. A spread
// the suite does not know fails loudly instead of being skipped.
const SPREADS: Record<string, string[]> = {
  // runOwnerAsk(ownerAskArgs(...)) — owner-ask.ts
  '...args': ['--json', 'owner-ask', 'tap', 'bap:abc', '--tap-uid=1'],
  // resolveGateReply(...).answerArgs — gatereply.ts
  '...res.answerArgs': ['DIVE-1', '--value=yes', '--channel-proof=1', '--channel-msg=2'],
}
type Site = { argv: string[]; standard: 'plain' | 'refuse'; at: number }
function evalWord(w: string): string[] {
  w = w.trim()
  if (!w) return []
  if (w.startsWith('...')) {
    const v = SPREADS[w]
    if (!v) throw new Error(`unknown spread in a sudo5dive argv: ${w} — add it to SPREADS`)
    return v
  }
  if (/^'[^']*'$/.test(w)) return [w.slice(1, -1)]
  if (w.startsWith('`')) return [w.slice(1, -1).replace(/\$\{[^}]*\}\)?\}?/g, 'X')]
  return ['X'] // an identifier: taskId, me, name, …
}
function splitArgv(src: string): string[] {
  // commas at depth 0 (template literals carry `${f(a, b)}`)
  const out: string[] = []
  let depth = 0, cur = '', inTpl = false
  for (const ch of src) {
    if (ch === '`') inTpl = !inTpl
    if (!inTpl && (ch === '(' || ch === '{')) depth++
    if (!inTpl && (ch === ')' || ch === '}')) depth--
    if (ch === ',' && depth === 0 && !inTpl) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}
function sitesOf(text: string): Site[] {
  const sites: Site[] = []
  const re = /sudo5dive\(\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length
    // find the matching ] (argv never nests [ ])
    const end = text.indexOf(']', start)
    const argv = splitArgv(text.slice(start, end)).flatMap(evalWord)
    // the rest of the call, up to its closing paren
    const tail = text.slice(end, text.indexOf(')', text.indexOf('}', end) + 1) + 1)
    sites.push({ argv, standard: /'plain'/.test(tail) ? 'plain' : 'refuse', at: m.index })
  }
  return sites
}
const SITES = sitesOf(SERVER)

// ── a fake that behaves like a real standard seat ───────────────────────────
// Measured semantics (5dive-cli main branch as of 2026-10-01, audited on the PR):
//   sudo -n <anything outside the grant> → "sudo: a password is required"
//   5dive <root-only verb> as the seat   → {"ok":false,"error":{"class":"permission",…}}
type Call = { file: string; args: string[] }
function standardSeatExec(calls: Call[]): SudoExecFn {
  return async (file, args) => {
    calls.push({ file, args })
    if (file === SUDO) {
      const argv = args.slice(1) // drop -n
      if (standardSeatMaySudo(argv)) return { stdout: '', stderr: '' }
      throw Object.assign(new Error('Command failed'), { stderr: 'sudo: a password is required' })
    }
    if (standardSeatMayRunPlain(['5dive', ...args])) return { stdout: '{"ok":true,"data":{}}', stderr: '' }
    const stdout = JSON.stringify({ ok: false, error: { code: 10, class: 'permission', message: `must run as root — try: sudo 5dive ${args.join(' ')}` } })
    throw Object.assign(new Error('Command failed'), { stdout, stderr: '' })
  }
}

type Outcome = { ok: true; via: 'sudo' | 'plain' } | { ok: false; refusal: 'admin-tier' } | { ok: false; leak: string }
// What reaches the user for one call site: success, the admin-tier refusal, or
// a LEAK (a sudo prompt or a raw CLI error).
async function drive(gate: ReturnType<typeof createSudoGate>, calls: Call[], s: Site): Promise<Outcome> {
  const before = calls.length
  try {
    await gate.run(s.argv, { timeout: 1 }, s.standard)
    const c = calls[calls.length - 1]!
    return { ok: true, via: c.file === SUDO ? 'sudo' : 'plain' }
  } catch (e) {
    if (isAdminTierRequired(e)) {
      if (calls.length !== before) return { ok: false, leak: 'refused AFTER spawning' }
      return { ok: false, refusal: 'admin-tier' }
    }
    const err = e as { stderr?: string; stdout?: string }
    return { ok: false, leak: String(err.stderr || err.stdout || e) }
  }
}
function gateFor(seat: SeatAdmin, calls: Call[], exec?: SudoExecFn) {
  return createSudoGate({ execFile: exec ?? standardSeatExec(calls), sudoBin: SUDO, fiveBin: FIVE, seat: async () => seat })
}

describe('the call sites the suite grades', () => {
  test('are read off server.ts, all of them', () => {
    // the 25 old `execFileP(SUDO, ['-n', …])` sites; a site lost from the scan
    // would quietly drop out of every arm below.
    expect(SITES.length).toBe(25)
    expect(SITES.every(s => s.argv.length > 0)).toBe(true)
  })
  test('cover every root-only verb the audit named', () => {
    const verbs = new Set(SITES.map(s => s.argv.filter(w => !w.startsWith('-')).slice(0, 3).join(' ')))
    // '5dive agent X' is /agents start|stop|restart: the verb is a variable there.
    for (const v of ['5dive agent set-account', '5dive agent rotation', '5dive agent X', '5dive council veto',
      '5dive council ballot-tap', '5dive owner-ask tap', '/usr/local/bin/5dive-refresh-plugins.sh X']) {
      expect([...verbs].some(x => x.startsWith(v))).toBe(true)
    }
  })
})

describe('an admin seat is byte-identical to before', () => {
  for (const seat of ['yes', 'unknown'] as const) {
    test(`${seat}: every site spawns exactly \`sudo -n <argv>\`, nothing else`, async () => {
      const calls: Call[] = []
      const ok: SudoExecFn = async (file, args) => { calls.push({ file, args }); return { stdout: '', stderr: '' } }
      const gate = gateFor(seat, calls, ok)
      for (const s of SITES) {
        const before = calls.length
        await gate.run(s.argv, { timeout: 1 }, s.standard)
        expect(calls.length).toBe(before + 1)
        // what `execFileP(SUDO, ['-n', ...argv], opts)` spawned
        expect(calls[before]).toEqual({ file: SUDO, args: ['-n', ...s.argv] })
      }
    })
  }
})

describe('a standard seat: the grant, the no-root path, or the one refusal', () => {
  test('no call site leaks a sudo prompt or a raw CLI refusal', async () => {
    const calls: Call[] = []
    const gate = gateFor('no', calls)
    const leaks: string[] = []
    for (const s of SITES) {
      const o = await drive(gate, calls, s)
      if ('leak' in o) leaks.push(`${s.argv.join(' ')} → ${o.leak}`)
    }
    expect(leaks).toEqual([])
  })
  test('every site that has a no-root path gets it — "work as much as possible"', async () => {
    const calls: Call[] = []
    const gate = gateFor('no', calls)
    const plain = SITES.filter(s => s.standard === 'plain')
    // task add/show/start/done/cancel/escalate/unpark, the channel-proof answer, agent send
    expect(plain.length).toBe(11)
    for (const s of plain) expect({ argv: s.argv, o: await drive(gate, calls, s) }).toEqual({ argv: s.argv, o: { ok: true, via: 'plain' } })
  })
  test('sudo is spawned only for the seat\'s own grant', async () => {
    const calls: Call[] = []
    const gate = gateFor('no', calls)
    for (const s of SITES) await drive(gate, calls, s)
    const sudos = calls.filter(c => c.file === SUDO)
    expect(sudos.length).toBeGreaterThan(0)
    for (const c of sudos) expect(c.args).toEqual(['-n', '5dive', 'agent', '_self_restart'])
  })
  test('the unprivileged verbs run as the seat, the root-only ones are refused', async () => {
    const calls: Call[] = []
    const gate = gateFor('no', calls)
    const via = async (argv: string[], standard: 'plain' | 'refuse') => drive(gate, calls, { argv, standard, at: 0 })
    expect(await via(['5dive', 'task', 'add', '--json', '--from=x', '--', 'a title'], 'plain')).toEqual({ ok: true, via: 'plain' })
    expect(await via(['5dive', 'task', 'done', '7', '--result=r'], 'plain')).toEqual({ ok: true, via: 'plain' })
    expect(await via(['5dive', '--json', 'task', 'answer', 'DIVE-1', '--value=y', '--channel-proof=1'], 'plain')).toEqual({ ok: true, via: 'plain' })
    expect(await via(['5dive', 'agent', '_self_restart'], 'refuse')).toEqual({ ok: true, via: 'sudo' })
    // root-only, whatever the call site asks for
    for (const argv of [
      ['5dive', 'agent', 'set-account', 'me', 'mark'],
      ['5dive', 'agent', 'stop', 'peer', '--json'],
      ['5dive', 'agent', 'rotation', 'set', 'me', '--enabled=true', '--accounts=all'],
      ['/usr/local/bin/5dive-refresh-plugins.sh', 'me'],
      // a bare --value answer would land as the AGENT's answer
      ['5dive', '--json', 'task', 'answer', '7', '--value=x'],
    ]) {
      expect(await via(argv, 'plain')).toEqual({ ok: false, refusal: 'admin-tier' })
    }
  })
  test('the refusal carries the one message', () => {
    const e = new AdminTierRequired(['5dive', 'agent', 'stop', 'x'])
    expect(e.message).toBe(TAP_STRINGS.en.adminTier)
    expect(isAdminTierRequired(e)).toBe(true)
    expect(isAdminTierRequired(new Error('x'))).toBe(false)
  })
})

describe('every full-profile command has an audited route', () => {
  test('no registry command is left to the default', () => {
    for (const c of COMMAND_REGISTRY) expect(STANDARD_ROUTED_COMMANDS).toContain(c.name)
  })
  test('a command nobody audited is refused, not run', () => {
    expect(standardSeatRoute('some-new-command')).toBe('admin')
  })
  test('the audit, as routes', () => {
    const works = ['start', 'help', 'status', 'context', 'stop', 'restart', 'clear', 'checkpoint', 'resume',
      'tasks', 'heartbeat', 'org', 'model', 'effort', 'goal']
    for (const c of works) expect(standardSeatRoute(c)).toBe('works')
    for (const c of ['inbox', 'task', 'account', 'usage']) expect(standardSeatRoute(c)).toBe('own')
    for (const c of ['update', 'login']) expect(standardSeatRoute(c)).toBe('admin')
    expect(standardSeatRoute('agents', '')).toBe('works')
    expect(standardSeatRoute('team', '')).toBe('works')
    for (const a of ['start x', 'stop x', 'restart x', 'STOP x']) {
      expect(standardSeatRoute('agents', a)).toBe('admin')
      expect(standardSeatRoute('team', a)).toBe('admin')
    }
    expect(standardSeatRoute('digest', '')).toBe('works')
    expect(standardSeatRoute('digest', 'status')).toBe('works')
    for (const a of ['on', 'off', 'at 8am', '20:00']) expect(standardSeatRoute('digest', a)).toBe('admin')
  })
  test('commands stay in the menu — an explanation, not a hidden command', () => {
    // the menu takes no tier input, so a standard seat lists the root-only ones too
    const menu = botFatherCommands(COMMAND_REGISTRY, true).map(c => c.command)
    for (const c of ['update', 'login', 'account', 'usage', 'digest', 'agents']) expect(menu).toContain(c)
  })
})

describe('server.ts wiring', () => {
  const loop = SERVER.slice(SERVER.indexOf('for (const def of COMMAND_REGISTRY) {'), SERVER.indexOf('// DIVE-950: the DIVE-518/519'))
  test('the dispatcher refuses an admin-only command before its handler, and only on a standard seat', () => {
    const gate = loop.indexOf("standardSeatRoute(def.name, String(ctx.match ?? '')) === 'admin' && (await seatTier()) === 'no'")
    expect(gate).toBeGreaterThan(-1)
    expect(loop.indexOf('adminTierText(liteLang(ctx.from?.language_code))')).toBeGreaterThan(gate)
    expect(loop.indexOf('await handler(ctx, gate)')).toBeGreaterThan(gate)
  })
  test('server.ts spawns sudo nowhere but the gate', () => {
    expect(SERVER).not.toMatch(/execFileP\(\s*SUDO/)
    // the one streaming spawn is the browser connect child, checked by the gate first
    expect((SERVER.match(/spawn\(SUDO/g) ?? []).length).toBe(1)
    const tap = SERVER.slice(SERVER.indexOf('async function handleBrowserConnectTap('))
    expect(tap.indexOf("sudoGateCheck(['5dive', 'browser', '_connect'])")).toBeGreaterThan(-1)
    expect(tap.indexOf("sudoGateCheck(")).toBeLessThan(tap.indexOf('runConnectPriv('))
    expect((SERVER.match(/runConnectPriv\(/g) ?? []).length).toBe(2) // definition + that one caller
  })
  test('/usage on a standard seat reads only its own statusline', () => {
    const usage = SERVER.slice(SERVER.indexOf('  usage: async ctx => {'), SERVER.indexOf('  goal: async ctx => {'))
    const gate = usage.indexOf("if (seat === 'no') {")
    const own = usage.indexOf('ownUsageText(')
    expect(gate).toBeGreaterThan(-1)
    expect(own).toBeGreaterThan(gate)
    expect(own).toBeLessThan(usage.indexOf("read5diveJson(['account', 'usage', '--json'])"))
  })
  test('the inbox digest and the tier-2 resend never reach the root-only --send on a standard seat', () => {
    const inbox = SERVER.slice(SERVER.indexOf('async function handleInboxRequest('))
    expect(inbox.indexOf("(await seatTier()) === 'no'")).toBeLessThan(inbox.indexOf("'--send'"))
    const resend = SERVER.slice(SERVER.indexOf('const grsM = GRESEND_RE.exec(data)'))
    expect(resend.indexOf("(await seatTier()) === 'no'")).toBeLessThan(resend.indexOf("'--send'"))
  })
})

describe('one message, en and ru', () => {
  test('en is the owner\'s wording', () => {
    expect(adminTierText('en')).toBe('This needs an admin-tier agent. Ask your box admin, or switch this agent to admin in the dashboard.')
  })
  test('ru is Russian, and both fit a tap toast', () => {
    expect(adminTierText('ru')).toMatch(/[а-яё]/i)
    for (const l of ['en', 'ru'] as const) {
      expect(adminTierText(l).length).toBeLessThanOrEqual(200)
      expect(adminTierText(l)).not.toMatch(/sudo|password|root/i)
    }
  })
  test('5220\'s two ad-hoc strings are now that message', () => {
    expect(USAGE_NOT_AVAILABLE_TEXT).toBe(adminTierText('en'))
    for (const l of ['en', 'ru'] as const) {
      expect(accountReadOnlyText('mark', l)).toContain(adminTierText(l))
      expect(accountSwitchFailedText('mark', true, 'sudo: a password is required', l)).toBe(`❌ ${adminTierText(l)}`)
    }
    expect(accountReadOnlyText('mark', 'ru')).toContain('Текущий аккаунт: mark')
  })
  test('an admin seat\'s account texts are unchanged', () => {
    expect(accountSwitchDoneText('mark')).toBe('✅ Account → mark\n\n⚠️  Claude is restarting to apply it — back in ~20-30s once the new session loads.')
    expect(accountSwitchFailedText('mark', false, 'unknown account')).toBe("❌ Couldn't switch account → mark: unknown account\n\nThis agent is still on its current account.")
  })
})

describe('/usage on a standard seat: its own 5h/1w', () => {
  const now = 1_790_850_000_000
  const cache = { rate_limits: { five_hour: { used_percentage: 3.4, resets_at: 1_790_856_000 }, seven_day: { used_percentage: 56, resets_at: 1_791_090_000 } } }
  const fmt = (ms: number) => `${Math.round(ms / 60_000)}m`
  test('en', () => {
    expect(ownUsageText('en', cache, now, fmt)).toBe([
      "This agent's usage", '', '5h: 3% · resets in 100m', '1w: 56% · resets in 4000m', '',
      'Usage for every account on this box needs an admin-tier agent, or the dashboard.',
    ].join('\n'))
  })
  test('ru', () => {
    const t = ownUsageText('ru', cache, now, fmt)
    expect(t).toContain('Расход этого агента')
    expect(t).toContain('5 ч: 3% · сброс через 100m')
    expect(t).toContain('1 нед: 56%')
  })
  test('no reading yet says so; a past reset is not shown', () => {
    expect(ownUsageText('en', null, now, fmt)).toContain('No usage reading yet')
    const past = { rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }
    expect(ownUsageText('en', past, now, fmt)).toContain('5h: 10%\n')
  })
})

// ── MUTANTS: put the defect back ─────────────────────────────────────────────
describe('MUTANT: a gate that ignores the seat (today\'s raw `sudo -n`)', () => {
  const rawSudo = (calls: Call[]) => ({
    async run(argv: string[], opts?: unknown) { return standardSeatExec(calls)(SUDO, ['-n', ...argv], opts) },
    async check() {},
  })
  test('the leak arm goes RED: the owner reads a sudo prompt', async () => {
    const calls: Call[] = []
    const gate = rawSudo(calls) as ReturnType<typeof createSudoGate>
    const leaks: string[] = []
    for (const s of SITES) {
      const o = await drive(gate, calls, s)
      if ('leak' in o) leaks.push(o.leak)
    }
    expect(leaks.length).toBeGreaterThan(10)
    expect(leaks).toContain('sudo: a password is required')
  })
})

describe('MUTANT: a call site that asks for the unprivileged path for a root-only verb', () => {
  test('is still refused, never a raw CLI error', async () => {
    const calls: Call[] = []
    const o = await drive(gateFor('no', calls), calls, { argv: ['5dive', 'agent', 'set-account', 'me', 'x'], standard: 'plain', at: 0 })
    expect(o).toEqual({ ok: false, refusal: 'admin-tier' })
    expect(calls).toEqual([])
  })
  test('without the allowlist it would leak the permission envelope', async () => {
    const calls: Call[] = []
    const exec = standardSeatExec(calls)
    const o = await exec(FIVE, ['agent', 'set-account', 'me', 'x']).then(() => 'ok', (e: { stdout?: string }) => String(e.stdout))
    expect(o).toContain('must run as root')
  })
})

describe('MUTANT: a raw sudo call reintroduced in server.ts', () => {
  test('the static arm goes RED', () => {
    const mutated = SERVER.replace(
      "void sudo5dive(['5dive', 'agent', 'set-account', me, name], { timeout: 5000 })",
      "void execFileP(SUDO, ['-n', '5dive', 'agent', 'set-account', me, name], { timeout: 5000 })",
    )
    expect(mutated).not.toBe(SERVER)
    expect(mutated).toMatch(/execFileP\(\s*SUDO/)
  })
})

describe('MUTANT: the dispatcher refusal removed', () => {
  test('/update would reach its handler, whose first act is the root-only refresh', () => {
    const update = SERVER.slice(SERVER.indexOf('  update: async ctx => {'), SERVER.indexOf('  model: async ctx => {'))
    // no seat check inside: the dispatcher is the only thing between a standard
    // seat and the refresh, so the dispatcher arm above is load-bearing.
    expect(update).not.toContain('seatTier')
    expect(update).toContain("'/usr/local/bin/5dive-refresh-plugins.sh'")
  })
})
