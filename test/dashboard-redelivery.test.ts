// DIVE-4125: a pending dashboard row must keep its control-plane identity,
// expose each delivery attempt, and stop after a bounded number of failed
// acknowledgements. This drives the real plugin process because a pure helper
// test cannot prove the metadata actually reaches the channel notification.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextPendingAttempt } from '../plugins/dashboard/pending-redelivery.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000

type Delivery = { content: string; meta: Record<string, unknown> }

async function start() {
  const dir = `${tmpdir()}/dashboard-redelivery-${process.pid}-${Date.now()}`
  mkdirSync(dir, { recursive: true })
  let queue = [{ id: 41, text: 'one original ping', chat_id: '1', ts: '2026-09-09T02:06:05.111Z' }]
  const deliveries: Delivery[] = []

  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') return Response.json({ pending: queue })
      // A 200 with acked=0 is still a failed acknowledgement. This was the
      // deceptive live shape: transport/auth looked healthy while the row
      // remained pending.
      if (url.pathname === '/server/messages/pending/ack') return Response.json({ ok: true, acked: 0 })
      return new Response('not found', { status: 404 })
    },
  })

  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: dir,
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      DASHBOARD_REDELIVERY_BACKOFF_MS: '10',
      CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
      USER: 'agent-dev',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'redelivery-test', version: '0' } },
  })}\n`)
  proc.stdin.flush()

  void (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.id === 1) {
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
            proc.stdin.flush()
          }
          if (message.method === 'notifications/claude/channel') {
            deliveries.push({
              content: String(message.params?.content ?? ''),
              meta: message.params?.meta ?? {},
            })
          }
        } catch {}
      }
    }
  })()

  const nudge = async () => {
    mkdirSync(join(dir, 'collect-now'), { recursive: true })
    writeFileSync(join(dir, 'collect-now', 'nudge'), '')
    await Bun.sleep(350)
  }
  const waitFor = async (predicate: () => boolean, timeout: number) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (predicate()) return true
      await Bun.sleep(25)
    }
    return predicate()
  }
  return {
    dir,
    deliveries,
    enqueue: (row: { id: number; text: string; chat_id: string; ts: string }) => { queue = [...queue, row] },
    nudge,
    waitFor,
    stop: () => {
      proc.kill()
      api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('dashboard pending redelivery (DIVE-4125)', () => {
  test('the retry decision backs off exponentially and parks at the bound', () => {
    const first = nextPendingAttempt(undefined, 1_000, 100)
    expect(first.kind).toBe('deliver')
    if (first.kind !== 'deliver') throw new Error('unreachable')
    expect(nextPendingAttempt(first.next, 1_099, 100)).toEqual({ kind: 'backoff', retryAt: 1_100 })

    const second = nextPendingAttempt(first.next, 1_100, 100)
    expect(second.kind).toBe('deliver')
    if (second.kind !== 'deliver') throw new Error('unreachable')
    expect(nextPendingAttempt(second.next, 1_299, 100)).toEqual({ kind: 'backoff', retryAt: 1_300 })

    const third = nextPendingAttempt(second.next, 1_300, 100)
    expect(third.kind).toBe('deliver')
    if (third.kind !== 'deliver') throw new Error('unreachable')
    expect(nextPendingAttempt(third.next, 2_000, 100)).toMatchObject({ kind: 'park', log: true })
  })

  test('failed acks preserve identity, expose attempts, cap retries, and leave a file-backed trace', async () => {
    const h = await start()
    try {
      expect(await h.waitFor(() => h.deliveries.length === 1, BOOT_MS + 5_000)).toBe(true)
      await h.nudge()
      await h.nudge()
      expect(await h.waitFor(() => h.deliveries.length === 3, 2_000)).toBe(true)

      // A fourth eligible drain parks row 41 instead of pushing it forever.
      await h.nudge()
      expect(h.deliveries.filter(d => d.meta.message_id === '41')).toHaveLength(3)

      const first = h.deliveries.filter(d => d.meta.message_id === '41')
      expect(first.map(d => d.meta.delivery_attempt)).toEqual([1, 2, 3])
      expect(first.map(d => d.meta.redelivery)).toEqual([false, true, true])
      expect(new Set(first.map(d => d.meta.delivered_at)).size).toBe(3)
      const seen = new Set<string>()
      const accepted = first.filter(d => {
        const identity = `${d.meta.chat_id}:${d.meta.message_id}`
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
      })
      expect(accepted).toHaveLength(1)

      // Harness-side dedup on the stable tuple accepts the original once, but
      // a genuinely new control-plane row remains independently deliverable.
      h.enqueue({ id: 42, text: 'a genuinely new message', chat_id: '1', ts: '2026-09-09T03:00:00.000Z' })
      await h.nudge()
      expect(await h.waitFor(() => h.deliveries.some(d => d.meta.message_id === '42'), 2_000)).toBe(true)
      expect(new Set(h.deliveries.map(d => `${d.meta.chat_id}:${d.meta.message_id}`)).size).toBe(2)

      const lifecycle = join(h.dir, 'lifecycle.log')
      expect(existsSync(lifecycle)).toBe(true)
      const log = readFileSync(lifecycle, 'utf8')
      expect(log).toContain('pending ack failed ids=41')
      expect(log).toContain('pending message id=41 parked after 3 unacknowledged attempts')
      const state = JSON.parse(readFileSync(join(h.dir, 'pending-redelivery.json'), 'utf8'))
      expect(state['41']).toMatchObject({ attempts: 3, parkedLogged: true })
    } finally {
      h.stop()
    }
  }, 20_000)
})
