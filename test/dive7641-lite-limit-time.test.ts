// DIVE-7641: a partner client whose agent runs on their own subscription hit a
// usage limit and was told only «Лимит исчерпан. Подробности в кабинете.»,
// although the hook already knew when the limit lifts (lodar 2026-11-03: «а
// сотрудник не пишет что лимит пришел - продолжу через 3 часа»). The line now
// says when, as a clock time in the box's zone, with the day when it is not
// today; «продолжу» only when the box resumes the work itself. These pin the
// words, then drive the REAL Telegram hook against the local Bot API stub.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { liteLimitText, liteResetPhrase, type Allowance } from '../plugins/telegram/hooks/lib/lite.ts'
import * as dashLite from '../plugins/dashboard/hooks/lib/lite.ts'

const ZONE = 'Etc/GMT-7' // the live client's offset, UTC+7 (no DST)
const OWN: Allowance = { kind: 'own' }
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
// The live example: 17:13Z read, the 5h window resets at 20:10Z (03:10 in the box zone).
const NOW = new Date('2026-11-03T17:13:00Z')

describe('DIVE-7641 the limit line says when', () => {
  const at = (epoch: number, resumes: boolean, now = NOW) => ({ epoch, resumes, now, timeZone: ZONE })

  test('ru and en, with the box resuming the work itself', () => {
    expect(liteLimitText('ru', OWN, at(sec('2026-11-03T20:10:00Z'), true))).toBe('Лимит исчерпан, продолжу в 03:10. Подробности в кабинете.')
    expect(liteLimitText('en', OWN, at(sec('2026-11-03T20:10:00Z'), true))).toBe("Limit reached, I'll continue at 03:10. Details in your account.")
  })

  test('ru and en, with no pane to resume: when it resets, not a promise', () => {
    expect(liteLimitText('ru', OWN, at(sec('2026-11-03T20:10:00Z'), false))).toBe('Лимит исчерпан, обновится в 03:10. Подробности в кабинете.')
    expect(liteLimitText('en', OWN, at(sec('2026-11-03T20:10:00Z'), false))).toBe('Limit reached, resets at 03:10. Details in your account.')
  })

  test('the day is added when it is not today, in the box zone', () => {
    const evening = new Date('2026-11-03T10:00:00Z') // 17:00 on Tue 3 Nov in the box zone
    expect(liteResetPhrase('ru', sec('2026-11-03T20:10:00Z'), evening, ZONE)).toBe('завтра в 03:10')
    expect(liteResetPhrase('en', sec('2026-11-03T20:10:00Z'), evening, ZONE)).toBe('tomorrow at 03:10')
    expect(liteResetPhrase('ru', sec('2026-11-06T05:00:00Z'), evening, ZONE)).toBe('в пятницу в 12:00')
    expect(liteResetPhrase('en', sec('2026-11-06T05:00:00Z'), evening, ZONE)).toBe('on Friday at 12:00')
    expect(liteResetPhrase('ru', sec('2026-11-12T05:00:00Z'), evening, ZONE)).toBe('12 ноября в 12:00')
    expect(liteResetPhrase('en', sec('2026-11-12T05:00:00Z'), evening, ZONE)).toBe('on November 12 at 12:00')
    // The live 7d window: 12:00Z on 4 Nov is 19:00 the same box-zone day as 00:13.
    expect(liteResetPhrase('ru', sec('2026-11-04T12:00:00Z'), NOW, ZONE)).toBe('в 19:00')
    // Same instant, a UTC box: still 3 Nov there, so it is tomorrow.
    expect(liteResetPhrase('en', sec('2026-11-04T12:00:00Z'), NOW, 'UTC')).toBe('tomorrow at 12:00')
  })

  test('no reset, a reset already past, or an unreadable zone: the line it always was', () => {
    expect(liteLimitText('ru', OWN)).toBe('Лимит исчерпан. Подробности в кабинете.')
    expect(liteLimitText('en', OWN)).toBe('Your allowance is used up. Details are in your account.')
    expect(liteLimitText('ru', OWN, { epoch: null, resumes: true })).toBe('Лимит исчерпан. Подробности в кабинете.')
    expect(liteLimitText('ru', OWN, at(sec('2026-11-03T17:00:00Z'), true))).toBe('Лимит исчерпан. Подробности в кабинете.')
    expect(liteLimitText('ru', OWN, { epoch: sec('2026-11-03T20:10:00Z'), resumes: true, now: NOW, timeZone: 'Not/AZone' })).toBe('Лимит исчерпан. Подробности в кабинете.')
  })

  test('the weekly cap keeps its day line', () => {
    const weekly: Allowance = { kind: 'capped', pctLeft: 0, reset: 'weekly', resetsAt: new Date('2026-11-09T00:00:00Z') }
    expect(liteLimitText('ru', weekly, at(sec('2026-11-03T20:10:00Z'), true))).toBe('Недельный лимит исчерпан, обновится в понедельник. Подробности в кабинете.')
  })

  test('never names the provider or the model, no emoji', () => {
    const LEAK = /5dive|claude|anthropic|openrouter|\bmodel|token|context|server|сервер|токен|модел|контекст|\p{Extended_Pictographic}/iu
    for (const lang of ['ru', 'en'] as const)
      for (const resumes of [true, false])
        expect(liteLimitText(lang, OWN, at(sec('2026-11-03T20:10:00Z'), resumes))).not.toMatch(LEAK)
  })

  test('the dashboard copy of lite.ts says the same', () => {
    expect(dashLite.liteLimitText('ru', OWN, at(sec('2026-11-03T20:10:00Z'), true))).toBe('Лимит исчерпан, продолжу в 03:10. Подробности в кабинете.')
  })
})

// ---- the real Telegram hook ---------------------------------------------------

const TG_HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')
const DM = '1234567890'
const ACCOUNT_URL = 'https://t.me/SomeCabinetBot?startapp'
let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dive7641-')) })
afterEach(() => {
  stub?.kill()
  stub = null
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

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
  readFileSync(stubLog, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as { port?: number; chatId: string; text: string; markup?: string })
    .filter(c => c.port === undefined)

const tgState = () => join(home, '.claude', 'channels', 'telegram')

function setup(lang: 'ru' | 'en'): string {
  mkdirSync(tgState(), { recursive: true })
  writeFileSync(join(tgState(), 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [DM] }))
  writeFileSync(join(tgState(), 'lite-lang'), lang)
  const p = join(home, 'tg.jsonl')
  writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="${DM}" message_id="1" user="c">когда обновится лимит?</channel>` } }) + '\n')
  return p
}

// A seat with a pane: tmux answers `display`, the account CLIs say nothing (no
// rotation, no headroom read), and `bun` is a stand-in so no real helper runs.
function seatEnv(): Record<string, string> {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  put('tmux', 'case "$*" in *display*) echo "agent-maya:0.0";; esac; exit 0')
  put('5dive', `echo '{"ok":false}'`)
  put('sudo', `echo '{"ok":false}'`)
  put('bun', `echo "$@" >> ${home}/helper.log`)
  return { TMUX: `${home}/sock,1,0`, PATH: `${bin}:${process.env.PATH}` }
}

function fire(payload: Record<string, unknown>, apiBase: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home, TMPDIR: home, USER: 'agent-maya', TMUX: '', TZ: ZONE,
    TELEGRAM_STATE_DIR: tgState(), TELEGRAM_BOT_TOKEN: '000:FAKE', TELEGRAM_API_BASE: apiBase,
    TELEGRAM_PROFILE: 'lite', TELEGRAM_ACCOUNT_URL: ACCOUNT_URL, AGENT_AUTH_PROFILE: '',
    ...extra,
  }
  // The box runs on the client's own subscription: no OpenRouter base URL.
  for (const k of ['CLAUDE_CONFIG_DIR', 'DASHBOARD_STATE_DIR', 'ANTHROPIC_BASE_URL']) delete env[k]
  const r = spawnSync(process.execPath, [TG_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

const LIMIT = { message: 'Claude usage limit reached', reason: 'usage_limit', stopReason: 'rate_limit' }
const inThreeHours = () => Math.floor(Date.now() / 1000) + 3 * 3600 + 120
const expected = (lang: 'ru' | 'en', epoch: number, resumes: boolean) => liteLimitText(lang, OWN, { epoch, resumes, timeZone: ZONE })
const button = (markup?: string) => (JSON.parse(markup ?? '{}') as { inline_keyboard?: { text: string; url: string }[][] }).inline_keyboard?.[0]?.[0]

describe('DIVE-7641 telegram hook on a lite own-subscription box', () => {
  const T = 30000

  for (const lang of ['ru', 'en'] as const) {
    test(`${lang}: a pane to resume → "I'll continue at HH:MM", with the account button`, async () => {
      const base = await startStub()
      const epoch = inThreeHours()
      const r = fire({ ...LIMIT, resetsAt: epoch, transcript_path: setup(lang) }, base, seatEnv())
      expect(r.code).toBe(0)
      const c = sent()
      expect(c.length).toBe(1)
      expect(c[0].text).toBe(expected(lang, epoch, true))
      expect(c[0].text).toMatch(lang === 'ru' ? /^Лимит исчерпан, продолжу (завтра )?в \d\d:\d\d\. Подробности в кабинете\.$/ : /^Limit reached, I'll continue (tomorrow )?at \d\d:\d\d\. Details in your account\.$/)
      expect(button(c[0].markup)).toEqual({ text: lang === 'ru' ? 'Открыть кабинет' : 'Open my account', url: ACCOUNT_URL })
    }, T)

    test(`${lang}: no pane → "resets at HH:MM", never a promise to continue`, async () => {
      const base = await startStub()
      const epoch = inThreeHours()
      fire({ ...LIMIT, resetsAt: epoch, transcript_path: setup(lang) }, base)
      const c = sent()
      expect(c.length).toBe(1)
      expect(c[0].text).toBe(expected(lang, epoch, false))
      expect(c[0].text).toMatch(lang === 'ru' ? /^Лимит исчерпан, обновится (завтра )?в \d\d:\d\d\./ : /^Limit reached, resets (tomorrow )?at \d\d:\d\d\./)
      expect(button(c[0].markup)?.url).toBe(ACCOUNT_URL)
    }, T)

    test(`${lang}: no reset time known → the unchanged line`, async () => {
      const base = await startStub()
      fire({ ...LIMIT, transcript_path: setup(lang) }, base)
      const c = sent()
      expect(c.length).toBe(1)
      expect(c[0].text).toBe(lang === 'ru' ? 'Лимит исчерпан. Подробности в кабинете.' : 'Your allowance is used up. Details are in your account.')
      expect(button(c[0].markup)?.url).toBe(ACCOUNT_URL)
    }, T)
  }
})
