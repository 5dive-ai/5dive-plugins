// DIVE-1514 regression coverage for the relay-in startup age-gate.
//
// Run: `bun test` from plugins/telegram (bun auto-discovers *.test.ts).
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sweepStaleRelayIn } from './relay-quarantine'

let dir: string
let relayIn: string
let dead: string
const NOW = 1_700_000_000_000 // fixed clock; tests must not depend on wall time
const TTL = 5 * 60_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relayq-'))
  relayIn = join(dir, 'relay-in')
  dead = join(dir, 'relay-dead')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// write <name> into relay-in and backdate its mtime by ageMs
function drop(name: string, ageMs: number) {
  const { mkdirSync } = require('fs')
  mkdirSync(relayIn, { recursive: true })
  const p = join(relayIn, name)
  writeFileSync(p, JSON.stringify({ id: name, content: 'x' }))
  const t = (NOW - ageMs) / 1000
  utimesSync(p, t, t)
  return p
}

test('quarantines a drop older than the TTL, leaves the fresh one', () => {
  drop('stale.json', TTL + 60_000)
  drop('fresh.json', TTL - 60_000)
  const out = sweepStaleRelayIn(relayIn, dead, TTL, NOW)
  expect(out.map(q => q.file)).toEqual(['stale.json'])
  // stale moved out of relay-in, into dead-letter; fresh untouched for drain
  expect(readdirSync(relayIn).sort()).toEqual(['fresh.json'])
  expect(readdirSync(dead).length).toBe(1)
})

test('never touches relay-in when everything is fresh (no dead-letter dir created)', () => {
  drop('a.json', 1_000)
  drop('b.json', 2_000)
  const out = sweepStaleRelayIn(relayIn, dead, TTL, NOW)
  expect(out).toEqual([])
  expect(readdirSync(relayIn).sort()).toEqual(['a.json', 'b.json'])
  expect(existsSync(dead)).toBe(false)
})

test('ignores non-json and a missing relay-in dir', () => {
  expect(sweepStaleRelayIn(join(dir, 'nope'), dead, TTL, NOW)).toEqual([])
  const { mkdirSync } = require('fs')
  mkdirSync(relayIn, { recursive: true })
  const p = join(relayIn, 'note.txt')
  writeFileSync(p, 'x')
  utimesSync(p, (NOW - TTL - 99_000) / 1000, (NOW - TTL - 99_000) / 1000)
  expect(sweepStaleRelayIn(relayIn, dead, TTL, NOW)).toEqual([])
  expect(readdirSync(relayIn)).toEqual(['note.txt'])
})

test('colliding basenames across sweeps stay distinct in dead-letter', () => {
  drop('dup.json', TTL + 10_000)
  sweepStaleRelayIn(relayIn, dead, TTL, NOW)
  drop('dup.json', TTL + 20_000)
  sweepStaleRelayIn(relayIn, dead, TTL, NOW)
  expect(readdirSync(dead).length).toBe(2) // both preserved, no overwrite
})
