// DIVE-9253: the onboarder seat. An outsider (a prospect firm's visitor) types
// into this agent while it holds the box's Claude sign-in. The seat runs with no
// built-in tools, but the reply tool's `files` array copies ANY absolute path
// into the outbox and serves it, so a prompt-injected onboarder could still send
// its own sign-in file. In onboarder mode this plugin offers and honours text
// only: no files, no voice. Enforced here, never by prompt.
//
// Two sources turn it on and neither can turn it off: the launcher's env
// (DASHBOARD_ONBOARDER=1) and a root-owned marker named after the agent, which
// `5dive onboarder create` writes. Losing one still leaves the lock on.

import { join } from 'path'

export const ONBOARDER_MARKER_DIR_DEFAULT = '/etc/5dive/onboarders'

/** True when this seat is an onboarder: env says so, or the agent's marker exists. */
export function onboarderMode(
  env: Record<string, string | undefined>,
  agent: string,
  exists: (path: string) => boolean,
): boolean {
  if (env.DASHBOARD_ONBOARDER === '1') return true
  if (!agent) return false
  const dir = env.DASHBOARD_ONBOARDER_DIR || ONBOARDER_MARKER_DIR_DEFAULT
  return exists(join(dir, agent))
}

/** The onboarder's reply tool: chat_id and text, nothing that names a file. */
export function onboarderReplyTool() {
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

/** The reply arguments an onboarder may send. `files`, `voice` and anything else are dropped. */
export function onboarderArgs<T extends { chat_id?: unknown; text?: unknown }>(args: T): { chat_id?: unknown; text?: unknown } {
  return { chat_id: args.chat_id, text: args.text }
}

export const ONBOARDER_INSTRUCTIONS = [
  'A visitor reads this chat on the web, not this session. Anything you want them to see must go through the reply tool, with the chat_id the inbound message names.',
  '',
  'The reply tool sends text only. It cannot attach files or speak.',
].join('\n')
