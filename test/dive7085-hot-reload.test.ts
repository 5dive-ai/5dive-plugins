// DIVE-7085: an installed telegram fix is live on a busy seat within a minute,
// without a restart. Fixture = a seat's plugin cache with two version dirs and
// its installed_plugins.json; the "old" tna.ts is today's with DIVE-7061's fix
// reverted, so main's 06:07Z message (a ⭐ option, no cue word) renders without
// buttons on it and with them on the new one — the reply lodar saw.
//   1. the swap: installing the new version flips the live render
//   2. a running process with a background child swaps in place: same pid, child alive
//   3. negative control: with the reload disabled the render stays old
//   4. a new version that fails to load / has the wrong shape / throws keeps the old live, logged
//   5. server.ts reads every tna function it calls through the live copy
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHotModule, installedFileFor, installedPathFor, HOT_RELOAD_POLL_MS } from '../plugins/telegram/hotreload'
import type * as Tna from '../plugins/telegram/tna'

const TG = join(import.meta.dir, '..', 'plugins', 'telegram')
const TNA_NEW = readFileSync(join(TG, 'tna.ts'), 'utf8')
const FIX = "return hasChoiceCue(unfenced(text ?? '')) || opts.some(o => o.pick) ? opts : []"
const TNA_OLD = TNA_NEW.replace(FIX, "return hasChoiceCue(unfenced(text ?? '')) ? opts : []")
const MSG = "I'd do one fresh sign-in.\n1. ⭐ Sign in again with the same account\n2. Wait for the old login to come back"

let tick = Date.now() / 1000
function seat(versions: Record<string, string>) {
  const cfg = mkdtempSync(join(tmpdir(), 'dive7085-'))
  const base = join(cfg, 'plugins', 'cache', '5dive-plugins', 'telegram')
  for (const [v, src] of Object.entries(versions)) {
    mkdirSync(join(base, v), { recursive: true })
    writeFileSync(join(base, v, 'tna.ts'), src)
  }
  const record = join(cfg, 'plugins', 'installed_plugins.json')
  const install = (v: string) => {
    writeFileSync(record, JSON.stringify({ version: 2, plugins: {
      'mod@5dive-plugins': [{ scope: 'user', installPath: join(cfg, 'plugins', 'cache', '5dive-plugins', 'mod', '0.6.0') }],
      'telegram@5dive-plugins': [{ scope: 'user', installPath: join(base, v), version: v }],
    } }))
    tick += 5
    utimesSync(record, tick, tick)
  }
  return { dir: (v: string) => join(base, v), install, record }
}
const boot = (dir: string) => import(join(dir, 'tna.ts')) as Promise<typeof Tna>

describe('DIVE-7085 fixture', () => {
  test("the old copy is DIVE-7061's pre-fix render (the replace landed)", async () => {
    expect(TNA_OLD).not.toBe(TNA_NEW)
    const s = seat({ '0.5.121': TNA_OLD, '0.5.122': TNA_NEW })
    expect((await boot(s.dir('0.5.121'))).optionChoices(MSG)).toEqual([])
    const opts = (await boot(s.dir('0.5.122'))).optionChoices(MSG)
    expect(opts.length).toBe(2)
    expect(opts[0].pick).toBe(true)
  })
})

describe('DIVE-7085 swap', () => {
  test('installing the new version flips the live render; the log names both versions', async () => {
    const s = seat({ '0.5.121': TNA_OLD, '0.5.122': TNA_NEW })
    s.install('0.5.121')
    const logs: string[] = []
    const hot = createHotModule({ file: 'tna.ts', boot: await boot(s.dir('0.5.121')), runningDir: s.dir('0.5.121'), log: l => logs.push(l) })
    expect(await hot.check()).toBe(false)
    expect(hot.live.optionChoices(MSG)).toEqual([])
    s.install('0.5.122')
    expect(await hot.check()).toBe(true)
    expect(hot.live.optionChoices(MSG).length).toBe(2)
    expect(hot.liveDir).toBe(s.dir('0.5.122'))
    expect(logs).toEqual(['hot reload: tna.ts now from 0.5.122 (process started on 0.5.121)'])
    expect(await hot.check()).toBe(false) // unchanged record: no re-import
  })

  test('negative control: TELEGRAM_HOT_RELOAD=0 keeps the old render', async () => {
    const s = seat({ '0.5.121': TNA_OLD, '0.5.122': TNA_NEW })
    s.install('0.5.121')
    const hot = createHotModule({ file: 'tna.ts', boot: await boot(s.dir('0.5.121')), runningDir: s.dir('0.5.121'), disabled: true, log: () => {} })
    s.install('0.5.122')
    expect(await hot.check()).toBe(false)
    expect(hot.live.optionChoices(MSG)).toEqual([])
  })

  test('a half-written record is retried, not fatal', async () => {
    const s = seat({ '0.5.121': TNA_OLD, '0.5.122': TNA_NEW })
    const hot = createHotModule({ file: 'tna.ts', boot: await boot(s.dir('0.5.121')), runningDir: s.dir('0.5.121'), log: () => {} })
    writeFileSync(s.record, '{"version": 2, "plugins": {"telegram@5dive')
    expect(await hot.check()).toBe(false)
    s.install('0.5.122')
    expect(await hot.check()).toBe(true)
  })

  test('the poll is well inside the five minutes the row allows', () => {
    expect(HOT_RELOAD_POLL_MS).toBeLessThanOrEqual(60_000)
  })
})

describe('DIVE-7085 a bad new version never takes the bridge down', () => {
  for (const [name, src, why] of [
    ['does not parse', 'export function optionChoices(text: string {', /FAILED, still serving 0\.5\.121: /],
    ['lost an export', TNA_NEW.replace('export function yesNoChoice', 'function yesNoChoice'), /missing export yesNoChoice/],
    ['throws when called', TNA_NEW.replace(FIX, "throw new Error('boom')"), /FAILED, still serving 0\.5\.121: boom/],
  ] as const) {
    test(`new version ${name}: old copy stays live and the log says so`, async () => {
      const s = seat({ '0.5.121': TNA_OLD, '0.5.123': src })
      const logs: string[] = []
      const hot = createHotModule({
        file: 'tna.ts', boot: await boot(s.dir('0.5.121')), runningDir: s.dir('0.5.121'), log: l => logs.push(l),
        probe: m => { m.optionChoices('Which one?\n1. ⭐ a\n2. b'); m.yesNoChoice('Ship it?') },
      })
      s.install('0.5.123')
      expect(await hot.check()).toBe(false)
      expect(hot.liveDir).toBe(s.dir('0.5.121'))
      expect(hot.live.optionChoices('Which one?\n1. a\n2. b').length).toBe(2)
      expect(logs.length).toBe(1)
      expect(logs[0]).toMatch(why)
      expect(await hot.check()).toBe(false) // not retried on every tick
      expect(logs.length).toBe(1)
    })
  }
})

describe('DIVE-7085 path containment', () => {
  test('only a sibling version dir of the running one is ever loaded', () => {
    const run = '/h/.claude/plugins/cache/5dive-plugins/telegram/0.5.123'
    const rec = (p: string) => ({ plugins: { 'telegram@x': [{ installPath: p }] } })
    expect(installedPathFor(rec('/h/.claude/plugins/cache/5dive-plugins/telegram/0.5.124'), run)).toBe('/h/.claude/plugins/cache/5dive-plugins/telegram/0.5.124')
    expect(installedPathFor(rec('/tmp/evil/0.5.124'), run)).toBeNull()
    expect(installedPathFor(rec('/h/.claude/plugins/cache/5dive-plugins/telegram-codex/0.5.41'), run)).toBeNull()
    expect(installedPathFor(null, run)).toBeNull()
    expect(installedFileFor(run)).toBe('/h/.claude/plugins/installed_plugins.json')
    expect(installedFileFor('/usr/local/lib/5dive/telegram-codex')).toBeNull()
  })
})

describe('DIVE-7085 a busy process swaps in place', () => {
  test('same pid, background child still alive, next render is the new one', async () => {
    const s = seat({ '0.5.121': TNA_OLD, '0.5.122': TNA_NEW })
    s.install('0.5.121')
    const driver = join(s.dir('0.5.121'), 'driver.ts')
    writeFileSync(driver, `
      import { spawn } from 'child_process'
      import { createHotModule } from ${JSON.stringify(join(TG, 'hotreload.ts'))}
      import * as boot from './tna.ts'
      const child = spawn('sleep', ['60'], { stdio: 'ignore' })
      const hot = createHotModule({ file: 'tna.ts', boot, runningDir: import.meta.dir, log: l => console.log('log ' + l) })
      hot.start(50)
      let last = -1
      setInterval(() => {
        const n = hot.live.optionChoices(${JSON.stringify(MSG)}).length
        if (n !== last) { last = n; console.log('render pid=' + process.pid + ' child=' + child.pid + ' n=' + n) }
      }, 20)
    `)
    const p = Bun.spawn(['bun', driver], { stdout: 'pipe', stderr: 'inherit' })
    const reader = p.stdout.getReader()
    let out = ''
    const until = async (re: RegExp) => {
      const end = Date.now() + 10_000
      while (!re.test(out) && Date.now() < end) {
        const { value, done } = await reader.read()
        if (done) break
        out += new TextDecoder().decode(value)
      }
      return re.exec(out)
    }
    try {
      const before = await until(/render pid=(\d+) child=(\d+) n=0/)
      expect(before).not.toBeNull()
      s.install('0.5.122')
      const after = await until(/render pid=(\d+) child=(\d+) n=2/)
      expect(after).not.toBeNull()
      expect(after![1]).toBe(before![1])
      expect(after![2]).toBe(before![2])
      expect(p.exitCode).toBeNull()
      expect(() => process.kill(Number(after![2]), 0)).not.toThrow()
      expect(out).toContain('log hot reload: tna.ts now from 0.5.122 (process started on 0.5.121)')
      process.kill(Number(after![2]))
    } finally {
      p.kill()
    }
  })
})

describe('DIVE-7085 server.ts wiring', () => {
  const SERVER = readFileSync(join(TG, 'server.ts'), 'utf8')
  test('no tna function is bound at import; each one server.ts calls goes through the live copy', () => {
    expect(SERVER).toContain("import * as tnaBoot from './tna'")
    expect(SERVER).toContain('runningDir: import.meta.dir,')
    expect(SERVER).toContain('tnaHot.start()')
    expect(SERVER).not.toMatch(/import \{[^}]*\b(optionChoices|yesNoChoice|parseOptions)\b[^}]*\} from '\.\/tna'/)
    const fns = [...TNA_NEW.matchAll(/^export function (\w+)/gm)].map(m => m[1]).filter(f => new RegExp(`\\b${f}\\(`).test(SERVER))
    expect(fns).toContain('optionChoices')
    for (const f of fns) expect(SERVER).toContain(`const ${f} = liveTna('${f}')`)
  })
})
