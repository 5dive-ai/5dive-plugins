// Package model holds the few types every stage of a run passes around.
package model

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Severity levels, most serious first.
const (
	Critical = "critical"
	High     = "high"
	Medium   = "medium"
	Low      = "low"
	Info     = "info"
)

// Severities lists every severity in report order.
var Severities = []string{Critical, High, Medium, Low, Info}

// SeverityRank orders severities: lower is more serious.
func SeverityRank(s string) int {
	for i, v := range Severities {
		if v == s {
			return i
		}
	}
	return len(Severities)
}

// Intent is one planned step: run one tool against one in-scope target.
type Intent struct {
	Tool   string            `json:"tool"`
	Target string            `json:"target"` // "ip" or "ip:port"
	Args   map[string]string `json:"args,omitempty"`
	Why    string            `json:"why"`
	// ParentNode is the exploration-graph node that prompted this intent (0 = the goal).
	ParentNode int64 `json:"-"`
}

// Key identifies an intent for de-duplication across planner rounds.
func (in Intent) Key() string {
	keys := make([]string, 0, len(in.Args))
	for k := range in.Args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(in.Tool + "|" + in.Target)
	for _, k := range keys {
		b.WriteString("|" + k + "=" + in.Args[k])
	}
	return b.String()
}

// Fact is something a tool observed. Facts feed the next planner round.
type Fact struct {
	Kind   string            `json:"kind"`   // open_port, service, http, tls, ssh, nmap_service
	Target string            `json:"target"` // "ip:port"
	Data   map[string]string `json:"data,omitempty"`
	// Node is the exploration-graph node id once stored.
	Node int64 `json:"-"`
}

// Finding is one report line for the owner.
type Finding struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	What     string `json:"what"`
	Why      string `json:"why"`
	Fix      string `json:"fix"`
	Proof    string `json:"proof"`
	Asset    string `json:"asset"`
}

// NewFinding builds a finding whose id is stable for the same check on the same asset,
// so later runs can tell a finding that stayed from one that is new.
func NewFinding(check, severity, asset, title, what, why, fix, proof string) Finding {
	sum := sha256.Sum256([]byte(check + "\x00" + asset))
	return Finding{
		ID:       fmt.Sprintf("%s-%s", check, hex.EncodeToString(sum[:4])),
		Severity: severity,
		Title:    title,
		What:     what,
		Why:      why,
		Fix:      fix,
		Proof:    Clip(proof, 600),
		Asset:    asset,
	}
}

// Asset is a node of the cross-run asset graph.
type Asset struct {
	Kind string            `json:"kind"` // host, port, service, url, cert
	Key  string            `json:"key"`
	Data map[string]string `json:"data,omitempty"`
}

// Clip shortens s to at most n bytes, marking the cut.
func Clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") + "…"
}
