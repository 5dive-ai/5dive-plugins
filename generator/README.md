# telegram-runtime generator (DIVE-9)

The `telegram-{codex,grok,agy}` plugins are near-identical Telegram bridges for
AI CLIs that lack Claude Code's channel-push. They differ only by a handful of
runtime knobs plus a few genuinely runtime-specific code regions. Hand-forking
them is how silent drift crept in (DIVE-8, DIVE-13). This generator makes a new
runtime **a config block, not a manual fork**.

`telegram-grok` is the canonical **base** — the cleanest poll-based fork
(systemd-managed, `hooks/hooks.json`, manifest present). Every other runtime is
described as a transform of it.

## Files

| path | role |
|------|------|
| `generate.ts` | the engine — renders a runtime from `runtimes/<slug>.json` |
| `derive-blocks.ts` | authoring aid — line-diffs a hand-fork against token-only output to extract its structural delta as a block |
| `runtimes/<slug>.json` | one runtime = a config block (token knobs + which structural blocks to apply) |
| `blocks/<name>.json` | a named set of post-tokenization find/replace edits for a genuinely-divergent code region |

## Usage

```sh
# materialize a runtime under plugins/telegram-<slug>/
bun generate.ts <slug>

# regenerate every runtime to a temp dir and diff vs the committed fork
bun generate.ts --check
```

`--check` is the anti-drift gate, wired into `.github/workflows/parity.yml`. It
must stay green: a committed fork edited without updating its config (or the
base) trips it. It is the structural successor to the hand-kept assertions in
`test/parity.test.ts`.

## How a runtime is rendered

1. **Token subs.** From the config's `tokens`, the engine builds an ordered list
   of `grok-string → target-string` substitutions (display name, vendor, CLI
   binary, state-dir home expr, env-knob prefix, plugin-root var, MCP-timeout key,
   package scope) plus a word-boundary sweep for the bare lowercase CLI binary.
   Because the base's own values map to themselves, **generating grok is a
   byte-exact identity** — the engine's built-in correctness self-check.
2. **Structural blocks.** Genuinely-divergent regions (e.g. agy's picker-managed
   model vs grok's `config.toml` model, agy's protobuf turn-mtime liveness vs
   grok's session-jsonl) are applied as post-tokenization find/replace edits.
3. **Manifest.** Emitted in the runtime's layout: `claude-plugin` (`.claude-plugin/plugin.json`
   + `.mcp.json`), `root` (`plugin.json` + `mcp_config.json`), or `none` (codex —
   MCP wired into the runtime's own config by 5dive provisioning). The version is
   sourced from the single `version` knob and written to **both** package.json and
   the manifest, so they can't drift (the bug this replaced: grok's manifest sat
   at 0.1.15 while package.json had moved to 0.1.23).

A `lintNoStrays` pass fails the build if any base token (`Grok`, `GROK_`,
`.grok`, `telegram-grok`, `interruptGrok`) leaks into a non-grok fork.

`README.md` and `TODO.md` are per-runtime authored prose: the generator emits a
token-subbed **starting scaffold** for a brand-new runtime but never overwrites
an existing one, and `--check` does not assert them.

## Adding runtime #5

For a runtime that follows the grok pattern (poll-based `wait_for_message` loop,
systemd-managed), it's just a config:

```jsonc
// runtimes/<slug>.json
{
  "tokens": {
    "slug": "<slug>", "displayName": "...", "vendor": "...", "cliBin": "...",
    "homeExpr": "process.env.<X>_HOME ?? join(homedir(), '.<x>')",
    "homeEnvVar": "<X>_HOME", "homeDir": "<x>", "envPrefix": "<X>",
    "pluginRootVar": "<X>_PLUGIN_ROOT", "timeoutKey": "tool_timeout_sec",
    "pkgScope": "@5dive/telegram-<slug>-mcp"
  },
  "version": "0.1.0",
  "manifest": "claude-plugin",
  "blocks": []
}
```

Then `bun generate.ts <slug>`. See `runtimes/qwen.json` for a worked example
(no committed fork — `--check` reports it as a clean, pending runtime).

If the runtime diverges structurally (different model config, different
turn-mtime source), hand-fork the divergent regions once, then run
`bun derive-blocks.ts <slug>` to extract those regions as a block, drop the
output in `blocks/<name>.json`, and reference it from the config's `blocks`.

## Scope note

`telegram-codex` is intentionally **not** generator-managed yet: it predates this
work and carries bespoke divergence (a Telegram↔hook permissions bridge, TOML hook
wiring, `manifest: none`) that the grok/agy pattern doesn't share. The parity
suite still pins it in lockstep. New runtimes follow the grok/agy pattern; codex
can be migrated later by deriving its blocks the same way agy's were.
