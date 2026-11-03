// DIVE-7657: the lite usage-limit line said a clock time, «продолжу в 03:10».
// lodar 2026-11-03: «продолжу через... будет лучше», then «в скобочках время».
// The line now says the time left from the moment of sending, with the clock
// time in brackets in the box's zone: «Лимит исчерпан, продолжу через 2 ч 50
// мин (в 03:10). Подробности в кабинете.» From a day on the bracket carries the
// weekday; under a minute there is no bracket. Rounded up, so the employee
// never promises to be back before the limit lifts. These pin the words, then
// drive the REAL Telegram hook against the local Bot API stub.

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
// The live example: 17:20Z, the 5h window resets at 20:10Z (03:10 on Wed 4 Nov in the box zone).
const NOW = new Date('2026-11-03T17:20:00Z')
const RESET = sec('2026-11-03T20:10:00Z')
const phrase = (lang: 'ru' | 'en', epoch: number, now = NOW) => liteResetPhrase(lang, epoch, now, ZONE)

describe('DIVE-7657 the limit line says how long, then the clock in brackets', () => {
  test('the two live lines, ru and en, resume and reset', () => {
    const at = (resumes: boolean) => ({ epoch: RESET, resumes, now: NOW, timeZone: ZONE })
    expect(liteLimitText('ru', OWN, at(true))).toBe('Лимит исчерпан, продолжу через 2 ч 50 мин (в 03:10). Подробности в кабинете.')
    expect(liteLimitText('ru', OWN, at(false))).toBe('Лимит исчерпан, обновится через 2 ч 50 мин (в 03:10). Подробности в кабинете.')
    expect(liteLimitText('en', OWN, at(true))).toBe("Limit reached, I'll continue in 2 h 50 min (at 03:10). Details in your account.")
    expect(liteLimitText('en', OWN, at(false))).toBe('Limit reached, resets in 2 h 50 min (at 03:10). Details in your account.')
  })

  test('under a minute: no bracket', () => {
    const now = new Date((RESET - 45) * 1000)
    expect(phrase('ru', RESET, now)).toBe('меньше чем через минуту')
    expect(phrase('en', RESET, now)).toBe('in under a minute')
    expect(liteLimitText('ru', OWN, { epoch: RESET, resumes: true, now, timeZone: ZONE })).toBe('Лимит исчерпан, продолжу меньше чем через минуту. Подробности в кабинете.')
  })

  test('minutes only', () => {
    const now = new Date((RESET - 40 * 60) * 1000)
    expect(phrase('ru', RESET, now)).toBe('через 40 мин (в 03:10)')
    expect(phrase('en', RESET, now)).toBe('in 40 min (at 03:10)')
  })

  test('hours with no minutes: «0 мин» is dropped', () => {
    const now = new Date((RESET - 3 * 3600) * 1000)
    expect(phrase('ru', RESET, now)).toBe('через 3 ч (в 03:10)')
    expect(phrase('en', RESET, now)).toBe('in 3 h (at 03:10)')
  })

  test('hours with minutes', () => {
    expect(phrase('ru', RESET)).toBe('через 2 ч 50 мин (в 03:10)')
    expect(phrase('en', RESET)).toBe('in 2 h 50 min (at 03:10)')
  })

  test('from a day on: days and hours, the weekday in the bracket', () => {
    // Wed 4 Nov 12:00Z = 19:00 Wed in the box zone; 2 d 5 h before it.
    const wed = sec('2026-11-04T12:00:00Z')
    const now = new Date((wed - (2 * 24 + 5) * 3600) * 1000)
    expect(phrase('ru', wed, now)).toBe('через 2 дн 5 ч (в ср 19:00)')
    expect(phrase('en', wed, now)).toBe('in 2 d 5 h (Wed 19:00)')
    // exactly a day: no «0 ч»
    expect(phrase('ru', wed, new Date((wed - 24 * 3600) * 1000))).toBe('через 1 дн (в ср 19:00)')
    // the weekday is the box zone's: 20:10Z Tue is already Wed in UTC+7
    expect(phrase('en', RESET, new Date((RESET - 30 * 3600) * 1000))).toBe('in 1 d 6 h (Wed 03:10)')
  })

  test('rounded up, never a promise to be back early', () => {
    // 2 h 49 min 1 s left → 2 h 50 min; a reset at :09:30 shows :10 in the bracket
    expect(phrase('ru', RESET, new Date((RESET - (2 * 3600 + 49 * 60 + 1)) * 1000))).toBe('через 2 ч 50 мин (в 03:10)')
    expect(phrase('en', RESET - 30, new Date((RESET - 30 - 40 * 60) * 1000))).toBe('in 40 min (at 03:10)')
    // 59 min 30 s → 1 h, not «60 мин»
    expect(phrase('ru', RESET, new Date((RESET - 3570) * 1000))).toBe('через 1 ч (в 03:10)')
    // 1 d 4 h 10 min → 1 d 5 h
    expect(phrase('en', RESET, new Date((RESET - (28 * 3600 + 600)) * 1000))).toBe('in 1 d 5 h (Wed 03:10)')
  })

  test('a reset already past or an unreadable zone: the line it always was', () => {
    expect(liteLimitText('ru', OWN, { epoch: RESET, resumes: true, now: new Date((RESET + 1) * 1000), timeZone: ZONE })).toBe('Лимит исчерпан. Подробности в кабинете.')
    expect(liteLimitText('en', OWN, { epoch: RESET, resumes: true, now: NOW, timeZone: 'Not/AZone' })).toBe('Your allowance is used up. Details are in your account.')
  })

  test('the weekly cap line is untouched', () => {
    const weekly: Allowance = { kind: 'capped', pctLeft: 0, reset: 'weekly', resetsAt: new Date('2026-11-09T00:00:00Z') }
    expect(liteLimitText('ru', weekly, { epoch: RESET, resumes: true, now: NOW, timeZone: ZONE })).toBe('Недельный лимит исчерпан, обновится в понедельник. Подробности в кабинете.')
  })

  test('the dashboard copy of lite.ts says the same', () => {
    expect(dashLite.liteLimitText('ru', OWN, { epoch: RESET, resumes: true, now: NOW, timeZone: ZONE })).toBe('Лимит исчерпан, продолжу через 2 ч 50 мин (в 03:10). Подробности в кабинете.')
  })
})

// ---- the real Telegram hook ---------------------------------------------------

const TG_HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')
const DM = '1234567890'
const ACCOUNT_URL = 'https://t.me/SomeCabinetBot?startapp'
let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dive7657-')) })
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
  writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="${DM}" message_id="1" user="c">сделай отчёт</channel>` } }) + '\n')
  return p
}

// A seat with a pane, so the box resumes the work itself («продолжу»).
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
  for (const k of ['CLAUDE_CONFIG_DIR', 'DASHBOARD_STATE_DIR', 'ANTHROPIC_BASE_URL']) delete env[k]
  const r = spawnSync(process.execPath, [TG_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

const LIMIT = { message: 'Claude usage limit reached', reason: 'usage_limit', stopReason: 'rate_limit' }
// The bracket's clock and weekday, as the box zone reads the reset (rounded up to its minute).
const clockOf = (epoch: number) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Math.ceil(epoch / 60) * 60000))
const dayOf = (lang: 'ru' | 'en', epoch: number) => {
  const i = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short' }).format(new Date(Math.ceil(epoch / 60) * 60000)))
  return (lang === 'ru' ? ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])[i]
}

// Each case: seconds until the reset (whole minutes, so the hook's few hundred
// ms of run time round back up to the same minute), and the words it must say.
const CASES: { name: string; secs: number; words: (lang: 'ru' | 'en', epoch: number) => string }[] = [
  { name: 'under a minute', secs: 30, words: l => l === 'ru' ? 'меньше чем через минуту' : 'in under a minute' },
  { name: 'minutes only', secs: 40 * 60, words: (l, e) => l === 'ru' ? `через 40 мин (в ${clockOf(e)})` : `in 40 min (at ${clockOf(e)})` },
  { name: 'hours, no minutes', secs: 3 * 3600, words: (l, e) => l === 'ru' ? `через 3 ч (в ${clockOf(e)})` : `in 3 h (at ${clockOf(e)})` },
  { name: 'hours and minutes', secs: 2 * 3600 + 50 * 60, words: (l, e) => l === 'ru' ? `через 2 ч 50 мин (в ${clockOf(e)})` : `in 2 h 50 min (at ${clockOf(e)})` },
  { name: 'over a day', secs: (2 * 24 + 5) * 3600, words: (l, e) => l === 'ru' ? `через 2 дн 5 ч (в ${dayOf(l, e)} ${clockOf(e)})` : `in 2 d 5 h (${dayOf(l, e)} ${clockOf(e)})` },
]

describe('DIVE-7657 telegram hook on a lite own-subscription box', () => {
  const T = 30000
  for (const lang of ['ru', 'en'] as const)
    for (const c of CASES)
      test(`${lang}: ${c.name}`, async () => {
        const base = await startStub()
        const epoch = Math.floor(Date.now() / 1000) + c.secs
        const r = fire({ ...LIMIT, resetsAt: epoch, transcript_path: setup(lang) }, base, seatEnv())
        expect(r.code).toBe(0)
        const out = sent()
        expect(out.length).toBe(1)
        expect(out[0].text).toBe(lang === 'ru'
          ? `Лимит исчерпан, продолжу ${c.words(lang, epoch)}. Подробности в кабинете.`
          : `Limit reached, I'll continue ${c.words(lang, epoch)}. Details in your account.`)
      }, T)
})
