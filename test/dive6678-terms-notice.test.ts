// DIVE-6678 — an agent whose Claude account owes the updated terms tells the
// owner, once, in their language.
//
// Measured 2026-10-21 on a partner box (DIVE-6677): the owner moved six seats
// onto their own Claude login, and every turn failed in the PANE only with the
// copy below. Five messages in four minutes got nothing back.
//
// These arms run the real hook against a local Bot API stub, with a fake `tmux`
// on PATH whose `capture-pane` prints a fixture pane (its `display` fails, so
// the hook has no pane to drive and spawns no helper). What is asserted is what
// was transmitted.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { isTermsWall, textLang, TERMS_NOTICE } from '../plugins/telegram/hooks/lib/terms'

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')
const OWNER_DM = '1234567890'

// The measured copy, exactly as the seat's pane showed it.
const TERMS_COPY =
  "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue."
const TERMS_LINE = `  ⎿  API Error: 400 ${TERMS_COPY}`
const PANE_TERMS = ['> Ау бля', '', TERMS_LINE, '', '>'].join('\n')
const PANE_OTHER = ['> привет', '', '  ⎿  API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}', '', '>'].join('\n')
// The copy further up, from an earlier episode; the failure that ended THIS
// turn is a different one.
const PANE_EARLIER = [TERMS_LINE, '> ok, accepted, try again', '  ⎿  API Error: 400 prompt is too long', '>'].join('\n')

type Call = { chatId: string; threadId?: string; text: string }

let home: string
let bin: string
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
    if (first) {
      const port = (JSON.parse(first) as { port?: number }).port
      if (port) return `http://127.0.0.1:${port}`
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('telegram stub never bound a port')
}

function calls(): Call[] {
  return readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Call & { port?: number })
    .filter(c => c.port === undefined)
}

const stateDir = () => join(home, '.claude', 'channels', 'telegram')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sf-terms-'))
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(join(stateDir(), 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [OWNER_DM] }))
  bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'tmux'),
    '#!/bin/sh\ncase "$1" in capture-pane) [ -f "$PANE_FIXTURE" ] && cat "$PANE_FIXTURE"; exit 0 ;; *) exit 1 ;; esac\n',
  )
  chmodSync(join(bin, 'tmux'), 0o755)
})
afterEach(() => {
  stub?.kill()
  stub = null
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

function transcript(text: string): string {
  const p = join(home, 'transcript.jsonl')
  const line = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: `<channel source="plugin:telegram:telegram" chat_id="${OWNER_DM}" message_id="1" user="owner">${text}</channel>`,
    },
  })
  writeFileSync(p, line + '\n')
  return p
}

// The StopFailure payload Claude Code 2.1.x sends: the error kind, the API's
// own text, and the `API Error:` line that ended the turn.
function fire(
  apiBase: string,
  opts: { pane?: string; payload?: Record<string, unknown>; transcript: string; env?: Record<string, string> },
): { code: number; stderr: string } {
  const paneFile = join(home, 'pane.txt')
  if (opts.pane !== undefined) writeFileSync(paneFile, opts.pane)
  else rmSync(paneFile, { force: true })
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'StopFailure', error: 'invalid_request', transcript_path: opts.transcript, ...opts.payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      PANE_FIXTURE: paneFile,
      TELEGRAM_STATE_DIR: stateDir(),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: apiBase,
      TMUX: '/tmp/fake-tmux,1,0',
      TELEGRAM_PROFILE: '',
      ...opts.env,
    },
    timeout: 20000,
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

const termsCalls = () => calls().filter(c => c.text === TERMS_NOTICE.ru || c.text === TERMS_NOTICE.en)

describe('DIVE-6678 terms notice, driven', () => {
  const T = 30000

  test('a fixture pane carrying the copy produces exactly one owner notice, in Russian', async () => {
    const base = await startStub()
    const r = fire(base, { pane: PANE_TERMS, transcript: transcript('Ау бля') })
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].chatId).toBe(OWNER_DM)
    expect(c[0].text).toBe(TERMS_NOTICE.ru)
  }, T)

  test('five failed messages in one episode still make one notice', async () => {
    const base = await startStub()
    const t = transcript('Агенты не отвечают')
    for (let i = 0; i < 5; i++) expect(fire(base, { pane: PANE_TERMS, transcript: t }).code).toBe(0)
    expect(termsCalls().length).toBe(1)
    expect(calls().length).toBe(1)
  }, T)

  test('a pane without the copy produces no terms notice', async () => {
    const base = await startStub()
    expect(fire(base, { pane: PANE_OTHER, transcript: transcript('привет') }).code).toBe(0)
    expect(termsCalls().length).toBe(0)
  }, T)

  test('the copy further up the pane, from an earlier failure, is not this one', async () => {
    const base = await startStub()
    expect(fire(base, { pane: PANE_EARLIER, transcript: transcript('ok, accepted, try again') }).code).toBe(0)
    expect(termsCalls().length).toBe(0)
  }, T)

  test('the payload alone (no pane) is enough, and an English owner gets English', async () => {
    const base = await startStub()
    const r = fire(base, {
      transcript: transcript('are you there?'),
      payload: { error_details: `400 ${TERMS_COPY}`, last_assistant_message: `API Error: 400 ${TERMS_COPY}` },
    })
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].text).toBe(TERMS_NOTICE.en)
  }, T)

  test("an agent's own words quoting the copy are not the failure", async () => {
    const base = await startStub()
    fire(base, {
      transcript: transcript('what did the customer see?'),
      payload: { error: 'server_error', last_assistant_message: `The customer saw: ${TERMS_COPY}` },
    })
    expect(termsCalls().length).toBe(0)
  }, T)

  test('a partner client (lite) gets the terms notice, not "try again in a minute"', async () => {
    const base = await startStub()
    fire(base, { pane: PANE_TERMS, transcript: transcript('Ау бля'), env: { TELEGRAM_PROFILE: 'lite' } })
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].text).toBe(TERMS_NOTICE.ru)
  }, T)
})

describe('DIVE-6678 terms matcher', () => {
  test('matches the copy only on the last API Error line of the pane', () => {
    expect(isTermsWall({}, PANE_TERMS)).toBe(true)
    expect(isTermsWall({}, PANE_OTHER)).toBe(false)
    expect(isTermsWall({}, PANE_EARLIER)).toBe(false)
    expect(isTermsWall({}, `I will explain: ${TERMS_COPY}`)).toBe(false)
  })
  test('language follows the letters', () => {
    expect(textLang('Ау бля')).toBe('ru')
    expect(textLang('hello')).toBe('en')
    expect(textLang('👍 1')).toBe(null)
  })
})
