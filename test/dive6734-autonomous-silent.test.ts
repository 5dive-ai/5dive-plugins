// DIVE-6734 — an agent working on its own stops posting "Usage limit hit" in
// its group. lodar 2026-10-22: "its like noone asked an agent directly yet it
// spams usage limit hit in group" (olivia, in the team group, on a turn nobody
// had started). The rule: nobody asked → nobody is told. The work resumes by
// itself after the reset.
//
// Every arm EXECUTES the real hook against the local Bot API stub and counts
// what was transmitted. The mutant is the pre-fix tree (the main branch before this
// row): there, the first arm sends one message to the group topic, the late-
// caller arms send to the group and swallow the caller, and the demo arm posts
// in the group.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DEMO_STRINGS } from '../plugins/telegram/hooks/lib/demo-key'

const HOOKS = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks')
const OWNER = '1234567890'
const GUEST = '1234567891'
const GROUP = '-1009876543210'
const TOPIC = '1417'
const LIMIT_MSG = 'Claude usage limit reached · your limit resets 9am (UTC)'

type Call = { chatId: string; threadId?: string; text: string; markup?: string }

let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog: string

async function startStub(): Promise<string> {
  stubLog = join(home, 'stub.jsonl')
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: 'ok' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    const first = readFileSync(stubLog, 'utf8').split('\n')[0]
    if (first) return `http://127.0.0.1:${(JSON.parse(first) as { port: number }).port}`
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('telegram stub never bound a port')
}
const calls = (): Call[] =>
  readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter((c: { port?: number }) => c.port === undefined)

const stateDir = () => join(home, '.claude', 'channels', 'telegram')
const lockDir = () => join(home, '.cache', '5dive-telegram', 'resume')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dive6734-'))
  mkdirSync(stateDir(), { recursive: true })
  // The measured olivia shape: the owner's DM plus the team group, bound to the
  // agent's own forum topic.
  writeFileSync(
    join(stateDir(), 'access.json'),
    JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [OWNER, GUEST],
      owners: [OWNER],
      groups: { [GROUP]: { requireMention: false, allowFrom: [OWNER], message_thread_id: Number(TOPIC) } },
    }),
  )
})
afterEach(() => {
  stub?.kill()
  stub = null
  rmSync(home, { recursive: true, force: true })
})

// No telegram inbound: a heartbeat/task/cron turn.
function autonomous(): string {
  const p = join(home, 'transcript-autonomous.jsonl')
  writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: 'heartbeat: continue the queue' } }) + '\n')
  return p
}
// Someone wrote to the agent (a DM, or a group's forum topic when thread is set).
function caller(chat: string, thread?: string): string {
  const p = join(home, `transcript-caller-${chat}-${thread ?? 'dm'}.jsonl`)
  const topic = thread ? ` message_thread_id="${thread}"` : ''
  writeFileSync(
    p,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="${chat}" message_id="1"${topic} user="op">status?</channel>` },
    }) + '\n',
  )
  return p
}

// A seat with a pane: tmux answers `display` with an agent session, and the
// account CLIs say nothing useful (no rotation, no headroom read).
function seatBin(): string {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  put('tmux', 'case "$*" in *display*) echo "agent-olivia:0.0";; esac; exit 0')
  put('5dive', `echo '{"ok":false}'`)
  put('sudo', `echo '{"ok":false}'`)
  return bin
}
// A recovery helper mid-wait: it heartbeats a fresh resume.lock.
function helperHoldsLock(): void {
  mkdirSync(lockDir(), { recursive: true })
  writeFileSync(join(lockDir(), 'resume.lock'), `1 ${Date.now()}`)
}

function fire(
  transcript: string,
  apiBase: string,
  opts: { seat?: boolean; payload?: Record<string, unknown>; env?: Record<string, string>; hook?: string } = {},
): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [join(HOOKS, opts.hook ?? 'stopfailure-notify.ts')], {
    input: JSON.stringify({ message: LIMIT_MSG, reason: 'usage_limit', stopReason: 'rate_limit', transcript_path: transcript, ...opts.payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      TELEGRAM_STATE_DIR: stateDir(),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: apiBase,
      TELEGRAM_PROFILE: '',
      AGENT_AUTH_PROFILE: '',
      ...(opts.seat ? { TMUX: '/tmp/fake-sock,1,0', PATH: `${seatBin()}:${process.env.PATH}` } : { TMUX: '' }),
      ...opts.env,
    },
    timeout: 20000,
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

describe('DIVE-6734 nobody asked → nobody is told', () => {
  const T = 30000

  test('an autonomous usage limit sends nothing, with group topics configured, and says why', async () => {
    const base = await startStub()
    const r = fire(autonomous(), base)
    expect(r.code).toBe(0)
    expect(calls()).toEqual([])
    expect(r.stderr).toContain('ratelimit dedup: SEND')
    expect(r.stderr).toContain('route=autonomous-silent targets=(none)')
  }, T)

  test('an autonomous transient throttle sends nothing either', async () => {
    const base = await startStub()
    const r = fire(autonomous(), base, {
      payload: { message: 'API Error: temporarily limiting requests. This is not your usage limit.', reason: 'api_error', stopReason: undefined },
    })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('transient dedup: SEND')
    expect(calls()).toEqual([])
  }, T)

  test('a caller turn is unchanged: the person who wrote hears it, in their own topic', async () => {
    const base = await startStub()
    const r = fire(caller(GROUP, TOPIC), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.map(x => [x.chatId, x.threadId])).toEqual([[GROUP, TOPIC]])
    expect(c[0].text).toMatch(/Usage limit hit/)
  }, T)

  // The dedup must not swallow a caller (no pane: the per-kind cooldown stamp).
  test('a silent autonomous episode, then a caller within the cooldown: exactly one send, to the caller', async () => {
    const base = await startStub()
    expect(fire(autonomous(), base).code).toBe(0)
    const r = fire(caller(OWNER), base)
    expect(r.code).toBe(0)
    expect(calls().map(x => x.chatId)).toEqual([OWNER])
    expect(r.stderr).toContain('ratelimit dedup: SEND')
  }, T)

  // ...and the caller's own episode still collapses to one notice.
  test('the caller is told once per episode, not on every repeat', async () => {
    const base = await startStub()
    fire(autonomous(), base)
    const t = caller(OWNER)
    for (let i = 0; i < 3; i++) expect(fire(t, base).code).toBe(0)
    expect(calls().map(x => x.chatId)).toEqual([OWNER])
  }, T)

  // The dedup must not swallow a caller (a pane: the helper's resume lock).
  test('the helper is waiting out a silent episode; a caller writes: exactly one send, to the caller, and no second helper', async () => {
    const base = await startStub()
    helperHoldsLock()
    const t = caller(GROUP, TOPIC)
    const first = fire(t, base, { seat: true })
    expect(first.code).toBe(0)
    expect(calls().map(x => [x.chatId, x.threadId])).toEqual([[GROUP, TOPIC]])
    // The helper's own 'continue' bouncing in that session: already told.
    expect(fire(t, base, { seat: true }).code).toBe(0)
    expect(calls().length).toBe(1)
    // Another person writing is told too, once.
    fire(caller(GUEST), base, { seat: true })
    fire(caller(GUEST), base, { seat: true })
    expect(calls().map(x => x.chatId)).toEqual([GROUP, GUEST])
    // The running helper keeps the lock; nobody spawned another one.
    expect(readdirSync(lockDir()).filter(f => f.startsWith('resume-'))).toEqual([])
    expect(readdirSync(lockDir())).toContain('resume.lock')
  }, T)

  test('the helper is waiting; another autonomous StopFailure stays silent', async () => {
    const base = await startStub()
    helperHoldsLock()
    expect(fire(autonomous(), base, { seat: true }).code).toBe(0)
    expect(calls()).toEqual([])
  }, T)

  // The one exception: the demo key's "out of free usage" with its buttons is the
  // upgrade path, and nothing resumes until the owner acts on it.
  test('the demo notice on an autonomous turn goes to the owner DM only, never the group', async () => {
    const base = await startStub()
    const r = fire(autonomous(), base, {
      payload: {
        message: 'API Error: 403 {"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys","code":403}}',
        reason: undefined,
        stopReason: undefined,
      },
      env: { AGENT_AUTH_PROFILE: 'demo-ai', ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-fake-dive6734' },
    })
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.map(x => x.chatId)).toEqual([OWNER])
    expect(c[0].text).toBe(DEMO_STRINGS.en.usedUp)
    expect(c[0].markup).toBeDefined()
    expect(r.stderr).toContain(`route=owners targets=${OWNER}`)
  }, T)
})

// The Stop hook's session-limit branch had the same autonomous rung (to the
// owners' DMs): same rule, same silence.
describe('DIVE-6734 stop-reply-check session-limit notice', () => {
  const T = 30000
  function withLimitTail(transcript: string): string {
    const lines = readFileSync(transcript, 'utf8')
    writeFileSync(
      transcript,
      lines +
        JSON.stringify({
          type: 'assistant',
          uuid: 'u-6734',
          isApiErrorMessage: true,
          message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 9am (UTC)" }] },
        }) +
        '\n',
    )
    return transcript
  }

  test('an autonomous turn ending on a session limit sends nothing', async () => {
    const base = await startStub()
    expect(fire(withLimitTail(autonomous()), base, { hook: 'stop-reply-check.ts', payload: { hook_event_name: 'Stop' } }).code).toBe(0)
    expect(calls().filter(c => /Session limit hit/.test(c.text))).toEqual([])
  }, T)

  test('a caller turn ending on a session limit still tells the caller', async () => {
    const base = await startStub()
    fire(withLimitTail(caller(OWNER)), base, { hook: 'stop-reply-check.ts', payload: { hook_event_name: 'Stop' } })
    expect(calls().filter(c => /Session limit hit/.test(c.text)).map(c => c.chatId)).toEqual([OWNER])
  }, T)
})
