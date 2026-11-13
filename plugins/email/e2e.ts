// plugins/email/e2e.ts — the whole channel on one machine, no root, no network
// (DIVE-8315). Needs the plugin's dependencies (bun install), so repo CI's bare
// `bun test` does not run it; run it by hand:
//
//   cd plugins/email && bun install && bun e2e.ts
//
// Starts OpenAgent Mail (mailserver.ts) on high loopback ports with a capture
// SMTP server as its "firm relay", and the agent's channel (server.ts) in
// local mode as a real MCP server over stdio. Then, as an outside person would:
//   1. a mail arrives on the MX and reaches the agent as a channel message
//   2. the agent's reply goes out in the same thread, from its own address, DKIM-signed
//   3. the sender answers that reply: the same chat_id
//   4. a new mail to a never-seen address is HELD and the owner is asked
//   5. the owner's Allow sends it; 6. a No drops another and stays refused
//   7. a mail that tries to send as another agent is refused at submission
//   8. mail to another agent on this box is handed over locally
//   9. a voicemail (an audio attachment) reaches the agent transcribed. With
//      EMAIL_E2E_VOICE=<a spoken .wav> it is heard by the real local
//      transcriber (5dive-transcribe --backend=local); without, a stand-in.
// Each arm prints PASS/FAIL; the exit code is the number of failures.

import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const at = (u: string, d: string) => [u, d].join('@')
const SELF = 'mike@example.com'
const BOB = at('bob', 'outside.test')
const NEW = at('carol', 'outside.test')
const NOPE = at('dave', 'outside.test')
const base = 40000 + Math.floor(Math.random() * 2000) * 3
const RELAY = base, MX = base + 1, SUB = base + 2
const dir = mkdtempSync(join(tmpdir(), 'oamail-e2e-'))
const uid = process.getuid!(), gid = process.getgid!()

let fails = 0
const check = (name: string, ok: boolean, why = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${ok || !why ? '' : `\n   ${why}`}`) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(f: () => T | undefined, ms = 15000): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) { const v = f(); if (v !== undefined && v !== false) return v; if (Date.now() > end) return undefined; await sleep(100) }
}

// The firm's relay: keeps every mail it is handed.
const relayed: { to: string[]; raw: string }[] = []
const relay = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
  onData(stream, s, cb) { const b: Buffer[] = []; stream.on('data', d => b.push(d)); stream.on('end', () => { relayed.push({ to: s.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(b).toString() }); cb() }) },
})
await new Promise<void>(r => relay.listen(RELAY, '127.0.0.1', () => r()))

// OpenAgent Mail.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
mkdirSync(join(dir, 'etc'), { recursive: true })
writeFileSync(join(dir, 'etc', 'dkim.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
const maildir = join(dir, 'maildir')
writeFileSync(join(dir, 'etc', 'server.json'), JSON.stringify({
  domain: 'example.com', hostname: 'mail.example.com',
  dkim: { selector: 'oa1', key: join(dir, 'etc', 'dkim.key') },
  relay: { host: '127.0.0.1', port: RELAY, secure: false, user: '', pass: '' },
  agents: {
    mike: { maildir, uid, gid, pass_sha256: createHash('sha256').update('pw-mike').digest('hex') },
    ann: { maildir: join(dir, 'maildir-ann'), uid, gid, pass_sha256: createHash('sha256').update('pw-ann').digest('hex') },
  },
}))
const srv = Bun.spawn(['node', '--experimental-strip-types', '--no-warnings', join(import.meta.dir, 'mailserver.ts')], {
  env: { ...process.env, OAMAIL_CONFIG: join(dir, 'etc', 'server.json'), OAMAIL_SPOOL: join(dir, 'spool'), OAMAIL_MX_PORT: String(MX), OAMAIL_MX_HOST: '127.0.0.1', OAMAIL_SUB_PORT: String(SUB) },
  stderr: 'pipe', stdout: 'ignore',
})

// The owner's card: a stand-in for `sudo -n 5dive people knock file`, numbering knocks 1, 2, …
const fake = join(dir, 'fake-sudo')
writeFileSync(fake, `#!/bin/sh\nn=$(cat "${dir}/kn" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/kn"; echo "$*" >> "${dir}/knocks.log"\necho '{"ok":true,"data":{"id":'$n',"status":"pending","carded":true}}'\n`)
chmodSync(fake, 0o755)

// The agent's channel, as Claude Code runs it.
// The transcriber: the real one on a real clip, else a stand-in that prints a fixed line.
const VOICE = process.env.EMAIL_E2E_VOICE || ''
const fakeT = join(dir, 'fake-transcribe')
writeFileSync(fakeT, '#!/bin/sh\n[ "$1" = --backend=local ] || exit 9\necho "stand-in transcript of $(basename "$2")"\n')
chmodSync(fakeT, 0o755)
const TRANSCRIBER = VOICE ? '/usr/local/bin/5dive-transcribe' : fakeT
const state = join(dir, 'state')
mkdirSync(state, { recursive: true })
writeFileSync(join(state, 'config.json'), JSON.stringify({
  address: SELF, name: 'Mike', mode: 'local', maildir,
  smtp: { host: '127.0.0.1', port: SUB, secure: false, user: SELF, pass: 'pw-mike' },
  approve_new: true, // free_domains defaults to example.com: colleagues are free
}))
// 0: a mail that landed while the agent was down waits in new/ — it must reach
// the agent once Claude connects, not be marked read before anyone listens.
mkdirSync(join(maildir, 'new'), { recursive: true })
writeFileSync(join(maildir, 'new', '1000.waiting.mail'), `From: Dana <dana@outside.test>\r\nTo: ${SELF}\r\nSubject: Sent while you were down\r\nMessage-ID: <w0@outside.test>\r\n\r\nAre you there?\r\n`)
const inbound: { content: string; meta: Record<string, string> }[] = []
const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
await client.connect(new StdioClientTransport({ command: 'bun', args: [join(import.meta.dir, 'server.ts')], env: { ...process.env, EMAIL_STATE_DIR: state, EMAIL_SUDO: fake, EMAIL_TRANSCRIBE: TRANSCRIBER, HOME: dir } as any, stderr: 'ignore' }))
// Like Claude Code: the channel listener is registered a moment AFTER the
// handshake (its log: "Successfully connected" then "Channel notifications
// registered"); a notification sent in between is dropped.
await sleep(500)
client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }), (n: any) => { inbound.push(n.params) })
const call = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { text: String(r.content?.[0]?.text ?? ''), err: !!r.isError }
}

await sleep(800)
// The outside sender does STARTTLS, as real senders do.
const outside = nodemailer.createTransport({ host: '127.0.0.1', port: MX, secure: false, tls: { rejectUnauthorized: false } })

try {
  // 0
  const m0 = await until(() => inbound.find(i => i.meta.user_id === 'dana@outside.test'))
  check('0. a mail that waited while the agent was down reaches it after connect', !!m0 && m0.content.includes('Are you there?'), `inbound=${JSON.stringify(inbound)}`)

  // 1
  await outside.sendMail({ from: `Bob <${BOB}>`, to: SELF, subject: 'Quote for 40 chairs', text: 'Hi Mike, can you send a quote?', messageId: '<q1@outside.test>' })
  const m1 = await until(() => inbound.find(i => i.meta.user_id === BOB))
  check('1. a mail on the MX reaches the agent as a channel message', !!m1, `inbound=${JSON.stringify(inbound)}`)
  check('1b. it is marked outside and carries the subject', m1?.meta.sender_role === 'outside' && m1?.meta.subject === 'Quote for 40 chairs' && m1.content.includes('can you send a quote'))

  // 2
  const r2 = await call('reply', { chat_id: m1?.meta.chat_id, text: 'Hi Bob,\n\n40 chairs come to 2,000 EUR.\n\nMike' })
  const out2 = await until(() => relayed.find(x => x.to.includes(BOB)))
  const p2: any = out2 ? await simpleParser(out2.raw) : null
  check('2. the reply goes out to the sender through the relay', !r2.err && !!out2, r2.text)
  check('2b. same thread: In-Reply-To and References name the first mail, Re: subject', p2?.inReplyTo === '<q1@outside.test>' && String(p2?.references ?? '').includes('<q1@outside.test>') && p2?.subject === 'Re: Quote for 40 chairs', `${p2?.inReplyTo} ${p2?.references} ${p2?.subject}`)
  check('2c. from the agent\'s own address, DKIM-signed by the box', p2?.from?.value?.[0]?.address === SELF && /DKIM-Signature: .*d=example\.com.*s=oa1/s.test(out2?.raw ?? ''))

  // 3
  await outside.sendMail({ from: `Bob <${BOB}>`, to: SELF, subject: 'Re: Quote for 40 chairs', text: 'Great, ordered.\n\nOn Thu, Mike wrote:\n> 40 chairs come to 2,000 EUR.', inReplyTo: p2?.messageId, references: ['<q1@outside.test>', p2?.messageId] })
  const m3 = await until(() => inbound.filter(i => i.meta.user_id === BOB)[1])
  check('3. the answer to the reply lands in the SAME chat, quoted history cut', m3?.meta.chat_id === m1?.meta.chat_id && m3?.content.includes('Great, ordered.') && !m3?.content.includes('2,000'), JSON.stringify(m3))

  // 4
  const before = relayed.length
  const r4 = await call('send', { to: [NEW], subject: 'Intro', text: 'Hello Carol' })
  await sleep(1500)
  check('4. a first mail to a never-seen address is HELD, not sent', r4.text.includes('HELD') && relayed.length === before, r4.text)
  check('4b. the owner was asked about that address on channel email', (await Bun.file(join(dir, 'knocks.log')).text()).includes(`--channel=email --sender=${NEW}`))

  // 5
  mkdirSync(join(state, 'knocks'), { recursive: true })
  writeFileSync(join(state, 'knocks', '1.json'), JSON.stringify({ id: 1, channel: 'email', sender: NEW, answer: 'allow' }))
  const out5 = await until(() => relayed.find(x => x.to.includes(NEW)))
  const n5 = await until(() => inbound.find(i => i.meta.sender_role === 'owner-answer' && i.content.includes('allowed')))
  check('5. the owner\'s Allow sends the held mail and tells the agent', !!out5 && !!n5)
  const r5 = await call('send', { to: [NEW], subject: 'Follow-up', text: 'One more' })
  check('5b. that address is on the list now: the next mail goes straight out', r5.text.startsWith('sent'), r5.text)

  // 6
  const r6 = await call('send', { to: [NOPE], subject: 'Hi', text: 'Hello Dave' })
  writeFileSync(join(state, 'knocks', '2.json'), JSON.stringify({ id: 2, channel: 'email', sender: NOPE, answer: 'no' }))
  const n6 = await until(() => inbound.find(i => i.meta.sender_role === 'owner-answer' && i.content.includes('said no')))
  await sleep(500)
  const r6b = await call('send', { to: [NOPE], subject: 'Again', text: 'Hello again' })
  check('6. a No drops the held mail, tells the agent, and the address stays refused', r6.text.includes('HELD') && !!n6 && !relayed.some(x => x.to.includes(NOPE)) && r6b.err && r6b.text.includes('said no'), `${r6.text} | ${r6b.text}`)

  // 7
  const spoof = nodemailer.createTransport({ host: '127.0.0.1', port: SUB, secure: false, ignoreTLS: true, auth: { user: SELF, pass: 'pw-mike' } })
  let refused = ''
  try { await spoof.sendMail({ from: 'ann@example.com', to: BOB, subject: 'x', text: 'x' }) } catch (e: any) { refused = String(e?.message ?? e) }
  const bad = nodemailer.createTransport({ host: '127.0.0.1', port: SUB, secure: false, ignoreTLS: true, auth: { user: SELF, pass: 'wrong' } })
  let badLogin = ''
  try { await bad.sendMail({ from: SELF, to: BOB, subject: 'x', text: 'x' }) } catch (e: any) { badLogin = String(e?.message ?? e) }
  let openRelay = ''
  try { await outside.sendMail({ from: BOB, to: NEW, subject: 'relay?', text: 'x' }) } catch (e: any) { openRelay = String(e?.message ?? e) }
  check('7. submission refuses sending as another agent, a wrong password, and the MX is no open relay', /yourself/.test(refused) && /bad login|Invalid/i.test(badLogin) && /no such mailbox/.test(openRelay), `${refused} | ${badLogin} | ${openRelay}`)

  // 8: a colleague agent on the same box gets the mail directly, never via the relay
  const before8 = relayed.length
  const r8 = await call('send', { to: ['ann@example.com'], subject: 'Lunch', text: 'Noon?' })
  await sleep(1000)
  const annNew = await until(() => { try { return require('node:fs').readdirSync(join(dir, 'maildir-ann', 'new')).length > 0 || undefined } catch { return undefined } }, 5000)
  check('8. mail to another agent on this box is handed over locally', r8.text.startsWith('sent') && !!annNew && relayed.length === before8, r8.text)

  // 9
  const clip = VOICE ? require('node:fs').readFileSync(VOICE) : Buffer.from('RIFF0000WAVEfmt ')
  await outside.sendMail({ from: `Office phone <${BOB}>`, to: SELF, subject: 'Voicemail from +1 555 0100', text: 'You have a new voicemail.', attachments: [{ filename: 'voicemail.wav', content: clip, contentType: 'audio/wav' }] })
  const m9 = await until(() => inbound.find(i => i.meta.voice === '1'), VOICE ? 120000 : 15000)
  const heard = VOICE ? /forty|40/i.test(m9?.content ?? '') && /chair/i.test(m9?.content ?? '') : (m9?.content ?? '').includes('stand-in transcript of')
  check(`9. a voicemail reaches the agent transcribed on the box (${VOICE ? 'real local transcriber' : 'stand-in transcriber'}), with the audio file`, !!m9 && heard && !!m9.meta.audio_path && require('node:fs').existsSync(m9.meta.audio_path), JSON.stringify(m9))
} finally {
  await client.close().catch(() => {})
  srv.kill()
  relay.close()
}
console.log(`\n${fails ? `${fails} FAILED` : 'all passed'}  (work dir ${dir})`)
process.exit(fails)
