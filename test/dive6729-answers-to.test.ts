// DIVE-6729: "Answers to" — the app lists EVERY name an agent answers to in a
// group, the word from her bot's display name first, and the owner can remove
// any of them (lodar 2026-10-22 06:29Z: «указывать имена уже прописанные к агенту
// при случае если человек захочет изменить даже исходное имя»). Real case: a bot
// named "Janis's matcha assistant" answered to "Janis", the owner's own name, and
// nothing could turn that off.
//
// Before: the gate always added the bot-name word to `groupsCallNames`, so the
// list was extras only. Now `groupsCallNamesComplete: true` (set by the verb's
// `--names=`) makes the list the whole set. Without the flag nothing changes.
// server.ts is read as TEXT (it long-polls Telegram on import).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callNames, nameMentioned } from '../plugins/telegram/grouplog'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
const GATE = SERVER.slice(SERVER.indexOf('function isMentioned('), SERVER.indexOf('function groupLineFor('))

// The name half of the gate, as server.ts runs it.
const heard = (text: string, firstName: string, access: { groupsCallNames?: unknown; groupsCallNamesComplete?: unknown }) =>
  nameMentioned(text, access.groupsCallNamesComplete === true ? undefined : firstName, callNames(access.groupsCallNames))

describe('the whole list', () => {
  test('flag on, bot word left off: a line with only that word is not a call', () => {
    const access = { groupsCallNames: ['Matcha'], groupsCallNamesComplete: true }
    expect(heard('Janis, what do you think?', "Janis's matcha assistant", access)).toBe(false)
    expect(heard('Matcha, what do you think?', "Janis's matcha assistant", access)).toBe(true)
  })
  test('flag on, bot word kept on the list: it still calls her', () => {
    const access = { groupsCallNames: ['Olivia', 'Оля'], groupsCallNamesComplete: true }
    expect(heard('Olivia, hi', 'Olivia', access)).toBe(true)
    expect(heard('спроси Олю', 'Olivia', access)).toBe(true)
  })
  test('flag on, empty list: no name calls her (only an @mention or a reply does)', () => {
    const access = { groupsCallNames: [], groupsCallNamesComplete: true }
    expect(heard('Olivia, hi', 'Olivia', access)).toBe(false)
  })
})

describe('no flag: exactly as before', () => {
  test('the bot word still calls her, on top of the list', () => {
    expect(heard('Janis, what do you think?', "Janis's matcha assistant", { groupsCallNames: ['Matcha'] })).toBe(true)
    expect(heard('Olivia, hi', 'Olivia', {})).toBe(true)
  })
  test('a flag that is not literally true is off', () => {
    for (const v of ['true', 1, null, false])
      expect(heard('Olivia, hi', 'Olivia', { groupsCallNames: [], groupsCallNamesComplete: v })).toBe(true)
  })
})

describe('server.ts', () => {
  test('the gate passes the flag, and drops the bot name only when it is on', () => {
    expect(SERVER).toContain('isMentioned(ctx, access.mentionPatterns, callNames(access.groupsCallNames), access.groupsCallNamesComplete === true)')
    expect(GATE).toContain('nameMentioned(text, namesComplete ? undefined : botFirstName, alsoNames)')
  })
  test('an @mention and a reply to her are checked before the names', () => {
    const at = GATE.indexOf('`@${botUsername}`'), reply = GATE.indexOf('reply_to_message?.from?.username === botUsername')
    const names = GATE.indexOf('nameMentioned(')
    expect(at).toBeGreaterThan(0)
    expect(reply).toBeGreaterThan(0)
    expect(at).toBeLessThan(names)
    expect(reply).toBeLessThan(names)
  })
  test('the plugin keeps the flag when it saves access.json', () => {
    const n = SERVER.slice(SERVER.indexOf('function normalizeAccess('), SERVER.indexOf('function normalizeAccess(') + 1500)
    expect(n).toContain('groupsCallNamesComplete: parsed.groupsCallNamesComplete')
  })
})
