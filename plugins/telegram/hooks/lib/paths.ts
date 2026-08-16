import { homedir } from 'os'
import { join } from 'path'

// Mirror the path resolution in ../server.ts so the hooks read/write the
// same files the MCP server does. TELEGRAM_STATE_DIR override exists for
// tests that pre-seed access.json + silence.json under a tmp dir.
//
// DIVE-3452: these are FUNCTIONS, not consts, and that is load-bearing. As
// consts they resolved once at MODULE LOAD, so in the shared-process test
// runner the first file to import this module — directly or transitively —
// froze STATE_DIR for every later file. Which file that was is decided by the
// order the runner walks test/, which differs between a dev box and CI: the
// same bytes were 833/0 locally and 831/2 in CI (run 31930246792), and the
// red landed on test/resume-prompt.test.ts, which had not changed. Resolving
// per call means no importer can freeze it for another, so no test needs to
// know what any other test imports.
export function stateDir(): string {
  return process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
}
export function accessFile(): string {
  return join(stateDir(), 'access.json')
}
export function silenceFile(): string {
  return join(stateDir(), 'silence.json')
}
// Opt-in flag for the context carry-over nudge (DIVE-114). Absent or
// `enabled:false` → the context-nudge Stop hook stays silent: the nudge is OFF
// by default and the user turns it on per-agent with `/context on` (toggle is
// folded into /context). Shared with server.ts (same path resolution).
export function nudgeFile(): string {
  return join(stateDir(), 'context-nudge.json')
}
// Touched (mtime bumped) by the Stop hook to tell the long-running MCP
// server's typing loop that the turn ended — the server can't otherwise
// learn this when the hook auto-relays out-of-process. See server.ts
// startTypingLoop and DIVE-146.
export function typingStopFile(): string {
  return join(stateDir(), 'typing-stop')
}

// DIVE-1027: filesystem handshake dir for bridging the native picker tools
// (AskUserQuestion / ExitPlanMode) to a Telegram inline keyboard. The
// PreToolUse hook drops `<reqid>.req.json` (the option labels) here and posts
// the keyboard; the MCP server's callback_query router resolves a tap into
// `<reqid>.ans.json`; the hook polls for that answer file. Only the server
// consumes getUpdates (DIVE-818 lock), so the tap can only be seen there —
// hence the two-process file relay rather than the hook awaiting the tap
// itself.
export function questionDir(): string {
  return join(stateDir(), 'questions')
}

// Prefix of the MCP tools the plugin exposes. Used by stop-reply-check
// (and the silence watchdog indirectly) to recognize "agent talked to
// the proper channel" vs "agent talked to the transcript" turns.
// Not env-derived, so a const is safe here.
export const TG_TOOL_PREFIX = 'mcp__plugin_telegram_telegram__'
