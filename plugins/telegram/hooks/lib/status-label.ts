// DIVE-5419: the human-readable step label the bridge shows on the ack while a
// turn runs (see ../../ackstatus.ts). Pure, so the leak rules are testable.
//
// What a label may carry is the DIVE-4123 line: never command text, file
// contents or transcript. So the only free text admitted is the model's own
// one-line `description` of a Bash or Agent call, and even that is filtered:
// any word that carries a path, URL, flag, assignment, shell syntax or a long
// token-like run is dropped, and the rest is capped. Every other tool maps to
// a fixed generic phrase — its input is never read.

const MAX_LABEL = 48

// A word that looks like a path, a URL, a flag, an assignment, shell syntax,
// an address, or a long id/secret-shaped run — dropped, not escaped.
const RISKY_WORD = /[\/\\=@`$<>{}|;&*"']|^-|[A-Za-z0-9_+\-]{24,}/

export function sanitizeLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const words = raw.replace(/\s+/g, ' ').trim().split(' ')
  let t = words.filter((w) => w && !RISKY_WORD.test(w)).join(' ').trim()
  if (!t) return null
  if (t.length > MAX_LABEL) t = `${t.slice(0, MAX_LABEL - 1).trimEnd()}…`
  return t
}

const FIXED: Record<string, string> = {
  Read: 'Reading files',
  NotebookRead: 'Reading files',
  Edit: 'Editing files',
  MultiEdit: 'Editing files',
  Write: 'Editing files',
  NotebookEdit: 'Editing files',
  Grep: 'Searching files',
  Glob: 'Searching files',
  LS: 'Searching files',
  WebFetch: 'Reading a web page',
  WebSearch: 'Searching the web',
  TodoWrite: 'Planning',
  AskUserQuestion: 'Waiting for your answer',
  ExitPlanMode: 'Waiting for your answer',
  Skill: 'Loading a skill',
}

// null = write nothing (the call is itself a Telegram send, which resets the
// ack on its own).
export function labelFor(toolName: unknown, toolInput: unknown, tgPrefix: string): string | null {
  if (typeof toolName !== 'string' || !toolName) return null
  if (toolName.startsWith(tgPrefix)) return null
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as { description?: unknown }
  if (toolName === 'Bash') return sanitizeLabel(input.description) ?? 'Running a command'
  if (toolName === 'Agent' || toolName === 'Task') return sanitizeLabel(input.description) ?? 'Working with a helper'
  if (FIXED[toolName]) return FIXED[toolName]
  if (toolName.startsWith('mcp__')) return 'Using a tool'
  return 'Working'
}
