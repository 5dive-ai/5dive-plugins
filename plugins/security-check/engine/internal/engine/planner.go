package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/tools"
)

// baseline is the deterministic planner: a fixed shallow recon sequence derived
// from the facts so far. It runs every round, with or without an LLM, so a model
// can add steps but never shrink the check below this floor. The engine drops
// intents it has already seen, so this can be stateless.
func baseline(s *scope.Scope, hasNmap bool, facts []model.Fact) []model.Intent {
	var out []model.Intent
	add := func(tool, target string, args map[string]string, why string, parent int64) {
		out = append(out, model.Intent{Tool: tool, Target: target, Args: args, Why: why, ParentNode: parent})
	}
	for _, ip := range s.IPs() {
		add("port_scan", ip.String(), nil, "find which common ports answer", 0)
		if hasNmap {
			add("nmap", ip.String(), nil, "identify service versions with nmap", 0)
		}
	}
	// Web probes go to each owner host name (as Host/SNI, max 5), or to the bare IP
	// when there are none. Probing both would report one site twice.
	vhosts := s.HostNames
	if len(vhosts) > 5 {
		vhosts = vhosts[:5]
	}
	if len(vhosts) == 0 {
		vhosts = []string{""}
	}
	for _, f := range facts {
		switch f.Kind {
		case "open_port", "nmap_service":
			add("banner", f.Target, nil, "work out what speaks on this port", f.Node)
		case "service":
			switch f.Data["proto"] {
			case "ssh":
				add("ssh_probe", f.Target, nil, "check SSH version and login methods", f.Node)
			case "http", "tls":
				scheme := "http"
				if f.Data["proto"] == "tls" {
					scheme = "https"
				}
				for _, vh := range vhosts {
					if scheme == "https" {
						add("tls_probe", f.Target, args("sni", vh), "check encryption and certificate", f.Node)
					}
					a := args("scheme", scheme, "host", vh)
					add("http_probe", f.Target, a, "check version leaks and safety headers", f.Node)
					add("exposure_probe", f.Target, a, "look for files that should never be public", f.Node)
				}
			}
		}
	}
	return out
}

// args builds an args map, leaving out empty values.
func args(kv ...string) map[string]string {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] != "" {
			m[kv[i]] = kv[i+1]
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// ScopeLock is the standing instruction that opens the planner's system prompt
// (and would open any worker prompt): the run is authorized testing of the
// operator's own cloned asset, these targets only, read-only probes only.
func ScopeLock(s *scope.Scope) string {
	ips := make([]string, 0, len(s.Targets))
	for _, ip := range s.IPs() {
		ips = append(ips, ip.String())
	}
	names := "none"
	if len(s.HostNames) > 0 {
		names = strings.Join(s.HostNames, ", ")
	}
	return fmt.Sprintf(`AUTHORIZATION AND SCOPE (standing instruction, applies to every turn):
This is an authorized security self-check that the operator ordered on their own server. The machine under test is a private, disposable copy (clone) of the operator's own server, made for this check and destroyed afterwards.
- Allowed targets, and the only ones: %s.
- The operator's own host names (%s) may appear ONLY as the "host" or "sni" argument of a step against an allowed target. They are never a target and are never looked up.
- Plan only read-only probes from the tool list. Never plan password guessing, payloads meant to break in, load or denial of service, or anything that changes data.
- The engine refuses and records any step outside these rules.`, strings.Join(ips, ", "), names)
}

const plannerTask = `You plan the next steps of the check. Each step runs exactly one tool against one target, and its results come back to you as facts next round.
Reply with ONLY a JSON object, no prose:
{"intents":[{"tool":"<name>","target":"<ip or ip:port>","args":{"scheme":"http|https","host":"<host name>","sni":"<host name>"},"why":"<short reason>"}],"done":false}
Propose at most 10 new steps that are not in already_run. Set "done": true when nothing more is worth checking.`

type plannerInput struct {
	Targets    []string     `json:"targets"`
	HostNames  []string     `json:"host_names"`
	Tools      []toolSpec   `json:"tools"`
	Facts      []model.Fact `json:"facts"`
	AlreadyRun []string     `json:"already_run"`
}

type toolSpec struct {
	Name   string `json:"name"`
	Target string `json:"target"`
	Args   string `json:"args,omitempty"`
	Desc   string `json:"desc"`
}

func plannerPrompt(s *scope.Scope, catalog map[string]tools.Tool, facts []model.Fact, seen map[string]bool) (string, error) {
	in := plannerInput{HostNames: s.HostNames}
	for _, ip := range s.IPs() {
		in.Targets = append(in.Targets, ip.String())
	}
	for _, t := range catalog {
		if t.Risk == tools.Safe {
			in.Tools = append(in.Tools, toolSpec{t.Name, t.Target, t.Args, t.Desc})
		}
	}
	sort.Slice(in.Tools, func(i, j int) bool { return in.Tools[i].Name < in.Tools[j].Name })
	if len(facts) > 200 {
		facts = facts[len(facts)-200:]
	}
	in.Facts = facts
	for k := range seen {
		in.AlreadyRun = append(in.AlreadyRun, k)
	}
	sort.Strings(in.AlreadyRun)
	b, err := json.Marshal(in)
	return string(b), err
}

type plannerOutput struct {
	Intents []model.Intent `json:"intents"`
	Done    bool           `json:"done"`
}

// parsePlan pulls the JSON object out of a model answer.
func parsePlan(text string) (plannerOutput, error) {
	var out plannerOutput
	i, j := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if i < 0 || j < i {
		return out, errors.New("no JSON object in answer")
	}
	if err := json.Unmarshal([]byte(text[i:j+1]), &out); err != nil {
		return out, err
	}
	if len(out.Intents) > 10 {
		out.Intents = out.Intents[:10]
	}
	return out, nil
}
