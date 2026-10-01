// DIVE-5220: on a standard-isolation seat the Telegram bot showed "✅ Account →
// mark … restarting" and then "❌ sudo: a password is required", and /usage said
// "your 5dive CLI may be out of date" — both were a refused sudo. The pure half
// (seat classification, the usage read, the texts) is driven directly; the
// wiring in server.ts is read as text, because importing the server long-polls
// Telegram.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  seatCanAdmin, isPermissionRefusal, classifyAccountUsage, accountReadOnlyText,
  accountSwitchPendingText, accountSwitchDoneText, accountSwitchFailedText,
  USAGE_NOT_AVAILABLE_TEXT, USAGE_READ_FAILED_TEXT,
} from '../plugins/telegram/seatpriv'

// Entries as `5dive agent list --json` returns them, read unprivileged as
// agent-oinoa on poke-two, 2026-09-29.
const OINOA = { name: 'oinoa', isolation: 'standard', sudo: { grant: 'cli-scoped', runas: 'root', impliedIsolation: 'standard', measured: true } }
const MARKETING = { name: 'marketing', isolation: 'admin', sudo: { grant: 'cli-root', runas: 'root', impliedIsolation: 'admin', measured: true } }
const MAIN = { name: 'main', isolation: 'admin', sudo: { grant: 'root-all', runas: 'any', impliedIsolation: 'beyond-admin', measured: true } }
// The CLI's own answer to an unprivileged `5dive account usage --json`.
const PERMISSION_ENV = { ok: false, error: { code: 10, class: 'permission', message: 'must run as root — try: sudo 5dive account usage --json' } }

const SERVER = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
function body(startMarker: string, endMarker: string): string {
  const i = SERVER.indexOf(startMarker)
  expect(i).toBeGreaterThan(-1)
  const j = SERVER.indexOf(endMarker, i + startMarker.length)
  expect(j).toBeGreaterThan(i)
  return SERVER.slice(i, j)
}

describe('which seats may switch accounts', () => {
  test('a standard seat (the oinoa entry) may not', () => {
    expect(seatCanAdmin(OINOA, false)).toBe('no')
  })
  test('admin and beyond-admin seats may — the full-seat path is unchanged', () => {
    expect(seatCanAdmin(MARKETING, false)).toBe('yes')
    expect(seatCanAdmin(MAIN, false)).toBe('yes')
  })
  test('the measured grant beats the stored label', () => {
    expect(seatCanAdmin({ ...OINOA, isolation: 'admin' }, false)).toBe('no')
    expect(seatCanAdmin({ ...MARKETING, isolation: 'standard' }, false)).toBe('yes')
  })
  test('an unmeasured grant falls back to the label', () => {
    expect(seatCanAdmin({ name: 'x', isolation: 'standard', sudo: { measured: false } }, false)).toBe('no')
    expect(seatCanAdmin({ name: 'x', isolation: 'admin' }, false)).toBe('yes')
  })
  test('a latched sudo refusal is decisive whatever the list says', () => {
    expect(seatCanAdmin(MARKETING, true)).toBe('no')
    expect(seatCanAdmin(null, true)).toBe('no')
  })
  test('no entry and no latch is unknown, not a guess', () => {
    expect(seatCanAdmin(null, false)).toBe('unknown')
    expect(seatCanAdmin({ name: 'x' }, false)).toBe('unknown')
  })
})

describe('/usage says what happened', () => {
  test('the CLI\'s permission envelope is a refusal', () => {
    expect(isPermissionRefusal(PERMISSION_ENV)).toBe(true)
    expect(isPermissionRefusal({ ok: false, error: { class: 'usage' } })).toBe(false)
    expect(isPermissionRefusal(null)).toBe(false)
  })
  test('refused → the not-available text, never "CLI out of date"', () => {
    for (const [env, seat, latched] of [
      [PERMISSION_ENV, 'unknown', false],
      [null, 'no', false],
      [null, 'unknown', true],
    ] as const) {
      const r = classifyAccountUsage(env, seat, latched)
      expect(r.kind).toBe('refused')
    }
    expect(USAGE_NOT_AVAILABLE_TEXT).not.toContain('out of date')
    // DIVE-5331: the one admin-tier message replaced 5220's own string.
    expect(USAGE_NOT_AVAILABLE_TEXT).toContain('needs an admin-tier agent')
  })
  test('an admin seat that reads the board gets the data', () => {
    const r = classifyAccountUsage({ ok: true, data: [{ name: 'mark', usage: null }] }, 'yes', false)
    expect(r).toEqual({ kind: 'ok', data: [{ name: 'mark', usage: null }] })
  })
  test('an admin seat with nothing parseable keeps the update hint', () => {
    expect(classifyAccountUsage(null, 'yes', false).kind).toBe('failed')
    expect(USAGE_READ_FAILED_TEXT).toContain('out of date')
  })
})

describe('/account never claims a switch it has not made', () => {
  test('the read-only view names the current account and who can switch it', () => {
    const t = accountReadOnlyText('mark')
    expect(t).toContain('Current account: mark')
    expect(t).toContain('needs an admin-tier agent')
    expect(t).not.toContain('✅')
  })
  test('the pending text carries no ✅; only the done text does', () => {
    expect(accountSwitchPendingText('mark')).not.toContain('✅')
    expect(accountSwitchPendingText('mark')).not.toContain('restarting')
    expect(accountSwitchDoneText('mark')).toStartWith('✅ Account → mark')
  })
  test('a refusal is one plain message, not a quoted sudo error', () => {
    const t = accountSwitchFailedText('mark', true, 'sudo: a password is required')
    expect(t).toStartWith('❌')
    expect(t).toContain('needs an admin-tier agent')
    expect(t).not.toContain('sudo')
    expect(t).not.toContain('✅')
  })
  test('any other failure keeps its reason', () => {
    expect(accountSwitchFailedText('mark', false, 'unknown account')).toContain('unknown account')
  })
})

describe('server.ts wiring', () => {
  const apply = body('async function applyAccount(', 'function applyEffort(')
  const menu = body('async function buildAccountMenu(', 'async function buildRotationMenu(')
  const usage = body('  usage: async ctx => {', '  // /goal —')
  const tap = body("const accountM = /^account:", "// /account auto-rotate submenu")

  test('applyAccount refuses a standard seat before any sudo is spawned', () => {
    const gate = apply.indexOf("thisSeatAdmin(me)) === 'no'")
    const spawn = apply.indexOf("'set-account'")
    expect(gate).toBeGreaterThan(-1)
    expect(spawn).toBeGreaterThan(gate)
  })
  test('the ✅ is sent only on set-account\'s success branch', () => {
    // The synchronous ack is the pending text; the done text rides the .then.
    expect(apply).toContain('text: accountSwitchPendingText(name)')
    expect(apply).not.toMatch(/text: `✅/)
    expect(apply).toMatch(/set-account'[\s\S]*\.then\(\s*\(\) => bot\.api\.sendMessage\(chatId, accountSwitchDoneText\(name\)\)/)
    expect(apply).toContain('accountSwitchFailedText(name, isSudoDenial(err) || isAdminTierRequired(err), detail, lang)')
  })
  test('the picker is swapped for the read-only view on a standard seat, before the root-only reads', () => {
    const gate = menu.indexOf("=== 'no'")
    expect(gate).toBeGreaterThan(-1)
    expect(menu.indexOf('accountReadOnlyText(')).toBeGreaterThan(gate)
    expect(menu.indexOf('read5diveAccountUsage()')).toBeGreaterThan(gate)
  })
  test('/usage answers a standard seat without spawning the reads, and classifies the rest', () => {
    const gate = usage.indexOf("seat === 'no'")
    expect(gate).toBeGreaterThan(-1)
    // DIVE-5331: the standard seat now gets its own usage, not only a refusal.
    expect(usage.indexOf('ownUsageText(')).toBeGreaterThan(gate)
    expect(usage.indexOf("read5diveJson(['account', 'usage', '--json'])")).toBeGreaterThan(gate)
    expect(usage).toContain('classifyAccountUsage<FiveDiveAccountUsage>(')
    expect(usage).not.toContain('`Couldn\'t read usage')
  })
  test('the tap handler edits in place and pushes nothing optimistic', () => {
    expect(tap).toContain('await ctx.editMessageText(r.text)')
    expect(tap).not.toContain('ctx.reply(r.text)')
  })
})
