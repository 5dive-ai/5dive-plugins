// DIVE-4992: the owner's tap on an agent's "Connect <site>" button.
//
// The agent asked with `5dive browser connect-request <site>`. ROOT minted a
// one-time code and put it straight into the button, so this seat first sees
// the code when the owner taps. The tap is relayed to root
// (`sudo -n 5dive browser _connect`, parameters NUL-separated on stdin). Root
// re-checks the code, that this seat's bot carried it, and that the tapper is
// this seat's paired owner. Only then does it start the browser and register
// the viewer bind. This module is the pure half: parse the tap, build root's
// stdin, parse its answer, and render the two messages. The I/O lives in
// server.ts.

type Entity = { type: 'code'; offset: number; length: number }

export type ConnectTap = { op: 'tap' | 'done'; code: string }

export type ConnectLink = { site: string; url: string; expires: string; done: string }

export type ConnectVerdict = { site: string; rc: number; status: string }

const TAP_RE = /^b(conn|done):([0-9a-f]{48})$/
const SITE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/browser\/viewer\/[A-Za-z0-9._-]{1,64}\/[0-9a-f]{64}$/
const CODE_RE = /^[0-9a-f]{48}$/

export function parseConnectTap(data: string): ConnectTap | null {
  const m = TAP_RE.exec(data)
  if (!m) return null
  return { op: m[1] === 'conn' ? 'tap' : 'done', code: m[2]! }
}

/** NUL-separated, the only shape the privileged half reads. The sender id is
 *  Telegram's `from.id` of the tap, never anything the message carried. */
export function connectStdin(tap: ConnectTap, senderId: string): string {
  if (!/^[0-9]+$/.test(senderId)) throw new Error('sender id must be numeric')
  return [tap.op, tap.code, senderId].map(s => s + '\0').join('')
}

function kv(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0 && !out.has(line.slice(0, i))) out.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  return out
}

/** Root's answer to a Connect tap. Anything not exactly the expected shape is
 *  null: the caller then says "could not open" rather than sending something
 *  that might not be a viewer URL. */
export function parseConnectLink(stdout: string): ConnectLink | null {
  const m = kv(stdout)
  const site = m.get('site') ?? ''
  const url = m.get('url') ?? ''
  const done = m.get('done') ?? ''
  const expires = m.get('expires') ?? ''
  if (!SITE_RE.test(site) || !URL_RE.test(url) || !CODE_RE.test(done)) return null
  if (!url.includes(`/browser/viewer/${site}/`)) return null
  return { site, url, expires, done }
}

export function parseConnectVerdict(stdout: string): ConnectVerdict | null {
  const m = kv(stdout)
  const site = m.get('site') ?? ''
  if (!SITE_RE.test(site)) return null
  const rc = Number(m.get('status_rc') ?? 'NaN')
  return { site, rc: Number.isFinite(rc) ? rc : -1, status: m.get('status') ?? '' }
}

/** The link message. The URL is a CODE entity and previews are off: a link
 *  previewer spends a one-time ticket before the human taps (DIVE-4464). The
 *  transport guard would do the same, but this path does not rely on it. */
export function renderConnectLink(l: ConnectLink): {
  text: string
  entities: Entity[]
  link_preview_options: { is_disabled: true }
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] }
} {
  const head =
    `🔐 Log in to ${l.site}.\n\n` +
    `Copy-paste this one-time link into your browser. Do not paste it back here. ` +
    `It works once${l.expires ? ` and expires ${l.expires}` : ''}.\n\n`
  const tail = `\n\nLog in, close the tab, then tap Done so the agent can check the login.`
  return {
    text: head + l.url + tail,
    entities: [{ type: 'code', offset: head.length, length: l.url.length }],
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: `Done — check ${l.site}`, callback_data: `bdone:${l.done}` }]] },
  }
}

export function renderConnectVerdict(v: ConnectVerdict): string {
  const ok = v.rc === 0
  return ok
    ? `✅ ${v.site} is connected. The agent can use it now.`
    : `⚠️ ${v.site} is not confirmed logged in: ${v.status || 'no verdict'}.`
}

/** What the agent's session is told, so it can carry on without polling. */
export function connectAgentNote(kind: 'opened' | 'verdict', site: string, detail = ''): string {
  return kind === 'opened'
    ? `[browser connect] The owner tapped Connect for ${site}. The one-time login link was sent to them. Wait for their Done; do not open the link.`
    : `[browser connect] The owner finished logging in to ${site}. ${detail}`.trim()
}

/** The owner-facing refusal. Root's messages are written for a person already,
 *  so the last stderr line is passed through, capped. */
export function connectFailureText(stderr: string): string {
  const last = stderr.trim().split('\n').filter(Boolean).pop() ?? ''
  const why = last.replace(/^[^:]*browser: /, '').slice(0, 300)
  return `❌ Could not open the login: ${why || 'the box did not answer'}`
}
