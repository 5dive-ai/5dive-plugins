package tools

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"strings"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

// bannerGrab works out what speaks on a port: it reads a greeting (SSH, FTP,
// SMTP talk first), then tries a TLS handshake, then a plain HTTP HEAD.
func bannerGrab(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	if _, _, err := splitTarget(in.Target); err != nil {
		return Result{}, err
	}
	greeting, err := readGreeting(ctx, env, in.Target)
	if err != nil {
		return Result{}, err
	}
	proto := "other"
	switch {
	case strings.HasPrefix(greeting, "SSH-"):
		proto = "ssh"
	case greeting == "" && speaksTLS(ctx, env, in.Target):
		proto = "tls"
	case greeting == "":
		resp := sendHTTPHead(ctx, env, in.Target)
		switch {
		case strings.Contains(resp, "plain HTTP request was sent to HTTPS port"):
			// nginx's 400 for plain HTTP on a TLS listener: the port is HTTPS.
			proto = "tls"
		case strings.HasPrefix(resp, "HTTP/"):
			proto, greeting = "http", resp
		}
	}
	banner := firstLine(greeting)
	return Result{
		Facts:  []model.Fact{{Kind: "service", Target: in.Target, Data: map[string]string{"proto": proto, "banner": banner}}},
		Assets: []model.Asset{{Kind: "service", Key: in.Target, Data: map[string]string{"proto": proto, "banner": banner}}},
	}, nil
}

func readGreeting(ctx context.Context, env *Env, target string) (string, error) {
	c, err := env.Dial(ctx, "tcp", target)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(env.IOTimeout / 2))
	buf := make([]byte, 512)
	n, _ := c.Read(buf)
	return string(bytes.ToValidUTF8(buf[:n], nil)), nil
}

// speaksTLS asks "is this TLS" with no SNI first, then with each of the owner's
// host names (max 5). A 5dive box serves TLS only for its domain: a no-SNI hello
// gets a TLS alert, which already proves the port speaks TLS. Some servers just
// drop a hello for a name they do not serve, which is what the SNI retries are for.
func speaksTLS(ctx context.Context, env *Env, target string) bool {
	names := env.Scope.HostNames
	if len(names) > 5 {
		names = names[:5]
	}
	for _, sni := range append([]string{""}, names...) {
		if err := tlsHello(ctx, env, target, sni); err == nil || isTLSAlert(err) {
			return true
		}
	}
	return false
}

func tlsHello(ctx context.Context, env *Env, target, sni string) error {
	c, err := env.Dial(ctx, "tcp", target)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(env.IOTimeout))
	tc := tls.Client(c, &tls.Config{ServerName: sni, InsecureSkipVerify: true}) //nolint:gosec // only asking "is this TLS"
	return tc.HandshakeContext(ctx)
}

// isTLSAlert reports whether the peer answered the hello with a TLS alert record.
// crypto/tls returns that as a *net.OpError with Op "remote error".
func isTLSAlert(err error) bool {
	var oe *net.OpError
	return errors.As(err, &oe) && oe.Op == "remote error"
}

func sendHTTPHead(ctx context.Context, env *Env, target string) string {
	c, err := env.Dial(ctx, "tcp", target)
	if err != nil {
		return ""
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(env.IOTimeout))
	if _, err := io.WriteString(c, "HEAD / HTTP/1.0\r\n\r\n"); err != nil {
		return ""
	}
	buf := make([]byte, 512)
	n, _ := io.ReadAtLeast(c, buf, 5)
	return string(bytes.ToValidUTF8(buf[:n], nil))
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	return model.Clip(strings.TrimSpace(s), 200)
}
