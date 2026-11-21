// Package model holds the few types every stage of a run passes around.
package model

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/netip"
	"regexp"
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
	// Source says what planned the step that found it: SourceBaseline (the fixed
	// recon chain, which a re-run without an LLM repeats) or SourcePlanner (only the
	// LLM proposed it). A retest can confirm «fixed» only for a baseline finding.
	Source string `json:"source,omitempty"`
	// Evidence is the traffic behind the finding: what the probe sent and what came
	// back, recorded on the wire with secrets masked (DIVE-8921).
	Evidence []Exchange `json:"evidence,omitempty"`
	// New marks a finding that no earlier check of the same server reported
	// (DIVE-8925). Only set when there was an earlier check: see report.Changes.
	New bool `json:"new,omitempty"`
}

// Exchange is one recorded conversation with the target: one connection, or one
// command for a tool that runs outside the engine's dialer (nmap).
type Exchange struct {
	Proto    string `json:"proto"`  // tcp | http | https | tls | exec
	Target   string `json:"target"` // ip:port dialled (ip for exec)
	Request  string `json:"request"`
	Response string `json:"response"`
}

// Finding sources.
const (
	SourceBaseline = "baseline"
	SourcePlanner  = "planner"
)

// NewFinding builds a finding whose id is stable for the same check on the same asset,
// so later runs can tell a finding that stayed from one that is new. Every run scans a
// NEW clone with a new IP, so the id hashes the asset with its IP address replaced by
// a fixed word: the same open port is the same finding on any clone (DIVE-8917).
func NewFinding(check, severity, asset, title, what, why, fix, proof string) Finding {
	sum := sha256.Sum256([]byte(check + "\x00" + StableAsset(asset)))
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

// FindingKey is a finding's identity across runs: its check and its clone-free asset.
// It also matches findings stored by engines older than DIVE-8917, whose id hashed
// the clone IP: the check name is the id up to its last "-", the asset is re-keyed.
func FindingKey(id, asset string) string {
	check := id
	if i := strings.LastIndex(id, "-"); i > 0 {
		check = id[:i]
	}
	return check + "\x00" + StableAsset(asset)
}

// addrLike matches a run of characters an IP address (with or without a port) is made of.
var addrLike = regexp.MustCompile(`[0-9A-Fa-f:.]+`)

// StableAsset replaces every IP address in an asset label with "server", keeping the
// port and everything else: "203.0.113.10:5432" -> "server:5432",
// "https://example.com (203.0.113.10:443)" -> "https://example.com (server:443)".
func StableAsset(asset string) string {
	return addrLike.ReplaceAllStringFunc(asset, func(s string) string {
		if _, err := netip.ParseAddr(s); err == nil {
			return "server"
		}
		if ap, err := netip.ParseAddrPort(s); err == nil && !ap.Addr().Is6() {
			return fmt.Sprintf("server:%d", ap.Port())
		}
		return s
	})
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
