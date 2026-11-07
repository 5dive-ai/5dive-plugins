// DIVE-7835 (lodar 2026-11-07): an agent whose AI sign-in was revoked or
// expired answered every Telegram message with Claude's raw "OAuth token
// revoked · Please run /login" (the Stop hook's auto-relay of the turn's API
// error, or "The agent stopped with an error: …" from the StopFailure hook).
// The owner hears instead, in their language, that the sign-in stopped working
// and how to sign in again: /login (tappable in Telegram), which runs the
// on-box sign-in for the account this agent is bound to.
//
// What counts: Claude Code's own sign-in refusals (the CLI's
// SEAT_REFUSAL_TEXT_RE, its sign-in half, cmd_agent.sh) on an API-error
// message, or its `authentication_failed` error code. Never the agent's own
// words: a client asking about "/login" is conversation, so only an
// isApiErrorMessage entry, or the payload's own error fields, are read.
// An invalid API key or an empty balance is another fix (a key, a top-up), not
// a sign-in.

import type { TranscriptEntry, TranscriptContentBlock } from './types'
import type { Lang } from './lite'

const SIGNIN_RE = /oauth token (?:has expired|revoked)|please run \/login|not logged in/i
const NOT_SIGNIN_RE = /invalid api key|credit balance|billing_error/i

/** One line of Claude Code's: is it a sign-in refusal? */
export function isSigninRefusalText(text: string | null | undefined, error?: string | null): boolean {
  const t = text ?? ''
  if (NOT_SIGNIN_RE.test(t)) return false
  return error === 'authentication_failed' || SIGNIN_RE.test(t)
}

function entryText(e: TranscriptEntry): string {
  const content = e.message?.content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return (content as TranscriptContentBlock[])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join(' ')
}

/**
 * The turn ended on a sign-in refusal: the NEWEST assistant entry is Claude
 * Code's API-error message, and it is a sign-in refusal. An older refusal
 * followed by a real answer is a sign-in that has since worked.
 */
export function endedOnSigninRefusal(entries: TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'assistant') continue
    if (!e.isApiErrorMessage) return false
    return isSigninRefusalText(entryText(e), typeof e.error === 'string' ? e.error : null)
  }
  return false
}

type SigninPayload = { error?: unknown; error_details?: unknown; message?: unknown; reason?: unknown; last_assistant_message?: unknown }

/** A StopFailure payload whose own fields carry a sign-in refusal (same fields isTermsWall reads). */
export function isSigninPayload(payload: SigninPayload): boolean {
  const err = typeof payload.error === 'string' ? payload.error : null
  if (err === 'authentication_failed') return true
  const own = [payload.error_details, payload.message, payload.reason]
  if (own.some(v => typeof v === 'string' && isSigninRefusalText(v))) return true
  const last = payload.last_assistant_message
  return typeof last === 'string' && /^\s*API Error\b/i.test(last) && isSigninRefusalText(last)
}

/**
 * The line the chat gets. `owner`: the box owner, who can tap /login (it signs
 * in this agent's own account). `client`: a partner's client (lite profile),
 * who has no /login and signs in from their account page.
 */
export const SIGNIN_NOTICE: Record<'owner' | 'client', Record<Lang, string>> = {
  owner: {
    en: "My AI sign-in stopped working, so I can't answer right now. Tap /login to sign me in again.",
    ru: 'Мой вход в ИИ перестал работать, поэтому я сейчас не могу ответить. Нажмите /login, чтобы войти снова.',
  },
  client: {
    en: "My AI sign-in stopped working, so I can't answer right now. Sign in again in your account.",
    ru: 'Мой вход в ИИ перестал работать, поэтому я сейчас не могу ответить. Войдите снова в личном кабинете.',
  },
}

// The on-box profile names the CLI accepts (cmd_auth.sh valid_profile_name).
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * `/login`'s `agent auth start` argv. A seat bound to its own account signs in
 * THAT account (`--auth-profile=<it>`): without it the CLI signs in the box's
 * default login, and a seat on a revoked account stays revoked. An unbound
 * seat, `default`, or a name the CLI would refuse runs the default sign-in as
 * before.
 */
export function authStartArgv(type: string, authProfile: string | null | undefined): string[] {
  const p = authProfile?.trim()
  const scoped = p && p !== 'default' && PROFILE_RE.test(p) ? [`--auth-profile=${p}`] : []
  return ['agent', 'auth', 'start', type, ...scoped, '--json']
}

/** `/login` on a standard-tier seat, which cannot start a sign-in itself. */
export const LOGIN_ADMIN_TIER: Record<Lang, string> = {
  en: "I can't start a sign-in from this agent. Sign me in again from the dashboard (my page → Sign in), or ask your box admin.",
  ru: 'Я не могу начать вход с этого агента. Войдите снова в панели управления (моя страница → Войти) или попросите администратора сервера.',
}
