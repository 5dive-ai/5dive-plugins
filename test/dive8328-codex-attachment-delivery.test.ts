// DIVE-8328 (box report 930): a Codex agent on the Telegram dispatcher path
// named two PNGs; the owner got the text twice and no images, and nobody was
// told. A file that failed re-ingested the whole outbox file, so every retry
// re-sent the TEXT; an explicit directive skipped the 50 MB cap; a picture
// sendPhoto refused never went as a document; an over-cap answer's rewrite
// could drop its files; and the model never learned any of it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachReceiptLine, deliverOutboxReply, plainSendReason, recordAttachReceipt, sendOneFile, takeAttachReceipts,
} from '../plugins/telegram-codex/outbox-send.ts'
import { TurnAttachMemo, planOutboxAttachments } from '../plugins/telegram-codex/outbox-attach.ts'
import { ChannelDispatcher, parseOutboundMessage, type DispatchSink, type RpcPort } from '../plugins/telegram-codex/dispatcher-core.ts'

const ROOT = join(import.meta.dir, '..', 'plugins', 'telegram-codex')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dive8328-')); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d }

const PHOTO_REFUSED = Object.assign(new Error('Call to \'sendPhoto\' failed! (400: Bad Request: PHOTO_INVALID_DIMENSIONS)'),
  { description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' })
const DOC_REFUSED = Object.assign(new Error('Call to \'sendDocument\' failed! (413: Request Entity Too Large)'),
  { description: 'Request Entity Too Large' })

/** The bridge's send path with Telegram faked: what reached the chat, in order. */
function bridge(outbox: string, refuse: { photo?: boolean; doc?: boolean; text?: boolean } = {}) {
  const chat: string[] = []
  const ports = {
    sendText: async (t: string) => { if (refuse.text) throw new Error('network down'); chat.push(`text:${t}`) },
    textSent: () => { rmSync(outbox, { force: true }) },
    sendFile: (f: string) => sendOneFile(f, {
      sendPhoto: async (p: string) => { if (refuse.photo) throw PHOTO_REFUSED; chat.push(`photo:${p}`) },
      sendVoice: async (p: string) => { chat.push(`voice:${p}`) },
      sendDocument: async (p: string) => { if (refuse.doc) throw DOC_REFUSED; chat.push(`document:${p}`) },
    }),
  }
  return { chat, ports }
}

describe('(a) a picture sendPhoto refuses goes as a document; the text goes once', () => {
  test('text once, then the PNG as a document, and the outbox file is gone', async () => {
    const d = tmp()
    const outbox = join(d, '1.json'); writeFileSync(outbox, '{}')
    const b = bridge(outbox, { photo: true })
    const r = await deliverOutboxReply('Here is the chart.', ['/w/tall.png'], b.ports)
    expect(b.chat).toEqual(['text:Here is the chart.', 'document:/w/tall.png'])
    expect(r).toEqual({ sent: ['tall.png'], failed: [] })
    expect(existsSync(outbox)).toBe(false)
  })
  test('a photo Telegram takes stays a photo', async () => {
    const b = bridge(join(tmp(), 'x.json'))
    await deliverOutboxReply('ok', ['/w/a.png', '/w/r.pdf'], b.ports)
    expect(b.chat).toEqual(['text:ok', 'photo:/w/a.png', 'document:/w/r.pdf'])
  })
})

describe('(b) a file that fails both ways: one "couldn\'t send" line, no second text, no re-ingest', () => {
  test('the text once, the next file still goes, one plain line for the failed one, nothing thrown', async () => {
    const d = tmp()
    const outbox = join(d, '1.json'); writeFileSync(outbox, '{}')
    const b = bridge(outbox, { photo: true, doc: true })
    const r = await deliverOutboxReply('Two screenshots.', ['/w/a.png', '/w/b.png'], b.ports)
    expect(b.chat).toEqual(['text:Two screenshots.', "text:couldn't send a.png: too large for Telegram\ncouldn't send b.png: too large for Telegram"])
    expect(b.chat.filter(m => m === 'text:Two screenshots.')).toHaveLength(1)
    expect(r.failed.map(f => f.name)).toEqual(['a.png', 'b.png'])
    // Resolved, not thrown: the bridge's catch (the only retry) never runs, and
    // the outbox file it would re-read is already gone.
    expect(existsSync(outbox)).toBe(false)
  })
  test('one good file and one bad: the good one is sent and named', async () => {
    let n = 0
    const chat: string[] = []
    const r = await deliverOutboxReply('t', ['/w/ok.pdf', '/w/bad.mp4'], {
      sendText: async t => { chat.push(t) },
      sendFile: async f => { if (n++) throw DOC_REFUSED; chat.push(f) },
    })
    expect(chat).toEqual(['t', '/w/ok.pdf', "couldn't send bad.mp4: too large for Telegram"])
    expect(r.sent).toEqual(['ok.pdf'])
  })
  test('only a failed TEXT throws, and then the outbox file is still there to retry', async () => {
    const d = tmp()
    const outbox = join(d, '1.json'); writeFileSync(outbox, '{}')
    const b = bridge(outbox, { text: true })
    await expect(deliverOutboxReply('t', ['/w/a.png'], b.ports)).rejects.toThrow('network down')
    expect(existsSync(outbox)).toBe(true)
    expect(b.chat).toEqual([])
  })
  test('server.ts: the retry runs only while the outbox file exists, and the file goes once the text is out', () => {
    const s = readFileSync(join(ROOT, 'server.ts'), 'utf8')
    const ingest = s.slice(s.indexOf('function ingestDispatcherOutbox('), s.indexOf('\n}\n', s.indexOf('function ingestDispatcherOutbox(')))
    expect(ingest).toContain('const result = await deliverOutboxReply(text, files, {')
    expect(ingest).toMatch(/textSent: \(\) => \{\s*\n\s*try \{ unlinkSync\(full\) \} catch \{\}/)
    expect(ingest).toContain('if (existsSync(full)) setTimeout(() => ingestDispatcherOutbox(name), 1_000).unref?.()')
    expect(ingest).not.toContain('for (const file of files) await sendFile(')
  })
  test('plain reasons, never a raw API error', () => {
    expect(plainSendReason(PHOTO_REFUSED)).toBe('Telegram could not read the file')
    expect(plainSendReason(DOC_REFUSED)).toBe('too large for Telegram')
    expect(plainSendReason(new Error("ENOENT: no such file or directory, open '/w/x'"))).toBe('the file is gone')
    expect(plainSendReason(new Error('x'.repeat(200))).length).toBeLessThanOrEqual(78)
  })
})

describe('(c) an explicit directive obeys the 50 MB cap', () => {
  test('a 60 MB file is not sent; the footer says "too large to send"; the model is told why', () => {
    const d = tmp()
    const big = join(d, 'big.mp4'); writeFileSync(big, ''); truncateSync(big, 60 * 1024 * 1024)
    const small = join(d, 'small.png'); writeFileSync(small, 'x')
    const p = planOutboxAttachments('Here you go.', [big, small], '42:t1', new TurnAttachMemo(), { home: join(d, 'home') })
    expect(p.send).toEqual([small])
    expect(p.footer).toBe('too large to send: big.mp4')
    expect(p.skipped).toEqual([{ name: 'big.mp4', reason: "60 MB, over Telegram's 50 MB" }])
  })
  test('exactly 50 MB still goes (the cap is "over")', () => {
    const d = tmp()
    const f = join(d, 'edge.mp4'); writeFileSync(f, ''); truncateSync(f, 50 * 1024 * 1024)
    expect(planOutboxAttachments('x', [f], '42:t1', new TurnAttachMemo(), { home: join(d, 'home') }).send).toEqual([f])
  })
})

// The dispatcher with a fake app-server, as in dive7811's harness.
function codex(sinkExtra: Partial<DispatchSink> = {}) {
  const requests: Array<{ method: string; params: any }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  let saved: any = null
  let next = 1
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: `turn-${next++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  const d = new ChannelDispatcher(rpc, { load: () => saved, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) }, ...sinkExtra }, '/workspace')
  const answer = async (turn: string, text: string) => {
    await d.notification('item/completed', { turnId: turn, item: { id: `${turn}-i`, type: 'agentMessage', text, phase: 'final_answer' } })
    await d.notification('turn/completed', { turn: { id: turn, status: 'completed' } })
  }
  const inputs = () => requests.filter(r => r.method === 'turn/start').map(r => r.params.input.map((i: any) => i.text as string))
  const messages = () => published.filter(p => p.meta.kind === 'message')
  return { d, answer, inputs, messages }
}

const LONG = Array.from({ length: 95 }, () => 'long').join(' ')
const DIRECTIVE = '[[5dive-attachment:/w/shot.png]]'

describe('(d) an over-cap answer that carried a file: the rewrite sends the file', () => {
  test('the rewrite drops the directive: the published rewrite carries it back; the cut prompt says so', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'screenshot?', route: { source: 'telegram', chat_id: '42' } })
    await h.answer('turn-1', `${LONG}\n${DIRECTIVE}`)
    expect(h.messages()).toEqual([])
    const cutTurn = h.inputs()[1].at(-1)!
    expect(cutTurn).toContain('your last reply was not sent')
    expect(cutTurn).toContain('shot.png will be sent with the new version')
    await h.answer('turn-2', 'Here it is.')
    expect(h.messages()).toHaveLength(1)
    expect(parseOutboundMessage(h.messages()[0].text)).toEqual({ text: 'Here it is.', files: ['/w/shot.png'] })
  })
  test('a rewrite that keeps the directive is not doubled', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'q', route: { source: 'telegram', chat_id: '42' } })
    await h.answer('turn-1', `${LONG}\n${DIRECTIVE}`)
    await h.answer('turn-2', `Short.\n${DIRECTIVE}`)
    expect(parseOutboundMessage(h.messages()[0].text).files).toEqual(['/w/shot.png'])
  })
  test('two rewrites that both drop it: the as-written last version still carries the file', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'q', route: { source: 'telegram', chat_id: '42' } })
    await h.answer('turn-1', `${LONG}\n${DIRECTIVE}`)
    await h.answer('turn-2', LONG)
    await h.answer('turn-3', `${LONG} still`)
    expect(h.messages()).toHaveLength(1)
    expect(parseOutboundMessage(h.messages()[0].text).files).toEqual(['/w/shot.png'])
  })
  test('an over-cap answer with no file: the cut prompt is unchanged', async () => {
    const h = codex()
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'q', route: { source: 'telegram', chat_id: '42' } })
    await h.answer('turn-1', LONG)
    expect(h.inputs()[1].at(-1)).not.toContain('will be sent with the new version')
  })
})

describe('(e) the outcome reaches the model in its next turn', () => {
  test('the bridge records it; the next turn on that chat carries the line, once', async () => {
    const dir = join(tmp(), 'attach-receipts')
    const line = attachReceiptLine(['a.png'], [{ name: 'c.mp4', reason: "479 MB, over Telegram's 50 MB" }])
    expect(line).toBe("[5dive attachments] sent a.png · not sent: c.mp4 (479 MB, over Telegram's 50 MB)")
    const h = codex({ receipts: route => route.source === 'telegram' ? takeAttachReceipts(dir, route.chat_id) : '' })
    await h.d.initialize()
    await h.d.submit({ id: 'm1', text: 'send the video', route: { source: 'telegram', chat_id: '42' } })
    await h.answer('turn-1', `Sent.\n[[5dive-attachment:/w/c.mp4]]`)
    recordAttachReceipt(dir, '42', line)
    recordAttachReceipt(dir, '7', attachReceiptLine(['other.pdf'], []))
    await h.d.submit({ id: 'm2', text: 'did it arrive?', route: { source: 'telegram', chat_id: '42' } })
    expect(h.inputs()[1]).toEqual([line, 'did it arrive?'])
    await h.answer('turn-2', 'No, it was too large.')
    await h.d.submit({ id: 'm3', text: 'ok', route: { source: 'telegram', chat_id: '42' } })
    expect(h.inputs()[2]).toEqual(['ok'])
    // Another chat's receipt waits for that chat.
    expect(takeAttachReceipts(dir, '7')).toBe('[5dive attachments] sent other.pdf')
  })
  test('nothing named, nothing said; receipts never leave their chat\'s file', () => {
    expect(attachReceiptLine([], [])).toBe('')
    const dir = join(tmp(), 'r')
    recordAttachReceipt(dir, '42', '')
    expect(takeAttachReceipts(dir, '42')).toBe('')
  })
  test('the bridge records into the dir the dispatcher reads, with the plan\'s skipped files too', () => {
    const s = readFileSync(join(ROOT, 'server.ts'), 'utf8')
    const disp = readFileSync(join(ROOT, 'dispatcher.ts'), 'utf8')
    expect(s).toContain("const DISPATCHER_RECEIPTS_DIR = join(DISPATCHER_STATE_DIR, 'attach-receipts')")
    expect(disp).toContain("const RECEIPTS_DIR = join(STATE_DIR, 'attach-receipts')")
    expect(s).toContain('attachReceiptLine(result.sent, [...plan!.skipped, ...result.failed]))')
    expect(disp).toContain('receipts: attachReceipts }')
  })
  test('outbox-send.ts ships in the package', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files).toContain('outbox-send.ts')
  })
})
