// The 5dive app spool: the file contract between the box's dashboard bridge
// (5dive-plugins: plugins/dashboard/server.ts) and an agent that answers its
// web chat. Pure node:fs, no runtime imports, so the tests drive it directly.
// The SAME file ships in @5dive/pi-chat and @5dive/opencode-chat (a parity
// test keeps the two copies byte for byte).
//
//   <spool>/inbox/<id>.json             written by the bridge, read here
//     {"id": "...", "text": "...",
//      "route": {"source": "dashboard", "chat_id": "dashboard", "voice": true},
//      "image_path": "/abs/path/on/this/box"}      // optional upload
//
//   <spool>/outbox/dashboard/<id>.json  written here, sent to the chat by the bridge
//     {"source": "dashboard", "chat_id": "dashboard", "text": "...", "kind": "message"}
//
//   <spool>/reader.json                 written here while this package reads
//     {"pid": 1234, "by": "pi"}         the bridge's own headless reader stands
//                                       down while that pid is alive
//
// Both sides write a temp name and rename it to `*.json`, so a reader never
// sees half a file. The spool is mode 0700 for the agent's own user: anyone
// who can write into it already is that user, so no token is needed.

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Runtime = "pi" | "opencode";
export type Route = { source: "dashboard"; chat_id: string; voice?: true };
export type ChatMessage = { id: string; text: string; route: Route; file?: string };

export const LABEL: Record<Runtime, string> = { pi: "Pi", opencode: "OpenCode" };
export const HEADER = "[5dive web chat: a person typed this in the 5dive app. Your final answer is sent back to that chat as you write it.]";
export const VOICE_HINT = "[It was spoken: answer in one to three short sentences with no lists, links or code; your answer is spoken back.]";
export const noAnswerText = (rt: Runtime) => `${LABEL[rt]} worked on your message but did not write an answer. Try asking again.`;
export const failedText = (rt: Runtime, reason = "") =>
  reason ? `${LABEL[rt]} could not answer: ${reason}` : `${LABEL[rt]} could not answer just now. Try again in a minute.`;

/** FIVEDIVE_SPOOL_DIR, else where a 5dive box's bridge keeps this runtime's spool. */
export function spoolDir(rt: Runtime, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const set = (env.FIVEDIVE_SPOOL_DIR ?? "").trim();
  return set || join(home, rt === "pi" ? ".pi" : ".opencode", "channels", "5dive");
}

export const inboxDir = (spool: string) => join(spool, "inbox");
export const outboxDir = (spool: string) => join(spool, "outbox", "dashboard");
export const readerFile = (spool: string) => join(spool, "reader.json");

export function ensureSpool(spool: string): void {
  mkdirSync(inboxDir(spool), { recursive: true, mode: 0o700 });
  mkdirSync(outboxDir(spool), { recursive: true, mode: 0o700 });
}

/** One parsed inbox file as a message, or null when it is not one. */
export function parseMessage(raw: unknown, fallbackId: string): ChatMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const r = m.route as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || r.source !== "dashboard") return null;
  const text = typeof m.text === "string" ? m.text.trim() : "";
  const file = typeof m.image_path === "string" && m.image_path.startsWith("/") ? m.image_path : "";
  if (!text && !file) return null;
  return {
    id: typeof m.id === "string" && m.id ? m.id : fallbackId,
    text,
    route: { source: "dashboard", chat_id: typeof r.chat_id === "string" && r.chat_id ? r.chat_id : "dashboard", ...(r.voice === true ? { voice: true as const } : {}) },
    ...(file ? { file } : {}),
  };
}

/**
 * Take every complete message waiting in the inbox, oldest first (the bridge
 * names files by time). A file is removed before its message is handed on, so
 * a restart never answers it twice; a file that is not a message is removed
 * too, or every poll would trip on it. Temp files (`.name.tmp`) are left alone.
 */
export function takeInbox(spool: string): ChatMessage[] {
  let names: string[];
  try {
    names = readdirSync(inboxDir(spool)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const name of names) {
    const full = join(inboxDir(spool), name);
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
      unlinkSync(full);
    } catch {
      continue; // another reader took it
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const msg = parseMessage(parsed, name.slice(0, -5));
    if (msg) out.push(msg);
  }
  return out;
}

/** What one chat message becomes as a turn: the same text the bridge's own reader sends. */
export function promptFor(msg: ChatMessage): string {
  const parts = [HEADER];
  if (msg.route.voice) parts.push(VOICE_HINT);
  if (msg.text) parts.push(msg.text);
  if (msg.file) parts.push(/\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)$/i.test(msg.file) ? `[Voice note: ${msg.file}]` : `[Attached file: ${msg.file}]`);
  return parts.join("\n");
}

let seq = 0;
/** Queue one reply for the bridge to send to the chat. */
export function writeReply(spool: string, route: Route, text: string, tag: string): string {
  const dir = outboxDir(spool);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${process.pid}-${tag}-${seq++}`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...route, text, kind: "message" }) + "\n", { mode: 0o600 });
  renameSync(tmp, join(dir, `${name}.json`));
  return join(dir, `${name}.json`);
}

/** Mark this process as the spool's reader, so the bridge's headless reader stands down. */
export function claimReader(spool: string, by: Runtime, pid = process.pid): void {
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  const tmp = join(spool, `.reader.${pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ pid, by }) + "\n", { mode: 0o600 });
  renameSync(tmp, readerFile(spool));
}

/** Drop the mark, only if it is still ours. */
export function releaseReader(spool: string, pid = process.pid): void {
  try {
    const cur = JSON.parse(readFileSync(readerFile(spool), "utf8")) as { pid?: unknown };
    if (cur.pid === pid) unlinkSync(readerFile(spool));
  } catch {}
}
