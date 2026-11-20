package scope_test

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/testnet"
)

func writeScope(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "scope.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadRefusesBadScopes(t *testing.T) {
	cases := map[string]string{
		"empty file":      ``,
		"not json":        `nope`,
		"no run id":       `{"targets":[{"kind":"ip","value":"203.0.113.7"}]}`,
		"no targets":      `{"run_id":"r1","targets":[]}`,
		"hostname target": `{"run_id":"r1","targets":[{"kind":"ip","value":"box.example.com"}]}`,
		"domain kind":     `{"run_id":"r1","targets":[{"kind":"domain","value":"box.example.com"}]}`,
		"cidr":            `{"run_id":"r1","targets":[{"kind":"ip","value":"203.0.113.0/24"}]}`,
		"unspecified":     `{"run_id":"r1","targets":[{"kind":"ip","value":"0.0.0.0"}]}`,
		"bad host name":   `{"run_id":"r1","targets":[{"kind":"ip","value":"203.0.113.7"}],"host_names":["evil.com:443"]}`,
		"deep depth":      `{"run_id":"r1","targets":[{"kind":"ip","value":"203.0.113.7"}],"depth":"deep"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := scope.Load(writeScope(t, body))
			if !errors.Is(err, scope.ErrRefused) {
				t.Fatalf("want ErrRefused, got %v", err)
			}
		})
	}
	if _, err := scope.Load(filepath.Join(t.TempDir(), "missing.json")); !errors.Is(err, scope.ErrRefused) {
		t.Fatalf("missing file: want ErrRefused, got %v", err)
	}
}

func TestLoadAcceptsContractExample(t *testing.T) {
	s, err := scope.Load(writeScope(t, `{"run_id":"str","owner":{"server_id":123,"domain":"box.example.com"},
		"targets":[{"kind":"ip","value":"203.0.113.7"}],"host_names":["box.example.com"],"depth":"shallow"}`))
	if err != nil {
		t.Fatal(err)
	}
	if s.Owner.ServerID != 123 || len(s.IPs()) != 1 || !s.AllowsHostName("BOX.example.com") {
		t.Fatalf("parsed wrong: %+v", s)
	}
}

func testScope() *scope.Scope {
	return &scope.Scope{RunID: "r", Targets: []scope.Target{{Kind: "ip", Value: "127.0.0.1"}}, HostNames: []string{"box.example.com"}}
}

// A host name is refused by the Guard and never reaches the dialer or a resolver.
func TestGuardNeverResolvesNames(t *testing.T) {
	testnet.TrapDNS(t)
	rec := testnet.NewRecorder(t)
	g := scope.NewGuard(testScope(), rec.Dial)
	for _, addr := range []string{"box.example.com:443", "localhost:22", "[box.example.com]:80"} {
		if _, err := g.DialContext(context.Background(), "tcp", addr); !errors.Is(err, scope.ErrRefused) {
			t.Errorf("%s: want ErrRefused, got %v", addr, err)
		}
	}
	if seen := rec.Seen(); len(seen) != 0 {
		t.Fatalf("dialer was called: %v", seen)
	}
	// The default dialer (no seam) refuses names too, with DNS trapped.
	if _, err := scope.NewGuard(testScope(), nil).DialContext(context.Background(), "tcp", "box.example.com:80"); !errors.Is(err, scope.ErrRefused) {
		t.Fatalf("default guard: want ErrRefused, got %v", err)
	}
}

func TestGuardRefusesOutOfScopeIP(t *testing.T) {
	rec := testnet.NewRecorder(t)
	g := scope.NewGuard(testScope(), rec.Dial)
	for _, addr := range []string{"127.0.0.2:80", "10.0.0.1:22", "[::1]:80"} {
		if _, err := g.DialContext(context.Background(), "tcp", addr); !errors.Is(err, scope.ErrRefused) {
			t.Errorf("%s: want ErrRefused, got %v", addr, err)
		}
	}
	if _, err := g.DialContext(context.Background(), "udp", "127.0.0.1:53"); !errors.Is(err, scope.ErrRefused) {
		t.Errorf("udp: want ErrRefused, got %v", err)
	}
	if seen := rec.Seen(); len(seen) != 0 {
		t.Fatalf("dialer was called: %v", seen)
	}
}

func TestGuardDialsInScopeIP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	rec := testnet.NewRecorder(t)
	c, err := scope.NewGuard(testScope(), rec.Dial).DialContext(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if seen := rec.Seen(); len(seen) != 1 || seen[0] != ln.Addr().String() {
		t.Fatalf("seen %v", seen)
	}
}
