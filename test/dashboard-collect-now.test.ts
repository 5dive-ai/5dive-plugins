// DIVE-3574: the dashboard chat's collect nudge, end to end on the box side.
//
// The row's complaint is a LATENCY one — "queued, this box collects every ~5
// min" — so this drives the REAL plugins/dashboard/server.ts as a subprocess
// against a stub control plane and MEASURES the time from the nudge marker
// landing to the collect actually happening. A static assertion that a watcher
// exists cannot tell you the perceived wait changed, which is the only thing
// the row is about.
//
// It also covers the correctness risk the nudge introduces and the 5-minute
// timer never could: drainPending used to be reachable only from two callers
// that could not overlap. A nudge can fire several times a second while
// someone types, and two concurrent drains fetch the SAME pending rows and
// push each message into the session TWICE, because the ack only lands after
// the notifications are sent.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
// server.ts deliberately gives the harness a 5s head start before its first
// drain and before the watchers install (a notification pushed inside that
// window is silently dropped). Everything here waits that out.
const BOOT_MS = 5_000

type Harness = {
  dir: string
  pendingHits: number[]
  delivered: string[]
  stop: () => void
  nudge: () => void
  enqueue: (msgs: Array<{ id: number; text: string }>) => void
  waitFor: (pred: () => boolean, ms: number) => Promise<boolean>
}

async function start(
  pending: Array<{ id: number; text: string }>,
  fetchDelayMs = 150
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'collect-now-'))
  const pendingHits: number[] = []
  const delivered: string[] = []
  let queue = [...pending]

  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') {
        pendingHits.push(Date.now())
        // Snapshot at REQUEST time, then delay — a real control plane reads the
        // rows when the request arrives, not when the response is written. A
        // stub that re-reads after the delay hands the second, overlapping
        // drain the state AFTER the first one's ack, which silently removes the
        // race this test exists to observe (it let a removed serialisation
        // guard pass green). The delay is what makes a drain long enough for
        // the next one to start inside it. Graded: with the guard removed from
        // server.ts, the burst test below goes red.
        const snapshot = queue
        await Bun.sleep(fetchDelayMs)
        return Response.json({ pending: snapshot })
      }
      if (url.pathname === '/server/messages/pending/ack') {
        const body = (await req.json()) as { ids: number[] }
        queue = queue.filter(m => !body.ids.includes(m.id))
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: dir,
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
      USER: 'agent-dev',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Minimal MCP peer: the server only starts its watchers after connect().
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'collect-now-test', version: '0' },
      },
    }) + '\n'
  )
  proc.stdin.flush()

  // Count each message the server pushes into the "session".
  void (async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method === 'notifications/claude/channel') {
            delivered.push(String(msg.params?.content ?? ''))
          }
          if (msg.id === 1) {
            proc.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
            )
            proc.stdin.flush()
          }
        } catch {}
      }
    }
  })()

  const nudgeDir = join(dir, 'collect-now')
  return {
    dir,
    pendingHits,
    delivered,
    stop: () => {
      proc.kill()
      api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
    enqueue: msgs => {
      queue = [...queue, ...msgs]
    },
    nudge: () => {
      mkdirSync(nudgeDir, { recursive: true })
      // Byte-for-byte what shelld's /shell/collect-now leaves behind: a
      // zero-length file at one constant path, rewritten in place.
      writeFileSync(join(nudgeDir, 'nudge'), '')
    },
    waitFor: async (pred, ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (pred()) return true
        await Bun.sleep(25)
      }
      return pred()
    },
  }
}

describe('dashboard collect-now nudge (DIVE-3574)', () => {
  test('a nudge collects in about a second, not the five minutes the timer would take', async () => {
    const h = await start([{ id: 1, text: 'hello from the dashboard' }])
    try {
      // Wait out the boot drain so the measurement starts from a quiet box.
      await h.waitFor(() => h.pendingHits.length >= 1, BOOT_MS + 3_000)
      const before = h.pendingHits.length
      const t0 = Date.now()
      h.nudge()
      const collected = await h.waitFor(() => h.pendingHits.length > before, 5_000)
      const latency = Date.now() - t0
      expect(collected).toBe(true)
      // The unchanged fallback timer is 5 * 60_000. Anything in this range can
      // only have come from the nudge.
      expect(latency).toBeLessThan(3_000)
      console.log(`nudge -> collect latency: ${latency}ms (fallback timer: 300000ms)`)
    } finally {
      h.stop()
    }
  }, 20_000)

  test('overlapping nudges deliver each message EXACTLY once', async () => {
    // A slow pending-fetch so a drain is genuinely in flight when the next
    // nudge fires. Nudges are spaced WIDER than the 250ms debounce on purpose:
    // the debounce alone coalesces a fast burst, so a fast burst cannot show
    // whether concurrent drains are prevented. Only a nudge that clears the
    // debounce and still lands mid-drain exercises the guard.
    const h = await start([], 900)
    try {
      await h.waitFor(() => h.pendingHits.length >= 1, BOOT_MS + 5_000)
      h.enqueue([
        { id: 1, text: 'first' },
        { id: 2, text: 'second' },
      ])
      for (let i = 0; i < 4; i++) {
        h.nudge()
        await Bun.sleep(300)
      }
      await h.waitFor(() => h.delivered.length >= 2, 8_000)
      await Bun.sleep(2_000)
      expect(h.delivered.filter(t => t === 'first')).toHaveLength(1)
      expect(h.delivered.filter(t => t === 'second')).toHaveLength(1)
    } finally {
      h.stop()
    }
  }, 40_000)

  test('the 5-minute fallback poll is untouched — the nudge is an accelerator, not a replacement', () => {
    // lodar's scope guard on this row, asserted against the source rather than
    // trusted: the nudge is best-effort, so the timer must remain load-bearing.
    const src = readFileSync(SERVER, 'utf8')
    expect(src).toContain('setInterval(() => void drainPending(), 5 * 60_000)')
    // And the nudge must never become a second delivery path: the watcher's
    // only action is to run the collect the box already runs. Slice to the
    // function's OWN closing brace — an open-ended slice runs to end of file
    // and then asserts about every function below it instead of this one.
    const from = src.indexOf('function startCollectNowWatch')
    expect(from).toBeGreaterThan(-1)
    const watcher = src.slice(from, src.indexOf('\n}\n', from) + 3)
    expect(watcher).toContain('void drainPending()')
    expect(watcher).not.toContain('notification(')
    expect(watcher).not.toContain('fetch(')
  })
})
