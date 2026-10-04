// DIVE-5504 item 4: which files a dispatcher reply sends, and what it says
// about the ones it does not.
//
// Until 0.5.27 a Codex reply attached only an explicit
// `[[5dive-attachment:/path]]` line, and attached it unchecked. Claude's bridge
// attaches any eligible file a reply NAMES (autoattach.ts, DIVE-4280); this is
// that contract for the dispatcher's outbox, plus two things only this path
// needs:
//   - explicit directives go through the same credential exclusions: a model
//     can write `[[5dive-attachment:~/.codex/auth.json]]` as easily as name it;
//   - once per TURN: a turn publishes every agent message on its own, and two
//     messages naming the same report must not send it twice.
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { attachedNames, autoAttachFooter, isDenied, planAutoAttach, type PlanOpts } from './autoattach.ts'

export type OutboxAttachPlan = {
  /** Paths to send, explicit ones first, each once per turn. */
  send: string[]
  /** Appended to the outgoing text: what the person cannot see for themselves. */
  footer: string
  /** For the log and the transcript: what was attached, or '' when nothing. */
  receipt: string
}

/** Turn keys whose attachments are remembered, newest last. */
const MEMO_TURNS = 32

export class TurnAttachMemo {
  private turns = new Map<string, Set<string>>()
  has(turn: string, real: string): boolean { return Boolean(turn) && Boolean(this.turns.get(turn)?.has(real)) }
  add(turn: string, real: string): void {
    if (!turn) return
    let s = this.turns.get(turn)
    if (!s) {
      s = new Set()
      this.turns.set(turn, s)
      while (this.turns.size > MEMO_TURNS) this.turns.delete(this.turns.keys().next().value!)
    }
    s.add(real)
  }
}

function realOf(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

export function planOutboxAttachments(
  text: string,
  explicit: string[],
  turn: string,
  memo: TurnAttachMemo,
  opts: Pick<PlanOpts, 'home' | 'probe'> & { real?: (p: string) => string | null } = {},
): OutboxAttachPlan {
  const real = opts.real ?? (opts.probe ? (p: string) => opts.probe!(p)?.real ?? null : realOf)
  const send: string[] = []
  const refused: string[] = []
  for (const f of explicit) {
    const r = real(f)
    if (!r) { refused.push(basename(f)); continue }
    if (isDenied(r, opts.home)) { refused.push(basename(f)); continue }
    if (memo.has(turn, r) || send.some(s => real(s) === r)) continue
    send.push(f)
  }
  const plan = planAutoAttach(text, { already: explicit, home: opts.home, probe: opts.probe })
  const auto: string[] = []
  for (const f of plan.attach) {
    const r = real(f)
    if (!r || memo.has(turn, r)) continue
    auto.push(f)
  }
  for (const f of [...send, ...auto]) {
    const r = real(f)
    if (r) memo.add(turn, r)
  }
  const lines = [autoAttachFooter({ ...plan, attach: auto })]
  if (refused.length) lines.push(`not sent (protected or missing): ${refused.join(', ')}`)
  const all = [...send, ...auto]
  return {
    send: all,
    footer: lines.filter(Boolean).join('\n'),
    receipt: attachedNames({ attach: all, overflow: 0, tooLarge: [] }),
  }
}
