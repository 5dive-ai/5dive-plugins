// DIVE-8012: on a partner client's box (TELEGRAM_PROFILE=lite) the org-policy
// notice (DIVE-5993) goes straight to the partner's client, who knows no 5dive.
// It names the partner's cabinet, never 5dive, except inside the settings JSON
// (the org's list must name marketplace 5dive-plugins). The default profile's
// text is byte-identical to before.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { orgPolicyText, ORG_POLICY_JSON } from '../plugins/telegram/orgpolicy'
import { isLite } from '../plugins/telegram/hooks/lib/lite'

const sha = (v: string) => createHash('sha256').update(v).digest('hex')
const JSON_BLOCK = /<pre><code class="language-json">[\s\S]*?<\/code><\/pre>/
const json = (t: string) => t.match(/<pre><code class="language-json">([\s\S]*?)<\/code><\/pre>/)![1]!
const outsideJson = (t: string) => t.replace(JSON_BLOCK, '')

// The two ways a box selects lite: the process env, and the channel's own .env.
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dive8012-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const envLite = (): NodeJS.ProcessEnv => ({ TELEGRAM_PROFILE: 'lite', TELEGRAM_STATE_DIR: join(dir, 'none') })
const fileLite = (): NodeJS.ProcessEnv => {
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_PROFILE=lite\n')
  return { TELEGRAM_STATE_DIR: dir }
}

describe('lite: no 5dive outside the settings JSON', () => {
  for (const [how, env] of [['env', envLite], ['channel .env', fileLite]] as const) {
    for (const lang of ['ru', 'en'] as const) {
      for (const name of ['Майя', 'Maya', '', '   ']) {
        test(`${how}, ${lang}, name ${JSON.stringify(name)}`, () => {
          const e = env()
          expect(isLite(e)).toBe(true)
          const t = orgPolicyText(name, lang, isLite(e))
          expect(outsideJson(t)).not.toMatch(/5dive/i)
          expect(t).not.toContain('Switch account')
          // The steps an admin follows are all still there, /restart included.
          expect(t).toContain('/restart')
          expect(t).toContain(lang === 'ru' ? '«Managed settings»' : 'Managed settings')
          expect(t).not.toContain('http')
        })
      }
    }
  }
  test('the way out names the cabinet', () => {
    expect(orgPolicyText('Майя', 'ru', true)).toContain(
      'Не получается изменить настройку компании? Тогда переключите агента «Майя» на личный аккаунт Claude (Pro или Max), где чат с агентами включён по умолчанию. Это делается в кабинете, в настройках агента «Майя».',
    )
    expect(orgPolicyText('Maya', 'en', true)).toContain(
      "Can't change the company setting? Switch Maya to a personal Claude account (Pro or Max) instead, where agent chat is on by default. You do that from your account page, in Maya's settings.",
    )
    expect(orgPolicyText('', 'ru', true)).toEndWith('Это делается в кабинете, в настройках агента.')
    expect(orgPolicyText('  ', 'en', true)).toEndWith("You do that from your account page, in the agent's settings.")
  })
})

describe('lite: the settings JSON is the same, 5dive-plugins kept', () => {
  test('ru and en carry the exact default JSON', () => {
    for (const lang of ['ru', 'en'] as const) {
      const t = orgPolicyText('Maya', lang, true)
      expect(json(t)).toBe(json(orgPolicyText('Maya', lang)))
      const list = JSON.parse(json(t)).allowedChannelPlugins
      expect(list).toContainEqual({ plugin: 'telegram', marketplace: '5dive-plugins' })
      expect(list).toContainEqual({ plugin: 'dashboard', marketplace: '5dive-plugins' })
    }
    expect(ORG_POLICY_JSON).toContain('"marketplace": "5dive-plugins"')
  })
})

describe('lite: the name stays escaped', () => {
  test('HTML in the name is escaped everywhere it appears', () => {
    const ru = orgPolicyText('Галина <b>&', 'ru', true)
    expect(ru).toContain('Агент «Галина &lt;b&gt;&amp;» пока не слышит')
    expect(ru).toContain('в настройках агента «Галина &lt;b&gt;&amp;».')
    const en = orgPolicyText('Ceo <b>', 'en', true)
    expect(en).toContain("Ceo &lt;b&gt; can't hear your messages yet")
    expect(en).toContain("in Ceo &lt;b&gt;'s settings.")
    expect(outsideJson(ru)).not.toContain('<b>')
    expect(outsideJson(en)).not.toContain('<b>')
  })
})

describe('default profile: byte-identical to before DIVE-8012', () => {
  // sha256 of origin/main cfa582c's orgPolicyText output for each case.
  const before: Record<string, string> = {
    'ru|Maya': '793b09755fec62c53afcba070b29e5555a311b2aa11c979a86ec3f862d06e32a',
    'ru|': 'e077c07235925ae75677db5ece527cdac7d9446a463b1762df420b7965529101',
    'ru|Ceo <b>': 'fb41dcd83d968e78ee0331af68c7aa87f83b66bcc17928d392c7021358a81074',
    'en|Maya': 'f93ab1d528c5b52e95584e1e20b9c6f514ce5d2583bd39971530164a6d74a39a',
    'en|': '85231789ee8e374690bf0728f05f881703b1ca6be368ec30bd644725fa0e5979',
    'en|Ceo <b>': '27e5734c5beab62fdcdece72d22209fff1d155295f809cd9900a19187892fec7',
  }
  test('ru and en, named, unnamed and HTML: the shas hold, with lite=false and with no third argument', () => {
    for (const [k, h] of Object.entries(before)) {
      const [lang, name] = k.split('|') as ['ru' | 'en', string]
      expect(sha(orgPolicyText(name, lang))).toBe(h)
      expect(sha(orgPolicyText(name, lang, false))).toBe(h)
    }
  })
  test('ru and en, named and unnamed: the default still names the 5dive dashboard', () => {
    for (const lang of ['ru', 'en'] as const) {
      for (const name of ['Maya', '']) {
        const t = orgPolicyText(name, lang, false)
        expect(t).toBe(orgPolicyText(name, lang))
        expect(t).toContain(lang === 'ru' ? 'в панели 5dive откройте «Account», затем «Switch account».' : 'in the 5dive dashboard, Account, then Switch account.')
      }
    }
  })
  test('a default env is not lite', () => {
    expect(isLite({ TELEGRAM_STATE_DIR: join(dir, 'none') })).toBe(false)
    expect(isLite({ TELEGRAM_PROFILE: 'LITE-ish', TELEGRAM_STATE_DIR: join(dir, 'none') })).toBe(false)
  })
})

describe('server wiring', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
  test("the notice is built with the box's profile", () => {
    expect(src).toContain("const LITE = resolveProfile() === 'lite'")
    const calls = src.split('\n').filter(l => /orgPolicyText\(/.test(l) && !/^\s*(\/\/|import)/.test(l))
    expect(calls).toEqual(["    const text = orgPolicyText(bot.botInfo?.first_name ?? '', lang, LITE)"])
  })
})
