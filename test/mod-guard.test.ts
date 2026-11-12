// The `mod` plugin's tool-call GUARD (DIVE-4696).
//
// WHAT A POLICY OWES THIS FILE, AND WHY IT IS TWO ARMS AND NOT ONE. A deny list is
// graded in both directions or it is not graded. The arm everyone writes is "the bad
// input is refused"; the arm that actually decides whether a policy can ship is the
// MUTANT — the nearly identical GOOD input that must run untouched. A guard sits on
// the path of every tool call on the seat, so a policy that also refuses good work is
// not a stricter guard, it is an outage with a reason attached. Every `describe` below
// carries both, and the good-input arm is written as the smallest edit to the bad one
// that makes it legitimate.
//
// The evaluator is pure (`hooks/guard.ts` takes no `$`, does no I/O), so all of this
// runs under `bun test` with no Claude Code and no engine stub. The wiring — the gate,
// the one `$.fs.read`, the single call site — is graded from the source in
// test/mod-telemetry.test.ts, which is where this plugin's structural assertions live.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile, envSet, evaluate, filesWanted, POLICY_SCHEMA } from '../plugins/mod/hooks/guard'

const ROOT = join(import.meta.dir, '..', 'plugins', 'mod')
const DOC = JSON.parse(readFileSync(join(ROOT, 'policy', 'guard.json'), 'utf8'))

/** The policies as the plugin will actually run them. */
const SHIPPED = compile(DOC)

/** No env: the default seat. Every policy's escape hatch is closed here. */
const NO_ENV: Record<string, unknown> = {}

// THE EVENT SHAPE, MEASURED (2026-09-20, Claude Code 2.1.278) AND NOT INFERRED.
//
// A `tool.call` event is the tool's own arguments spread at the TOP LEVEL, plus `tool`
// and `tool_use_id`. There is no `e.input`. The first draft of this guard read
// `e.input`, because the neighbouring `$.tool.check` call really does take
// `{ tool, input }` — and with `e.input` undefined every policy saw an empty subject,
// so the guard loaded, compiled its six policies, and denied nothing. It passed every
// arm in this file, because every arm built the input the way the draft read it.
//
// So the fixtures below are built from the OBSERVED payload, `tool_use_id` and all,
// and `EVENT_KEYS` pins the observation itself. If a Claude Code release moves the
// arguments under a key, this is the arm that says so.
const EVENT_KEYS = ['command', 'description', 'tool', 'tool_use_id']

const write = (file_path: string, content: string) => ({
  tool: 'Write',
  input: { file_path, content, tool: 'Write', tool_use_id: 'toolu_01' },
})
const edit = (file_path: string, new_string: string) => ({
  tool: 'Edit',
  input: { file_path, old_string: '', new_string, tool: 'Edit', tool_use_id: 'toolu_01' },
})
const bash = (command: string) => ({
  tool: 'Bash',
  input: { command, description: 'a command', tool: 'Bash', tool_use_id: 'toolu_01' },
})

/** The policy id that refused, or null. */
const verdict = (call: { tool: string; input: unknown }, env = NO_ENV) =>
  evaluate(SHIPPED, call, env)?.policy ?? null

// ---------------------------------------------------------------------------

describe('the shipped policy document', () => {
  test('compiles with ZERO drops', () => {
    // A dropped policy is a rule the seat believes it is enforcing and is not. The
    // drop is deliberately not fatal (see hooks/guard.ts), which is exactly why the
    // shipped file has to be asserted clean here rather than discovered at runtime.
    expect(SHIPPED.drops).toEqual([])
    expect(SHIPPED.policies.length).toBe(DOC.policies.length)
    expect(DOC.v).toBe(POLICY_SCHEMA)
  })

  test('every policy names the written rule it replaces', () => {
    // The row's test: a policy that ships without deleting its prose has moved
    // nothing. `rule` is the pointer that makes the deletion checkable by a reader.
    for (const p of DOC.policies) {
      expect(typeof p.rule).toBe('string')
      expect(p.rule.length).toBeGreaterThan(0)
      expect(p.deny).toContain('{rule}')
    }
  })

  test('every deny reason says what to do instead, not just no', () => {
    // A deny reaches the MODEL. "Refused by policy" produces a retry; a reason
    // produces the right call. The cheap proxy for that is length plus the rule.
    for (const p of DOC.policies) expect(p.deny.length).toBeGreaterThan(80)
  })
})

describe('policy: pii-fixture — a real identifier in a test fixture', () => {
  const FIXTURE = 'test/telegram.test.ts'

  test('a real Telegram id in a fixture is refused', () => {
    expect(verdict(write(FIXTURE, 'const chat_id = 5551234567'))).toBe('pii-fixture')
  })

  test('MUTANT: the reserved fake 1234567890 is not', () => {
    expect(verdict(write(FIXTURE, 'const chat_id = 1234567890'))).toBeNull()
  })

  test('a real email in a fixture is refused', () => {
    expect(verdict(write(FIXTURE, 'from: "someone@gmail.com"'))).toBe('pii-fixture')
  })

  test('MUTANT: @example.com is not', () => {
    expect(verdict(write(FIXTURE, 'from: "someone@example.com"'))).toBeNull()
  })

  test('a routable IP in a fixture is refused', () => {
    expect(verdict(write(FIXTURE, 'host = "95.216.4.19"'))).toBe('pii-fixture')
  })

  test('MUTANT: the RFC 5737 documentation range is not', () => {
    expect(verdict(write(FIXTURE, 'host = "192.0.2.19"'))).toBeNull()
    expect(verdict(write(FIXTURE, 'host = "127.0.0.1"'))).toBeNull()
  })

  // DIVE-4720. The residual DIVE-4696 recorded and did not fix: with the guard off on
  // every seat a version-shaped literal only cost the verifier a note, but ON BY
  // DEFAULT it is a fleet-wide refusal of legitimate writes — this repo's own tests
  // pin Claude Code releases by number. The narrowing is octet VALIDITY plus the two
  // boundaries, all three in `find`, so it stays an ops edit with no plugin release.
  test('MUTANT: a four-part version literal is not an IP address', () => {
    // The exact string named in docs/mod-guard.md's residual list.
    expect(verdict(write(FIXTURE, 'const V = "2.1.278.0"'))).toBeNull()
    // 278 is not an octet, and neither is 300 or 999.
    expect(verdict(write(FIXTURE, 'expect(v).toBe("2.1.300.4")'))).toBeNull()
    expect(verdict(write(FIXTURE, 'VERIFIED_AGAINST = "999.1.2.3"'))).toBeNull()
  })

  test('MUTANT: a v-prefixed or five-part version is not an IP address', () => {
    expect(verdict(write(FIXTURE, 'tag = "v2.1.27.0"'))).toBeNull()
    expect(verdict(write(FIXTURE, 'build = "1.2.3.4.5"'))).toBeNull()
    expect(verdict(write(FIXTURE, 'rel = "2.1.27.0-rc1"'))).toBeNull()
  })

  test('the narrowing did not cost the policy a real address', () => {
    // The whole point of an exclusion is that it excludes ONLY what it names. These
    // are the shapes the check exists for, re-asserted at the new regex.
    expect(verdict(write(FIXTURE, 'host = "95.216.4.19"'))).toBe('pii-fixture')
    expect(verdict(write(FIXTURE, 'dns = "8.8.8.8"'))).toBe('pii-fixture')
    expect(verdict(write(FIXTURE, 'box: 65.109.1.2'))).toBe('pii-fixture')
  })

  test('the seat-level escape hatch exists and is named', () => {
    // On by default means a false positive must have a one-setting exit that is not
    // "edit the shared policy file". Every other policy carries one; this one did not.
    expect(
      verdict(write(FIXTURE, 'host = "95.216.4.19"'), {
        FIVEDIVE_MOD_GUARD_ALLOW_FIXTURE_ID: '1',
      }),
    ).toBeNull()
  })

  test('MUTANT: the same content OUTSIDE a fixture path is not this policy’s business', () => {
    // The rule is about what a FIXTURE contains. Product code legitimately carries a
    // real address, a real host and a real id; a guard that could not tell the two
    // apart would refuse the feature as well as the fixture.
    expect(verdict(write('src/telegram.ts', 'const chat_id = 5551234567'))).toBeNull()
    expect(verdict(write('src/telegram.ts', 'from: "someone@gmail.com"'))).toBeNull()
  })

  test('it reads an Edit the same way it reads a Write', () => {
    // Edit is how a fixture actually gets a bad value: the file exists and one line
    // changes. A policy that only looked at Write would be a rail with a hole in it.
    expect(verdict(edit(FIXTURE, 'chat_id: 5551234567'))).toBe('pii-fixture')
    expect(verdict(edit(FIXTURE, 'chat_id: 1234567890'))).toBeNull()
  })

  test('the reason names the named default, not just the refusal', () => {
    const v = evaluate(SHIPPED, write(FIXTURE, 'const chat_id = 5551234567'), NO_ENV)
    expect(v?.check).toBe('telegram-id')
    expect(v?.reason).toContain('1234567890')
    expect(v?.reason).toContain(FIXTURE)
  })
})

describe('policy: no-verify — bypassing the pre-push guards', () => {
  test('a push with --no-verify is refused', () => {
    expect(verdict(bash('git push --no-verify'))).toBe('no-verify')
  })

  test('a commit with --no-verify is refused, including mid-chain', () => {
    expect(verdict(bash('git commit -m "wip" --no-verify'))).toBe('no-verify')
    expect(verdict(bash('cd /tmp/wt && git push origin hp --no-verify'))).toBe('no-verify')
  })

  test('MUTANT: the same push without the flag runs', () => {
    expect(verdict(bash('git push origin dive-4696-mod-guard'))).toBeNull()
    expect(verdict(bash('git commit -m "wip"'))).toBeNull()
  })

  test('MUTANT: TALKING about --no-verify is not doing it', () => {
    // The guard reads a command line, and a command line frequently quotes the rule
    // it is about to obey. `grep`, `echo` and a heredoc writing this very file all
    // contain the flag and none of them bypass anything.
    expect(verdict(bash('grep -rn -- "--no-verify" docs/'))).toBeNull()
    expect(verdict(bash('echo "do not --no-verify past the PII guard"'))).toBeNull()
  })

  test('the seat can open it deliberately, and only deliberately', () => {
    const on = { FIVEDIVE_MOD_GUARD_ALLOW_NO_VERIFY: '1' }
    expect(verdict(bash('git push --no-verify'), on)).toBeNull()
    // "=0" is what somebody writes when they mean OFF. An escape hatch that opens on
    // any value at all is one typo from being permanently open.
    expect(verdict(bash('git push --no-verify'), { FIVEDIVE_MOD_GUARD_ALLOW_NO_VERIFY: '0' })).toBe(
      'no-verify',
    )
    expect(verdict(bash('git push --no-verify'), { FIVEDIVE_MOD_GUARD_ALLOW_NO_VERIFY: '' })).toBe(
      'no-verify',
    )
  })
})

describe('policy: smoke-attestation — forging the smoke-verified label', () => {
  test('applying the label is refused', () => {
    expect(verdict(bash('gh pr edit 149 --add-label smoke-verified'))).toBe('smoke-attestation')
    expect(
      verdict(bash('5dive gh api -X POST repos/lodar/5dive-api/issues/149/labels -f labels=smoke-verified')),
    ).toBe('smoke-attestation')
  })

  test('MUTANT: smoke-override, the documented other exit, is not touched', () => {
    // The rules file names TWO honest exits. A guard that refused both would push the
    // next provisioning change onto the third, undocumented one.
    expect(verdict(bash('gh pr edit 149 --add-label smoke-override'))).toBeNull()
  })

  test('MUTANT: naming the label without applying it is not applying it', () => {
    expect(verdict(bash('echo "never apply smoke-verified when the smoke did not run"'))).toBeNull()
    expect(verdict(bash('gh pr view 149 --json labels'))).toBeNull()
  })

  test('a recorded receipt is what makes the attestation have an author', () => {
    const on = { FIVEDIVE_MOD_GUARD_SMOKE_RECEIPT: '41603fea' }
    expect(verdict(bash('gh pr edit 149 --add-label smoke-verified'), on)).toBeNull()
  })
})

describe('policy: runtime-store — writing the runtime’s own state by hand', () => {
  test('a direct write into the store or the audit log is refused', () => {
    expect(verdict(write('/var/lib/5dive/state.json', '{}'))).toBe('runtime-store')
    expect(verdict(write('/var/log/5dive/audit.log', 'x'))).toBe('runtime-store')
    expect(verdict(write('/home/claude/projects/5dive/tasks.db', 'x'))).toBe('runtime-store')
  })

  test('MUTANT: the mod’s own per-seat sink is not the runtime store', () => {
    // This one is the near miss that matters: the sink path also begins with a dot-5dive
    // directory, and an earlier draft of the path list caught it. The plugin refusing
    // its own telemetry would have looked exactly like the sink being broken.
    expect(verdict(write('/home/agent-dev/.5dive/mod-telemetry/dev-s1.jsonl', '{}'))).toBeNull()
  })

  test('MUTANT: ordinary source and a worktree file are untouched', () => {
    expect(verdict(write('plugins/mod/hooks/guard.ts', 'x'))).toBeNull()
    expect(verdict(write('/home/claude/projects/5dive/plugins-4696-dev/README.md', 'x'))).toBeNull()
  })

  test('it judges the PATH, so the file’s content is irrelevant', () => {
    const v = evaluate(SHIPPED, write('/var/lib/5dive/state.json', ''), NO_ENV)
    expect(v?.check).toBe('protected-path')
    expect(v?.reason).toContain('/var/lib/5dive/state.json')
  })
})

describe('policy: destructive-outside-workdir', () => {
  test('a recursive delete of a host path or a seat’s config is refused', () => {
    expect(verdict(bash('rm -rf /var/lib/5dive'))).toBe('destructive-outside-workdir')
    expect(verdict(bash('rm -rf /etc/5dive'))).toBe('destructive-outside-workdir')
    expect(verdict(bash('rm -rf ~/.claude'))).toBe('destructive-outside-workdir')
    expect(verdict(bash('rm -rf /home/agent-main/.ssh'))).toBe('destructive-outside-workdir')
  })

  test('MUTANT: a relative delete inside the worktree runs', () => {
    // This is the arm that decides whether the policy is shippable at all: clearing
    // node_modules and a build directory is ordinary work on every seat, every day.
    expect(verdict(bash('rm -rf node_modules'))).toBeNull()
    expect(verdict(bash('rm -rf ./build .next'))).toBeNull()
    expect(verdict(bash('rm -f /tmp/scratch.log'))).toBeNull()
  })

  test('MUTANT: a NON-recursive delete is not this policy’s business', () => {
    expect(verdict(bash('rm /var/lib/5dive/stale.lock'))).toBeNull()
  })

  test('`git clean -f` in a shared checkout is refused, `-n` is not', () => {
    // The dry run is how you find out what it would delete. Refusing that would be
    // refusing the safe way to answer the question.
    expect(verdict(bash('git clean -fd'))).toBe('destructive-outside-workdir')
    expect(verdict(bash('git clean -xdf'))).toBe('destructive-outside-workdir')
    expect(verdict(bash('git clean -n'))).toBeNull()
    expect(verdict(bash('git clean --dry-run'))).toBeNull()
  })
})

describe('policy: external-reply — publishing under an identity that is not yours', () => {
  test('a comment on a repo we do not own is refused', () => {
    expect(verdict(bash('gh pr comment 4 --repo someorg/somerepo --body "hi"'))).toBe(
      'external-reply',
    )
    expect(verdict(bash('gh issue comment 9 -R otherorg/tool --body "hi"'))).toBe('external-reply')
  })

  test('MUTANT: our own repositories are not', () => {
    expect(verdict(bash('gh pr comment 96 --repo 5dive-ai/5dive-plugins --body "hi"'))).toBeNull()
    expect(verdict(bash('gh pr comment 155 --repo lodar/5dive-api --body "hi"'))).toBeNull()
  })

  test('MUTANT: READING a foreign repository is not publishing on it', () => {
    // The identity cap is about what goes OUT. Cloning, viewing and checking out a
    // third-party repo is how most research on this fleet starts.
    expect(verdict(bash('gh pr view 4 --repo someorg/somerepo --json body'))).toBeNull()
    expect(verdict(bash('gh repo clone someorg/somerepo'))).toBeNull()
  })

  test('a per-thread approval is what opens it', () => {
    const on = { FIVEDIVE_MOD_GUARD_EXTERNAL_REPLY_APPROVED: 'DIVE-4696' }
    expect(verdict(bash('gh pr comment 4 --repo someorg/somerepo --body "hi"'), on)).toBeNull()
  })
})

describe('policy: openrouter-key-mint — a new OpenRouter key for a test run', () => {
  const MINT = `ssh -p 26220 root@host 'set -a; . /etc/5dive/api.env; curl -s -X POST https://openrouter.ai/api/v1/keys -H "Authorization: Bearer $OPENROUTER_MASTER_KEY_5DIVE" -d "{\\"name\\":\\"qa\\",\\"limit\\":3}"'`

  test('minting a key against the OpenRouter keys API is refused', () => {
    expect(verdict(bash(MINT))).toBe('openrouter-key-mint')
    expect(verdict(bash('curl https://openrouter.ai/api/v1/keys --json \'{"name":"bench"}\''))).toBe('openrouter-key-mint')
    expect(verdict(bash(`node -e "fetch('https://openrouter.ai/api/v1/keys',{method:'POST'})"`))).toBe('openrouter-key-mint')
  })

  test('raising an existing key is refused too: it spends the same balance', () => {
    expect(verdict(bash('curl -X PATCH https://openrouter.ai/api/v1/keys/abc -d \'{"limit":6}\''))).toBe('openrouter-key-mint')
  })

  test('the master key with a base-URL variable is still a mint', () => {
    expect(verdict(bash('curl -X POST "$OR_BASE/api/v1/keys" -H "Authorization: Bearer $OPENROUTER_MASTER_KEY_X"'))).toBe('openrouter-key-mint')
  })

  test('MUTANT: reading the balance, listing keys and deleting a key stay open', () => {
    expect(verdict(bash('curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OPENROUTER_MASTER_KEY_5DIVE"'))).toBeNull()
    expect(verdict(bash('curl -s https://openrouter.ai/api/v1/keys -H "Authorization: Bearer $OPENROUTER_MASTER_KEY_5DIVE" | jq .data'))).toBeNull()
    expect(verdict(bash('curl -s -X DELETE https://openrouter.ai/api/v1/keys/abc -H "Authorization: Bearer $OPENROUTER_MASTER_KEY_5DIVE"'))).toBeNull()
  })

  test('MUTANT: a chat call on an existing key is not a mint', () => {
    expect(verdict(bash('curl https://openrouter.ai/api/v1/chat/completions -d \'{"model":"x"}\''))).toBeNull()
  })

  test('the seat can open it deliberately, and only deliberately', () => {
    expect(verdict(bash(MINT), { FIVEDIVE_MOD_GUARD_ALLOW_OPENROUTER_MINT: '1' })).toBeNull()
    expect(verdict(bash(MINT), { FIVEDIVE_MOD_GUARD_ALLOW_OPENROUTER_MINT: '0' })).toBe('openrouter-key-mint')
  })

  test('the reason names what to use instead', () => {
    const r = evaluate(SHIPPED, bash(MINT), NO_ENV)?.reason ?? ''
    expect(r).toContain('Claude plan')
    expect(r).toContain('emergency-api')
  })
})

// DIVE-7673 (lodar 11-04, on DIVE-7667's gate «… needs up to $15 more on OpenRouter; $1.65 is left. Raise the
// limit by $15?»: "you burned my OR again?? … now im furious"). The key-mint rule kept the seat from raising
// the key itself, so it asked HIM to. Asking is the same spend; the mutant is a gate that only NAMES OpenRouter.
describe('policy: openrouter-spend-ask — a gate or row asking lodar to fund OpenRouter', () => {
  const ASKED = `5dive task need DIVE-7667 --type=approval --ask="The Grok arm needs up to $15 more on OpenRouter; $1.65 is left. Raise the limit by $15?" --recommend=approve`
  const ASK_FILE = '/tmp/scratch/7667-ask.txt'
  const withFiles = (command: string, files: Record<string, string>) => ({ ...bash(command), files })

  test("DIVE-7667's own gate, word for word, is refused", () => {
    expect(verdict(bash(ASKED))).toBe('openrouter-spend-ask')
    expect(verdict(bash('5dive task need X --type=approval --ask="Raise the OpenRouter limit by $15?"'))).toBe('openrouter-spend-ask')
  })

  test('the other ways of asking for the money are refused too', () => {
    for (const ask of [
      'Top up OpenRouter with $10 for the bench?',
      'Increase the openrouter key cap so the matrix can finish?',
      'The bench needs more OpenRouter credits. OK?',
      'OPENROUTER budget: bump it for tonight?',
    ]) expect([ask, verdict(bash(`sudo 5dive task need DIVE-1 --type=decision --ask="${ask}"`))]).toEqual([ask, 'openrouter-spend-ask'])
    expect(verdict(bash(`5dive task add "Raise the OpenRouter limit by $20 for the bench" --priority=high`))).toBe('openrouter-spend-ask')
  })

  test('an --ask-file is judged on the file it names, every spelling of the flag', () => {
    const files = { [ASK_FILE]: 'The bench needs $15 more on OpenRouter. Raise the limit?' }
    expect(evaluate(SHIPPED, withFiles(`5dive task need X --type=approval --ask-file=${ASK_FILE}`, files), NO_ENV)?.policy).toBe('openrouter-spend-ask')
    expect(evaluate(SHIPPED, withFiles(`5dive task need X --type=approval --ask-file "${ASK_FILE}"`, files), NO_ENV)?.policy).toBe('openrouter-spend-ask')
    expect(evaluate(SHIPPED, withFiles(`5dive task add "Grok bench" --priority=high --body-file='${ASK_FILE}'`, files), NO_ENV)?.policy).toBe('openrouter-spend-ask')
    // The hook reads exactly the named file, for this policy only.
    expect(filesWanted(SHIPPED, bash(`5dive task need X --ask-file=${ASK_FILE} --recommend-file=- && echo done`), NO_ENV)).toEqual([ASK_FILE])
    expect(filesWanted(SHIPPED, bash('cat /etc/hosts'), NO_ENV)).toEqual([])
    expect(filesWanted(SHIPPED, bash(`5dive task need X --ask-file=${ASK_FILE}`), { FIVEDIVE_MOD_GUARD_ALLOW_OPENROUTER_MINT: '1' })).toEqual([])
  })

  test('MUTANT: the same --ask-file with a harmless ask, or a file that did not read, runs', () => {
    const cmd = `5dive task need X --type=approval --ask-file=${ASK_FILE}`
    expect(evaluate(SHIPPED, withFiles(cmd, { [ASK_FILE]: "Customer's OpenRouter key shows an error. Reply?" }), NO_ENV)).toBeNull()
    expect(evaluate(SHIPPED, withFiles(cmd, {}), NO_ENV)).toBeNull()
  })

  test('MUTANT: a gate or row that only NAMES OpenRouter stays open', () => {
    for (const ask of [
      "Customer's OpenRouter key shows an error, reply?",
      "Customer's OpenRouter credit ran out. What do we tell them?",
      "Customer can't top up OpenRouter from the AI tab. Reply?",
      'Offer OpenRouter as a model option on the box?',
    ]) expect([ask, verdict(bash(`5dive task need DIVE-1 --type=decision --ask="${ask}"`))]).toEqual([ask, null])
    expect(verdict(bash(`5dive task add "Show the OpenRouter credit balance on the AI tab" --priority=high`))).toBeNull()
  })

  test('MUTANT: the money words without OpenRouter, or OpenRouter money outside a gate or row, are not this policy', () => {
    expect(verdict(bash('5dive task need X --type=approval --ask="Raise the Hetzner limit by $15?"'))).toBeNull()
    expect(verdict(bash('echo "Raise the OpenRouter limit by $15?" > notes.md'))).toBeNull()
    expect(verdict(bash('curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OPENROUTER_MASTER_KEY_5DIVE"'))).toBeNull()
  })

  test("the seat can open it deliberately, with the key-mint rule's own setting", () => {
    expect(verdict(bash(ASKED), { FIVEDIVE_MOD_GUARD_ALLOW_OPENROUTER_MINT: '1' })).toBeNull()
    expect(verdict(bash(ASKED), { FIVEDIVE_MOD_GUARD_ALLOW_OPENROUTER_MINT: '0' })).toBe('openrouter-spend-ask')
  })

  test('the reason says asking is the same spend, and what to use instead', () => {
    const r = evaluate(SHIPPED, bash(ASKED), NO_ENV)?.reason ?? ''
    expect(r).toContain('same spend')
    expect(r).toContain('Claude plan')
    expect(r).toContain('emergency-api')
    expect(r).toContain("product's own login")
  })
})

describe('engine: require_flags and file_args (DIVE-7673)', () => {
  const doc = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    compile({ v: POLICY_SCHEMA, policies: [{ id: 'p', rule: 'r', tools: ['Bash'], text_keys: ['command'], deny: 'd {found}', ...extra, checks: [{ id: 'c', say: 's', ...check }] }] })

  test('require_flags applies to require_all only; without it they stay case-sensitive', () => {
    expect(evaluate(doc({ find: 'go', require_all: ['boom'], require_flags: 'i' }), bash('go BOOM'), NO_ENV)?.policy).toBe('p')
    expect(evaluate(doc({ find: 'go', require_all: ['boom'] }), bash('go BOOM'), NO_ENV)).toBeNull()
    expect(evaluate(doc({ find: 'go', require_all: ['boom'], require_flags: 'i' }), bash('GO boom'), NO_ENV)).toBeNull()
  })

  test('a policy without file_args never asks for a file, and a bad file_args regex drops its policy', () => {
    expect(filesWanted(doc({ find: 'x' }), bash('x --ask-file=/a'), NO_ENV)).toEqual([])
    const bad = doc({ find: 'x' }, { file_args: ['(['] })
    expect(bad.policies).toEqual([])
    expect(bad.drops[0]!.policy).toBe('p')
  })
})

// DIVE-8299 (lodar 11-12 13:53Z, after poke-two froze: «why quinn and dev didn't use ci server for tests - why
// we have this issue again»). Two seats ran `npx tsc --noEmit -p .` on the frontend at once, ~1-1.4 GB each,
// and every seat went silent 7 minutes. The prose banned full suites and next build, not tsc; prose has now
// failed three times on this box. The mutants are the targeted forms the same rule TELLS a seat to use.
describe('policy: heavy-local — whole-project typecheck, next build/dev and full suites on poke-two', () => {
  const POKE = 'poke-two'
  const on = (command: string, host: string = POKE, env = NO_ENV) =>
    evaluate(SHIPPED, { ...bash(command), host }, env)?.policy ?? null
  const checkOf = (command: string) => evaluate(SHIPPED, { ...bash(command), host: POKE }, NO_ENV)?.check ?? null

  test("the incident's own command, both seats' spelling, is refused", () => {
    expect(on('npx tsc --noEmit -p .')).toBe('heavy-local')
    expect(on('cd /home/claude/projects/5dive/app && npx tsc --noEmit -p . 2>&1 | tail -30; echo tsc-done')).toBe('heavy-local')
    expect(checkOf('npx tsc --noEmit -p .')).toBe('whole-project-tsc')
  })

  test('every whole-project typecheck spelling is refused', () => {
    for (const c of [
      'npx tsc --noEmit',
      'tsc --noEmit',
      'tsc',
      'bunx tsc --noEmit',
      'npx -y tsc --noEmit --pretty false',
      './node_modules/.bin/tsc --noEmit -p tsconfig.json',
      'npx tsc --project tsconfig.app.json',
      'npx tsc -b',
      'timeout 600 npx tsc --noEmit 2>&1 | tail -20',
      'FIVEDIVE_KEEP_ALIVE=1 nice -n 19 npx tsc --noEmit -p . > /tmp/tsc.log',
      'bash -c "npx tsc --noEmit"',
      'set -e\ncd app\nnpx tsc --noEmit',
      'npm run typecheck',
      'npm --prefix app run type-check',
      'bun run typecheck',
      'pnpm typecheck',
      'yarn tsc',
    ]) {
      expect([c, on(c)]).toEqual([c, 'heavy-local'])
    }
  })

  test('next build and next dev are refused, bare or through a Next app\'s npm script', () => {
    for (const c of [
      'npx next build',
      'next dev',
      'cd app && npx next dev -p 3005',
      'bunx next build',
      'cd /home/claude/projects/5dive/app && npm run build',
      'cd ~/wt/fe-8293 && npm run dev',
      'npm --prefix /home/claude/projects/5dive/agent-profile run build',
    ]) {
      expect([c, on(c)]).toEqual([c, 'heavy-local'])
    }
  })

  test('a full suite — a test runner with no test file after it — is refused', () => {
    for (const c of [
      'npm test',
      'npm run test',
      'npm t',
      'bun test',
      'bun test --timeout 20000',
      'npm test -- --watch=false',
      'npm test 2>&1 | tail -40',
      'pnpm test',
      'yarn test',
      'node --test',
      "node --import tsx --test 'src/**/*.test.ts'",
      'cd x && bun run test',
    ]) {
      expect([c, on(c)]).toEqual([c, 'heavy-local'])
    }
  })

  test('MUTANT: the targeted forms the rule tells a seat to use all run', () => {
    for (const c of [
      'node --test src/x.test.ts',
      'node --import tsx --test src/lib/foo.test.ts',
      'node --import tsx --experimental-test-module-mocks --test src/routes/a.test.ts src/routes/b.test.ts',
      'npm test -- src/lib/x.test.ts',
      'bun test test/mod-guard.test.ts',
      'bun test test/mod-guard.test.ts test/mod-telemetry.test.ts 2>&1 | tail -5',
      'tsc --noEmit src/one-file.ts',
      'npx tsc --noEmit src/a.ts src/b.tsx',
      'npx tsc --version',
      'tsc -v',
    ]) {
      expect([c, on(c)]).toEqual([c, null])
    }
  })

  test('MUTANT: reading, quoting or writing the words is not running them', () => {
    for (const c of [
      'grep -rn "npx tsc --noEmit -p ." docs/',
      "cat package.json | jq -r '.scripts.build' # next build",
      'echo "run npm test before you push"',
      'git commit -m "CHECKED: npx tsc --noEmit -p . on CI, bun test green"',
      '5dive task done DIVE-1 --result="ran npm test on 5dive-ci"',
      'npm run test:unit -- src/x.test.ts',
      'npm install && npm run lint',
      'npm run build',
    ]) {
      expect([c, on(c)]).toEqual([c, null])
    }
  })

  test('MUTANT: the same command sent to 5dive-ci over ssh runs — CI is where it belongs', () => {
    expect(on("ssh 5dive-ci 'cd /srv/app && npx tsc --noEmit -p .'")).toBeNull()
    expect(on('sudo -u claude ssh root@ci "cd app && npm test"')).toBeNull()
  })

  test('it is a poke-two rule: on 5dive-ci, a customer box, or a host it cannot name, it never fires', () => {
    expect(on('npx tsc --noEmit -p .', '5dive-ci')).toBeNull()
    expect(on('npm test', 'wavy-bloom')).toBeNull()
    expect(on('next build', 'poke-two-old')).toBeNull()
    expect(on('npx tsc --noEmit -p .', '')).toBeNull()
    expect(verdict(bash('npx tsc --noEmit -p .'))).toBeNull()
  })

  test('the seat can open it deliberately, and only deliberately', () => {
    expect(on('npm test', POKE, { FIVEDIVE_MOD_GUARD_ALLOW_HEAVY_LOCAL: '1' })).toBeNull()
    expect(on('npm test', POKE, { FIVEDIVE_MOD_GUARD_ALLOW_HEAVY_LOCAL: '0' })).toBe('heavy-local')
  })

  test('the reason says CI runs it, and what to run locally instead', () => {
    const r = evaluate(SHIPPED, { ...bash('npx tsc --noEmit -p .'), host: POKE }, NO_ENV)?.reason ?? ''
    expect(r).toContain('CI runs this — push and let it')
    expect(r).toContain('node --test <file>')
    expect(r).toContain('FIVEDIVE_MOD_GUARD_ALLOW_HEAVY_LOCAL')
  })
})

describe('engine: hosts and unless_any (DIVE-8299)', () => {
  const doc = (extra: Record<string, unknown>, check: Record<string, unknown> = {}) => ({
    v: POLICY_SCHEMA,
    policies: [
      {
        id: 'p',
        rule: 'r',
        tools: ['Bash'],
        text_keys: ['command'],
        ...extra,
        checks: [{ id: 'c', find: 'boom', say: 'boom', ...check }],
        deny: '{found} [{rule}]',
      },
    ],
  })

  test('a policy without hosts applies on every host, the unnamed one included', () => {
    const c = compile(doc({}))
    expect(evaluate(c, bash('boom'), NO_ENV)?.policy).toBe('p')
    expect(evaluate(c, { ...bash('boom'), host: 'anything' }, NO_ENV)?.policy).toBe('p')
  })

  test('hosts scopes it to the named hosts, and a bad hosts regex drops its policy', () => {
    const c = compile(doc({ hosts: ['^a$'] }))
    expect(evaluate(c, { ...bash('boom'), host: 'a' }, NO_ENV)?.policy).toBe('p')
    expect(evaluate(c, { ...bash('boom'), host: 'b' }, NO_ENV)).toBeNull()
    const bad = compile(doc({ hosts: ['('] }))
    expect(bad.policies).toEqual([])
    expect(bad.drops[0]?.policy).toBe('p')
  })

  test('unless_any cancels the check when the subject holds its context', () => {
    const c = compile(doc({}, { unless_any: ['\\bssh\\s'] }))
    expect(evaluate(c, bash('boom'), NO_ENV)?.policy).toBe('p')
    expect(evaluate(c, bash('ssh x boom'), NO_ENV)).toBeNull()
  })
})

describe('the evaluator itself', () => {
  test('the guard reads the event the engine actually sends', () => {
    // The observed Bash payload, verbatim from a 2.1.278 debug log, with nothing
    // renamed and nothing added. A policy has to fire on THIS.
    const observed = {
      command: 'git push --no-verify',
      description: 'Push the branch',
      tool: 'Bash',
      tool_use_id: 'toolu_01JVjyKAk73F5cq4LNa2Sgw6',
    }
    expect(Object.keys(observed).sort()).toEqual([...EVENT_KEYS].sort())
    expect(evaluate(SHIPPED, { tool: 'Bash', input: observed }, NO_ENV)?.policy).toBe('no-verify')
    // ...and the shape the draft ASSUMED must NOT be what makes a policy fire, or the
    // arm above would pass again on the next wrong guess.
    expect(evaluate(SHIPPED, { tool: 'Bash', input: { input: observed } }, NO_ENV)).toBeNull()
  })

  test('a tool no policy names is never touched', () => {
    expect(verdict({ tool: 'Read', input: { file_path: '/var/lib/5dive/state.json' } })).toBeNull()
    expect(verdict({ tool: 'Grep', input: { pattern: 'chat_id = 5551234567' } })).toBeNull()
  })

  test('an input that is not the shape a policy expects is allowed, not refused', () => {
    // Fail open is the contract (see hooks/guard.ts). A tool whose input arrives as
    // null, or with the key missing, must run — an early-access event shape changing
    // under us must not take the seat out.
    expect(verdict({ tool: 'Bash', input: null })).toBeNull()
    expect(verdict({ tool: 'Bash', input: {} })).toBeNull()
    expect(verdict({ tool: 'Write', input: { file_path: 42, content: 7 } })).toBeNull()
  })

  test('a bad regex drops ITS policy and leaves the others enforcing', () => {
    const c = compile({
      v: POLICY_SCHEMA,
      policies: [
        { id: 'broken', rule: 'r', tools: ['Bash'], text_keys: ['command'], deny: 'd {rule}', checks: [{ id: 'x', find: '([', say: 's' }] },
        { id: 'fine', rule: 'r', tools: ['Bash'], text_keys: ['command'], deny: 'd {rule}', checks: [{ id: 'y', find: 'boom', say: 's' }] },
      ],
    })
    expect(c.drops.map((d) => d.policy)).toEqual(['broken'])
    expect(c.policies.map((p) => p.id)).toEqual(['fine'])
    expect(evaluate(c, bash('boom'), NO_ENV)?.policy).toBe('fine')
  })

  test('a policy with no `rule` is dropped: a deny with no written rule is not a policy', () => {
    const c = compile({
      v: POLICY_SCHEMA,
      policies: [{ id: 'ruleless', tools: ['Bash'], text_keys: ['command'], deny: 'no', checks: [{ id: 'y', find: 'boom', say: 's' }] }],
    })
    expect(c.policies).toEqual([])
    expect(c.drops[0]!.policy).toBe('ruleless')
  })

  test('a document from a newer schema enforces NOTHING rather than guessing', () => {
    const c = compile({ v: POLICY_SCHEMA + 1, policies: DOC.policies })
    expect(c.policies).toEqual([])
    expect(c.drops[0]!.why).toContain(`v${POLICY_SCHEMA}`)
  })

  test('a document that is not a document is a drop, not a throw', () => {
    expect(compile(null).policies).toEqual([])
    expect(compile('nonsense').policies).toEqual([])
    expect(compile({ v: POLICY_SCHEMA }).drops.length).toBe(1)
  })

  test('the first policy in FILE ORDER is the one that answers', () => {
    // One reason reaches the model, and it is the one at the top of the file — so the
    // order ops reads in `jq` is the order the seat applies.
    const c = compile({
      v: POLICY_SCHEMA,
      policies: [
        { id: 'first', rule: 'r', tools: ['Bash'], text_keys: ['command'], deny: 'A {rule}', checks: [{ id: 'a', find: 'boom', say: 's' }] },
        { id: 'second', rule: 'r', tools: ['Bash'], text_keys: ['command'], deny: 'B {rule}', checks: [{ id: 'b', find: 'boom', say: 's' }] },
      ],
    })
    expect(evaluate(c, bash('boom'), NO_ENV)?.policy).toBe('first')
  })

  test('envSet: set means set, and 0/false/empty mean off', () => {
    expect(envSet({ K: '1' }, 'K')).toBe(true)
    expect(envSet({ K: 'DIVE-4696' }, 'K')).toBe(true)
    expect(envSet({ K: '0' }, 'K')).toBe(false)
    expect(envSet({ K: 'false' }, 'K')).toBe(false)
    expect(envSet({ K: '' }, 'K')).toBe(false)
    expect(envSet({}, 'K')).toBe(false)
  })
})
