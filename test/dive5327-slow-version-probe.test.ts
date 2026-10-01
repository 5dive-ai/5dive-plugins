// DIVE-5327: a slow `5dive --version` (>2s on a loaded box) was reported to the
// user as "needs a newer 5dive CLI". These arms drive the real reader in
// plugins/telegram/fivediveversion.ts against a stub binary that sleeps, with the
// real execFile, so a timeout here is the same kill the bot sees on a busy box.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVersionReader, isDefinitiveMiss } from '../plugins/telegram/fivediveversion.ts'

const execFileP = promisify(execFile) as unknown as Parameters<typeof createVersionReader>[0]['exec']
const SRC = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

let dir = ''
let mode = ''
// The stub reads its behaviour from a file, so one path serves every arm and a
// test can make it slow AFTER the first good read, as on a box that gets busy.
function stub(behaviour: 'fast' | 'slow' | 'old' | 'fail') {
  writeFileSync(mode, behaviour)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dive5327-'))
  mode = join(dir, 'mode')
  const bin = join(dir, '5dive')
  writeFileSync(bin, `#!/bin/sh
case "$(cat '${mode}')" in
  fast) echo "5dive 0.65.1" ;;
  slow) sleep 3; echo "5dive 0.65.1" ;;
  old)  echo "usage: 5dive <cmd>" ;;
  fail) exit 2 ;;
esac
`)
  chmodSync(bin, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bin = () => join(dir, '5dive')

describe('DIVE-5327 — a slow version probe is not an old CLI', () => {
  test('after one good read, a 3s-slow CLI still answers (cache hit, no exec)', async () => {
    stub('fast')
    const r = createVersionReader({ bin: bin(), exec: execFileP })
    expect(await r.probe()).toEqual({ kind: 'ok', version: '0.65.1' })
    stub('slow')
    const t0 = Date.now()
    expect(await r.probe()).toEqual({ kind: 'ok', version: '0.65.1' })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  test('past the TTL, a re-read that times out keeps the cached version', async () => {
    let clock = 0
    stub('fast')
    const r = createVersionReader({ bin: bin(), exec: execFileP, now: () => clock, warmMs: 300 })
    expect(await r.version()).toBe('0.65.1')
    clock += 11 * 60_000
    stub('slow')
    expect(await r.probe()).toEqual({ kind: 'ok', version: '0.65.1' })
  })

  test('a cold read that times out is busy, not absent', async () => {
    stub('slow')
    const r = createVersionReader({ bin: bin(), exec: execFileP, coldMs: 300 })
    expect(await r.probe()).toEqual({ kind: 'busy' })
    expect(await r.version()).toBeNull()
  })

  test('the default cold budget outlasts a 3s-slow CLI (it was 2s)', async () => {
    stub('slow')
    const r = createVersionReader({ bin: bin(), exec: execFileP })
    expect(await r.probe()).toEqual({ kind: 'ok', version: '0.65.1' })
  }, 15_000)

  test('real negatives stay absent: no binary, non-zero exit, wrong shape', async () => {
    expect(await createVersionReader({ bin: join(dir, 'nope'), exec: execFileP }).probe()).toEqual({ kind: 'absent' })
    stub('fail')
    expect(await createVersionReader({ bin: bin(), exec: execFileP }).probe()).toEqual({ kind: 'absent' })
    stub('old')
    expect(await createVersionReader({ bin: bin(), exec: execFileP }).probe()).toEqual({ kind: 'absent' })
  })

  test('concurrent callers share one exec', async () => {
    let calls = 0
    const r = createVersionReader({
      bin: 'x',
      exec: async () => { calls++; await new Promise(res => setTimeout(res, 50)); return { stdout: '5dive 1.2.3\n' } },
    })
    const out = await Promise.all([r.version(), r.version(), r.probe()])
    expect(out[0]).toBe('1.2.3')
    expect(calls).toBe(1)
  })

  test('fork failures under load are not definitive', () => {
    expect(isDefinitiveMiss({ code: 'EAGAIN' })).toBe(false)
    expect(isDefinitiveMiss({ killed: true, signal: 'SIGTERM', code: null })).toBe(false)
    expect(isDefinitiveMiss({ code: 'ENOENT' })).toBe(true)
    expect(isDefinitiveMiss({ code: 1 })).toBe(true)
  })
})

describe('DIVE-5327 — server.ts wiring', () => {
  test('read5diveVersion delegates to the cached reader; the 2s inline probe is gone', () => {
    expect(SRC).toMatch(/import \{ createVersionReader \} from '\.\/fivediveversion\.ts'/)
    expect(SRC).not.toMatch(/execFileP\(FIVEDIVE, \['--version'\]/)
  })

  test('the dispatcher says "couldn\'t check" on busy, "newer CLI" only on absent', () => {
    const i = SRC.indexOf("if (def.scope === 'paired-5dive') {")
    expect(i).toBeGreaterThan(0)
    const block = SRC.slice(i, i + 1200)
    expect(block).toMatch(/probe\.kind === 'busy'[\s\S]*Couldn't check the 5dive CLI/)
    expect(block).toMatch(/probe\.kind === 'absent'[\s\S]*needs a newer 5dive CLI/)
  })
})
