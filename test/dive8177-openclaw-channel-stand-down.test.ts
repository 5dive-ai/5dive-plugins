// DIVE-8177: the OpenClaw 5dive channel (in the gateway) and the box's own
// OpenClaw reader (openclawdispatch.ts) share one spool inbox. The channel marks
// <spool>/reader.json with the gateway pid, and the box reader stands down while
// that pid is alive and is a gateway. Found as the publish blocker in DIVE-8145.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readerActive } from '../plugins/dashboard/clidispatch.ts'
import { startOpenclawDispatcher } from '../plugins/dashboard/openclawdispatch.ts'
import * as spool from '../plugins/dashboard/openclaw-channel/src/spool.ts'

const DASH = join(import.meta.dir, '..', 'plugins', 'dashboard')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dive8177-')); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d }
const drop = (dir: string, name: string, body: unknown) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(body))
  renameSync(join(dir, `.${name}.tmp`), join(dir, `${name}.json`))
}
const outbox = (dir: string) => { try { return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch { return [] } }
// A live process whose program has the given name: a symlink to sleep.
const liveNamed = (name: string) => {
  const d = tmp()
  symlinkSync('/bin/sleep', join(d, name))
  const p = spawn(join(d, name), ['30'], { stdio: 'ignore' })
  cleanups.push(() => { try { p.kill('SIGKILL') } catch {} })
  // Until exec lands, /proc/<pid>/cmdline still shows the parent's program.
  const until = Date.now() + 3000
  while (Date.now() < until) {
    try { if (readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0')[0].endsWith(`/${name}`)) break } catch {}
    Bun.sleepSync(5)
  }
  return p.pid!
}

describe('the OpenClaw channel marks the spool (DIVE-8177)', () => {
  test('claim writes {pid, by: openclaw}; release drops only its own mark', () => {
    const s = tmp()
    spool.claimReader(s, 4242)
    expect(JSON.parse(readFileSync(spool.readerFile(s), 'utf8'))).toEqual({ pid: 4242, by: 'openclaw' })
    spool.releaseReader(s, 999)                                      // not ours: kept
    expect(existsSync(spool.readerFile(s))).toBe(true)
    spool.releaseReader(s, 4242)
    expect(existsSync(spool.readerFile(s))).toBe(false)
    spool.releaseReader(s, 4242)                                     // nothing there: no throw
  })

  test('the gateway claims before it polls and releases when it stops', () => {
    const src = readFileSync(join(DASH, 'openclaw-channel', 'src', 'gateway.ts'), 'utf8')
    const claim = src.indexOf('claimReader(spool)'), poll = src.indexOf('await pollSpool('), release = src.indexOf('releaseReader(spool)')
    expect(claim).toBeGreaterThan(0)
    expect(claim).toBeLessThan(poll)
    expect(release).toBeGreaterThan(poll)
    expect(src.slice(poll, release)).toContain('} finally {')
  })
})

describe('the box OpenClaw reader stands down (DIVE-8177)', () => {
  test('only a live gateway holds the inbox; its renamed process counts', () => {
    const s = tmp()
    expect(readerActive(s, 'openclaw')).toBe(false)                  // no mark
    const gw = liveNamed('openclaw-gateway')                          // what /proc shows for a running gateway
    spool.claimReader(s, gw)
    expect(readerActive(s, 'openclaw')).toBe(true)
    expect(readerActive(s, 'pi')).toBe(false)                         // marked for another runtime
    const other = liveNamed('sleepy')
    spool.claimReader(s, other)
    expect(readerActive(s, 'openclaw')).toBe(false)                   // a reused pid, another program
    spool.claimReader(s, 2 ** 22 + 7)
    expect(readerActive(s, 'openclaw')).toBe(false)                   // dead pid (above pid_max)
    const cli = liveNamed('openclaw')
    spool.claimReader(s, cli)
    expect(readerActive(s, 'openclaw')).toBe(true)                    // an unrenamed launcher
  })

  test('the dispatcher leaves the inbox alone while stood down, and answers once it is not', async () => {
    const s = tmp()
    const inbox = join(s, 'inbox'), out = join(s, 'outbox', 'dashboard')
    let off = true
    let turns = 0
    const d = startOpenclawDispatcher({ inboxDir: inbox, outboxDir: out, log: () => {}, standDown: () => off,
      run: async () => { turns++; return { stdout: JSON.stringify({ payloads: [{ text: 'from the bridge' }] }), stderr: '', code: 0 } } })
    cleanups.push(() => d.stop())
    drop(inbox, '1-1-0', { id: 'm1', text: 'hi', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await Bun.sleep(1300)
    expect(turns).toBe(0)
    expect(readdirSync(inbox)).toEqual(['1-1-0.json'])                // left for the channel
    off = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && outbox(out).length === 0) await Bun.sleep(25)
    await d.idle()
    expect(turns).toBe(1)
    expect(outbox(out).map(r => r.text)).toEqual(['from the bridge'])
  })

  test('server.ts wires the OpenClaw stand-down to the seat spool', () => {
    expect(readFileSync(join(DASH, 'server.ts'), 'utf8')).toContain("standDown: () => readerActive(DISPATCHER_STATE_DIR, 'openclaw')")
  })
})
