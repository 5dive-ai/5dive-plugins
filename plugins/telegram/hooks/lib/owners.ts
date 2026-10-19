// DIVE-6518: who an owner-only notice goes to. The seat's owners (access.owners,
// the first id paired, DIVE-5867) within allowFrom, private chats only; all of
// allowFrom only when the pairing predates the owners record. A guest in
// allowFrom may talk to the agent; a usage limit or a Connect link is not theirs.
// One copy, no imports: the server (firstreply.ts) and the hooks both read it.
export function ownerChatIds(access: { owners?: string[]; allowFrom?: string[] }): string[] {
  const allow = access.allowFrom ?? []
  return (access.owners ?? allow).filter(id => allow.includes(id) && /^[1-9]\d*$/.test(id))
}
