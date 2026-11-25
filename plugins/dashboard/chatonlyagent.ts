// DIVE-9253: a chat-only agent (`5dive agent create --chat-only`). Someone
// outside the team types into it through the web chat while it holds the box's
// Claude sign-in. The agent runs with no built-in tools, but the reply tool's
// `files` array copies ANY absolute path into the outbox and serves it, so a
// prompt-injected agent could still send its own sign-in file. For a chat-only
// agent this plugin offers and honours text only: no files, no voice. Enforced
// here, never by prompt.
//
// Two sources turn it on and neither can turn it off: the launcher's env
// (DASHBOARD_CHAT_ONLY_AGENT=1) and a root-owned marker named after the agent in
// /etc/5dive/chat-only-agents/. Losing one still leaves the lock on. Not to be
// confused with a chat-only BOX (chatonly.ts, the /etc/5dive/chat-only file).

import { join } from 'path'

export const CHAT_ONLY_AGENT_DIR_DEFAULT = '/etc/5dive/chat-only-agents'

/** True when this agent is chat-only: env says so, or the agent's marker exists. */
export function chatOnlyAgentMode(
  env: Record<string, string | undefined>,
  agent: string,
  exists: (path: string) => boolean,
): boolean {
  if (env.DASHBOARD_CHAT_ONLY_AGENT === '1') return true
  if (!agent) return false
  const dir = env.DASHBOARD_CHAT_ONLY_AGENT_DIR || CHAT_ONLY_AGENT_DIR_DEFAULT
  return exists(join(dir, agent))
}

/** The chat-only agent's reply tool: chat_id and text, nothing that names a file. */
export function chatOnlyAgentReplyTool() {
  return {
    name: 'reply',
    description:
      'Reply in the chat. Pass chat_id from the inbound message. Text only: this chat sends no files and no voice. ' +
      'Text over 70 words (outside fenced code) is refused and nothing is sent: keep it to 60.',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'string' }, text: { type: 'string' } },
      required: ['chat_id'],
    },
  }
}

/** The reply arguments a chat-only agent may send. `files`, `voice` and anything else are dropped. */
export function chatOnlyAgentArgs<T extends { chat_id?: unknown; text?: unknown }>(args: T): { chat_id?: unknown; text?: unknown } {
  return { chat_id: args.chat_id, text: args.text }
}

export const CHAT_ONLY_AGENT_INSTRUCTIONS = [
  'A visitor reads this chat on the web, not this session. Anything you want them to see must go through the reply tool, with the chat_id the inbound message names.',
  '',
  'The reply tool sends text only. It cannot attach files or speak.',
].join('\n')
