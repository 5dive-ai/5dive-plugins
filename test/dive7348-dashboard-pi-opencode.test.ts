// DIVE-7348: the web chat on Pi and OpenCode seats. The dashboard server runs
// its adapter shape beside the seat (5dive-agent-start, --runtime=pi|opencode)
// and clidispatch.ts answers each message with one headless turn of the seat's
// own CLI in the web chat's session. Event shapes below are copied from live
// runs of pi 1.5.0 and opencode 1.19.5 on 2026-11-06.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLI_HEADER, OPENCODE_PERMISSION, VOICE_HINT, cliTurn, cliTurnTimeoutS, failedText, failedWithReason, noAnswerText,
  notInstalledText, parseOpencodeTurn, parsePiTurn, plainReason, promptFor, startCliDispatcher, tooSlowText, turnEnv,
  type RunTurn, type Spawner,
} from '../plugins/dashboard/clidispatch.ts'

const DASH = join(import.meta.dir, '..', 'plugins', 'dashboard')
const SERVER = join(DASH, 'server.ts')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  expect(predicate()).toBe(true)
}

function drop(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(body))
  renameSync(join(dir, `.${name}.tmp`), join(dir, `${name}.json`))
}

const readOutbox = (dir: string) => {
  try { return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch { return [] }
}

const ev = (o: unknown) => JSON.stringify(o)
const S = 'ses_e4ce07521ffe92XarWftgVxUPU'
// opencode 1.19.5, a turn that ran `echo hi` and then answered.
const OC_TOOL_TURN = [
  ev({ type: 'step_start', sessionID: S, part: { type: 'step-start' } }),
  ev({ type: 'text', sessionID: S, part: { type: 'text', text: 'Let me run that.' } }),
  ev({ type: 'tool_use', sessionID: S, part: { type: 'tool', tool: 'bash', state: { status: 'completed' } } }),
  ev({ type: 'step_finish', sessionID: S, part: { type: 'step-finish', reason: 'tool-calls' } }),
  ev({ type: 'step_start', sessionID: S, part: { type: 'step-start' } }),
  ev({ type: 'text', sessionID: S, part: { type: 'text', text: 'The word is "kiwi." The output is hi.' } }),
  ev({ type: 'step_finish', sessionID: S, part: { type: 'step-finish', reason: 'stop' } }),
].join('\n')

describe('a Pi or OpenCode turn', () => {
  test('the prompt names the web chat, flags a spoken note and points at an upload', () => {
    expect(promptFor({ text: '  hi there ' })).toBe(`${CLI_HEADER}\nhi there`)
    expect(promptFor({ text: '[voice note] good morning', route: { voice: true } })).toBe(`${CLI_HEADER}\n${VOICE_HINT}\n[voice note] good morning`)
    expect(promptFor({ text: 'look', image_path: '/home/claude/chat-uploads/a/p.png' })).toContain('[Attached file: /home/claude/chat-uploads/a/p.png]')
    expect(promptFor({ text: '', image_path: '/x/n.webm' })).toContain('[Voice note: /x/n.webm]')
  })

  test('pi: stdout is the answer; a failed turn carries its reason; silence is no answer', () => {
    expect(parsePiTurn('pong.\n', '', 0)).toEqual({ kind: 'reply', text: 'pong.' })
    expect(parsePiTurn('', '', 0)).toEqual({ kind: 'empty' })
    // Live, 2026-11-06: pi -p on an OpenAI key with no credit.
    expect(parsePiTurn('', 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.', 1))
      .toEqual({ kind: 'failed', reason: 'You have no credits remaining.' })
  })

  test('opencode: the answer is the text after the last tool call, and the session id is kept', () => {
    expect(parseOpencodeTurn(OC_TOOL_TURN, '', 0)).toEqual({ kind: 'reply', text: 'The word is "kiwi." The output is hi.', sessionId: S })
    const plain = ev({ type: 'text', sessionID: S, part: { type: 'text', text: 'pong.' } })
    expect(parseOpencodeTurn(plain, '', 0)).toEqual({ kind: 'reply', text: 'pong.', sessionId: S })
    // Text before a tool and nothing after: every text part rather than nothing.
    const onlyBefore = [ev({ type: 'text', sessionID: S, part: { type: 'text', text: 'Checking.' } }), ev({ type: 'tool_use', sessionID: S, part: { tool: 'bash' } })].join('\n')
    expect(parseOpencodeTurn(onlyBefore, '', 0)).toMatchObject({ kind: 'reply', text: 'Checking.' })
    expect(parseOpencodeTurn(ev({ type: 'step_finish', sessionID: S, part: {} }), '', 0)).toEqual({ kind: 'empty', sessionId: S })
  })

  test('opencode: a failed model call exits 0 and is still a failure, with its reason', () => {
    // Live, opencode 1.15.13 on the free tier.
    const err = ev({ type: 'error', sessionID: S, error: { name: 'APIError', data: { message: 'OpenCode 1.18.0 or newer is required to use the free tier', statusCode: 426 } } })
    expect(parseOpencodeTurn(err, '', 0)).toEqual({ kind: 'failed', reason: 'OpenCode 1.18.0 or newer is required to use the free tier', sessionId: S })
    expect(parseOpencodeTurn('', '\x1b[91m\x1b[1mError: \x1b[0mSession not found', 1)).toEqual({ kind: 'failed', reason: 'Session not found' })
  })

  test('a provider error is cut to one plain sentence with no links or JSON', () => {
    expect(plainReason('403: {"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/x $1.09 of $1.00 used","code":403}')).toBe('Key limit exceeded (total limit).')
    expect(plainReason('')).toBe('')
    expect(plainReason('x'.repeat(400)).length).toBeLessThanOrEqual(160)
  })

  test('the turn limit is a whole number of seconds from 60 to 7200', () => {
    expect(cliTurnTimeoutS(undefined)).toBe(600)
    expect(cliTurnTimeoutS('1800')).toBe(1800)
    expect(cliTurnTimeoutS('5')).toBe(600)
    expect(cliTurnTimeoutS('abc')).toBe(600)
  })

  test("opencode's turn reads the seat's own config and gets the seat's permissions", () => {
    const env = turnEnv('opencode', '/nonexistent/bin/opencode', { PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/claude/.config' })
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
    expect(env.OPENCODE_PERMISSION).toBe(OPENCODE_PERMISSION)
    expect(env.PATH).toBe('/nonexistent/bin:/usr/bin')
    // An operator's own value wins; pi keeps the environment as it is, beyond PATH.
    expect(turnEnv('opencode', '/b/opencode', { OPENCODE_PERMISSION: '{}' }).OPENCODE_PERMISSION).toBe('{}')
    expect(turnEnv('pi', '/b/pi', { XDG_CONFIG_HOME: '/x' }).XDG_CONFIG_HOME).toBe('/x')
  })
})

describe('the turn runner', () => {
  const fake = (results: Array<{ stdout?: string; stderr?: string; code?: number | null; timedOut?: boolean; missing?: boolean }>) => {
    const calls: Array<{ bin: string; args: string[]; input: string; cwd: string }> = []
    const spawner: Spawner = async (bin, args, input, o) => {
      calls.push({ bin, args, input, cwd: o.cwd })
      const r = results.shift() ?? {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code === undefined ? 0 : r.code, timedOut: !!r.timedOut, missing: !!r.missing }
    }
    return { calls, spawner }
  }

  test('pi continues one session in the spool, with the message on stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-turn-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { calls, spawner } = fake([{ stdout: 'pong.\n' }])
    const run = cliTurn({ runtime: 'pi', bin: '/b/pi', stateDir: dir, cwd: '/work', spawner, env: {} })
    expect(await run('hello')).toMatchObject({ kind: 'reply', text: 'pong.' })
    expect(calls[0]).toEqual({ bin: '/b/pi', args: ['-p', '--session-dir', join(dir, 'pi-sessions'), '--continue'], input: 'hello', cwd: '/work' })
  })

  test('opencode keeps the first turn’s session, and starts a new one once if it is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-turn-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const answer = (sid: string, text: string) => ev({ type: 'text', sessionID: sid, part: { type: 'text', text } })
    const { calls, spawner } = fake([
      { stdout: answer('ses_one', 'first') },
      { stdout: answer('ses_one', 'second') },
      { stdout: '', stderr: 'Error: Session not found', code: 1 },
      { stdout: answer('ses_two', 'third') },
    ])
    const run = cliTurn({ runtime: 'opencode', bin: '/b/opencode', stateDir: dir, cwd: '/work', spawner, env: {} })
    expect(await run('a')).toMatchObject({ kind: 'reply', text: 'first' })
    expect(calls[0].args).toEqual(['run', '--format', 'json', '--title', '5dive web chat'])
    expect(readFileSync(join(dir, 'opencode-session'), 'utf8').trim()).toBe('ses_one')
    expect(await run('b')).toMatchObject({ kind: 'reply', text: 'second' })
    expect(calls[1].args).toEqual(['run', '--format', 'json', '--session', 'ses_one'])
    expect(await run('c')).toMatchObject({ kind: 'reply', text: 'third' })
    expect(calls[2].args).toContain('ses_one')
    expect(calls[3].args).toEqual(['run', '--format', 'json', '--title', '5dive web chat'])
    expect(calls[3].input).toBe('c')
    expect(readFileSync(join(dir, 'opencode-session'), 'utf8').trim()).toBe('ses_two')
  })
})

describe('the Pi / OpenCode dispatcher', () => {
  const setup = (runtime: 'pi' | 'opencode', run: RunTurn) => {
    const root = mkdtempSync(join(tmpdir(), `${runtime}-disp-`))
    const inbox = join(root, 'inbox'), outbox = join(root, 'outbox')
    const d = startCliDispatcher({ runtime, inboxDir: inbox, outboxDir: outbox, run, log: () => {} })
    cleanups.push(() => { d.stop(); rmSync(root, { recursive: true, force: true }) })
    return { inbox, outbox, d }
  }

  test('answers in arrival order, one turn at a time, and keeps a voice note spoken', async () => {
    const prompts: string[] = []
    let running = 0, maxRunning = 0
    const { inbox, outbox } = setup('pi', async p => {
      running++; maxRunning = Math.max(maxRunning, running); prompts.push(p)
      await Bun.sleep(30); running--
      return { kind: 'reply', text: `re: ${p.split('\n').pop()}` }
    })
    drop(inbox, '1', { id: 'a', text: 'first', route: { chat_id: 'dashboard' } })
    drop(inbox, '2', { id: 'b', text: 'second', route: { chat_id: 'dashboard', voice: true } })
    await waitFor(() => readOutbox(outbox).length === 2)
    const out = readOutbox(outbox)
    expect(out.map(o => o.text)).toEqual(['re: first', 're: second'])
    expect(out[1].voice).toBe(true)
    expect(maxRunning).toBe(1)
    expect(prompts[1]).toContain(VOICE_HINT)
  })

  test('every way a turn can fail ends in a plain notice, never silence', async () => {
    const results: Awaited<ReturnType<RunTurn>>[] = [
      { kind: 'empty' },
      { kind: 'failed', reason: 'You have no credits remaining.' },
      { kind: 'failed', reason: '' },
      { kind: 'failed', reason: '', timedOut: true },
      { kind: 'failed', reason: 'spawn ENOENT', missing: true },
    ]
    const { inbox, outbox } = setup('opencode', async () => results.shift()!)
    for (let i = 0; i < 5; i++) drop(inbox, String(i), { id: String(i), text: 'q', route: { chat_id: 'dashboard', voice: true } })
    await waitFor(() => readOutbox(outbox).length === 5)
    const out = readOutbox(outbox)
    expect(out.map(o => o.text)).toEqual([
      noAnswerText('opencode'),
      failedWithReason('opencode', 'You have no credits remaining.'),
      failedText('opencode'),
      tooSlowText('opencode'),
      notInstalledText('opencode'),
    ])
    expect(out[0].text).toBe('OpenCode worked on your message but did not write an answer. Try asking again.')
    // A notice is never spoken.
    expect(out.every(o => o.voice === undefined)).toBe(true)
  })

  test('a runner that throws still ends in a notice', async () => {
    const { inbox, outbox } = setup('pi', async () => { throw new Error('boom') })
    drop(inbox, '1', { id: 'x', text: 'q', route: { chat_id: 'dashboard' } })
    await waitFor(() => readOutbox(outbox).length === 1)
    expect(readOutbox(outbox)[0].text).toBe('Pi could not answer just now. Try again in a minute.')
  })

  test('an answer over the word cap is rewritten in the same session', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ')
    const prompts: string[] = []
    const { inbox, outbox } = setup('pi', async p => { prompts.push(p); return { kind: 'reply', text: prompts.length === 1 ? long : 'short now' } })
    drop(inbox, '1', { id: 'x', text: 'q', route: { chat_id: 'dashboard' } })
    await waitFor(() => readOutbox(outbox).length === 1)
    expect(readOutbox(outbox)[0].text).toBe('short now')
    expect(prompts[1]).toMatch(/too long: \d+ words; cut to \d+/)
  })
})

function fakeApi(pending: Array<{ id: number; text: string; from: string; chat_id: string }>) {
  const outbound: any[] = []
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') return Response.json({ pending })
      if (url.pathname === '/server/messages/pending/ack') {
        const body = await req.json() as { ids: number[] }
        pending.splice(0, pending.length, ...pending.filter(m => !body.ids.includes(m.id)))
        return Response.json({ ok: true, acked: body.ids.length })
      }
      if (url.pathname === '/server/messages/event') {
        outbound.push(await req.json())
        return Response.json({ id: 200 + outbound.length })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { api, outbound }
}

function serverEnv(root: string, port: number, extra: Record<string, string>) {
  const sharedOutbox = join(root, 'downloads')
  mkdirSync(sharedOutbox, { recursive: true })
  return {
    ...process.env,
    DASHBOARD_DISPATCHER_SWEEP_MS: '200',
    DASHBOARD_INBOX_SWEEP_MS: '200',
    DASHBOARD_STATE_DIR: join(root, '.claude', 'channels', 'dashboard'),
    DASHBOARD_OUTBOX: sharedOutbox,
    DASHBOARD_API_BASE: `http://127.0.0.1:${port}`,
    DASHBOARD_FFMPEG: '/bin/false',
    DASHBOARD_FFPROBE: '/bin/false',
    CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
    HOME: root,
    ...extra,
  }
}

describe('Pi and OpenCode web chat end to end', () => {
  test("a typed message gets Pi's answer, from the seat's work folder, in one continued session", async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-dashboard-'))
    const work = join(root, 'work'); mkdirSync(work)
    const log = join(root, 'pi.log')
    const pi = join(root, 'pi')
    // Stands in for `pi -p`: logs argv and cwd, answers with stdin's last line.
    writeFileSync(pi, `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nmsg=$(cat | tail -n 1)\nprintf 'Pi says: %s\\n' "$msg"\n`)
    chmodSync(pi, 0o755)
    const { api, outbound } = fakeApi([{ id: 91, text: 'what is two plus two', from: 'owner', chat_id: 'dashboard' }])
    const child = Bun.spawn(['bun', SERVER, '--runtime=pi'], {
      env: serverEnv(root, api.port, { DASHBOARD_CLI_BIN: pi, DASHBOARD_AGENT_WORKDIR: work, USER: 'agent-pidash' }),
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({ agent: 'pidash', body: 'Pi says: what is two plus two', metadata: { chat_id: 'dashboard' } })
    const line = readFileSync(log, 'utf8').trim()
    expect(line).toBe(`${work}|-p --session-dir ${join(root, '.pi', 'channels', '5dive', 'pi-sessions')} --continue`)
    // The message never rode argv.
    expect(line).not.toContain('two plus two')
    expect(child.exitCode).toBeNull()

    const inbox = join(root, '.claude', 'channels', 'dashboard', 'agent-inbox')
    drop(inbox, 'm2', { text: 'and three?', chat_id: 'dashboard' })
    await waitFor(() => outbound.length === 2)
    expect(outbound[1].body).toBe('Pi says: and three?')
  }, 30_000)

  test("a typed message gets OpenCode's answer and a failed call shows its reason", async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-dashboard-'))
    const log = join(root, 'oc.log')
    const oc = join(root, 'opencode')
    // Stands in for `opencode run --format json`: answers stdin's last line as a
    // text event, or, for "fail", the error event a provider refusal gives (exit 0).
    writeFileSync(oc, `#!/usr/bin/env bash\nprintf '%s|XDG=%s\\n' "$*" "\${XDG_CONFIG_HOME:-unset}" >> ${JSON.stringify(log)}\nmsg=$(cat | tail -n 1)\n`
      + `if [ "$msg" = fail ]; then printf '%s\\n' '{"type":"error","sessionID":"ses_abc","error":{"name":"APIError","data":{"message":"Insufficient credits. Add more using https://x.test/credits"}}}'; exit 0; fi\n`
      + `printf '{"type":"text","sessionID":"ses_abc","part":{"type":"text","text":"OpenCode says: %s"}}\\n' "$msg"\n`)
    chmodSync(oc, 0o755)
    const { api, outbound } = fakeApi([{ id: 92, text: 'hello there', from: 'owner', chat_id: 'dashboard' }])
    const child = Bun.spawn(['bun', SERVER, '--runtime=opencode'], {
      env: serverEnv(root, api.port, { DASHBOARD_CLI_BIN: oc, USER: 'agent-ocdash', XDG_CONFIG_HOME: '/home/claude/.config' }),
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({ agent: 'ocdash', body: 'OpenCode says: hello there' })
    const inbox = join(root, '.claude', 'channels', 'dashboard', 'agent-inbox')
    drop(inbox, 'm2', { text: 'fail', chat_id: 'dashboard' })
    await waitFor(() => outbound.length === 2)
    expect(outbound[1].body).toBe('OpenCode could not answer: Insufficient credits.')
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('run --format json --title 5dive web chat|XDG=unset')
    expect(lines[1]).toBe('run --format json --session ses_abc|XDG=unset')
    expect(existsSync(join(root, '.opencode', 'channels', '5dive', 'opencode-session'))).toBe(true)
  }, 30_000)
})
