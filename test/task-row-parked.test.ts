// lodar 2026-10-03: in /tasks, a row that is only waiting for its wake time
// (`5dive task park`: status blocked, wake_at set, no gate) showed the same ⛔ as
// a row that is stuck. It now shows ⏰ and the day it wakes. Plugin-only: the
// CLI's `task ls --json` already returns wake_at.
//
// server.ts long-polls on import, so this runs the REAL taskRow cut out of each
// fork's source (not a copy of its logic), with taskAssignedToMe stubbed.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FORKS = [
  'telegram', 'telegram-grok', 'telegram-agy', 'telegram-codex', 'telegram-pi',
  'telegram-opencode',
]

function loadTaskRow(fork: string): (t: any, needTag?: boolean) => string {
  const s = readFileSync(join(import.meta.dir, '..', 'plugins', fork, 'server.ts'), 'utf8')
  const start = s.indexOf('function taskRow(')
  expect(start, `${fork}: no taskRow`).toBeGreaterThan(-1)
  const end = s.indexOf('\n}\n', start)
  const body = s.slice(start, end + 2).replace(/\(t: any, needTag = false\): string/, '(t, needTag = false)')
  return new Function('taskAssignedToMe', `${body}; return taskRow`)(() => false)
}

const base = { id: 7, ident: 'DIVE-7', title: 'weekly digest', assignee: 'olivia' }

describe.each(FORKS)('%s /tasks row', (fork) => {
  const taskRow = loadTaskRow(fork)

  test('a parked row shows ⏰ and its wake day, not ⛔', () => {
    const row = taskRow({ ...base, status: 'blocked', wake_at: '2026-10-08 00:00:00', need_type: null })
    expect(row.startsWith('⏰ DIVE-7')).toBe(true)
    expect(row).toContain(' · until Oct 8')
    expect(row).not.toContain('⛔')
  })

  test('a blocked row with no wake time stays ⛔', () => {
    const row = taskRow({ ...base, status: 'blocked', wake_at: null, need_type: null })
    expect(row.startsWith('⛔ DIVE-7')).toBe(true)
    expect(row).not.toContain('until')
  })

  test('a gated row stays ⛔ even with a wake time', () => {
    const row = taskRow({ ...base, status: 'blocked', wake_at: '2026-10-08 00:00:00', need_type: 'approval' })
    expect(row.startsWith('⛔ DIVE-7')).toBe(true)
  })

  test('an unreadable wake time still shows ⏰, with no date', () => {
    const row = taskRow({ ...base, status: 'blocked', wake_at: 'soon', need_type: null })
    expect(row.startsWith('⏰ DIVE-7')).toBe(true)
    expect(row).not.toContain('until')
  })

  test('todo and in-progress rows are unchanged', () => {
    expect(taskRow({ ...base, status: 'todo', wake_at: '2026-10-08 00:00:00' }).startsWith('DIVE-7')).toBe(true)
    expect(taskRow({ ...base, status: 'in_progress' }).startsWith('▶ DIVE-7')).toBe(true)
  })
})
