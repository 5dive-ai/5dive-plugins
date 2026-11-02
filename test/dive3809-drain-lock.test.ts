// DIVE-3809 scope 3: the drain guard must serialise ACROSS PROCESSES.
//
// server.ts's `draining`/`rerun` pair is module state — it serialises the three
// callers inside ONE process and is blind to a second one. Two plugin processes
// for the same agent (an overlapping restart, a stray respawn) each fetch the
// SAME pending rows and push every message into the session TWICE, because the
// ack only lands after the notifications are sent.
//
// DIVE-3806 REFUTED this as the cause of the loss it observed — lifecycle.log
// showed exactly one live process across that window — so this is not a fix for
// that. It is a real race, it is scope 3, and dashboard-collect-now.test.ts
// cannot see it: that harness runs a single process, so it grades the
// per-process half and would stay green with the lock deleted.
//
// The arm therefore runs TWO real server.ts processes against ONE stub control
// plane and ONE shared state dir, and counts pushes across BOTH.
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000

function spawnPlugin(dir: string, port: number, delivered: string[]) {
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: dir,
      DASHBOARD_API_BASE: `http://127.0.0.1:${port}`,
      CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
      USER: 'agent-dev',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lock-test', version: '0' } },
    }) + '\n'
  )
  proc.stdin.flush()
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
          if (msg.method === 'notifications/claude/channel') delivered.push(String(msg.params?.content ?? ''))
          if (msg.id === 1) {
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            proc.stdin.flush()
          }
        } catch {}
      }
    }
  })()
  return proc
}

async function waitFor(pred: () => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

function bootIdNow(): string {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return '-' }
}

// A pid that existed and is gone: spawn and reap a short-lived process.
function deadPid(): number {
  const p = Bun.spawnSync(['sh', '-c', 'echo $$'])
  return Number(new TextDecoder().decode(p.stdout).trim())
}

function stubApi(queue: () => Array<{ id: number; text: string }>, ack: (ids: number[]) => void) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') return Response.json({ pending: queue() })
      if (url.pathname === '/server/messages/pending/ack') {
        const body = (await req.json()) as { ids: number[] }
        ack(body.ids)
        return Response.json({ ok: true, acked: body.ids.length })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

describe('cross-process drain lock (DIVE-3809)', () => {
  test('two plugin processes on one state dir push each message EXACTLY once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-lock-'))
    const delivered: string[] = []
    let queue = [
      { id: 1, text: 'first' },
      { id: 2, text: 'second' },
    ]
    let pendingHits = 0
    // Snapshot at REQUEST time then delay, exactly as dashboard-collect-now
    // does: a stub that re-reads after the delay hands the second drain the
    // state AFTER the first one's ack and silently removes the race.
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') {
          pendingHits++
          const snapshot = queue
          await Bun.sleep(900)
          return Response.json({ pending: snapshot })
        }
        if (url.pathname === '/server/messages/pending/ack') {
          const body = (await req.json()) as { ids: number[] }
          queue = queue.filter(m => !body.ids.includes(m.id))
          return Response.json({ ok: true, acked: body.ids.length })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const a = spawnPlugin(dir, api.port, delivered)
    const b = spawnPlugin(dir, api.port, delivered)
    try {
      // Both boot drains fire ~5s after start, i.e. genuinely overlapping.
      await waitFor(() => delivered.length >= 2, BOOT_MS + 10_000)
      // Settle: give a second (unserialised) drain every chance to double-push.
      await Bun.sleep(3_000)
      const counts = new Map<string, number>()
      for (const d of delivered) counts.set(d, (counts.get(d) ?? 0) + 1)
      expect(delivered.length).toBeGreaterThanOrEqual(2)
      expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([])
      expect(pendingHits).toBeGreaterThan(0)
    } finally {
      a.kill(); b.kill(); api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  test('a stale lock left by a killed drain is broken, not honoured forever', async () => {
    // The failure this forecloses: a lock file is the classic way to turn an
    // intermittent loss into a permanent one. A drain killed mid-flight leaves
    // the file behind, and if nothing breaks it the collect path is wedged for
    // the life of the box — strictly worse than the bug being fixed.
    const dir = mkdtempSync(join(tmpdir(), 'stale-lock-'))
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'pending-drain.lock')
    writeFileSync(lock, '999999 stale\n')
    // Age it well past the 2-minute staleness bound. utimesSync, not `touch
    // -d` — bun's built-in shell does not implement that flag.
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, old, old)
    const delivered: string[] = []
    let queue = [{ id: 7, text: 'after a crash' }]
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') return Response.json({ pending: queue })
        if (url.pathname === '/server/messages/pending/ack') {
          const body = (await req.json()) as { ids: number[] }
          queue = queue.filter(m => !body.ids.includes(m.id))
          return Response.json({ ok: true, acked: body.ids.length })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const p = spawnPlugin(dir, api.port, delivered)
    try {
      const got = await waitFor(() => delivered.length >= 1, BOOT_MS + 10_000)
      expect(got).toBe(true)
      expect(delivered[0]).toBe('after a crash')
      // And the drain cleaned up after itself, so the next pass is not blocked.
      // The push lands before the ack and the release, so wait for the unlink
      // rather than reading the file the instant the message shows up.
      expect(await waitFor(() => !existsSync(lock), 5_000)).toBe(true)
    } finally {
      p.kill(); api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  // DIVE-7573 (D5): an adapter killed mid long-poll leaves a FRESH lock. The
  // age bound honoured it for 2 minutes, so the chat was deaf for 80-120 s
  // after every agent restart. A lock whose owner pid is gone, or that was
  // written in an earlier boot, is broken at once — and a live owner's fresh
  // lock is still honoured (the cross-process guard above must not weaken).
  for (const [name, body] of [
    ['a dead pid', () => `${deadPid()} ${bootIdNow()} ${new Date().toISOString()}\n`],
    ['an earlier boot', () => `${process.pid} 00000000-0000-0000-0000-000000000000 ${new Date().toISOString()}\n`],
  ] as const) {
    test(`a FRESH lock left by ${name} is broken at once, not after 2 minutes`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dead-owner-lock-'))
      const lock = join(dir, 'pending-drain.lock')
      writeFileSync(lock, body())   // mtime = now: the age bound alone would honour it
      const delivered: string[] = []
      let queue = [{ id: 9, text: 'right after a restart' }]
      const api = stubApi(() => queue, ids => { queue = queue.filter(m => !ids.includes(m.id)) })
      const p = spawnPlugin(dir, api.port, delivered)
      try {
        expect(await waitFor(() => delivered.length >= 1, BOOT_MS + 10_000)).toBe(true)
        expect(delivered[0]).toBe('right after a restart')
      } finally {
        p.kill(); api.stop(true)
        rmSync(dir, { recursive: true, force: true })
      }
    }, 40_000)
  }

  test('a FRESH lock held by a LIVE process is still honoured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-owner-lock-'))
    const lock = join(dir, 'pending-drain.lock')
    // This test process is alive and is not the plugin: a live foreign owner.
    writeFileSync(lock, `${process.pid} ${bootIdNow()} ${new Date().toISOString()}\n`)
    const delivered: string[] = []
    let queue = [{ id: 11, text: 'must wait for the holder' }]
    const api = stubApi(() => queue, ids => { queue = queue.filter(m => !ids.includes(m.id)) })
    const p = spawnPlugin(dir, api.port, delivered)
    try {
      await Bun.sleep(BOOT_MS + 3_000)
      expect(delivered).toEqual([])
      expect(existsSync(lock)).toBe(true)
    } finally {
      p.kill(); api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  test('a plugin stopped mid long-poll releases the lock on exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-release-'))
    const lock = join(dir, 'pending-drain.lock')
    const delivered: string[] = []
    let inPoll = false
    // Hold every pending request open, like the chat-only long poll does.
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') { inPoll = true; await Bun.sleep(30_000); return Response.json({ pending: [] }) }
        return new Response('not found', { status: 404 })
      },
    })
    const p = spawnPlugin(dir, api.port, delivered)
    try {
      expect(await waitFor(() => inPoll && existsSync(lock), BOOT_MS + 10_000)).toBe(true)
      p.kill('SIGTERM')
      await p.exited
      expect(existsSync(lock)).toBe(false)
    } finally {
      p.kill(); api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})
