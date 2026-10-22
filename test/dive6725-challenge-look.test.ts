// DIVE-6725 — exact-swallow's owner got three "clear the captcha" buttons for a
// page that was a 404 with no captcha on it, and the agent was told "the owner
// cleared the check" after each Done. Root now loads the page before it asks and
// reads it back at Done (tests/browser_connect_request_unit.sh, arms P and L in
// 5dive-ai/5dive-browser). This is the plugin's half: the words follow what the
// box saw, and a late tap that root answered with a fresh button is not a failure.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseConnectLink,
  parseConnectVerdict,
  renderConnectLink,
  renderConnectVerdict,
  connectAgentNote,
  connectFailureText,
} from '../plugins/telegram/browser-connect.ts'

const DONE = 'd'.repeat(48)
const URL = `https://box.example.5dive.ai/browser/viewer/google.com/${'a'.repeat(64)}`
const TAP = `site=google.com\nurl=${URL}\nexpires=2026-10-22T09:46:03Z\ndone=${DONE}\nkind=challenge\n`
const SEEN =
  'the view is closed and the browser is back in the agent\'s hands, on the page it stopped at. ' +
  'It shows "URL inspection - Search Console" at https://search.google.com/search-console/inspect (HTTP 200); no check is detected on it'
const DONE_NONE = `site=google.com\nkind=challenge\nstatus_rc=0\ncheck=none\ntitle=URL inspection - Search Console\npage=https://search.google.com/search-console/inspect\nstatus=${SEEN}\n`
const DONE_STILL = DONE_NONE.replace('check=none', 'check=still').replace('no check is detected on it', 'a check is still on it')

describe('the link message follows what the box saw', () => {
  test('check=0: take over, never a captcha or a check to clear', () => {
    const l = parseConnectLink(TAP + 'check=0\n')!
    expect(l.check).toBe(false)
    const m = renderConnectLink(l)
    expect(m.text).toContain('🖐 Take over on google.com.')
    expect(m.text).toContain('Do what the agent asked')
    expect(m.text).not.toMatch(/captcha|Clear the check/)
  })
  test('check=1: the captcha words, as before', () => {
    const m = renderConnectLink(parseConnectLink(TAP + 'check=1\n')!)
    expect(m.text).toContain('Clear the check on google.com')
    expect(m.text).toContain('Clear the captcha yourself')
  })
  test('no check line (an older box): the captcha words it always sent', () => {
    expect(parseConnectLink(TAP)!.check).toBe(true)
    expect(renderConnectLink(parseConnectLink(TAP)!).text).toContain('Clear the check on google.com')
  })
  test('take-over keeps the link a CODE entity with previews off, and the same Done button', () => {
    const m = renderConnectLink(parseConnectLink(TAP + 'check=0\n')!)
    expect(m.entities).toEqual([{ type: 'code', offset: m.text.indexOf(URL), length: URL.length }])
    expect(m.link_preview_options).toEqual({ is_disabled: true })
    expect(m.reply_markup.inline_keyboard[0]![0]).toEqual({ text: 'Done — carry on', callback_data: `bdone:${DONE}` })
  })
})

describe('Done tells the agent what the page shows, never that a check was cleared', () => {
  test('the verdict carries the check state', () => {
    expect(parseConnectVerdict(DONE_NONE)).toMatchObject({ kind: 'challenge', check: 'none' })
    expect(parseConnectVerdict(DONE_STILL)!.check).toBe('still')
    expect(parseConnectVerdict(DONE_NONE.replace('check=none', 'check=bogus'))!.check).toBe('')
  })
  test('the agent note is root\'s read of the page', () => {
    const v = parseConnectVerdict(DONE_NONE)!
    const n = connectAgentNote('verdict', v.site, v.status, v.kind)
    expect(n).toContain('The owner tapped Done for google.com')
    expect(n).toContain('"URL inspection - Search Console"')
    expect(n).toContain('no check is detected on it')
    expect(n).not.toContain('cleared the check')
    expect(n).not.toContain('with the check cleared')
  })
  test('with nothing from root, the note says it does not know, still never "cleared"', () => {
    const n = connectAgentNote('verdict', 'google.com', '', 'challenge')
    expect(n).toContain('did not say what the page shows')
    expect(n).not.toMatch(/cleared/)
  })
  test('the owner is not told all is well when the box still sees a check', () => {
    expect(renderConnectVerdict(parseConnectVerdict(DONE_STILL)!)).toContain('still sees a check on google.com')
    expect(renderConnectVerdict(parseConnectVerdict(DONE_NONE)!)).toContain('carrying on with google.com')
  })
  test('server.ts hands a challenge Done root\'s status, not a login status line', () => {
    const src = readFileSync(join(import.meta.dir, '../plugins/telegram/server.ts'), 'utf8')
    expect(src).toContain("const said = v.kind === 'challenge' ? v.status :")
    expect(src).toContain("connectAgentNote('verdict', v.site, said, v.kind)")
  })
})

describe('a late tap', () => {
  test('root sent a fresh button: the old message says so, not "Could not open"', () => {
    const t = connectFailureText('browser: that button had expired, so a fresh one was just sent below. Tap Open or Connect on it.\n')
    expect(t).toBe('⏰ That button had expired, so a fresh one was just sent below. Tap Open or Connect on it.')
  })
  test('a tap too late for a fresh one is still the plain refusal', () => {
    expect(connectFailureText('browser: that button has expired. Ask the agent to send a new one.\n'))
      .toBe('❌ Could not open the login: that button has expired. Ask the agent to send a new one.')
  })
})
