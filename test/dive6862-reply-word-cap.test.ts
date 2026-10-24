// DIVE-6862: the chat reply tool refuses a reply over 70 words and sends
// nothing, so the model cuts it before the owner sees it (dashboard + telegram).
// The pack line alone left 27 of 30 graded replies over 60 words.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countReplyWords, replyTooLong, replyWordCap, REPLY_TOO_LONG_RE, REPLY_WORD_CAP } from '../plugins/telegram/replycap.ts'
import { analyzeTurn, refusedTooLongIds, REPLY_TOO_LONG_RE as HOOK_RE } from '../plugins/telegram/hooks/lib/transcript.ts'
import { answeredAfter, usedToolAfter } from '../plugins/dashboard/hooks/lib/dashboard-chat.ts'
import type { TranscriptEntry } from '../plugins/telegram/hooks/lib/types.ts'

const ROOT = join(import.meta.dir, '..')
const SERVER = join(ROOT, 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('replycap.ts: the count and the refusal', () => {
  test('70 words pass; 71 are refused with the count and the way out in the message', () => {
    expect(REPLY_WORD_CAP).toBe(70)
    expect(replyTooLong(words(70), 70)).toBeNull()
    const msg = replyTooLong(words(71), 70)!
    expect(msg).toStartWith('too long: 71 words; cut to 60 or attach a file and name it in one line')
    expect(msg).toContain('Nothing was sent')
  })

  test('a closed fenced block is not counted; an unclosed fence is prose', () => {
    const code = '```bash\n' + words(200) + '\n```'
    expect(countReplyWords(`${words(50)}\n${code}\n${words(10)}`)).toBe(60)
    expect(replyTooLong(`${words(50)}\n${code}`, 70)).toBeNull()
    expect(countReplyWords('~~~~\n' + words(40) + '\n~~~~\nok')).toBe(1)
    // A shorter or different fence inside does not close it.
    expect(countReplyWords('````\n```\n' + words(40) + '\n````\nok')).toBe(1)
    expect(countReplyWords('```\n' + words(80))).toBe(80)
    expect(replyTooLong('```\n' + words(80), 70)).not.toBeNull()
  })

  test('a URL is one word; dashes, bullets and emoji are none; Cyrillic counts', () => {
    expect(countReplyWords('see https://my.5dive.ai/self-host?a=1&b=2 now')).toBe(3)
    expect(countReplyWords('- one — two\n- three 👍')).toBe(3)
    expect(countReplyWords('Готово, всё работает.')).toBe(3)
  })

  test('a files-only reply (empty or missing text) passes; files never exempt the text', () => {
    expect(replyTooLong('', 70)).toBeNull()
    expect(replyTooLong(undefined, 70)).toBeNull()
    expect(replyTooLong(null, 70)).toBeNull()
    // The check sees only text: a long text with files attached is still refused.
    expect(replyTooLong(words(90), 70)).not.toBeNull()
  })

  test('FIVEDIVE_REPLY_MAX_WORDS overrides the cap; 0 turns it off; junk keeps 70', () => {
    expect(replyWordCap({})).toBe(70)
    expect(replyWordCap({ FIVEDIVE_REPLY_MAX_WORDS: '0' })).toBe(0)
    expect(replyWordCap({ FIVEDIVE_REPLY_MAX_WORDS: '120' })).toBe(120)
    expect(replyWordCap({ FIVEDIVE_REPLY_MAX_WORDS: 'lots' })).toBe(70)
    expect(replyWordCap({ FIVEDIVE_REPLY_MAX_WORDS: '-3' })).toBe(70)
    expect(replyTooLong(words(500), 0)).toBeNull()
    expect(replyTooLong(words(30), 20)).toStartWith('too long: 30 words; cut to 20')
  })

  test('the two plugin copies are byte-identical, and the hooks find the refusal it writes', () => {
    expect(readFileSync(join(ROOT, 'plugins/dashboard/replycap.ts'), 'utf8')).toBe(readFileSync(join(ROOT, 'plugins/telegram/replycap.ts'), 'utf8'))
    const msg = replyTooLong(words(71), 70)!
    expect(REPLY_TOO_LONG_RE.source).toBe(HOOK_RE.source)
    expect(HOOK_RE.test(`reply failed: ${msg}`)).toBe(true)
  })
})

describe('telegram server: the cap sits in reply and edit_message', () => {
  const src = readFileSync(join(ROOT, 'plugins/telegram/server.ts'), 'utf8')
  test('reply checks after the DIVE-1674 empty-text check and before anything is sent', () => {
    const reply = src.slice(src.indexOf("case 'reply': {"))
    const empty = reply.indexOf("nothing sent. Pass non-empty text")
    const cap = reply.indexOf('const tooLong = replyTooLong(text)')
    const allowed = reply.indexOf('assertAllowedChat(chat_id, args.reply_to')
    expect(empty).toBeGreaterThan(0)
    expect(cap).toBeGreaterThan(empty)
    expect(allowed).toBeGreaterThan(cap)
    expect(reply.slice(cap, allowed)).toContain('if (tooLong) throw new Error(tooLong)')
  })
  test('edit_message checks the new body before the edit goes', () => {
    const edit = src.slice(src.indexOf("case 'edit_message': {"))
    const cap = edit.indexOf('const editTooLong = replyTooLong(body)')
    expect(cap).toBeGreaterThan(0)
    expect(cap).toBeLessThan(edit.indexOf('planAutoAttach(body'))
  })
})

// A turn: a Telegram/dashboard message, then the model's calls and their results.
function turn(source: 'telegram' | 'dashboard', calls: Array<{ id: string; name: string; result: string }>, text?: string): TranscriptEntry[] {
  const tag = source === 'telegram'
    ? '<channel source="plugin:telegram:telegram" chat_id="42" message_id="7" user="o" ts="1">'
    : '<channel source="plugin:dashboard:dashboard" chat_id="dashboard" message_id="7" user="o" ts="1">'
  const out: TranscriptEntry[] = [{ type: 'user', message: { content: `${tag}how did it go?</channel>` } }]
  for (const c of calls) {
    out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: c.id, name: c.name, input: { chat_id: '42', text: '…' } }] } })
    out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, content: [{ type: 'text', text: c.result }] }] } })
  }
  if (text) out.push({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  return out
}

describe('Stop hooks: a reply refused for length is not an answer', () => {
  const TG = 'mcp__plugin_telegram_telegram__'
  const DASH = 'mcp__plugin_dashboard_dashboard__reply'
  const refusal = `reply failed: ${replyTooLong(words(90), 70)}`

  test('telegram: refused only → no send, no tool, the text is relayed; a later good reply is a send', () => {
    const a = analyzeTurn(turn('telegram', [{ id: 't1', name: `${TG}reply`, result: refusal }], 'It went fine.'), TG)
    expect(a.hadSend).toBe(false)
    expect(a.hadTool).toBe(false)
    expect(a.texts).toEqual(['It went fine.'])
    const b = analyzeTurn(turn('telegram', [
      { id: 't1', name: `${TG}reply`, result: refusal },
      { id: 't2', name: `${TG}reply`, result: 'sent (id: 9)' },
    ]), TG)
    expect(b.hadSend).toBe(true)
    // A refused edit_message is no send either.
    expect(analyzeTurn(turn('telegram', [{ id: 'e1', name: `${TG}edit_message`, result: `edit_message failed: ${replyTooLong(words(90), 70)}` }]), TG).hadSend).toBe(false)
    // Any other failure keeps the old meaning: the call counts.
    expect(analyzeTurn(turn('telegram', [{ id: 't3', name: `${TG}reply`, result: 'reply failed: chat 42 is not allowlisted' }]), TG).hadSend).toBe(true)
  })

  test('dashboard: refused only → not answered and no tool used; a later good reply answers', () => {
    const e = turn('dashboard', [{ id: 'd1', name: DASH, result: replyTooLong(words(90), 70)! }])
    expect(refusedTooLongIds(e)).toEqual(new Set(['d1']))
    expect(answeredAfter(e, 0)).toBe(false)
    expect(usedToolAfter(e, 0)).toBe(false)
    const ok = turn('dashboard', [
      { id: 'd1', name: DASH, result: replyTooLong(words(90), 70)! },
      { id: 'd2', name: DASH, result: 'sent (id: 41)' },
    ])
    expect(answeredAfter(ok, 0)).toBe(true)
  })
})

function writeRelay(dir: string): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync } from 'node:fs'
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(${JSON.stringify(dir)} + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') process.stdout.write('200\\n{"pending":[]}')
else if (op[0] === 'event') process.stdout.write('200\\n{"id":41}')
else process.stdout.write('200\\n{"ok":true}')
`)
  return file
}

function events(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((o: string[]) => o[0] === 'event')
}

describe('dashboard server: the MCP reply is capped, the outbox is not', () => {
  test('71 words refused with nothing posted; 70 posted; a 100-word notice-outbox file still posts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-6862-'))
    const envFile = join(dir, 'connectord.env')
    writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
    chmodSync(envFile, 0o000)
    mkdirSync(join(dir, 'outbox'), { recursive: true })
    mkdirSync(join(dir, 'state', 'notice-outbox'), { recursive: true })
    const notice = words(100)
    writeFileSync(join(dir, 'state', 'notice-outbox', 'n1.json'), JSON.stringify({ source: 'dashboard', chat_id: '33', text: notice }))
    const results: Array<{ isError?: boolean; text: string }> = []
    const proc = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        DASHBOARD_STATE_DIR: join(dir, 'state'),
        DASHBOARD_API_BASE: 'http://127.0.0.1:9',
        DASHBOARD_OUTBOX: join(dir, 'outbox'),
        CONNECTORD_ENV_FILE: envFile,
        CONNECTORD_TOKEN: undefined as unknown as string,
        FIVEDIVE_REPLY_MAX_WORDS: undefined as unknown as string,
        DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', writeRelay(dir)]),
        USER: 'agent-theo',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
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
            if (typeof msg.id === 'number' && msg.id >= 7) results[msg.id - 7] = { isError: msg.result?.isError, text: msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error) }
          } catch {}
        }
      }
    })()
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cap-test', version: '0' } } })
      send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: '33', text: words(71) } } })
      expect(await waitFor(() => results[0] !== undefined, 8_000)).toBe(true)
      expect(results[0].isError).toBe(true)
      expect(results[0].text).toStartWith('too long: 71 words; cut to 60')
      expect(events(dir).some(e => e[2] === words(71))).toBe(false)
      send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: '33', text: words(70) } } })
      expect(await waitFor(() => results[1] !== undefined, 8_000)).toBe(true)
      expect(results[1].isError).toBeUndefined()
      expect(events(dir)).toContainEqual(['event', '33', words(70)])
      expect(await waitFor(() => events(dir).some(e => e[2] === notice), BOOT_MS + 8_000)).toBe(true)
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
