// Helpers for the OpenCode plugin, kept out of index.ts: OpenCode starts every
// function index.ts exports as a plugin.

export type Part = { type?: string; text?: string; synthetic?: boolean };

/** `opencode run …` is a one-shot turn: it must not take chat messages. */
export function isOneShot(argv: string[] = process.argv): boolean {
  return argv.slice(1, 4).includes("run");
}

/** The answer in a reply's parts: the text after the last tool call, else every text part. */
export function answerText(parts: Part[]): string {
  const texts: string[] = [];
  let after: string[] = [];
  let sawTool = false;
  for (const p of parts) {
    if (p?.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim()) {
      texts.push(p.text.trim());
      after.push(p.text.trim());
    } else if (p?.type === "tool") {
      sawTool = true;
      after = [];
    }
  }
  return (sawTool && after.length ? after : texts).join("\n\n");
}
