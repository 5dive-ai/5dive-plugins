package tools

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"regexp"
	"sync"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
)

// Recorder is the engine's traffic-recording proxy (DIVE-8921). The engine gives
// each worker its own Recorder and routes the worker's dialer through it, so every
// connection a probe opens is kept: what was sent and what came back. Our probes
// are in-process, so HTTPS is recorded as plaintext above the TLS layer, with no
// interception CA. Secrets in the recording are masked before it leaves here.
type Recorder struct {
	mu    sync.Mutex
	convs []*conv
}

// NewRecorder returns an empty recorder.
func NewRecorder() *Recorder { return &Recorder{} }

// Bytes kept per direction of one connection, and how much of each side an
// exchange shows.
const (
	captureCap  = 16 << 10
	maxRequest  = 1024
	maxResponse = 2048
)

type conv struct {
	r             *Recorder
	mu            sync.Mutex
	proto, target string
	out, in       []byte
	sent, got     int
	carrier       bool            // a TLS session recorded above it carries the meaning
	fixed         *model.Exchange // an exchange added whole (Add)
}

func (c *conv) keep(dst *[]byte, total *int, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	*total += len(b)
	if room := captureCap - len(*dst); room > 0 {
		if len(b) > room {
			b = b[:room]
		}
		*dst = append(*dst, b...)
	}
}

type recConn struct {
	net.Conn
	c *conv
}

func (rc *recConn) Read(b []byte) (int, error) {
	n, err := rc.Conn.Read(b)
	rc.c.keep(&rc.c.in, &rc.c.got, b[:n])
	return n, err
}

func (rc *recConn) Write(b []byte) (int, error) {
	n, err := rc.Conn.Write(b)
	rc.c.keep(&rc.c.out, &rc.c.sent, b[:n])
	return n, err
}

func (r *Recorder) wrap(c net.Conn, proto, target string) net.Conn {
	cv := &conv{r: r, proto: proto, target: target}
	r.mu.Lock()
	r.convs = append(r.convs, cv)
	r.mu.Unlock()
	return &recConn{Conn: c, c: cv}
}

// Dial routes dial through the recorder.
func (r *Recorder) Dial(dial scope.DialFunc) scope.DialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return r.wrap(c, "tcp", address), nil
	}
}

// Add records an exchange that did not go through the dialer (nmap's run).
func (r *Recorder) Add(e model.Exchange) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.convs = append(r.convs, &conv{fixed: &e})
	r.mu.Unlock()
}

// Mark and Since bracket one sequential step: Since(Mark()) is what the step sent.
func (r *Recorder) Mark() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.convs)
}

// Since returns the exchanges recorded after mark, in the order they started.
func (r *Recorder) Since(mark int) []model.Exchange {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	convs := append([]*conv(nil), r.convs[mark:]...)
	r.mu.Unlock()
	var out []model.Exchange
	for _, c := range convs {
		if e, ok := c.exchange(); ok {
			out = append(out, e)
		}
	}
	return out
}

// Exchanges returns everything recorded.
func (r *Recorder) Exchanges() []model.Exchange { return r.Since(0) }

// recordTLS swaps the record of a TLS carrier connection for the session above
// it, so HTTPS evidence is the request and response, not ciphertext.
func recordTLS(raw net.Conn, tc *tls.Conn, proto string) net.Conn {
	rc, ok := raw.(*recConn)
	if !ok {
		return tc
	}
	rc.c.mu.Lock()
	rc.c.carrier = true
	rc.c.mu.Unlock()
	return rc.c.r.wrap(tc, proto, rc.c.target)
}

func (c *conv) exchange() (model.Exchange, bool) {
	if c.fixed != nil {
		return *c.fixed, true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.carrier {
		return model.Exchange{}, false
	}
	return model.Exchange{
		Proto:    sniff(c.proto, c.out),
		Target:   c.target,
		Request:  render(c.out, c.sent, maxRequest, noneSent),
		Response: render(c.in, c.got, maxResponse, noneGot),
	}, true
}

// ConnectOnly reports an exchange where the connection opened and nothing was said.
func ConnectOnly(e model.Exchange) bool {
	return e.Request == "("+noneSent+")" && e.Response == "("+noneGot+")"
}

const (
	noneSent = "nothing sent, connect only"
	noneGot  = "nothing received"
)

var httpMethod = regexp.MustCompile(`^(GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH) \S+ HTTP/1\.[01]\r\n`)

// sniff names a raw connection by what went over it.
func sniff(proto string, out []byte) string {
	if proto != "tcp" {
		return proto
	}
	switch {
	case len(out) > 2 && out[0] == 0x16 && out[1] == 0x03:
		return "tls"
	case httpMethod.Match(out):
		return "http"
	}
	return proto
}

// render shows captured bytes: text with secrets masked, or a hex head for binary.
func render(b []byte, total, limit int, empty string) string {
	if total == 0 {
		return "(" + empty + ")"
	}
	if binary(b) {
		head := b
		if len(head) > 48 {
			head = head[:48]
		}
		return fmt.Sprintf("[%d bytes, binary] % x", total, head)
	}
	s := Redact(string(bytes.ToValidUTF8(b, []byte("?"))))
	if total > len(b) {
		s += fmt.Sprintf("\n[%d more bytes not kept]", total-len(b))
	}
	return model.Clip(s, limit)
}

func binary(b []byte) bool {
	if len(b) > 512 {
		b = b[:512]
	}
	odd := 0
	for _, c := range b {
		if c < 0x20 && c != '\n' && c != '\r' && c != '\t' || c == 0x7f {
			odd++
		}
	}
	return odd*10 > len(b)
}

// Masks for secrets the target may send back: a public .env or config backup is
// itself the finding, and its values must not be copied into our report.
var (
	secretHeader = regexp.MustCompile(`(?im)^((?:set-)?cookie|(?:proxy-)?authorization|x-api-key)([ \t]*:[ \t]*)([^\r\n]+)`)
	phpDefine    = regexp.MustCompile(`(define\(\s*['"][^'"]+['"]\s*,\s*)('[^']*'|"[^"]*")`)
	secretPair   = regexp.MustCompile(`(?i)(["']?[\w.-]*(?:pass|secret|token|key|auth|credential|dsn)[\w.-]*["']?[ \t]*[:=][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'<>]+)`)
	envAssign    = regexp.MustCompile(`(?m)^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.]*[ \t]*=[ \t]*)([^\r\n]+)`)
)

// Hidden replaces a masked value.
const Hidden = "[hidden]"

// Redact masks credential values in text the target sent or we sent.
func Redact(s string) string {
	s = secretHeader.ReplaceAllString(s, "${1}${2}"+Hidden)
	s = phpDefine.ReplaceAllString(s, "${1}'"+Hidden+"'")
	s = secretPair.ReplaceAllStringFunc(s, func(m string) string {
		p := secretPair.FindStringSubmatch(m)
		if p[2] == Hidden || p[2] == "'"+Hidden+"'" {
			return m
		}
		return p[1] + Hidden
	})
	return envAssign.ReplaceAllString(s, "${1}"+Hidden)
}
