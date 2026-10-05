// lodar 2026-10-05: Codex writes Markdown, and a plain-text Telegram message
// shows it literally ("**Done**" arrives with its asterisks). An answer sent
// without a parse_mode goes through here first: emphasis, headings, inline
// code and link syntax are taken off, the words stay. Conservative on purpose —
// snake_case, globs, `a * b` and 2*3 are not emphasis and are left alone, and a
// fenced block keeps its contents verbatim (only the ``` lines go).

const FENCE = /^\s*(```|~~~)/

function plainLine(line: string): string {
  return line
    .replace(/^(\s{0,3})#{1,6}\s+/, '$1') // "## Heading" -> "Heading"
    .replace(/^(\s*)>\s?/, '$1') // "> quote" -> "quote"
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)') // [text](url) -> text (url)
    .replace(/`([^`\n]+)`/g, '$1') // `code` -> code
    .replace(/(^|[^\w*])\*\*(?=\S)([^\n]*?\S)\*\*(?![\w*])/g, '$1$2') // **bold**
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2') // *italic*
    .replace(/(^|[^\w~])~~(?=\S)([^\n]*?\S)~~(?![\w~])/g, '$1$2') // ~~strike~~
}

export function stripMarkdown(text: string): string {
  let inFence = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { inFence = !inFence; continue }
    out.push(inFence ? line : plainLine(line))
  }
  return out.join('\n')
}
