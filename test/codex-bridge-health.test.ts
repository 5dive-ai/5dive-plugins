import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HEALTH_FILE,
  HEALTH_HEARTBEAT_MS,
  HEALTH_SCHEMA,
  classifyHealth,
  modelStatusLines,
  readHealth,
  renderHealth,
  staleAfterMs,
  writeHealth,
  type ChannelHealth,
} from '../plugins/telegram-codex/health.ts'

const NOW = new Date('2026-09-13T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

function record(over: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    schema: HEALTH_SCHEMA,
    bridge: 'codex-dispatcher',
    bridgeVersion: '0.5.18',
    pid: 4242,
    startedAt: ago(600_000),
    updatedAt: ago(5_000),
    heartbeatMs: HEALTH_HEARTBEAT_MS,
    declared: ['telegram', 'dashboard'],
    listening: ['telegram', 'dashboard'],
    bound: true,
    threadId: 'thread-1',
    lastInboundAt: ago(30_000),
    lastOutboundAt: ago(20_000),
    queueDepth: 0,
    ...over,
  }
}

const classify = (health: ChannelHealth | null, over: Partial<Parameters<typeof classifyHealth>[0]> = {}) =>
  classifyHealth({ health, declared: ['telegram', 'dashboard'], serviceActive: true, now: NOW, ...over })

describe('healthy', () => {
  test('a fresh, bound handshake whose listening set matches the registry', () => {
    const v = classify(record())
    expect(v.state).toBe('healthy')
    expect(v.repair).toBe('none')
    expect(v.detail).toContain('telegram,dashboard')
  })

  test('an active turn and a queue are reported, not treated as unhealthy', () => {
    const v = classify(record({ queueDepth: 3, active: { turnId: 'turn-9', source: 'telegram', startedAt: ago(1_000) } }))
    expect(v.state).toBe('healthy')
    expect(v.detail).toContain('turn-9')
    expect(v.detail).toContain('3 queued')
  })

  test('nothing declared is nothing to bind — never a defect', () => {
    const v = classify(null, { declared: [] })
    expect(v.state).toBe('healthy')
    expect(v.repair).toBe('none')
  })

  test('the rendered line carries the fields an operator has to act on', () => {
    const h = record({ queueDepth: 2 })
    const line = renderHealth(classify(h), h)
    expect(line).toContain('bridge 0.5.18')
    expect(line).toContain('queue 2')
    expect(line).toContain(h.lastInboundAt!)
    expect(line).toContain(h.lastOutboundAt!)
  })
})

describe('stale', () => {
  test('a handshake past its window is a dead bridge, not a bound one', () => {
    const v = classify(record({ updatedAt: ago(20 * 60_000) }))
    expect(v.state).toBe('stale')
    expect(v.repair).toBe('restart')
    expect(v.detail).toContain('1200s ago')
    expect(v.detail).toContain('pid 4242')
  })

  test("a stale record's `bound: true` is never believed", () => {
    // The whole point of the ticket: the pane probe could not tell these apart.
    const fresh = classify(record())
    const stale = classify(record({ updatedAt: ago(10 * 60_000) }))
    expect(fresh.state).toBe('healthy')
    expect(stale.state).not.toBe('healthy')
  })

  test('one missed heartbeat is not stale — the bias stays false-negative', () => {
    expect(classify(record({ updatedAt: ago(HEALTH_HEARTBEAT_MS + 1_000) })).state).toBe('healthy')
    expect(staleAfterMs(record())).toBe(60_000)
  })

  test('a bridge cannot make itself permanently stale with a tiny cadence', () => {
    expect(staleAfterMs(record({ heartbeatMs: 10 }))).toBe(60_000)
    expect(staleAfterMs(record({ heartbeatMs: 120_000 }))).toBe(360_000)
  })

  test('an unreadable updatedAt is reported, never restarted blind', () => {
    const v = classify(record({ updatedAt: 'not-a-date' }))
    expect(v.state).toBe('stale')
    expect(v.repair).toBe('report')
  })
})

describe('mismatched', () => {
  test('declared-but-not-listening names the channel and offers a restart', () => {
    const v = classify(record({ listening: ['telegram'] }))
    expect(v.state).toBe('mismatched')
    expect(v.repair).toBe('restart')
    expect(v.detail).toContain('declared but not listening: dashboard')
  })

  test('listening-but-not-declared is a disagreement too', () => {
    const v = classify(record(), { declared: ['telegram'] })
    expect(v.state).toBe('mismatched')
    expect(v.detail).toContain('listening but not declared: dashboard')
  })

  test('a mismatch WITH a named cause is reported — a restart cannot fix a dead token', () => {
    const v = classify(record({
      listening: ['telegram'],
      failure: { at: ago(30_000), channel: 'dashboard', cause: 'adapter exited code=1 signal=none' },
    }))
    expect(v.state).toBe('mismatched')
    expect(v.repair).toBe('report')
    expect(v.detail).toContain('adapter exited code=1')
  })

  test('set comparison ignores order and duplicates', () => {
    expect(classify(record({ listening: ['dashboard', 'telegram', 'telegram'] })).state).toBe('healthy')
  })
})

describe('unbound and failed', () => {
  test('running with no live thread is unbound, and restartable', () => {
    const v = classify(record({ bound: false, threadId: undefined }))
    expect(v.state).toBe('unbound')
    expect(v.repair).toBe('restart')
  })

  test('an unbound bridge WITH a cause reports the cause verbatim', () => {
    const v = classify(record({
      bound: false,
      failure: { at: ago(10_000), channel: 'bridge', cause: 'app-server exited code=127 signal=none' },
    }))
    expect(v.state).toBe('failed')
    expect(v.repair).toBe('report')
    expect(v.detail).toContain('code=127')
    expect(v.detail).toContain('bridge')
  })
})

describe('absent', () => {
  test('no handshake under a live service is a bridge that never started', () => {
    const v = classify(null)
    expect(v.state).toBe('absent')
    expect(v.repair).toBe('restart')
  })

  test('no handshake under a dead service is expected, and never repaired', () => {
    const v = classify(null, { serviceActive: false })
    expect(v.state).toBe('absent')
    expect(v.repair).toBe('none')
    expect(v.detail).toContain('start the agent first')
  })

  test('a schema this build cannot read is reported, never guessed at', () => {
    const v = classify(record({ schema: HEALTH_SCHEMA + 1 }))
    expect(v.repair).toBe('report')
    expect(v.detail).toContain('upgrade')
  })
})

describe('failed repair', () => {
  test('a restart is withdrawn once the attempts are spent', () => {
    const stale = record({ updatedAt: ago(20 * 60_000) })
    expect(classify(stale, { repairAttempts: 1, maxRepairs: 2 }).repair).toBe('restart')
    const spent = classify(stale, { repairAttempts: 2, maxRepairs: 2 })
    expect(spent.repair).toBe('report')
    expect(spent.state).toBe('stale')
    expect(spent.detail).toContain('2 restart(s) did not heal it')
  })

  test('every restartable state honours the ceiling', () => {
    const spent = { repairAttempts: 3, maxRepairs: 2 }
    expect(classify(null, spent).repair).toBe('report')
    expect(classify(record({ bound: false }), spent).repair).toBe('report')
    expect(classify(record({ listening: [] }), spent).repair).toBe('report')
  })

  test('a healthy bridge is never restarted, whatever the attempt count', () => {
    expect(classify(record(), { repairAttempts: 9, maxRepairs: 2 }).repair).toBe('none')
  })
})

describe('the file on disk', () => {
  test('write then read round-trips, and a corrupt file reads as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-health-'))
    try {
      expect(readHealth(dir)).toBeNull()
      const h = record()
      writeHealth(dir, h)
      expect(readHealth(dir)).toEqual(h)
      writeFileSync(join(dir, HEALTH_FILE), '{ not json')
      expect(readHealth(dir)).toBeNull()
      // An absent/corrupt file must be a REPORTED state, not a thrown reader.
      expect(classify(readHealth(dir)).state).toBe('absent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('writing to an unwritable path never throws', () => {
    expect(() => writeHealth('/proc/nope/nowhere', record())).not.toThrow()
  })
})

describe('/status model line (DIVE-4924)', () => {
  const cfg = { model: 'gpt-6-astra', effort: 'high' }
  const now = NOW.getTime()

  test('one line when the conversation runs what the config names', () => {
    expect(modelStatusLines(cfg, record({ threadModel: 'gpt-6-astra', threadEffort: 'high' }), now))
      .toEqual(['model: gpt-6-astra · high'])
  })

  test('a thread still on the old model is shown, not hidden behind the config', () => {
    const lines = modelStatusLines(cfg, record({ threadModel: 'gpt-6-sol', threadEffort: 'high' }), now)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('model: gpt-6-astra · high')
    expect(lines[1]).toStartWith('conversation: gpt-6-sol · high')
  })

  test('an effort mismatch alone is a mismatch', () => {
    expect(modelStatusLines(cfg, record({ threadModel: 'gpt-6-astra', threadEffort: 'low' }), now)).toHaveLength(2)
  })

  test('a stale, absent, or pre-4924 record says nothing about the conversation', () => {
    expect(modelStatusLines(cfg, record({ threadModel: 'gpt-6-sol', updatedAt: ago(3_600_000) }), now)).toEqual(['model: gpt-6-astra · high'])
    expect(modelStatusLines(cfg, null, now)).toEqual(['model: gpt-6-astra · high'])
    expect(modelStatusLines(cfg, record(), now)).toEqual(['model: gpt-6-astra · high'])
    expect(modelStatusLines({ model: null, effort: null }, null, now)).toEqual([])
  })
})
