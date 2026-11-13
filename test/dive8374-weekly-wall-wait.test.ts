// DIVE-8374 — a seat on its WEEKLY limit typed `continue` every few minutes.
//
// Cause: the weekly wall prints a dated reset (`resets Nov 17, 8am`), the hook
// resolved it to the right epoch ~88h out, and the resume helper threw it away:
// Phase 2 trusted a reset only up to 30h ahead, so anything further skipped the
// wait and went straight to the retry loop — `continue` at 5, 10, 20 minutes,
// each one answered by the same weekly-limit line.
//
// Graded here, matching the row's acceptance:
//   1. an epoch 88h out → the helper sleeps until it, and sends ZERO `continue`
//      before it — by unit (planWait) and end-to-end, executing the real helper
//      with a stub tmux on PATH;
//   2. an epoch 9 days out → still the retry path (a stale or mis-parsed line);
//   3. the dashboard plugin runs the same helper (byte-identical copy).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { MAX_RESET_WAIT_SEC, planWait } from '../plugins/telegram/hooks/lib/resume-retry'

const H = 3600
const D = 86400
const NOW = 1_794_560_000

describe('DIVE-8374 Phase 2 trusts a weekly reset', () => {
  test('88h out: wait until the reset (+30s buffer)', () => {
    expect(planWait(NOW + 88 * H, NOW)).toEqual({ kind: 'wait', sec: 88 * H + 30 })
  })
  test('a full 7-day weekly wall is still a wait', () => {
    expect(planWait(NOW + 7 * D, NOW)).toEqual({ kind: 'wait', sec: 7 * D + 30 })
  })
  test('the 5-hour wall is unchanged', () => {
    expect(planWait(NOW + 2 * H, NOW)).toEqual({ kind: 'wait', sec: 2 * H + 30 })
  })
  test('9 days out: untrusted, the retry path', () => {
    expect(planWait(NOW + 9 * D, NOW)).toEqual({ kind: 'untrusted', delta: 9 * D })
  })
  test('a past reset: untrusted, the retry path', () => {
    expect(planWait(NOW - 5, NOW)).toEqual({ kind: 'untrusted', delta: -5 })
  })
  test('no epoch: the blind park-hold', () => {
    expect(planWait(0, NOW)).toEqual({ kind: 'blind' })
  })
  test('the window is the parser\'s own dated-reset bound, 8 days', () => {
    expect(MAX_RESET_WAIT_SEC).toBe(8 * D)
    expect(planWait(NOW + 8 * D, NOW).kind).toBe('wait')
    expect(planWait(NOW + 8 * D + 1, NOW).kind).toBe('untrusted')
  })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dive8374-'))
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

const rateLimitEntry =
  JSON.stringify({
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 17, 8am" }] },
  }) + '\n'

// Run the REAL helper with a stub tmux that always shows the parked limit menu
// and records every keystroke. Stop it as soon as `until` holds (or after
// `maxMs`), and return its log and the keys it typed.
async function runHelper(
  plugin: 'telegram' | 'dashboard',
  resetEpoch: number,
  until: (out: string, keys: string[]) => boolean,
  maxMs = 20000,
): Promise<{ out: string; keys: string[] }> {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const sendLog = join(dir, 'sendkeys.log')
  const tp = join(dir, 'session.jsonl')
  writeFileSync(tp, rateLimitEntry)
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    capture-pane) echo "You've hit your weekly limit · resets Nov 17, 8am"; echo "1. Stop and wait for the limit to reset"; exit 0 ;;
    send-keys) mode=send ;;
  esac
done
[ "$mode" = send ] && echo "\${@: -2:1}" >> ${JSON.stringify(sendLog)}
exit 0
`,
    { mode: 0o755 },
  )
  const lock = join(dir, 'resume.lock')
  writeFileSync(lock, '')
  const helper = join(import.meta.dir, '..', 'plugins', plugin, 'hooks', 'resume-after-reset.ts')
  const child = spawn(process.execPath, [helper, String(resetEpoch), join(dir, 'sock'), 'sess:0.0', '', lock, tp], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TELEGRAM_BOT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.on('data', d => (out += d))
  const keys = () => (existsSync(sendLog) ? readFileSync(sendLog, 'utf8').split('\n').filter(Boolean) : [])
  const start = Date.now()
  while (Date.now() - start < maxMs && child.exitCode === null && !until(out, keys())) {
    await new Promise(r => setTimeout(r, 200))
  }
  // Give a racing keystroke a moment to land before we read the log.
  await new Promise(r => setTimeout(r, 500))
  child.kill('SIGKILL')
  return { out, keys: keys() }
}

describe('DIVE-8374 the shipped helper parks on a weekly wall (e2e)', () => {
  for (const plugin of ['telegram', 'dashboard'] as const) {
    test(`${plugin}: reset 88h out → sleeps until it, zero \`continue\``, async () => {
      const epoch = Math.floor(Date.now() / 1000) + 88 * H
      const { out, keys } = await runHelper(plugin, epoch, o => /phase2 /.test(o))
      expect(out).toMatch(/phase1 pressed '1'/)
      expect(out).toMatch(/phase2 sleeping 3168\d\ds until reset/)
      expect(out).not.toMatch(/out of trusted window|phase3/)
      expect(keys.filter(k => k !== '1')).toEqual([]) // only the park key, no `continue`
    }, 30000)
  }

  test('reset 9 days out → still the retry path (types `continue`)', async () => {
    const epoch = Math.floor(Date.now() / 1000) + 9 * D
    const { out, keys } = await runHelper('telegram', epoch, (_o, k) => k.some(x => x !== '1'))
    expect(out).toMatch(/phase2 reset epoch out of trusted window/)
    expect(keys.filter(k => k !== '1').length).toBeGreaterThanOrEqual(1)
  }, 30000)
})
