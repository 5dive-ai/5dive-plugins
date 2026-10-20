// DIVE-6579: a Codex dispatcher seat answers a voice note by voice. lodar,
// 2026-10-20: "exact-swallow codex-elm cannot send voice back - i see only text
// response". Codex never sees a reply tool, so the adapters voice the answer:
// a voice note's route carries `voice: true`, the dispatcher echoes the route
// on every outbox file, and `notify` marks which message is the answer.
// The dashboard half runs end to end in codex-dashboard-adapter.test.ts.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelDispatcher, type DispatchMessage, type RpcPort } from '../plugins/telegram-codex/dispatcher-core.ts'
import { speakToFile, voicesReply } from '../plugins/telegram-codex/voice-reply.ts'
import { isVoiceInbound, voicesReply as dashboardVoicesReply } from '../plugins/dashboard/voicenote.ts'

const item = (turnId: string, id: string, text: string, phase?: string) =>
  ({ turnId, item: { id, type: 'agentMessage', text, ...(phase ? { phase } : {}) } })

function harness() {
  const published: Array<{ route: any; text: string; meta: any }> = []
  let turn = 1
  const rpc: RpcPort = {
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: `turn-${turn++}` } }
      throw new Error(`unexpected ${method}`)
    },
  }
  let saved: any = null
  const dispatcher = new ChannelDispatcher(rpc, { load: () => saved, save: s => { saved = structuredClone(s) } },
    { publish: async (route, text, meta) => { published.push({ route, text, meta }) } }, '/w')
  return { dispatcher, published }
}

describe('DIVE-6579: the dispatcher echoes the voice route and marks the answer', () => {
  test('a dashboard voice turn: every message keeps voice: true; commentary is notify false, the answer notify true', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    const voice: DispatchMessage = { id: 'd1', text: '[voice note] hi', route: { source: 'dashboard', chat_id: 'dashboard', voice: true } }
    await h.dispatcher.submit(voice)
    await h.dispatcher.notification('item/completed', item('turn-1', 'a', 'Looking.', 'commentary'))
    await h.dispatcher.notification('item/completed', item('turn-1', 'b', 'Hello.', 'final_answer'))
    await h.dispatcher.notification('item/completed', item('turn-1', 'c', 'Older model, no phase.'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    const messages = h.published.filter(p => p.meta.kind === 'message')
    expect(messages.map(p => [p.text, p.meta.notify])).toEqual([
      ['Looking.', false], ['Hello.', true], ['Older model, no phase.', undefined]])
    expect(messages.every(p => p.route.voice === true)).toBe(true)
    // Which ones the adapter voices, given the outbox file is { ...route, text, ...meta }.
    expect(messages.map(p => dashboardVoicesReply({ ...p.route, text: p.text, ...p.meta }))).toEqual([false, true, true])
  })

  test('a Telegram voice turn: the answer is voiced, its commentary (progress) is not', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit({ id: 't1', text: '(voice message) hi', route: { source: 'telegram', chat_id: '42', voice: true } })
    await h.dispatcher.notification('item/completed', item('turn-1', 'a', 'Checking.', 'commentary'))
    await h.dispatcher.notification('item/completed', item('turn-1', 'b', 'Hi there.', 'final_answer'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    const voiced = h.published.filter(p => voicesReply({ ...p.route, ...p.meta }, []))
    expect(voiced.map(p => p.text)).toEqual(['Hi there.'])
  })

  test('NEGATIVE: a typed message on the same chat is one route (voice is not part of the key) and is never voiced', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit({ id: 't1', text: 'hi', route: { source: 'telegram', chat_id: '42' } })
    await h.dispatcher.notification('item/completed', item('turn-1', 'b', 'Hi there.', 'final_answer'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.published.filter(p => voicesReply({ ...p.route, ...p.meta }, []))).toEqual([])
  })
})

describe('DIVE-6579: which replies are voiced', () => {
  for (const [name, fn] of [['telegram-codex', (o: any) => voicesReply(o, o.files ?? [])], ['dashboard', dashboardVoicesReply]] as const) {
    test(`${name}: the answer to a voice note only, and never twice`, () => {
      expect(fn({ voice: true, kind: 'message', notify: true })).toBe(true)
      expect(fn({ voice: true })).toBe(true)                                   // a harness that sets voice and nothing else
      expect(fn({ voice: true, kind: 'message' })).toBe(true)                  // an older dispatcher: no notify
      expect(fn({ kind: 'message', notify: true })).toBe(false)                // typed
      expect(fn({ voice: 'yes', kind: 'message' })).toBe(false)
      expect(fn({ voice: true, kind: 'message', notify: false })).toBe(false)  // commentary
      expect(fn({ voice: true, kind: 'error' })).toBe(false)
      expect(fn({ voice: true, kind: 'control' })).toBe(false)
      expect(fn({ voice: true, kind: 'message', files: ['/tmp/5dive-speak.a.ogg'] })).toBe(false) // the model spoke it already
      expect(fn({ voice: true, kind: 'message', files: ['/tmp/report.pdf'] })).toBe(true)
    })
  }

  test('dashboard: a voice note is one heard on the box or one still to hear', () => {
    expect(isVoiceInbound('[voice note] book the flight', {})).toBe(true)
    expect(isVoiceInbound('[voice note]', { attachment_kind: 'voice', audio_path: '/x/n.webm' })).toBe(true)
    expect(isVoiceInbound('book the flight', {})).toBe(false)
    expect(isVoiceInbound('see [voice note] below', { image_path: '/x/a.png' })).toBe(false)
  })
})

describe('DIVE-6579: speakToFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dive6579-'))
  const script = (name: string, body: string) => {
    const f = join(dir, name)
    writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(f, 0o755)
    return f
  }

  test('returns the OGG 5dive-speak printed, after passing the text as one argument', async () => {
    const out = join(dir, 'a.ogg')
    const bin = script('ok', `printf '%s' "$2" > ${JSON.stringify(join(dir, 'arg'))}\nprintf OggS > ${JSON.stringify(out)}\necho loading >&2\necho ${JSON.stringify(out)}`)
    expect(await speakToFile('-n It is nine.', bin)).toBe(out)
    expect(readFileSync(join(dir, 'arg'), 'utf8')).toBe('-n It is nine.')
  })

  test('voice replies switched off (exit 3) is null, not an error', async () => {
    expect(await speakToFile('hi', script('off', 'echo off >&2; exit 3'))).toBeNull()
  })

  test('a failure throws its last stderr line; a path that is not there throws', async () => {
    await expect(speakToFile('hi', script('bad', 'echo "engine down" >&2; exit 1'))).rejects.toThrow('engine down')
    await expect(speakToFile('hi', script('nofile', `echo ${JSON.stringify(join(dir, 'missing.ogg'))}`))).rejects.toThrow('made no file')
  })
})

describe('DIVE-6579: telegram-codex wiring (server.ts is an entry point; bun test cannot import it)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'server.ts'), 'utf8')
  const fn = (name: string) => s.slice(s.indexOf(`function ${name}(`), s.indexOf('\n}\n', s.indexOf(`function ${name}(`)))

  test('a Telegram voice note marks its dispatcher route', () => {
    expect(fn('enqueueInbound')).toContain("...(msg.attachment?.kind === 'voice' ? { voice: true } : {}),")
  })

  test('the outbox voices the answer after the text and its files went, and the file is gone', () => {
    const ingest = fn('ingestDispatcherOutbox')
    const sent = ingest.indexOf('for (const file of files) await sendFile(String(obj.chat_id), file, options)')
    const unlinked = ingest.indexOf('try { unlinkSync(full) } catch {}', sent)
    const voiced = ingest.indexOf('if (voicesReply(obj, files)) await sendSpokenReply(String(obj.chat_id), body, options, name)')
    expect(sent).toBeGreaterThan(0)
    expect(unlinked).toBeGreaterThan(sent)
    expect(voiced).toBeGreaterThan(unlinked)
    // A failed voice note is logged, never thrown into the outbox retry.
    expect(fn('sendSpokenReply')).toContain('voice note not sent')
  })

  test('voice-reply.ts ships in the package', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'package.json'), 'utf8'))
    expect(pkg.files).toContain('voice-reply.ts')
  })
})
