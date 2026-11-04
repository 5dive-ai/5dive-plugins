// DIVE-7713 (#1550): a self-hosted box lost agent replies to "control plane
// returned 429". A reply answered 429/5xx is now retried with backoff,
// honouring Retry-After, for up to ~2 minutes, with the same body every try.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPLY_RETRY_BUDGET_MS, replyRetryDelayMs, retryableReplyStatus, sendReplyWithRetry } from '../plugins/dashboard/replyretry.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')

function clock() {
  let t = 1_000_000
  const waits: number[] = []
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms }, waits }
}
const answer = (status: number, headers: Record<string, string> = {}) => new Response(status === 200 ? '{"ok":true}' : '{"error":"x"}', { status, headers })

describe('replyretry.ts', () => {
  test('which answers go again: 429/503 always; other 5xx only with a key; 4xx never', () => {
    for (const s of [429, 503]) { expect(retryableReplyStatus(s, false)).toBe(true); expect(retryableReplyStatus(s, true)).toBe(true) }
    for (const s of [500, 502, 504]) { expect(retryableReplyStatus(s, false)).toBe(false); expect(retryableReplyStatus(s, true)).toBe(true) }
    for (const s of [400, 401, 403, 404, 409, 413]) expect(retryableReplyStatus(s, true)).toBe(false)
  })

  test('Retry-After in seconds or as a date wins; without it the backoff grows to 30s', () => {
    expect(replyRetryDelayMs(0, '1', 0)).toBe(1_000)
    expect(replyRetryDelayMs(3, '7', 0)).toBe(7_000)
    expect(replyRetryDelayMs(0, new Date(20_000).toUTCString(), 10_000)).toBe(10_000)
    expect([0, 1, 2, 3, 4, 5, 9].map(a => replyRetryDelayMs(a, null, 0))).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000])
    expect(replyRetryDelayMs(2, 'soon', 0)).toBe(4_000)
  })

  test('429, 429 (Retry-After: 1), then 200 → the 200, after two 1s waits', async () => {
    const c = clock()
    const seq = [answer(429, { 'retry-after': '1' }), answer(429, { 'retry-after': '1' }), answer(200)]
    let sent = 0
    const res = await sendReplyWithRetry(async () => seq[sent++], { keyed: false, ...c })
    expect(res.status).toBe(200)
    expect(sent).toBe(3)
    expect(c.waits).toEqual([1_000, 1_000])
  })

  test('gives up inside the ~2 minute budget and hands back the last answer', async () => {
    const c = clock()
    let sent = 0
    const res = await sendReplyWithRetry(async () => { sent++; return answer(429) }, { keyed: false, ...c })
    expect(res.status).toBe(429)
    expect(c.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(REPLY_RETRY_BUDGET_MS)
    expect(sent).toBeGreaterThan(5)
  })

  test('an unkeyed reply (the relay) is not resent after a 502 or a dropped connection', async () => {
    const c = clock()
    let sent = 0
    expect((await sendReplyWithRetry(async () => { sent++; return answer(502) }, { keyed: false, ...c })).status).toBe(502)
    expect(sent).toBe(1)
    await expect(sendReplyWithRetry(async () => { sent++; throw new Error('ECONNRESET') }, { keyed: false, ...c })).rejects.toThrow('ECONNRESET')
    expect(sent).toBe(2)
  })

  test('a keyed reply is resent after a 502 and after a dropped connection', async () => {
    const c = clock()
    let sent = 0
    const res = await sendReplyWithRetry(async () => {
      sent++
      if (sent === 1) throw new Error('ECONNRESET')
      return sent === 2 ? answer(502) : answer(200)
    }, { keyed: true, ...c })
    expect(res.status).toBe(200)
    expect(sent).toBe(3)
  })

  test('a 400 is returned at once', async () => {
    let sent = 0
    expect((await sendReplyWithRetry(async () => { sent++; return answer(400) }, { keyed: true, ...clock() })).status).toBe(400)
    expect(sent).toBe(1)
  })
})

type Posted = { body: string; metadata: Record<string, unknown> }

async function boot(script: (n: number, p: Posted) => Response) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-7713-'))
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const posts: Posted[] = []
  const stored = new Map<string, number>()
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') return Response.json({ pending: [] })
      if (url.pathname === '/server/messages/event') {
        const p = (await req.json()) as Posted
        posts.push(p)
        return script(posts.length, p)
      }
      return new Response('not found', { status: 404 })
    },
  })
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
      USER: 'agent-theo',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const results: Record<number, { isError?: boolean; text: string }> = {}
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
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
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          else if (typeof msg.id === 'number') results[msg.id] = { isError: msg.result?.isError || (msg.error ? true : undefined), text: msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error) }
        } catch {}
      }
    }
  })()
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'retry-test', version: '0' } } })
  const reply = async (id: number, text: string, ms: number) => {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: '33', text } } })
    const deadline = Date.now() + ms
    while (!results[id] && Date.now() < deadline) await Bun.sleep(25)
    return results[id]
  }
  const stop = async () => { proc.kill(); await proc.exited; api.stop(true); rmSync(dir, { recursive: true, force: true }) }
  return { posts, stored, reply, stop }
}

describe('dashboard server: the reply tool rides out a 429', () => {
  test('429 twice (Retry-After: 1), then 200 → the tool succeeds, the same reply went three times', async () => {
    const s = await boot((n) => n <= 2
      ? Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'retry-after': '1' } })
      : Response.json({ ok: true, id: 501, conversation: 9 }))
    try {
      const r = await s.reply(7, 'the build is green', 15_000)
      expect(r).toBeDefined()
      expect(r.isError).toBeUndefined()
      expect(s.posts.length).toBe(3)
      // One reply: the same body and the same key on every try.
      expect(new Set(s.posts.map(p => p.body))).toEqual(new Set(['the build is green']))
      const keys = new Set(s.posts.map(p => p.metadata.reply_key))
      expect(keys.size).toBe(1)
      expect(String([...keys][0])).toMatch(/^r-[0-9a-f]{32}$/)
    } finally {
      await s.stop()
    }
  }, 30_000)

  test('a 502 after the server stored it: the retry carries the same key, so the chat has it once', async () => {
    const rows: string[] = []
    const s = await boot((n, p) => {
      const key = String(p.metadata.reply_key)
      if (!rows.includes(key)) rows.push(key)
      return n === 1 ? new Response('bad gateway', { status: 502 }) : Response.json({ ok: true, id: 1, duplicate: true })
    })
    try {
      const r = await s.reply(8, 'stored once', 15_000)
      expect(r.isError).toBeUndefined()
      expect(s.posts.length).toBe(2)
      expect(rows.length).toBe(1)
    } finally {
      await s.stop()
    }
  }, 30_000)

  test('a 400 is not retried and the tool says the reply failed', async () => {
    const s = await boot(() => Response.json({ error: 'invalid agent' }, { status: 400 }))
    try {
      const r = await s.reply(9, 'nope', 10_000)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('control plane returned 400')
      expect(s.posts.length).toBe(1)
    } finally {
      await s.stop()
    }
  }, 30_000)
})
