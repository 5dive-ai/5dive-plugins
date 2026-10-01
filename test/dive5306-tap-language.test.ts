// DIVE-5306: the buttons the bridge writes under an agent's question, and the
// acks for a tap, follow the human's Telegram language (en + ru). OINOA is a
// Russian market and its owners were tapping English Yes/No buttons.
//
// Pins:
//   1. en is byte-identical to the literals server.ts printed before the table.
//   2. a ru user gets Russian labels and acks.
//   3. what a tap relays to the AGENT is the same English text for both.
//   4. server.ts reads every one of those labels from TAP_STRINGS, and records
//      the language on every profile, not only lite.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TAP_STRINGS, tapLang, liteLang } from '../plugins/telegram/hooks/lib/lite'
import { questionLabel, resolveQuestionTap } from '../plugins/telegram/hooks/lib/question-bridge'
import { tapContent, tapMeta } from '../plugins/telegram/buttontap'

const TG = join(import.meta.dir, '..', 'plugins', 'telegram')
const SERVER = readFileSync(join(TG, 'server.ts'), 'utf8')

describe('en is what the plugin printed before (byte-identical)', () => {
  const en = TAP_STRINGS.en
  test('yes/no keyboard and its acks', () => {
    expect([en.yes, en.no, en.yesAck, en.noAck]).toEqual(['✅ Yes', '❌ No', '👍 Yes', '👎 No'])
    expect(en.optionGone).toBe('That option is no longer available.')
  })
  test('permission prompt', () => {
    expect(en.permTitle('Bash')).toBe('🔐 Permission: Bash')
    expect([en.permMore, en.allow, en.deny, en.allowed, en.denied]).toEqual(['See more', '✅ Allow', '❌ Deny', '✅ Allowed', '❌ Denied'])
    expect(en.permGone).toBe('Details no longer available.')
  })
  test('question picker acks', () => {
    expect(en.sent('x')).toBe('Sent: x')
    expect(en.notRecorded).toBe("Couldn't record — reply in chat.")
    expect(en.alreadyAnswered).toBe('Already answered.')
    expect(en.optionInvalid).toBe('That option is no longer valid.')
    expect(en.expired).toBe('This prompt has expired.')
  })
})

describe('a Russian-speaking user', () => {
  const ru = TAP_STRINGS.ru
  test('gets Да / Нет on the yes/no keyboard and a Russian ack', () => {
    expect([ru.yes, ru.no]).toEqual(['✅ Да', '❌ Нет'])
    expect([ru.yesAck, ru.noAck]).toEqual(['👍 Да', '👎 Нет'])
  })
  test('gets Russian permission buttons, keeping the tool name as sent', () => {
    expect(ru.permTitle('Bash')).toBe('🔐 Нужно разрешение: Bash')
    expect([ru.allow, ru.deny]).toEqual(['✅ Разрешить', '❌ Запретить'])
  })
  test('every key is translated, none falls through to English', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(TAP_STRINGS.en).sort())
    for (const k of Object.keys(ru) as (keyof typeof ru)[]) {
      const r = ru[k], e = TAP_STRINGS.en[k]
      const rv = typeof r === 'function' ? (r as (s: string) => string)('X') : r
      const ev = typeof e === 'function' ? (e as (s: string) => string)('X') : e
      expect(rv).not.toBe(ev)
      expect(rv).toMatch(/[а-яё]/i)
    }
  })
})

describe('which language', () => {
  test('ru and any ru-* code is Russian; every other code is English', () => {
    for (const c of ['ru', 'RU', 'ru-RU', 'ru-ua']) expect(liteLang(c)).toBe('ru')
    for (const c of ['en', 'en-US', 'de', 'uk', 'be', '', 'xx']) expect(liteLang(c)).toBe('en')
  })
  test("a tap uses the tapper's own code, else what the chat last spoke", () => {
    expect(tapLang('ru', 'en')).toBe('ru')
    expect(tapLang('en', 'ru')).toBe('en')
    expect(tapLang(undefined, 'ru')).toBe('ru')
    expect(tapLang(null, 'en')).toBe('en')
    expect(tapLang('', 'ru')).toBe('ru')
  })
})

describe('what the agent reads is identical for both languages', () => {
  // The yes/no arm passes canonical=true, so the relayed button is the English
  // fallback label whatever the tapped button showed (pinned in the source below).
  const relayed = (value: 'yes' | 'no') => ({ value, button: value === 'yes' ? '✅ Yes' : '❌ No', answersMessageId: 479, callbackQueryId: 'cq' })
  test('the tap text and meta carry the English label', () => {
    expect(tapContent(relayed('yes'))).toBe('yes (tapped the ✅ Yes button under your message 479)')
    expect(tapContent(relayed('no'))).toBe('no (tapped the ❌ No button under your message 479)')
    expect(tapMeta(relayed('yes')).button).toBe('✅ Yes')
  })
  test('the yes/no arm relays canonically and only the ack is localized', () => {
    const ynArm = SERVER.slice(SERVER.indexOf('const ynM = /^yn:(yes|no)$/.exec(data)'), SERVER.indexOf('const optM = OPT_RE.exec(data)'))
    expect(ynArm).toContain("relayButtonTap(ctx, value, value === 'yes' ? '✅ Yes' : '❌ No', 'yes/no', true)")
    expect(ynArm).toContain('text: value === \'yes\' ? s.yesAck : s.noAck')
    const helper = SERVER.slice(SERVER.indexOf('function relayButtonTap('), SERVER.indexOf("\nbot.on('callback_query:data'"))
    expect(helper).toContain('canonical = false')
    expect(helper).toContain('button: (canonical ? undefined : pressed) ?? fallbackButton')
  })
  test('the question picker still hands the agent the English answer sentence', () => {
    const req = JSON.stringify({ labels: ['The user selected: "Да"', 'The user selected: "Нет"'], shown: ['Да', 'Нет'] })
    expect(resolveQuestionTap('q:1-2:0', req, false)).toEqual({ kind: 'answer', idx: 0, answer: 'The user selected: "Да"' })
    // ...and the human sees the option label.
    expect(questionLabel(req, 1)).toBe('Нет')
    expect(questionLabel(req, 5)).toBeNull()
    expect(questionLabel(JSON.stringify({ labels: ['x'] }), 0)).toBeNull() // a request from before `shown`
    expect(questionLabel(null, 0)).toBeNull()
  })
})

describe('server.ts wiring (read as text)', () => {
  test('no bridge label is hard-coded any more', () => {
    const code = SERVER.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    expect(code).not.toContain(".text('✅ Yes', 'yn:yes')")
    expect(code).not.toContain(".text('✅ Allow'")
    expect(code).not.toContain(".text('See more'")
    expect(code).not.toContain('`🔐 Permission: ${tool_name}`')
    expect(code).not.toContain("'👍 Yes'")
    expect(code).not.toContain("text: 'This prompt has expired.'")
  })
  test('the yes/no keyboard is built in the language of the chat it goes to', () => {
    expect(SERVER).toContain('yesNoButtons(text, langOfChat(chat_id))')
    expect(SERVER).toContain(".text(s.yes, 'yn:yes').text(s.no, 'yn:no')")
  })
  test('each permission DM is labelled in its own chat language', () => {
    const block = SERVER.slice(SERVER.indexOf("method: z.literal('notifications/claude/channel/permission_request')"), SERVER.indexOf('const FORMAT_DESC'))
    expect(block).toMatch(/for \(const chat_id of access\.allowFrom\) \{\n\s*\/\/[^\n]*\n\s*const s = TAP_STRINGS\[langOfChat\(chat_id\)\]/)
  })
  test('the language is recorded on every profile, and only from a real code', () => {
    expect(SERVER).toMatch(/^\s*noteChatLang\(chat_id, from\.language_code\)$/m)
    expect(SERVER).not.toMatch(/if \(LITE\) writeLiteLang/)
    const fn = SERVER.slice(SERVER.indexOf('function noteChatLang('), SERVER.indexOf('function langOfChat('))
    expect(fn).toContain('if (!code) return')
  })
  test('the question hook persists the shown labels beside the answers', () => {
    const hook = readFileSync(join(TG, 'hooks', 'pretool-question.ts'), 'utf8')
    expect(hook).toContain('labels: spec!.buttons.map(b => b.answer), shown: spec!.buttons.map(b => b.label)')
  })
})

// ── the lite profile's four new commands (same row, owner asks 2026-10-01) ────
import { LITE_COMMANDS, LITE_STRINGS, liteMenu, liteStatusText, liteDuration } from '../plugins/telegram/hooks/lib/lite'

function liteBody(src: string): string {
  const start = src.indexOf('async function liteCommand(')
  return src.slice(start, src.indexOf('\n}\n', start))
}
function arm(body: string, from: string, to: string): string {
  return body.slice(body.indexOf(from), body.indexOf(to, body.indexOf(from) + 1))
}
const BODY = liteBody(SERVER)
const STOP_CLEAR = arm(BODY, "if (cmd === 'stop' || cmd === 'clear')", "if (cmd === 'restart')")
const RESTART = arm(BODY, "if (cmd === 'restart')", "if (cmd === 'status')")
const STATUS = arm(BODY, "if (cmd === 'status')", '// A URL button')

describe('lite /stop /status /restart /clear', () => {
  test('the menu lists the eight commands in en and ru, and /new is not one', () => {
    expect([...LITE_COMMANDS]).toEqual(['start', 'usage', 'account', 'help', 'stop', 'status', 'restart', 'clear'])
    for (const lang of ['en', 'ru'] as const) expect(liteMenu(lang, { account: true })).toHaveLength(8)
  })
  test("/stop sends C-c and /clear sends /clear Enter, to the seat's own pane", () => {
    expect(STOP_CLEAR).toContain("const keys = cmd === 'stop' ? ['C-c'] : ['/clear', 'Enter']")
    expect(STOP_CLEAR).toContain("await execFileP(TMUX, ['send-keys', '-t', `${user}:0`, ...keys])")
    expect(STOP_CLEAR).toContain("if (!user.startsWith('agent-'))")
  })
  test('/restart calls exactly sudo -n 5dive agent _self_restart, after the reply', () => {
    expect(RESTART).toContain("execFileP(SUDO, ['-n', '5dive', 'agent', '_self_restart'], { timeout: 5000 })")
    expect(RESTART.indexOf('ctx.reply(s.restarting)')).toBeLessThan(RESTART.indexOf('_self_restart'))
    expect((RESTART.match(/execFileP\(/g) ?? []).length).toBe(1)
  })
  const noOrg = (a: string) => !/SUDO|sudo|digest|read5dive|execFileP/.test(a)
  test('/status reads only the seat\'s own session file: no sudo, no digest, no CLI', () => {
    expect(STATUS).toContain('liteStatusText(lang, findActiveSession(), Date.now())')
    expect(noOrg(STATUS)).toBe(true)
  })
  test('negative control: a /status that shells out to digest fails', () => {
    const mutant = STATUS.replace('findActiveSession()', "await read5diveJson(['digest', 'status', '--json'])")
    expect(noOrg(mutant)).toBe(false)
  })
  test('the full profile still has its own /status; lite never reaches it', () => {
    expect(BODY).not.toContain('digest')
  })
  test('/status is one plain line, working or idle, localized', () => {
    const now = 10 * 60_000
    expect(liteStatusText('en', { status: 'busy', updatedAt: now - 3 * 60_000 }, now)).toBe('Working on your request (3 min).')
    expect(liteStatusText('ru', { status: 'busy', updatedAt: now - 3 * 60_000 }, now)).toBe('Работаю над вашим запросом (3 мин).')
    expect(liteStatusText('en', { status: 'idle', updatedAt: now - 30_000 }, now)).toBe('Ready. Last active under a minute ago.')
    expect(liteStatusText('ru', { status: 'idle', updatedAt: now }, now)).toBe('Свободен. Последний ответ: меньше минуты назад.')
    expect(liteStatusText('en', null, now)).toBe('Not running right now. Try /restart.')
    expect(liteDuration('en', 125 * 60_000)).toBe('2 h 5 min')
    expect(liteDuration('ru', 120 * 60_000)).toBe('2 ч')
  })
  test('no lite reply names 5dive, tmux or a session (partner clients read them)', () => {
    const out: string[] = []
    for (const lang of ['en', 'ru'] as const) {
      const s = LITE_STRINGS[lang]
      out.push(s.stopped, s.restarting, s.cleared, s.failed, ...Object.values(s.menu))
      for (const st of [{ status: 'busy', updatedAt: 0 }, { status: 'idle', updatedAt: 0 }, null]) out.push(liteStatusText(lang, st, 4 * 3_600_000))
    }
    expect(out.filter(t => /5dive|tmux|session|сесси|pane|process|процесс/i.test(t))).toEqual([])
    // the lite command arms send no text of their own beyond the table
    for (const a of [STOP_CLEAR, RESTART, STATUS]) expect(a).not.toMatch(/reply\(`|reply\('|sendMessage\(chatId, `/)
  })
})

describe('full profile /status says cli, not 5dive (lodar: "dont show 5dive v0. just say cli v0")', () => {
  test('the version line is cli: v…', () => {
    expect(SERVER).toContain('lines.push(`cli: v${fiveDiveVersion}`)')
    expect(SERVER).not.toContain('lines.push(`5dive: v${fiveDiveVersion}`)')
  })
})
