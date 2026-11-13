// DIVE-8315 — the email channel's pure half: threading, the send gate, the
// daily cap, what a mail looks like to the agent, local-only, the knock
// round-trip shapes, and the outside-mail guard. Node builtins only.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseConfig, normAddr, threadRoot, chatIdOf, replySubject, nextReferences, freshText, renderInbound,
  emptyState, readState, gateFor, capLeft, countSent, afterAnswer, mayReach, isPrivateAddress,
  knockFileArgs, knockFiled, parseAnswer, isAudio, voiceLine, type Config, type Held,
} from '../plugins/email/mail.ts'
import { guardVerdict, newestSource } from '../plugins/email/guard.ts'

// The agent's own domain is example.com. "Outside" needs a second domain: the
// reserved .test TLD (RFC 2606), joined at run time so the only literal
// addresses in this file are @example.com ones. Message-IDs likewise. The
// local-only arms need private and loopback ranges, which are not anyone's
// address either: built at run time too; public ones are 192.0.2.x.
const at = (user: string, domain: string) => [user, domain].join('@')
const mid = (s: string) => `<${s}@example.com>`
const ip = (...p: (number | string)[]) => p.join('.')
const ip6 = (...p: string[]) => p.join(':')
const SELF = 'mike@example.com'
const COLLEAGUE = 'ann@example.com'
const OUT1 = at('bob', 'outside.test')
const OUT2 = at('new', 'outside.test')
const ep = { host: 'mail.example.com', port: 993, secure: true, user: SELF, pass: 'x' }
const cfg: Config = { address: SELF, mode: 'imap', imap: ep, smtp: { ...ep, port: 587, secure: false } }

describe('config', () => {
  test('a valid imap config parses and lower-cases the address', () => {
    expect(parseConfig({ ...cfg, address: `Mike <${SELF.toUpperCase()}>` })?.address).toBe(SELF)
  })
  test('imap mode needs an imap endpoint; local mode needs an absolute maildir', () => {
    expect(parseConfig({ ...cfg, imap: undefined })).toBeNull()
    expect(parseConfig({ ...cfg, mode: 'local', imap: undefined, maildir: 'rel' })).toBeNull()
    expect(parseConfig({ ...cfg, mode: 'local', imap: undefined, maildir: '/var/lib/5dive/mail/mike' })).not.toBeNull()
  })
  test('a host with a shell character is refused', () => {
    expect(parseConfig({ ...cfg, smtp: { ...ep, host: 'a;b' } })).toBeNull()
  })
})

describe('addresses', () => {
  test('normAddr', () => {
    expect(normAddr(` ${SELF.toUpperCase()} `)).toBe(SELF)
    expect(normAddr(`"Bob B" <${OUT1}>`)).toBe(OUT1)
    expect(normAddr(at('bob', 'nodot'))).toBeNull()
    expect(normAddr(at('bob x', 'outside.test'))).toBeNull()
    expect(normAddr(undefined)).toBeNull()
  })
})

describe('threads: a reply chain is one chat', () => {
  const A = mid('a'), B = mid('b'), C = mid('c')
  test('root is the first References id, else In-Reply-To, else own id', () => {
    expect(threadRoot(C, B, `${A} ${B}`)).toBe(A)
    expect(threadRoot(C, B, undefined)).toBe(B)
    expect(threadRoot(C, undefined, undefined)).toBe(C)
  })
  test('the first mail and every reply to it share one chat_id', () => {
    const first = chatIdOf(threadRoot(A, undefined, undefined)!)
    const reply = chatIdOf(threadRoot(B, A, A)!)
    const reply2 = chatIdOf(threadRoot(C, B, [A, B])!)
    expect(reply).toBe(first)
    expect(reply2).toBe(first)
    expect(chatIdOf(mid('other'))).not.toBe(first)
  })
  test('subject and references', () => {
    expect(replySubject('Invoice 12')).toBe('Re: Invoice 12')
    expect(replySubject('RE: Invoice 12')).toBe('RE: Invoice 12')
    expect(replySubject('')).toBe('Re: (no subject)')
    expect(nextReferences([A], B)).toEqual([A, B])
    expect(nextReferences(Array.from({ length: 30 }, (_, i) => mid(`n${i}`)), mid('last'))).toHaveLength(20)
  })
})

describe('what the agent sees', () => {
  test('quoted history is cut', () => {
    expect(freshText(`Thanks, works.\n\nOn Mon, 3 Nov 2026 at 10:00, Mike <${SELF}> wrote:\n> old`)).toBe('Thanks, works.')
    expect(freshText('Yes.\n\n> earlier\n> more\n')).toBe('Yes.')
    expect(freshText('a\n> inline quote\nmy answer')).toContain('my answer')
  })
  test('the tag carries the sender from the headers and sender_role=outside', () => {
    const r = renderInbound({ messageId: mid('a'), from: { address: OUT1, name: 'Bob "B"' }, to: [SELF], cc: [OUT2], subject: 'Hi', text: 'Hello', date: '2026-11-13T00:00:00.000Z', files: ['/f1', '/f2'] }, 'mabc', 's1', SELF)
    expect(r.meta.user_id).toBe(OUT1)
    expect(r.meta.user).not.toContain('"')
    expect(r.meta.sender_role).toBe('outside')
    expect(r.meta.file_path).toBe('/f1')
    expect(r.meta.more_files).toBe('/f2')
    expect(r.content).toContain(`Also to: ${OUT2}`)
  })
})

describe('the send gate (design 4)', () => {
  test('someone who wrote in is free; a new outside address asks', () => {
    const s = emptyState()
    expect(gateFor(cfg, s, OUT2)).toBe('ask')
    s.known.push(OUT1)
    expect(gateFor(cfg, s, OUT1)).toBe('free')
  })
  test('colleagues on the agent\'s own domain are free by default; free_domains overrides', () => {
    const s = emptyState()
    expect(gateFor(cfg, s, COLLEAGUE)).toBe('free')
    expect(gateFor({ ...cfg, free_domains: [] }, s, COLLEAGUE)).toBe('ask')
  })
  test('the owner can switch the tap off; a No still holds', () => {
    const s = emptyState()
    expect(gateFor({ ...cfg, approve_new: false }, s, OUT2)).toBe('free')
    s.refused.push(OUT2)
    expect(gateFor({ ...cfg, approve_new: false }, s, OUT2)).toBe('refused')
  })
  test('afterAnswer: allow releases when nobody else is waited on; no drops', () => {
    const h: Held = { id: '1', to: [OUT1, OUT2], cc: [], subject: 's', text: 't', files: [], waiting: [OUT1, OUT2], knocks: {}, at: '' }
    expect(afterAnswer(h, OUT1, 'allow')).toBe('wait')
    expect(afterAnswer(h, at('zzz', 'outside.test'), 'allow')).toBe('wait')
    expect(afterAnswer({ ...h, waiting: [OUT2] }, OUT2, 'no')).toBe('drop')
    expect(afterAnswer(h, OUT2, 'allow')).toBe('send')
  })
  test('daily cap', () => {
    const s = emptyState()
    const now = new Date('2026-11-13T10:00:00Z')
    expect(capLeft({ ...cfg, daily_cap: 2 }, s, now)).toBe(2)
    countSent(s, now); countSent(s, now)
    expect(capLeft({ ...cfg, daily_cap: 2 }, s, now)).toBe(0)
    expect(capLeft({ ...cfg, daily_cap: 2 }, s, new Date('2026-11-14T00:00:01Z'))).toBe(2)
    expect(capLeft(cfg, readState({ sent: { day: '2026-11-13', n: 50 } }), now)).toBe(0)
  })
})

describe('the owner card round-trip', () => {
  test('knock args name the address on channel email and never the agent', () => {
    const a = knockFileArgs(OUT1.toUpperCase())!
    expect(a).toContain('--channel=email')
    expect(a).toContain(`--sender=${OUT1}`)
    expect(a.some(x => x.startsWith('--agent'))).toBe(false)
    expect(knockFileArgs('not an address')).toBeNull()
  })
  test('the CLI answer', () => {
    expect(knockFiled('{"ok":true,"data":{"id":7,"status":"pending","carded":true}}')).toEqual({ kid: '7', status: 'pending' })
    expect(knockFiled('{"ok":true,"data":{"id":null,"status":"allowed"}}').status).toBe('allowed')
    expect(knockFiled('{"ok":false,"error":{"message":"nope"}}')).toEqual({ kid: null, status: 'error', why: 'nope' })
  })
  test('an answer file is read only for channel email and its own name', () => {
    expect(parseAnswer({ id: 7, channel: 'email', sender: OUT1, answer: 'allow' }, '7.json')).toEqual({ id: '7', sender: OUT1, answer: 'allow' })
    expect(parseAnswer({ id: 7, channel: 'teams', sender: OUT1, answer: 'allow' }, '7.json')).toBeNull()
    expect(parseAnswer({ id: 7, channel: 'email', sender: OUT1, answer: 'allow' }, '8.json')).toBeNull()
    expect(parseAnswer({ id: 7, channel: 'email', sender: OUT1, answer: 'maybe' }, '7.json')).toBeNull()
  })
})

describe('local-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lo-'))
  const paths = { flag: join(dir, 'local-only'), allow: join(dir, 'local-only.allow') }
  const LAN = ip(192, 168, 1, 20), LOOP = ip(127, 0, 0, 1)
  test('online: any server', () => {
    expect(mayReach(['192.0.2.8'], paths)).toBe(true)
  })
  test('offline: a LAN mail server only, until IT opens email', () => {
    writeFileSync(paths.flag, '')
    expect(mayReach([LAN], paths)).toBe(true)
    expect(mayReach([LOOP], paths)).toBe(true)
    expect(mayReach(['192.0.2.9'], paths)).toBe(false)
    expect(mayReach([LAN, '192.0.2.9'], paths)).toBe(false)
    expect(mayReach([], paths)).toBe(false)
    writeFileSync(paths.allow, 'teams\nemail\n')
    expect(mayReach(['192.0.2.9'], paths)).toBe(true)
  })
  test('private ranges', () => {
    const priv = [ip(10, 0, 0, 1), ip(172, 16, 0, 1), ip(172, 31, 255, 255), ip(192, 168, 0, 1), ip6('', '', '1'), ip6('fd00', '', '1'), ip6('', '', 'ffff', ip(10, 1, 2, 3))]
    for (const a of priv) expect(isPrivateAddress(a)).toBe(true)
    for (const a of [ip(172, 32, 0, 1), '192.0.2.8']) expect(isPrivateAddress(a)).toBe(false)
  })
})

describe('the outside-mail guard (design 5)', () => {
  const line = (src: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: `<channel source="${src}" chat_id="1">hi</channel>` } })
  const on = { check: 'on' as const, membersMay: [] }
  test('the newest received channel message wins', () => {
    expect(newestSource([line('telegram'), line('email')].join('\n'))).toBe('email')
    expect(newestSource([line('email'), line('telegram')].join('\n'))).toBe('telegram')
  })
  test('a tool result quoting a tag is not a received message', () => {
    const tr = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '<channel source="email">' }] } })
    expect(newestSource([line('telegram'), tr].join('\n'))).toBe('telegram')
  })
  test('after an email, a risky act is held; plain work is not', () => {
    expect(guardVerdict('email', on, 'Bash', { command: 'sudo rm -rf /srv/x' }).ok).toBe(false)
    expect(guardVerdict('email', on, 'Bash', { command: 'ls -la' }).ok).toBe(true)
    expect(guardVerdict('email', on, 'Write', { file_path: '/home/agent-mike/.claude/settings.json' }).ok).toBe(false)
    expect(guardVerdict('email', on, 'Write', { file_path: '/home/agent-mike/notes.md' }).ok).toBe(true)
  })
  test('the owner\'s answer on their own channel lets the same call through', () => {
    expect(guardVerdict('telegram', on, 'Bash', { command: 'sudo systemctl restart x' }).ok).toBe(true)
  })
  test('the owner\'s switch: roles check off, or a kind widened', () => {
    expect(guardVerdict('email', { check: 'off', membersMay: [] }, 'Bash', { command: 'sudo ls' }).ok).toBe(true)
    expect(guardVerdict('email', { check: 'on', membersMay: ['root'] }, 'Bash', { command: 'sudo ls' }).ok).toBe(true)
  })
})

describe('voice messages (voicemail-to-email)', () => {
  test('an audio attachment is known by its type or its name', () => {
    expect(isAudio('voicemail.wav', 'application/octet-stream')).toBe(true)
    expect(isAudio('msg', 'audio/mpeg')).toBe(true)
    for (const n of ['a.mp3', 'b.M4A', 'c.ogg', 'd.opus', 'e.amr', 'f.flac']) expect(isAudio(n, '')).toBe(true)
    expect(isAudio('invoice.pdf', 'application/pdf')).toBe(false)
    expect(isAudio('photo.jpg', 'image/jpeg')).toBe(false)
  })
  test('the agent reads the transcript, or why there is none', () => {
    expect(voiceLine('vm.wav', { text: 'Call me back.' })).toContain('transcript, heard on this server:]\nCall me back.')
    expect(voiceLine('vm.wav', { text: '  ' })).toContain('(nothing could be heard in it)')
    expect(voiceLine('vm.wav', { why: 'not installed' })).toBe('[Voice message "vm.wav" attached, not transcribed: not installed]')
    expect(voiceLine('vm.wav', { text: 'x'.repeat(9000) }).length).toBeLessThan(8200)
  })
})
