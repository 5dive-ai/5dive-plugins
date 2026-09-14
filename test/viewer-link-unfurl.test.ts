import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { protectTelegramViewerLinks as protectBase } from '../plugins/telegram/viewer-link.ts'
import { protectTelegramViewerLinks as protectCodex } from '../plugins/telegram-codex/viewer-link.ts'
import { protectTelegramViewerLinks as protectGrok } from '../plugins/telegram-grok/viewer-link.ts'
import { protectTelegramViewerLinks as protectAgy } from '../plugins/telegram-agy/viewer-link.ts'
import { protectTelegramViewerLinks as protectOpenCode } from '../plugins/telegram-opencode/viewer-link.ts'
import { protectTelegramViewerLinks as protectPi } from '../plugins/telegram-pi/viewer-link.ts'

const NONCE = 'a'.repeat(64)
const URL = `https://app.5dive.ai/browser/viewer/linkedin/${NONCE}`
const implementations = [
  ['telegram', protectBase],
  ['telegram-codex', protectCodex],
  ['telegram-grok', protectGrok],
  ['telegram-agy', protectAgy],
  ['telegram-opencode', protectOpenCode],
  ['telegram-pi', protectPi],
] as const

describe.each(implementations)('%s protects one-time browser viewer links', (_name, protect) => {
  test('plain text becomes an explicit code entity with preview suppression and copy-only guidance', () => {
    const payload = { text: `Open on your phone: ${URL}` }
    expect(protect(payload)).toBe(true)
    expect(payload).toMatchObject({
      link_preview_options: { is_disabled: true },
      entities: [{ type: 'code', offset: 20, length: URL.length }],
    })
    expect(payload.text).toContain('Copy-paste this one-time link into your browser.')
    expect(payload.text).toContain('Do not paste it back here.')
  })

  test('MarkdownV2 output is a code span and is not double-wrapped', () => {
    const payload = { text: `One\\-time: ${URL}`, parse_mode: 'MarkdownV2' }
    expect(protect(payload)).toBe(true)
    expect(payload.text).toContain(`\`${URL}\``)
    expect(payload.text).not.toContain(`\`\`${URL}\`\``)
    expect(payload.text).toContain('Copy\\-paste this one\\-time link')
    expect(protect(payload)).toBe(true)
    expect(payload.text.match(new RegExp('`', 'g'))).toHaveLength(2)
    expect(payload.text.match(/Do not paste it back here/g)).toHaveLength(1)
  })

  test('ordinary URLs and lookalikes are unchanged', () => {
    const ordinary = { text: 'Docs: https://example.com/browser/viewer/site/not-a-ticket' }
    expect(protect(ordinary)).toBe(false)
    expect(ordinary).toEqual({ text: 'Docs: https://example.com/browser/viewer/site/not-a-ticket' })
  })

  test('a conflicting URL entity is removed rather than overlapping the code span', () => {
    const payload = { text: URL, entities: [{ type: 'url', offset: 0, length: URL.length }] }
    protect(payload)
    expect(payload.entities).toEqual([{ type: 'code', offset: 0, length: URL.length }])
  })
})

test('all six Telegram senders enforce protection in the Bot API middleware', () => {
  for (const [name] of implementations) {
    const source = readFileSync(join(import.meta.dir, '..', 'plugins', name, 'server.ts'), 'utf8')
    expect(source, name).toContain("import { protectTelegramViewerLinks } from './viewer-link.ts'")
    expect(source, name).toMatch(/bot\.api\.config\.use\([\s\S]*?protectTelegramViewerLinks\(payload\)/)
  }
})

test('the shared browser workflow requires non-unfurling handoff copy', () => {
  const skill = readFileSync(join(import.meta.dir, '..', 'plugins/browser/skills/connect-site/SKILL.md'), 'utf8')
  expect(skill).toContain("format: 'markdownv2'")
  expect(skill).toContain('Do not paste it back into chat')
  expect(skill).toContain('non-unfurling code formatting')
})
