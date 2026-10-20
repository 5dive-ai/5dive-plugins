import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  expect(predicate()).toBe(true)
}

describe('Codex dashboard adapter end to end', () => {
  test('spools pending and durable drops, ACKs, preserves routing, and sends attachments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-dashboard-adapter-'))
    const dashboardState = join(root, '.claude', 'channels', 'dashboard')
    const dispatcherState = join(root, '.codex', 'channels', 'dispatcher')
    const sharedOutbox = join(root, 'downloads')
    mkdirSync(sharedOutbox, { recursive: true })
    const attachment = join(root, 'report.txt')
    writeFileSync(attachment, 'dashboard attachment\n')

    let pending = [{
      id: 71, text: 'queued while offline', from: 'owner', chat_id: 'dashboard',
      image_path: '/tmp/inbound.png',
    }]
    const acknowledgements: number[][] = []
    const outbound: any[] = []
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') return Response.json({ pending })
        if (url.pathname === '/server/messages/pending/ack') {
          const body = await req.json() as { ids: number[] }
          acknowledgements.push(body.ids)
          pending = pending.filter(message => !body.ids.includes(message.id))
          return Response.json({ ok: true, acked: body.ids.length })
        }
        if (url.pathname === '/server/messages/event') {
          outbound.push(await req.json())
          return Response.json({ id: 99 })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const child = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        CODEX_DISPATCHER_ADAPTER: 'dashboard',
        CODEX_DISPATCHER_STATE_DIR: dispatcherState,
        DASHBOARD_STATE_DIR: dashboardState,
        DASHBOARD_OUTBOX: sharedOutbox,
        DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
        CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
        USER: 'agent-codexdash',
      },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    const dispatcherInbox = join(dispatcherState, 'inbox')
    await waitFor(() => existsSync(dispatcherInbox) && readdirSync(dispatcherInbox).length === 1)
    expect(acknowledgements).toEqual([[71]])
    const first = JSON.parse(readFileSync(join(dispatcherInbox, readdirSync(dispatcherInbox)[0]!), 'utf8'))
    expect(first).toMatchObject({
      id: 'dashboard:pending:71', text: 'queued while offline', image_path: '/tmp/inbound.png',
      route: { source: 'dashboard', chat_id: 'dashboard' },
    })

    const agentInbox = join(dashboardState, 'agent-inbox')
    const tmp = join(agentInbox, '.drop.tmp')
    writeFileSync(tmp, JSON.stringify({ text: 'live dashboard drop', chat_id: 'dashboard' }))
    renameSync(tmp, join(agentInbox, 'drop.json'))
    await waitFor(() => readdirSync(dispatcherInbox).length === 2)
    const inboxBodies = readdirSync(dispatcherInbox)
      .map(name => JSON.parse(readFileSync(join(dispatcherInbox, name), 'utf8')))
    expect(inboxBodies.some(message => message.id === 'dashboard:drop:drop.json'
      && message.route?.source === 'dashboard')).toBe(true)

    const dispatcherOutbox = join(dispatcherState, 'outbox', 'dashboard')
    const outTmp = join(dispatcherOutbox, '.reply.tmp')
    writeFileSync(outTmp, JSON.stringify({
      source: 'dashboard', chat_id: 'dashboard', text: 'Here is the report.', files: [attachment],
    }))
    renameSync(outTmp, join(dispatcherOutbox, 'reply.json'))
    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({
      agent: 'codexdash', body: 'Here is the report.', metadata: { chat_id: 'dashboard' },
    })
    const delivered = outbound[0].metadata.files[0]
    expect(delivered).toStartWith(`${sharedOutbox}/codexdash-`)
    expect(readFileSync(delivered, 'utf8')).toBe('dashboard attachment\n')
  }, 10_000)

  // DIVE-6579: codex never sees the reply tool, so a web voice note was answered
  // in text only. The voice note's route says voice: true, the dispatcher
  // echoes the route on its outbox file ({ ...route, text, ...meta }, as
  // dispatcher.ts publish() writes it), and the adapter voices the answer.
  test('a reply to a voice note is spoken once and posts a voice file; a typed one and commentary are not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-dashboard-voice-'))
    const dashboardState = join(root, '.claude', 'channels', 'dashboard')
    const dispatcherState = join(root, '.codex', 'channels', 'dispatcher')
    const sharedOutbox = join(root, 'downloads')
    mkdirSync(sharedOutbox, { recursive: true })
    const speakLog = join(root, 'speak.log')
    const speak = join(root, '5dive-speak')
    writeFileSync(speak, `#!/usr/bin/env bash\nprintf '%s\\n' "$2" >> ${JSON.stringify(speakLog)}\n`
      + `out=${JSON.stringify(root)}/speak-$RANDOM.ogg\nprintf 'OggS' > "$out"\necho "$out"\n`)
    chmodSync(speak, 0o755)

    const outbound: any[] = []
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') return Response.json({ pending: [] })
        if (url.pathname === '/server/messages/event') {
          outbound.push(await req.json())
          return Response.json({ id: 100 + outbound.length })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const child = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        CODEX_DISPATCHER_ADAPTER: 'dashboard',
        CODEX_DISPATCHER_STATE_DIR: dispatcherState,
        DASHBOARD_STATE_DIR: dashboardState,
        DASHBOARD_OUTBOX: sharedOutbox,
        DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
        DASHBOARD_SPEAK: speak,
        DASHBOARD_FFMPEG: '/bin/false',
        DASHBOARD_FFPROBE: '/bin/false',
        CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
        USER: 'agent-codexdash',
      },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    const agentInbox = join(dashboardState, 'agent-inbox')
    const dispatcherInbox = join(dispatcherState, 'inbox')
    const dispatcherOutbox = join(dispatcherState, 'outbox', 'dashboard')
    const seen = new Set<string>()
    const inbound = async (name: string, body: object) => {
      await waitFor(() => existsSync(agentInbox))
      writeFileSync(join(agentInbox, `.${name}.tmp`), JSON.stringify(body))
      renameSync(join(agentInbox, `.${name}.tmp`), join(agentInbox, `${name}.json`))
      let file = ''
      await waitFor(() => existsSync(dispatcherInbox)
        && !!(file = readdirSync(dispatcherInbox).find(f => f.endsWith('.json') && !seen.has(f)) ?? ''))
      seen.add(file)
      return JSON.parse(readFileSync(join(dispatcherInbox, file), 'utf8'))
    }
    const answer = (name: string, route: object, text: string, meta: object) => {
      writeFileSync(join(dispatcherOutbox, `.${name}.tmp`), JSON.stringify({ ...route, text, turnId: 't', itemId: name, ...meta }))
      renameSync(join(dispatcherOutbox, `.${name}.tmp`), join(dispatcherOutbox, `${name}.json`))
    }
    const spoken = () => existsSync(speakLog) ? readFileSync(speakLog, 'utf8').trim().split('\n') : []

    // A voice note heard on the box, and one that was not (attachment_kind="voice").
    const heard = await inbound('heard', { text: '[voice note] what time is it', chat_id: 'dashboard' })
    expect(heard.route).toEqual({ source: 'dashboard', chat_id: 'dashboard', voice: true })
    const unheard = await inbound('unheard', { text: '[voice note]', chat_id: 'web', image_path: '/home/claude/chat-uploads/x/n.webm' })
    expect(unheard.route).toEqual({ source: 'dashboard', chat_id: 'web', voice: true })
    const typed = await inbound('typed', { text: 'what time is it', chat_id: 'dashboard' })
    expect(typed.route).toEqual({ source: 'dashboard', chat_id: 'dashboard' })

    // Commentary on the voice turn: text only. Then the answer: text, then the voice note.
    answer('a1', heard.route, 'Checking the clock.', { kind: 'message', notify: false })
    await waitFor(() => outbound.length === 1)
    answer('a2', heard.route, 'It is nine.', { kind: 'message', notify: true })
    await waitFor(() => outbound.length === 3)
    expect(spoken()).toEqual(['It is nine.'])
    expect(outbound[1]).toMatchObject({ body: 'It is nine.', metadata: { chat_id: 'dashboard' } })
    expect(outbound[1].metadata.files).toBeUndefined()
    expect(outbound[2].metadata.chat_id).toBe('dashboard')
    expect(outbound[2].metadata.files).toHaveLength(1)
    expect(outbound[2].metadata.files[0]).toMatch(new RegExp(`^${sharedOutbox}/codexdash-.*\\.ogg$`))

    // The typed message's answer: text only, nothing spoken.
    // One at a time: fs.watch can coalesce a burst, and the sweep is 15 s.
    answer('b1', typed.route, 'It is ten.', { kind: 'message', notify: true })
    await waitFor(() => outbound.length === 4)
    // An older dispatcher's answer carries no notify; an error on a voice route is not spoken.
    answer('c1', unheard.route, 'Heard you.', { kind: 'message' })
    await waitFor(() => outbound.length === 6)
    answer('c2', unheard.route, 'Codex could not complete this turn: quota', { kind: 'error' })
    await waitFor(() => outbound.length === 7)
    await Bun.sleep(300)
    expect(spoken()).toEqual(['It is nine.', 'Heard you.'])
    expect(outbound.filter(o => o.metadata.files).map(o => o.metadata.chat_id)).toEqual(['dashboard', 'web'])
    expect(outbound.find(o => o.body === 'It is ten.').metadata.files).toBeUndefined()
  }, 15_000)
})
