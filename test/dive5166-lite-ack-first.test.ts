// DIVE-5166: a lite (partner-client) agent stayed silent for the whole of a
// long request ("make a site with a week calendar": nothing until the file was
// done). LITE_INSTRUCTIONS had dropped the ack-first rule, lite has no ack
// reaction, and the silence watchdog exited on lite, so nothing asked for an
// "on it" line. Two arms: the rule is back in the lite instructions, and the
// watchdog nudges the AGENT once per unanswered message after 20s.
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { LITE_INSTRUCTIONS } from '../plugins/telegram/hooks/lib/lite'
import { decideLiteNudge } from '../plugins/telegram/hooks/lib/silence-decision'

const TG = join(import.meta.dir, '..', 'plugins', 'telegram')

const tmps: string[] = []
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

describe('the lite instructions carry the ack-first rule', () => {
  test('a long request gets an "on it" line first and the result as a new message; a quick one gets one reply', () => {
    expect(LITE_INSTRUCTIONS).toContain('first send one short line in your own voice saying you are on it')
    expect(LITE_INSTRUCTIONS).toContain('send the result as a new message')
    expect(LITE_INSTRUCTIONS).toContain('A quick question gets one reply')
    expect(LITE_INSTRUCTIONS).toContain('Never go quiet on a request.')
    // consumer wording: none of the operator ack machinery leaks in
    for (const operator of ['edit_message', '30s', 'progress']) expect(LITE_INSTRUCTIONS).not.toContain(operator)
    expect(LITE_INSTRUCTIONS.replaceAll('`5dive partner hire <slug>`', '')).not.toContain('5dive')
  })
})

describe('decideLiteNudge', () => {
  const now = 10_000
  test('fires once the newest message has waited past the threshold with no sign of life', () => {
    expect(decideLiteNudge({ lastInboundAt: now - 21 }, now, 20)).toEqual({ shouldFire: true, waited: 21 })
    expect(decideLiteNudge({ lastInboundAt: now - 20 }, now, 20).shouldFire).toBe(false)
    expect(decideLiteNudge({ lastInboundAt: now - 5 }, now, 20).shouldFire).toBe(false)
  })
  test('any contact after the message (reply, edit, reaction) means it was not ignored', () => {
    expect(decideLiteNudge({ lastInboundAt: now - 30, lastReplyAt: now - 25 }, now, 20).shouldFire).toBe(false)
    expect(decideLiteNudge({ lastInboundAt: now - 30, lastContactAt: now - 25 }, now, 20).shouldFire).toBe(false)
    // contact from an EARLIER message does not count for the newer one
    expect(decideLiteNudge({ lastInboundAt: now - 30, lastReplyAt: now - 40, lastContactAt: now - 40 }, now, 20).shouldFire).toBe(true)
  })
  test('once per message, then again on the next message', () => {
    expect(decideLiteNudge({ lastInboundAt: now - 60, lastReminderAt: now - 30 }, now, 20).shouldFire).toBe(false)
    expect(decideLiteNudge({ lastInboundAt: now - 60, lastReminderAt: now - 90 }, now, 20).shouldFire).toBe(true)
  })
  test('never with no message, or on a conversation older than an hour', () => {
    expect(decideLiteNudge({}, now, 20).shouldFire).toBe(false)
    expect(decideLiteNudge({ lastInboundAt: now - 3601 }, now, 20).shouldFire).toBe(false)
  })
})

describe('the silence watchdog under lite', () => {
  const run = (dir: string) =>
    spawnSync('bun', [join(TG, 'hooks', 'silence-watchdog.ts')], {
      input: JSON.stringify({ transcript_path: '/nonexistent' }),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TELEGRAM_STATE_DIR: dir },
      encoding: 'utf8',
      timeout: 20_000,
    })
  const box = (profile: 'lite' | 'default', silence: Record<string, number>) => {
    const d = mkdtempSync(join(tmpdir(), 'dive5166-'))
    tmps.push(d)
    writeFileSync(join(d, '.env'), `TELEGRAM_BOT_TOKEN=1:x\n${profile === 'lite' ? 'TELEGRAM_PROFILE=lite\n' : ''}`)
    writeFileSync(join(d, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }))
    writeFileSync(join(d, 'silence.json'), JSON.stringify(silence))
    return d
  }
  const nowS = () => Math.floor(Date.now() / 1000)

  test('an unanswered message past 20s nudges the agent exactly once, in consumer wording', () => {
    const d = box('lite', { lastInboundAt: nowS() - 30 })
    const first = run(d)
    expect(first.status).toBe(0)
    const ctx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('saying you are on it')
    expect(ctx).toContain('send the result as a new message')
    // not the operator alarm
    expect(ctx).not.toContain('alarms')
    expect(ctx).not.toContain('edit_message')
    expect(JSON.parse(readFileSync(join(d, 'silence.json'), 'utf8')).lastReminderAt).toBeGreaterThan(0)
    const second = run(d)
    expect(second.status).toBe(0)
    expect(second.stdout).toBe('')
  })

  test('a message already answered, or still inside 20s, gets no nudge and no state write', () => {
    for (const s of [{ lastInboundAt: nowS() - 30, lastReplyAt: nowS() - 28 }, { lastInboundAt: nowS() - 3 }]) {
      const d = box('lite', s)
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(JSON.parse(readFileSync(join(d, 'silence.json'), 'utf8'))).toEqual(s)
    }
  })

  test('control: the default profile still runs the operator watchdog on the same state', () => {
    const d = box('default', { lastInboundAt: nowS() - 90 })
    const r = run(d)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('The user alarms at >60s silence.')
    expect(existsSync(join(d, 'silence.json'))).toBe(true)
  })
})
