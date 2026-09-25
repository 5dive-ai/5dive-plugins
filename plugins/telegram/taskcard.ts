// DIVE-4949 (lodar, 2026-09-25): the /task_<id> card is the founder's phone view
// of a row. It could not answer a gate and it could not say why a row was blocked —
// /task_5114 showed `status: blocked` and nothing else, so the reason took a chat
// round ("why DIVE-4927 blocked how to unlock?").
//
// Pure pieces only, so the harness grades the strings and the button choice without
// a bot, a box, or the long-polling server.ts import:
//   taskStateLines()   — why blocked / wakes when / blockers, delivery state,
//                        verifier, last gate outcome, age.
//   cardGateAction()   — which answer control (if any) the card offers for a gate.
//   resolveCardTap()   — the tap-side re-check before `task answer` runs.
//
// CONSUME THE VERDICT, NEVER THE INPUTS (DIVE-3224/3340). The tier rule and the
// "needs a human" rule live CLI-side; this module reads `gate_live`, `needs_human`
// and `tier` off `task show --json` and never re-derives them from routed_reviewer
// or need_type. The CLI re-enforces tier<2 on `task answer --channel-proof`, so a
// wrong choice here is refused there, not honoured.

import { resolveTnaAnswer, type TnaGate } from './tna.ts'

export const DASHBOARD_TASKS_URL = 'https://5dive.ai/dashboard/tasks'

// The CLI writes SQLite `datetime('now')` stamps: UTC, space-separated, no zone.
export function parseCliTs(ts: unknown): number | null {
  const s = String(ts ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(s)) return null
  const iso = s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z')
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** "5h ago" / "in 5h" / "just now". Coarse on purpose: a phone glance, not a log. */
export function relTime(ts: unknown, now: number): string | null {
  const ms = parseCliTs(ts)
  if (ms === null) return null
  const d = ms - now
  const a = Math.abs(d)
  if (a < 60_000) return 'just now'
  const m = Math.round(a / 60_000)
  const span = m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  return d > 0 ? `in ${span}` : `${span} ago`
}

function one(s: unknown, max: number): string {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > max ? v.slice(0, max - 1) + '…' : v
}

function prLabel(ref: string): string {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(ref)
  return m ? `${m[1]}#${m[2]}` : ref
}

/** The first http(s) URL in delivery_ref, or null. The field can hold a bare sha. */
export function deliveryUrl(t: any): string | null {
  const m = /https?:\/\/\S+/.exec(String(t?.delivery_ref ?? ''))
  return m ? m[0] : null
}

export function isParked(t: any): boolean {
  return !!(t?.parked_at && t?.wake_at && t?.status !== 'done' && t?.status !== 'cancelled')
}

/** The lines the card was missing. `blockedBy` is `task show --json`'s data.blocked_by. */
export function taskStateLines(t: any, blockedBy: any[], gateLive: boolean, now: number): string[] {
  const out: string[] = []
  const open = t.status !== 'done' && t.status !== 'cancelled'

  // 1. WHY BLOCKED + WHEN IT UNBLOCKS. The one that cost the round.
  if (open && (t.park_reason || t.wake_at)) {
    const wake = relTime(t.wake_at, now)
    const wakeTxt = wake ? (wake.endsWith('ago') ? `wake was due ${wake}` : `wakes ${wake}`) : ''
    out.push(`⏸ parked${wakeTxt ? ` — ${wakeTxt}` : ''}${t.wake_at ? ` (${String(t.wake_at)} UTC)` : ''}`)
    if (t.park_reason) out.push(`   why: ${one(t.park_reason, 300)}`)
  }
  const openBlockers = (Array.isArray(blockedBy) ? blockedBy : []).filter(
    b => b && b.status !== 'done' && b.status !== 'cancelled',
  )
  if (open && openBlockers.length) {
    out.push(`⛓ waiting on: ${openBlockers.slice(0, 5).map(b => `${b.ident} [${b.status}]`).join(', ')}${openBlockers.length > 5 ? ` +${openBlockers.length - 5}` : ''}`)
  }

  // 2. DELIVERY STATE, one line.
  if (t.delivery_ref) {
    const url = deliveryUrl(t)
    const parts = [`📦 ${url ? prLabel(url) : one(t.delivery_ref, 60)}`]
    if (t.graded_verdict) parts.push(`graded ${t.graded_verdict}${t.graded_by ? ` by ${t.graded_by}` : ''}`)
    else if (t.delivered_at) parts.push(`delivered ${relTime(t.delivered_at, now) ?? t.delivered_at}, not graded yet`)
    if (t.merge_landed_at) {
      parts.push(`merged ${relTime(t.merge_landed_at, now) ?? t.merge_landed_at}`)
      if (open) parts.push('owed a close')
    }
    out.push(parts.join(' · '))
  }

  // 3. VERIFIER / ROUTED REVIEWER.
  const who: string[] = []
  if (t.verifier) who.push(`verifier: ${t.verifier}`)
  if (t.routed_reviewer) who.push(`reviewer: ${t.routed_reviewer}`)
  if (who.length) out.push(who.join('  ·  '))

  // 4. LAST GATE OUTCOME. Today an answered gate disappears from the card. `gate`
  // is the CLI's own verdict string (_task_gate_header_sql) — rendered, not rebuilt.
  if (!gateLive && t.gate && t.gate !== 'none') {
    const g = String(t.gate).replace(/\s*Full record:.*$/, '').replace(/;\s*the live row carries no gate\.?/, '')
    out.push(`gate: ${one(g, 200)}`)
  }

  // 5. AGE.
  const c = relTime(t.created_at, now)
  const u = relTime(t.updated_at, now)
  if (c || u) out.push(`age: ${c ? `created ${c}` : ''}${c && u ? ' · ' : ''}${u ? `updated ${u}` : ''}`)
  return out
}

// ---------------------------------------------------------------------------
// Gate answer controls on the card.
// ---------------------------------------------------------------------------

export function splitOptions(raw: unknown): string[] {
  return String(raw ?? '').split('|').map(s => s.trim()).filter(Boolean)
}

/** 6 base36 chars of FNV-1a over need_options. Rides in callback_data so a tap
 *  made against an OLD option list cannot answer with the index's NEW meaning. */
export function optionsTag(raw: unknown): string {
  let h = 0x811c9dc5
  for (const ch of String(raw ?? '')) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(6, '0').slice(-6)
}

export const GANS_RE = /^gans:(\d+):(\d+|approved|denied):([0-9a-z]{6})$/
export const GRESEND_RE = /^gresend:(\d+)$/
export const TWAKE_RE = /^twake:(\d+)$/

export type CardGateAction =
  | { kind: 'none'; why: string }
  | { kind: 'buttons'; buttons: { label: string; data: string }[] }
  | { kind: 'resend'; data: string }

function tierOf(t: any): number | null {
  if (t?.tier === undefined || t?.tier === null || t?.tier === '') return null
  const n = Number(t.tier)
  return Number.isFinite(n) ? n : null
}

/**
 * Which answer control the card offers. Every branch reads a CLI verdict:
 *   not live / routed to an agent       → none (not his to answer)
 *   secret / manual                     → none (text route; secrets never enter chat)
 *   tier 2, or tier unknown             → resend (the CLI mints the nonce buttons)
 *   tier<2 decision with options        → one button per option, ⭐ on the rec
 *   tier<2 approval                     → Approve / Deny
 * An UNKNOWN tier reads as 2, the CLI's own fail-safe direction (inbox.sh NULLIF):
 * the worst case is a re-sent alert, never a plugin-minted control on a hard gate.
 */
export function cardGateAction(t: any, gateLive: boolean, needsHuman: boolean): CardGateAction {
  if (!gateLive) return { kind: 'none', why: 'no live gate' }
  if (!needsHuman) return { kind: 'none', why: 'routed to an agent' }
  const type = String(t.need_type ?? '')
  if (type === 'secret' || type === 'manual') return { kind: 'none', why: `${type} gate` }
  const tier = tierOf(t)
  if (tier === null || tier >= 2) return { kind: 'resend', data: `gresend:${t.id}` }
  const tag = optionsTag(t.need_options)
  if (type === 'decision') {
    const opts = splitOptions(t.need_options)
    if (!opts.length) return { kind: 'none', why: 'decision without options' }
    const rec = String(t.recommend ?? '').trim()
    return {
      kind: 'buttons',
      buttons: opts.map((o, i) => ({
        label: `${o === rec ? '⭐ ' : ''}${o.length > 60 ? o.slice(0, 59) + '…' : o}`,
        data: `gans:${t.id}:${i}:${tag}`,
      })),
    }
  }
  if (type === 'approval') {
    return {
      kind: 'buttons',
      buttons: [
        { label: '✅ Approve', data: `gans:${t.id}:approved:${tag}` },
        { label: '❌ Deny', data: `gans:${t.id}:denied:${tag}` },
      ],
    }
  }
  return { kind: 'none', why: `no card control for a ${type || 'typeless'} gate` }
}

export type CardTap =
  | { kind: 'answer'; answerArgs: string[]; ack: string }
  | { kind: 'stale'; toast: string }

/**
 * The tap-side re-check, against a FRESH `task show --json`. The card may be hours
 * old; the gate may have been answered, re-filed, re-routed or re-optioned since.
 * Every one of those is refused here rather than answered with a stale meaning.
 */
export function resolveCardTap(t: any, token: string, tag: string): CardTap {
  if (!t) return { kind: 'stale', toast: 'Task not found.' }
  const gateLive = t.gate_live !== undefined
    ? Number(t.gate_live) === 1
    : !!(t.need_type && !t.need_answered_at && t.status !== 'done' && t.status !== 'cancelled')
  const needsHuman = t.needs_human !== undefined ? Number(t.needs_human) === 1 : gateLive
  if (!gateLive) return { kind: 'stale', toast: 'This gate is no longer open.' }
  const action = cardGateAction(t, gateLive, needsHuman)
  if (action.kind !== 'buttons') {
    return { kind: 'stale', toast: 'This gate changed since the card was sent — reopen /task to see it.' }
  }
  if (optionsTag(t.need_options) !== tag) {
    return { kind: 'stale', toast: 'The options changed since the card was sent — reopen /task to see them.' }
  }
  const r = resolveTnaAnswer(t as TnaGate, token)
  if (r.kind === 'answer') return { kind: 'answer', answerArgs: r.answerArgs, ack: r.ack }
  if (r.kind === 'already') return { kind: 'stale', toast: r.toast }
  return { kind: 'stale', toast: 'That option is no longer valid.' }
}
