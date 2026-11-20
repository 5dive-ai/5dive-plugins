// Package tools holds the probes a worker can run. Each tool runs one intent
// against one in-scope target and returns what it saw. Every connection goes
// through Env.Dial, which is the scope Guard in production.
package tools

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
)

// Risk classes for the approval gate.
const (
	Safe      = "safe"      // read-only probes
	Intrusive = "intrusive" // payloads that try to break in, or password guessing
)

// Env is what every tool gets.
type Env struct {
	Scope          *scope.Scope
	Dial           scope.DialFunc
	Ports          []int         // ports the port scan tries
	ConnectTimeout time.Duration // port scan connect timeout
	IOTimeout      time.Duration // per-probe read/handshake timeout
	NmapPath       string        // "" when nmap is not installed
}

// Result is what one tool run produced.
type Result struct {
	Facts    []model.Fact
	Findings []model.Finding
	Assets   []model.Asset
}

// Tool is one entry in the catalogue.
type Tool struct {
	Name   string
	Risk   string
	Target string // "ip" or "ip:port"
	Desc   string
	Args   string // accepted args, for the planner prompt
	Run    func(ctx context.Context, env *Env, in model.Intent) (Result, error)
}

// Catalog lists every tool the gate knows. The intrusive entries have no Run:
// stage 1 never approves them, and they are listed so a proposal naming one is
// classified and recorded as denied rather than as unknown.
func Catalog() map[string]Tool {
	list := []Tool{
		{Name: "port_scan", Risk: Safe, Target: "ip", Desc: "TCP connect scan of common ports", Run: portScan},
		{Name: "banner", Risk: Safe, Target: "ip:port", Desc: "read the greeting and tell SSH, TLS and HTTP apart", Run: bannerGrab},
		{Name: "http_probe", Risk: Safe, Target: "ip:port", Args: "scheme=http|https, host=<one of host_names>", Desc: "GET / and read status, version headers and safety headers", Run: httpProbe},
		{Name: "exposure_probe", Risk: Safe, Target: "ip:port", Args: "scheme=http|https, host=<one of host_names>", Desc: "GET a fixed list of files that should never be public", Run: exposureProbe},
		{Name: "tls_probe", Risk: Safe, Target: "ip:port", Args: "sni=<one of host_names>", Desc: "TLS versions accepted and certificate health", Run: tlsProbe},
		{Name: "ssh_probe", Risk: Safe, Target: "ip:port", Desc: "SSH version and whether password login is offered (no password is ever sent)", Run: sshProbe},
		{Name: "nmap", Risk: Safe, Target: "ip", Desc: "nmap -sV --top-ports 100 (only when installed)", Run: nmapScan},
		{Name: "ssh_password_guess", Risk: Intrusive, Target: "ip:port", Desc: "try passwords against SSH"},
		{Name: "http_payload_fuzz", Risk: Intrusive, Target: "ip:port", Desc: "send injection payloads to web forms"},
	}
	out := make(map[string]Tool, len(list))
	for _, t := range list {
		out[t.Name] = t
	}
	return out
}

// splitTarget parses "ip:port".
func splitTarget(target string) (netip.Addr, int, error) {
	ap, err := netip.ParseAddrPort(target)
	if err != nil {
		return netip.Addr{}, 0, fmt.Errorf("target %q is not ip:port", target)
	}
	return ap.Addr(), int(ap.Port()), nil
}

func joinTarget(ip netip.Addr, port int) string {
	return net.JoinHostPort(ip.String(), strconv.Itoa(port))
}

// vhost picks the Host/SNI value for a probe: a scope host name, or the bare IP.
// An unknown name is refused (the gate refuses it first; this is the backstop).
func vhost(env *Env, in model.Intent, key string, ip netip.Addr) (string, error) {
	h := in.Args[key]
	if h == "" || h == ip.String() {
		return "", nil
	}
	if !env.Scope.AllowsHostName(h) {
		return "", fmt.Errorf("%s %q is not one of this run's host names", key, h)
	}
	return h, nil
}

// httpClient talks to a target IP. Proxies are off, redirects are not followed
// (a redirect could name the live box), and every dial goes through env.Dial.
func httpClient(env *Env, sni string) *http.Client {
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           env.Dial,
		TLSClientConfig:       &tls.Config{ServerName: sni, InsecureSkipVerify: true}, //nolint:gosec // certificate health is tls_probe's job
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   env.IOTimeout,
		ResponseHeaderTimeout: env.IOTimeout,
	}
	return &http.Client{
		Transport: tr,
		Timeout:   2 * env.IOTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// hostHeader is the Host header for vhost on port (empty vhost = leave the IP).
func hostHeader(vhost, scheme string, port int) string {
	if vhost == "" {
		return ""
	}
	if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
		return vhost
	}
	return net.JoinHostPort(vhost, strconv.Itoa(port))
}
