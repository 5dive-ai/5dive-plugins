package engine

import (
	"fmt"
	"net/netip"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/tools"
)

// Approval modes.
const (
	AutoSafe = "auto-safe" // safe tools run, intrusive tools are denied
	DenyAll  = "deny-all"  // nothing runs
)

// Decision is the gate's answer for one intent.
type Decision struct {
	Approved bool
	Reason   string
}

var allowedArgs = map[string]bool{"scheme": true, "host": true, "sni": true}

// Gate decides whether an intent may run. Every intent, from either planner,
// passes here first: scope, then approval mode, then the tool's risk class.
func Gate(s *scope.Scope, catalog map[string]tools.Tool, mode string, in model.Intent) Decision {
	deny := func(format string, a ...any) Decision { return Decision{Reason: fmt.Sprintf(format, a...)} }
	tool, ok := catalog[in.Tool]
	if !ok {
		return deny("unknown tool %q", in.Tool)
	}
	ip, err := s.CheckAddress(in.Target)
	if err != nil {
		return deny("out of scope: %v", err)
	}
	switch tool.Target {
	case "ip":
		if _, err := netip.ParseAddr(in.Target); err != nil {
			return deny("%s takes a bare IP target, got %q", in.Tool, in.Target)
		}
	case "ip:port":
		if _, err := netip.ParseAddrPort(in.Target); err != nil {
			return deny("%s takes an ip:port target, got %q", in.Tool, in.Target)
		}
	}
	for k, v := range in.Args {
		if !allowedArgs[k] {
			return deny("argument %q is not allowed", k)
		}
		if (k == "host" || k == "sni") && v != "" && v != ip.String() && !s.AllowsHostName(v) {
			return deny("out of scope: %s %q is not one of this run's host names", k, v)
		}
		if k == "scheme" && v != "http" && v != "https" {
			return deny("scheme %q is not http or https", v)
		}
	}
	if mode == DenyAll {
		return deny("approval mode deny-all: no step runs")
	}
	if tool.Risk != tools.Safe {
		return deny("%s is %s; stage 1 runs read-only probes only", in.Tool, tool.Risk)
	}
	return Decision{Approved: true, Reason: "read-only probe, in scope"}
}
