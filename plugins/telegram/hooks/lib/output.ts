// Hook output JSON shapes claude understands. Each function writes the
// shape to stdout — claude's hook runtime reads it back as the result.

export function emitBlock(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

export function emitDenyTool(toolName: string, reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  // toolName is unused in the JSON itself; kept in the API so callers
  // can self-document which tool the deny pertains to.
  void toolName
}

// DIVE-1027: allow the native tool to run (e.g. approve ExitPlanMode). Unlike
// deny, this lets the tool execute — used when a Telegram tap approves.
export function emitAllowTool(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: reason,
      },
    }),
  )
}

export function emitPostToolContext(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reason,
      },
    }),
  )
}
