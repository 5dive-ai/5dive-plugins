// DIVE-7835 — an agent whose AI sign-in was revoked tells the owner to sign in
// again (/login), instead of relaying Claude Code's raw "OAuth token revoked ·
// Please run /login".
//
// Seen 2026-11-06 on a partner box: every agent answered every message with the
// raw line until the client wrote to support. Both hooks that could send it are
// driven END TO END here: the real hook runs as a subprocess against a synthetic
// transcript, and a local Bot API stub records what it actually transmitted.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  authStartArgv,
  endedOnSigninRefusal,
  isSigninPayload,
  isSigninRefusalText,
  SIGNIN_NOTICE,
  LOGIN_ADMIN_TIER,
} from '../plugins/telegram/hooks/lib/signin'
import type { TranscriptEntry } from '../plugins/telegram/hooks/lib/types'

const ROOT = join(import.meta.dir, '..', 'plugins', 'telegram')
const STOP = join(ROOT, 'hooks', 'stop-reply-check.ts')
const STOPFAILURE = join(ROOT, 'hooks', 'stopfailure-notify.ts')
const CHAT = '1234567890'
const REVOKED = 'OAuth token revoked · Please run /login'

const inbound = (text: string) =>
  ({
    type: 'user',
    message: { content: `<channel source="plugin:telegram:telegram" chat_id="${CHAT}" message_id="7" user="owner">${text}</channel>` },
  }) as unknown as TranscriptEntry
const apiError = (t: string, error = 'authentication_failed') =>
  ({ type: 'assistant', isApiErrorMessage: true, error, message: { content: [{ type: 'text', text: t }] } }) as unknown as TranscriptEntry
const said = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }) as unknown as TranscriptEntry

describe('DIVE-7835 sign-in matcher', () => {
  test("Claude Code's sign-in refusals, never a key, a balance or the agent's own words", () => {
    expect(isSigninRefusalText(REVOKED)).toBe(true)
    expect(isSigninRefusalText('OAuth token has expired. Please run /login')).toBe(true)
    expect(isSigninRefusalText('Not logged in · Please run /login')).toBe(true)
    expect(isSigninRefusalText('', 'authentication_failed')).toBe(true)
    expect(isSigninRefusalText('Invalid API key · Please run /login')).toBe(false)
    expect(isSigninRefusalText('Credit balance is too low')).toBe(false)
    expect(isSigninRefusalText('API Error: 529 Overloaded')).toBe(false)
  })

  test('only a turn that ENDED on the API-error refusal counts', () => {
    expect(endedOnSigninRefusal([inbound('hi'), apiError(REVOKED)])).toBe(true)
    expect(endedOnSigninRefusal([inbound('hi'), apiError(REVOKED), inbound('again'), said('Back, all good.')])).toBe(false)
    expect(endedOnSigninRefusal([inbound('what does "please run /login" mean?'), said('It means: Please run /login.')])).toBe(false)
    expect(endedOnSigninRefusal([inbound('hi'), apiError('API Error: 529 Overloaded', 'server_error')])).toBe(false)
    expect(endedOnSigninRefusal([])).toBe(false)
  })

  test("a StopFailure payload's own fields", () => {
    expect(isSigninPayload({ error: 'authentication_failed' })).toBe(true)
    expect(isSigninPayload({ error: 'unknown', error_details: `401 ${REVOKED}` })).toBe(true)
    expect(isSigninPayload({ last_assistant_message: `API Error: 401 ${REVOKED}` })).toBe(true)
    expect(isSigninPayload({ last_assistant_message: `The customer saw: ${REVOKED}` })).toBe(false)
    expect(isSigninPayload({ error: 'rate_limit', message: 'usage limit' })).toBe(false)
  })

  test("/login signs in the seat's own account, never the box default by accident", () => {
    expect(authStartArgv('claude', 'client-claude-2')).toEqual(['agent', 'auth', 'start', 'claude', '--auth-profile=client-claude-2', '--json'])
    expect(authStartArgv('claude', undefined)).toEqual(['agent', 'auth', 'start', 'claude', '--json'])
    expect(authStartArgv('claude', 'default')).toEqual(['agent', 'auth', 'start', 'claude', '--json'])
    expect(authStartArgv('claude', '--evil')).toEqual(['agent', 'auth', 'start', 'claude', '--json'])
  })

  test('/login on a standard seat says where to sign in instead of only "needs admin"', () => {
    const src = readFileSync(join(ROOT, 'server.ts'), 'utf8')
    expect(src).toMatch(/def\.name === 'login' \? LOGIN_ADMIN_TIER\[lang\] : adminTierText\(lang\)/)
    expect(src).toMatch(/read5diveJson\(authStartArgv\(type, authProfile\), 15000\)/)
    expect(src).toMatch(/const started = await authStart\(type, authProfile\)/)
    expect(LOGIN_ADMIN_TIER.en).not.toMatch(/\/login/)
  })
})

let home: string
let bin: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''
let apiBase = ''

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dive7835-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'state', 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [CHAT] }))
  bin = join(home, 'bin')
  mkdirSync(bin)
  // tmux that captures an empty pane and has no session: no helper is spawned.
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\ncase "$1" in capture-pane) exit 0 ;; *) exit 1 ;; esac\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  stubLog = join(home, 'stub.jsonl')
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: 'ok' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    const first = readFileSync(stubLog, 'utf8').split('\n')[0]
    if (first) {
      const port = (JSON.parse(first) as { port?: number }).port
      if (port) {
        apiBase = `http://127.0.0.1:${port}`
        break
      }
    }
    await new Promise(r => setTimeout(r, 50))
  }
  if (!apiBase) throw new Error('telegram stub never bound a port')
})
afterEach(() => {
  stub?.kill()
  stub = null
  apiBase = ''
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

type Sent = { chatId: string; text: string; markup?: string }
function sent(): Sent[] {
  return readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Sent & { port?: number })
    .filter(c => c.port === undefined)
}

function run(hook: string, entries: TranscriptEntry[], payload: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const transcript = join(home, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false, ...payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      PATH: `${bin}:${process.env.PATH}`,
      TELEGRAM_STATE_DIR: join(home, 'state'),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: apiBase,
      TMUX: '',
      TELEGRAM_PROFILE: '',
      ...env,
    },
    timeout: 20000,
  })
  return r.status ?? -1
}

describe('DIVE-7835 the Stop hook, driven', () => {
  const T = 30000

  test('a turn ending on the revoked sign-in gets the sign-in notice, not the raw line', async () => {
    expect(run(STOP, [inbound('are you there?'), apiError(REVOKED)])).toBe(0)
    const s = sent()
    expect(s.length).toBe(1)
    expect(s[0].chatId).toBe(CHAT)
    expect(s[0].text).toBe(SIGNIN_NOTICE.owner.en)
    expect(s.some(m => m.text.includes('OAuth token revoked'))).toBe(false)
  }, T)

  test('in the language the owner wrote in', async () => {
    run(STOP, [inbound('ты тут?'), apiError(REVOKED)])
    expect(sent().map(m => m.text)).toEqual([SIGNIN_NOTICE.owner.ru])
  }, T)

  test('a partner client hears to sign in on their account page, with its button', async () => {
    run(STOP, [inbound('hello?'), apiError(REVOKED)], {}, { TELEGRAM_PROFILE: 'lite', TELEGRAM_ACCOUNT_URL: 'https://cabinet.example.com/account' })
    const s = sent()
    expect(s.length).toBe(1)
    expect(s[0].text).toBe(SIGNIN_NOTICE.client.en)
    expect(s[0].markup).toContain('https://cabinet.example.com/account')
  }, T)

  test('any other loose text still auto-relays as before', async () => {
    run(STOP, [inbound('hi'), said('Here is the answer.')])
    expect(sent().map(m => m.text)).toEqual(['(auto-relay) Here is the answer.'])
  }, T)
})

describe('DIVE-7835 the StopFailure hook, driven', () => {
  const T = 30000

  test('authentication_failed tells the caller to sign in again, not "stopped with an error"', async () => {
    expect(run(STOPFAILURE, [inbound('ping'), apiError(REVOKED)], { hook_event_name: 'StopFailure', error: 'authentication_failed' })).toBe(0)
    const s = sent()
    expect(s.length).toBe(1)
    expect(s[0].text).toBe(SIGNIN_NOTICE.owner.en)
  }, T)

  test('repeat failures in one episode make one notice', async () => {
    for (let i = 0; i < 3; i++) run(STOPFAILURE, [inbound('ping'), apiError(REVOKED)], { hook_event_name: 'StopFailure', error: 'authentication_failed' })
    expect(sent().length).toBe(1)
  }, T)

  test('a partner client gets the client line', async () => {
    run(STOPFAILURE, [inbound('ping'), apiError(REVOKED)], { hook_event_name: 'StopFailure', error: 'authentication_failed' }, { TELEGRAM_PROFILE: 'lite' })
    expect(sent().map(m => m.text)).toEqual([SIGNIN_NOTICE.client.en])
  }, T)

  test('another failure keeps its old text', async () => {
    run(STOPFAILURE, [inbound('ping'), apiError('API Error: 400 prompt is too long', 'invalid_request')], { hook_event_name: 'StopFailure', error: 'invalid_request' })
    const s = sent()
    expect(s.length).toBe(1)
    expect(s[0].text.startsWith('The agent stopped with an error')).toBe(true)
  }, T)
})
