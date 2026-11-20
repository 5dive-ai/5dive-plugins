package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/testnet"
)

func testDeps(t *testing.T, rec *testnet.Recorder, env map[string]string) deps {
	return deps{
		getenv:   func(k string) string { return env[k] },
		dial:     rec.Dial,
		ports:    []int{1}, // never the real top-100 list against this host's loopback
		lookPath: func(string) (string, error) { return "", fmt.Errorf("no nmap in tests") },
	}
}

func writeScope(t *testing.T, dir, body string) string {
	p := filepath.Join(dir, "scope.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// A refused scope exits 2 before any network I/O and before any output exists.
func TestBadScopeExits2BeforeNetwork(t *testing.T) {
	testnet.TrapDNS(t)
	for name, body := range map[string]string{
		"empty":    `{}`,
		"hostname": `{"run_id":"r","targets":[{"kind":"ip","value":"box.example.com"}],"host_names":["box.example.com"]}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			rec := testnet.NewRecorder(t)
			var stderr bytes.Buffer
			code := run(context.Background(), []string{"run", "--scope", writeScope(t, dir, body),
				"--db", filepath.Join(dir, "e.sqlite"), "--out", filepath.Join(dir, "out")}, &stderr, testDeps(t, rec, nil))
			if code != exitScope {
				t.Fatalf("exit %d, want 2 (%s)", code, stderr.String())
			}
			if len(rec.Seen()) != 0 {
				t.Fatalf("dialed %v", rec.Seen())
			}
			if _, err := os.Stat(filepath.Join(dir, "out")); !os.IsNotExist(err) {
				t.Fatalf("output written for a refused scope")
			}
		})
	}
}

func TestNoExtraTargetsOnCommandLine(t *testing.T) {
	rec := testnet.NewRecorder(t)
	code := run(context.Background(), []string{"run", "--scope", "x", "--db", "y", "--out", "z", "10.0.0.1"},
		&bytes.Buffer{}, testDeps(t, rec, nil))
	if code != exitError || len(rec.Seen()) != 0 {
		t.Fatalf("exit %d dials %v", code, rec.Seen())
	}
}

// A token budget stop exits 3 and still writes all three reports.
func TestTokenBudgetExits3WithReport(t *testing.T) {
	testnet.TrapDNS(t)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"content":[{"type":"text","text":"{\"intents\":[],\"done\":true}"}],"stop_reason":"end_turn","usage":{"input_tokens":900,"output_tokens":100}}`)
	}))
	defer fake.Close()
	dir := t.TempDir()
	rec := testnet.NewRecorder(t)
	env := map[string]string{
		"SECCHECK_LLM_PROVIDERS": `[{"kind":"anthropic","base_url":"` + fake.URL + `","model":"m","api_key_env":"SECCHECK_KEY"}]`,
		"SECCHECK_KEY":           "k",
	}
	var stderr bytes.Buffer
	code := run(context.Background(), []string{"run",
		"--scope", writeScope(t, dir, `{"run_id":"r9","owner":{"server_id":1,"domain":"box.example.com"},"targets":[{"kind":"ip","value":"127.0.0.1"}],"host_names":["box.example.com"],"depth":"shallow"}`),
		"--db", filepath.Join(dir, "e.sqlite"), "--out", filepath.Join(dir, "out"), "--max-tokens", "50"}, &stderr, testDeps(t, rec, env))
	if code != exitBudget {
		t.Fatalf("exit %d, want 3 (%s)", code, stderr.String())
	}
	for _, f := range []string{"report.json", "report.md", "findings.csv"} {
		if _, err := os.Stat(filepath.Join(dir, "out", f)); err != nil {
			t.Errorf("%s not written: %v", f, err)
		}
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "out", "report.json"))
	var rep struct {
		StoppedReason string         `json:"stopped_reason"`
		Budget        map[string]int `json:"budget"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil {
		t.Fatal(err)
	}
	if rep.StoppedReason != "budget_tokens" || rep.Budget["tokens_used"] != 1000 || rep.Budget["max_tokens"] != 50 {
		t.Fatalf("report %+v", rep)
	}
}

func TestDenyAllRunsNothing(t *testing.T) {
	testnet.TrapDNS(t)
	dir := t.TempDir()
	rec := testnet.NewRecorder(t)
	code := run(context.Background(), []string{"run",
		"--scope", writeScope(t, dir, `{"run_id":"r","targets":[{"kind":"ip","value":"127.0.0.1"}]}`),
		"--db", filepath.Join(dir, "e.sqlite"), "--out", dir, "--approval", "deny-all"}, &bytes.Buffer{}, testDeps(t, rec, nil))
	if code != exitDone || len(rec.Seen()) != 0 {
		t.Fatalf("exit %d dials %v", code, rec.Seen())
	}
}
