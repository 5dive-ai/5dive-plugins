// DIVE-1027: unit cover for the native-picker → Telegram-keyboard bridge.
//
// buildBridge/buttonText are the PURE translation layer the pretool-question
// hook relies on: it turns an AskUserQuestion / ExitPlanMode tool_input into the
// button set + the answer text each tap returns, and decides whether a tap
// ALLOWs the tool (ExitPlanMode approve) or DENYs-with-answer (everything else).
// Unsupported shapes must return null so the hook falls back to the pre-1027
// legacy deny instead of silently dropping options. Imports the REAL shipped
// module (not a copy), matching test/tna-harness.test.ts's convention.

import { describe, test, expect } from 'bun:test'
import { buildBridge, buttonText, resolveQuestionTap } from '../plugins/telegram/hooks/lib/question-bridge'

describe('buildBridge — ExitPlanMode', () => {
  test('two buttons, approve ALLOWs, revise denies', () => {
    const ep = buildBridge('ExitPlanMode', { plan: 'Do X then Y' })!
    expect(ep).not.toBeNull()
    expect(ep.buttons.length).toBe(2)
    expect(ep.markers).toBe(false)
    expect(ep.buttons[0].permit).toBe('allow') // approve must ALLOW (no re-call loop)
    expect(ep.buttons[1].permit).toBeUndefined() // keep-planning denies
    expect(ep.buttons[0].answer).toContain('APPROVED')
    expect(ep.prompt).toContain('Do X then Y')
  })

  test('missing plan still yields the 2-button approve/revise set', () => {
    const ep = buildBridge('ExitPlanMode', {})!
    expect(ep.buttons.length).toBe(2)
    expect(ep.buttons[0].permit).toBe('allow')
  })
})

describe('buildBridge — AskUserQuestion (single-select)', () => {
  test('maps options to deny-with-answer buttons, no permit', () => {
    const aq = buildBridge('AskUserQuestion', {
      questions: [
        {
          header: 'DB',
          question: 'Which db?',
          options: [{ label: 'Postgres', description: 'sql' }, { label: 'Mongo' }],
        },
      ],
    })!
    expect(aq.buttons.length).toBe(2)
    expect(aq.markers).toBe(true)
    expect(aq.buttons[0].permit).toBeUndefined()
    expect(aq.buttons[0].answer).toBe('The user selected: "Postgres" (sql)')
    expect(aq.buttons[1].answer).toBe('The user selected: "Mongo"')
    expect(aq.prompt).toBe('❓ DB\nWhich db?')
  })

  test('no header → bare ❓ marker line', () => {
    const aq = buildBridge('AskUserQuestion', {
      questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
    })!
    expect(aq.prompt).toBe('❓\nPick one')
  })
})

describe('buildBridge — unsupported shapes fall back (null)', () => {
  test('multi-question', () => {
    expect(
      buildBridge('AskUserQuestion', {
        questions: [
          { question: 'a', options: [{ label: 'x' }] },
          { question: 'b', options: [{ label: 'y' }] },
        ],
      }),
    ).toBeNull()
  })
  test('multiSelect', () => {
    expect(
      buildBridge('AskUserQuestion', {
        questions: [{ question: 'a', multiSelect: true, options: [{ label: 'x' }] }],
      }),
    ).toBeNull()
  })
  test('zero options', () => {
    expect(buildBridge('AskUserQuestion', { questions: [{ question: 'a', options: [] }] })).toBeNull()
  })
  test('zero questions', () => {
    expect(buildBridge('AskUserQuestion', { questions: [] })).toBeNull()
  })
  test('missing question text', () => {
    expect(buildBridge('AskUserQuestion', { questions: [{ options: [{ label: 'x' }] }] })).toBeNull()
  })
  test('option with no label', () => {
    expect(buildBridge('AskUserQuestion', { questions: [{ question: 'a', options: [{}] }] })).toBeNull()
  })
  test('unrelated tool name', () => {
    expect(buildBridge('SomethingElse', {})).toBeNull()
  })
})

describe('buttonText', () => {
  test('lettered markers when enabled', () => {
    expect(buttonText('Postgres', 0, true)).toBe('A) Postgres')
    expect(buttonText('Mongo', 1, true)).toBe('B) Mongo')
  })
  test('no marker when disabled', () => {
    expect(buttonText('✅ Approve', 0, false)).toBe('✅ Approve')
  })
  test('clips overlong labels to one tidy line (≤56)', () => {
    const long = 'x'.repeat(80)
    expect(buttonText(long, 0, true).length).toBeLessThanOrEqual(56)
    expect(buttonText(long, 0, true).endsWith('…')).toBe(true)
  })
})

describe('resolveQuestionTap — the server-side callback resolver (headless)', () => {
  const req = (labels: string[]) => JSON.stringify({ tool: 'AskUserQuestion', labels })

  test('valid tap → answer with idx + resolved text', () => {
    const r = resolveQuestionTap('q:123-45:1', req(['ans A', 'ans B']), false)
    expect(r).toEqual({ kind: 'answer', idx: 1, answer: 'ans B' })
  })

  test('request file gone (hook timed out / cleaned up) → expired', () => {
    expect(resolveQuestionTap('q:123-45:0', null, false).kind).toBe('expired')
  })

  test('answer already exists (double-tap / race) → already', () => {
    expect(resolveQuestionTap('q:123-45:0', req(['a']), true).kind).toBe('already')
  })

  test('out-of-range idx → invalid', () => {
    expect(resolveQuestionTap('q:123-45:5', req(['a', 'b']), false).kind).toBe('invalid')
    // a negative idx never appears in generated callback_data (we emit i>=0) and
    // the \d+ pattern won't match it → treated as not-ours/expired, not invalid.
    expect(resolveQuestionTap('q:123-45:-1', req(['a']), false).kind).toBe('expired')
  })

  test('malformed callback_data / not-ours → expired', () => {
    expect(resolveQuestionTap('opt:2', req(['a']), false).kind).toBe('expired')
    expect(resolveQuestionTap('q:abc', req(['a']), false).kind).toBe('expired')
  })

  test('corrupt request json → expired (never throws)', () => {
    expect(resolveQuestionTap('q:1-2:0', '{not json', false).kind).toBe('expired')
  })

  test('reqid with a negative-looking segment still parses', () => {
    const r = resolveQuestionTap('q:1751700000000-999:0', req(['only']), false)
    expect(r).toEqual({ kind: 'answer', idx: 0, answer: 'only' })
  })
})

describe('handshake contract — server resolves idx against persisted answers', () => {
  // The hook persists buttons.map(b => b.answer) as `labels` in <reqid>.req.json;
  // the server writes labels[idx] to <reqid>.ans.json on tap. This asserts that
  // contract end to end at the data level (the live round-trip is covered by the
  // real-bot tap recorded on the task).
  test('idx maps back to the exact answer string', () => {
    const aq = buildBridge('AskUserQuestion', {
      questions: [{ question: 'q', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
    })!
    const persistedLabels = aq.buttons.map(b => b.answer)
    expect(persistedLabels[2]).toBe('The user selected: "C"')
    // out-of-range idx is what the server rejects as "no longer valid"
    expect(persistedLabels[9]).toBeUndefined()
  })
})
