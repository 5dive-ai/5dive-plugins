// plugins/teams/auth.ts — is this request really from Microsoft, for THIS bot?
//
// Bot Framework signs every activity it posts to us with a JWT:
//   iss = https://api.botframework.com     aud = our App ID
//   kid names a key in Microsoft's published JWKS, and that key must ENDORSE
//   the channel ("msteams") — a key Microsoft uses for another channel is not
//   good for Teams.
//   serviceUrl claim = the activity's serviceUrl (binds where we reply).
// https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
//
// Pure apart from the injected `deps`: the signature check itself (jose) is
// handed in by server.ts, so this file and its tests need no packages.

export const BF_OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
export const BF_ISSUER = 'https://api.botframework.com'
export const CLOCK_SKEW_S = 300

export type Jwk = { kid?: string; endorsements?: string[]; [k: string]: unknown }

export type VerifyDeps = {
  // Microsoft's current signing keys (cached by the caller).
  keys: () => Promise<Jwk[]>
  // Check the signature with one key; return the payload or throw.
  verifySignature: (token: string, key: Jwk) => Promise<Record<string, unknown>>
  now?: () => number
}

export type Verdict = { ok: true } | { ok: false; why: string }

export function bearer(header: string | null | undefined): string | null {
  const m = String(header ?? '').match(/^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/)
  return m ? m[1] : null
}

export function decodeHeader(token: string): { kid?: string; alg?: string } | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// Claim checks, after the signature is good. Separate so the tests can grade
// every refusal without a real key.
export function checkClaims(
  p: Record<string, unknown>,
  activity: { serviceUrl?: unknown; channelId?: unknown },
  appId: string,
  nowS: number,
): Verdict {
  if (p.iss !== BF_ISSUER) return { ok: false, why: `issuer ${String(p.iss)}` }
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud]
  if (!aud.some(a => String(a).toLowerCase() === appId.toLowerCase())) return { ok: false, why: 'audience is not this bot' }
  const exp = Number(p.exp)
  if (!Number.isFinite(exp) || exp + CLOCK_SKEW_S < nowS) return { ok: false, why: 'token expired' }
  const nbf = Number(p.nbf ?? 0)
  if (Number.isFinite(nbf) && nbf - CLOCK_SKEW_S > nowS) return { ok: false, why: 'token not yet valid' }
  const su = String(p.serviceurl ?? p.serviceUrl ?? '').replace(/\/+$/, '')
  const asu = String(activity.serviceUrl ?? '').replace(/\/+$/, '')
  if (!su || su.toLowerCase() !== asu.toLowerCase()) return { ok: false, why: 'serviceUrl does not match the token' }
  return { ok: true }
}

export async function verifyRequest(
  authHeader: string | null | undefined,
  activity: { serviceUrl?: unknown; channelId?: unknown },
  appId: string,
  deps: VerifyDeps,
): Promise<Verdict> {
  const token = bearer(authHeader)
  if (!token) return { ok: false, why: 'no bearer token' }
  const hdr = decodeHeader(token)
  if (!hdr?.kid) return { ok: false, why: 'token has no key id' }
  if (hdr.alg && hdr.alg !== 'RS256') return { ok: false, why: `alg ${hdr.alg}` }
  let keys: Jwk[]
  try {
    keys = await deps.keys()
  } catch (e) {
    return { ok: false, why: `could not load Microsoft signing keys: ${e}` }
  }
  const key = keys.find(k => k.kid === hdr.kid)
  if (!key) return { ok: false, why: 'unknown signing key' }
  const channel = String(activity.channelId ?? '')
  if (!Array.isArray(key.endorsements) || !key.endorsements.includes(channel)) {
    return { ok: false, why: `signing key does not endorse channel ${channel || '?'}` }
  }
  let payload: Record<string, unknown>
  try {
    payload = await deps.verifySignature(token, key)
  } catch (e) {
    return { ok: false, why: `bad signature: ${e}` }
  }
  return checkClaims(payload, activity, appId, Math.floor((deps.now?.() ?? Date.now()) / 1000))
}

// Outbound: the bot's own token, client-credentials against the CUSTOMER's
// tenant (single-tenant app). Cached until five minutes before expiry.
export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>

export function makeTokenSource(cfg: { tenant_id: string; app_id: string; app_password: string }, f: TokenFetch = fetch) {
  let cached: { token: string; until: number } | null = null
  let inflight: Promise<string> | null = null
  return async function token(): Promise<string> {
    if (cached && cached.until > Date.now()) return cached.token
    if (inflight) return inflight
    inflight = (async () => {
      const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant_id)}/oauth2/v2.0/token`
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.app_id,
        client_secret: cfg.app_password,
        scope: 'https://api.botframework.com/.default',
      })
      const r = await f(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok || typeof j.access_token !== 'string') {
        // Never echo the response whole: on some errors it quotes the request.
        throw new Error(`Microsoft sign-in for the bot failed (${r.status} ${j.error ?? ''})`.trim())
      }
      cached = { token: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in) - 300) * 1000 }
      return cached.token
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }
}
