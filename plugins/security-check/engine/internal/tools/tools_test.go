package tools

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/testnet"
)

func testEnv(t *testing.T) (*Env, *testnet.Recorder) {
	t.Helper()
	testnet.TrapDNS(t)
	rec := testnet.NewRecorder(t)
	s := &scope.Scope{RunID: "t", Targets: []scope.Target{{Kind: "ip", Value: "127.0.0.1"}}, HostNames: []string{"box.example.com", "owner.invalid"}}
	return &Env{
		Scope: s, Dial: scope.NewGuard(s, rec.Dial).DialContext,
		ConnectTimeout: 500 * time.Millisecond, IOTimeout: 2 * time.Second,
	}, rec
}

func hostPort(t *testing.T, rawURL string) string {
	t.Helper()
	return strings.TrimPrefix(strings.TrimPrefix(rawURL, "http://"), "https://")
}

func checks(fs []model.Finding) map[string]model.Finding {
	m := map[string]model.Finding{}
	for _, f := range fs {
		m[f.ID[:strings.LastIndex(f.ID, "-")]] = f
	}
	return m
}

// A site that answers 200 with its app page for every path must produce no
// exposure findings: each check reads the content, not just the status.
func TestExposureProbeIgnoresCatchAll200(t *testing.T) {
	env, _ := testEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<!doctype html><html><head><title>My App</title></head><body>DB_PASSWORD ref: refs/heads/main PHP Version</body></html>")
	}))
	defer srv.Close()
	res, err := exposureProbe(context.Background(), env, model.Intent{Tool: "exposure_probe", Target: hostPort(t, srv.URL), Args: map[string]string{"scheme": "http"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Findings) != 0 {
		t.Fatalf("false positives on a catch-all site: %+v", res.Findings)
	}
}

func TestExposureProbeFindsRealLeaks(t *testing.T) {
	env, rec := testEnv(t)
	var hosts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hosts = append(hosts, r.Host)
		switch r.URL.Path {
		case "/.git/HEAD":
			fmt.Fprint(w, "ref: refs/heads/main\n")
		case "/.env":
			fmt.Fprint(w, "APP_KEY=base64:abc\nDB_PASSWORD=hunter2\n")
		case "/uploads/":
			fmt.Fprint(w, "<html><head><title>Index of /uploads</title></head></html>")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	res, err := exposureProbe(context.Background(), env, model.Intent{Tool: "exposure_probe", Target: hostPort(t, srv.URL), Args: map[string]string{"scheme": "http", "host": "box.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	got := checks(res.Findings)
	for _, c := range []string{"git-exposed", "env-exposed", "dir-listing"} {
		if _, ok := got[c]; !ok {
			t.Errorf("missing %s finding; got %v", c, res.Findings)
		}
	}
	if len(got) != 3 {
		t.Errorf("want exactly 3 findings, got %d: %v", len(got), res.Findings)
	}
	if got["env-exposed"].Severity != model.Critical {
		t.Errorf(".env should be critical")
	}
	for _, h := range hosts {
		if !strings.HasPrefix(h, "box.example.com") {
			t.Errorf("Host header %q, want the scope host name", h)
		}
	}
	for _, a := range rec.Seen() {
		if !strings.HasPrefix(a, "127.0.0.1:") {
			t.Errorf("dialed %q", a)
		}
	}
}

func TestHTTPProbeHeadersAndVersionLeak(t *testing.T) {
	env, _ := testEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", "nginx/1.14.0")
		w.Header().Set("X-Powered-By", "PHP/7.4.3")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fmt.Fprint(w, "ok")
	}))
	defer srv.Close()
	res, err := httpProbe(context.Background(), env, model.Intent{Tool: "http_probe", Target: hostPort(t, srv.URL), Args: map[string]string{"scheme": "http", "host": "box.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	got := checks(res.Findings)
	for _, c := range []string{"version-leak", "missing-safety-headers", "outdated-nginx", "outdated-php"} {
		if _, ok := got[c]; !ok {
			t.Errorf("missing %s; got %+v", c, res.Findings)
		}
	}
	if p := got["missing-safety-headers"].Proof; strings.Contains(p, "X-Content-Type-Options") || !strings.Contains(p, "Content-Security-Policy") {
		t.Errorf("headers proof wrong: %s", p)
	}
	if fix := got["missing-safety-headers"].Fix; strings.Contains(fix, "nosniff") || !strings.Contains(fix, "Content-Security-Policy") || strings.Contains(fix, "Strict-Transport-Security") {
		t.Errorf("fix must name only the missing headers (no HSTS on http): %s", fix)
	}
	if len(res.Facts) != 1 || res.Facts[0].Data["server"] != "nginx/1.14.0" {
		t.Errorf("facts: %+v", res.Facts)
	}
}

// secureHeaders sets every browser safety header the check looks for.
func secureHeaders(w http.ResponseWriter) {
	w.Header().Set("Strict-Transport-Security", "max-age=31536000")
	w.Header().Set("Content-Security-Policy", "object-src 'none'")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func headersProbe(t *testing.T, env *Env, rawURL, scheme string) []model.Finding {
	t.Helper()
	res, err := httpProbe(context.Background(), env, model.Intent{Tool: "http_probe", Target: hostPort(t, rawURL), Args: map[string]string{"scheme": scheme, "host": "box.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	return res.Findings
}

// Caddy's automatic port-80 answer is a bare 308 to https. No browser renders it,
// so it is never graded: the https page gets its own probe (DIVE-8956).
func TestHTTPProbeNeverGradesTheHTTPSRedirect(t *testing.T) {
	env, rec := testEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "https://box.example.com/")
		w.WriteHeader(http.StatusPermanentRedirect)
	}))
	defer srv.Close()
	if f, ok := checks(headersProbe(t, env, srv.URL, "http"))["missing-safety-headers"]; ok {
		t.Fatalf("graded the redirect: %+v", f)
	}
	if n := len(rec.Seen()); n != 1 {
		t.Errorf("want one dial (the redirect is not followed off the port), got %d: %v", n, rec.Seen())
	}
}

// Headers on the https site, as the advice says, clear the finding; an https site
// without them gets it, and the advice names each missing header.
func TestHTTPProbeGradesTheHTTPSPage(t *testing.T) {
	env, _ := testEnv(t)
	set := true
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if set {
			secureHeaders(w)
		}
		fmt.Fprint(w, "ok")
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	defer srv.Close()
	if f, ok := checks(headersProbe(t, env, srv.URL, "https"))["missing-safety-headers"]; ok {
		t.Fatalf("flagged a site that sends every header: %+v", f)
	}
	set = false
	f, ok := checks(headersProbe(t, env, srv.URL, "https"))["missing-safety-headers"]
	if !ok {
		t.Fatal("no finding on an https site without headers")
	}
	for _, h := range []string{"Strict-Transport-Security", "Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options"} {
		if !strings.Contains(f.Fix, h) || !strings.Contains(f.Proof, h) {
			t.Errorf("%s missing from fix or proof:\nfix: %s\nproof: %s", h, f.Fix, f.Proof)
		}
	}
}

// A redirect that stays on the site (/ -> /login) is followed: the login page is
// what a browser shows, so its headers are the ones graded.
func TestHTTPProbeFollowsSameSiteRedirect(t *testing.T) {
	env := recordingEnv(t)
	secure := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		if secure {
			secureHeaders(w)
		}
		fmt.Fprint(w, "login")
	}))
	defer srv.Close()
	f, ok := checks(headersProbe(t, env, srv.URL, "http"))["missing-safety-headers"]
	if !ok {
		t.Fatal("the login page has no headers but no finding")
	}
	if !strings.Contains(f.Proof, "GET / -> 302; GET /login -> 200") || len(f.Evidence) != 2 {
		t.Errorf("proof/evidence should show both hops: %s (%d exchanges)", f.Proof, len(f.Evidence))
	}
	secure = true
	if f, ok := checks(headersProbe(t, env, srv.URL, "http"))["missing-safety-headers"]; ok {
		t.Errorf("login page sends every header, still flagged: %+v", f)
	}
}

// A redirect to another site is neither graded nor followed.
func TestHTTPProbeStopsAtForeignRedirect(t *testing.T) {
	env, rec := testEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://elsewhere.example.net/", http.StatusFound)
	}))
	defer srv.Close()
	if f, ok := checks(headersProbe(t, env, srv.URL, "http"))["missing-safety-headers"]; ok {
		t.Fatalf("graded a redirect to another site: %+v", f)
	}
	if n := len(rec.Seen()); n != 1 {
		t.Errorf("want one dial, got %d: %v", n, rec.Seen())
	}
}

func TestHTTPProbeRefusesForeignHostArg(t *testing.T) {
	env, rec := testEnv(t)
	_, err := httpProbe(context.Background(), env, model.Intent{Tool: "http_probe", Target: "127.0.0.1:80", Args: map[string]string{"host": "evil.example.net"}})
	if err == nil || len(rec.Seen()) != 0 {
		t.Fatalf("want refusal before any dial, got err=%v dials=%v", err, rec.Seen())
	}
}

func TestTLSProbeSelfSignedAndNameMismatch(t *testing.T) {
	env, _ := testEnv(t)
	srv := quietTLSServer()
	defer srv.Close()
	// The httptest certificate covers example.com and *.example.com, not owner.invalid.
	res, err := tlsProbe(context.Background(), env, model.Intent{Tool: "tls_probe", Target: hostPort(t, srv.URL), Args: map[string]string{"sni": "owner.invalid"}})
	if err != nil {
		t.Fatal(err)
	}
	got := checks(res.Findings)
	for _, c := range []string{"cert-untrusted", "cert-name-mismatch"} {
		if _, ok := got[c]; !ok {
			t.Errorf("missing %s; got %+v", c, res.Findings)
		}
	}
	if _, ok := got["cert-expired"]; ok {
		t.Errorf("fresh test cert reported expired")
	}
	// Pretend it is 2090: the httptest cert (valid to 2084) is now expired.
	defer func(f func() time.Time) { now = f }(now)
	now = func() time.Time { return time.Date(2090, 1, 1, 0, 0, 0, 0, time.UTC) }
	res, err = tlsProbe(context.Background(), env, model.Intent{Tool: "tls_probe", Target: hostPort(t, srv.URL)})
	if err != nil {
		t.Fatal(err)
	}
	if f, ok := checks(res.Findings)["cert-expired"]; !ok || f.Severity != model.High {
		t.Errorf("want high cert-expired, got %+v", res.Findings)
	}
}

// quietTLSServer is an httptest TLS server that does not log the handshakes the
// probes cut short on purpose.
func quietTLSServer() *httptest.Server {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	return srv
}

// fakeSSH serves the SSH handshake and offers password login.
func fakeSSH(t *testing.T, offerPassword bool) (string, *bool) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	gotPassword := new(bool)
	cfg := &ssh.ServerConfig{ServerVersion: "SSH-2.0-OpenSSH_7.6p1 Ubuntu-4"}
	cfg.PublicKeyCallback = func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, fmt.Errorf("no") }
	if offerPassword {
		cfg.PasswordCallback = func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) {
			*gotPassword = true
			return nil, fmt.Errorf("no")
		}
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _, _, _ = ssh.NewServerConn(c, cfg)
			}()
		}
	}()
	return ln.Addr().String(), gotPassword
}

func TestSSHProbeSeesPasswordLoginWithoutSendingOne(t *testing.T) {
	env, _ := testEnv(t)
	addr, gotPassword := fakeSSH(t, true)
	res, err := sshProbe(context.Background(), env, model.Intent{Tool: "ssh_probe", Target: addr})
	if err != nil {
		t.Fatal(err)
	}
	got := checks(res.Findings)
	if f, ok := got["ssh-password-login"]; !ok || f.Severity != model.Medium {
		t.Errorf("want ssh-password-login; got %+v", res.Findings)
	}
	if _, ok := got["outdated-openssh"]; !ok {
		t.Errorf("OpenSSH 7.6 should be flagged old; got %+v", res.Findings)
	}
	if *gotPassword {
		t.Fatal("the probe sent a password")
	}

	addr, _ = fakeSSH(t, false)
	res, err = sshProbe(context.Background(), env, model.Intent{Tool: "ssh_probe", Target: addr})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := checks(res.Findings)["ssh-password-login"]; ok {
		t.Errorf("key-only server reported as password login")
	}
}

func TestBannerTellsProtocolsApart(t *testing.T) {
	env, _ := testEnv(t)
	sshAddr, _ := fakeSSH(t, false)
	httpSrv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer httpSrv.Close()
	tlsSrv := quietTLSServer()
	defer tlsSrv.Close()
	for want, target := range map[string]string{"ssh": sshAddr, "http": hostPort(t, httpSrv.URL), "tls": hostPort(t, tlsSrv.URL)} {
		res, err := bannerGrab(context.Background(), env, model.Intent{Tool: "banner", Target: target})
		if err != nil {
			t.Fatal(err)
		}
		if got := res.Facts[0].Data["proto"]; got != want {
			t.Errorf("%s: proto %q, want %q", target, got, want)
		}
	}
}

// sniOnlyTLSServer serves TLS only for name, like a 5dive box: a hello without
// that SNI gets alert 80 (internal_error), or, when drop is set, a closed
// connection with no answer at all.
func sniOnlyTLSServer(t *testing.T, name string, drop bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	cert := srv.TLS.Certificates[0]
	srv.TLS.Certificates = nil
	srv.TLS.GetConfigForClient = func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		if h.ServerName != name && drop {
			h.Conn.Close()
			return nil, fmt.Errorf("no site for %q", h.ServerName)
		}
		return nil, nil
	}
	srv.TLS.GetCertificate = func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if h.ServerName != name {
			return nil, fmt.Errorf("no certificate for %q", h.ServerName)
		}
		return &cert, nil
	}
	t.Cleanup(srv.Close)
	return srv
}

// DIVE-8908: a TLS port that serves only the owner's domain is TLS, whether a
// no-SNI hello gets an alert or is dropped. Before, both fell through to the
// plain-HTTP HEAD and the port was reported as an unencrypted website.
func TestBannerSeesSNIOnlyTLS(t *testing.T) {
	env, _ := testEnv(t)
	for _, drop := range []bool{false, true} {
		srv := sniOnlyTLSServer(t, "box.example.com", drop)
		target := hostPort(t, srv.URL)
		if err := tlsHello(context.Background(), env, target, ""); err == nil {
			t.Fatalf("drop=%v: fixture answered a no-SNI hello; it must refuse it", drop)
		} else if isTLSAlert(err) == drop {
			t.Fatalf("drop=%v: no-SNI hello error %v, alert=%v", drop, err, isTLSAlert(err))
		}
		res, err := bannerGrab(context.Background(), env, model.Intent{Tool: "banner", Target: target})
		if err != nil {
			t.Fatal(err)
		}
		if got := res.Facts[0].Data["proto"]; got != "tls" {
			t.Errorf("drop=%v: proto %q, want tls", drop, got)
		}
	}
}

// nginx answers plain HTTP on a TLS listener with a 400 that names the cause.
func TestBannerReadsNginxPlainHTTPOnTLSPort(t *testing.T) {
	env, _ := testEnv(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				buf := make([]byte, 1)
				if _, err := c.Read(buf); err != nil || buf[0] == 0x16 {
					return // a TLS hello: hang up without an alert
				}
				io.WriteString(c, "HTTP/1.1 400 Bad Request\r\nServer: nginx\r\n\r\n<center>The plain HTTP request was sent to HTTPS port</center>")
			}()
		}
	}()
	res, err := bannerGrab(context.Background(), env, model.Intent{Tool: "banner", Target: ln.Addr().String()})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Facts[0].Data["proto"]; got != "tls" {
		t.Errorf("proto %q, want tls", got)
	}
}

func TestPortScanFlagsDatabasePort(t *testing.T) {
	env, _ := testEnv(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	riskyPorts[port] = riskyPorts[5432] // the listener stands in for PostgreSQL
	defer delete(riskyPorts, port)
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	closedPort := closed.Addr().(*net.TCPAddr).Port
	closed.Close()
	env.Ports = []int{port, closedPort}

	res, err := portScan(context.Background(), env, model.Intent{Tool: "port_scan", Target: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Facts) != 1 || res.Facts[0].Target != ln.Addr().String() {
		t.Fatalf("facts %+v", res.Facts)
	}
	f, ok := checks(res.Findings)["open-risky-port"]
	if !ok || f.Severity != model.High || !strings.Contains(f.Title, "PostgreSQL") {
		t.Fatalf("want high PostgreSQL finding, got %+v", res.Findings)
	}
}

func TestParseNmapXML(t *testing.T) {
	raw := `<?xml version="1.0"?><nmaprun><host><address addr="127.0.0.1" addrtype="ipv4"/><ports>
<port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="9.6p1 Ubuntu 3ubuntu13.5"/></port>
<port protocol="tcp" portid="80"><state state="open"/><service name="http" product="Apache httpd" version="2.4.18"/></port>
<port protocol="tcp" portid="81"><state state="closed"/></port>
</ports></host></nmaprun>`
	res, err := parseNmapXML([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Facts) != 2 || res.Facts[0].Data["product"] != "OpenSSH 9.6p1 Ubuntu 3ubuntu13.5" {
		t.Fatalf("facts %+v", res.Facts)
	}
	got := checks(res.Findings)
	if _, ok := got["outdated-apache"]; !ok {
		t.Errorf("Apache 2.4.18 should be flagged; got %+v", res.Findings)
	}
	if _, ok := got["outdated-openssh"]; ok {
		t.Errorf("OpenSSH 9.6 flagged as old")
	}
}

func TestTLSProbeFlagsOldVersions(t *testing.T) {
	env, _ := testEnv(t)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{MinVersion: tls.VersionTLS10}
	srv.StartTLS()
	defer srv.Close()
	res, err := tlsProbe(context.Background(), env, model.Intent{Tool: "tls_probe", Target: hostPort(t, srv.URL)})
	if err != nil {
		t.Fatal(err)
	}
	got := checks(res.Findings)
	for _, c := range []string{"old-tls-tls1.0", "old-tls-tls1.1"} {
		if _, ok := got[c]; !ok {
			t.Errorf("missing %s; got %+v", c, res.Findings)
		}
	}
	// The default server (TLS 1.2+) must not be flagged.
	modern := quietTLSServer()
	defer modern.Close()
	res, err = tlsProbe(context.Background(), env, model.Intent{Tool: "tls_probe", Target: hostPort(t, modern.URL)})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range res.Findings {
		if strings.HasPrefix(f.ID, "old-tls") {
			t.Errorf("modern server flagged: %s", f.ID)
		}
	}
}
