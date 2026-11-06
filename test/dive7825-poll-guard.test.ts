// DIVE-7825: a getUpdates that Telegram never answers must not hold the channel
// deaf for the client's 500 s default, silently, while the beacon stays green.
//
// pollguard.ts is the transformer every Telegram bridge installs on its bot. These
// arms drive it with a fake transport (the suite has no grammy): a poll that never
// answers is aborted at its window plus slack, the loop's retry then gets the
// queued messages, one stderr line names the failure, and bot.lastpoll stops
// advancing during the hang and moves again after it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPollGuard, pollDeadlineMs, touchLastPoll, POLL_SLACK_MS } from '../plugins/telegram/pollguard.ts'

const ROOT = join(import.meta.dir, '..')
const FORKS = ['telegram-codex', 'telegram-grok', 'telegram-agy', 'telegram-opencode', 'telegram-pi']

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pg7825-')); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d }

// A transport that never answers getUpdates until aborted (what Telegram's front
// end did for teal-fox's bot), then answers normally once `healthy` is set.
function fakeTelegram() {
  const st = { healthy: false, calls: 0, signals: [] as Array<AbortSignal | undefined>, queued: [{ update_id: 1 }, { update_id: 2 }] }
  const prev = (method: string, _payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    st.calls++
    st.signals.push(signal)
    if (method !== 'getUpdates') return Promise.resolve({ ok: true, method })
    if (st.healthy) return Promise.resolve(st.queued.splice(0))
    return new Promise((_res, rej) => {
      signal?.addEventListener('abort', () => rej(new Error("Network request for 'getUpdates' failed!")), { once: true })
    })
  }
  return { st, prev }
}

describe('pollguard: a getUpdates with no answer is cut off, logged and retried', () => {
  test('the deadline is the long-poll window plus 15 s (30 s poll → 45 s), not 500 s', () => {
    expect(POLL_SLACK_MS).toBe(15_000)
    expect(pollDeadlineMs({ timeout: 30 })).toBe(45_000)
    expect(pollDeadlineMs({ offset: 5 })).toBe(15_000) // the drop-pending getUpdates has no window
    expect(pollDeadlineMs(undefined)).toBe(15_000)
  })

  test('a hung poll aborts at its deadline; the retry delivers the queued messages; lastpoll stalls then resumes', async () => {
    const dir = tmp()
    const lastPollFile = join(dir, 'bot.lastpoll')
    const lines: string[] = []
    const { st, prev } = fakeTelegram()
    const guard = createPollGuard({ lastPollFile, log: l => lines.push(l), slackMs: 120 })

    touchLastPoll(lastPollFile, 1) // slot taken: the poll clock starts
    const before = readFileSync(lastPollFile, 'utf8')

    // grammY's fetchUpdates: call getUpdates; on error, handlePollingError sleeps 3 s and retries.
    const fetchUpdates = async () => {
      for (;;) {
        try { return await guard(prev, 'getUpdates', { offset: 1, timeout: 0 }) as Array<{ update_id: number }> }
        catch { st.healthy = true; await Bun.sleep(5) }
      }
    }
    const t0 = performance.now()
    const updates = await fetchUpdates()
    const took = performance.now() - t0

    expect(updates.map(u => u.update_id)).toEqual([1, 2])
    expect(st.calls).toBe(2)
    expect(took).toBeGreaterThanOrEqual(100)
    expect(took).toBeLessThan(2_000) // without the guard this never returns (red below)
    expect(lines[0]).toMatch(/^getUpdates failed \(1 in a row\): no answer in 0s, aborted; retrying in 3s$/)
    expect(lines[1]).toBe('getUpdates recovered after 1 failed attempt')
    const after = readFileSync(lastPollFile, 'utf8')
    expect(after).not.toBe(before) // advanced only when a poll came back
    expect(Number(after)).toBeGreaterThan(1)
  })

  test('lastpoll does not move while the poll hangs', async () => {
    const dir = tmp()
    const lastPollFile = join(dir, 'bot.lastpoll')
    const { prev } = fakeTelegram()
    const guard = createPollGuard({ lastPollFile, log: () => {}, slackMs: 80 })
    await expect(guard(prev, 'getUpdates', { timeout: 0 })).rejects.toThrow()
    expect(existsSync(lastPollFile)).toBe(false)
  })

  test('mutation: with no guard the same hung poll is still pending well past the deadline', async () => {
    const { prev } = fakeTelegram()
    const raw = prev('getUpdates', { timeout: 0 }, new AbortController().signal)
    const raced = await Promise.race([raw.then(() => 'answered', () => 'failed'), Bun.sleep(400).then(() => 'still hanging')])
    expect(raced).toBe('still hanging')
  })

  test('a failure streak logs once a minute, not once per retry', async () => {
    let clock = 0
    const lines: string[] = []
    const guard = createPollGuard({ lastPollFile: join(tmp(), 'lp'), log: l => lines.push(l), now: () => clock, logEveryMs: 60_000 })
    const failing = () => Promise.reject(new Error('504: Gateway Timeout'))
    for (let i = 0; i < 25; i++) { clock += 3_000; await guard(failing, 'getUpdates', { timeout: 30 }).catch(() => {}) }
    expect(lines.length).toBe(2) // t=3 s and t=63 s, not 25 lines
    expect(lines[0]).toBe('getUpdates failed (1 in a row): 504: Gateway Timeout; retrying in 3s')
    expect(lines[1]).toMatch(/^getUpdates failed \(\d+ in a row\)/)
    await guard(() => Promise.resolve([]), 'getUpdates', { timeout: 30 })
    expect(lines[2]).toBe('getUpdates recovered after 25 failed attempts')
  })

  test('bot.stop() (the caller aborts) is not logged as a failure, and the abort reaches the transport', async () => {
    const lines: string[] = []
    const { st, prev } = fakeTelegram()
    const guard = createPollGuard({ lastPollFile: join(tmp(), 'lp'), log: l => lines.push(l) })
    const stop = new AbortController()
    const p = guard(prev, 'getUpdates', { timeout: 30 }, stop.signal)
    stop.abort()
    await expect(p).rejects.toThrow()
    expect(st.signals[0]!.aborted).toBe(true)
    expect(lines).toEqual([])
  })

  test('every other method passes through untouched: same signal, no deadline, no lastpoll', async () => {
    const dir = tmp()
    const { st, prev } = fakeTelegram()
    const guard = createPollGuard({ lastPollFile: join(dir, 'lp'), log: () => {}, slackMs: 1 })
    const sig = new AbortController().signal
    await guard(prev, 'sendDocument', { chat_id: 1 }, sig)
    await guard(prev, 'sendMessage', { chat_id: 1, text: 'hi' })
    expect(st.signals).toEqual([sig, undefined])
    expect(existsSync(join(dir, 'lp'))).toBe(false)
  })
})

describe('pollguard: every Telegram bridge installs it', () => {
  test('every plugin copy is byte-identical to telegram/pollguard.ts', () => {
    const want = readFileSync(join(ROOT, 'plugins/telegram/pollguard.ts'), 'utf8')
    for (const f of FORKS) expect(readFileSync(join(ROOT, `plugins/${f}/pollguard.ts`), 'utf8')).toBe(want)
  })

  for (const p of ['telegram', ...FORKS]) {
    test(`${p}: the bot gets the guard right after it is built, and taking the slot starts the poll clock`, () => {
      const src = readFileSync(join(ROOT, `plugins/${p}/server.ts`), 'utf8')
      expect(src).toContain("const LAST_POLL_FILE = join(STATE_DIR, 'bot.lastpoll')")
      expect(src).toMatch(/const bot = new Bot\(TOKEN[^\n]*\n(?:\/\/[^\n]*\n)*bot\.api\.config\.use\(createPollGuard\(\{\n  lastPollFile: LAST_POLL_FILE,/)
      expect(src).toMatch(/bumpHeartbeat\(\);?\s*touchLastPoll\(LAST_POLL_FILE\)/)
      // the beacon keeps its DIVE-818 meaning: still a timer, never tied to poll progress
      expect(src).toMatch(/setInterval\((?:bumpHeartbeat|beat), HEARTBEAT_MS\)/)
    })
  }

  test('telegram-codex ships pollguard.ts in its package files', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'plugins/telegram-codex/package.json'), 'utf8')).files).toContain('pollguard.ts')
  })
})
