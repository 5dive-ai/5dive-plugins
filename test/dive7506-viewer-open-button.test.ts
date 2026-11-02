// DIVE-7506 — the one-time browser viewer link keeps its copy-only code span AND
// gets a one-tap "Open the browser" URL button under the message.
//
// lodar 2026-11-02: «why link is sent as code and not as url ?» · «i have to click
// to copy» · then «keep the link as code» · «maybe add button too». So BOTH: a send
// that drops the code span FAILS here, a send without the button FAILS here, and
// a plain clickable URL (a url / text_link entity, or previews on) still FAILS.
// Telegram never previews or prefetches an inline-keyboard URL button, so the
// ticket is spent by the owner's tap, not by Telegram's previewer.
import { afterEach, describe, expect, test } from 'bun:test'
import { protectTelegramViewerLinks as protectBase } from '../plugins/telegram/viewer-link.ts'
import { protectTelegramViewerLinks as protectCodex } from '../plugins/telegram-codex/viewer-link.ts'
import { protectTelegramViewerLinks as protectGrok } from '../plugins/telegram-grok/viewer-link.ts'
import { protectTelegramViewerLinks as protectAgy } from '../plugins/telegram-agy/viewer-link.ts'
import { protectTelegramViewerLinks as protectOpenCode } from '../plugins/telegram-opencode/viewer-link.ts'
import { protectTelegramViewerLinks as protectPi } from '../plugins/telegram-pi/viewer-link.ts'

const NONCE = 'b'.repeat(64)
const URL = `https://box.example.5dive.ai/browser/viewer/shop.example.com/${NONCE}`
const URL2 = `https://box.example.5dive.ai/browser/viewer/github.com/${'c'.repeat(64)}`
const OPEN = { text: 'Open the browser', url: URL }

const implementations = [
  ['telegram', protectBase],
  ['telegram-codex', protectCodex],
  ['telegram-grok', protectGrok],
  ['telegram-agy', protectAgy],
  ['telegram-opencode', protectOpenCode],
  ['telegram-pi', protectPi],
] as const

type Payload = {
  text: string
  parse_mode?: string
  entities?: { type: string; offset: number; length: number }[]
  link_preview_options?: Record<string, unknown>
  reply_markup?: any
}

/** The one-time ticket's safety, read off the payload Telegram would receive:
 *  the URL is copy-only code, previews are off, nothing makes the text itself a
 *  clickable or previewable link, and the only other carrier is a plain URL
 *  button (never web_app / login_url, which Telegram opens differently). */
function assertCodeAndButton(p: Payload, url = URL) {
  expect(p.link_preview_options).toMatchObject({ is_disabled: true })
  const mode = p.parse_mode?.toLowerCase()
  if (!mode) {
    expect(p.entities).toContainEqual({ type: 'code', offset: p.text.indexOf(url), length: url.length })
    expect((p.entities ?? []).some(e => e.type === 'url' || e.type === 'text_link')).toBe(false)
  } else if (mode === 'html') {
    expect(p.text).toContain(`<code>${url}</code>`)
  } else {
    expect(p.text).toContain(`\`${url}\``)
  }
  const buttons = (p.reply_markup?.inline_keyboard ?? []).flat()
  const open = buttons.filter((b: any) => b.url === url)
  expect(open).toHaveLength(1)
  expect(Object.keys(open[0]).sort()).toEqual(['text', 'url'])
  expect(open[0].text).toStartWith('Open the browser')
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe.each(implementations)('%s: code span AND an Open the browser button', (_name, protect) => {
  test('plain text: the code entity stays and the URL button is added', () => {
    const p: Payload = { text: `Take over on shop.example.com: ${URL}` }
    expect(protect(p)).toBe(true)
    assertCodeAndButton(p)
    expect(p.reply_markup.inline_keyboard[0]).toEqual([OPEN])
    expect(p.text).toContain('Tap Open the browser below, or copy-paste this one-time link into your browser. Do not paste it back here.')
  })

  test('MarkdownV2 (the reply tool): code span stays, button added, warning escaped', () => {
    const p: Payload = { text: `Take over: ${URL.replace(/[-.]/g, '\\$&')}`, parse_mode: 'MarkdownV2' }
    expect(protect(p)).toBe(true)
    assertCodeAndButton(p)
    expect(p.text).toContain('Tap Open the browser below, or copy\\-paste this one\\-time link into your browser\\. Do not paste it back here\\.')
  })

  test('HTML: code tag stays, button added', () => {
    const p: Payload = { text: `Take over: ${URL}`, parse_mode: 'HTML' }
    protect(p)
    assertCodeAndButton(p)
  })

  test('buttons the caller set stay, under the Open row', () => {
    const done = { text: 'Done — carry on', callback_data: 'bdone:x' }
    const p: Payload = { text: URL, reply_markup: { inline_keyboard: [[done]] } }
    protect(p)
    expect(p.reply_markup.inline_keyboard).toEqual([[OPEN], [done]])
  })

  test('idempotent: guarding twice never adds a second button or warning', () => {
    const p: Payload = { text: `Open: ${URL}` }
    protect(p)
    protect(p)
    expect(p.reply_markup.inline_keyboard).toEqual([[OPEN]])
    expect(p.text.match(/Do not paste it back here/g)).toHaveLength(1)
  })

  test('a link that already has a URL button is left with exactly that one', () => {
    const p: Payload = { text: URL, reply_markup: { inline_keyboard: [[{ text: 'Open', url: URL }]] } }
    protect(p)
    expect(p.reply_markup.inline_keyboard).toEqual([[{ text: 'Open', url: URL }]])
  })

  test('two links: two numbered buttons, both code spans stay', () => {
    const p: Payload = { text: `${URL}\n${URL2}` }
    protect(p)
    assertCodeAndButton(p, URL)
    assertCodeAndButton(p, URL2)
    expect(p.reply_markup.inline_keyboard.map((r: any) => r[0].text)).toEqual(['Open the browser (1)', 'Open the browser (2)'])
  })

  test('fallback: a reply keyboard cannot carry an inline button, so the code span goes alone with the copy words', () => {
    const keyboard = { keyboard: [[{ text: 'yes' }]] }
    const p: Payload = { text: `Open: ${URL}`, reply_markup: keyboard }
    protect(p)
    expect(p.reply_markup).toBe(keyboard)
    expect(p.entities).toContainEqual({ type: 'code', offset: 6, length: URL.length })
    expect(p.text).toContain('\n\nCopy-paste this one-time link into your browser. Do not paste it back here.')
  })

  test('fallback: no button Telegram would refuse (path-only, raw IP, http)', () => {
    for (const link of [
      `/browser/viewer/site/${NONCE}`,
      `https://192.0.2.5/browser/viewer/site/${NONCE}`,
      `http://box.example.5dive.ai/browser/viewer/site/${NONCE}`,
    ]) {
      const p: Payload = { text: `Open: ${link}` }
      expect(protect(p)).toBe(true)
      expect(p.reply_markup).toBeUndefined()
      expect(p.entities).toContainEqual({ type: 'code', offset: 6, length: link.length })
    }
  })

  test('the ticket is unspent after the send is built: the guard makes no request at all', () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('spent', { status: 410 })
    }) as unknown as typeof fetch
    const p: Payload = { text: `Take over: ${URL}` }
    protect(p)
    JSON.stringify(p) // what the Bot API client puts on the wire
    expect(calls).toBe(0)
    assertCodeAndButton(p)
  })

  test('negative controls: the assertion fails a button-only send, a code-only send, and a plain URL', () => {
    const p: Payload = { text: `Take over: ${URL}` }
    protect(p)
    const buttonOnly = { ...p, entities: [] }
    expect(() => assertCodeAndButton(buttonOnly)).toThrow()
    const codeOnly = { ...p, reply_markup: undefined }
    expect(() => assertCodeAndButton(codeOnly)).toThrow()
    const plainUrl = { ...p, entities: [{ type: 'url', offset: p.text.indexOf(URL), length: URL.length }] }
    expect(() => assertCodeAndButton(plainUrl)).toThrow()
    const previewOn = { ...p, link_preview_options: { is_disabled: false } }
    expect(() => assertCodeAndButton(previewOn)).toThrow()
  })
})
