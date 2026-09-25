// DIVE-4992 — the owner's tap on an agent's "Connect <site>" button.
// Pure half (parse, stdin, root's answer, the two messages) plus the wiring
// arms that decide who the tap reaches: the allowFrom check runs first, and the
// Connect branch runs before the generic agent-keyboard bridge. If that bridge
// ran first, it would hand the one-time code to the agent's session.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseConnectTap,
  connectStdin,
  parseConnectLink,
  parseConnectVerdict,
  renderConnectLink,
  renderConnectVerdict,
  connectFailureText,
} from '../plugins/telegram/browser-connect.ts'
import { protectTelegramViewerLinks } from '../plugins/telegram/viewer-link.ts'

const CODE = 'c'.repeat(48)
const DONE = 'd'.repeat(48)
const NONCE = 'a'.repeat(64)
const URL = `https://box.example.5dive.ai/browser/viewer/booking.com/${NONCE}`
const ROOT_OK = `site=booking.com\nurl=${URL}\nexpires=2026-09-25T15:00:00Z\ndone=${DONE}\n`

describe('parseConnectTap', () => {
  test('Connect and Done buttons parse', () => {
    expect(parseConnectTap(`bconn:${CODE}`)).toEqual({ op: 'tap', code: CODE })
    expect(parseConnectTap(`bdone:${DONE}`)).toEqual({ op: 'done', code: DONE })
  })
  test('anything else is not ours', () => {
    for (const d of [`bconn:${CODE.slice(1)}`, `bconn:${CODE}0`, `bconn:${CODE.toUpperCase()}`, `bconn:${CODE};rm`, 'gclear:12', `xconn:${CODE}`, '']) {
      expect(parseConnectTap(d)).toBeNull()
    }
  })
  test('callback_data fits Telegram\'s 64-byte cap', () => {
    expect(`bconn:${CODE}`.length).toBeLessThanOrEqual(64)
  })
})

describe('connectStdin', () => {
  test('NUL-separated op, code, sender', () => {
    expect(connectStdin({ op: 'tap', code: CODE }, '111')).toBe(["tap", CODE, "111"].map(s => s + "\u0000").join(""))
  })
  test('a non-numeric sender never reaches root', () => {
    expect(() => connectStdin({ op: 'tap', code: CODE }, '-100111')).toThrow()
    expect(() => connectStdin({ op: 'tap', code: CODE }, '1\0done')).toThrow()
  })
})

describe('parseConnectLink', () => {
  test('root\'s answer parses', () => {
    expect(parseConnectLink(ROOT_OK)).toEqual({ site: 'booking.com', url: URL, expires: '2026-09-25T15:00:00Z', done: DONE })
  })
  test('anything that is not exactly a viewer URL for that site is refused', () => {
    expect(parseConnectLink(ROOT_OK.replace(URL, 'https://evil.example/x'))).toBeNull()
    expect(parseConnectLink(ROOT_OK.replace('https://', 'http://'))).toBeNull()
    expect(parseConnectLink(ROOT_OK.replace('/booking.com/', '/github.com/'))).toBeNull()
    expect(parseConnectLink(ROOT_OK.replace(`done=${DONE}`, 'done=zz'))).toBeNull()
    expect(parseConnectLink('')).toBeNull()
  })
})

describe('renderConnectLink', () => {
  const m = renderConnectLink(parseConnectLink(ROOT_OK)!)
  test('the URL is a code entity covering exactly the URL', () => {
    expect(m.entities).toHaveLength(1)
    expect(m.entities[0]!.type).toBe('code')
    expect(m.text.slice(m.entities[0]!.offset, m.entities[0]!.offset + m.entities[0]!.length)).toBe(URL)
  })
  test('previews are off, so a previewer cannot spend the ticket', () => {
    expect(m.link_preview_options.is_disabled).toBe(true)
  })
  test('it tells the owner to copy-paste and not paste back', () => {
    expect(m.text).toContain('Copy-paste this one-time link into your browser. Do not paste it back here.')
  })
  test('the Done button carries the Done code, not the URL', () => {
    const b = m.reply_markup.inline_keyboard[0]![0]!
    expect(b.callback_data).toBe(`bdone:${DONE}`)
    expect(JSON.stringify(m.reply_markup)).not.toContain(NONCE)
  })
  test('the transport guard leaves it as it is (no double wrap, still one code entity over the URL)', () => {
    const payload = { text: m.text, entities: [...m.entities], link_preview_options: { ...m.link_preview_options } }
    protectTelegramViewerLinks(payload)
    expect(payload.text).toBe(m.text)
    expect(payload.entities).toEqual(m.entities)
  })
})

describe('verdict and failure', () => {
  test('authenticated reads as connected', () => {
    const v = parseConnectVerdict('site=booking.com\nstatus_rc=0\nstatus=booking.com: authenticated\n')!
    expect(renderConnectVerdict(v)).toContain('booking.com is connected')
  })
  test('anything else is not called connected', () => {
    const v = parseConnectVerdict('site=booking.com\nstatus_rc=75\nstatus=session expired\n')!
    expect(renderConnectVerdict(v)).not.toContain('is connected')
    expect(renderConnectVerdict(v)).toContain('session expired')
  })
  test('root\'s refusal reaches the owner in plain words', () => {
    expect(connectFailureText('browser: that button has expired. Ask the agent to send a new one.\n'))
      .toBe('❌ Could not open the login: that button has expired. Ask the agent to send a new one.')
  })
})

describe('wiring in the Claude Code bridge', () => {
  const src = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
  const router = src.slice(src.indexOf("bot.on('callback_query:data'"))
  test('the Connect branch is after the allowFrom check and before every other branch', () => {
    const allow = router.indexOf('access.allowFrom.includes(senderId)')
    const connect = router.indexOf('parseConnectTap(data)')
    const firstOther = router.indexOf('/^q:')
    const bridge = router.indexOf('[callback_query data=')
    expect(allow).toBeGreaterThan(0)
    expect(connect).toBeGreaterThan(allow)
    expect(connect).toBeLessThan(firstOther)
    expect(connect).toBeLessThan(bridge)
  })
  test('root is reached by the exact command, with the parameters on stdin', () => {
    expect(src).toContain("spawn(SUDO, ['-n', FIVEDIVE, 'browser', '_connect']")
    expect(src).toContain('child.stdin?.end(stdin)')
  })
  test('the tapper id sent to root is Telegram\'s from.id, not message content', () => {
    expect(router).toMatch(/const senderId = String\(ctx\.from\.id\)/)
    expect(src).toContain('handleBrowserConnectTap(ctx, connectTap, senderId)')
  })
})
