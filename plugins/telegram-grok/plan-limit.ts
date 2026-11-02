// DIVE-7565 — a Grok seat that has used up its plan says so in plain words.
//
// What an owner got on 2026-11-02 (chill-gorge, seat dude, 5dive 0.110.0):
//   "⚠️ grok: API error (status 402 Payment Required): Grok Build usage balance exhausted"  (twice)
//   "⚠️ dude stopped responding — not responding — cause unknown. … Try /restart"
// while the pane's status bar read "Weekly limit left: 0% · Grok 4.7 (high)" and a
// "Help improve Grok [Opt out] [Opt in]" box sat on top of the input. /restart
// cannot fix a used-up plan, and three messages for one cause is two too many.
//
// Pure, so test/dive7565-grok-plan-used-up.test.ts runs it on the real pane text.
// Shared by server.ts (stall alert, stall auto-reply, the opt-in box) and
// hooks/notification-relay.ts (the raw 402 relay); one marker file in the
// channel state dir makes the owner notice go out ONCE per limit hit, whichever
// of the two processes sees it first.

import { statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Grok only. The generator's `plan-limit-off` block turns this off in every other
// runtime it renders from this base: their CLIs never print these words, and
// the row was scoped to the runtime that does (do not widen).
export const PLAN_ON = true

// Grok's own words for a used-up plan, verbatim from the pane above.
const PLAN_USED_UP_RE = /balance exhausted|\b402 Payment Required\b|Weekly limit left:\s*0%/i

export function planUsedUp(text: string): boolean {
  return PLAN_ON && PLAN_USED_UP_RE.test(text)
}

// A reset time, only when the screen shows one. Never invented.
export function planResetHint(text: string): string | null {
  const m = text.match(/\bresets? (?:in|at|on)\b[^\n│·|]*/i)
  if (!m) return null
  const s = m[0].trim().replace(/[.\s]+$/, '')
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null
}

// The one line the owner gets. Plain words: no status codes, no /restart.
export function planUsedUpText(name: string, text = ''): string {
  const who = name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Your agent'
  const reset = planResetHint(text)
  return `${who} has used up this week's Grok plan, so it can't answer until the limit resets.`
    + (reset ? ` ${reset}.` : '')
    + ' To keep going now, upgrade the plan at grok.com.'
}

// ── once per limit hit ─────────────────────────────────────────────────────
// A weekly plan resets within a week, so a marker older than that belongs to an
// earlier hit. server.ts also clears it the moment the agent answers again.
export const PLAN_NOTICE_FILE = 'plan-used-up-notice'
export const PLAN_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** True exactly once per limit hit: the caller that gets true sends the notice. */
export function claimPlanNotice(stateDir: string, now = Date.now()): boolean {
  const p = join(stateDir, PLAN_NOTICE_FILE)
  try {
    if (now - statSync(p).mtimeMs < PLAN_NOTICE_TTL_MS) return false
    unlinkSync(p)  // stale: an earlier hit
  } catch {}
  try {
    // 'wx' = create only if absent, so two hooks firing together cannot both win.
    writeFileSync(p, new Date(now).toISOString() + '\n', { flag: 'wx' })
    return true
  } catch (err: any) {
    // Someone else just claimed it. Any other failure (no state dir): send rather
    // than stay silent — a duplicate beats an owner who is never told.
    return err?.code !== 'EEXIST'
  }
}

export function clearPlanNotice(stateDir: string): void {
  try { unlinkSync(join(stateDir, PLAN_NOTICE_FILE)) } catch {}
}

// ── the "Help improve Grok" box ────────────────────────────────────────────
// Grok asks once per account whether it may keep coding data for training. The
// answer is stored on the account, not in config.toml (the CLI has no setting
// that skips it), so the bridge answers it: Opt out, never Opt in.
export function optInBoxShowing(pane: string): boolean {
  return PLAN_ON && /Help improve Grok/.test(pane) && /\[\s*Opt out\s*\]/.test(pane)
}

/**
 * Which answer the box has selected, read from a styled capture
 * (`tmux capture-pane -e`): true = Opt out, false = Opt in, null = cannot tell.
 * The selected answer is the one drawn with emphasis (reverse video, a
 * background colour, or bold) that the other lacks. The caller presses Enter
 * only on true; anything else is dismissed, which leaves sharing at Grok's own
 * default (off), so this can never opt in.
 */
export function optOutSelected(styled: string): boolean | null {
  const line = styled.split('\n').find((l) => /Opt out/.test(l.replace(/\x1b\[[0-9;:]*m/g, '')) && /Opt in/.test(l.replace(/\x1b\[[0-9;:]*m/g, '')))
  if (!line) return null
  const out = emphasisAt(line, 'Opt out')
  const inn = emphasisAt(line, 'Opt in')
  if (out === null || inn === null || out === inn) return null
  return out > inn
}

// Emphasis score of the SGR state in force where `word` starts on `line`.
function emphasisAt(line: string, word: string): number | null {
  let state: string[] = []
  let plain = ''
  const segs: Array<{ start: number; score: number }> = []
  const re = /\x1b\[([0-9;:]*)m|([^\x1b]+)|\x1b/g
  for (let m; (m = re.exec(line)); ) {
    if (m[1] !== undefined) {
      const codes = m[1] === '' ? ['0'] : m[1].split(';')
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i]!
        if (c === '0') { state = []; continue }
        if (c === '38' || c === '48') {
          // extended colour (38;5;n or 38;2;r;g;b) is one code
          const n = codes[i + 1] === '2' ? 4 : 2
          state.push(codes.slice(i, i + 1 + n).join(';'))
          i += n
          continue
        }
        if (c === '27') { state = state.filter((x) => x !== '7'); continue }
        if (c === '22') { state = state.filter((x) => x !== '1'); continue }
        if (c === '49') { state = state.filter((x) => !/^(4[0-7]|10[0-7]|48;)/.test(x)); continue }
        state.push(c)
      }
      continue
    }
    const text = m[2] ?? ''
    if (!text) continue
    let score = 0
    if (state.includes('7')) score += 4                                  // reverse video
    if (state.some((c) => /^(4[0-7]|10[0-7]|48;)/.test(c))) score += 2   // background colour
    if (state.includes('1')) score += 1                                  // bold
    segs.push({ start: plain.length, score })
    plain += text
  }
  const at = plain.indexOf(word)
  if (at === -1) return null
  let score: number | null = null
  for (const sg of segs) if (sg.start <= at) score = sg.score
  return score
}
