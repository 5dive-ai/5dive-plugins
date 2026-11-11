// The 5dive app spool: the file contract between the box's dashboard bridge
// (plugins/dashboard/server.ts) and this channel. Pure node:fs, no OpenClaw
// imports, so the unit tests drive it directly.
//
//   <spool>/inbox/<id>.json             written by the bridge, read here
//     {"id": "...", "text": "...",
//      "route": {"source": "dashboard", "chat_id": "dashboard", "voice": true},
//      "image_path": "/abs/path/on/this/box",      // optional upload
//      "received_at": "2026-10-30T23:00:00Z"}
//
//   <spool>/outbox/dashboard/<id>.json  written here, sent to the chat by the bridge
//     {"source": "dashboard", "chat_id": "dashboard", "text": "...",
//      "files": ["/abs/path"], "voice": true}
//
//   <spool>/reader.json                 written here while the gateway reads
//     {"pid": 1234, "by": "openclaw"}   the bridge's own reader stands down
//                                       while that pid is alive (DIVE-8177)
//
// Both sides write a temp name first and rename it to `*.json`, so a reader
// never sees half a file. The spool is mode 0700 for the agent's own user:
// anyone who can write into it is that user, which is why the channel needs
// no token. Same contract as the Hermes plugin (plugins/dashboard/hermes/adapter.py).

import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { basename, join } from "node:path";

/** The one sender the bridge writes as: the person signed in to 5dive. */
export const SENDER_ID = "5dive-app";
export const CHAT_LABEL = "5dive app";
export const DEFAULT_CHAT_ID = "dashboard";
/** Matches the web chat's own message ceiling. */
export const MAX_MESSAGE_LENGTH = 16000;

export type SpoolRoute = { source: "dashboard"; chat_id: string; voice?: boolean };

export type SpoolMessage = {
  id: string;
  text: string;
  route: SpoolRoute;
  /** An upload the bridge already fetched to this box. */
  imagePath?: string;
  /** Milliseconds since the epoch. */
  receivedAt: number;
};

export type OutboxReply = {
  source: "dashboard";
  chat_id: string;
  text: string;
  files?: string[];
  voice?: true;
};

export const inboxDir = (spool: string) => join(spool, "inbox");
export const outboxDir = (spool: string) => join(spool, "outbox", "dashboard");

/** Create both halves of the spool, 0700, if they are missing. */
export function ensureSpool(spool: string): void {
  mkdirSync(inboxDir(spool), { recursive: true, mode: 0o700 });
  mkdirSync(outboxDir(spool), { recursive: true, mode: 0o700 });
}

/** Turn one parsed inbox file into a message, or null when it is not one. */
export function parseInboxMessage(raw: unknown, fallbackId: string, now = Date.now()): SpoolMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  const route = msg.route as Record<string, unknown> | undefined;
  if (!route || typeof route !== "object" || route.source !== "dashboard") return null;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  const upload = typeof msg.image_path === "string" && msg.image_path.startsWith("/") ? msg.image_path : "";
  if (!text && !upload) return null;
  const chatId = typeof route.chat_id === "string" && route.chat_id ? route.chat_id : DEFAULT_CHAT_ID;
  const at = typeof msg.received_at === "string" ? Date.parse(msg.received_at) : NaN;
  return {
    id: typeof msg.id === "string" && msg.id ? msg.id : fallbackId,
    text,
    route: { source: "dashboard", chat_id: chatId, ...(route.voice === true ? { voice: true } : {}) },
    ...(upload ? { imagePath: upload } : {}),
    receivedAt: Number.isFinite(at) ? at : now,
  };
}

/**
 * Read and remove every complete message waiting in the inbox, oldest first
 * (the bridge names files by time, so name order is arrival order).
 *
 * A file is removed before its message is handed on, so a gateway restart
 * never answers the same message twice. A file that is not a valid message is
 * removed too and reported through `onDrop`; leaving it would make every poll
 * trip on it. Temp files (`.name.tmp`) are never touched.
 */
export function takeInbox(spool: string, onDrop?: (name: string, why: string) => void): SpoolMessage[] {
  const dir = inboxDir(spool);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SpoolMessage[] = [];
  for (const name of names) {
    const full = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
      unlinkSync(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // another reader took it
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      onDrop?.(name, "unreadable");
      continue;
    }
    const msg = parseInboxMessage(parsed, basename(name, ".json"));
    if (!msg) {
      onDrop?.(name, "incomplete");
      continue;
    }
    out.push(msg);
  }
  return out;
}

export function newReplyId(now = Date.now()): string {
  return `${now}-${randomBytes(4).toString("hex")}`;
}

/** Leave one reply for the bridge to send. Returns the reply's id. */
export function writeOutbox(
  spool: string,
  reply: { chatId?: string; text: string; files?: readonly string[]; voice?: boolean },
): string {
  const dir = outboxDir(spool);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = newReplyId();
  const body: OutboxReply = {
    source: "dashboard",
    chat_id: reply.chatId || DEFAULT_CHAT_ID,
    text: reply.text.slice(0, MAX_MESSAGE_LENGTH),
  };
  if (reply.files?.length) body.files = [...reply.files];
  if (reply.voice) body.voice = true;
  const tmp = join(dir, `.${id}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(body) + "\n");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, `${id}.json`));
  return id;
}

const AUDIO_EXT = /\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)$/i;

/**
 * The text the agent sees for one chat message. An upload is already a file
 * on this box, so the agent is given its path (the same wording as the
 * OpenClaw stopgap, openclawdispatch.ts).
 */
export function bodyFor(msg: SpoolMessage): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  if (msg.imagePath) {
    parts.push(AUDIO_EXT.test(msg.imagePath) ? `[Voice note: ${msg.imagePath}]` : `[Attached file: ${msg.imagePath}]`);
  }
  return parts.join("\n");
}

/**
 * The spool directory: FIVEDIVE_SPOOL_DIR wins over the channel config's
 * `spoolDir`, as in the Hermes plugin. Empty when neither is set.
 */
export function resolveSpoolDir(configured: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.FIVEDIVE_SPOOL_DIR ?? "").trim();
  if (fromEnv) return fromEnv;
  return typeof configured === "string" ? configured.trim() : "";
}

/**
 * Who may talk in through the spool. Default: only the bridge's one sender.
 * FIVEDIVE_ALLOW_ALL_USERS opens it to any sender; FIVEDIVE_ALLOWED_USERS
 * (comma separated) replaces the configured list.
 */
export function resolveAllowFrom(configured: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  if (/^(1|true|yes)$/i.test((env.FIVEDIVE_ALLOW_ALL_USERS ?? "").trim())) return ["*"];
  const fromEnv = (env.FIVEDIVE_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  if (Array.isArray(configured)) {
    const list = configured.map((v) => String(v).trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [SENDER_ID];
}

/** Voice-in, voice-out: the first reply after a voice note is marked so the bridge speaks it. */
export class VoiceLatch {
  private pending = new Set<string>();
  arm(chatId: string): void {
    this.pending.add(chatId);
  }
  take(chatId: string): boolean {
    return this.pending.delete(chatId);
  }
}

/** One latch per account, shared by inbound replies and outbound sends. */
const voiceLatches = new Map<string, VoiceLatch>();

export function voiceLatchFor(accountId: string): VoiceLatch {
  let latch = voiceLatches.get(accountId);
  if (!latch) voiceLatches.set(accountId, (latch = new VoiceLatch()));
  return latch;
}

/** Local files the agent attached, as absolute paths the bridge can upload. */
export function localFiles(urls: ReadonlyArray<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    const path = raw.startsWith("file://") ? decodeURIComponent(raw.slice("file://".length)) : raw;
    if (path.startsWith("/") && !out.includes(path)) out.push(path);
  }
  return out;
}

export const readerFile = (spool: string) => join(spool, "reader.json");

/**
 * Mark this process as the spool's reader (DIVE-8177). The box bridge's own
 * OpenClaw reader stands down while this pid is alive, so a message is never
 * answered twice. A dead or reused pid does not count, so a crash cannot
 * silence the chat: the bridge just takes it back.
 */
export function claimReader(spool: string, pid = process.pid): void {
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  const tmp = join(spool, `.reader.${pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ pid, by: "openclaw" }) + "\n", { mode: 0o600 });
  renameSync(tmp, readerFile(spool));
}

/** Drop the mark, only if it is still ours. */
export function releaseReader(spool: string, pid = process.pid): void {
  try {
    const cur = JSON.parse(readFileSync(readerFile(spool), "utf8")) as { pid?: unknown };
    if (cur.pid === pid) unlinkSync(readerFile(spool));
  } catch {}
}
