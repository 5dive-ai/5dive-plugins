// DIVE-5504 item 3: a Codex approval request on the dispatcher path is asked on
// Telegram (the hook's req/res handshake), the tapper's answer resumes the
// waiting JSON-RPC request, and a timeout or a missing adapter stays an
// explicit decline. Before 0.5.26 every one of these was declined unseen.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPROVAL_METHODS, approvalAsk, approvalResult, askOnTelegram, isApprovalMethod, verdictLine,
} from '../plugins/telegram-codex/approvals.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function permsDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dive5504-approvals-'))
  dirs.push(d)
  return d
}

/** Plays server.ts: waits for the req file, then writes the tapper's answer. */
async function tapWhenAsked(dir: string, behavior: 'allow' | 'deny', user = 'owner'): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const req = readdirSync(dir).find(f => f.startsWith('req-') && f.endsWith('.json'))
    if (req) {
      const body = JSON.parse(readFileSync(join(dir, req), 'utf8'))
      writeFileSync(join(dir, req.replace(/^req-/, 'res-')), JSON.stringify({ behavior, user }))
      return body
    }
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('no request was written')
}

describe('approval requests become Telegram asks', () => {
  test('the four approval methods are handled; other server requests are not', () => {
    expect([...APPROVAL_METHODS].every(isApprovalMethod)).toBe(true)
    expect(isApprovalMethod('item/tool/requestUserInput')).toBe(false)
    expect(isApprovalMethod('account/chatgptAuthTokens/refresh')).toBe(false)
  })

  test('a v2 command approval shows the command, its cwd and reason', () => {
    const a = approvalAsk('item/commandExecution/requestApproval',
      { command: 'rm -rf build', cwd: '/w', reason: 'clean build', threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1 })
    expect(a).toEqual({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: '/w', reason: 'clean build' })
  })

  test('a legacy exec approval joins argv; a legacy patch lists its files', () => {
    expect(approvalAsk('execCommandApproval', { command: ['git', 'push'], cwd: '/w' }).tool_input).toEqual({ command: 'git push' })
    const p = approvalAsk('applyPatchApproval', { fileChanges: { '/w/a.ts': {}, '/w/b.ts': {} }, callId: 'c', conversationId: 'x' })
    expect(p.tool_name).toBe('Edit')
    expect(p.tool_input.files).toEqual(['/w/a.ts', '/w/b.ts'])
  })
})

describe('the verdict resumes the waiting request', () => {
  test('ALLOW: the tapper is attributed and v2 gets accept, legacy gets approved', async () => {
    const dir = permsDir()
    const ask = approvalAsk('item/commandExecution/requestApproval', { command: 'ls', cwd: '/w' })
    const [verdict, req] = await Promise.all([
      askOnTelegram({ permsDir: dir, ask, route: { chat_id: '42', message_thread_id: '7' }, model: 'gpt-x', timeoutMs: 5_000, pollMs: 5 }),
      tapWhenAsked(dir, 'allow', 'lodar'),
    ])
    expect(verdict).toEqual({ behavior: 'allow', user: 'lodar' })
    // the prompt is routed to the turn's chat, carries an expiry, and is marked as the dispatcher's
    expect(req).toMatchObject({ source: 'dispatcher', tool_name: 'Bash', chat_id: '42', message_thread_id: '7', model: 'gpt-x' })
    expect(Number.isFinite(Date.parse(req.expires_at))).toBe(true)
    expect(approvalResult('item/commandExecution/requestApproval', verdict)).toEqual({ decision: 'accept' })
    expect(approvalResult('item/fileChange/requestApproval', verdict)).toEqual({ decision: 'accept' })
    expect(approvalResult('execCommandApproval', verdict)).toEqual({ decision: 'approved' })
    expect(verdictLine(verdict)).toBe('approved by @lodar on Telegram')
    // both handshake files are gone: nothing is left for a second tap to answer
    expect(readdirSync(dir)).toEqual([])
  })

  test('DENY: v2 gets decline; legacy gets a denied rejection that names who', async () => {
    const dir = permsDir()
    const ask = approvalAsk('applyPatchApproval', { fileChanges: { '/w/a.ts': {} } })
    const [verdict] = await Promise.all([
      askOnTelegram({ permsDir: dir, ask, timeoutMs: 5_000, pollMs: 5 }),
      tapWhenAsked(dir, 'deny', 'lodar'),
    ])
    expect(approvalResult('item/fileChange/requestApproval', verdict)).toEqual({ decision: 'decline' })
    expect(approvalResult('applyPatchApproval', verdict)).toEqual({ decision: { denied: { rejection: 'denied by @lodar on Telegram' } } })
  })

  test('TIMEOUT: declined, said so, and the request file is withdrawn so a late tap is refused', async () => {
    const dir = permsDir()
    const ask = approvalAsk('item/commandExecution/requestApproval', { command: 'ls' })
    const verdict = await askOnTelegram({ permsDir: dir, ask, timeoutMs: 60, pollMs: 5 })
    expect(verdict).toEqual({ behavior: 'timeout', seconds: 0 })
    expect(approvalResult('item/commandExecution/requestApproval', verdict)).toEqual({ decision: 'decline' })
    expect(approvalResult('execCommandApproval', verdict).decision).toEqual({ denied: { rejection: 'no answer on Telegram within 0s, so it was declined' } })
    expect(readdirSync(dir)).toEqual([])
  })

  test('UNAVAILABLE: an unwritable permissions dir declines with the reason instead of throwing', async () => {
    const verdict = await askOnTelegram({ permsDir: '/nonexistent/dive5504', ask: approvalAsk('execCommandApproval', { command: ['ls'] }), timeoutMs: 50 })
    expect(verdict.behavior).toBe('unavailable')
    expect(approvalResult('execCommandApproval', verdict).decision).toMatchObject({ denied: { rejection: expect.stringContaining('could not ask on Telegram') } })
  })

  test('a malformed answer is not an approval: it waits on, then times out', async () => {
    const dir = permsDir()
    const p = askOnTelegram({ permsDir: dir, ask: approvalAsk('execCommandApproval', { command: ['ls'] }), timeoutMs: 150, pollMs: 5, id: 'abc' })
    await new Promise(r => setTimeout(r, 20))
    expect(existsSync(join(dir, 'req-abc.json'))).toBe(true)
    writeFileSync(join(dir, 'res-abc.json'), JSON.stringify({ behavior: 'yes please' }))
    expect((await p).behavior).toBe('timeout')
  })
})

describe('wiring', () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram-codex', f), 'utf8')

  test('the dispatcher no longer declines approvals unseen, and answers off the read loop', () => {
    const d = src('dispatcher.ts')
    expect(d).not.toContain("dispatcher has no interactive approval client")
    expect(d).toContain('rpc.onServerRequest = answerServerRequest')
    expect(d).toMatch(/void this\.onServerRequest\(msg\.method, msg\.params\)\.then\(answer, \(\) => answer\(null\)\)/)
  })

  test('server.ts refuses a tap on an expired request and asks in the turn\'s chat', () => {
    const s = src('server.ts')
    expect(s).toContain("This request expired; Codex was already told no.")
    expect(s).toMatch(/assertAllowedChat\(req\.chat_id\)/)
    expect(s).toContain('⌛ No answer in time, so Codex was told no.')
  })
})
