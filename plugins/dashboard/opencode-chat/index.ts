// @5dive/opencode-chat: talk to OpenCode from the 5dive web and mobile chat.
//
// While OpenCode runs as the TUI or `opencode serve`, this reads the 5dive
// spool's inbox once a second and answers each message in one OpenCode session
// titled "5dive web chat" (open it in the TUI to see the chat there). Messages
// are answered one at a time, in order. The text OpenCode writes after its last
// tool call goes back to the chat. `opencode run` (a one-shot turn) never reads.
//
// OpenCode calls every function this module exports as a plugin, so the
// plugin is the ONLY export here; the helpers live in src/answer.ts.

import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claimReader, ensureSpool, failedText, noAnswerText, promptFor, releaseReader, spoolDir, takeInbox, writeReply,
  type ChatMessage,
} from "./src/spool.ts";
import { answerText, isOneShot, type Part } from "./src/answer.ts";

const SESSION_FILE = "opencode-session"; // the same file the 5dive bridge's own reader keeps
const ID = /^[A-Za-z0-9_-]{4,200}$/;

export const FivediveChat: Plugin = async ({ client }, options) => {
  if (isOneShot()) return {};
  const spool = typeof options?.spoolDir === "string" && options.spoolDir ? options.spoolDir : spoolDir("opencode");
  ensureSpool(spool);
  claimReader(spool, "opencode");
  const idFile = join(spool, SESSION_FILE);

  const sessionId = async (fresh: boolean): Promise<string> => {
    if (!fresh) {
      try { const s = readFileSync(idFile, "utf8").trim(); if (ID.test(s)) return s; } catch {}
    }
    const made = await client.session.create({ body: { title: "5dive web chat" } });
    const id = (made.data as { id?: string } | undefined)?.id ?? "";
    if (!ID.test(id)) throw new Error("could not start a chat session");
    writeFileSync(idFile, id + "\n", { mode: 0o600 });
    return id;
  };

  const answer = async (msg: ChatMessage) => {
    let reply = "";
    for (let fresh = false; ; fresh = true) {
      const id = await sessionId(fresh);
      const res = await client.session.prompt({ path: { id }, body: { parts: [{ type: "text", text: promptFor(msg) }] } });
      const status = (res.response as Response | undefined)?.status;
      if (!fresh && status === 404) { try { unlinkSync(idFile); } catch {} ; continue; } // the kept session is gone
      const data = res.data as { info?: { error?: { data?: { message?: string }; name?: string } }; parts?: Part[] } | undefined;
      const text = answerText(data?.parts ?? []);
      const err = data?.info?.error?.data?.message ?? data?.info?.error?.name ?? (res.error ? String((res.error as { data?: { message?: string } }).data?.message ?? "request failed") : "");
      reply = text || (err ? failedText("opencode", err.split("\n")[0].slice(0, 160)) : noAnswerText("opencode"));
      break;
    }
    writeReply(spool, msg.route, reply, "opencode");
  };

  let chain = Promise.resolve();
  const timer = setInterval(() => {
    for (const m of takeInbox(spool)) {
      chain = chain.then(() => answer(m)).catch(() => {
        try { writeReply(spool, m.route, failedText("opencode"), "opencode"); } catch {}
      });
    }
  }, 1000);
  timer.unref?.();
  const stop = () => { clearInterval(timer); releaseReader(spool); };
  process.once("exit", stop);
  return { dispose: async () => stop() };
};

