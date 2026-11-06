// plugins/teams/hosts.ts — which Microsoft hosts may receive this bot's token,
// and which may hand us a file. Pure; no dependencies, so `bun test` runs it
// on a runner with no plugin deps installed.
//
// Ported from OpenClaw's msteams extension (MIT, see ../../NOTICE):
//   extensions/msteams/src/bot-framework-service-url.ts  (service URL allowlist)
//   extensions/msteams/src/microsoft-hosts.ts            (Graph/SharePoint hosts)
//   extensions/msteams/src/file-consent.ts               (consent upload hosts)
//
// WHY IT MATTERS. Every outbound call carries a Bot Framework bearer token and
// goes to the `serviceUrl` the inbound activity named. A forged or replayed
// activity that names its own serviceUrl would make us post the token there.
// The JWT check (auth.ts) binds serviceUrl to a Microsoft-signed claim; this
// allowlist is the second lock, and the only one on the reply path.

// Bot Framework service URLs for the commercial, GCC, GCC High, DoD and
// 21Vianet clouds. These are the only hosts that may receive our token.
export const SERVICE_URL_HOSTS = [
  'smba.trafficmanager.net',
  'smba.infra.gcc.teams.microsoft.com',
  'smba.infra.gov.teams.microsoft.us',
  'smba.infra.dod.teams.microsoft.us',
  'botframework.azure.cn',
] as const

export const GRAPH_HOSTS = ['graph.microsoft.com', 'graph.microsoft.us', 'graph.microsoft.de', 'graph.microsoft.cn'] as const

export const SHAREPOINT_HOSTS = ['sharepoint.com', 'sharepoint.us', 'sharepoint.de', 'sharepoint.cn', 'sharepoint-df.com'] as const

// Where Teams may tell us to PUT a file the user accepted (FileConsentCard).
export const CONSENT_UPLOAD_HOSTS = [...SHAREPOINT_HOSTS, 'storage.live.com', 'onedrive.com', '1drv.ms', ...GRAPH_HOSTS] as const

// Where an inbound file may be downloaded from. SharePoint/OneDrive links carry
// their own pre-signed auth (no token sent). Inline images live on the Bot
// Framework attachment service and need our token, so those hosts are the
// service-URL list plus the Teams media hosts.
export const INBOUND_FILE_HOSTS = [...SHAREPOINT_HOSTS, 'onedrive.com', '1drv.ms'] as const
export const INBOUND_TOKEN_FILE_HOSTS = [...SERVICE_URL_HOSTS, 'asm.skype.com', 'asyncgw.teams.microsoft.com'] as const

export function hostMatches(hostname: string, list: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return list.some(e => h === e || h.endsWith(`.${e}`))
}

function httpsHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  return u.hostname
}

export function isAllowedServiceUrl(raw: unknown): raw is string {
  const h = httpsHost(raw)
  return !!h && hostMatches(h, SERVICE_URL_HOSTS)
}

// Throws on a host outside the list, so a caller cannot forget to check.
export function normalizeServiceUrl(raw: unknown): string {
  if (!isAllowedServiceUrl(raw)) {
    throw new Error(`refusing Teams serviceUrl host: ${httpsHost(raw) ?? 'invalid-url'}`)
  }
  return raw.trim().replace(/\/+$/, '')
}

export function isAllowedConsentUploadUrl(raw: unknown): boolean {
  const h = httpsHost(raw)
  return !!h && hostMatches(h, CONSENT_UPLOAD_HOSTS)
}

// 'open' = fetch with no token; 'token' = fetch with the bot token; null = refuse.
export function inboundFileAuth(raw: unknown): 'open' | 'token' | null {
  const h = httpsHost(raw)
  if (!h) return null
  if (hostMatches(h, INBOUND_TOKEN_FILE_HOSTS)) return 'token'
  if (hostMatches(h, INBOUND_FILE_HOSTS)) return 'open'
  return null
}

// A resolved address that is private, loopback or link-local. Used before a
// consent upload or a file download so a public name that resolves inward
// cannot turn us into a proxy onto the office network.
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase()
  if (v === '::1' || v === '::' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true
  const m4 = v.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m4) return false
  const [a, b] = [Number(m4[1]), Number(m4[2])]
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
