// DIVE-6433: a human gate's tap confirmations follow the owner's language.
// The CLI writes the gate message and its buttons in the box owner's language;
// this is the other half, what the plugin says after a tna: tap.
//
// Pins:
//   1. en copy is byte-identical to the literals server.ts printed before.
//   2. ru translates the copy and the ack (approved → одобрено).
//   3. the value `task answer` records is the same for both: a tap on a Russian
//      button answers the gate exactly like the English one.
//   4. server.ts reads the tna: copy from TAP_STRINGS and passes the tap language.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TAP_STRINGS } from '../plugins/telegram/hooks/lib/lite'
import { resolveTnaAnswer, tnaAck } from '../plugins/telegram/tna'

const SERVER = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')

const approval = { need_type: 'approval' }
const decision = { need_type: 'decision', need_options: 'Ship it | Hold' }

describe('en is unchanged', () => {
  test('copy', () => {
    const en = TAP_STRINGS.en
    expect(en.gateGone).toBe('This task no longer has a gate.')
    expect(en.gateAnswered('approved')).toBe('Answered: approved')
    expect(en.gateAnsweredEdit('approved')).toBe('✅ answered: approved')
    expect(en.optionInvalid).toBe('That option is no longer valid.')
  })
  test('ack and the already-answered copy', () => {
    expect(tnaAck('approved')).toBe('approved')
    const r = resolveTnaAnswer({ need_type: 'approval', need_answered_at: '2026-10-17 13:10:44', need_answer: 'approved', need_answered_by: 'human:lodar' }, 'approved')
    expect(r).toEqual({ kind: 'already', prior: 'approved', toast: 'Already answered 2026-10-17 13:10 UTC by human:lodar.', edit: '✅ already answered: approved (2026-10-17 13:10 UTC by human:lodar)' })
  })
})

describe('ru', () => {
  test('copy and ack are Russian', () => {
    const ru = TAP_STRINGS.ru
    expect(ru.gateAnswered(tnaAck('approved', 'ru'))).toBe('Ответ принят: одобрено')
    expect(ru.gateAnsweredEdit(tnaAck('denied', 'ru'))).toBe('✅ ответ: отклонено')
    expect(tnaAck('Ship it', 'ru')).toBe('Ship it')
    const r = resolveTnaAnswer({ need_type: 'approval', need_answered_at: '2026-10-17 13:10:44', need_answer: 'approved', need_answered_by: 'human:x' }, 'approved', 'ru')
    expect(r).toEqual({ kind: 'already', prior: 'approved', toast: 'Ответ уже получен: 2026-10-17 13:10 UTC, human:x.', edit: '✅ ответ уже получен: одобрено (2026-10-17 13:10 UTC, human:x)' })
  })
  test('the recorded value is language-neutral', () => {
    for (const [gate, token] of [[approval, 'approved'], [approval, 'denied'], [decision, '1'], [{ need_type: 'manual' }, 'done']] as const) {
      const en = resolveTnaAnswer(gate as any, token)
      const ru = resolveTnaAnswer(gate as any, token, 'ru')
      expect(ru).toEqual(en)
      expect(en.kind).toBe('answer')
    }
    expect((resolveTnaAnswer(decision as any, '1', 'ru') as any).answerArgs).toEqual(['--value=Hold'])
  })
})

describe('server.ts wiring', () => {
  test('the tna: handler reads TAP_STRINGS in the tap language', () => {
    expect(SERVER).toContain('resolveTnaAnswer(task, token, lang)')
    expect(SERVER).toContain('s.gateAnswered(tnaAck(r.ack, lang))')
    expect(SERVER).not.toContain("text: 'This task no longer has a gate.'")
    expect(SERVER).not.toContain('`✅ answered: ${r.ack}`')
  })
})
