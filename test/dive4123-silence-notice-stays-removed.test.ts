// DIVE-4123 / 5dive-plugins#54 — the autonomous-silence DM notice stays removed.
//
// #54 reports the v0.5.49 telegram plugin DMing the operator "nothing has
// reached this channel for 3 turns" plus ~1200 chars of transcript, on a seat
// that was answering correctly on the dashboard. The cause is the one
// DIVE-3910 already removed in 3cfec88: the notice's silent-run analysis was
// hard-scoped to telegram, so a turn answered on any sibling channel counted as
// dark, and its "group topic" destination always fell back to the paired
// human's DM because no seat here configures a topic.
//
// 3cfec88 deleted the call site, `hooks/lib/autonomous-silence.ts` and its unit
// file — but did NOT bump the plugin version, so an install pinned at 0.5.49
// kept running the leaking code (installs resolve a version-pinned cache path).
// 0.5.50 is that bump. lodar's decision on the #54 gate (2026-09-09) was to
// preserve the removal rather than resurrect the notice with sibling-channel
// suppression, so this file is the tripwire that keeps it gone: a future
// "restore the silence notice" change has to delete these assertions first.
//
// The agent-side `hooks/silence-watchdog.ts` is a DIFFERENT mechanism and is
// deliberately untouched — it injects a <system-reminder> into the agent's own
// transcript and never sends anything to a user.
//
// Static, like parity.test.ts: importing a server long-polls Telegram.

import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const TELEGRAM_FAMILY = [
  'telegram',
  'telegram-codex',
  'telegram-grok',
  'telegram-agy',
  'telegram-opencode',
  'telegram-pi',
] as const

describe.each(TELEGRAM_FAMILY)('%s: no autonomous-silence notice', (plugin) => {
  test('the autonomous-silence module is not present', () => {
    expect(existsSync(join(PLUGINS, plugin, 'hooks', 'lib', 'autonomous-silence.ts'))).toBe(false)
  })
})

describe('telegram stop-reply-check', () => {
  const src = readFileSync(join(PLUGINS, 'telegram', 'hooks', 'stop-reply-check.ts'), 'utf8')

  test('does not import the silent-run module (the breadcrumb comment naming it is fine)', () => {
    expect(src).not.toMatch(/^\s*import[^\n]*autonomous-silence/m)
    expect(src).not.toMatch(/require\(['"][^'"]*autonomous-silence/)
  })

  test('does not call the silent-run analysis', () => {
    expect(src).not.toMatch(/nextSilentRun|SILENT_RUN_FIRST|silentRun/)
  })

  test('does not send the "reached this channel" notice', () => {
    expect(src).not.toMatch(/reached this channel/i)
  })

  test('keeps the removal breadcrumb, so the next reader knows it was deliberate', () => {
    expect(src).toMatch(/DIVE-3910: the autonomous-silence notice was REMOVED here/)
  })
})

describe('the agent-side silence watchdog is untouched', () => {
  const src = readFileSync(join(PLUGINS, 'telegram', 'hooks', 'silence-watchdog.ts'), 'utf8')

  test('still nudges the agent through the tool-result context, not a DM', () => {
    expect(src).toMatch(/emitPostToolContext/)
    expect(src).not.toMatch(/sendMessage\(/)
  })
})

describe('plugin version', () => {
  test('telegram ships the removal at >= 0.5.50', () => {
    const raw = readFileSync(join(PLUGINS, 'telegram', '.claude-plugin', 'plugin.json'), 'utf8')
    const [major, minor, patch] = (JSON.parse(raw).version as string).split('.').map(Number)
    const n = major * 1_000_000 + minor * 1_000 + patch
    expect(n).toBeGreaterThanOrEqual(5_050)
  })
})
