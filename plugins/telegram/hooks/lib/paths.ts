import { homedir } from 'os'
import { join } from 'path'

// Mirror the path resolution in ../server.ts so the hooks read/write the
// same files the MCP server does. TELEGRAM_STATE_DIR override exists for
// tests that pre-seed access.json + silence.json under a tmp dir.
export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const SILENCE_FILE = join(STATE_DIR, 'silence.json')
// Opt-in flag for the context carry-over nudge (DIVE-114). Absent or
// `enabled:false` → the context-nudge Stop hook stays silent: the nudge is OFF
// by default and the user turns it on per-agent with `/context on` (toggle is
// folded into /context). Shared with server.ts (same path resolution).
export const NUDGE_FILE = join(STATE_DIR, 'context-nudge.json')
// Touched (mtime bumped) by the Stop hook to tell the long-running MCP
// server's typing loop that the turn ended — the server can't otherwise
// learn this when the hook auto-relays out-of-process. See server.ts
// startTypingLoop and DIVE-146.
export const TYPING_STOP_FILE = join(STATE_DIR, 'typing-stop')

// Prefix of the MCP tools the plugin exposes. Used by stop-reply-check
// (and the silence watchdog indirectly) to recognize "agent talked to
// the proper channel" vs "agent talked to the transcript" turns.
export const TG_TOOL_PREFIX = 'mcp__plugin_telegram_telegram__'
