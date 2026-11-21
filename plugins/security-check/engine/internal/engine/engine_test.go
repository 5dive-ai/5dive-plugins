package engine

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/llm"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/report"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/store"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/testnet"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/tools"
)

func testScope() *scope.Scope {
	return &scope.Scope{RunID: "run-1", Targets: []scope.Target{{Kind: "ip", Value: "127.0.0.1"}}, HostNames: []string{"box.example.com"}, Depth: "shallow"}
}

// leakySite is a small web app with its .git folder exposed.
func leakySite(t *testing.T) (*httptest.Server, int) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.git/HEAD" {
			fmt.Fprint(w, "ref: refs/heads/main\n")
			return
		}
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, "<html>hello</html>")
	}))
	t.Cleanup(srv.Close)
	return srv, srv.Listener.Addr().(*net.TCPAddr).Port
}

func newConfig(t *testing.T, ports []int) (Config, *testnet.Recorder) {
	t.Helper()
	testnet.TrapDNS(t)
	rec := testnet.NewRecorder(t)
	s := testScope()
	st, err := store.Open(filepath.Join(t.TempDir(), "e.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return Config{
		Scope: s, Store: st, Approval: AutoSafe, MaxDuration: time.Minute, MaxTokens: 100000, Version: "test",
		Env: &tools.Env{
			Scope: s, Dial: scope.NewGuard(s, rec.Dial).DialContext, Ports: ports,
			ConnectTimeout: 500 * time.Millisecond, IOTimeout: 2 * time.Second,
		},
	}, rec
}

func findingChecks(rep *report.Report) map[string]model.Finding {
	m := map[string]model.Finding{}
	for _, f := range rep.Findings {
		m[f.ID[:strings.LastIndex(f.ID, "-")]] = f
	}
	return m
}

func assertOnlyLoopbackDialed(t *testing.T, rec *testnet.Recorder) {
	t.Helper()
	for _, a := range rec.Seen() {
		if !strings.HasPrefix(a, "127.0.0.1:") {
			t.Errorf("dialed outside scope: %q", a)
		}
	}
}

func TestDeterministicRunEndToEnd(t *testing.T) {
	_, port := leakySite(t)
	cfg, rec := newConfig(t, []int{port})
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if rep.StoppedReason != report.StopDone {
		t.Fatalf("stopped %s", rep.StoppedReason)
	}
	got := findingChecks(rep)
	for _, c := range []string{"open-ports", "git-exposed", "missing-safety-headers", "no-https"} {
		if _, ok := got[c]; !ok {
			t.Errorf("missing %s; got %v", c, rep.Findings)
		}
	}
	if rep.Summary.High != 1 {
		t.Errorf("summary %+v", rep.Summary)
	}
	ran := map[string]bool{}
	for _, a := range rep.Approvals {
		if a.Decision != "approved" {
			t.Errorf("denied in a clean run: %+v", a)
		}
		ran[a.Tool] = true
	}
	for _, want := range []string{"port_scan", "banner", "http_probe", "exposure_probe"} {
		if !ran[want] {
			t.Errorf("planner never ran %s", want)
		}
	}
	assertOnlyLoopbackDialed(t, rec)

	// The exploration graph: one goal, and every finding hangs off an intent.
	db := cfg.Store.DB()
	for kind, min := range map[string]int{"goal": 1, "intent": 4, "fact": 2, "finding": 4} {
		var n int
		_ = db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE run_id = 'run-1' AND kind = ?`, kind).Scan(&n)
		if n < min {
			t.Errorf("%d %s nodes, want >= %d", n, kind, min)
		}
	}
	var orphan int
	_ = db.QueryRow(`SELECT COUNT(*) FROM nodes f JOIN nodes p ON p.id = f.parent_id
		WHERE f.kind = 'finding' AND p.kind NOT IN ('intent','goal')`).Scan(&orphan)
	if orphan != 0 {
		t.Errorf("%d findings not under an intent", orphan)
	}
	var assets int
	_ = db.QueryRow(`SELECT COUNT(*) FROM assets`).Scan(&assets)
	if assets < 3 {
		t.Errorf("only %d assets", assets)
	}

	// DIVE-8921: every finding carries the traffic behind it, and the full trail is stored.
	for _, f := range rep.Findings {
		if len(f.Evidence) == 0 {
			t.Errorf("%s has no evidence", f.ID)
		}
		for _, e := range f.Evidence {
			if e.Target == "" || e.Request == "" || e.Response == "" {
				t.Errorf("%s evidence incomplete: %+v", f.ID, e)
			}
		}
	}
	if f := got["git-exposed"]; len(f.Evidence) != 1 || !strings.HasPrefix(f.Evidence[0].Request, "GET /.git/HEAD ") ||
		!strings.Contains(f.Evidence[0].Response, "ref: refs/heads/main") {
		t.Errorf("git-exposed evidence: %+v", f.Evidence)
	}
	plainAnswer := false
	for _, e := range got["no-https"].Evidence {
		plainAnswer = plainAnswer || (e.Proto == "http" && strings.HasPrefix(e.Response, "HTTP/1."))
		if tools.ConnectOnly(e) {
			t.Errorf("no-https evidence carries a bare connect beside real exchanges: %+v", e)
		}
	}
	if !plainAnswer {
		t.Errorf("no-https evidence should include the plain HTTP answer: %+v", got["no-https"].Evidence)
	}
	var traffic, stored int
	_ = db.QueryRow(`SELECT COUNT(*) FROM traffic t JOIN nodes n ON n.id = t.node_id WHERE t.run_id = 'run-1' AND n.kind = 'intent'`).Scan(&traffic)
	_ = db.QueryRow(`SELECT COUNT(*) FROM finding_evidence WHERE run_id = 'run-1'`).Scan(&stored)
	if traffic < 10 || stored != len(rep.Findings) {
		t.Errorf("stored %d exchanges under intents, %d finding evidence rows for %d findings", traffic, stored, len(rep.Findings))
	}
}

// DIVE-8908, prod check 3: a site answering plain HTTP on two ports is ONE
// unencrypted website, so one no-https finding per host, not one per port.
func TestNoHTTPSOncePerHost(t *testing.T) {
	_, p1 := leakySite(t)
	_, p2 := leakySite(t)
	cfg, _ := newConfig(t, []int{p1, p2})
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, f := range rep.Findings {
		if strings.HasPrefix(f.ID, "no-https-") {
			n++
			if f.Asset != "127.0.0.1" {
				t.Errorf("no-https asset %q, want the host", f.Asset)
			}
		}
	}
	if n != 1 {
		t.Errorf("%d no-https findings, want 1: %+v", n, rep.Findings)
	}
}

// sniOnlySite serves TLS only for the owner's domain, as every 5dive box does:
// a hello without that SNI gets alert 80.
func sniOnlySite(t *testing.T, name string) int {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html>hello</html>")
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	cert := srv.TLS.Certificates[0]
	srv.TLS.Certificates = nil
	srv.TLS.GetCertificate = func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if h.ServerName != name {
			return nil, fmt.Errorf("no certificate for %q", h.ServerName)
		}
		return &cert, nil
	}
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// DIVE-8908, prod check 3: the clone of a box with valid HTTPS for its domain was
// reported "not encrypted" because the bare-IP hello had no SNI. With plain HTTP
// on one port and SNI-only TLS on another, there is no no-https finding, and the
// certificate is checked under the owner's domain.
func TestSNIOnlyTLSIsNotReportedUnencrypted(t *testing.T) {
	_, plain := leakySite(t)
	tlsPort := sniOnlySite(t, "box.example.com")
	cfg, rec := newConfig(t, []int{plain, tlsPort})
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if f, ok := findingChecks(rep)["no-https"]; ok {
		t.Errorf("false no-https on an SNI-only TLS site: %+v", f)
	}
	sniProbed := false
	for _, a := range rep.Approvals {
		if a.Tool == "tls_probe" && a.Target == "127.0.0.1:"+strconv.Itoa(tlsPort) && a.Decision == "approved" {
			sniProbed = true
		}
	}
	if !sniProbed {
		t.Errorf("tls_probe never ran on the TLS port: %+v", rep.Approvals)
	}
	for _, f := range rep.Findings {
		if strings.Contains(f.Asset, "127.0.0.1:"+strconv.Itoa(tlsPort)) && !strings.Contains(f.Asset, "box.example.com") {
			t.Errorf("TLS-port finding not under the owner's domain: %+v", f)
		}
	}
	assertOnlyLoopbackDialed(t, rec)
}

func TestGateDeniesIntrusiveTools(t *testing.T) {
	s, cat := testScope(), tools.Catalog()
	guess := model.Intent{Tool: "ssh_password_guess", Target: "127.0.0.1:22"}
	for _, mode := range []string{AutoSafe, DenyAll} {
		if d := Gate(s, cat, mode, guess); d.Approved {
			t.Errorf("%s approved an intrusive tool", mode)
		}
	}
	probe := model.Intent{Tool: "ssh_probe", Target: "127.0.0.1:22"}
	if d := Gate(s, cat, AutoSafe, probe); !d.Approved {
		t.Errorf("auto-safe denied a safe probe: %s", d.Reason)
	}
	if d := Gate(s, cat, DenyAll, probe); d.Approved {
		t.Errorf("deny-all approved a probe")
	}
	if d := Gate(s, cat, AutoSafe, model.Intent{Tool: "rm_rf", Target: "127.0.0.1"}); d.Approved {
		t.Errorf("unknown tool approved")
	}
	if d := Gate(s, cat, AutoSafe, model.Intent{Tool: "port_scan", Target: "127.0.0.1:80"}); d.Approved {
		t.Errorf("port_scan with ip:port approved")
	}
}

// fakeLLM is an Anthropic-shaped provider that proposes the given intents.
func fakeLLM(t *testing.T, plan string, tokensPerCall int) *llm.Client {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"content":[{"type":"text","text":%q}],"stop_reason":"end_turn","usage":{"input_tokens":%d,"output_tokens":0}}`, plan, tokensPerCall)
	}))
	t.Cleanup(srv.Close)
	return llm.NewClient([]llm.Provider{{Kind: "anthropic", BaseURL: srv.URL, Model: "fake", APIKeyEnv: "K"}},
		func(string) string { return "key" })
}

// An LLM that proposes an out-of-scope IP, a host name as target, a foreign Host
// header and an intrusive tool gets every one refused and recorded, and nothing
// outside the scope is ever dialed or looked up.
func TestLLMOutOfScopeIntentsAreRefusedAndRecorded(t *testing.T) {
	_, port := leakySite(t)
	cfg, rec := newConfig(t, []int{port})
	p := strconv.Itoa(port)
	cfg.LLM = fakeLLM(t, `Sure. {"intents":[
		{"tool":"http_probe","target":"10.9.9.9:80","why":"x"},
		{"tool":"port_scan","target":"box.example.com","why":"x"},
		{"tool":"http_probe","target":"127.0.0.1:`+p+`","args":{"host":"live.example.net"},"why":"x"},
		{"tool":"ssh_password_guess","target":"127.0.0.1:22","why":"x"},
		{"tool":"http_probe","target":"127.0.0.1:`+p+`","args":{"scheme":"http","host":"box.example.com"},"why":"in scope"}
	],"done":false}`, 10)

	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	denied := map[string]string{}
	for _, a := range rep.Approvals {
		if a.Decision == "denied" {
			denied[a.Tool+" "+a.Target] = a.Reason
		}
	}
	for key, reason := range map[string]string{
		"http_probe 10.9.9.9:80":          "out of scope",
		"port_scan box.example.com":       "names are never resolved",
		"http_probe 127.0.0.1:" + p:       "live.example.net",
		"ssh_password_guess 127.0.0.1:22": "intrusive",
	} {
		if !strings.Contains(denied[key], reason) {
			t.Errorf("%s: denial %q, want it to mention %q", key, denied[key], reason)
		}
	}
	var stored int
	_ = cfg.Store.DB().QueryRow(`SELECT COUNT(*) FROM approvals WHERE decision = 'denied'`).Scan(&stored)
	if stored != len(denied) || stored != 4 {
		t.Errorf("%d denials in sqlite, %d in report, want 4", stored, len(denied))
	}
	if rep.Budget.TokensUsed == 0 {
		t.Errorf("LLM tokens not counted")
	}
	assertOnlyLoopbackDialed(t, rec)
}

func TestLLMFailureFallsBackToDeterministic(t *testing.T) {
	_, port := leakySite(t)
	cfg, _ := newConfig(t, []int{port})
	cfg.LLM = fakeLLM(t, "I'm sorry, but I can't help with that.", 7)
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := findingChecks(rep)["git-exposed"]; !ok {
		t.Fatalf("fallback planner missed the exposed .git: %v", rep.Findings)
	}
	if rep.Budget.TokensUsed != 7 {
		t.Errorf("tokens %d, want 7 (one refused call, then no more LLM calls)", rep.Budget.TokensUsed)
	}
}

func TestBudgetStops(t *testing.T) {
	_, port := leakySite(t)
	cfg, rec := newConfig(t, []int{port})
	cfg.MaxDuration = time.Nanosecond
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if rep.StoppedReason != report.StopBudgetTime || len(rec.Seen()) != 0 {
		t.Fatalf("stopped %s after %d dials", rep.StoppedReason, len(rec.Seen()))
	}

	cfg2, rec2 := newConfig(t, []int{port})
	cfg2.LLM = fakeLLM(t, `{"intents":[],"done":true}`, 500)
	cfg2.MaxTokens = 100
	rep, err = Run(context.Background(), cfg2)
	if err != nil {
		t.Fatal(err)
	}
	if rep.StoppedReason != report.StopBudgetTokens || rep.Budget.TokensUsed != 500 || len(rec2.Seen()) != 0 {
		t.Fatalf("stopped %s tokens %d dials %d", rep.StoppedReason, rep.Budget.TokensUsed, len(rec2.Seen()))
	}
	var reason string
	_ = cfg2.Store.DB().QueryRow(`SELECT stopped_reason FROM runs WHERE id = 'run-1'`).Scan(&reason)
	if reason != report.StopBudgetTokens {
		t.Errorf("runs.stopped_reason %q", reason)
	}
}

func TestScopeLockNamesTargetsAndRules(t *testing.T) {
	lock := ScopeLock(testScope())
	for _, want := range []string{"authorized", "127.0.0.1", "box.example.com", "never looked up", "read-only"} {
		if !strings.Contains(lock, want) {
			t.Errorf("scope lock lacks %q", want)
		}
	}
}

// DIVE-8917 Retest: a retest re-runs the baseline with no LLM, so it can only
// answer «fixed» for a finding the baseline reaches on its own. Every finding of
// a deterministic run is baseline; one the LLM opened the door to (a port only
// it probed), even when the baseline ran the later steps, is planner.
func TestFindingSourceFollowsTheWholeChain(t *testing.T) {
	_, portA := leakySite(t)
	_, portB := leakySite(t)
	cfg, rec := newConfig(t, []int{portA}) // the baseline only knows port A
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Findings) == 0 {
		t.Fatal("no findings")
	}
	for _, f := range rep.Findings {
		if f.Source != model.SourceBaseline {
			t.Errorf("deterministic run: %s has source %q, want baseline", f.ID, f.Source)
		}
	}

	cfg2, rec2 := newConfig(t, []int{portA})
	b := strconv.Itoa(portB)
	cfg2.LLM = fakeLLM(t, `{"intents":[{"tool":"banner","target":"127.0.0.1:`+b+`","why":"an uncommon port"}],"done":false}`, 10)
	rep2, err := Run(context.Background(), cfg2)
	if err != nil {
		t.Fatal(err)
	}
	src := map[string]string{} // git-exposed asset port -> source
	for _, f := range rep2.Findings {
		if strings.HasPrefix(f.ID, "git-exposed-") {
			for _, p := range []string{strconv.Itoa(portA), b} {
				if strings.Contains(f.Asset, ":"+p) {
					src[p] = f.Source
				}
			}
		}
		if strings.HasPrefix(f.ID, "no-https-") && f.Source != model.SourceBaseline {
			t.Errorf("no-https rests on baseline port %d too, got %q", portA, f.Source)
		}
	}
	if src[strconv.Itoa(portA)] != model.SourceBaseline {
		t.Errorf("port A finding: %q, want baseline (findings %+v)", src[strconv.Itoa(portA)], rep2.Findings)
	}
	if src[b] != model.SourcePlanner {
		t.Errorf("port B finding (LLM-opened): %q, want planner (findings %+v)", src[b], rep2.Findings)
	}
	assertOnlyLoopbackDialed(t, rec)
	assertOnlyLoopbackDialed(t, rec2)
}

// DIVE-8917: a retest scans a NEW clone with a new IP. The same site with the same
// holes, reached at two different IPs, must report the same finding ids, or a retest
// reads «fixed» for a problem that is still there.
func TestSameBoxAtTwoIPsGivesTheSameFindingIDs(t *testing.T) {
	ln, err := net.Listen("tcp", "0.0.0.0:0") // answers on 127.0.0.1 and 127.0.0.2
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.git/HEAD" {
			fmt.Fprint(w, "ref: refs/heads/main\n")
			return
		}
		fmt.Fprint(w, "<html>hello</html>")
	}))
	srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	port := ln.Addr().(*net.TCPAddr).Port

	ids := func(ip string) []string {
		cfg, _ := newConfig(t, []int{port})
		cfg.Scope.Targets = []scope.Target{{Kind: "ip", Value: ip}}
		rep, err := Run(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range rep.Findings {
			if !strings.Contains(f.Asset, ip) && f.ID[:strings.LastIndex(f.ID, "-")] != "open-ports" {
				t.Errorf("asset %q does not name the scanned IP %s", f.Asset, ip)
			}
			out = append(out, f.ID)
		}
		return out
	}
	a, b := ids("127.0.0.1"), ids("127.0.0.2")
	if len(a) < 3 {
		t.Fatalf("too few findings to compare: %v", a)
	}
	if strings.Join(a, ",") != strings.Join(b, ",") {
		t.Errorf("same box, different ids:\n 127.0.0.1 %v\n 127.0.0.2 %v", a, b)
	}
}

// DIVE-8925: two checks of the same server, each on a NEW clone with a new IP,
// sharing the server's database. The second check opened one more port: only
// that port (and what was found on it) is «new»; the first check says nothing,
// since on a server's first check everything would be.
func TestNewSinceLastCheckAcrossTwoClones(t *testing.T) {
	listen := func() int {
		ln, err := net.Listen("tcp", "0.0.0.0:0") // answers on 127.0.0.1 and 127.0.0.2
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/.git/HEAD" {
				fmt.Fprint(w, "ref: refs/heads/main\n")
				return
			}
			fmt.Fprint(w, "<html>hello</html>")
		}))
		srv.Listener.Close()
		srv.Listener = ln
		srv.Start()
		t.Cleanup(srv.Close)
		return ln.Addr().(*net.TCPAddr).Port
	}
	old, added := listen(), listen()

	cfg, _ := newConfig(t, []int{old})
	check := func(runID, ip string, ports []int) *report.Report {
		cfg.Scope.RunID = runID
		cfg.Scope.Targets = []scope.Target{{Kind: "ip", Value: ip}}
		cfg.Env.Ports = ports
		rep, err := Run(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		return rep
	}

	first := check("run-1", "127.0.0.1", []int{old})
	if first.Changes != nil {
		t.Fatalf("first check compares with nothing, got %+v", first.Changes)
	}
	for _, f := range first.Findings {
		if f.New {
			t.Errorf("first check marks %s new", f.ID)
		}
	}

	second := check("run-2", "127.0.0.2", []int{old, added})
	c := second.Changes
	if c == nil || c.EarlierRuns != 1 || !strings.HasPrefix(c.Since, strings.TrimSuffix(first.StartedAt, "Z")) {
		t.Fatalf("second check: changes %+v", c)
	}
	addedPort := fmt.Sprintf("server:%d/tcp", added)
	var keys []string
	for _, a := range c.NewAssets {
		keys = append(keys, a.Kind+" "+a.Key)
		if strings.Contains(a.Key, "127.0.0.") {
			t.Errorf("new asset keyed on the clone IP: %+v", a)
		}
		if strings.Contains(a.Key, fmt.Sprintf(":%d", old)) {
			t.Errorf("the port both checks saw reads as new: %+v", a)
		}
	}
	if !strings.Contains(strings.Join(keys, ","), "port "+addedPort) {
		t.Errorf("new assets %v miss %s", keys, addedPort)
	}
	newCount := 0
	for _, f := range second.Findings {
		onAdded := strings.Contains(f.Asset, fmt.Sprintf(":%d", added))
		if onAdded && !f.New {
			t.Errorf("finding on the added port not marked new: %s %s", f.ID, f.Asset)
		}
		if strings.Contains(f.Asset, fmt.Sprintf(":%d", old)) && f.New {
			t.Errorf("finding on the old port marked new: %s %s", f.ID, f.Asset)
		}
		if f.New {
			newCount++
		}
	}
	if newCount == 0 || newCount != c.NewFindings {
		t.Errorf("new findings: %d marked, summary says %d", newCount, c.NewFindings)
	}
}

// drainAt closes drain the first time the run logs a line containing mark.
type drainAt struct {
	mark  string
	drain chan struct{}
	once  sync.Once
}

func (d *drainAt) Write(p []byte) (int, error) {
	if strings.Contains(string(p), d.mark) {
		d.once.Do(func() { close(d.drain) })
	}
	return len(p), nil
}

// A drain lets the running step finish, starts nothing after it, and keeps
// what that step found in a report that says "stopped" (DIVE-8940).
func TestDrainStopsAndKeepsWhatItFound(t *testing.T) {
	_, port := leakySite(t)
	cfg, _ := newConfig(t, []int{port})
	d := &drainAt{mark: "step 1: run port_scan", drain: make(chan struct{})}
	cfg.Drain, cfg.Log = d.drain, d
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if rep.StoppedReason != report.StopStopped {
		t.Fatalf("stopped %q, want %q", rep.StoppedReason, report.StopStopped)
	}
	if len(rep.Approvals) != 1 || rep.Approvals[0].Tool != "port_scan" {
		t.Fatalf("steps after the drain: %+v", rep.Approvals)
	}
	got := findingChecks(rep)
	if _, ok := got["open-ports"]; !ok {
		t.Errorf("the running step's result was dropped: %v", rep.Findings)
	}
	if _, ok := got["git-exposed"]; ok {
		t.Errorf("a step ran after the drain: %v", rep.Findings)
	}
	if md := report.Markdown(rep); !strings.Contains(md, "was stopped before it finished") {
		t.Errorf("report.md does not say it was stopped:\n%s", md)
	}
}

// A step that would run long (a deep sweep of every port) is cancelled once
// the drain's grace is up, and a cut sweep never claims no port answered.
func TestDrainCancelsARunningStepAfterItsGrace(t *testing.T) {
	cfg, _ := newConfig(t, []int{1, 2, 3, 4, 5, 6, 7, 8})
	hang := func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	cfg.Env.Dial = scope.NewGuard(cfg.Scope, hang).DialContext
	cfg.Env.ConnectTimeout = 20 * time.Second
	d := &drainAt{mark: "step 1: run port_scan", drain: make(chan struct{})}
	cfg.Drain, cfg.Log, cfg.DrainGrace = d.drain, d, 100*time.Millisecond
	start := time.Now()
	rep, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("drain took %s; the grace did not cancel the running step", took)
	}
	if rep.StoppedReason != report.StopStopped {
		t.Fatalf("stopped %q", rep.StoppedReason)
	}
	if _, ok := findingChecks(rep)["no-open-ports"]; ok {
		t.Errorf("a cut sweep claimed no port answered: %v", rep.Findings)
	}
}
