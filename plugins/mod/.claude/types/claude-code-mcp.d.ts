// The inputs of the MCP tools this session had, from each server's tools/list
// inputSchema; written by `/plugin-types` (src/plugins/functionHooks/mcp-tool-types/mcp-tool-declarations.ts).
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Regenerate rather than edit.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Create a doc, or apply several operations to one doc atomically. */
    mcp__claude_ai_Claude_Docs__batch: {
      batch?: unknown[]
      container?: {
        create?: {}
        id?: string
        kind: string
      }
      opId?: string
      verbose?: boolean
    }
    /** Create one object in a doc: a tab, its contents, a comment, an upload record. */
    mcp__claude_ai_Claude_Docs__create: {
      artifact?: string
      container?: {
        id: string
        kind: string
        version?: string
      }
      engine?: string
      object: "file" | "node" | "utterance" | "enum" | "blob"
      opId?: string
      payload: {} | string
      verbose?: boolean
    }
    /** Delete one object from a doc: a tab, its contents, a comment, an upload record. A doc keeps at least one tab (deleting its last refuses `last_tab`): to start over, rewrite that tab's contents with `update`, never delete and recreate the tab. */
    mcp__claude_ai_Claude_Docs__delete: {
      container?: {
        id: string
        kind: string
        version?: string
      }
      engine?: string
      opId?: string
      payload?: {} | string
      ref: {
        id: string
        object: "project" | "file" | "node" | "utterance"
      }
      verbose?: boolean
    }
    /** Export one tab inline as base64: pdf, docx, html, text, markdown or notion (Notion-flavored markdown, what notion-create-pages takes). To just keep the file in the doc's files, create a blob {from: {object: "file", id}, format} instead (no large result). */
    mcp__claude_ai_Claude_Docs__export: {
      container: {
        id: string
        kind: string
        version?: string
      }
      file: string
      format: "markdown" | "text" | "html" | "docx" | "pdf" | "notion"
      maxBytes?: number
      paper?: "letter" | "a4"
    }
    /** Docs guides: topic.instructions = how to create and edit docs. Also topic.<name>, refusal.<code>. No docs skill or instructions loaded → ["topic.instructions"] first; after a doc's birth → ["topic.index"]. */
    mcp__claude_ai_Claude_Docs__guide: {
      /** topic.<name> (instructions, index, editing, tabs, comments, charts, chart-definition, uploads, skill) or refusal.<code>; several per call is fine. */
      items?: unknown[]
    }
    /** List a tab's or a doc's comment history (threads, replies, resolves). */
    mcp__claude_ai_Claude_Docs__query: {
      container?: {
        id: string
        kind: string
        version?: string
      }
      object?: "utterance"
      payload?: {} | string
    }
    /** Read a doc (lists its tabs), a tab's contents, or a comment. A claude.ai/[code/]artifact/[<title>-]<id> link → `ref {"object":"project","id":"<id>"}` first; reads inside it take `container {"kind":"project","id":"<id>"}`. */
    mcp__claude_ai_Claude_Docs__read: {
      container?: {
        id: string
        kind: string
        version?: string
      }
      engine?: string
      payload?: {} | string
      ref: {
        id: string
        object: "project" | "file" | "node" | "utterance" | "enum" | "blob"
      }
    }
    /** Edit a tab's contents, rename a doc or tab, or change a stored value. */
    mcp__claude_ai_Claude_Docs__update: {
      answering?: string
      container?: {
        id: string
        kind: string
        version?: string
      }
      engine?: string
      opId?: string
      payload: {} | string
      ref: {
        id: string
        object: "project" | "file" | "node" | "utterance" | "enum"
      }
      verbose?: boolean
    }
    /** Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB. */
    mcp__plugin_telegram_telegram__download_attachment: {
      /** The attachment_file_id from inbound meta */
      file_id: string
    }
    /** Edit a message the bot previously sent. Useful for interim progress updates. The server automatically prepends the original message text as a sticky header, so pass ONLY the new status — do not re-include the original ack. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings. */
    mcp__plugin_telegram_telegram__edit_message: {
      chat_id: string
      message_id: string
      text: string
      /** Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed). */
      format?: "text" | "markdownv2"
    }
    /** Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected. */
    mcp__plugin_telegram_telegram__react: {
      chat_id: string
      message_id: string
      emoji: string
    }
    /** Recover recent Telegram context after a restart. Telegram's Bot API exposes no history, but this plugin persists a bounded rolling log of inbound messages and your replies per chat. Returns the most recent messages as a compact transcript. Pass chat_id to target a specific chat, or omit it to use the most recently active chat. Use this instead of asking the human to re-paste earlier context. */
    mcp__plugin_telegram_telegram__recent_messages: {
      /** Chat to fetch. Omit to use the most recently active chat. */
      chat_id?: string
      /** How many recent messages to return (default 20, max 200). */
      limit?: number
    }
    /** Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading under a specific message, message_thread_id for posting into a forum topic, and files (absolute paths) to attach images or documents. */
    mcp__plugin_telegram_telegram__reply: {
      chat_id: string
      text: string
      /** Message ID to thread under. Use message_id from the inbound <channel> block. */
      reply_to?: string
      /** Forum topic id. Pass through verbatim from the inbound <channel> block when present, so the reply lands in the same topic instead of the supergroup's General channel. Omit if the inbound had none. */
      message_thread_id?: string
      /** Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each. */
      files?: string[]
      /** Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed). */
      format?: "text" | "markdownv2"
    }
  }
}
