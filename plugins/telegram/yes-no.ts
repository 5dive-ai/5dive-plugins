// Wh-interrogatives introduce open questions, not yes/no questions. Keep this
// tiny classifier pure so the button detector can be tested without importing
// server.ts (which starts Telegram long-polling as an import side effect).
export const WH_INTERROGATIVE_RE = /^(what|which|who|whom|whose|where|when|why|how)\b/i

export function startsWithWhInterrogative(question: string): boolean {
  return WH_INTERROGATIVE_RE.test(question.trim())
}
