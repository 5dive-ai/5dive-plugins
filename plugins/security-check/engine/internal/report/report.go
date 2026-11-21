// Package report writes the three output files the control plane reads back:
// report.json, report.md and findings.csv.
package report

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
)

// Stopped reasons.
const (
	StopDone         = "done"
	StopBudgetTime   = "budget_time"
	StopBudgetTokens = "budget_tokens"
	StopError        = "error"
)

// Report is report.json.
type Report struct {
	RunID         string          `json:"run_id"`
	StartedAt     string          `json:"started_at"`
	FinishedAt    string          `json:"finished_at"`
	EngineVersion string          `json:"engine_version"`
	Scope         *scope.Scope    `json:"scope"`
	Summary       Summary         `json:"summary"`
	Findings      []model.Finding `json:"findings"`
	Budget        Budget          `json:"budget"`
	// LLMSpend is each LLM profile's tokens against its own budget (absent with no LLM).
	LLMSpend      []ProviderSpend `json:"llm_spend,omitempty"`
	Approvals     []Approval      `json:"approvals"`
	StoppedReason string          `json:"stopped_reason"`
	// Changes is what this run saw that no earlier run on the same server did;
	// nil on a server's first run, where everything would read «new» (DIVE-8925).
	Changes *Changes `json:"changes,omitempty"`
}

// Changes compares a run with every earlier run (check or retest) of the same
// server. «New» means never seen before, not «absent last time»: the LLM planner
// looks in different places each run, so «absent last time» would flag a thing
// the previous run simply did not look at. For the same reason there is no «gone»
// list: not finding something is not proof it was removed (a retest answers that).
type Changes struct {
	EarlierRuns int           `json:"earlier_runs"`
	Since       string        `json:"since"` // when the latest earlier run started
	NewAssets   []model.Asset `json:"new_assets"`
	NewFindings int           `json:"new_findings"` // findings marked "new": true
}

// Summary counts findings per severity.
type Summary struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Info     int `json:"info"`
}

// Budget is what the run spent against its limits.
type Budget struct {
	TokensUsed int `json:"tokens_used"`
	Seconds    int `json:"seconds"`
	MaxTokens  int `json:"max_tokens"`
	MaxSeconds int `json:"max_seconds"`
}

// ProviderSpend is one LLM profile's tokens; max_tokens absent = no own budget.
type ProviderSpend struct {
	Provider  string `json:"provider"`
	Tokens    int    `json:"tokens"`
	MaxTokens int    `json:"max_tokens,omitempty"`
}

// Approval is one gate decision.
type Approval struct {
	Step     int    `json:"step"`
	Tool     string `json:"tool"`
	Target   string `json:"target"`
	Decision string `json:"decision"` // approved | denied
	Reason   string `json:"reason"`
}

// Finalize sorts findings most serious first and fills the summary.
func (r *Report) Finalize() {
	sort.SliceStable(r.Findings, func(i, j int) bool {
		return model.SeverityRank(r.Findings[i].Severity) < model.SeverityRank(r.Findings[j].Severity)
	})
	r.Summary = Summary{}
	for _, f := range r.Findings {
		switch f.Severity {
		case model.Critical:
			r.Summary.Critical++
		case model.High:
			r.Summary.High++
		case model.Medium:
			r.Summary.Medium++
		case model.Low:
			r.Summary.Low++
		default:
			r.Summary.Info++
		}
	}
	if r.Findings == nil {
		r.Findings = []model.Finding{}
	}
	if r.Approvals == nil {
		r.Approvals = []Approval{}
	}
}

// Write writes report.json, report.md and findings.csv into dir.
func Write(dir string, r *Report) error {
	r.Finalize()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	js, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(dir, "report.json"), js); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(dir, "report.md"), []byte(Markdown(r))); err != nil {
		return err
	}
	var b strings.Builder
	w := csv.NewWriter(&b)
	_ = w.Write([]string{"id", "severity", "title", "what", "why", "fix", "proof", "asset", "evidence"})
	for _, f := range r.Findings {
		_ = w.Write([]string{f.ID, f.Severity, f.Title, f.What, f.Why, f.Fix, f.Proof, f.Asset, EvidenceText(f.Evidence)})
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return err
	}
	return writeFile(filepath.Join(dir, "findings.csv"), []byte(b.String()))
}

// EvidenceText is a finding's evidence as plain text: each exchange's target,
// then ">>" what we sent and "<<" what came back.
func EvidenceText(ex []model.Exchange) string {
	parts := make([]string, len(ex))
	for i, e := range ex {
		parts[i] = fmt.Sprintf("%s %s\n>> %s\n<< %s", e.Proto, e.Target, e.Request, e.Response)
	}
	return strings.Join(parts, "\n---\n")
}

// writeFile writes atomically so a reader never sees half a report.
func writeFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var label = map[string]string{
	model.Critical: "Urgent",
	model.High:     "Urgent",
	model.Medium:   "Important",
	model.Low:      "Minor",
}

// Headline is the opening line, for example "3 things to fix, 1 urgent".
func Headline(s Summary) string {
	toFix := s.Critical + s.High + s.Medium + s.Low
	urgent := s.Critical + s.High
	switch {
	case toFix == 0:
		return "Nothing to fix. Your server looks good from the outside."
	case urgent > 0:
		return fmt.Sprintf("%d %s to fix, %d urgent", toFix, plural(toFix, "thing", "things"), urgent)
	default:
		return fmt.Sprintf("%d %s to fix, nothing urgent", toFix, plural(toFix, "thing", "things"))
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

var stoppedNote = map[string]string{
	StopBudgetTime:   "This check hit its time limit and stopped early, so it may have missed things.",
	StopBudgetTokens: "This check hit its usage limit and stopped early, so it may have missed things.",
	StopError:        "This check stopped early because of an error, so it may have missed things.",
}

// Markdown renders report.md: short, plain, most serious first.
func Markdown(r *Report) string {
	var b strings.Builder
	head := Headline(r.Summary)
	ran := false
	for _, a := range r.Approvals {
		ran = ran || a.Decision == "approved"
	}
	switch {
	case !ran:
		head = "No checks ran, so this report says nothing about your server yet."
	case r.Summary.Critical+r.Summary.High+r.Summary.Medium+r.Summary.Low == 0 && r.StoppedReason != StopDone:
		head = "Nothing to fix found so far, but the check stopped early."
	}
	b.WriteString(head + "\n")
	if note := stoppedNote[r.StoppedReason]; note != "" {
		b.WriteString("\n" + note + "\n")
	}
	n := 0
	var info []model.Finding
	for _, f := range r.Findings {
		if f.Severity == model.Info {
			info = append(info, f)
			continue
		}
		n++
		fmt.Fprintf(&b, "\n## %d. %s (%s)\n\n", n, f.Title, label[f.Severity])
		fmt.Fprintf(&b, "**What we found:** %s\n\n", f.What)
		fmt.Fprintf(&b, "**Why it matters:** %s\n\n", f.Why)
		fmt.Fprintf(&b, "**How to fix:** %s\n", f.Fix)
	}
	if len(info) > 0 {
		b.WriteString("\n## Good to know\n\n")
		for _, f := range info {
			fmt.Fprintf(&b, "- %s\n", f.Title)
		}
	}
	b.WriteString("\n---\nWe checked a private copy of your server, never the live one. Details and evidence are in report.json and findings.csv.\n")
	return b.String()
}
