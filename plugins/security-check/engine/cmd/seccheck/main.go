// Command seccheck scans a sealed clone of an owner's server and writes a plain
// report. Targets come only from scope.json, which the control plane writes.
//
//	seccheck run --scope scope.json --db evidence.sqlite --out dir [--max-seconds 900] [--max-tokens 150000] [--approval auto-safe|deny-all]
//	seccheck version
//
// Exit codes: 0 done, 1 other error, 2 scope refused, 3 budget exhausted (report written).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/engine"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/llm"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/report"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/store"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/tools"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "0.1.0"

const (
	exitDone   = 0
	exitError  = 1
	exitScope  = 2
	exitBudget = 3
)

// deps are the seams tests replace; main uses the real ones.
type deps struct {
	getenv   func(string) string
	dial     scope.DialFunc // nil = plain dialer with DNS disabled
	ports    []int          // a shallow scope's ports
	deep     []int          // a deep scope's ports
	lookPath func(string) (string, error)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stderr, deps{getenv: os.Getenv, ports: tools.TopPorts, deep: tools.AllPorts(), lookPath: exec.LookPath}))
}

func run(ctx context.Context, args []string, stderr io.Writer, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: seccheck run --scope <scope.json> --db <sqlite> --out <dir> | seccheck version")
		return exitError
	}
	switch args[0] {
	case "version":
		fmt.Println(Version)
		return exitDone
	case "run":
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		return exitError
	}

	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	scopePath := fs.String("scope", "", "scope.json written by the control plane")
	dbPath := fs.String("db", "", "sqlite evidence database")
	outDir := fs.String("out", "", "directory for report.json, report.md, findings.csv")
	maxSeconds := fs.Int("max-seconds", 900, "wall-clock budget")
	maxTokens := fs.Int("max-tokens", 150000, "LLM token budget")
	approval := fs.String("approval", engine.AutoSafe, "auto-safe | deny-all")
	if err := fs.Parse(args[1:]); err != nil {
		return exitError
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "unexpected arguments: %v (targets come only from --scope)\n", fs.Args())
		return exitError
	}
	if *scopePath == "" || *dbPath == "" || *outDir == "" {
		fmt.Fprintln(stderr, "--scope, --db and --out are required")
		return exitError
	}
	if *approval != engine.AutoSafe && *approval != engine.DenyAll {
		fmt.Fprintf(stderr, "--approval %q is not auto-safe or deny-all\n", *approval)
		return exitError
	}
	if *maxSeconds <= 0 || *maxTokens < 0 {
		fmt.Fprintln(stderr, "--max-seconds must be > 0 and --max-tokens >= 0")
		return exitError
	}

	// The scope is checked before anything touches the network.
	sc, err := scope.Load(*scopePath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitScope
	}

	st, err := store.Open(*dbPath)
	if err != nil {
		fmt.Fprintf(stderr, "open %s: %v\n", *dbPath, err)
		return exitError
	}
	defer st.Close()

	var client *llm.Client
	if raw := d.getenv("SECCHECK_LLM_PROVIDERS"); raw != "" {
		ps, err := llm.ParseProviders(raw)
		if err != nil {
			fmt.Fprintf(stderr, "%v; using the deterministic planner\n", err)
		} else if len(ps) > 0 {
			client = llm.NewClient(ps, d.getenv)
		}
	}
	nmapPath, _ := d.lookPath("nmap")
	ports := d.ports
	if sc.Depth == scope.Deep {
		ports = d.deep
	}

	env := &tools.Env{
		Scope:          sc,
		Dial:           scope.NewGuard(sc, d.dial).DialContext,
		Ports:          ports,
		ConnectTimeout: time.Second,
		IOTimeout:      5 * time.Second,
		NmapPath:       nmapPath,
	}
	rep, runErr := engine.Run(ctx, engine.Config{
		Scope: sc, Store: st, Env: env, LLM: client, Approval: *approval,
		MaxDuration: time.Duration(*maxSeconds) * time.Second, MaxTokens: *maxTokens,
		Version: Version, Log: stderr,
	})
	if err := report.Write(*outDir, rep); err != nil {
		fmt.Fprintf(stderr, "write report: %v\n", err)
		return exitError
	}
	switch {
	case runErr != nil || rep.StoppedReason == report.StopError:
		if runErr != nil && !errors.Is(runErr, context.Canceled) {
			fmt.Fprintf(stderr, "run failed: %v\n", runErr)
		}
		return exitError
	case rep.StoppedReason == report.StopBudgetTime || rep.StoppedReason == report.StopBudgetTokens:
		return exitBudget
	}
	return exitDone
}
