// DIVE-5121: the telegram plugin's `lite` profile, for a partner's CLIENT.
//
// Two halves, and the first one is the point. lodar, on the row: "be careful not
// to break existing working product because we aggressively customizing it per
// partner". So:
//
//   1. NO PROFILE SET = TODAY. The profile resolves to 'default' for everything
//      but the literal `lite`; the default menu, /help, MCP instructions block and
//      hook registrations are pinned to the 0.5.64 release's bytes; every place the code
//      reads the profile is a guard of a known shape; and the one shared send
//      helper that grew a parameter posts the same body when it is not passed.
//   2. LITE = THE AGREED SURFACE (oinoa's list on the row): six localized
//      commands, org commands unreachable, consumer instructions, and no
//      client-visible string that names the platform or carries an emoji.
//
// server.ts long-polls Telegram on import, so it is read as TEXT here (the same
// way tests/telegram_instructions_unit.sh reads it); hooks/lib/lite.ts and the hooks' send
// helper are pure and imported.

import { describe, test, expect, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  resolveProfile,
  liteLang,
  liteRoute,
  liteMenu,
  liteHelpBody,
  liteAccountUrl,
  liteQuestionPrompt,
  readAllowance,
  liteUsageText,
  liteLimitText,
  nextReset,
  LITE_COMMANDS,
  LITE_STRINGS,
  LITE_INSTRUCTIONS,
  type Allowance,
  type Lang,
} from '../plugins/telegram/hooks/lib/lite'
import { COMMAND_REGISTRY, botFatherCommands, renderHelpBody } from '../plugins/telegram/commands'
import { sendMessage } from '../plugins/telegram/hooks/lib/telegram'

const ROOT = join(import.meta.dir, '..')
const TG = join(ROOT, 'plugins', 'telegram')
const SERVER = readFileSync(join(TG, 'server.ts'), 'utf8')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const tmps: string[] = []
function stateDir(envFile?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'dive5121-'))
  tmps.push(d)
  if (envFile !== undefined) writeFileSync(join(d, '.env'), envFile)
  return d
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('no profile set = the plugin as it is today', () => {
  test('the profile is default unless the value is exactly lite', () => {
    const none = stateDir()
    expect(resolveProfile({ TELEGRAM_STATE_DIR: none })).toBe('default')
    expect(resolveProfile({ TELEGRAM_STATE_DIR: stateDir('TELEGRAM_BOT_TOKEN=1:abc\n') })).toBe('default')
    for (const v of ['', 'default', 'full', 'light', 'lite2', 'li te', 'oinoa']) {
      expect(resolveProfile({ TELEGRAM_STATE_DIR: none, TELEGRAM_PROFILE: v })).toBe('default')
      expect(resolveProfile({ TELEGRAM_STATE_DIR: stateDir(`TELEGRAM_PROFILE=${v}\n`) })).toBe('default')
    }
    // and it is selectable both ways the box can set it
    expect(resolveProfile({ TELEGRAM_STATE_DIR: none, TELEGRAM_PROFILE: 'lite' })).toBe('lite')
    expect(resolveProfile({ TELEGRAM_STATE_DIR: stateDir('TELEGRAM_BOT_TOKEN=1:abc\nTELEGRAM_PROFILE=lite\n') })).toBe('lite')
    // the process env wins over the file, like server.ts's .env loader
    expect(resolveProfile({ TELEGRAM_STATE_DIR: stateDir('TELEGRAM_PROFILE=lite\n'), TELEGRAM_PROFILE: 'default' })).toBe('default')
  })

  test('the default menu and /help are the 0.5.66 ones (the 0.5.64 commands.ts less the /council entry)', () => {
    // sha of plugins/telegram/commands.ts in 0.5.66: the 0.5.64 release (243af25) with only
    // the /council registry entry deleted (DIVE-5164, lodar). Every other command is unchanged.
    expect(sha(readFileSync(join(TG, 'commands.ts'), 'utf8'))).toBe('37b3d0d6e5101ac5bb7512bf61bf7927cc104dd6dbc3f13af8a85db1b81ffd0a')
    expect(COMMAND_REGISTRY.map(c => c.name)).toEqual([
      'start', 'help', 'status', 'context', 'stop', 'restart', 'clear', 'checkpoint', 'resume', 'agents', 'team',
      'tasks', 'inbox', 'heartbeat', 'task', 'org', 'update', 'model', 'effort', 'account', 'login', 'usage',
      'goal', 'digest',
    ])
    expect(botFatherCommands(undefined, true)).toHaveLength(20)
    expect(botFatherCommands(undefined, true).map(c => c.command)).not.toContain('council')
    expect(renderHelpBody(COMMAND_REGISTRY, true)).not.toContain('/council')
  })

  test('the default MCP instructions block is byte-identical to the 0.5.64 release plus the DIVE-5171 tap line', () => {
    // Extracted exactly as tests/telegram_instructions_unit.sh extracts it.
    // DIVE-5171 (0.5.68) added one sentence on purpose — a via="button" inbound
    // is the user's real answer — so the pin moved with it. 0.5.64's block was
    // d04d20b5cacd135bd079e80b3222f0f118aebd941862bb228dbd2c96db16e9ac.
    const lines = SERVER.split('\n')
    const start = lines.indexOf('    instructions: [')
    const end = lines.findIndex((l, i) => i > start && /^    \]\.join/.test(l))
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const block = lines.slice(start + 1, end).join('\n') + '\n'
    expect(sha(block)).toBe('d9fcec695f9d1193ae09aaeb1fd42c13ba736b68ccb8f333340b71c5d57d322e')
    // The lite block is a LATER key that only exists when LITE is true.
    expect(lines[end]).toBe("    ].join('\\n'),")
    expect(lines.slice(end + 1, end + 5).join('\n')).toContain('...(LITE ? { instructions: LITE_INSTRUCTIONS } : {}),')
  })

  test('the hook registrations are byte-identical to the 0.5.64 release (all six hooks still wired)', () => {
    expect(sha(readFileSync(join(TG, 'hooks', 'hooks.json'), 'utf8'))).toBe('a1e2b5be3c402b822d9c6ac0b58dab97435bad0c2418f283a45f09075db9ea15')
  })

  test('every read of the profile in server.ts is a guard of a known shape', () => {
    // A ratchet: a new LITE use has to be added here, which puts it in front of
    // a reviewer with the question "is the default operand the old code?".
    const uses = SERVER.split('\n').filter(l => /\bLITE\b/.test(l) && !/^\s*\/\//.test(l))
    const shapes = [
      /^const LITE = resolveProfile\(\) === 'lite'$/,
      /^\s*if \(LITE\) (writeLiteLang|void \(async)/,
      /^\s*if \(LITE\) \{$/,
      /^\s*if \(!LITE && access\.ackReaction && msgId != null\) \{$/,
      /^\s*if \(!LITE\) void \(async \(\) => \{$/,
      /^if \(!STATIC && !SEND_ONLY && !LITE\) \{$/,
      /^\s*if \(LITE \|\| !yesNoChoice\(text\)\) return \{ stripped: text \}$/,
      /^\s*const (auto|edit)Footer = LITE \? '' : autoAttachFooter\((auto|edit)Plan\)$/,
      /^\s*const alertIdent = LITE \? null : gateAlertIdent\(/,
      /^\s*const gateReply = LITE \? null : parseGateReply\(text\)$/,
      /^\s*\.\.\.\(LITE \? \{ instructions: LITE_INSTRUCTIONS \} : \{\}\),$/,
    ]
    const odd = uses.filter(l => !shapes.some(re => re.test(l)))
    expect(odd).toEqual([])
    expect(uses).toHaveLength(13)
  })

  test('the lite front door is registered only under LITE, ahead of every other update handler', () => {
    // Code lines only: comments mention these calls too.
    const code = SERVER.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*\/\//.test(l))
    const at = (re: RegExp) => code.filter(({ l }) => re.test(l)).map(({ i }) => i)
    const [door] = at(/^\s*bot\.use\(/)
    expect(at(/^\s*bot\.use\(/)).toHaveLength(1)
    expect(code.find(({ i }) => i === door! - 1)?.l).toBe('if (LITE) {')
    const handlers = at(/^\s*bot\.(command|on|hears|callbackQuery)\(/)
    expect(handlers.length).toBeGreaterThanOrEqual(13)
    expect(Math.min(...handlers)).toBeGreaterThan(door!)
  })

  test('the hooks send helper posts the same body when no markup is passed', async () => {
    const dir = stateDir()
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    const env = { ...process.env }
    process.env.TELEGRAM_STATE_DIR = dir
    process.env.TELEGRAM_BOT_TOKEN = '1:test'
    process.env.TELEGRAM_API_BASE = 'http://stub.invalid'
    globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body))
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    try {
      expect(await sendMessage('42', 'hello', '7')).toBe(true)
      expect(await sendMessage('42', 'hello', '7', { inline_keyboard: [] })).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      process.env = env
    }
    expect(bodies[0]).toBe('chat_id=42&text=hello&message_thread_id=7')
    expect(bodies[1]).toBe('chat_id=42&text=hello&message_thread_id=7&reply_markup=%7B%22inline_keyboard%22%3A%5B%5D%7D')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Every bot-authored string a lite client can see, rendered.
const SAMPLE_ALLOWANCES: Allowance[] = [
  { kind: 'own' },
  { kind: 'uncapped' },
  { kind: 'unknown' },
  { kind: 'capped', pctLeft: 62, reset: 'weekly', resetsAt: new Date('2026-10-05T00:00:00Z') },
  { kind: 'capped', pctLeft: 5, reset: 'daily', resetsAt: new Date('2026-09-29T00:00:00Z') },
  { kind: 'capped', pctLeft: 40, reset: 'monthly', resetsAt: new Date('2026-10-01T00:00:00Z') },
  { kind: 'capped', pctLeft: 0, reset: null, resetsAt: null },
]
function clientVisible(lang: Lang): string[] {
  const s = LITE_STRINGS[lang]
  const out: string[] = [
    s.newDone, s.stopDone, s.failed, s.accountPrompt, s.accountButton, s.helpQuestions,
    ...Object.values(s.menu),
    liteHelpBody(lang, { account: true }),
    liteHelpBody(lang, { account: false }),
  ]
  for (const a of SAMPLE_ALLOWANCES) out.push(liteUsageText(lang, a), liteLimitText(lang, a))
  return out
}
const LEAK = /5dive|claude|anthropic|openrouter|\bmodel|token|context|server|\bbox\b|\bcost|\$|сервер|токен|модел|контекст/i
const EMOJI = /\p{Extended_Pictographic}/u
const leaks = (strings: string[]) => strings.filter(t => LEAK.test(t) || EMOJI.test(t))

describe('lite = the surface oinoa agreed', () => {
  test('the / menu is exactly the six commands, in both languages', () => {
    for (const lang of ['ru', 'en'] as const) {
      expect(liteMenu(lang, { account: true }).map(c => c.command)).toEqual(['start', 'new', 'stop', 'usage', 'account', 'help'])
      // no cabinet URL on the box → no button that goes nowhere
      expect(liteMenu(lang, { account: false }).map(c => c.command)).toEqual(['start', 'new', 'stop', 'usage', 'help'])
    }
    expect(liteMenu('ru', { account: true }).map(c => c.description)).toEqual(['Начать', 'Новый разговор', 'Остановить', 'Лимит', 'Мой кабинет', 'Помощь'])
    expect(liteMenu('en', { account: true }).map(c => c.description)).toEqual(['Start', 'New conversation', 'Stop', 'Allowance', 'My account', 'Help'])
  })

  test('every org command is unreachable: it routes to the /help reply', () => {
    const orgOnly = COMMAND_REGISTRY.map(c => c.name).filter(n => !(LITE_COMMANDS as readonly string[]).includes(n) && n !== 'clear')
    expect(orgOnly.length).toBe(18) // 19 until DIVE-5164 removed /council from the registry
    for (const n of orgOnly) expect(liteRoute(`/${n}`)).toBe('help')
    for (const n of ['task_12', 'nudges', 'whatever', 'login', 'status', 'council']) expect(liteRoute(`/${n}`)).toBe('help')
  })

  test('the six route to themselves; /clear is a hidden alias of /new; chat is not a command', () => {
    for (const c of LITE_COMMANDS) expect(liteRoute(`/${c}`)).toBe(c)
    expect(liteRoute('/start ref_abc123')).toBe('start')
    expect(liteRoute('/NEW@MayaBot')).toBe('new')
    expect(liteRoute('/clear')).toBe('new')
    expect(liteMenu('en', { account: true }).some(c => c.command === 'clear')).toBe(false)
    for (const t of ['hello', '', ' /new', 'what does /usage say?', undefined]) expect(liteRoute(t)).toBeNull()
  })

  test('no client-visible string names the platform or carries an emoji', () => {
    expect(leaks([...clientVisible('ru'), ...clientVisible('en')])).toEqual([])
  })

  test('negative control: the scan catches a planted leak and a planted emoji', () => {
    expect(leaks(['Работает на 5dive', 'Stopped ✅', 'your model is busy', 'Остановлено.'])).toEqual(['Работает на 5dive', 'Stopped ✅', 'your model is busy'])
  })

  test('/usage and the limit line read the way oinoa wrote them', () => {
    const weekly = SAMPLE_ALLOWANCES[3]!
    expect(liteUsageText('ru', weekly)).toBe('Осталось на неделе 62%, обновится в понедельник.')
    expect(liteUsageText('ru', { kind: 'own' })).toBe('Работает на вашей подписке.')
    expect(liteLimitText('ru', { ...weekly, pctLeft: 0 } as Allowance)).toBe('Недельный лимит исчерпан, обновится в понедельник. Подробности в кабинете.')
    expect(LITE_STRINGS.ru.failed).toBe('Не получилось, попробуйте ещё раз через минуту.')
    expect(liteUsageText('en', weekly)).toBe("62% of this week's allowance left, renews on Monday.")
  })

  test('/help is short: what the agent does, the commands, where questions go', () => {
    const body = liteHelpBody('ru', { about: 'Мария — ваш помощник по делам.', account: true })
    expect(body.split('\n\n')).toHaveLength(3)
    expect(body).toStartWith('Мария — ваш помощник по делам.')
    expect(body).toEndWith('Вопросы — в кабинете.')
    expect(liteHelpBody('en', { account: false })).not.toContain('/account')
  })

  test('the client language: Russian for ru*, English otherwise', () => {
    expect(liteLang('ru')).toBe('ru')
    expect(liteLang('ru-RU')).toBe('ru')
    for (const c of ['en', 'uk', 'de', '', undefined, null]) expect(liteLang(c)).toBe('en')
  })

  test('the account button is a URL button to https:// or tg:// only', () => {
    expect(liteAccountUrl('https://t.me/SomeCabinetBot?startapp')).toBe('https://t.me/SomeCabinetBot?startapp')
    expect(liteAccountUrl(' tg://resolve?domain=x ')).toBe('tg://resolve?domain=x')
    for (const bad of ['', undefined, 'javascript:alert(1)', 'http://x', 'https://a b']) expect(liteAccountUrl(bad)).toBeNull()
    expect(SERVER).toContain('new InlineKeyboard().url(s.accountButton, accountUrl)')
    expect(SERVER).not.toMatch(/webApp\(s\.accountButton/)
  })

  test('the lite instructions carry none of the operator rules, and keep the channel mechanics', () => {
    for (const operator of ['three kinds of message', 'roughly 60 words', 'COUNTED IN WORDS', 'half-findings', 'blocked on them'])
      expect(LITE_INSTRUCTIONS).not.toContain(operator)
    for (const needed of ['reply tool', 'download_attachment', 'recent_messages', 'image_path', 'chat_id', '/start', 'Never use emoji'])
      expect(LITE_INSTRUCTIONS).toContain(needed)
    // the one command the agent runs is the only place the brand may appear (DIVE-5168)
    expect(LITE_INSTRUCTIONS.replaceAll('`5dive partner hire <slug>`', '')).not.toMatch(/5dive/i)
  })

  test('DIVE-5168: lite instructions carry the hire-a-colleague rule; the default block does not', () => {
    expect(LITE_INSTRUCTIONS).toContain('run `5dive partner hire <slug>`')
    expect(LITE_INSTRUCTIONS).toContain('ask them to confirm. Only after a clear yes')
    expect(LITE_INSTRUCTIONS).toContain('Never hire without that yes, and never hire more than the one they confirmed.')
    expect(LITE_INSTRUCTIONS).toContain('is not available')
    const lines = SERVER.split('\n')
    const start = lines.indexOf('    instructions: [')
    const end = lines.findIndex((l, i) => i > start && /^    \]\.join/.test(l))
    const block = lines.slice(start + 1, end).join('\n')
    expect(block).not.toContain('partner hire')
    expect(block).not.toContain('colleague')
  })

  test('the question bridge drops its emoji lead in lite', () => {
    expect(liteQuestionPrompt('❓ Время\nКогда вам удобно?')).toBe('Время\nКогда вам удобно?')
    expect(liteQuestionPrompt('❓\nWhen suits you?')).toBe('When suits you?')
  })
})

describe('the allowance is read from the agent key itself', () => {
  const now = new Date('2026-09-28T10:00:00Z') // a Monday
  const OR = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-test' }
  const answer = (status: number, data: unknown) => (async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch

  test('not pointed at the partner key → the client runs on their own subscription', async () => {
    expect(await readAllowance({}, answer(200, {}), now)).toEqual({ kind: 'own' })
    expect(await readAllowance({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, answer(200, {}), now)).toEqual({ kind: 'own' })
    expect(await readAllowance({ ANTHROPIC_BASE_URL: 'https://openrouter.ai.evil.com' }, answer(200, {}), now)).toEqual({ kind: 'own' })
  })

  test('a weekly cap → % left and next Monday', async () => {
    let seen = ''
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = `${url} ${init.headers.authorization}`
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 6.2, limit_reset: 'weekly' } }), { status: 200 })
    }) as unknown as typeof fetch
    const a = await readAllowance(OR, f, now)
    expect(seen).toBe('https://openrouter.ai/api/v1/key Bearer sk-or-v1-test')
    expect(a).toEqual({ kind: 'capped', pctLeft: 62, reset: 'weekly', resetsAt: new Date('2026-10-05T00:00:00Z') })
  })

  test('uncapped, broken, refused, or no key → never a guess', async () => {
    expect(await readAllowance(OR, answer(200, { limit: null }), now)).toEqual({ kind: 'uncapped' })
    expect(await readAllowance(OR, answer(500, {}), now)).toEqual({ kind: 'unknown' })
    expect(await readAllowance(OR, answer(200, { limit: 0, limit_remaining: 0 }), now)).toEqual({ kind: 'unknown' })
    expect(await readAllowance(OR, (async () => { throw new Error('offline') }) as unknown as typeof fetch, now)).toEqual({ kind: 'unknown' })
    expect(await readAllowance({ ANTHROPIC_BASE_URL: OR.ANTHROPIC_BASE_URL }, answer(200, {}), now)).toEqual({ kind: 'unknown' })
  })

  test('the reset follows the same Monday 00:00 UTC rule as 5dive-api (DIVE-5111)', () => {
    expect(nextReset('weekly', new Date('2026-09-27T23:59:00Z')).toISOString()).toBe('2026-09-28T00:00:00.000Z') // Sunday
    expect(nextReset('weekly', new Date('2026-09-28T00:00:00Z')).toISOString()).toBe('2026-10-05T00:00:00.000Z') // Monday
    expect(nextReset('daily', now).toISOString()).toBe('2026-09-29T00:00:00.000Z')
    expect(nextReset('monthly', new Date('2026-12-15T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('the hooks under lite', () => {
  const run = (hook: string, env: Record<string, string>) =>
    spawnSync('bun', [join(TG, 'hooks', hook)], {
      input: JSON.stringify({ transcript_path: '/nonexistent', stop_hook_active: false }),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    })

  test('silence-watchdog is dropped: under lite it never touches its state; the default run (control) does', () => {
    // A paired owner is what makes the default hook bump silence.json on every
    // tool call, so the file is the discriminator. Without the control run the
    // lite arm would pass on a hook that simply had nothing to do.
    const paired = (envFile: string) => {
      const d = stateDir(envFile)
      writeFileSync(join(d, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }))
      return d
    }
    const control = paired('TELEGRAM_BOT_TOKEN=1:x\n')
    const rc = run('silence-watchdog.ts', { TELEGRAM_STATE_DIR: control })
    expect(rc.status).toBe(0)
    expect(existsSync(join(control, 'silence.json'))).toBe(true)
    const lite = paired('TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_PROFILE=lite\n')
    const rl = run('silence-watchdog.ts', { TELEGRAM_STATE_DIR: lite })
    expect(rl.status).toBe(0)
    expect(rl.stdout).toBe('')
    expect(existsSync(join(lite, 'silence.json'))).toBe(false)
  })

  test('context-nudge is dropped: the lite exit sits after the payload read and before any send', () => {
    // Its send is a hardcoded api.telegram.org call, so this arm reads the order.
    const src = readFileSync(join(TG, 'hooks', 'context-nudge.ts'), 'utf8')
    const read = src.indexOf('const payload = await readPayload<HookPayload>()')
    const exit = src.indexOf('if (isLite()) process.exit(0)')
    expect(read).toBeGreaterThan(0)
    expect(exit).toBeGreaterThan(read)
    expect(src.indexOf('await fetch(')).toBeGreaterThan(exit)
    const r = run('context-nudge.ts', { TELEGRAM_STATE_DIR: stateDir('TELEGRAM_PROFILE=lite\n') })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('the kept hooks read the profile and route their text through the lite strings', () => {
    const src = (f: string) => readFileSync(join(TG, 'hooks', f), 'utf8')
    expect(src('stopfailure-notify.ts')).toContain("text = limitHit ? liteLimitText(lang, await readAllowance()) : LITE_STRINGS[lang].failed")
    expect(src('stopfailure-notify.ts')).toContain("recordOpsDetail('stopfailure', text)")
    expect(src('stop-reply-check.ts')).toContain('LITE ? joined : `(auto-relay) ${joined}`')
    for (const f of ['resume-after-reset.ts', 'resume-after-error.ts']) expect(src(f)).toMatch(/if \(isLite\(\)\) \{\n\s+recordOpsDetail\(/)
  })
})
