// DIVE-8464: app-server skips untrusted hooks (measured on Codex 0.169), so the
// dispatcher trusts exactly the hook commands 5dive-agent-start wired.
import { describe, expect, test } from 'bun:test'
import { hooksToTrust, parseTrustList, trustWiredHooks } from '../plugins/telegram-codex/hook-trust'

const CFG = '/home/agent-x/.codex/config.toml'
const guard = 'bun /var/lib/5dive/plugins/enabled/email@m/hooks/codex-mail-guard.ts'
const hook = (over: Record<string, unknown>) => ({ key: `${CFG}:pre_tool_use:0:0`, command: guard, source: 'user', sourcePath: CFG, currentHash: 'sha256:aa', trustStatus: 'untrusted', ...over })
const listed = (...hooks: unknown[]) => ({ data: [{ cwd: '/w', hooks }] })

describe('codex hook trust', () => {
  test('T1 a wired, untrusted hook from the seat config is trusted at its current hash', () => {
    expect(hooksToTrust(listed(hook({})), [guard], CFG)).toEqual([{ key: `${CFG}:pre_tool_use:0:0`, hash: 'sha256:aa' }])
  })
  test('T2 anything not wired, from another file, already trusted, or with a hostile key is left alone', () => {
    expect(hooksToTrust(listed(hook({ command: 'bun /tmp/evil.ts' })), [guard], CFG)).toEqual([])
    expect(hooksToTrust(listed(hook({ sourcePath: '/w/.codex/config.toml' })), [guard], CFG)).toEqual([])
    expect(hooksToTrust(listed(hook({ source: 'project' })), [guard], CFG)).toEqual([])
    expect(hooksToTrust(listed(hook({ trustStatus: 'trusted' })), [guard], CFG)).toEqual([])
    expect(hooksToTrust(listed(hook({ key: 'a"].x = 1 #' })), [guard], CFG)).toEqual([])
    expect(hooksToTrust(listed(hook({})), [], CFG)).toEqual([])
  })
  test('T3 the trust list parses only an array of strings', () => {
    expect(parseTrustList(JSON.stringify([guard, 3, '']))).toEqual([guard])
    expect(parseTrustList('{bad')).toEqual([])
    expect(parseTrustList(undefined)).toEqual([])
  })
  test('T4 trustWiredHooks writes hooks.state.<key>.trusted_hash through config/value/write', async () => {
    const calls: [string, any][] = []
    const rpc = { request: async (m: string, p: any) => { calls.push([m, p]); return m === 'hooks/list' ? listed(hook({}), hook({ key: `${CFG}:pre_tool_use:1:0`, command: 'bun /tmp/x.ts' })) : { status: 'ok' } } }
    expect(await trustWiredHooks(rpc, { wired: [guard], configPath: CFG, cwd: '/w' })).toBe(1)
    expect(calls[1]).toEqual(['config/value/write', { keyPath: `hooks.state."${CFG}:pre_tool_use:0:0".trusted_hash`, value: 'sha256:aa', mergeStrategy: 'replace' }])
    expect(calls.length).toBe(2)
  })
  test('T5 nothing wired, nothing asked of Codex', async () => {
    let n = 0
    expect(await trustWiredHooks({ request: async () => { n++; return {} } }, { wired: [], configPath: CFG, cwd: '/w' })).toBe(0)
    expect(n).toBe(0)
  })
})
