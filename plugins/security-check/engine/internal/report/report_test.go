package report

import (
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
)

func sample() *Report {
	return &Report{
		RunID: "r1", StartedAt: "2026-11-20T10:00:00Z", FinishedAt: "2026-11-20T10:01:00Z", EngineVersion: "0.1.0",
		Scope: &scope.Scope{RunID: "r1", Targets: []scope.Target{{Kind: "ip", Value: "203.0.113.7"}}},
		Findings: []model.Finding{
			model.NewFinding("a", model.Low, "x", "Low one", "w", "y", "f", "p"),
			model.NewFinding("b", model.Info, "x", "Info one", "w", "y", "f", "p"),
			model.NewFinding("c", model.Critical, "x", "Critical one", "w, with \"quotes\"", "y", "f", "p\nline2"),
			model.NewFinding("d", model.Medium, "x", "Medium one", "w", "y", "f", "p"),
		},
		Budget:        Budget{TokensUsed: 5, Seconds: 60, MaxTokens: 100, MaxSeconds: 900},
		Approvals:     []Approval{{Step: 1, Tool: "port_scan", Target: "203.0.113.7", Decision: "approved", Reason: "ok"}},
		StoppedReason: StopDone,
	}
}

func TestWriteShapes(t *testing.T) {
	dir := t.TempDir()
	if err := Write(dir, sample()); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"run_id", "started_at", "finished_at", "engine_version", "scope", "summary", "findings", "budget", "approvals", "stopped_reason"} {
		if _, ok := top[k]; !ok {
			t.Errorf("report.json lacks %q", k)
		}
	}
	var rep struct {
		Summary   map[string]int      `json:"summary"`
		Findings  []map[string]string `json:"findings"`
		Budget    map[string]int      `json:"budget"`
		Approvals []map[string]any    `json:"approvals"`
	}
	if err := json.Unmarshal(raw, &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Summary["critical"] != 1 || rep.Summary["medium"] != 1 || rep.Summary["low"] != 1 || rep.Summary["info"] != 1 || rep.Summary["high"] != 0 {
		t.Errorf("summary %v", rep.Summary)
	}
	if rep.Findings[0]["severity"] != "critical" || rep.Findings[3]["severity"] != "info" {
		t.Errorf("findings not sorted by severity: %v", rep.Findings)
	}
	for _, k := range []string{"id", "severity", "title", "what", "why", "fix", "proof", "asset"} {
		if _, ok := rep.Findings[0][k]; !ok {
			t.Errorf("finding lacks %q", k)
		}
	}
	for _, k := range []string{"tokens_used", "seconds", "max_tokens", "max_seconds"} {
		if _, ok := rep.Budget[k]; !ok {
			t.Errorf("budget lacks %q", k)
		}
	}
	for _, k := range []string{"step", "tool", "target", "decision", "reason"} {
		if _, ok := rep.Approvals[0][k]; !ok {
			t.Errorf("approval lacks %q", k)
		}
	}

	f, _ := os.Open(filepath.Join(dir, "findings.csv"))
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(rows[0], ",") != "id,severity,title,what,why,fix,proof,asset" || len(rows) != 5 || rows[1][6] != "p\nline2" {
		t.Errorf("csv %q", rows)
	}

	md, _ := os.ReadFile(filepath.Join(dir, "report.md"))
	lines := strings.Split(string(md), "\n")
	if lines[0] != "3 things to fix, 1 urgent" {
		t.Errorf("md first line %q", lines[0])
	}
	if strings.Index(string(md), "Critical one") > strings.Index(string(md), "Medium one") {
		t.Errorf("md not sorted")
	}
	for _, banned := range []string{"pentest", "exploit", "attack"} {
		if strings.Contains(strings.ToLower(string(md)), banned) {
			t.Errorf("report.md says %q", banned)
		}
	}
}

func TestHeadline(t *testing.T) {
	cases := map[Summary]string{
		{}:                   "Nothing to fix. Your server looks good from the outside.",
		{Info: 3}:            "Nothing to fix. Your server looks good from the outside.",
		{Low: 1}:             "1 thing to fix, nothing urgent",
		{High: 1, Medium: 1}: "2 things to fix, 1 urgent",
	}
	for s, want := range cases {
		if got := Headline(s); got != want {
			t.Errorf("%+v: %q, want %q", s, got, want)
		}
	}
}

func TestEmptyReportHasArraysNotNull(t *testing.T) {
	r := &Report{RunID: "r", StoppedReason: StopBudgetTime}
	r.Finalize()
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), `"findings":null`) || strings.Contains(string(b), `"approvals":null`) {
		t.Errorf("null arrays: %s", b)
	}
	if md := Markdown(r); !strings.Contains(md, "time limit") || !strings.HasPrefix(md, "No checks ran") {
		t.Errorf("budget stop not explained")
	}
}
