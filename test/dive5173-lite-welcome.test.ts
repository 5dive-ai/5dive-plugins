// DIVE-5173: three lite changes, one release (owner asks, OINOA, 2026-09-29).
//
//   1. /new and its hidden /clear alias are gone: a client cannot wipe the
//      conversation from the chat. They get the /help reply.
//   2. /stop is gone too: a client cannot interrupt a turn from the chat.
//   3. A bare /start is answered AT ONCE with the pack's welcome, no model turn.
//      The text is `ext.5dive.welcome.{en,ru}` in the agent's persona.yaml.
//      No welcome → the model greets, as before. A deep-link payload still goes
//      to the model after the welcome.
//
// The menu/route half lives in dive5121-lite-profile.test.ts (four commands).
// server.ts long-polls Telegram on import, so it is read as TEXT here.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liteWelcome, liteWelcomeFrom, liteStartPayload, personaFile, liteRoute, LITE_STRINGS } from '../plugins/telegram/hooks/lib/lite.ts'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

/** The body of liteCommand in server.ts, up to the next top-level statement. */
function liteCommandBody(src: string): string {
  const start = src.indexOf('async function liteCommand(')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end)
}

const PERSONA = `openagent: "0.2"
id: maya
name: "Maya"
role: "Executive Assistant"
behavior: "keeps your calendar"
ext:
  5dive:
    welcome:
      en: "Hi, I'm Maya. I keep your calendar and your commitments in one place. Try: what is on today?"
      ru: |
        Здравствуйте, я Майя.
        Спросите, например: что у меня сегодня?
`

const dirs: string[] = []
function box(persona?: string): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), 'dive5173-'))
  dirs.push(d)
  mkdirSync(join(d, 'claude'))
  if (persona !== undefined) writeFileSync(join(d, 'claude', 'persona.yaml'), persona)
  return { CLAUDE_CONFIG_DIR: join(d, 'claude'), TELEGRAM_STATE_DIR: join(d, 'state') }
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('the pack welcome (ext.5dive.welcome in persona.yaml)', () => {
  test('reads the client-language line from a real persona.yaml', () => {
    const env = box(PERSONA)
    expect(personaFile(env)).toBe(join(env.CLAUDE_CONFIG_DIR!, 'persona.yaml'))
    expect(liteWelcome('en', env)).toBe("Hi, I'm Maya. I keep your calendar and your commitments in one place. Try: what is on today?")
    expect(liteWelcome('ru', env)).toBe('Здравствуйте, я Майя.\nСпросите, например: что у меня сегодня?')
  })

  test('no welcome → null, so the model greets as before', () => {
    expect(liteWelcome('en', box())).toBeNull()                                   // no persona.yaml at all
    expect(liteWelcome('en', box('openagent: "0.2"\nid: maya\n'))).toBeNull()      // persona without the field
    expect(liteWelcome('en', box(PERSONA.replace(/      en: .*\n/, '')))).toBeNull() // only the other language
    expect(liteWelcome('ru', box(PERSONA.replace(/      en: .*\n/, '')))).not.toBeNull()
  })

  test('a broken persona.yaml is null plus an ops line, never a throw', () => {
    const env = box('ext: [unclosed\n  : :')
    expect(liteWelcome('en', env)).toBeNull()
    const ops = readFileSync(join(env.TELEGRAM_STATE_DIR!, 'ops-failures.jsonl'), 'utf8')
    expect(ops).toContain('"source":"/start"')
  })

  test('only a non-empty string under ext.5dive.welcome.<lang> counts', () => {
    expect(liteWelcomeFrom({ ext: { '5dive': { welcome: { en: '  Hi.  ' } } } }, 'en')).toBe('Hi.')
    for (const doc of [null, undefined, 'x', {}, { ext: null }, { ext: { '5dive': 'x' } },
      { ext: { deploy: { welcome: { en: 'Hi' } } } },             // another vendor's namespace
      { welcome: { en: 'Hi' } },                                   // top level: the schema is closed there
      { ext: { '5dive': { welcome: { en: '   ' } } } },
      { ext: { '5dive': { welcome: { en: 42 } } } }]) {
      expect(liteWelcomeFrom(doc, 'en')).toBeNull()
    }
  })

  test('the deep-link payload of a /start', () => {
    expect(liteStartPayload('/start')).toBe('')
    expect(liteStartPayload('/start@MayaBot')).toBe('')
    expect(liteStartPayload('/start ref_abc123')).toBe('ref_abc123')
    expect(liteStartPayload('/START@MayaBot  ref_abc123 ')).toBe('ref_abc123')
    expect(liteStartPayload(undefined)).toBe('')
  })
})

/** The /start arm: welcome sent, then a bare /start returns, then (payload or
 *  no welcome) the model. */
function startArmOk(body: string): boolean {
  const arm = body.slice(body.indexOf("if (cmd === 'start')"), body.indexOf("if (cmd === 'usage')"))
  const welcome = arm.indexOf('ctx.reply(welcome)')
  const bareReturn = arm.indexOf('if (!liteStartPayload(text)) return')
  const inbound = arm.indexOf('await handleInbound(ctx, text, undefined)')
  return welcome > -1 && bareReturn > welcome && inbound > bareReturn && arm.includes('msglogAppend(MSGLOG_DIR, chatId,')
}
/** Nothing in liteCommand resets or interrupts the pane. */
function resetArmGone(body: string): boolean {
  return !/cmd === 'new'|cmd === 'stop'|'\/clear', 'Enter'|'C-c'|newDone|stopDone/.test(body)
}

describe('server.ts liteCommand', () => {
  const body = liteCommandBody(SERVER)

  test('/start sends the welcome first, and a bare /start never reaches the model', () => {
    expect(startArmOk(body)).toBe(true)
  })

  test('the /new and /stop arm is gone: nothing sends /clear or C-c to the pane', () => {
    expect(resetArmGone(body)).toBe(true)
    for (const lang of ['ru', 'en'] as const) {
      expect(Object.keys(LITE_STRINGS[lang].menu)).toEqual(['start', 'usage', 'account', 'help'])
      expect('newDone' in LITE_STRINGS[lang] || 'stopDone' in LITE_STRINGS[lang]).toBe(false)
    }
    for (const t of ['/new', '/clear', '/stop']) expect(liteRoute(t)).toBe('help')
  })

  test('negative control: both checks go red on the mutants they exist to catch', () => {
    const sendsClear = body.replace("if (cmd === 'usage')", "if (cmd === 'new') {\n    await execFileP(TMUX, ['send-keys', '-t', 't:0', '/clear', 'Enter'])\n  }\n  if (cmd === 'usage')")
    const sendsCtrlC = body.replace("if (cmd === 'usage')", "if (cmd === 'x') await execFileP(TMUX, ['send-keys', '-t', 't:0', 'C-c'])\n  if (cmd === 'usage')")
    expect(resetArmGone(sendsClear)).toBe(false)
    expect(resetArmGone(sendsCtrlC)).toBe(false)
    const modelFirst = body.replace('if (!liteStartPayload(text)) return', '')          // bare /start → model turn
    const unlogged = body.replace('msglogAppend(MSGLOG_DIR, chatId,', 'void (0,')        // greeting not in recent_messages
    const noWelcome = body.replace('ctx.reply(welcome)', 'Promise.resolve(null)')         // welcome never sent
    for (const m of [modelFirst, unlogged, noWelcome]) expect(startArmOk(m)).toBe(false)
  })
})
