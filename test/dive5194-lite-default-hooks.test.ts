// DIVE-5194: a lite (partner-client) bot went quiet on a long request on a
// DeepSeek agent (397, 2026-09-29 06:40Z). DIVE-5166's fix was an instruction
// the model did not follow plus a lite-only watchdog arm, and lite had no ack
// reaction at all. lodar, 06:43Z: "we shouldn't customize our perfectly
// working hooks too much" — so lite gets the DEFAULT behaviour back and keeps
// only what the client sees different:
//
//   1. the ack reaction on every inbound (👀 unless the box names another);
//   2. the default silence watchdog, unchanged (it nudges the agent, never the
//      client) — no lite arm;
//   3. context-nudge, opt-in as before, in the client's words;
//   4. the typing indicator, which already repeats every 4s for the whole turn
//      under both profiles (pinned here so a later lite guard cannot drop it).
//
// server.ts long-polls Telegram on import, so it is read as TEXT; the hooks run
// as real processes, with fetch swapped for a recorder where they send.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ackReactionFor, LITE_STRINGS, liteLang } from '../plugins/telegram/hooks/lib/lite'

const TG = join(import.meta.dir, '..', 'plugins', 'telegram')
const SERVER = readFileSync(join(TG, 'server.ts'), 'utf8')

const tmps: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dive5194-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

describe('the ack reaction', () => {
  test('lite reacts 👀 when the box names no reaction; the box setting still wins, and "" still turns it off', () => {
    expect(ackReactionFor(undefined, true)).toBe('👀')
    expect(ackReactionFor('🔥', true)).toBe('🔥')
    expect(ackReactionFor('', true)).toBe('')
  })

  test('default profile: exactly the setting, as before (no reaction unless configured)', () => {
    expect(ackReactionFor(undefined, false)).toBeUndefined()
    expect(ackReactionFor('🔥', false)).toBe('🔥')
    expect(ackReactionFor('', false)).toBe('')
  })

  test('server.ts: the reaction branch is shared by both profiles and reads the helper', () => {
    expect(SERVER).not.toContain('!LITE && access.ackReaction')
    expect(SERVER).toContain('const ackReaction = ackReactionFor(access.ackReaction, LITE)\n  if (ackReaction && msgId != null) {')
    expect(SERVER).toContain("{ type: 'emoji', emoji: ackReaction as ReactionTypeEmoji['emoji'] },")
  })
})

describe('the typing indicator', () => {
  test('every inbound starts the repeating typing loop before any profile branch, every 4s', () => {
    const inbound = SERVER.indexOf('async function handleInbound(')
    const loop = SERVER.indexOf('  startTypingLoop(chat_id)\n', inbound)
    const firstLite = SERVER.indexOf('if (LITE)', inbound)
    expect(inbound).toBeGreaterThan(0)
    expect(loop).toBeGreaterThan(inbound)
    expect(loop).toBeLessThan(firstLite)
    expect(SERVER).toContain('const TYPING_INTERVAL_MS = 4_000')
  })
})

describe('silence-watchdog under lite is the default watchdog', () => {
  const run = (dir: string) =>
    spawnSync('bun', [join(TG, 'hooks', 'silence-watchdog.ts')], {
      input: JSON.stringify({ transcript_path: '/nonexistent' }),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TELEGRAM_STATE_DIR: dir },
      encoding: 'utf8',
      timeout: 20_000,
    })
  const box = (profile: 'lite' | 'default', silence: Record<string, number>) => {
    const d = tmp()
    writeFileSync(join(d, '.env'), `TELEGRAM_BOT_TOKEN=1:x\n${profile === 'lite' ? 'TELEGRAM_PROFILE=lite\n' : ''}`)
    writeFileSync(join(d, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }))
    writeFileSync(join(d, 'silence.json'), JSON.stringify(silence))
    return d
  }
  const nowS = () => Math.floor(Date.now() / 1000)

  test('a message unanswered past 60s nudges the agent with the same words as default', () => {
    const s = { lastInboundAt: nowS() - 90 }
    const lite = run(box('lite', s))
    const dflt = run(box('default', s))
    expect(lite.status).toBe(0)
    expect(dflt.status).toBe(0)
    expect(lite.stdout).toContain('The user alarms at >60s silence.')
    expect(lite.stdout).toContain('Send a fresh reply')
    // the two runs can straddle a second under load, so the elapsed count is
    // the one field allowed to differ
    const words = (o: string) => o.replace(/gone \d+s and/, 'gone Ns and')
    expect(words(lite.stdout)).toBe(words(dflt.stdout))
  })

  test('a message answered before the threshold gets no nudge (lite and default alike)', () => {
    for (const profile of ['lite', 'default'] as const) {
      // answered 5s after it arrived; the default cadence (an edit nudge 60s
      // after the last contact) is the same in both profiles and is not this arm
      const d = box(profile, { lastInboundAt: nowS() - 20, lastReplyAt: nowS() - 15, lastContactAt: nowS() - 15 })
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })

  test('still inside 60s: no nudge', () => {
    const r = run(box('lite', { lastInboundAt: nowS() - 10 }))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('the lite-only nudge (DIVE-5166) is gone', () => {
    expect(readFileSync(join(TG, 'hooks', 'lib', 'silence-decision.ts'), 'utf8')).not.toContain('decideLiteNudge')
  })
})

describe('context-nudge under lite', () => {
  // fetch is swapped for a recorder, so the hook's real send path runs and the
  // body it would post to Telegram is what the arm reads.
  const run = (profile: 'lite' | 'default', lang?: 'ru' | 'en') => {
    const home = tmp()
    const state = tmp()
    const out = join(tmp(), 'sent.json')
    const preload = join(tmp(), 'rec.ts')
    writeFileSync(preload, `globalThis.fetch = (async (_u: string, init: any) => { require('fs').writeFileSync(${JSON.stringify(out)}, String(init.body)); return new Response('{}', { status: 200 }) }) as any\n`)
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'statusline-last.json'), JSON.stringify({ session_id: `dive5194-${Math.random()}`, context_window: { used_percentage: 50 } }))
    writeFileSync(join(state, 'context-nudge.json'), JSON.stringify({ enabled: true }))
    writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['42'], groups: {}, pending: {} }))
    if (lang) writeFileSync(join(state, 'lite-lang'), lang)
    const r = spawnSync('bun', ['--preload', preload, join(TG, 'hooks', 'context-nudge.ts')], {
      input: JSON.stringify({ transcript_path: '/nonexistent', stop_hook_active: false }),
      env: {
        PATH: process.env.PATH ?? '', HOME: home, TELEGRAM_STATE_DIR: state, TELEGRAM_BOT_TOKEN: '1:x',
        ...(profile === 'lite' ? { TELEGRAM_PROFILE: 'lite' } : {}),
      },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(r.status).toBe(0)
    if (!existsSync(out)) return null
    const p = new URLSearchParams(readFileSync(out, 'utf8'))
    return { text: p.get('text'), buttons: JSON.parse(p.get('reply_markup')!).inline_keyboard.map((row: any) => row[0].text) }
  }

  test('turned on, a lite client gets the tier in their language, with no word about context and no clear-without-saving button (DIVE-5173)', () => {
    const ru = LITE_STRINGS.ru.carryover
    expect(run('lite', 'ru')).toEqual({ text: ru.tiers[0]!, buttons: [ru.remember, ru.notYet] })
    const en = LITE_STRINGS.en.carryover
    expect(run('lite', 'en')).toEqual({ text: en.tiers[0]!, buttons: [en.remember, en.notYet] })
  })

  test('control: the default profile sends the operator text it always did', () => {
    expect(run('default')).toEqual({
      text: "Context's at ~45% — good spot to carry over to a fresh session. Tap to save, or keep going.",
      buttons: ['Clear now', 'Remember & clear', 'Not yet'],
    })
  })

  // The ho: handlers are cut out of server.ts (which cannot be imported: it
  // long-polls) and RUN with stubs, so the arms read what a tap actually does.
  const hoSource = () => {
    const from = SERVER.indexOf("  const liteHo = LITE && data.startsWith('ho:')")
    const to = SERVER.indexOf('  // ho:restart → full agent restart', from)
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    return SERVER.slice(from, to)
  }
  const tap = async (src: string, data: string, lite: boolean, lang: 'ru' | 'en') => {
    const dir = tmp()
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      `export default async function (ctx: any, data: string, LITE: boolean, LITE_STRINGS: any, liteLang: any, proxyToClaudeTUI: any, newestCarryoverMtime: any, clearAfterCarryover: any) {\n${src}\n}`,
    )
    writeFileSync(join(dir, 'ho.mjs'), js)
    const handler = (await import(join(dir, 'ho.mjs'))).default
    const seen = { ran: [] as string[], toast: undefined as unknown, edit: undefined as unknown, stripped: false }
    const ctx = {
      from: { language_code: lang },
      answerCallbackQuery: async (o: { text?: unknown }) => { seen.toast = o.text },
      editMessageText: async (t: unknown) => { seen.edit = t },
      editMessageReplyMarkup: async () => { seen.stripped = true },
    }
    await handler(ctx, data, lite, LITE_STRINGS, liteLang, (cmd: string) => { seen.ran.push(cmd); return true }, () => 0, async () => {})
    return seen
  }

  test('every lite string an ho: arm reads is a non-empty string in both languages (catches a key a later PR deletes)', () => {
    const fields = [...hoSource().matchAll(/liteHo\??\.([A-Za-z_][\w.]*)/g)].map(m => m[1]!)
    expect(fields.length).toBeGreaterThan(0)
    for (const lang of ['ru', 'en'] as const) {
      for (const f of fields) {
        const v = f.split('.').reduce<any>((o, k) => o?.[k], LITE_STRINGS[lang])
        expect({ lang, f, ok: typeof v === 'string' && v.length > 0 }).toEqual({ lang, f, ok: true })
      }
    }
  })

  test('a lite ho:clear tap wipes nothing and reads "carrying on" in the client\'s language; ho:now and ho:skip read lite strings', async () => {
    const src = hoSource()
    for (const lang of ['ru', 'en'] as const) {
      const s = LITE_STRINGS[lang]
      expect(await tap(src, 'ho:clear', true, lang)).toEqual({ ran: [], toast: s.carryover.carryOn, edit: undefined, stripped: true })
      expect(await tap(src, 'ho:skip', true, lang)).toEqual({ ran: [], toast: s.carryover.carryOn, edit: undefined, stripped: true })
      expect(await tap(src, 'ho:now', true, lang)).toEqual({ ran: ['/telegram:carryover'], toast: s.carryover.saving, edit: s.carryover.saving, stripped: false })
    }
  })

  test('control: the default profile keeps its clear and its operator text', async () => {
    const src = hoSource()
    expect(await tap(src, 'ho:clear', false, 'ru')).toEqual({ ran: ['/clear'], toast: 'Clearing…', edit: 'Cleared the context now — nothing saved.', stripped: false })
    expect(await tap(src, 'ho:skip', false, 'en')).toEqual({ ran: [], toast: 'Okay, carrying on.', edit: undefined, stripped: true })
  })

  test('mutants: a lite read of a deleted key, or a lite clear that wipes, each red the arms above', async () => {
    // 1. the iteration-2 bug: the clear arm reads liteHo.newDone again.
    const readsNewDone = hoSource().replace(
      "if (data === 'ho:clear' && !liteHo) {\n    const dispatched = proxyToClaudeTUI('/clear')",
      "if (data === 'ho:clear') {\n    const dispatched = proxyToClaudeTUI('/clear')\n    if (liteHo) { await ctx.answerCallbackQuery({ text: liteHo.newDone }); return }",
    )
    expect(readsNewDone).not.toBe(hoSource())
    const fields = [...readsNewDone.matchAll(/liteHo\??\.([A-Za-z_][\w.]*)/g)].map(m => m[1]!)
    expect(fields.some(f => typeof f.split('.').reduce<any>((o, k) => o?.[k], LITE_STRINGS.ru) !== 'string')).toBe(true)
    expect((await tap(readsNewDone, 'ho:clear', true, 'en')).ran).toEqual(['/clear'])
    // 2. the guard dropped: a lite client can wipe the conversation again.
    const wipes = hoSource().replace("if (data === 'ho:clear' && !liteHo) {", "if (data === 'ho:clear') {")
    expect(wipes).not.toBe(hoSource())
    expect((await tap(wipes, 'ho:clear', true, 'ru')).ran).toEqual(['/clear'])
  })
})
