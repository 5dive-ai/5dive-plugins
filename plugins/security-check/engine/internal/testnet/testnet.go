// Package testnet holds test seams that prove the scanner never resolves a name.
package testnet

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"testing"
)

// Recorder is a dialer seam that fails the test if it is ever handed a name
// instead of an IP literal, and records every address it dials.
type Recorder struct {
	t     testing.TB
	mu    sync.Mutex
	Addrs []string
}

// NewRecorder returns a recording, name-refusing dialer for t.
func NewRecorder(t testing.TB) *Recorder { return &Recorder{t: t} }

// Dial is the seam.
func (r *Recorder) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	r.mu.Lock()
	r.Addrs = append(r.Addrs, address)
	r.mu.Unlock()
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		r.t.Errorf("dialer got a malformed address %q", address)
		return nil, err
	}
	if _, err := netip.ParseAddr(host); err != nil {
		r.t.Errorf("dialer was handed a name, which would need DNS: %q", address)
		return nil, errors.New("name reached the dialer")
	}
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}

// Seen returns the dialed addresses.
func (r *Recorder) Seen() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.Addrs...)
}

// TrapDNS replaces the process resolver for the test so that any DNS query fails
// the test. Names not in /etc/hosts (like box.example.com) would go to DNS.
func TrapDNS(t testing.TB) {
	old := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			t.Errorf("a DNS query was attempted (%s %s)", network, address)
			return nil, errors.New("DNS is trapped in tests")
		},
	}
	t.Cleanup(func() { net.DefaultResolver = old })
}
