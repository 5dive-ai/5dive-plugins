// DIVE-6979: an agent whose AI account ran out of money went silent. Neither
// StopFailure hook had a class for an exhausted balance, so the OpenRouter 402s
// seen live on 2026-10-24 (DIVE-6833) fell through: the web chat only stopped
// showing "typing", and a partner client on Telegram was told "try again in a
// minute". These pin the class (one arm per live text, plus the negative
// controls), then drive both REAL hooks: the dashboard's against an isolated
// HOME, Telegram's against the local Bot API stub.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { classifyFailure, CREDIT_NOTICE } from '../plugins/telegram/hooks/lib/failure.ts'
import { noticeText } from '../plugins/dashboard/hooks/lib/dashboard-chat.ts'

const ROOT = join(import.meta.dir, '..', 'plugins')
const DASH_HOOK = join(ROOT, 'dashboard', 'hooks', 'stopfailure-notify.ts')
const TG_HOOK = join(ROOT, 'telegram', 'hooks', 'stopfailure-notify.ts')

// The two live texts (DIVE-6833, 2026-10-24).
const BALANCE_402 = 'API Error: 402 This request requires at least $0.50 in balance'
const INFLIGHT_402 =
  'API Error: 402 {"error":{"message":"This request would exceed your available credits given your current in-flight requests","code":402}}'
const USAGE_429 = { message: 'Claude usage limit reached', reason: 'usage_limit', stopReason: 'rate_limit' }

const classify = (payload: Record<string, unknown>, pane = '') => classifyFailure(payload, JSON.stringify(payload), pane)

describe('DIVE-6979 classifyFailure: an empty balance is its own kind', () => {
  test('the "$0.50 in balance" 402, in the payload', () => {
    const k = classify({ message: BALANCE_402 })
    expect(k.isOutOfCredit).toBe(true)
    expect(k.isRateLimit).toBe(false)
    expect(k.isTransientApiError).toBe(false)
  })

  test('the "$0.50 in balance" 402, only in the pane', () => {
    const k = classify({ message: 'turn failed' }, `> hi\n${BALANCE_402}\n`)
    expect(k.isOutOfCredit).toBe(true)
    expect(k.isTransientApiError).toBe(false)
  })

  test('the in-flight "available credits" 402, even when the payload also says rate_limit', () => {
    const k = classify({ message: INFLIGHT_402, stopReason: 'rate_limit' })
    expect(k.isOutOfCredit).toBe(true)
    expect(k.isRateLimit).toBe(false)
    expect(k.isTransientApiError).toBe(false)
  })

  test("Claude Code's billing_error", () => {
    expect(classify({ error: 'billing_error', message: 'turn failed' }).isOutOfCredit).toBe(true)
  })

  test('negative control: a 429 usage limit still takes the rate-limit path', () => {
    const k = classify(USAGE_429)
    expect(k.isRateLimit).toBe(true)
    expect(k.isOutOfCredit).toBe(false)
  })

  // quinn, iteration 1: words on screen are conversation, not the error.
  const PROSE = 'The client asked: OpenRouter says "insufficient credits", what do I do?'

  test('negative control: a usage limit in the payload stays one when the pane only TALKS about credits', () => {
    const payload = { error: 'rate_limit', message: "You've hit your usage limit · resets 5pm" }
    const k = classifyFailure(payload, JSON.stringify(payload), PROSE)
    expect(k.isRateLimit).toBe(true)
    expect(k.isOutOfCredit).toBe(false)
  })

  test('negative control: credit words in pane prose, or a quoted 402, are not a status line', () => {
    expect(classify({ message: 'turn failed' }, PROSE).isOutOfCredit).toBe(false)
    expect(classify({ message: 'turn failed' }, `> why did I get ${BALANCE_402}?`).isOutOfCredit).toBe(false)
  })

  test("the 402 as Claude Code draws it on the pane (\u23bf status line)", () => {
    expect(classify({ message: 'turn failed' }, `> hi\n  \u23bf  ${BALANCE_402}\n`).isOutOfCredit).toBe(true)
  })

  test('a pane-only 402 status line never overrides a usage limit the payload reports', () => {
    const k = classify(USAGE_429, `  \u23bf  ${BALANCE_402}\n`)
    expect(k.isRateLimit).toBe(true)
    expect(k.isOutOfCredit).toBe(false)
  })

  test('negative control: a 529 overload is still transient', () => {
    const k = classify({ message: 'turn failed' }, 'API Error: 529 Overloaded')
    expect(k.isTransientApiError).toBe(true)
    expect(k.isOutOfCredit).toBe(false)
  })

  test('the notice names no reset time and no raw error', () => {
    for (const who of ['client', 'owner'] as const) {
      for (const lang of ['en', 'ru'] as const) {
        const t = CREDIT_NOTICE[who][lang]
        expect(t).not.toMatch(/402|\$|limit|лимит|resets?|\d/i)
      }
    }
    expect(noticeText('credit', 1, 0, 'ru', true)).toBe(CREDIT_NOTICE.client.ru)
    expect(noticeText('credit', null, 0, 'en', false)).toBe(CREDIT_NOTICE.owner.en)
  })
})

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dive6979-')) })
afterEach(() => {
  stub?.kill()
  stub = null
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

// ---- the dashboard (web chat) hook ------------------------------------------

const dashInbound = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: `<channel source="plugin:dashboard:dashboard" chat_id="dashboard" user="owner" ts="2026-10-26T04:00:00Z">${text}</channel>` },
})

function transcript(entries: unknown[]): string {
  const p = join(home, 'transcript.jsonl')
  writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return p
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USER: 'agent-tap', TMUX: '', ...extra }
  for (const k of ['CLAUDE_CONFIG_DIR', 'DASHBOARD_STATE_DIR', 'TELEGRAM_STATE_DIR', 'TELEGRAM_PROFILE', 'ANTHROPIC_BASE_URL']) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

// A pane to drive, so an arm can prove NO resume helper starts.
function withTmux(env: Record<string, string>): Record<string, string> {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = display ] && echo "agent-tap:0.0"\nexit 0\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  const bun = join(home, 'fake-bun.sh')
  writeFileSync(bun, `#!/bin/sh\necho "$@" >> ${home}/helper.log\n`)
  chmodSync(bun, 0o755)
  return { ...env, TMUX: `${home}/sock,1,0`, PATH: `${bin}:${env.PATH}`, DASHBOARD_RESUME_BUN: bun }
}

function fireDash(payload: Record<string, unknown>, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [DASH_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

const outbox = () => join(home, '.claude', 'channels', 'dashboard', 'notice-outbox')
const notices = () =>
  (existsSync(outbox()) ? readdirSync(outbox()).filter(n => n.endsWith('.json')) : []).map(
    n => JSON.parse(readFileSync(join(outbox(), n), 'utf8')) as { chat_id: string; text: string },
  )
const helperLog = () => (existsSync(join(home, 'helper.log')) ? readFileSync(join(home, 'helper.log'), 'utf8') : '')

describe('DIVE-6979 dashboard hook', () => {
  const T = 30000

  test('a partner client gets ONE plain notice in their language, and no resume helper', () => {
    const env = withTmux(baseEnv({ TELEGRAM_PROFILE: 'lite' }))
    const tp = transcript([dashInbound('Привет, сделай отчёт')])
    const first = fireDash({ message: BALANCE_402, transcript_path: tp }, env)
    expect(first.code).toBe(0)
    expect(first.stderr).toContain('credit dedup: SEND')
    // Same episode, the agent re-fails: still one notice.
    fireDash({ message: INFLIGHT_402, transcript_path: tp }, env)
    const n = notices()
    expect(n.length).toBe(1)
    expect(n[0].text).toBe(CREDIT_NOTICE.client.ru)
    expect(helperLog()).toBe('')
    // The technical line goes to the box's ops log, not the chat.
    const ops = readFileSync(join(home, '.claude', 'channels', 'telegram', 'ops-failures.jsonl'), 'utf8')
    expect(ops).toContain('out of AI credit')
  }, T)

  test('an owner (default profile) is told it is theirs to top up', () => {
    fireDash({ message: BALANCE_402, transcript_path: transcript([dashInbound('write the report please')]) }, baseEnv())
    expect(notices().map(n => n.text)).toEqual([CREDIT_NOTICE.owner.en])
  }, T)

  test('negative control: a usage limit still gets the usage-limit notice', () => {
    fireDash({ ...USAGE_429, transcript_path: transcript([dashInbound('write the report please')]) }, baseEnv())
    const n = notices()
    expect(n.length).toBe(1)
    expect(n[0].text).toMatch(/usage limit/)
  }, T)
})

// ---- the Telegram hook --------------------------------------------------------

const DM = '1234567890'
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''

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

const sent = () =>
  readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { port?: number; chatId: string; text: string })
    .filter(c => c.port === undefined)

const tgState = () => join(home, '.claude', 'channels', 'telegram')

function tgSetup(lang?: 'ru'): void {
  mkdirSync(tgState(), { recursive: true })
  writeFileSync(join(tgState(), 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [DM] }))
  if (lang) writeFileSync(join(tgState(), 'lite-lang'), lang)
}

function tgTranscript(kind: 'caller' | 'autonomous'): string {
  const p = join(home, `tg-${kind}.jsonl`)
  const line =
    kind === 'caller'
      ? { type: 'user', message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="${DM}" message_id="1" user="c">Привет</channel>` } }
      : { type: 'user', message: { role: 'user', content: 'heartbeat: continue the queue' } }
  writeFileSync(p, JSON.stringify(line) + '\n')
  return p
}

function fireTg(payload: Record<string, unknown>, apiBase: string, extra: Record<string, string> = {}) {
  const env = baseEnv({ TELEGRAM_STATE_DIR: tgState(), TELEGRAM_BOT_TOKEN: '000:FAKE', TELEGRAM_API_BASE: apiBase, ...extra })
  const r = spawnSync(process.execPath, [TG_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

describe('DIVE-6979 telegram hook', () => {
  const T = 30000

  test('a partner client gets the plain credit line, once per episode, not "try again in a minute"', async () => {
    const base = await startStub()
    tgSetup('ru')
    const tp = tgTranscript('caller')
    expect(fireTg({ message: BALANCE_402, transcript_path: tp }, base, { TELEGRAM_PROFILE: 'lite' }).code).toBe(0)
    fireTg({ message: INFLIGHT_402, transcript_path: tp }, base, { TELEGRAM_PROFILE: 'lite' })
    const c = sent()
    expect(c.length).toBe(1)
    expect(c[0].chatId).toBe(DM)
    expect(c[0].text).toBe(CREDIT_NOTICE.client.ru)
  }, T)

  test('an owner on an autonomous turn is still told: nothing resumes until they top up', async () => {
    const base = await startStub()
    tgSetup()
    const r = fireTg({ message: BALANCE_402, transcript_path: tgTranscript('autonomous') }, base)
    expect(r.stderr).toContain('route=owners')
    const c = sent()
    expect(c.length).toBe(1)
    expect(c[0].text).toBe(CREDIT_NOTICE.owner.en)
  }, T)

  test('negative control: a usage limit on an autonomous turn stays silent (DIVE-6734)', async () => {
    const base = await startStub()
    tgSetup()
    const r = fireTg({ ...USAGE_429, transcript_path: tgTranscript('autonomous') }, base)
    expect(r.stderr).toContain('route=autonomous-silent')
    expect(sent().length).toBe(0)
  }, T)
})
