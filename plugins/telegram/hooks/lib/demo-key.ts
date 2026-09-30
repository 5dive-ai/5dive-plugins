/**
 * DIVE-5256: the free AI that came with a my.5dive server, used up.
 *
 * A my.5dive box holds its one-time demo key as a box account named `demo-ai`,
 * and every hire is bound to it until the owner connects their own AI (DIVE-5255,
 * wiki: a-my5dive-box-holds-its-demo-key-as-a-demo-ai-account-...). When the key
 * runs out, OpenRouter answers 403 "Key limit exceeded" and the agent goes quiet.
 * This module is the one place that decides "used up", and the once-per-key
 * notice that follows it.
 *
 * WHO. Only an agent whose bound account is `demo-ai` (AGENT_AUTH_PROFILE, set by
 * the box for the agent's whole process tree). That name exists only on a
 * my.5dive box, so a dashboard box (monthly key), a partner box (weekly key) and
 * an agent the owner already moved to their own AI all read 'not-demo' and
 * nothing changes for them. The account name, not the key's reset, is the
 * discriminator: an owner's own capped OpenRouter key must never be called "the
 * free AI that came with your server".
 *
 * DETECT. Read the key's remaining limit from OpenRouter (`GET /api/v1/key`,
 * which a key may call on itself — the same read /usage already makes). One
 * read decides for every trigger: the server's timer, an inbound message, and a
 * failed turn in the StopFailure hook. A failed turn that says "Key limit
 * exceeded" while the read itself fails counts as used up too.
 *
 * ONCE. A stamp per key fingerprint, created with O_EXCL, so the server and the
 * hook (two processes) cannot both send. Nothing re-triggers until the key
 * changes: a new key is a new fingerprint, and a read that finds credit on the
 * key again (a top-up) clears its stamp.
 *
 * Pure apart from the fs helpers: no grammy import, so the hooks can use it.
 */

import { createHash } from 'crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { liteAccountUrl, readChannelEnv, type Lang } from './lite'

export const DEMO_ACCOUNT = 'demo-ai'

/** Is this agent running on the box's demo account? Exact name only. */
export function onDemoAccount(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_AUTH_PROFILE ?? '').trim() === DEMO_ACCOUNT
}

export type DemoKeyState =
  | { kind: 'not-demo' }
  | { kind: 'unknown'; fingerprint: string | null }
  | { kind: 'left'; fingerprint: string; rearm: boolean }
  | { kind: 'used-up'; fingerprint: string }

/** The agent's key: the demo account is an OpenRouter account, so the bearer is
 *  ANTHROPIC_AUTH_TOKEN (else ANTHROPIC_API_KEY) against an openrouter.ai base. */
function agentKey(env: NodeJS.ProcessEnv): string | null {
  let host = ''
  try { host = new URL(env.ANTHROPIC_BASE_URL ?? '').hostname } catch {}
  if (!/(^|\.)openrouter\.ai$/i.test(host)) return null
  return env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || null
}

/** USD. Under this the key is used up whatever else we know. */
export const USED_UP_BELOW = 0.001
/** USD. A balance at or above this is credit again (a top-up re-arms). */
export const REARM_FLOOR = 0.05

/** A short, non-reversible name for a key. Never the key itself. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Where the demo key stands. `sawKeyLimit`: the caller already holds an
 * OpenRouter "Key limit exceeded" for this key (the StopFailure payload), so an
 * unreadable limit still counts as used up. Never throws.
 */
export async function readDemoKey(
  opts: { sawKeyLimit?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<DemoKeyState> {
  if (!onDemoAccount(env)) return { kind: 'not-demo' }
  const key = agentKey(env)
  if (!key) return { kind: 'unknown', fingerprint: null }
  const fingerprint = keyFingerprint(key)
  const fallback: DemoKeyState = opts.sawKeyLimit ? { kind: 'used-up', fingerprint } : { kind: 'unknown', fingerprint }
  try {
    const res = await fetchFn('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return fallback
    const d = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {}
    if (d.limit == null) return { kind: 'left', fingerprint, rearm: true }
    const remaining = Number(d.limit_remaining)
    if (!Number.isFinite(remaining)) return fallback
    // OpenRouter refuses a request whose estimate would overrun the key, so a
    // key can stop with a few cents still on it. Below REARM_FLOOR a 403 in hand
    // is believed over the balance, and only a balance above it (a top-up)
    // re-arms the notice; otherwise the timer and the failed turns would
    // alternate re-arming and re-sending.
    if (remaining < USED_UP_BELOW || (opts.sawKeyLimit && remaining < REARM_FLOOR)) return { kind: 'used-up', fingerprint }
    return { kind: 'left', fingerprint, rearm: remaining >= REARM_FLOOR }
  } catch {
    return fallback
  }
}

/** An OpenRouter per-key cap in a failure's text (403, not 402: 402 is the
 *  account's balance, which is not this key's). */
export function isKeyLimitText(raw: string): boolean {
  return /key limit exceeded/i.test(raw)
}

const STAMP_PREFIX = 'demo-used-up.'

/** Claim the one notice for this key. true = this caller sends it; false =
 *  already sent (by this process, the server, or the hook). O_EXCL makes the
 *  claim atomic across processes. An unwritable state dir claims nothing:
 *  better one notice missed than one on every failed turn. */
export function claimDemoNotice(stateDir: string, fingerprint: string): boolean {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, STAMP_PREFIX + fingerprint), new Date().toISOString() + '\n', { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Give back a claim whose send failed, so the next trigger tries again. */
export function releaseDemoNotice(stateDir: string, fingerprint: string): void {
  try { rmSync(join(stateDir, STAMP_PREFIX + fingerprint), { force: true }) } catch {}
}

/** The key has credit again (topped up): the next time it runs out is news. */
export function rearmDemoNotice(stateDir: string, fingerprint: string): void {
  releaseDemoNotice(stateDir, fingerprint)
}

/** Stamps of keys this agent no longer runs on are dropped, so a replaced key
 *  leaves nothing behind. Keeps `keep`. */
export function pruneDemoStamps(stateDir: string, keep: string): void {
  try {
    for (const f of readdirSync(stateDir)) {
      if (f.startsWith(STAMP_PREFIX) && f !== STAMP_PREFIX + keep) rmSync(join(stateDir, f), { force: true })
    }
  } catch {}
}

// ── the notice ───────────────────────────────────────────────────────────────
// Plain words, the agent speaking: no platform, provider, model, key or cost.

export const DEMO_STRINGS = {
  en: {
    usedUp: 'I\'ve used up the free AI that came with your server. Connect your own AI subscription to keep me talking and speaking.',
    connectButton: 'Connect my AI',
  },
  ru: {
    usedUp: 'Бесплатный ИИ, который шёл вместе с вашим сервером, закончился. Подключите свою ИИ-подписку, и я снова смогу отвечать и говорить.',
    connectButton: 'Подключить свой ИИ',
  },
} as const

export function demoNoticeText(lang: Lang): string {
  return DEMO_STRINGS[lang].usedUp
}

export type UrlButton = { text: string; url: string }

/**
 * The notice's buttons, one per row. Today: Connect my AI. The list is the
 * extension point for a later "Top up with Stars" (lodar, 2026-09-30: not now),
 * which becomes one more entry here. No URL → no buttons, the text still goes.
 */
export function demoNoticeButtons(lang: Lang, accountUrl: string | null): UrlButton[] {
  const rows: UrlButton[] = []
  if (accountUrl) rows.push({ text: DEMO_STRINGS[lang].connectButton, url: accountUrl })
  return rows
}

/** Bot API reply_markup for the buttons, or undefined for none. */
export function demoNoticeMarkup(buttons: UrlButton[]): { inline_keyboard: UrlButton[][] } | undefined {
  return buttons.length ? { inline_keyboard: buttons.map(b => [b]) } : undefined
}

/** Where Connect goes: the box's account URL (the lite /account target, the
 *  Mini App on a my.5dive box), else the 5dive Mini App itself. */
export const DEMO_DEFAULT_ACCOUNT_URL = 'https://t.me/FiveDiveBot?startapp'

export function demoAccountUrl(env: NodeJS.ProcessEnv = process.env): string {
  return liteAccountUrl(readChannelEnv('TELEGRAM_ACCOUNT_URL', env)) ?? DEMO_DEFAULT_ACCOUNT_URL
}
