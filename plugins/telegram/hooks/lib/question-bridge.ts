// DIVE-1027: pure, side-effect-free helpers that translate a native picker
// tool_input (AskUserQuestion / ExitPlanMode) into a Telegram-inline-keyboard
// "bridge spec". Kept free of I/O so it can be unit-tested without a live bot.
//
// buildBridge returns null when the shape isn't supported yet — a multi-question
// or multiSelect AskUserQuestion needs multi-step / toggle UX we don't render in
// v1 — so the hook falls back to the legacy "write the question as a numbered
// Telegram message yourself" deny instead of silently dropping options.

// permit:'allow' means this tap should ALLOW the native tool to run rather than
// deny-with-answer. ExitPlanMode's approve must allow (deny would leave the
// agent stuck in plan mode, re-calling the tool in a loop); AskUserQuestion
// always deny-with-answer (allowing it would render the dead tmux picker).
export type BridgeButton = { label: string; answer: string; permit?: 'allow' }
export type BridgeSpec = { prompt: string; buttons: BridgeButton[]; markers: boolean }

const BTN_MAX = 56

export function buildBridge(toolName: string, input: Record<string, unknown>): BridgeSpec | null {
  if (toolName === 'ExitPlanMode') {
    const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
    const prompt = plan
      ? `📋 Plan ready for review:\n\n${plan}\n\nApprove to start, or ask to keep planning.`
      : `📋 The agent is ready to leave plan mode and start implementing. Approve?`
    return {
      prompt,
      // ExitPlanMode is the simple 2-button approve/revise case. Labels carry
      // their own emoji, so no A)/B) marker.
      markers: false,
      buttons: [
        {
          label: '✅ Approve — proceed',
          answer: 'The user APPROVED the plan. Exit plan mode and begin implementing it.',
          permit: 'allow',
        },
        {
          label: '✍️ Keep planning',
          answer:
            'The user did NOT approve the plan yet. Keep refining it and present the revised plan again before implementing.',
        },
      ],
    }
  }

  if (toolName === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions : []
    if (questions.length !== 1) return null // v1: single question only
    const q = questions[0] as Record<string, unknown>
    if (q.multiSelect) return null // v1: single-select only
    const opts = Array.isArray(q.options) ? q.options : []
    if (!opts.length) return null
    const header = typeof q.header === 'string' && q.header ? q.header : ''
    const question = typeof q.question === 'string' ? q.question : ''
    if (!question) return null
    const prompt = [header ? `❓ ${header}` : '❓', question].filter(Boolean).join('\n')
    const buttons: BridgeButton[] = []
    for (const o of opts) {
      const oo = o as Record<string, unknown>
      const label = typeof oo.label === 'string' ? oo.label : ''
      if (!label) return null
      const desc = typeof oo.description === 'string' && oo.description ? ` (${oo.description})` : ''
      buttons.push({ label, answer: `The user selected: "${label}"${desc}` })
    }
    return { prompt, buttons, markers: true }
  }

  return null
}

// Server-side resolution of a `q:<reqid>:<idx>` tap — the pure core of the
// callback_query branch in server.ts, extracted (like DIVE-369's
// resolveTnaAnswer) so the handshake has headless regression cover without a
// live bot. The handler stays a thin I/O adapter: read the request file, check
// for an existing answer, call this, then act on the verdict.
//   reqRaw   : contents of `<reqid>.req.json`, or null if it's gone (expired)
//   ansExists: whether `<reqid>.ans.json` already exists (double-tap / race)
export type QuestionTapResult =
  | { kind: 'answer'; idx: number; answer: string }
  | { kind: 'already' }
  | { kind: 'invalid' }
  | { kind: 'expired' }

export function resolveQuestionTap(
  data: string,
  reqRaw: string | null,
  ansExists: boolean,
): QuestionTapResult {
  const m = /^q:([0-9-]+):(\d+)$/.exec(data)
  if (!m) return { kind: 'expired' }
  if (reqRaw == null) return { kind: 'expired' } // hook timed out + cleaned up
  let labels: string[] = []
  try {
    const j = JSON.parse(reqRaw)
    labels = Array.isArray(j.labels) ? j.labels : []
  } catch {
    return { kind: 'expired' }
  }
  if (ansExists) return { kind: 'already' } // don't overwrite a prior tap
  const idx = Number(m[2])
  if (idx < 0 || idx >= labels.length) return { kind: 'invalid' }
  return { kind: 'answer', idx, answer: labels[idx]! }
}

// Inline-keyboard button caption: kept to one tidy line. When markers is on we
// prefix a letter (A, B, C…) mirroring DIVE-708's lettered choice buttons.
export function buttonText(label: string, index: number, markers: boolean): string {
  const prefix = markers ? `${String.fromCharCode(65 + index)}) ` : ''
  const room = BTN_MAX - prefix.length
  const clipped = label.length > room ? label.slice(0, room - 1).trimEnd() + '…' : label
  return `${prefix}${clipped}`
}
