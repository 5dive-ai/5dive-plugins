package model

import "testing"

// DIVE-8917: every check runs on a NEW clone with a new IP. A finding id that hashed
// the IP made the same open port a different finding on each clone, so a retest
// answered «fixed» for a port that was still open.
func TestFindingIDIsTheSameOnTwoCloneIPs(t *testing.T) {
	for _, c := range []struct{ check, a, b string }{
		{"open-risky-port", "203.0.113.10:5432", "203.0.113.77:5432"},
		{"no-https", "203.0.113.10", "198.51.100.4"},
		{"missing-safety-headers", "https://example.com (203.0.113.10:443)", "https://example.com (203.0.113.77:443)"},
		{"exposed-env", "http://203.0.113.10:80/.env", "http://198.51.100.4:80/.env"},
		{"ssh-password-login", "[2001:db8::1]:22", "[2001:db8::2]:22"},
		{"no-https", "2001:db8::1", "2001:db8::2"},
	} {
		fa := NewFinding(c.check, Medium, c.a, "t", "w", "y", "f", "p")
		fb := NewFinding(c.check, Medium, c.b, "t", "w", "y", "f", "p")
		if fa.ID != fb.ID {
			t.Errorf("%s: %q -> %s, %q -> %s; want the same id", c.check, c.a, fa.ID, c.b, fb.ID)
		}
		if fa.Asset != c.a {
			t.Errorf("asset shown to the owner changed: %q -> %q", c.a, fa.Asset)
		}
	}
}

// The id still tells apart what differs apart from the IP: port, path, site name, check.
func TestFindingIDStillSeparatesPortPathSiteAndCheck(t *testing.T) {
	ids := map[string]string{}
	for _, c := range [][2]string{
		{"open-risky-port", "203.0.113.10:5432"},
		{"open-risky-port", "203.0.113.10:3306"},
		{"exposed-env", "http://203.0.113.10:80/.env"},
		{"exposed-env", "http://203.0.113.10:80/.git/config"},
		{"missing-safety-headers", "https://a.example.com (203.0.113.10:443)"},
		{"missing-safety-headers", "https://b.example.com (203.0.113.10:443)"},
		{"version-leak", "https://b.example.com (203.0.113.10:443)"},
	} {
		id := NewFinding(c[0], Low, c[1], "t", "w", "y", "f", "p").ID
		if prev, dup := ids[id]; dup {
			t.Errorf("%s %q and %s share id %s", c[0], c[1], prev, id)
		}
		ids[id] = c[0] + " " + c[1]
	}
}

func TestStableAsset(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.10:5432":                      "server:5432",
		"203.0.113.10":                           "server",
		"https://example.com (203.0.113.10:443)": "https://example.com (server:443)",
		"http://203.0.113.10:80/.env":            "http://server:80/.env",
		"[2001:db8::1]:22":                       "[server]:22",
		"https://example.com/cafe.html":          "https://example.com/cafe.html",
	} {
		if got := StableAsset(in); got != want {
			t.Errorf("StableAsset(%q) = %q, want %q", in, got, want)
		}
	}
}
