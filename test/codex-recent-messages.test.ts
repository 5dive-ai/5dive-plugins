// DIVE-5504 item 6: recent_messages for telegram-codex. The bridge keeps
// Claude's bounded per-chat rolling log (msglog.ts, DIVE-1028), exposes it as
// the `recent_messages` MCP tool, and — because the dispatcher's model has no
// MCP tools — carries the chat's last messages into the first turn after a
// LOST thread, so the owner is not asked to repeat themselves.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ChannelDispatcher, recoveryTranscript, type DispatchMessage, type DispatcherState, type RpcPort, type TranscriptRow,
} from '../plugins/telegram-codex/dispatcher-core.ts'

const root = join(import.meta.dir, '..', 'plugins')
const row = (dir: 'in' | 'out', text: string, user = 'lodar'): TranscriptRow => ({ ts: '2026-10-04T10:00:00Z', dir, user, text })
const tg = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })

function harness(initial: DispatcherState | null, rows: TranscriptRow[], resumeFails: boolean) {
  let saved = initial ? structuredClone(initial) : null
  const requests: Array<{ method: string; params: any }> = []
  const asked: string[] = []
  let thread = 10
  let turn = 1
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/resume') {
        if (resumeFails) throw new Error('no rollout found')
        return { thread: { id: params.threadId } }
      }
      if (method === 'thread/start') return { thread: { id: `thread-${thread++}` } }
      if (method === 'turn/start') return { turn: { id: `turn-${turn++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    { load: () => saved ? structuredClone(saved) : null, save: s => { saved = structuredClone(s) } },
    { publish: async () => {}, transcript: route => { asked.push(route.chat_id); return rows } },
    '/w',
  )
  const texts = () => (requests.filter(r => r.method === 'turn/start').at(-1)!.params.input as any[]).map(i => i.text ?? '')
  return { dispatcher, texts, asked }
}

const prior: DispatcherState = { schema: 1, threadId: 'thread-old', seen: [], pending: [] } as DispatcherState
const chat = [row('in', 'deploy the blog'), row('out', 'Deployed; the preview is at /tmp/x.md', 'theo'), row('in', 'now the tests')]

describe('recovery transcript', () => {
  test('a LOST thread: the next turn carries the chat\'s last messages, minus the message being answered', async () => {
    const h = harness(prior, chat, true)
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1', 'now the tests'))
    const [recovery, transcript, msg] = h.texts()
    expect(recovery).toContain('could not be resumed')
    expect(transcript).toBe('[5dive recovery] The earlier conversation is not in this thread. The last messages in this chat, oldest first, '
      + 'as background only (do not redo them):\nlodar: deploy the blog\nyou: Deployed; the preview is at /tmp/x.md')
    expect(msg).toBe('now the tests')
    expect(h.asked).toEqual(['42'])
  })

  test('only once: the turn after it carries no transcript', async () => {
    const h = harness(prior, chat, true)
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1', 'now the tests'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    await h.dispatcher.submit(tg('m2', 'and lint'))
    expect(h.texts()).toEqual(['and lint'])
  })

  test('NEGATIVE: a resumed thread still has its history, so no transcript is read or sent', async () => {
    const h = harness(prior, chat, false)
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1', 'now the tests'))
    expect(h.texts()).toEqual(['now the tests'])
    expect(h.asked).toEqual([])
  })

  test('bounded: at most 12 rows and ~4000 characters, newest kept', () => {
    const many = Array.from({ length: 40 }, (_, i) => row('in', `msg ${i} ${'x'.repeat(500)}`))
    const t = recoveryTranscript(many, 'current')
    const lines = t.split('\n').slice(1)
    expect(lines.length).toBeLessThanOrEqual(12)
    expect(t.length).toBeLessThan(4400)
    expect(lines.at(-1)).toContain('msg 39')
    expect(recoveryTranscript([], 'x')).toBe('')
  })
})

describe('the recent_messages tool', () => {
  const server = readFileSync(join(root, 'telegram-codex', 'server.ts'), 'utf8')
  test('msglog.ts is Claude\'s, byte for byte', () => {
    expect(readFileSync(join(root, 'telegram-codex', 'msglog.ts'), 'utf8')).toBe(readFileSync(join(root, 'telegram', 'msglog.ts'), 'utf8'))
  })
  test('the tool exists, is scoped to an allowed chat, and the log records inbound and replies', () => {
    expect(server).toContain("name: 'recent_messages'")
    expect(server).toMatch(/case 'recent_messages': \{[\s\S]{0,300}if \(rawChat\) assertAllowedChat\(rawChat\)/)
    expect(server).toMatch(/logMessage\(String\(chat\.id\), 'in'/)
    expect(server).toMatch(/logMessage\(chat_id, 'out', agentName\(\)/)
    expect(server).toMatch(/logMessage\(String\(obj\.chat_id\), 'out', agentName\(\)/)
  })
})
