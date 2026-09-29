// DIVE-5200 — the agent is stuck on a captcha: the owner gets a one-time link to
// the box browser, clears it, taps Done, and the agent carries on by itself.
// Root's half is graded in tests/browser_connect_request_unit.sh (C arms); this
// is the plugin's half: the kind rides root's answer, the owner reads plain
// words, and the agent's session is told to carry on without re-asking.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseConnectLink,
  parseConnectVerdict,
  renderConnectLink,
  renderConnectVerdict,
  connectAgentNote,
} from '../plugins/telegram/browser-connect.ts'

const DONE = 'd'.repeat(48)
const URL = `https://box.example.5dive.ai/browser/viewer/futuretools.io/${'a'.repeat(64)}`
const TAP_OK = `site=futuretools.io\nurl=${URL}\nexpires=2026-09-29T15:00:00Z\ndone=${DONE}\nkind=challenge\n`
const DONE_OK = `site=futuretools.io\nkind=challenge\nstatus_rc=0\nstatus=the view is closed and the browser is back in the agent's hands, on the page it stopped at\n`

describe('the kind rides root\'s answer', () => {
  test('a challenge link parses as a challenge', () => {
    expect(parseConnectLink(TAP_OK)?.kind).toBe('challenge')
  })
  test('no kind, or an unknown one, is a login (the pre-5200 answer still parses the same)', () => {
    expect(parseConnectLink(TAP_OK.replace('kind=challenge\n', ''))?.kind).toBe('login')
    expect(parseConnectLink(TAP_OK.replace('kind=challenge', 'kind=weird'))?.kind).toBe('login')
  })
  test('a challenge Done parses as a challenge verdict', () => {
    expect(parseConnectVerdict(DONE_OK)).toMatchObject({ site: 'futuretools.io', rc: 0, kind: 'challenge' })
  })
})

describe('what the owner reads', () => {
  const m = renderConnectLink(parseConnectLink(TAP_OK)!)
  test('it says clear the check, not log in', () => {
    expect(m.text).toContain('Clear the check on futuretools.io')
    expect(m.text).toContain('Clear the captcha yourself')
    expect(m.text).not.toContain('Log in')
  })
  test('the one-time link is still a CODE entity with previews off', () => {
    expect(m.entities).toEqual([{ type: 'code', offset: m.text.indexOf(URL), length: URL.length }])
    expect(m.link_preview_options).toEqual({ is_disabled: true })
  })
  test('the Done button says the agent carries on', () => {
    expect(m.reply_markup.inline_keyboard[0]![0]).toEqual({ text: 'Done — carry on', callback_data: `bdone:${DONE}` })
  })
  test('after Done: thanks, the agent is carrying on (not a login verdict)', () => {
    const t = renderConnectVerdict(parseConnectVerdict(DONE_OK)!)
    expect(t).toContain('carrying on with futuretools.io')
    expect(t).not.toContain('logged in')
  })
})

describe('what the agent is told', () => {
  test('opened: wait for Done, never open the link', () => {
    const n = connectAgentNote('opened', 'futuretools.io', '', 'challenge')
    expect(n).toContain('Wait for their Done')
    expect(n).toContain('do not open the link')
  })
  test('Done: carry on without re-asking, check first so nothing is sent twice, never solve it', () => {
    const n = connectAgentNote('verdict', 'futuretools.io', '', 'challenge')
    expect(n).toContain('without asking them again')
    expect(n).toContain('nothing is sent twice')
    expect(n).toContain('never try to solve it')
    expect(n).toContain('back in your hands')
  })
  test('a login note is unchanged', () => {
    expect(connectAgentNote('opened', 'booking.com')).toContain('[browser connect] The owner tapped Connect for booking.com')
  })
})

describe('wiring', () => {
  const src = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
  test('both agent notes pass the kind through', () => {
    expect(src).toContain("connectAgentNote('opened', link.site, '', link.kind)")
    expect(src).toMatch(/connectAgentNote\('verdict', v\.site, .*, v\.kind\)/)
  })
})
