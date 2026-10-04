// DIVE-5508: Codex on Telegram, dispatcher seats. Three defects lodar hit on a
// voice note to olivia (bridge 0.5.30):
//  1. no "typing…" at all — the pane path starts it in wait_for_message, which
//     a dispatcher-driven model never calls;
//  2. the answer arrived twice — the model wrote it as `commentary`, then
//     repeated it as `final_answer`, and commentary was published as its own
//     message;
//  3. the speak step's .ogg went out through sendDocument, a file not a voice note.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ChannelDispatcher, NOTE_MAX_CHARS, hasAttachmentDirective, noteStatus, type DispatchMessage, type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'

const tg = (id: string, text = id): DispatchMessage => ({ id, text, route: { source: 'telegram', chat_id: '42' } })
const msg = (turnId: string, id: string, text: string, phase?: string) =>
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
  const messages = () => published.filter(p => p.meta.kind === 'message').map(p => [p.text, p.meta.notify])
  return { dispatcher, published, messages }
}

describe('DIVE-5508: one answer per turn', () => {
  test("olivia's turn replayed: commentary + speak + near-identical final answer → exactly one message", async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1', '(voice message) Can you hear my voice now?'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'The audio file arrived this time. I’ll transcribe it to confirm.', 'commentary'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b',
      'Yes, I can hear you now. Your recording transcribed correctly: “Can you hear my voice now?”', 'commentary'))
    await h.dispatcher.notification('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', command: '5dive-speak "Yes"' } })
    await h.dispatcher.notification('item/completed', msg('turn-1', 'c',
      'Yes, I can hear you now. The recording transcribed correctly.\n[[5dive-attachment:/tmp/5dive-speak.abc.ogg]]', 'final_answer'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })

    expect(h.messages()).toEqual([[
      'Yes, I can hear you now. The recording transcribed correctly.\n[[5dive-attachment:/tmp/5dive-speak.abc.ogg]]', true]])
    // Both commentaries went to the ack, as progress edits.
    expect(h.published.filter(p => p.meta.kind === 'progress').map(p => p.text)).toEqual([
      'starting',
      'The audio file arrived this time. I’ll transcribe it to confirm.',
      'Yes, I can hear you now. Your recording transcribed correctly: “Can you hear my voice now?”',
    ])
  })

  test('a turn that only wrote commentary still answers: its LAST commentary, notifying', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'Checking.', 'commentary'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b', 'All green.', 'commentary'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.messages()).toEqual([['All green.', true]])
    // The answer lands before the ack is closed.
    expect(h.published.map(p => p.meta.kind)).toEqual(['progress', 'progress', 'progress', 'message', 'progress-done'])
  })

  test('a failed commentary-only turn: the commentary goes silently, the error is the notification', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'Half way.', 'commentary'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'quota' } } })
    expect(h.messages()).toEqual([['Half way.', false]])
    expect(h.published.at(-1)).toMatchObject({ text: 'Codex could not complete this turn: quota', meta: { kind: 'error' } })
  })

  test('NEGATIVE: an answered turn does not also replay its commentary', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'Draft.', 'commentary'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b', 'Final.'))  // unknown phase, held
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.messages()).toEqual([['Final.', true]])
  })

  test('a commentary carrying a file still goes as a silent message (the ack cannot hold one)', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(tg('m1'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'Here is the log:\n[[5dive-attachment:/tmp/x.log]]', 'commentary'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b', 'Done.', 'final_answer'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.messages()).toEqual([['Here is the log:\n[[5dive-attachment:/tmp/x.log]]', false], ['Done.', true]])
  })

  test('NEGATIVE: a dashboard turn keeps every message (no ack to fold into)', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit({ id: 'd1', text: 'hi', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await h.dispatcher.notification('item/completed', msg('turn-1', 'a', 'Looking.', 'commentary'))
    await h.dispatcher.notification('item/completed', msg('turn-1', 'b', 'Hello.', 'final_answer'))
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.published.map(p => [p.meta.kind, p.text])).toEqual([['message', 'Looking.'], ['message', 'Hello.']])
  })

  test('noteStatus: one line, clamped; hasAttachmentDirective matches only a directive line', () => {
    expect(noteStatus('  a\n\nb  c ')).toBe('a b c')
    const long = noteStatus('x'.repeat(1000))
    expect(long).toHaveLength(NOTE_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    expect(hasAttachmentDirective('see [[5dive-attachment:/a]] inline')).toBe(false)
    expect(hasAttachmentDirective('see\n[[5dive-attachment:/a/b.ogg]]')).toBe(true)
  })
})

describe('DIVE-5508: adapter wiring (server.ts is an entry point; bun test cannot import it)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'server.ts'), 'utf8')
  const fn = (name: string) => s.slice(s.indexOf(`function ${name}(`), s.indexOf('\n}\n', s.indexOf(`function ${name}(`)))

  test('a dispatcher-seat inbound starts "typing…" (Telegram routes only), before returning', () => {
    const enq = fn('enqueueInbound')
    const branch = enq.slice(enq.indexOf('if (!PANE_IS_THE_MODEL) {'), enq.indexOf('    return\n  }'))
    expect(branch).toContain("if ((msg.dispatch_source ?? 'telegram') === 'telegram') startTypingLoop(msg.chat_id, msg.message_thread_id)")
  })

  test('the outbox stops typing on the answer and on progress-done, and a queued turn restarts it', () => {
    const ingest = fn('ingestDispatcherOutbox')
    expect(ingest).toMatch(/progressAcks\.done\(key, String\(obj\.text\)\)\s*\n\s*stopTypingLoop\(String\(obj\.chat_id\)\)/)
    expect(ingest).toContain('if (obj.notify !== false) stopTypingLoop(String(obj.chat_id))')
    expect(ingest).toMatch(/obj\.text === 'starting' && !typingLoops\.has\(String\(obj\.chat_id\)\)\) \{\s*\n\s*startTypingLoop\(/)
  })

  test('typing follows the forum topic', () => {
    expect(fn('startTypingLoop')).toMatch(/sendChatAction\(chat_id, 'typing', opts\)/)
  })

  test('files: .ogg/.oga/.opus via sendVoice with a document fallback; both send paths use it', () => {
    expect(s).toContain("const VOICE_EXTS = new Set(['.ogg', '.oga', '.opus'])")
    const send = fn('sendFile')
    expect(send).toMatch(/VOICE_EXTS\.has\(ext\)\) \{\s*\n\s*try \{\s*\n\s*return await bot\.api\.sendVoice/)
    expect(send).toContain('return bot.api.sendDocument(chat_id, new InputFile(file), opts)')
    expect(fn('ingestDispatcherOutbox')).toContain('for (const file of files) await sendFile(String(obj.chat_id), file, options)')
    // No send path bypasses it.
    expect(s.match(/bot\.api\.sendDocument\(/g)).toHaveLength(1)
    expect(s.match(/bot\.api\.sendPhoto\(/g)).toHaveLength(1)
  })
})
