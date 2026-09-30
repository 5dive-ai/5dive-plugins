// DIVE-5256: when the free AI that came with a my.5dive server runs out, each
// agent on it says so ONCE in its own chat, with a Connect button, and a second
// failed turn sends nothing. The decision and the claim (hooks/lib/demo-key.ts)
// are driven directly with a stubbed OpenRouter; the StopFailure hook is
// EXECUTED against a local Bot API stub (test/helpers/telegram-stub.ts) and
// what it transmitted is asserted; the server wiring is read as text, because
// importing the server long-polls Telegram.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  onDemoAccount, readDemoKey, isKeyLimitText, claimDemoNotice, releaseDemoNotice, rearmDemoNotice,
  pruneDemoStamps, keyFingerprint, demoNoticeText, demoNoticeButtons, demoNoticeMarkup, demoAccountUrl,
  DEMO_STRINGS, DEMO_DEFAULT_ACCOUNT_URL,
} from '../plugins/telegram/hooks/lib/demo-key'

const KEY = 'sk-or-v1-test-demo-key'
const DEMO_ENV = { AGENT_AUTH_PROFILE: 'demo-ai', ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: KEY } as NodeJS.ProcessEnv
// The measured OpenRouter refusal for a key past its limit (403, not 402).
const KEY_LIMIT = 'API Error: 403 {"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys","code":403}}'

type Seen = { url: string; auth: string | null }
function openrouter(data: Record<string, unknown> | null, status = 200) {
  const seen: Seen[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    return new Response(JSON.stringify({ data }), { status })
  }) as typeof fetch
  return { fn, seen }
}
const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch

describe('who the notice is for', () => {
  test('only the demo-ai account, by exact name', () => {
    expect(onDemoAccount({ AGENT_AUTH_PROFILE: 'demo-ai' })).toBe(true)
    for (const p of [undefined, '', 'openrouter', 'mark', 'demo-ai-2', 'Demo-AI']) {
      expect(onDemoAccount({ AGENT_AUTH_PROFILE: p })).toBe(false)
    }
  })
  test('any other agent reads not-demo and OpenRouter is never called', async () => {
    const or = openrouter({ limit: 1, limit_remaining: 0 })
    for (const p of ['openrouter', 'mark', '']) {
      expect((await readDemoKey({ sawKeyLimit: true }, { ...DEMO_ENV, AGENT_AUTH_PROFILE: p }, or.fn)).kind).toBe('not-demo')
    }
    expect(or.seen.length).toBe(0)
  })
})

describe('detecting "used up" from the key itself', () => {
  test('a spent one-time key is used up; the read goes to OpenRouter with the agent\'s own key', async () => {
    const or = openrouter({ limit: 1, limit_remaining: 0, limit_reset: null })
    expect(await readDemoKey({}, DEMO_ENV, or.fn)).toEqual({ kind: 'used-up', fingerprint: keyFingerprint(KEY) })
    expect(or.seen).toEqual([{ url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${KEY}` }])
  })
  test('a key with credit left is not, and re-arms only above the floor', async () => {
    expect(await readDemoKey({}, DEMO_ENV, openrouter({ limit: 1, limit_remaining: 0.62 }).fn))
      .toEqual({ kind: 'left', fingerprint: keyFingerprint(KEY), rearm: true })
    expect(await readDemoKey({}, DEMO_ENV, openrouter({ limit: 1, limit_remaining: 0.02 }).fn))
      .toEqual({ kind: 'left', fingerprint: keyFingerprint(KEY), rearm: false })
    expect((await readDemoKey({}, DEMO_ENV, openrouter({ limit: null }).fn)).kind).toBe('left')
  })
  test('a 403 in hand beats a few cents the key still shows', async () => {
    expect((await readDemoKey({ sawKeyLimit: true }, DEMO_ENV, openrouter({ limit: 1, limit_remaining: 0.02 }).fn)).kind).toBe('used-up')
    // …but not a real balance: that 403 was a big request, not an empty key.
    expect((await readDemoKey({ sawKeyLimit: true }, DEMO_ENV, openrouter({ limit: 1, limit_remaining: 0.5 }).fn)).kind).toBe('left')
  })
  test('an unreadable limit is unknown, unless the failure itself said Key limit exceeded', async () => {
    expect((await readDemoKey({}, DEMO_ENV, throwing)).kind).toBe('unknown')
    expect((await readDemoKey({}, DEMO_ENV, openrouter(null, 401).fn)).kind).toBe('unknown')
    expect((await readDemoKey({ sawKeyLimit: true }, DEMO_ENV, throwing)).kind).toBe('used-up')
    expect((await readDemoKey({ sawKeyLimit: true }, DEMO_ENV, openrouter(null, 403).fn)).kind).toBe('used-up')
  })
  test('the key is only ever sent to openrouter.ai', async () => {
    const or = openrouter({ limit: 1, limit_remaining: 0 })
    const r = await readDemoKey({ sawKeyLimit: true }, { ...DEMO_ENV, ANTHROPIC_BASE_URL: 'https://evil.example/api' }, or.fn)
    expect(r).toEqual({ kind: 'unknown', fingerprint: null })
    expect(or.seen.length).toBe(0)
  })
  test('Key limit exceeded is the per-key cap; a 402 account balance is not', () => {
    expect(isKeyLimitText(KEY_LIMIT)).toBe(true)
    expect(isKeyLimitText('API Error: 402 {"error":{"message":"Insufficient credits"}}')).toBe(false)
  })
  test('the fingerprint names a key without carrying it', () => {
    expect(keyFingerprint(KEY)).toMatch(/^[0-9a-f]{16}$/)
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(KEY + 'x'))
    expect(KEY).not.toContain(keyFingerprint(KEY))
  })
})

describe('once per key', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'demo-claim-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('the first claim sends, every later one does not', () => {
    expect(claimDemoNotice(dir, 'aaaa')).toBe(true)
    expect(claimDemoNotice(dir, 'aaaa')).toBe(false)
    expect(claimDemoNotice(dir, 'aaaa')).toBe(false)
  })
  test('a new key is news again; a replaced key leaves no stamp behind', () => {
    expect(claimDemoNotice(dir, 'aaaa')).toBe(true)
    expect(claimDemoNotice(dir, 'bbbb')).toBe(true)
    pruneDemoStamps(dir, 'bbbb')
    expect(readdirSync(dir)).toEqual(['demo-used-up.bbbb'])
  })
  test('a failed send gives the claim back; a top-up re-arms it', () => {
    expect(claimDemoNotice(dir, 'aaaa')).toBe(true)
    releaseDemoNotice(dir, 'aaaa')
    expect(claimDemoNotice(dir, 'aaaa')).toBe(true)
    rearmDemoNotice(dir, 'aaaa')
    expect(claimDemoNotice(dir, 'aaaa')).toBe(true)
  })
  test('the claim is atomic across processes (O_EXCL): of 8 racing claimers exactly one wins', () => {
    const lib = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'lib', 'demo-key.ts')
    const code = `import { claimDemoNotice } from ${JSON.stringify(lib)}; process.stdout.write(claimDemoNotice(${JSON.stringify(dir)}, 'race') ? 'W' : 'L')`
    const procs = Array.from({ length: 8 }, () => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }))
    expect(procs.map(p => p.stdout).join('').split('').filter(c => c === 'W').length).toBe(1)
  })
  test('an unwritable state dir claims nothing (one missed notice beats one per turn)', () => {
    writeFileSync(join(dir, 'file'), '')
    expect(claimDemoNotice(join(dir, 'file', 'sub'), 'aaaa')).toBe(false)
  })
})

describe('what the owner reads', () => {
  test('the row\'s words, in plain language, English and Russian', () => {
    expect(demoNoticeText('en')).toBe("I've used up the free AI that came with your server. Connect your own AI subscription to keep me talking and speaking.")
    expect(demoNoticeText('ru')).toBe('Бесплатный ИИ, который шёл вместе с вашим сервером, закончился. Подключите свою ИИ-подписку, и я снова смогу отвечать и говорить.')
  })
  test('nothing technical: no provider, model, key, token, cost, limit or error', () => {
    for (const lang of ['en', 'ru'] as const) {
      const all = Object.values(DEMO_STRINGS[lang]).join(' ')
      expect(all).not.toMatch(/openrouter|anthropic|claude|gemini|model|api|key|token|\$|dollar|cost|credit|limit|error|403|(?<![а-яё])ключ|токен|лимит|ошибк|модел/i)
    }
  })
  test('one Connect button to the account target; the list is where a second button goes', () => {
    const b = demoNoticeButtons('en', 'https://t.me/FiveDiveBot?startapp')
    expect(b).toEqual([{ text: 'Connect my AI', url: 'https://t.me/FiveDiveBot?startapp' }])
    expect(demoNoticeMarkup(b)).toEqual({ inline_keyboard: [[{ text: 'Connect my AI', url: 'https://t.me/FiveDiveBot?startapp' }]] })
    // A later "Top up with Stars" is one more entry, one more row, no rework.
    expect(demoNoticeMarkup([...b, { text: 'Top up', url: 'https://t.me/x' }])?.inline_keyboard.length).toBe(2)
    expect(demoNoticeMarkup(demoNoticeButtons('en', null))).toBeUndefined()
  })
  test('the account target is the box\'s own account URL, else the 5dive app', () => {
    const d = mkdtempSync(join(tmpdir(), 'demo-url-'))
    try {
      expect(demoAccountUrl({ TELEGRAM_STATE_DIR: d })).toBe(DEMO_DEFAULT_ACCOUNT_URL)
      writeFileSync(join(d, '.env'), 'TELEGRAM_ACCOUNT_URL=https://t.me/SomeAppBot?startapp\n')
      expect(demoAccountUrl({ TELEGRAM_STATE_DIR: d })).toBe('https://t.me/SomeAppBot?startapp')
      writeFileSync(join(d, '.env'), 'TELEGRAM_ACCOUNT_URL=javascript:alert(1)\n')
      expect(demoAccountUrl({ TELEGRAM_STATE_DIR: d })).toBe(DEMO_DEFAULT_ACCOUNT_URL)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

// ── the StopFailure hook, executed ───────────────────────────────────────────

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')
const OWNER = '555000111'
type Call = { chatId: string; text: string; markup?: string }

describe('StopFailure on the used-up demo key (hook executed against a Bot API stub)', () => {
  let home: string
  let stub: ReturnType<typeof spawn> | null = null
  let stubLog: string
  const T = 40000

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'demo-hook-')) })
  afterEach(() => { stub?.kill(); stub = null; rmSync(home, { recursive: true, force: true }) })

  async function startStub(): Promise<string> {
    stubLog = join(home, 'stub.jsonl')
    writeFileSync(stubLog, '')
    stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
      env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: 'ok' }, stdio: 'ignore',
    })
    for (let i = 0; i < 200; i++) {
      const first = readFileSync(stubLog, 'utf8').split('\n')[0]
      if (first) return `http://127.0.0.1:${(JSON.parse(first) as { port: number }).port}`
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('telegram stub never bound a port')
  }
  const calls = (): Call[] => readFileSync(stubLog, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter((c: { port?: number }) => c.port === undefined)
  const stateDir = () => join(home, '.claude', 'channels', 'telegram')

  function setup(): string {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [OWNER] }))
    const t = join(home, 'transcript.jsonl')
    writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="${OWNER}" message_id="7" user="owner">hi</channel>` } }) + '\n')
    return t
  }
  // The key is fake, so OpenRouter's read of it fails (401, or no network):
  // the hook stands on the 403 it was handed, as it must when the read fails.
  function fire(base: string, transcript: string, profile: string, message = KEY_LIMIT) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ message, transcript_path: transcript }),
      encoding: 'utf8',
      env: {
        ...process.env, HOME: home, TELEGRAM_STATE_DIR: stateDir(), TELEGRAM_BOT_TOKEN: '000:FAKE',
        TELEGRAM_API_BASE: base, TMUX: '', TELEGRAM_PROFILE: 'lite',
        AGENT_AUTH_PROFILE: profile, ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-fake-dive5256',
      },
      timeout: 20000,
    })
  }

  test('the first failed turn sends the notice with Connect; the second sends nothing', async () => {
    const base = await startStub()
    const t = setup()
    const first = fire(base, t, 'demo-ai')
    expect(first.status).toBe(0)
    let c = calls()
    expect(c.length).toBe(1)
    expect(c[0]!.chatId).toBe(OWNER)
    expect(c[0]!.text).toBe(DEMO_STRINGS.en.usedUp)
    expect(JSON.parse(c[0]!.markup!)).toEqual({ inline_keyboard: [[{ text: 'Connect my AI', url: DEMO_DEFAULT_ACCOUNT_URL }]] })
    expect(existsSync(join(stateDir(), `demo-used-up.${keyFingerprint('sk-or-v1-fake-dive5256')}`))).toBe(true)

    const second = fire(base, t, 'demo-ai')
    expect(second.status).toBe(0)
    expect(second.stderr).toContain('notice already sent for this key')
    c = calls()
    expect(c.length).toBe(1)
  }, T)

  test('a pre-existing claim (the server said it first) means the failed turn sends nothing', async () => {
    const base = await startStub()
    const t = setup()
    expect(claimDemoNotice(stateDir(), keyFingerprint('sk-or-v1-fake-dive5256'))).toBe(true)
    expect(fire(base, t, 'demo-ai').status).toBe(0)
    expect(calls().length).toBe(0)
  }, T)

  test('an agent NOT on the demo account keeps today\'s lite limit line, no demo notice, no stamp', async () => {
    const base = await startStub()
    const t = setup()
    expect(fire(base, t, 'openrouter').status).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0]!.text).not.toBe(DEMO_STRINGS.en.usedUp)
    expect(c[0]!.text).toMatch(/allowance/i)
    expect(readdirSync(stateDir()).filter(f => f.startsWith('demo-used-up.'))).toEqual([])
  }, T)

  test('a demo-account failure that is not the key limit takes the old path', async () => {
    const base = await startStub()
    const t = setup()
    // A 500 with the fake key unreadable → unknown → no demo notice.
    expect(fire(base, t, 'demo-ai', 'API Error: 500 Internal server error').status).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0]!.text).not.toBe(DEMO_STRINGS.en.usedUp)
    expect(readdirSync(stateDir()).filter(f => f.startsWith('demo-used-up.'))).toEqual([])
  }, T)
})

// ── the server wiring (read as text) ─────────────────────────────────────────

describe('server.ts wiring', () => {
  const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
  test('the timer is armed only for an agent on the demo account, and never in static or send-only mode', () => {
    expect(SERVER).toContain('if (!STATIC && !SEND_ONLY && onDemoAccount()) {')
  })
  test('each private inbound checks first, and the message still goes on to the model', () => {
    const i = SERVER.indexOf("if (!from.is_bot && ctx.chat?.type === 'private' && onDemoAccount()) void checkDemoKey(chat_id, liteLang(from.language_code))")
    expect(i).toBeGreaterThan(SERVER.indexOf('async function handleInbound('))
  })
  test('the server claims before it sends and gives the claim back if nothing reached the owner', () => {
    const body = SERVER.slice(SERVER.indexOf('async function checkDemoKey('), SERVER.indexOf('if (!STATIC && !SEND_ONLY && onDemoAccount())'))
    expect(body.indexOf('claimDemoNotice(')).toBeGreaterThan(-1)
    expect(body.indexOf('claimDemoNotice(')).toBeLessThan(body.indexOf('bot.api.sendMessage('))
    expect(body).toContain('if (!sentAny) releaseDemoNotice(STATE_DIR, demo.fingerprint)')
    expect(body).toContain('if (demo.rearm) rearmDemoNotice(STATE_DIR, demo.fingerprint)')
  })
})
