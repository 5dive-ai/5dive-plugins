// DIVE-5505: Codex dispatcher seats could not hear voice notes. The bridge wrote
// the dispatcher inbox without the attachment, and the dispatcher's model has no
// MCP tools (`mcp_servers={}`), so it could not call download_attachment either:
// it got a bare "(voice message)" and asked the owner to type. Now the bridge
// downloads the file, transcribes voice/audio with 5dive-transcribe, and the
// turn text carries the transcript or, failing that, the attachment's meta and
// local path.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dispatcherTurnText, execTranscriber, type AttachmentMeta, type MediaPorts,
} from '../plugins/telegram-codex/inbound-media.ts'
import { ChannelDispatcher, type RpcPort } from '../plugins/telegram-codex/dispatcher-core.ts'

const voice: AttachmentMeta = { kind: 'voice', file_id: 'AwACAgQAAxk', size: 9123, mime: 'audio/ogg' }
const doc: AttachmentMeta = { kind: 'document', file_id: 'BQACAgQAAxk', size: 2048, mime: 'application/pdf', name: 'invoice.pdf' }

function stubBin(dir: string, body: string): string {
  const bin = join(dir, '5dive-transcribe')
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

function ports(dir: string, transcribe: MediaPorts['transcribe']): MediaPorts & { fetched: string[] } {
  const fetched: string[] = []
  return {
    fetched,
    async download(fileId) {
      fetched.push(fileId)
      const path = join(dir, `${fileId}.oga`)
      writeFileSync(path, 'OggS')
      return path
    },
    transcribe,
  }
}

/** What the dispatcher actually submits to Codex for a given inbox text. */
async function dispatched(text: string): Promise<string[]> {
  const requests: Array<{ method: string; params: any }> = []
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      throw new Error(`unexpected ${method}`)
    },
  }
  let saved: any = null
  const d = new ChannelDispatcher(rpc, { load: () => saved, save: s => { saved = structuredClone(s) } }, { publish: async () => {} }, '/w')
  await d.initialize()
  await d.submit({ id: 'telegram:42::7', text, route: { source: 'telegram', chat_id: '42' } })
  return requests.find(r => r.method === 'turn/start')!.params.input.map((i: any) => i.text ?? '')
}

describe('voice on the dispatcher path', () => {
  test('the stub transcriber\'s output reaches the dispatched turn text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5505-'))
    try {
      const bin = stubBin(dir, 'echo "  deploy the blog   and ping me "')
      const p = ports(dir, execTranscriber(bin, 5000))
      const turn = await dispatcherTurnText('(voice message)', voice, p)
      expect(p.fetched).toEqual([voice.file_id])
      expect(turn.transcript).toBe('deploy the blog and ping me')
      expect(turn.text.split('\n')[0]).toBe('(voice message) deploy the blog and ping me')
      expect(turn.text).toContain(`attachment_path=${join(dir, `${voice.file_id}.oga`)}`)
      const input = await dispatched(turn.text)
      expect(input.at(-1)).toContain('(voice message) deploy the blog and ping me')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a captioned voice note keeps the caption and labels the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5505-'))
    try {
      const turn = await dispatcherTurnText('see this', voice, ports(dir, async () => 'hello there'))
      expect(turn.text.split('\n').slice(0, 2)).toEqual(['see this', '(voice message) hello there'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the transcriber failing: the turn carries attachment_file_id, the path and why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5505-'))
    try {
      const bin = stubBin(dir, 'echo "whisper-service unreachable" >&2; exit 3')
      const turn = await dispatcherTurnText('(voice message)', voice, ports(dir, execTranscriber(bin, 5000)))
      expect(turn.transcript).toBeUndefined()
      expect(turn.text).toContain(`attachment_file_id=${voice.file_id}`)
      expect(turn.text).toContain('attachment_kind=voice attachment_file_id=AwACAgQAAxk attachment_size=9123 attachment_mime=audio/ogg attachment_path=')
      expect(turn.text).toContain('(transcription failed: whisper-service unreachable)')
      expect((await dispatched(turn.text)).at(-1)).toContain(`attachment_file_id=${voice.file_id}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the transcriber absent from the box falls back the same way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5505-'))
    try {
      const turn = await dispatcherTurnText('(voice message)', voice, ports(dir, execTranscriber(join(dir, 'nope'), 5000)))
      expect(turn.text).toContain(`attachment_file_id=${voice.file_id}`)
      expect(turn.text).toContain('transcription failed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an empty transcript is a failure, not a silent "(voice message) "', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5505-'))
    try {
      const turn = await dispatcherTurnText('(voice message)', voice, ports(dir, async () => '  \n'))
      expect(turn.transcript).toBeUndefined()
      expect(turn.text).toContain('(transcription was empty)')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a failed download still gives the meta, so the file is named', async () => {
    let transcribed = false
    const turn = await dispatcherTurnText('(voice message)', voice, {
      download: async () => { throw new Error('file is too big') },
      transcribe: async () => { transcribed = true; return 'x' },
    })
    expect(transcribed).toBe(false)
    expect(turn.text).toContain(`attachment_file_id=${voice.file_id}`)
    expect(turn.text).not.toContain('attachment_path=')
    expect(turn.text).toContain('(download failed: file is too big)')
  })
})

// DIVE-5779: the bridge killed 5dive-transcribe at a fixed 120s, so a voice
// note over ~5 min failed on a dispatcher seat however long the binary itself
// would wait (DIVE-5750: 120s plus the note's length). The kill is now a base
// plus the note's length. Scaled down: base 150ms, a stub that takes 400ms.
describe('the transcriber timeout scales with the note (DIVE-5779)', () => {
  const slow = 'sleep 0.4; echo "a long note, heard in full"'

  test('a transcriber slower than the base still reaches the dispatched turn text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5779-'))
    try {
      const long: AttachmentMeta = { ...voice, duration: 2 }
      const turn = await dispatcherTurnText('(voice message)', long, ports(dir, execTranscriber(stubBin(dir, slow), 150)))
      expect(turn.transcript).toBe('a long note, heard in full')
      expect((await dispatched(turn.text)).at(-1)).toContain('(voice message) a long note, heard in full')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('without the note\'s length the same stub is killed at the base, so the length is what saved it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5779-'))
    try {
      const turn = await dispatcherTurnText('(voice message)', voice, ports(dir, execTranscriber(stubBin(dir, slow), 150)))
      expect(turn.transcript).toBeUndefined()
      expect(turn.text).toContain('transcription failed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the port is handed the duration Telegram reported', async () => {
    let got: number | undefined
    const dir = mkdtempSync(join(tmpdir(), 'dive5779-'))
    try {
      await dispatcherTurnText('(voice message)', { ...voice, duration: 361 }, ports(dir, async (_p, d) => { got = d; return 'ok' }))
      expect(got).toBe(361)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('other attachments on the dispatcher path', () => {
  test('a document carries its file_id, name and local path, and is not transcribed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive5505-'))
    try {
      let transcribed = false
      const p = ports(dir, async () => { transcribed = true; return 'x' })
      const turn = await dispatcherTurnText('(document: invoice.pdf)', doc, p)
      expect(transcribed).toBe(false)
      expect(turn.text).toBe(`(document: invoice.pdf)\n[attachment_kind=document attachment_file_id=${doc.file_id} `
        + `attachment_size=2048 attachment_mime=application/pdf attachment_name=invoice.pdf attachment_path=${join(dir, `${doc.file_id}.oga`)}]`)
      expect((await dispatched(turn.text)).at(-1)).toContain(`attachment_file_id=${doc.file_id}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('no attachment: the text is untouched and nothing is fetched', async () => {
    let fetched = false
    const turn = await dispatcherTurnText('hi', undefined, { download: async () => { fetched = true; return '' }, transcribe: async () => '' })
    expect(turn).toEqual({ text: 'hi' })
    expect(fetched).toBe(false)
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'server.ts'), 'utf8')
  const ingest = src.slice(src.indexOf('async function ingest('), src.indexOf('// --- /inbox'))

  test('ingest builds the dispatcher text from the attachment, and only off the pane path', () => {
    expect(ingest).toContain('attachment && !PANE_IS_THE_MODEL')
    expect(ingest).toContain('dispatcherTurnText(text, attachment, { download: downloadToInbox, transcribe: transcribeFile })')
    expect(ingest).toMatch(/enqueueInbound\(\{[\s\S]*text: turn\.text,/)
  })

  test('the transcriber defaults to the box binary', () => {
    expect(src).toContain("process.env.TELEGRAM_CODEX_TRANSCRIBE_BIN ?? '/usr/local/bin/5dive-transcribe'")
  })

  test('the base timeout clears the binary\'s own worst case, and voice and audio carry their duration (DIVE-5779)', () => {
    expect(src).toContain('Number(process.env.TELEGRAM_CODEX_TRANSCRIBE_TIMEOUT_MS ?? 600_000)')
    expect(src).toContain("kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type, duration: v.duration,")
    expect(src).toContain("kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name, duration: a.duration,")
  })

  test('the new module ships in the package', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'package.json'), 'utf8'))
    expect(pkg.files).toContain('inbound-media.ts')
  })
})

// DIVE-5505 item 4: /status said "last activity: (none this session)" on a
// dispatcher seat mid-answer, because only the MCP tool handlers (pane path)
// wrote the stamps. The dispatcher path writes its OWN pair: the Stop hook reads
// last-inbound/last-reply, and a dispatcher turn can end before its answer has
// left the outbox, which would read as "unanswered" and ping every turn.
describe('dispatcher-path activity stamps', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'server.ts'), 'utf8')
  const fn = (name: string) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)))

  test('the dispatcher enqueue stamps dispatch-inbound once the inbox file is in place', () => {
    const branch = fn('enqueueInbound').split('if (!PANE_IS_THE_MODEL) {')[1].split('\n    return\n')[0]
    expect(branch).toMatch(/renameSync\(tmp, dest\)\n\s*try \{ writeFileSync\(DISPATCH_INBOUND_FILE, String\(Date\.now\(\)\)\) \} catch \{\}/)
  })

  test('the outbox stamps dispatch-reply after a sent answer, not after silent commentary', () => {
    const body = fn('ingestDispatcherOutbox')
    const sent = body.indexOf('await bot.api.sendMessage(')
    const stamp = body.indexOf("if (obj.notify !== false) try { writeFileSync(DISPATCH_REPLY_FILE, String(Date.now())) } catch {}")
    expect(sent).toBeGreaterThan(0)
    expect(stamp).toBeGreaterThan(sent)
  })

  test('/status reads both pairs; the Stop hook still reads only the pane pair', () => {
    expect(fn('activityStamps')).toContain('Math.max(readStamp(LAST_INBOUND_FILE), readStamp(DISPATCH_INBOUND_FILE))')
    expect(fn('activityStamps')).toContain('Math.max(readStamp(LAST_REPLY_FILE), readStamp(DISPATCH_REPLY_FILE))')
    expect(fn('lastActivityMs')).toContain('activityStamps()')
    expect(fn('bridgeStatus')).toContain('activityStamps()')
    const hook = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'hooks', 'notify-stop.ts'), 'utf8')
    expect(hook).not.toContain('dispatch-')
  })
})
