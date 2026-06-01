#!/usr/bin/env bun
/**
 * Derive structural-block edits for a runtime that already exists as a
 * hand-fork (codex/grok/agy). Runs the generator in TOKEN-ONLY mode (no blocks)
 * and line-diffs the result against the committed fork, emitting the minimal set
 * of contiguous {find, replace} hunks needed to close the gap. Each hunk carries
 * one line of stable context on each side so the find-string is unique.
 *
 * This is authoring scaffolding, not part of generation: run it once, review the
 * emitted hunks, split them into named blocks/<region>.json files, then point the
 * runtime config at those blocks. Re-run after a base change to spot new drift.
 *
 *   bun derive-blocks.ts <slug>
 */
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const slug = process.argv[2]
if (!slug) { console.error('usage: bun derive-blocks.ts <slug>'); process.exit(2) }

const GEN = import.meta.dir
const committed = join(GEN, '..', 'plugins', `telegram-${slug}`, 'server.ts')

// Generate token-only: temporarily run with a blocks-stripped config by setting
// an env flag the generator honors.
const out = mkdtempSync(join(tmpdir(), 'derive-'))
const proc = Bun.spawnSync(['bun', join(GEN, 'generate.ts'), slug, `--out=${out}`],
  { env: { ...process.env, GEN_NO_BLOCKS: '1' }, stderr: 'pipe' })
if (!proc.success) {
  console.error('token-only generate failed:\n' + proc.stderr.toString())
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

const a = readFileSync(join(out, 'server.ts'), 'utf8').split('\n')  // token-only (find side)
const b = readFileSync(committed, 'utf8').split('\n')               // committed  (replace side)
rmSync(out, { recursive: true, force: true })

// LCS over lines → change hunks.
const n = a.length, m = b.length
const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
for (let i = n - 1; i >= 0; i--)
  for (let j = m - 1; j >= 0; j--)
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])

type Op = { kind: 'eq' | 'del' | 'ins'; line: string }
const ops: Op[] = []
let i = 0, j = 0
while (i < n && j < m) {
  if (a[i] === b[j]) { ops.push({ kind: 'eq', line: a[i] }); i++; j++ }
  else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ kind: 'del', line: a[i] }); i++ }
  else { ops.push({ kind: 'ins', line: b[j] }); j++ }
}
while (i < n) ops.push({ kind: 'del', line: a[i++] })
while (j < m) ops.push({ kind: 'ins', line: b[j++] })

// Group consecutive non-eq ops into hunks with 1 line of leading/trailing context.
type Hunk = { find: string[]; replace: string[] }
const hunks: Hunk[] = []
let k = 0
while (k < ops.length) {
  if (ops[k].kind === 'eq') { k++; continue }
  const start = k
  while (k < ops.length && ops[k].kind !== 'eq') k++
  const ctxBefore = start > 0 ? [ops[start - 1].line] : []
  const ctxAfter = k < ops.length ? [ops[k].line] : []
  const dels = ops.slice(start, k).filter(o => o.kind === 'del').map(o => o.line)
  const ins = ops.slice(start, k).filter(o => o.kind === 'ins').map(o => o.line)
  hunks.push({
    find: [...ctxBefore, ...dels, ...ctxAfter],
    replace: [...ctxBefore, ...ins, ...ctxAfter],
  })
}

const edits = hunks.map(h => ({ find: h.find.join('\n'), replace: h.replace.join('\n'), files: ['server.ts'] }))
console.log(JSON.stringify(edits, null, 2))
console.error(`derived ${edits.length} hunk(s) for telegram-${slug}`)
