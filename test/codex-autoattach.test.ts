// DIVE-5504 item 4: a Codex reply that NAMES an eligible file attaches it once,
// through Claude's autoattach contract (DIVE-4280), on both the dispatcher
// outbox and the MCP reply tool. The negative arms are the load-bearing ones:
// ~/.codex/auth.json holds the seat's ChatGPT tokens, and an explicit
// [[5dive-attachment:…]] directive used to bypass every exclusion.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDenied } from '../plugins/telegram-codex/autoattach.ts'
import { TurnAttachMemo, planOutboxAttachments } from '../plugins/telegram-codex/outbox-attach.ts'

const root = join(import.meta.dir, '..', 'plugins')
let HOME = ''
let W = ''
const touch = (p: string, bytes = 16) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'.repeat(bytes)); return p }

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'dive5504-attach-'))
  HOME = join(base, 'home', 'agent-cdx')
  W = join(HOME, 'work')
  touch(join(W, 'report.md'))
  touch(join(W, 'chart.png'))
  touch(join(W, 'script.sh'))
  touch(join(HOME, '.codex', 'auth.json'))
  touch(join(HOME, '.codex', 'channels', 'telegram', 'access.json'))
})
afterAll(() => { rmSync(join(HOME, '..', '..'), { recursive: true, force: true }) })

// The tmp base sits under /tmp, an allowed root, so isDenied's allowlist passes.
describe('the codex fork of autoattach', () => {
  test('differs from Claude\'s only by denying .codex (plus its header)', () => {
    const claude = readFileSync(join(root, 'telegram', 'autoattach.ts'), 'utf8')
    const codex = readFileSync(join(root, 'telegram-codex', 'autoattach.ts'), 'utf8')
    const body = codex.split('\n').slice(4).join('\n')
    expect(body).toBe(claude.replace(
      "new Set(['.claude', '.ssh',", "new Set(['.claude', '.codex', '.ssh',"))
    expect(body).not.toBe(claude)
  })

  test('~/.codex/auth.json and the bridge access file are never eligible', () => {
    expect(isDenied(join(HOME, '.codex', 'auth.json'), HOME)).toBe(true)
    expect(isDenied(join(HOME, '.codex', 'channels', 'telegram', 'access.json'), HOME)).toBe(true)
    expect(isDenied(join(W, 'report.md'), HOME)).toBe(false)
  })
})

describe('dispatcher outbox: what a reply sends', () => {
  test('a named .md report and image attach; code is not an artefact; the receipt names them', () => {
    const memo = new TurnAttachMemo()
    const p = planOutboxAttachments(`Done: ${W}/report.md and \`${W}/chart.png\`. Ran ${W}/script.sh.`, [], '42:turn-1', memo, { home: HOME })
    expect(p.send).toEqual([`${W}/report.md`, `${W}/chart.png`])
    expect(p.receipt).toBe('attached: report.md, chart.png')
    expect(p.footer).toBe('')
  })

  test('ONCE per turn: a second message of the same turn naming it sends nothing; the next turn may', () => {
    const memo = new TurnAttachMemo()
    expect(planOutboxAttachments(`see ${W}/report.md`, [], '42:t1', memo, { home: HOME }).send).toHaveLength(1)
    expect(planOutboxAttachments(`as I said, ${W}/report.md`, [], '42:t1', memo, { home: HOME }).send).toEqual([])
    expect(planOutboxAttachments(`updated ${W}/report.md`, [], '42:t2', memo, { home: HOME }).send).toHaveLength(1)
  })

  test('an explicit directive and a mention of the same file send it once', () => {
    const p = planOutboxAttachments(`Report: ${W}/report.md`, [`${W}/report.md`], '42:t', new TurnAttachMemo(), { home: HOME })
    expect(p.send).toEqual([`${W}/report.md`])
  })

  test('NEGATIVE: naming credentials attaches nothing; an explicit directive to them is refused and said so', () => {
    const named = planOutboxAttachments(`token is in ${HOME}/.codex/auth.json`, [], '42:t', new TurnAttachMemo(), { home: HOME })
    expect(named.send).toEqual([])
    const explicit = planOutboxAttachments('here', [`${HOME}/.codex/auth.json`, `${W}/missing.pdf`], '42:t', new TurnAttachMemo(), { home: HOME })
    expect(explicit.send).toEqual([])
    expect(explicit.footer).toBe('not sent (protected or missing): auth.json, missing.pdf')
    expect(explicit.receipt).toBe('')
  })

  test('at most five auto-attachments; the rest are counted in the footer', () => {
    const many = Array.from({ length: 7 }, (_, i) => touch(join(W, `r${i}.md`)))
    const p = planOutboxAttachments(many.join(' '), [], '42:t', new TurnAttachMemo(), { home: HOME })
    expect(p.send).toHaveLength(5)
    expect(p.footer).toBe('+2 more files named; ask for one by name')
  })
})

describe('wiring', () => {
  const server = readFileSync(join(root, 'telegram-codex', 'server.ts'), 'utf8')
  test('the outbox plans once per file (kept across retries) and the MCP reply auto-attaches with a receipt', () => {
    expect(server).toMatch(/let plan = outboxAttachPlans\.get\(name\)/)
    expect(server).toContain('for (const file of files)')
    expect(server).toContain('const autoPlan = planAutoAttach(text, { already: files })')
    expect(server).toContain('for (const f of [...files, ...autoPlan.attach])')
    expect(server).toMatch(/autoNames \? `; \$\{autoNames\}` : ''/)
  })
  test('both new modules ship in the package', () => {
    const files = JSON.parse(readFileSync(join(root, 'telegram-codex', 'package.json'), 'utf8')).files
    expect(files).toEqual(expect.arrayContaining(['approvals.ts', 'autoattach.ts', 'outbox-attach.ts']))
  })
})
