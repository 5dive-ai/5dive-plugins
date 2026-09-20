// 5dive `mod` — capability 2: a `tool.call` DENY list driven by a data file
// (DIVE-4696).
//
// WHY THIS IS NOT MORE PROSE. Every rule in the fleet's CLAUDE.md files is re-sent on
// every turn of every seat (~1100 loads/day per that file's own header) and is enforced
// AFTER the fact — by sudoers scoping, by the pre-push PII guard, or by an audit row
// somebody reads later. A rule expressed here costs zero tokens per turn, fires BEFORE
// the tool runs, and hands the model the reason it was refused. The PR that adds a
// policy here DELETES its prose; a policy that ships without that has moved nothing.
//
// WHAT THIS FILE IS. Pure functions over a JSON document. No `$`, no I/O, no clock —
// which is what makes every policy gradeable by `bun test` with no engine, in both
// directions: the deny must fire on the bad input AND must not fire on the good one.
// `register.ts` owns the one `$.fs.read` that loads the document and the single call
// site inside the existing `tool.call` hook.
//
// THE DOCUMENT IS DATA, NOT CODE (a row constraint). A new policy is a new object in
// plugins/mod/policy/guard.json — ops extends the list without a plugin release, and
// `jq '.policies[].id'` is the whole reader. Nothing in this file names a policy.
//
// FAIL OPEN, LOUDLY. A document that will not parse, a regex that will not compile, a
// tool whose input is not the shape a policy expects: the policy is DROPPED and the
// call proceeds. A guard that fails closed bricks a seat on a plugin release, and this
// surface is early access. The cost of that choice is that "the guard is off" and "the
// guard allowed it" are one observable unless the failure is said out loud, so every
// drop returns a reason and `register.ts` logs it once per session.

/** The schema version of policy/guard.json. Bump only on a breaking change. */
export const POLICY_SCHEMA = 1

/** One test inside a policy. `find` is the trigger; everything else narrows it. */
export type Check = {
  id: string
  /** Which subject to run against: the write's path, or its text. Default "text". */
  on?: 'path' | 'text'
  find: string
  flags?: string
  /**
   * Capture group holding the VALUE being judged. With it, `allow_any` is consulted
   * and a permitted value is not a hit; without it, any match is a hit.
   */
  group?: number
  /** Regexes; a captured value matching any one of them is permitted. */
  allow_any?: string[]
  /**
   * Context the subject must ALSO contain for this check to apply at all. This is what
   * keeps `smoke-verified` in a sentence from reading as applying the label.
   */
  require_all?: string[]
  /** The human half of the deny, with `{match}` replaced by what was found. */
  say: string
}

/** One rule, as the file states it. */
export type Policy = {
  id: string
  rule: string
  tools: string[]
  path_keys?: string[]
  text_keys?: string[]
  /** If present, the policy applies only when the write's path matches one of these. */
  path_any?: string[]
  /** A seat setting that, when set to a non-empty value other than "0", skips it. */
  unless_env?: string
  checks: Check[]
  /** Template: `{found}` the check's `say`, `{path}` the write's path, `{rule}`. */
  deny: string
}

export type PolicyFile = { v: number; id?: string; policies: Policy[] }

/** A policy that could not be honoured, and why. Never silent — see the header. */
export type Drop = { policy: string; why: string }

export type Compiled = { policies: CompiledPolicy[]; drops: Drop[] }

type CompiledCheck = {
  id: string
  on: 'path' | 'text'
  re: RegExp
  group?: number
  allow: RegExp[]
  require: RegExp[]
  say: string
}

type CompiledPolicy = {
  id: string
  rule: string
  tools: Set<string>
  pathKeys: string[]
  textKeys: string[]
  pathAny: RegExp[]
  unlessEnv?: string
  checks: CompiledCheck[]
  deny: string
}

/** A regex source that will not compile drops its policy rather than throwing. */
function re(source: string, flags: string): RegExp {
  return new RegExp(source, flags)
}

/**
 * Turns the document into matchers, once. A policy whose regexes will not compile, or
 * that is missing a field the evaluator needs, is DROPPED with a reason; the rest of
 * the file still applies. One bad edit by ops must not switch the whole guard off
 * silently — that is the failure mode this shape exists to avoid.
 */
export function compile(doc: unknown): Compiled {
  const drops: Drop[] = []
  const out: CompiledPolicy[] = []
  const file = doc as PolicyFile | null
  if (file === null || typeof file !== 'object' || !Array.isArray(file.policies)) {
    return { policies: [], drops: [{ policy: '(file)', why: 'no `policies` array' }] }
  }
  if (file.v !== POLICY_SCHEMA) {
    return {
      policies: [],
      drops: [
        {
          policy: '(file)',
          why: `schema v${String(file.v)}, this build reads v${POLICY_SCHEMA}`,
        },
      ],
    }
  }
  for (const p of file.policies) {
    const id = typeof p?.id === 'string' && p.id !== '' ? p.id : '(unnamed)'
    try {
      if (typeof p.rule !== 'string' || p.rule === '') {
        throw new Error('no `rule`: a policy names the written rule it replaces')
      }
      if (typeof p.deny !== 'string' || p.deny === '') throw new Error('no `deny` text')
      if (!Array.isArray(p.tools) || p.tools.length === 0) throw new Error('no `tools`')
      if (!Array.isArray(p.checks) || p.checks.length === 0) throw new Error('no `checks`')
      const checks: CompiledCheck[] = p.checks.map((c) => {
        if (typeof c?.id !== 'string' || c.id === '') throw new Error('a check with no `id`')
        if (typeof c.find !== 'string') throw new Error(`check ${c.id}: no \`find\``)
        if (typeof c.say !== 'string' || c.say === '') {
          throw new Error(`check ${c.id}: no \`say\` — a deny with no reason is not one`)
        }
        const on = c.on === 'path' ? 'path' : 'text'
        return {
          id: c.id,
          on,
          re: re(c.find, c.flags ?? ''),
          ...(typeof c.group === 'number' ? { group: c.group } : {}),
          allow: (c.allow_any ?? []).map((s) => re(s, '')),
          require: (c.require_all ?? []).map((s) => re(s, '')),
          say: c.say,
        }
      })
      out.push({
        id,
        rule: p.rule,
        tools: new Set(p.tools),
        pathKeys: p.path_keys ?? [],
        textKeys: p.text_keys ?? [],
        pathAny: (p.path_any ?? []).map((s) => re(s, '')),
        ...(typeof p.unless_env === 'string' ? { unlessEnv: p.unless_env } : {}),
        checks,
        deny: p.deny,
      })
    } catch (err) {
      drops.push({ policy: id, why: String(err instanceof Error ? err.message : err) })
    }
  }
  return { policies: out, drops }
}

/** Reads a string off a tool's input object; anything else answers ''. */
function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key]
  return typeof v === 'string' ? v : ''
}

/**
 * A seat setting counts as SET only when it is a non-empty string that is not "0" and
 * not "false". An escape hatch spelled `=0` must not open the hatch — that is the
 * shape people write when they mean "off".
 */
export function envSet(env: Record<string, unknown>, key: string): boolean {
  const v = String(env[key] ?? '')
  return v !== '' && v !== '0' && v !== 'false'
}

/** Every match of `re` in `s`, as the whole match and the chosen group. */
function hits(c: CompiledCheck, s: string): Array<{ whole: string; value: string }> {
  const found: Array<{ whole: string; value: string }> = []
  if (c.re.global) {
    c.re.lastIndex = 0
    for (const m of s.matchAll(c.re)) {
      found.push({ whole: m[0], value: c.group === undefined ? m[0] : (m[c.group] ?? '') })
    }
    return found
  }
  const m = c.re.exec(s)
  if (m !== null) {
    found.push({ whole: m[0], value: c.group === undefined ? m[0] : (m[c.group] ?? '') })
  }
  return found
}

/** What a policy decided about one call. */
export type Verdict = { policy: string; check: string; reason: string } | null

/**
 * Runs the compiled policies against one tool call.
 *
 * Returns the FIRST deny in file order and stops — the model gets one reason, not a
 * report, and the order in the file is the order ops sees in `jq`.
 *
 * `env` is the seat's settings `env` block: the same place the mod's own gates live,
 * so an escape hatch is a recorded seat setting rather than a flag on a command line
 * that nothing keeps.
 */
export function evaluate(
  compiled: Compiled,
  call: { tool: string; input: unknown },
  env: Record<string, unknown>,
): Verdict {
  for (const p of compiled.policies) {
    if (!p.tools.has(call.tool)) continue
    if (p.unlessEnv !== undefined && envSet(env, p.unlessEnv)) continue

    const path = p.pathKeys.map((k) => str(call.input, k)).find((v) => v !== '') ?? ''
    if (p.pathAny.length > 0 && !p.pathAny.some((r) => r.test(path))) continue
    const text = p.textKeys.map((k) => str(call.input, k)).join('\n')

    for (const c of p.checks) {
      const subject = c.on === 'path' ? path : text
      if (subject === '') continue
      if (!c.require.every((r) => r.test(subject))) continue
      for (const h of hits(c, subject)) {
        if (c.allow.length > 0 && c.allow.some((r) => r.test(h.value))) continue
        const found = c.say.replace('{match}', h.value)
        return {
          policy: p.id,
          check: c.id,
          reason: p.deny
            .replace('{found}', found)
            .replace('{path}', path === '' ? '(no path)' : path)
            .replace('{rule}', p.rule),
        }
      }
    }
  }
  return null
}
