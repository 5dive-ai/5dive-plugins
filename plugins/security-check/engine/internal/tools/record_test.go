package tools

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

// recordingEnv is testEnv with the worker's traffic recorder wired in, as the engine does.
func recordingEnv(t *testing.T) *Env {
	env, _ := testEnv(t)
	env.Rec = NewRecorder()
	env.Dial = env.Rec.Dial(env.Dial)
	return env
}

func TestRedactMasksCredentialValues(t *testing.T) {
	in := strings.Join([]string{
		"APP_KEY=base64:abc",
		"export DB_PASSWORD=hunter2",
		"define('DB_PASSWORD', 's3cr3t');",
		`{"api_token": "tok-123", "name": "shop"}`,
		"Set-Cookie: session=abc123; Path=/",
		"Authorization: Bearer xyz",
		"HTTP/1.1 200 OK",
		"Content-Type: text/plain",
	}, "\n")
	out := Redact(in)
	for _, secret := range []string{"base64:abc", "hunter2", "s3cr3t", "tok-123", "abc123", "Bearer xyz"} {
		if strings.Contains(out, secret) {
			t.Errorf("%q survived redaction:\n%s", secret, out)
		}
	}
	for _, keep := range []string{"APP_KEY=", "DB_PASSWORD", `"name": "shop"`, "HTTP/1.1 200 OK", "Content-Type: text/plain", "Set-Cookie: "} {
		if !strings.Contains(out, keep) {
			t.Errorf("redaction lost %q:\n%s", keep, out)
		}
	}
}

// Every exposure finding carries the exact GET and the answer, with the leaked
// secrets masked: the recording must never copy the owner's passwords into the report.
func TestExposureFindingCarriesMaskedExchange(t *testing.T) {
	env := recordingEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.env" {
			fmt.Fprint(w, "APP_KEY=base64:abc\nDB_PASSWORD=hunter2\n")
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	res, err := exposureProbe(context.Background(), env, model.Intent{Tool: "exposure_probe", Target: hostPort(t, srv.URL), Args: map[string]string{"scheme": "http", "host": "box.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	f, ok := checks(res.Findings)["env-exposed"]
	if !ok || len(f.Evidence) != 1 {
		t.Fatalf("env finding / evidence: %+v", res.Findings)
	}
	ev := f.Evidence[0]
	if ev.Proto != "http" || !strings.HasPrefix(ev.Request, "GET /.env HTTP/1.1\r\nHost: box.example.com") {
		t.Errorf("request evidence: %+v", ev)
	}
	if !strings.HasPrefix(ev.Response, "HTTP/1.1 200 OK") || !strings.Contains(ev.Response, "DB_PASSWORD="+Hidden) {
		t.Errorf("response evidence: %q", ev.Response)
	}
	for _, s := range []string{ev.Response, f.Proof} {
		if strings.Contains(s, "hunter2") || strings.Contains(s, "base64:abc") {
			t.Errorf("secret copied into the finding: %q", s)
		}
	}
}

// HTTPS evidence is the request and response, recorded above TLS, not ciphertext.
func TestHTTPSProbeEvidenceIsPlaintext(t *testing.T) {
	env := recordingEnv(t)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", "nginx/1.14.0")
		fmt.Fprint(w, "ok")
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	defer srv.Close()
	res, err := httpProbe(context.Background(), env, model.Intent{Tool: "http_probe", Target: hostPort(t, srv.URL), Args: map[string]string{"scheme": "https"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Findings) == 0 {
		t.Fatal("no findings")
	}
	for _, f := range res.Findings {
		if len(f.Evidence) != 1 {
			t.Fatalf("%s evidence %+v", f.ID, f.Evidence)
		}
		ev := f.Evidence[0]
		if ev.Proto != "https" || !strings.HasPrefix(ev.Request, "GET / HTTP/1.1") || !strings.Contains(ev.Response, "Server: nginx/1.14.0") {
			t.Errorf("%s evidence not plaintext HTTPS: %+v", f.ID, ev)
		}
	}
	if all := env.Rec.Exchanges(); len(all) != 1 {
		t.Errorf("the TLS carrier was recorded too: %+v", all)
	}
}

func TestRenderBinaryAndEmpty(t *testing.T) {
	if got := render(nil, 0, 100, "nothing sent, connect only"); got != "(nothing sent, connect only)" {
		t.Errorf("empty: %q", got)
	}
	hello := []byte{0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x03}
	if got := render(hello, 300, 100, ""); !strings.HasPrefix(got, "[300 bytes, binary] 16 03 01") {
		t.Errorf("binary: %q", got)
	}
	if sniff("tcp", hello) != "tls" || sniff("tcp", []byte("HEAD / HTTP/1.0\r\n\r\n")) != "http" || sniff("tcp", []byte("SSH-2.0-x")) != "tcp" {
		t.Error("sniff names connections wrongly")
	}
}
