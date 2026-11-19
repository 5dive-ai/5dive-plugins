// DIVE-8800 — a partner client whose weekly AI allowance ran out was told to
// "sign in again" (reported 2026-11-13 and 2026-11-19).
// OpenRouter refuses a capped key with 403 "Key limit exceeded (weekly limit)"
// and Claude Code files that under `authentication_failed`, which the sign-in
// matcher read as a revoked login. A key's cap is a limit, never a sign-in:
// the client hears her allowance line, an owner hears their key hit its limit,
// a my.5dive box's free key the demo notice, and a real revoked sign-in is
// unchanged. Both hooks are driven end to end against a Bot API stub.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  endedOnKeyLimit,
  endedOnSigninRefusal,
  isSigninPayload,
  isSigninRefusalText,
  KEY_LIMIT_NOTICE,
  SIGNIN_NOTICE,
} from '../plugins/telegram/hooks/lib/signin'
import { LITE_STRINGS } from '../plugins/telegram/hooks/lib/lite'
import { DEMO_STRINGS } from '../plugins/telegram/hooks/lib/demo-key'
import type { TranscriptEntry } from '../plugins/telegram/hooks/lib/types'

const ROOT = join(import.meta.dir, '..', 'plugins', 'telegram')
const STOP = join(ROOT, 'hooks', 'stop-reply-check.ts')
const STOPFAILURE = join(ROOT, 'hooks', 'stopfailure-notify.ts')
const CHAT = '1234567890'
const REVOKED = 'OAuth token revoked · Please run /login'
// The refusal as the client's agent logged it (report on DIVE-8800).
const CAP = 'API Error: 403 {"error":{"message":"Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/settings/keys","code":403}}'
const CAP_PAYLOAD = { hook_event_name: 'StopFailure', error: 'authentication_failed', error_details: CAP.replace('API Error: ', '') }

const inbound = (text: string) =>
  ({
    type: 'user',
    message: { content: `<channel source="plugin:telegram:telegram" chat_id="${CHAT}" message_id="7" user="owner">${text}</channel>` },
  }) as unknown as TranscriptEntry
const apiError = (t: string, error = 'authentication_failed') =>
  ({ type: 'assistant', isApiErrorMessage: true, error, message: { content: [{ type: 'text', text: t }] } }) as unknown as TranscriptEntry

describe('DIVE-8800 a key cap is never a sign-in', () => {
  test('the matcher: "Key limit exceeded" outranks authentication_failed; a revoked sign-in is unchanged', () => {
    expect(isSigninRefusalText(CAP, 'authentication_failed')).toBe(false)
    expect(isSigninRefusalText(REVOKED, 'authentication_failed')).toBe(true)
    expect(isSigninRefusalText('OAuth token has expired. Please run /login')).toBe(true)
  })

  test("the StopFailure payload's own fields", () => {
    expect(isSigninPayload(CAP_PAYLOAD)).toBe(false)
    expect(isSigninPayload({ error: 'authentication_failed', last_assistant_message: CAP })).toBe(false)
    expect(isSigninPayload({ error: 'authentication_failed' })).toBe(true)
    expect(isSigninPayload({ error: 'authentication_failed', error_details: `401 ${REVOKED}` })).toBe(true)
  })

  test('the transcript: only a turn that ENDED on the cap counts', () => {
    expect(endedOnKeyLimit([inbound('hi'), apiError(CAP)])).toBe(true)
    expect(endedOnSigninRefusal([inbound('hi'), apiError(CAP)])).toBe(false)
    expect(endedOnKeyLimit([inbound('what is "Key limit exceeded"?'), { type: 'assistant', message: { content: [{ type: 'text', text: 'Key limit exceeded means…' }] } } as unknown as TranscriptEntry])).toBe(false)
    expect(endedOnKeyLimit([inbound('hi'), apiError(REVOKED)])).toBe(false)
  })
})

let home: string
let bin: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''
let apiBase = ''

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dive8800-'))
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

const LITE_ENV = { TELEGRAM_PROFILE: 'lite', TELEGRAM_ACCOUNT_URL: 'https://cabinet.example.com/account', ANTHROPIC_BASE_URL: '' }

describe('DIVE-8800 the Stop hook, driven', () => {
  const T = 30000

  test('a partner client on a capped key hears her allowance line with the account button, never "sign in again"', async () => {
    expect(run(STOP, [inbound('hello?'), apiError(CAP)], {}, LITE_ENV)).toBe(0)
    const s = sent()
    expect(s.length).toBe(1)
    expect(s[0].text).toBe(LITE_STRINGS.en.limitReached(null))
    expect(s[0].markup).toContain('https://cabinet.example.com/account')
    expect(s.some(m => m.text === SIGNIN_NOTICE.client.en || /key limit|openrouter/i.test(m.text))).toBe(false)
  }, T)

  test('in Russian when the chat language is ru', async () => {
    writeFileSync(join(home, 'state', 'lite-lang'), 'ru\n')
    run(STOP, [inbound('привет'), apiError(CAP)], {}, LITE_ENV)
    expect(sent().map(m => m.text)).toEqual([LITE_STRINGS.ru.limitReached(null)])
  }, T)

  test('an owner on their own capped key hears the key hit its limit, not /login', async () => {
    run(STOP, [inbound('are you there?'), apiError(CAP)])
    expect(sent().map(m => m.text)).toEqual([KEY_LIMIT_NOTICE.en])
  }, T)

  test("an agent on a my.5dive box's free key gets the demo notice once per key", async () => {
    const env = {
      AGENT_AUTH_PROFILE: 'demo-ai',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-fake',
      FIVE_LOCAL_ONLY_FILE: join(home, 'no-local-only'),
      // openrouter.ai is never reached: the key read fails at a closed proxy,
      // and a failed read with the cap in hand counts as used up.
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1',
    }
    run(STOP, [inbound('hi'), apiError(CAP)], {}, env)
    run(STOP, [inbound('hi again'), apiError(CAP)], {}, env)
    expect(sent().map(m => m.text)).toEqual([DEMO_STRINGS.en.usedUp])
  }, T)

  test('a real revoked sign-in still gets the sign-in notice', async () => {
    run(STOP, [inbound('hi'), apiError(REVOKED)], {}, LITE_ENV)
    expect(sent().map(m => m.text)).toEqual([SIGNIN_NOTICE.client.en])
  }, T)
})

describe('DIVE-8800 the StopFailure hook, driven', () => {
  const T = 30000

  test('a partner client on a capped key hears her allowance line, never "sign in again"', async () => {
    expect(run(STOPFAILURE, [inbound('ping'), apiError(CAP)], CAP_PAYLOAD, LITE_ENV)).toBe(0)
    const s = sent()
    expect(s.length).toBe(1)
    expect(s[0].text).toBe(LITE_STRINGS.en.limitReached(null))
    expect(s[0].markup).toContain('https://cabinet.example.com/account')
  }, T)

  test('repeat failures in one episode make one notice', async () => {
    for (let i = 0; i < 3; i++) run(STOPFAILURE, [inbound('ping'), apiError(CAP)], CAP_PAYLOAD, LITE_ENV)
    expect(sent().length).toBe(1)
  }, T)

  test('an owner hears the key hit its limit', async () => {
    run(STOPFAILURE, [inbound('ping'), apiError(CAP)], CAP_PAYLOAD)
    expect(sent().map(m => m.text)).toEqual([KEY_LIMIT_NOTICE.en])
  }, T)

  test('a real expired sign-in still gets the sign-in notice', async () => {
    run(STOPFAILURE, [inbound('ping'), apiError('OAuth token has expired. Please run /login')], { hook_event_name: 'StopFailure', error: 'authentication_failed' }, LITE_ENV)
    expect(sent().map(m => m.text)).toEqual([SIGNIN_NOTICE.client.en])
  }, T)
})
