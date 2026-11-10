// @5dive/pi-chat: talk to this Pi session from the 5dive web and mobile chat.
//
// While Pi runs with a UI (the terminal, or `--mode rpc`), this reads the 5dive
// spool's inbox once a second. A chat message waits until Pi is idle, then goes
// in as a user message in THIS session, so the chat and the terminal share one
// conversation. When the run settles, the last text Pi wrote goes back to the
// chat. Print mode (`pi -p`) and JSON mode never read: those are one-shot turns,
// and on a 5dive box the bridge itself runs them.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  claimReader, ensureSpool, failedText, noAnswerText, promptFor, releaseReader, spoolDir, takeInbox, writeReply,
  type ChatMessage, type Route,
} from "../src/spool.ts";

type Block = { type?: string; text?: string };
type Msg = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };

/** The text blocks of an assistant message, joined; empty for a tool-call-only message. */
export function assistantText(m: Msg): string {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
  return (m.content as Block[]).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text!.trim()).filter(Boolean).join("\n\n");
}

export default function fivediveChat(pi: ExtensionAPI) {
  const spool = spoolDir("pi");
  const queue: ChatMessage[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: Route | null = null; // the chat waiting on the run in progress
  let lastText = "";
  let lastError = "";
  let busy = false;

  const send = () => {
    if (current || busy || !queue.length) return;
    const msg = queue.shift()!;
    current = msg.route;
    lastText = "";
    lastError = "";
    try {
      pi.sendUserMessage(promptFor(msg));
    } catch {
      // A run started between the check and the send: queue it behind that run.
      pi.sendUserMessage(promptFor(msg), { deliverAs: "followUp" });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return; // `pi -p` / `--mode json`: a one-shot turn never reads the chat
    ensureSpool(spool);
    claimReader(spool, "pi");
    clearInterval(timer);
    timer = setInterval(() => {
      for (const m of takeInbox(spool)) queue.push(m);
      send();
    }, 1000);
    timer.unref?.();
  });

  pi.on("agent_start", async () => { busy = true; });

  pi.on("message_end", async (event) => {
    if (!current) return;
    const m = (event as { message?: Msg }).message ?? {};
    const text = assistantText(m);
    if (text) lastText = text;
    if (m.role === "assistant" && m.stopReason === "error" && m.errorMessage) lastError = m.errorMessage;
  });

  pi.on("agent_settled", async () => {
    busy = false;
    if (current) {
      const route = current;
      current = null;
      const text = lastText || (lastError ? failedText("pi", lastError.split("\n")[0].slice(0, 160)) : noAnswerText("pi"));
      try { writeReply(spool, route, text, "pi"); } catch {}
    }
    send();
  });

  pi.on("session_shutdown", async () => {
    clearInterval(timer);
    timer = undefined;
    releaseReader(spool);
  });
}
