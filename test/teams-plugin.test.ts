// DIVE-7658 — the Teams channel's pure halves: who may reach the agent, where
// the bot's token may go, and how a message becomes buttons. No plugin deps:
// the signature check is injected, so this runs on a bare CI runner.
//
// Private addresses below are built from made-up prefix variables: the code
// under test sorts private from public, and the documentation ranges
// (192.0.2.x etc.) count as public, so they cannot stand in for private ones.

import { describe, test, expect } from 'bun:test'
import { isAllowedServiceUrl, normalizeServiceUrl, isAllowedConsentUploadUrl, inboundFileAuth, isPrivateAddress } from '../plugins/teams/hosts.ts'
import { splitTrailingOptions, optionValue, choiceCard, readSubmitValue, parseFileConsentInvoke, chunkText, CHOICE_KIND } from '../plugins/teams/cards.ts'
import { parseActivity, cleanText, safeName } from '../plugins/teams/activity.ts'
import { verifyRequest, checkClaims, bearer, makeTokenSource, BF_ISSUER } from '../plugins/teams/auth.ts'

const TENANT = '11111111-2222-3333-4444-555555555555'
const APP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SU = 'https://smba.trafficmanager.net/emea/'
const policy = { tenantId: TENANT, appId: APP }

function dm(over: Record<string, any> = {}) {
  return {
    type: 'message',
    id: 'm1',
    channelId: 'msteams',
    serviceUrl: SU,
    timestamp: '2026-11-03T22:00:00Z',
    from: { id: '29:x', name: 'Test User', aadObjectId: 'user-1' },
    conversation: { id: 'a:conv1', conversationType: 'personal', tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text: 'hello',
    ...over,
  }
}

describe('where the bot token may go', () => {
  test('Microsoft service URLs pass, in every cloud', () => {
    for (const u of [SU, 'https://smba.infra.gcc.teams.microsoft.com/x', 'https://smba.infra.dod.teams.microsoft.us/', 'https://x.botframework.azure.cn/']) {
      expect(isAllowedServiceUrl(u)).toBe(true)
    }
  })
  test('anything else is refused, including look-alikes and http', () => {
    for (const u of ['https://evil.example/', 'http://smba.trafficmanager.net/', 'https://smba.trafficmanager.net.evil.example/', 'https://evilsmba.trafficmanager.net.example/', 'not a url', 42]) {
      expect(isAllowedServiceUrl(u)).toBe(false)
    }
    expect(() => normalizeServiceUrl('https://evil.example/')).toThrow(/refusing/)
  })
  test('normalize trims the trailing slash', () => {
    expect(normalizeServiceUrl(SU)).toBe('https://smba.trafficmanager.net/emea')
  })
  test('file upload and download hosts', () => {
    expect(isAllowedConsentUploadUrl('https://contoso-my.sharepoint.com/personal/x')).toBe(true)
    expect(isAllowedConsentUploadUrl('https://contoso.example/upload')).toBe(false)
    expect(inboundFileAuth('https://contoso-my.sharepoint.com/f')).toBe('open')
    expect(inboundFileAuth('https://smba.trafficmanager.net/emea/v3/attachments/x')).toBe('token')
    expect(inboundFileAuth('https://us-api.asm.skype.com/v1/objects/x')).toBe('token')
    expect(inboundFileAuth('https://attacker.example/f')).toBe(null)
    expect(inboundFileAuth('http://contoso-my.sharepoint.com/f')).toBe(null)
  })
  test('private addresses are caught', () => {
    const A = '10.20', B = '192.168', C = '172.20', LL = '169.254', CG = '100.64'
    for (const ip of [`${A}.0.1`, '127.0.0.1', `${B}.1.5`, `${C}.0.1`, `${LL}.1.1`, '::1', 'fd00::1', `::ffff:${A}.2.3`, `${CG}.0.1`]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
    for (const ip of ['192.0.2.1', '198.51.100.7', '2001:db8::1']) expect(isPrivateAddress(ip)).toBe(false)
  })
})

describe('the button contract (same as Telegram)', () => {
  test('a trailing numbered list becomes buttons', () => {
    const s = splitTrailingOptions('Ship it tonight? I would.\n\n1. ⭐ Yes, tonight\n2. Wait for Monday')
    expect(s.body).toBe('Ship it tonight? I would.')
    expect(s.options).toEqual(['⭐ Yes, tonight', 'Wait for Monday'])
    expect(optionValue(s.options[0])).toBe('Yes, tonight')
  })
  test('prose with numbers stays text', () => {
    for (const t of ['We closed 2. tickets', 'Steps:\n1. one', 'List:\n2. two\n3. three', 'a\n1. x\nmore text after']) {
      expect(splitTrailingOptions(t).options).toEqual([])
    }
  })
  test('more than 8 answers, or a long one, stays text', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${i + 1}. o${i}`).join('\n')
    expect(splitTrailingOptions(`q\n${nine}`).options).toEqual([])
    expect(splitTrailingOptions(`q\n1. ${'x'.repeat(95)}\n2. b`).options).toEqual([])
  })
  test('the card carries one submit per answer, without the star', () => {
    const c: any = choiceCard('Pick', ['⭐ A', 'B'], 'card-1')
    expect(c.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(c.content.actions.map((a: any) => a.data)).toEqual([
      { kind: CHOICE_KIND, card: 'card-1', choice: 'A' },
      { kind: CHOICE_KIND, card: 'card-1', choice: 'B' },
    ])
  })
  test('a tap reads back as the answer', () => {
    expect(readSubmitValue({ kind: CHOICE_KIND, card: 'c', choice: 'A' })).toEqual({ choice: 'A', card: 'c' })
    expect(readSubmitValue({ action: { type: 'Action.Submit', data: { kind: CHOICE_KIND, choice: 'B' } } })).toEqual({ choice: 'B', card: undefined })
    expect(readSubmitValue({ msteams: { type: 'imBack', value: 'go' } })).toEqual({ choice: 'go' })
    expect(readSubmitValue(null)).toBe(null)
  })
})

describe('reading an activity', () => {
  test('a DM is a message with the Telegram-shaped meta', () => {
    const p: any = parseActivity(dm(), policy)
    expect(p.kind).toBe('message')
    expect(p.meta).toMatchObject({ chat_id: 'a:conv1', message_id: 'm1', user: 'Test User', user_id: 'user-1' })
  })
  test('another tenant is refused even though Microsoft signed it', () => {
    const p = parseActivity(dm({ channelData: { tenant: { id: 'other' } }, conversation: { id: 'a:c', conversationType: 'personal', tenantId: 'other' } }), policy)
    expect(p).toEqual({ kind: 'ignore', reason: 'tenant other' })
  })
  test('group chats and channel posts are out of scope', () => {
    const p = parseActivity(dm({ conversation: { id: '19:g', conversationType: 'groupChat', tenantId: TENANT } }), policy)
    expect(p.kind).toBe('ignore')
  })
  test('an allowlist, when set, is enforced', () => {
    expect(parseActivity(dm(), { ...policy, allowedUsers: ['someone-else'] }).kind).toBe('ignore')
    expect(parseActivity(dm(), { ...policy, allowedUsers: ['USER-1'] }).kind).toBe('message')
  })
  test('a button tap is via=button with the answer as text', () => {
    const p: any = parseActivity(dm({ text: undefined, replyToId: 'act-9', value: { kind: CHOICE_KIND, card: 'c1', choice: 'Yes' } }), policy)
    expect(p.kind).toBe('button')
    expect(p.text).toBe('Yes')
    expect(p.meta.via).toBe('button')
    expect(p.card).toBe('c1')
  })
  test('files: a shared file and a pasted image are read, the html copy is not', () => {
    const p: any = parseActivity(dm({
      text: 'see attached',
      attachments: [
        { contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'brief.pdf', content: { downloadUrl: 'https://contoso-my.sharepoint.com/d', fileType: 'pdf' } },
        { contentType: 'image/png', contentUrl: 'https://smba.trafficmanager.net/emea/v3/attachments/a/views/original' },
        { contentType: 'text/html', content: '<p>see attached</p>' },
      ],
    }), policy)
    expect(p.files.map((f: any) => f.name)).toEqual(['brief.pdf', 'image.png'])
  })
  test('a file-consent answer is recognised', () => {
    const p: any = parseActivity(dm({ type: 'invoke', name: 'fileConsent/invoke', value: { type: 'fileUpload', action: 'accept', context: { uploadId: 'u1' }, uploadInfo: { name: 'a.pdf', uploadUrl: 'https://x.sharepoint.com/u', contentUrl: 'c', uniqueId: 'id', fileType: 'pdf' } } }), policy)
    expect(p.kind).toBe('consent')
    expect(p.consent.uploadId).toBe('u1')
    expect(parseFileConsentInvoke({ name: 'other' })).toBe(null)
  })
  test('other channels and empty messages are ignored', () => {
    expect(parseActivity(dm({ channelId: 'slack' }), policy).kind).toBe('ignore')
    expect(parseActivity(dm({ text: '<at>Bot</at> ' }), policy).kind).toBe('ignore')
  })
  test('text and filename cleaning', () => {
    expect(cleanText('<at>Max</at> hi &amp; <b>bye</b>')).toBe('hi & bye')
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('.bashrc')).toBe('_bashrc')
  })
  test('long text is chunked under the cap', () => {
    const parts = chunkText('a'.repeat(15000) + '\n\n' + 'b'.repeat(15000), 20000)
    expect(parts.length).toBe(2)
    expect(parts.every(p => p.length <= 20000)).toBe(true)
  })
})

describe('is the request really from Microsoft, for this bot', () => {
  const now = 1_800_000_000
  const good = { iss: BF_ISSUER, aud: APP, exp: now + 600, nbf: now - 10, serviceurl: SU }
  const act = { serviceUrl: SU, channelId: 'msteams' }
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
  const tok = `Bearer ${hdr}.eyJ4IjoxfQ.c2ln`
  const deps = (payload: any, endorse = ['msteams']) => ({
    keys: async () => [{ kid: 'k1', endorsements: endorse }],
    verifySignature: async () => payload,
    now: () => now * 1000,
  })

  test('a good token passes', async () => {
    expect(await verifyRequest(tok, act, APP, deps(good))).toEqual({ ok: true })
  })
  test('every refusal has a reason', async () => {
    expect((await verifyRequest(null, act, APP, deps(good))) as any).toMatchObject({ ok: false, why: 'no bearer token' })
    expect((await verifyRequest(tok, act, APP, deps(good, ['skype']))) as any).toMatchObject({ ok: false })
    expect((await verifyRequest(tok, act, APP, { ...deps(good), verifySignature: async () => { throw new Error('sig') } })) as any).toMatchObject({ ok: false })
    const other = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'nope' })).toString('base64url')
    expect((await verifyRequest(`Bearer ${other}.e30.c2ln`, act, APP, deps(good))) as any).toMatchObject({ why: 'unknown signing key' })
    const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url')
    expect((await verifyRequest(`Bearer ${hs}.e30.c2ln`, act, APP, deps(good))) as any).toMatchObject({ ok: false })
  })
  test('claims: issuer, audience, expiry, serviceUrl binding', () => {
    expect(checkClaims(good, act, APP, now).ok).toBe(true)
    expect(checkClaims({ ...good, iss: 'https://sts.windows.net/x/' }, act, APP, now).ok).toBe(false)
    expect(checkClaims({ ...good, aud: 'another-bot' }, act, APP, now).ok).toBe(false)
    expect(checkClaims({ ...good, exp: now - 1000 }, act, APP, now).ok).toBe(false)
    expect(checkClaims({ ...good, nbf: now + 1000 }, act, APP, now).ok).toBe(false)
    expect(checkClaims({ ...good, serviceurl: 'https://smba.trafficmanager.net/amer/' }, act, APP, now).ok).toBe(false)
    expect(checkClaims(good, { serviceUrl: SU.replace(/\/$/, ''), channelId: 'msteams' }, APP, now).ok).toBe(true)
  })
  test('bearer parsing rejects junk', () => {
    expect(bearer('Basic abc')).toBe(null)
    expect(bearer('Bearer a.b')).toBe(null)
  })
  test('the bot token is fetched once and cached, from the customer tenant', async () => {
    const calls: string[] = []
    const f = async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ access_token: 't1', expires_in: 3600 }), { status: 200 })
    }
    const tok = makeTokenSource({ tenant_id: TENANT, app_id: APP, app_password: 'pw' }, f as any)
    expect(await tok()).toBe('t1')
    expect(await tok()).toBe('t1')
    expect(calls).toEqual([`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`])
  })
  test('a failed sign-in never echoes the response', async () => {
    const f = async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'secret pw is wrong' }), { status: 401 })
    const tok = makeTokenSource({ tenant_id: TENANT, app_id: APP, app_password: 'pw' }, f as any)
    let msg = ''
    try { await tok() } catch (e: any) { msg = String(e?.message) }
    expect(msg).toContain('invalid_client')
    expect(msg).not.toContain('secret pw')
  })
})
