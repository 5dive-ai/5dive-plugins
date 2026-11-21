# security-check

The engine behind «Check my setup» (stage 1, DIVE-8897). `seccheck` is one static Go
binary that checks a **sealed, throwaway clone** of an owner's server from the outside
and writes a plain report: what is open, how serious it is, how to close it.

The 5dive control plane (lodar/5dive-api `src/lib/security-check/`) makes the clone, scrubs
its credentials, writes a `scope.json` and runs `seccheck` on the control plane itself (the
only address the clone's firewall admits) against the clone's IP, then reads the report files
back. Nothing is uploaded to or run on the owner's live box. The live box is never a target. Clean-room code: ARTEX was a design
reference only. Plan: `community/wiki/security-self-check-plugin-staged-plan.md`.

## The three hard requirements

| Requirement | Enforced by |
|---|---|
| **1. Clone only.** The live box is never scanned. | The control plane writes only the clone's IP into `scope.json`. In the engine, targets are IP literals from that file and nowhere else (no flag, env or positional argument adds one), and host names are **never resolved**, since public DNS points at the live box. `internal/scope` (`Validate`, `Guard`) refuses every dial that is not an in-scope IP literal, and the default dialer has DNS switched off. nmap runs with `-n`. |
| **2. Scope lock is the authorization.** | `internal/scope` (scope file + `Guard` on every connection), `internal/engine/gate.go` (every intent, from either planner, is checked for scope, approval mode and risk before it runs; denials are recorded), and `ScopeLock` in `internal/engine/planner.go` (standing instruction at the top of every LLM planner prompt). Workers run fixed probes and never call an LLM. |
| **3. No prod OAuth refresh from the clone.** | Stopping agent units and wiping tokens on the clone happen in the control plane before the clone boots. The engine's part: its LLM key comes only from the env var named in `SECCHECK_LLM_PROVIDERS` (`internal/llm`). It never reads credentials from the box. |

## Contract

```
seccheck run --scope <scope.json> --db <sqlite path> --out <dir>
             [--max-seconds 900] [--max-tokens 150000] [--approval auto-safe|deny-all]
seccheck version
```

Exit codes: `0` done · `1` other error · `2` scope refused (before any network I/O) ·
`3` stopped early by a budget or by `SIGUSR1` (the report is still written).

Stopping a check early (`kill -USR1 <pid>`): no new step starts, the running steps get 30 s
to finish and are then cancelled, and `report.json` says `stopped_reason: "stopped"` with
everything found so far. `SIGINT`/`SIGTERM` still abort (exit 1). Send `SIGUSR1` only to an
engine built with it: an older one dies on it (Go's default) and writes no report.

`scope.json` (written only by the control plane):

```json
{"run_id":"str","owner":{"server_id":123,"domain":"box.example.com"},
 "targets":[{"kind":"ip","value":"203.0.113.7"}],"host_names":["box.example.com"],"depth":"shallow"}
```

`host_names` are used only as the HTTP Host header and TLS SNI value when connecting to a target IP.
`depth` is `shallow` (the default: about 100 common ports) or `deep` (the owner's opt-in
deeper sweep: every TCP port, same probes and gate). Any other value is refused.

Outputs in `--out`:

- `report.json` has `run_id, started_at, finished_at, engine_version, scope, summary{critical,high,medium,low,info}, findings[{id,severity,title,what,why,fix,proof,asset,source,evidence[{proto,target,request,response}]}], budget{tokens_used,seconds,max_tokens,max_seconds}, approvals[{step,tool,target,decision,reason}], stopped_reason (done|budget_time|budget_tokens|stopped|error), changes{earlier_runs,since,new_assets[{kind,key,data}],new_findings}`. `changes` is absent on a server's first run; otherwise a finding no earlier run (check or retest) of the same `--db` reported carries `"new": true`, and `new_assets` lists what this run was the first to see. «New» means never seen before, not «absent last time», and there is no «gone» list: the LLM looks in different places each run, so not finding something does not prove it was removed. A finding `id` is stable for the same check on the same asset across runs. `evidence` is the recorded traffic behind the finding (at most 4 exchanges; HTTPS is recorded above TLS, so it reads as plain HTTP), with credential values in it replaced by `[hidden]`; every exchange of the run is in the sqlite `traffic` table.
- `report.md` is plain and short, most serious first, and opens with a line like `3 things to fix, 1 urgent`.
- `findings.csv` has one row per finding, with the same columns as `findings[]` (minus `source`; `evidence` as text: `>>` sent, `<<` received).

`--db` (sqlite) holds two graphs: `assets` is shared across runs (host, port, service, url
and cert, with `first_seen`/`last_seen` and the run that first saw it). Each run scans a new
clone at a new IP, so an asset is keyed with its IP replaced by `server` (`server:22/tcp`);
opening a database an older engine wrote re-keys its assets the same way. The per-run exploration graph is `runs`
plus `nodes` (goal, intent, fact, finding, with `parent_id`), along with `approvals` and
`findings`. The schema is created idempotently. A retried `run_id` replaces its earlier attempt.

### Engine

Each round, the planner proposes intents `{tool,target,args,why}`. The gate approves or
denies each one. A worker runs one approved intent and stops, and its facts feed the next
round. Wall-clock and token budgets are checked between steps.

- **Planner.** It always uses the deterministic shallow sequence: port scan, then banner,
  then SSH, HTTP, exposure and TLS probes, plus nmap when it is on PATH. When
  `SECCHECK_LLM_PROVIDERS` is set
  (`[{"kind":"anthropic"|"openai","base_url":"…","model":"…","api_key_env":"NAME"}]`), an
  LLM can add steps on top. The LLM never removes baseline steps. If a provider refuses or
  errors, the next one is tried. If they all fail, the rest of the run is deterministic.
- **Gate.** Safe tools are read-only probes and are auto-approved under `auto-safe`.
  Intrusive tools (password guessing, payloads) are denied in stage 1 under every mode.
  `deny-all` runs nothing.
- **Probes.** TCP connect scan of about 100 common ports (every port at depth `deep`). Database and admin ports open to
  the internet are reported as high (the Docker API port is critical). The probes also
  grab banners, check HTTP version leaks and missing safety headers, look for files that
  should not be public (with content checks against false positives), check TLS versions
  and certificate expiry, trust and name, and check SSH version and whether password
  login is offered. No password is ever sent.

## Build and test

```
cd plugins/security-check/engine
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o seccheck ./cmd/seccheck
```

Go 1.22. The only dependencies are `modernc.org/sqlite` and `golang.org/x/crypto`. CI:
`.github/workflows/security-check.yml` uploads the amd64 and arm64 binaries.
`bin/security-check` only launches the binary that sits next to it.
