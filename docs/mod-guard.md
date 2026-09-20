# The tool-call guard: rules that cost nothing per turn

*DIVE-4696. Capability 2 of `mod@5dive-plugins`. Written against Claude Code 2.1.278.*

## What problem this is the shape of

Every rule in the fleet's `CLAUDE.md` files is re-sent on every turn of every seat — that file's
own header puts it at ~1100 loads a day — and none of them is enforced by being read. The rules
that matter are caught *afterwards*: by sudoers scoping, by the pre-push PII guard, by a reviewer,
or by an audit row somebody reads later. So a rule is paid for continuously and collected
occasionally.

A `tool.call` hook inverts both halves. The policy costs zero tokens per turn, it fires **before**
the tool runs, and the reason goes to the model, which is the only reader who can still act on it.

The bargain this plugin makes is therefore not "add a guard". It is: **a policy lands here and its
prose leaves `CLAUDE.md` in the same change.** A policy that ships without that has added a rail
and moved nothing.

## Where the rules live

`plugins/mod/policy/guard.json` — data, not code. Nothing in `hooks/guard.ts` names a policy, a
path, a tool or a rule; the evaluator only knows the schema. Ops adds or retires a policy by
editing the document, with no plugin release and no TypeScript:

```bash
jq -r '.policies[] | "\(.id)\t\(.rule)"' plugins/mod/policy/guard.json
```

## A policy

```json
{
  "id": "no-verify",
  "rule": "The pre-push PII guard catches these; do not --no-verify past it (5dive/CLAUDE.md)",
  "tools": ["Bash"],
  "text_keys": ["command"],
  "unless_env": "FIVEDIVE_MOD_GUARD_ALLOW_NO_VERIFY",
  "checks": [{ "id": "git-no-verify", "find": "…", "say": "a git commit or push with --no-verify" }],
  "deny": "{found} skips … [{rule}]"
}
```

| field | meaning |
| --- | --- |
| `id` | how the deny is attributed, in the sink line and in a bug report. |
| `rule` | **the written rule this policy replaces.** A policy without one is dropped at load: a deny that states no rule is a preference with a veto. |
| `tools` | the tool names it applies to. A tool not listed is never inspected. |
| `path_keys` / `text_keys` | which keys of the tool's input hold the path and the text. This is what keeps the evaluator tool-agnostic. |
| `path_any` | optional. The policy applies only when the path matches one of these — how `pii-fixture` distinguishes a fixture from product code that legitimately holds a real address. |
| `unless_env` | optional. A seat setting that switches the policy off, so an escape hatch is a recorded setting and not a flag on one command line. `0`, `false` and empty do **not** open it. |
| `checks[].find` / `flags` / `group` | the trigger, and which capture group holds the value being judged. |
| `checks[].allow_any` | values that are permitted. With `group`, this is what makes `1234567890` and `@example.com` pass and everything else fail. |
| `checks[].require_all` | context the subject must also contain. This is what keeps *quoting* `smoke-verified` in a sentence from reading as *applying* the label. |
| `deny` | the reason handed to the model. `{found}`, `{path}` and `{rule}` are substituted. |

The first policy in **file order** that matches answers, and evaluation stops: the model gets one
reason, not a report.

## The policies that shipped with it

| id | refuses | escape |
| --- | --- | --- |
| `pii-fixture` | a real Telegram id, email or routable IP written into a test or fixture path | change the value |
| `no-verify` | `git commit`/`git push --no-verify` | `FIVEDIVE_MOD_GUARD_ALLOW_NO_VERIFY` |
| `smoke-attestation` | applying the `smoke-verified` label | `FIVEDIVE_MOD_GUARD_SMOKE_RECEIPT=<sha>` |
| `runtime-store` | a direct write into `/var/lib/5dive`, `/var/log/5dive`, `/etc/5dive` or `tasks.db` | — |
| `destructive-outside-workdir` | `rm -r` of a host path or a seat's dotfiles; `git clean -f` | `FIVEDIVE_MOD_GUARD_ALLOW_DESTRUCTIVE` |
| `external-reply` | `gh pr/issue comment|review|create --repo <owner we do not own>` | `FIVEDIVE_MOD_GUARD_EXTERNAL_REPLY_APPROVED` |

## Turning it on

Two gates, both required:

- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the seat's environment, or the module never loads;
- `"env": { "FIVEDIVE_MOD_GUARD": "1" }` in the seat's `settings.json`.

Off is the default on every seat, and off means the `tool.call` hook is byte-for-byte the
observe-only telemetry hook DIVE-4692 shipped. `FIVEDIVE_MOD_GUARD_POLICY` points at a different
document; absent, it is the plugin's own `policy/guard.json`.

Seat it the way `sec-default` is seated — first in the seat's plugin list, which `prependPlugins`
orders — so the deny is reached before a later plugin can rewrite the call out from under it.

## Two properties worth arguing about

**It fails OPEN.** A document that will not parse, a regex that will not compile, a tool input that
is not the shape a policy expects: the call proceeds. This surface is early access and a guard that
failed closed would take a seat out on a Claude Code upgrade. The cost of that choice is that "the
guard is off" and "the guard allowed it" are one observable — so every failure is said out loud,
once per session, in the debug log, and a partial load names the policies that were dropped and
states that those rules are not enforced.

**It never rewrites a call.** A call is refused whole or it runs untouched. There is no third
answer in v1, and adding one would mean a plugin could change what a seat did without the seat's
transcript showing it.

## Adding a policy

1. Write it in `policy/guard.json`, with the `rule` it replaces.
2. Add **two** arms to `test/mod-guard.test.ts`: the bad input is refused, **and** the nearest good
   input is not. A guard sits on the path of every tool call on the seat, so a policy that also
   refuses good work is not a stricter guard — it is an outage with a reason attached.
3. Delete or shorten the prose in `CLAUDE.md`, and put the byte count on the row.
4. Check the sink afterwards. A `decision: "deny"` line carries `policy` and `check`, so "this
   policy fires 40× a day on good work" is a measurement rather than an argument — see
   `docs/mod-telemetry-contract.md`.
