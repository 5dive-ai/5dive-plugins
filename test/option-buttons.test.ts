// DIVE-708: unit matrix for the lettered/numbered option-list parser that turns
// an agent's choice message into tappable buttons. Pure logic lives in tna.ts
// (parseOptions / optionChoices); this asserts the detector fires on real choice
// lists and stays quiet on the things that would make a FALSE button — the
// conservative bar the Yes/No detector set (DIVE-332). Also asserts the four
// shipped tna.ts are byte-identical so a fork can't silently drift.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseOptions, optionChoices, OPT_RE } from '../plugins/telegram/tna'

describe('parseOptions — raw sequence detection', () => {
  test('lettered a/b/c list', () => {
    const o = parseOptions('a) Build the wizard\nb) Wait\nc) Ship docs')
    expect(o.map(x => x.marker)).toEqual(['a', 'b', 'c'])
    expect(o[0]!.label).toBe('Build the wizard')
  })
  test('numbered 1/2/3 list (dot or paren)', () => {
    expect(parseOptions('1. Red\n2. Green\n3. Blue').length).toBe(3)
    expect(parseOptions('1) Red\n2) Green').length).toBe(2)
  })
  test('preamble + bullet-prefixed options are fine', () => {
    const o = parseOptions('Here are the choices:\n- a) Keep\n- b) Drop')
    expect(o.map(x => x.label)).toEqual(['Keep', 'Drop'])
  })
  test('UPPERCASE markers normalise to lowercase', () => {
    expect(parseOptions('A) One\nB) Two').map(x => x.marker)).toEqual(['a', 'b'])
  })

  // Negatives — must return [] so no buttons render.
  test('single option is not a list', () => expect(parseOptions('a) lonely')).toEqual([]))
  test('non-sequential markers rejected', () => {
    expect(parseOptions('a) one\nc) three')).toEqual([])
    expect(parseOptions('1. one\n3. three')).toEqual([])
  })
  test('a long, paragraph-style label is not an option', () => {
    const long = 'x'.repeat(120)
    expect(parseOptions(`1. ${long}\n2. short`)).toEqual([])
  })
  test('more than 8 rejected', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i + 1}. opt`).join('\n')
    expect(parseOptions(many)).toEqual([])
  })
  test('prose with no marked list', () => expect(parseOptions('do you want me to ship it?')).toEqual([]))
})

describe('optionChoices — cue gate (false-positive guard)', () => {
  test('fires when a question mark is present', () => {
    expect(optionChoices('Which one?\na) Build\nb) Wait').length).toBe(2)
  })
  test('fires on a choice cue word', () => {
    expect(optionChoices('Pick one:\na) Build\nb) Wait').length).toBe(2)
    expect(optionChoices('Your options:\n1. A\n2. B').length).toBe(2)
  })
  test('does NOT fire on a plain numbered STEP list (no cue)', () => {
    expect(optionChoices('I will:\n1. branch\n2. build\n3. push')).toEqual([])
  })
  test('a valid sequence still needs the cue', () => {
    // parseOptions sees the sequence, optionChoices withholds it without a cue.
    expect(parseOptions('a) one\nb) two').length).toBe(2)
    expect(optionChoices('a) one\nb) two')).toEqual([])
  })
})

describe('OPT_RE — callback_data shape', () => {
  test('matches opt:<index>', () => {
    expect(OPT_RE.exec('opt:0')?.[1]).toBe('0')
    expect(OPT_RE.exec('opt:3')?.[1]).toBe('3')
    expect(OPT_RE.test('yn:yes')).toBe(false)
    expect(OPT_RE.test('opt:')).toBe(false)
  })
})

describe('tna.ts parity — base and forks byte-identical', () => {
  const PLUGINS = ['telegram', 'telegram-grok', 'telegram-codex', 'telegram-agy']
  const read = (p: string) => readFileSync(join(import.meta.dir, '..', 'plugins', p, 'tna.ts'), 'utf8')
  test('all forks match base', () => {
    const base = read('telegram')
    for (const p of PLUGINS.slice(1)) expect(read(p)).toBe(base)
  })
})
