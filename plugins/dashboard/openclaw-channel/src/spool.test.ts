// The spool contract, driven directly: `bun test src/spool.test.ts`.
// No OpenClaw install needed: spool.ts and poll.ts import only node built-ins.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollSpool } from "./poll.js";
import {
  bodyFor,
  ensureSpool,
  inboxDir,
  localFiles,
  outboxDir,
  parseInboxMessage,
  resolveAllowFrom,
  resolveSpoolDir,
  SENDER_ID,
  takeInbox,
  VoiceLatch,
  writeOutbox,
  type SpoolMessage,
} from "./spool.js";

const dirs: string[] = [];
function spool(): string {
  const d = mkdtempSync(join(tmpdir(), "fivedive-spool-"));
  dirs.push(d);
  ensureSpool(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function drop(dir: string, name: string, body: unknown) {
  writeFileSync(join(inboxDir(dir), name), typeof body === "string" ? body : JSON.stringify(body));
}
const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  id: text,
  text,
  route: { source: "dashboard", chat_id: "dashboard" },
  received_at: "2026-10-30T23:00:00Z",
  ...extra,
});

describe("inbox", () => {
  test("takes every message oldest first and removes the files", () => {
    const d = spool();
    drop(d, "1700000000002-b.json", msg("second"));
    drop(d, "1700000000001-a.json", msg("first"));
    const got = takeInbox(d);
    expect(got.map((m) => m.text)).toEqual(["first", "second"]);
    expect(readdirSync(inboxDir(d))).toEqual([]);
    expect(takeInbox(d)).toEqual([]);
  });

  test("never touches a half-written temp file", () => {
    const d = spool();
    drop(d, ".1700000000001-a.tmp", "{\"id\":");
    drop(d, ".1700000000001-a.json", msg("hidden"));
    expect(takeInbox(d)).toEqual([]);
    expect(readdirSync(inboxDir(d)).sort()).toEqual([".1700000000001-a.json", ".1700000000001-a.tmp"]);
  });

  test("drops unreadable and incomplete files, and says so", () => {
    const d = spool();
    drop(d, "1-bad.json", "not json");
    drop(d, "2-noroute.json", { text: "hi" });
    drop(d, "3-wrongsource.json", msg("hi", { route: { source: "telegram" } }));
    drop(d, "4-empty.json", msg("   "));
    drop(d, "5-good.json", msg("hello"));
    const dropped: string[] = [];
    const got = takeInbox(d, (name, why) => dropped.push(`${name}:${why}`));
    expect(got.map((m) => m.text)).toEqual(["hello"]);
    expect(dropped).toEqual(["1-bad.json:unreadable", "2-noroute.json:incomplete", "3-wrongsource.json:incomplete", "4-empty.json:incomplete"]);
    expect(readdirSync(inboxDir(d))).toEqual([]);
  });

  test("a missing inbox is an empty inbox", () => {
    expect(takeInbox(join(tmpdir(), "fivedive-does-not-exist-" + process.pid))).toEqual([]);
  });

  test("parses route, voice, upload and time", () => {
    const m = parseInboxMessage(
      { id: "m1", text: " hi ", route: { source: "dashboard", chat_id: "c2", voice: true }, image_path: "/tmp/a.png", received_at: "2026-10-30T23:00:00Z" },
      "fallback",
    );
    expect(m).toEqual({
      id: "m1",
      text: "hi",
      route: { source: "dashboard", chat_id: "c2", voice: true },
      imagePath: "/tmp/a.png",
      receivedAt: Date.parse("2026-10-30T23:00:00Z"),
    });
  });

  test("an upload with no text is a message; a relative path is not an upload", () => {
    expect(parseInboxMessage({ route: { source: "dashboard" }, image_path: "/x/v.ogg" }, "f", 5)).toEqual({
      id: "f",
      text: "",
      route: { source: "dashboard", chat_id: "dashboard" },
      imagePath: "/x/v.ogg",
      receivedAt: 5,
    });
    expect(parseInboxMessage({ route: { source: "dashboard" }, image_path: "x/v.ogg" }, "f")).toBeNull();
  });
});

describe("outbox", () => {
  test("writes one complete reply, 0600, no temp left behind", () => {
    const d = spool();
    const id = writeOutbox(d, { chatId: "dashboard", text: "hello", files: ["/tmp/r.pdf"], voice: true });
    const names = readdirSync(outboxDir(d));
    expect(names).toEqual([`${id}.json`]);
    const full = join(outboxDir(d), names[0]!);
    expect(JSON.parse(readFileSync(full, "utf8"))).toEqual({
      source: "dashboard",
      chat_id: "dashboard",
      text: "hello",
      files: ["/tmp/r.pdf"],
      voice: true,
    });
    expect(statSync(full).mode & 0o777).toBe(0o600);
  });

  test("plain reply carries no files or voice keys; ids sort by time", () => {
    const d = spool();
    const a = writeOutbox(d, { text: "a" });
    const body = JSON.parse(readFileSync(join(outboxDir(d), `${a}.json`), "utf8"));
    expect(body).toEqual({ source: "dashboard", chat_id: "dashboard", text: "a" });
    expect(a).toMatch(/^\d{13}-[0-9a-f]{8}$/);
  });

  test("an over-long reply is cut at the chat's ceiling", () => {
    const d = spool();
    const id = writeOutbox(d, { text: "x".repeat(20000) });
    expect(JSON.parse(readFileSync(join(outboxDir(d), `${id}.json`), "utf8")).text.length).toBe(16000);
  });
});

describe("config and helpers", () => {
  test("FIVEDIVE_SPOOL_DIR wins over config", () => {
    expect(resolveSpoolDir("/cfg", { FIVEDIVE_SPOOL_DIR: "/env" })).toBe("/env");
    expect(resolveSpoolDir(" /cfg ", {})).toBe("/cfg");
    expect(resolveSpoolDir(undefined, {})).toBe("");
  });

  test("only the bridge's sender is allowed by default", () => {
    expect(resolveAllowFrom(undefined, {})).toEqual([SENDER_ID]);
    expect(resolveAllowFrom(["a", 2], {})).toEqual(["a", "2"]);
    expect(resolveAllowFrom(["a"], { FIVEDIVE_ALLOWED_USERS: "x, y" })).toEqual(["x", "y"]);
    expect(resolveAllowFrom(["a"], { FIVEDIVE_ALLOW_ALL_USERS: "true" })).toEqual(["*"]);
  });

  test("an upload reaches the agent as its path on this box", () => {
    const base = { id: "1", route: { source: "dashboard" as const, chat_id: "dashboard" }, receivedAt: 0 };
    expect(bodyFor({ ...base, text: "look", imagePath: "/u/a.png" })).toBe("look\n[Attached file: /u/a.png]");
    expect(bodyFor({ ...base, text: "", imagePath: "/u/n.ogg" })).toBe("[Voice note: /u/n.ogg]");
  });

  test("a voice note marks only the next reply in that chat", () => {
    const l = new VoiceLatch();
    l.arm("dashboard");
    expect(l.take("other")).toBe(false);
    expect(l.take("dashboard")).toBe(true);
    expect(l.take("dashboard")).toBe(false);
  });

  test("only absolute local files are passed to the bridge", () => {
    expect(localFiles(["/a.png", "file:///b%20c.pdf", "https://x/y.png", undefined, "/a.png"])).toEqual(["/a.png", "/b c.pdf"]);
  });
});

describe("poll loop", () => {
  test("hands each message on in order, survives a failing one, drains on stop", async () => {
    const d = spool();
    drop(d, "1-a.json", msg("a"));
    drop(d, "2-b.json", msg("boom"));
    drop(d, "3-c.json", msg("c"));
    const seen: string[] = [];
    const done: string[] = [];
    const errors: unknown[] = [];
    const ctl = new AbortController();
    const loop = pollSpool({
      spool: d,
      signal: ctl.signal,
      intervalMs: 20,
      onMessage: async (m: SpoolMessage) => {
        seen.push(m.text);
        if (m.text === "boom") throw new Error("boom");
        await new Promise((r) => setTimeout(r, 30));
        done.push(m.text);
      },
      onError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 50));
    drop(d, "4-d.json", msg("d"));
    await new Promise((r) => setTimeout(r, 60));
    ctl.abort();
    await loop;
    expect(seen).toEqual(["a", "boom", "c", "d"]);
    expect(done.sort()).toEqual(["a", "c", "d"]);
    expect(errors.length).toBe(1);
    expect(readdirSync(inboxDir(d))).toEqual([]);
  });
});
