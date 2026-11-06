// DIVE-7730: an openclaw seat on an office AI gets a longer turn. On a CPU the
// first answer took ~30 min, and the dashboard ran every turn with --timeout 600.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openclawTurn, openclawTurnTimeoutS } from '../plugins/dashboard/openclawdispatch.ts'

describe('openclaw turn limit', () => {
  test('the env value is used when it is a sane number of seconds, else 600', () => {
    expect(openclawTurnTimeoutS('1800')).toBe(1800)
    expect(openclawTurnTimeoutS(undefined)).toBe(600)
    expect(openclawTurnTimeoutS('')).toBe(600)
    expect(openclawTurnTimeoutS('abc')).toBe(600)
    expect(openclawTurnTimeoutS('5')).toBe(600)
    expect(openclawTurnTimeoutS('99999')).toBe(600)
    expect(openclawTurnTimeoutS('90.5')).toBe(600)
  })

  test('the turn passes that limit to openclaw agent --timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc7730-'))
    const bin = join(dir, 'openclaw')
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(dir, 'argv')}\necho '{}'\n`)
    chmodSync(bin, 0o755)
    await openclawTurn(bin, join(dir, 'turns'), openclawTurnTimeoutS('1800'))('hi')
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n')
    expect(argv[argv.indexOf('--timeout') + 1]).toBe('1800')
  })
})
