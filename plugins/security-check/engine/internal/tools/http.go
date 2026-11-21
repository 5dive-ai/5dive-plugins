package tools

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

type httpTarget struct {
	scheme, vhost, label string
	ip                   netip.Addr
	port                 int
	client               *http.Client
	base                 string
	rec                  *Recorder
}

func newHTTPTarget(env *Env, in model.Intent) (*httpTarget, error) {
	ip, port, err := splitTarget(in.Target)
	if err != nil {
		return nil, err
	}
	scheme := in.Args["scheme"]
	if scheme == "" {
		scheme = "http"
	}
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("scheme %q is not http or https", scheme)
	}
	vh, err := vhost(env, in, "host", ip)
	if err != nil {
		return nil, err
	}
	label := in.Target
	if vh != "" {
		label = vh + " (" + in.Target + ")"
	}
	return &httpTarget{
		scheme: scheme, vhost: vh, ip: ip, port: port, label: scheme + "://" + label,
		client: httpClient(env, vh),
		base:   scheme + "://" + joinTarget(ip, port),
		rec:    env.Rec,
	}, nil
}

// get fetches path and returns status, headers, up to 64 KiB of body, and the
// recorded exchange as evidence.
func (t *httpTarget) get(ctx context.Context, path string) (int, http.Header, []byte, []model.Exchange, error) {
	mark := t.rec.Mark()
	status, hdr, body, err := t.fetch(ctx, path)
	return status, hdr, body, t.rec.Since(mark), err
}

func (t *httpTarget) fetch(ctx context.Context, path string) (int, http.Header, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.base+path, nil)
	if err != nil {
		return 0, nil, nil, err
	}
	if h := hostHeader(t.vhost, t.scheme, t.port); h != "" {
		req.Host = h
	}
	req.Header.Set("User-Agent", "5dive-seccheck/1 (owner-authorized self-check)")
	resp, err := t.client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, resp.Header, body, nil
}

func httpProbe(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	t, err := newHTTPTarget(env, in)
	if err != nil {
		return Result{}, err
	}
	status, hdr, _, ev, err := t.get(ctx, "/")
	if err != nil {
		return Result{}, err
	}
	server, powered := hdr.Get("Server"), hdr.Get("X-Powered-By")
	r := Result{
		Facts: []model.Fact{{Kind: "http", Target: in.Target, Data: map[string]string{
			"scheme": t.scheme, "host": t.vhost, "status": strconv.Itoa(status), "server": server, "powered_by": powered,
		}}},
		Assets: []model.Asset{{Kind: "url", Key: t.label, Data: map[string]string{"status": strconv.Itoa(status), "server": server}}},
	}

	leak := strings.TrimSpace(strings.Join(nonEmpty(server, powered), ", "))
	if powered != "" || strings.ContainsAny(server, "0123456789") {
		r.Findings = append(r.Findings, model.NewFinding("version-leak", model.Low, t.label,
			"Your web server tells everyone which software version it runs",
			fmt.Sprintf("Every page answer includes %q.", leak),
			"Knowing the exact version lets automated scanners pick known weaknesses for it straight away.",
			"Hide the version: in nginx set `server_tokens off;`, in Apache set `ServerTokens Prod` and `ServerSignature Off`, in PHP set `expose_php = Off`.",
			fmt.Sprintf("GET / -> %d; Server: %s; X-Powered-By: %s", status, server, powered)))
	}
	for _, s := range []string{server, powered} {
		if f, ok := outdated(s, t.label); ok {
			r.Findings = append(r.Findings, f)
		}
	}

	if f, ok := t.headersFinding(ctx, status, hdr, ev); ok {
		r.Findings = append(r.Findings, f)
	}
	withEvidence(r.Findings, ev)
	return r, nil
}

// safetyHeader is one browser safety setting: how to tell it is missing, and the
// line that adds it.
type safetyHeader struct {
	name, does, line string
	httpsOnly        bool
	present          func(hdr http.Header) bool
}

var safetyHeaders = []safetyHeader{
	{"Strict-Transport-Security", "always use the encrypted site", "`Strict-Transport-Security: max-age=31536000`", true,
		func(h http.Header) bool { return h.Get("Strict-Transport-Security") != "" }},
	{"Content-Security-Policy", "limits which scripts may run", "`Content-Security-Policy: object-src 'none'; base-uri 'self'` (a safe start; tighten it later)", false,
		func(h http.Header) bool { return h.Get("Content-Security-Policy") != "" }},
	{"X-Frame-Options", "stops other sites embedding yours", "`X-Frame-Options: SAMEORIGIN`", false,
		func(h http.Header) bool {
			return h.Get("X-Frame-Options") != "" || strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors")
		}},
	{"X-Content-Type-Options", "stops browsers guessing file types", "`X-Content-Type-Options: nosniff`", false,
		func(h http.Header) bool { return strings.EqualFold(h.Get("X-Content-Type-Options"), "nosniff") }},
}

// headersFinding judges the safety headers on the page a browser actually shows,
// never on a redirect: a site's automatic http -> https redirect carries none, and
// the https page it points to gets its own probe on its own port.
func (t *httpTarget) headersFinding(ctx context.Context, status int, hdr http.Header, ev []model.Exchange) (model.Finding, bool) {
	status, hdr, trail, ev := t.followSameSite(ctx, status, hdr, ev)
	if status >= 300 {
		return model.Finding{}, false
	}
	var missing []safetyHeader
	for _, h := range safetyHeaders {
		if (!h.httpsOnly || t.scheme == "https") && !h.present(hdr) {
			missing = append(missing, h)
		}
	}
	if len(missing) == 0 {
		return model.Finding{}, false
	}
	var whats, names, lines []string
	for _, h := range missing {
		whats = append(whats, h.name+" ("+h.does+")")
		names = append(names, h.name)
		lines = append(lines, h.line)
	}
	f := model.NewFinding("missing-safety-headers", model.Low, t.label,
		fmt.Sprintf("Your site is missing %d browser safety setting(s)", len(missing)),
		"Your site does not send these settings to visitors' browsers: "+strings.Join(whats, "; ")+".",
		"These settings make browsers block common tricks, such as another site showing yours inside a hidden frame or slipping in its own scripts.",
		"Add these headers to your site in your web server or app config: "+strings.Join(lines, ", ")+".",
		fmt.Sprintf("%s; missing: %s", strings.Join(trail, "; "), strings.Join(names, ", ")))
	f.Evidence = ev
	return f, true
}

// maxHops caps the same-site redirects followed to reach the rendered page.
const maxHops = 3

// followSameSite follows redirects that stay on this probe's scheme, host and port
// (such as / -> /login) to the page a browser shows, and returns its status and
// headers, the GET trail, and every recorded exchange. It stops at a redirect that
// leaves: to https, to another port, or to another site.
func (t *httpTarget) followSameSite(ctx context.Context, status int, hdr http.Header, ev []model.Exchange) (int, http.Header, []string, []model.Exchange) {
	path := "/"
	trail := []string{fmt.Sprintf("GET / -> %d", status)}
	for hop := 0; hop < maxHops && status >= 300 && status < 400; hop++ {
		next, ok := t.sameSite(path, hdr.Get("Location"))
		if !ok {
			break
		}
		s, h, _, more, err := t.get(ctx, next)
		ev = append(ev, more...)
		if err != nil {
			break
		}
		path, status, hdr = next, s, h
		trail = append(trail, fmt.Sprintf("GET %s -> %d", next, status))
	}
	return status, hdr, trail, ev
}

// sameSite resolves a Location against path, as a browser would, and returns the
// path to request when it stays on this probe's scheme, host and port.
func (t *httpTarget) sameSite(path, location string) (string, bool) {
	if location == "" {
		return "", false
	}
	host := t.vhost
	if host == "" {
		host = t.ip.String()
	}
	cur := &url.URL{Scheme: t.scheme, Host: net.JoinHostPort(host, strconv.Itoa(t.port)), Path: path}
	loc, err := cur.Parse(location)
	if err != nil || !strings.EqualFold(loc.Scheme, t.scheme) || !strings.EqualFold(loc.Hostname(), host) {
		return "", false
	}
	port := loc.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[t.scheme]
	}
	if port != strconv.Itoa(t.port) {
		return "", false
	}
	return loc.RequestURI(), true
}

// withEvidence gives every finding without evidence of its own the exchanges ev.
func withEvidence(fs []model.Finding, ev []model.Exchange) {
	for i := range fs {
		if len(fs[i].Evidence) == 0 {
			fs[i].Evidence = ev
		}
	}
}

func nonEmpty(ss ...string) []string {
	var out []string
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// exposure is one file or page that should never be public. match must look at the
// CONTENT, so a site that answers 200 to every path is not reported.
type exposure struct {
	path, check, severity, title, why, fix string
	match                                  func(body []byte) bool
}

var (
	envLine = regexp.MustCompile(`(?m)^[A-Z][A-Z0-9_]*=`)
	gitSHA  = regexp.MustCompile(`^[0-9a-f]{40}\s*$`)
)

var exposures = []exposure{
	{"/.git/HEAD", "git-exposed", model.High, "Your website's code history can be downloaded",
		"Anyone can download your project's code and its whole change history, which often holds passwords that were committed by mistake.",
		"Block the `.git` folder in your web server (nginx: `location ~ /\\.git { deny all; }`), or deploy without it.",
		func(b []byte) bool {
			return bytes.HasPrefix(b, []byte("ref: refs/")) || gitSHA.Match(b)
		}},
	{"/.env", "env-exposed", model.Critical, "Your app's secrets file is public",
		"The `.env` file usually holds database passwords and API keys. Anyone who reads it can use them.",
		"Block `.env` in your web server right away, move it outside the public folder, and change every password and key that was in it.",
		func(b []byte) bool { return !bytes.Contains(b, []byte("<")) && envLine.Match(b) }},
	{"/wp-config.php.bak", "wp-config-backup", model.Critical, "A backup of your WordPress settings is public",
		"This backup holds your database password in plain text.",
		"Delete the `.bak` file from the server and change the database password.",
		func(b []byte) bool {
			return bytes.Contains(b, []byte("DB_PASSWORD")) && bytes.Contains(b, []byte("define("))
		}},
	{"/backup.zip", "backup-exposed", model.High, "A backup archive can be downloaded",
		"Anyone can download this backup, which may contain your files, code or data.",
		"Move backups out of the website folder and delete the public copy.",
		func(b []byte) bool { return bytes.HasPrefix(b, []byte("PK\x03\x04")) }},
	{"/server-status", "server-status", model.Medium, "Your web server's status page is public",
		"It shows who is visiting your site right now and which pages they open.",
		"Restrict `/server-status` to localhost (Apache: `Require local`), or turn `mod_status` off.",
		func(b []byte) bool {
			return bytes.Contains(b, []byte("Apache Server Status")) || bytes.Contains(b, []byte("Server uptime"))
		}},
	{"/phpinfo.php", "phpinfo", model.Medium, "A PHP debug page is public",
		"It lists your server's software versions, folders and settings, which helps anyone looking for a way in.",
		"Delete `phpinfo.php` from the server.",
		func(b []byte) bool {
			return bytes.Contains(b, []byte("phpinfo()")) || (bytes.Contains(b, []byte("PHP Version")) && bytes.Contains(b, []byte("PHP License")))
		}},
	{"/.DS_Store", "ds-store", model.Low, "A Mac folder index file is public",
		"This file lists the names of files in the folder, including ones you did not link to.",
		"Delete `.DS_Store` files from the server and block them in your web server.",
		func(b []byte) bool { return bytes.HasPrefix(b, []byte("\x00\x00\x00\x01Bud1")) }},
}

var dirListingPaths = []string{"/", "/uploads/", "/backup/"}

func isDirListing(b []byte) bool {
	return bytes.Contains(b, []byte("<title>Index of /")) || bytes.Contains(b, []byte("Directory listing for /"))
}

func exposureProbe(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	t, err := newHTTPTarget(env, in)
	if err != nil {
		return Result{}, err
	}
	var r Result
	for _, e := range exposures {
		if ctx.Err() != nil {
			return r, ctx.Err()
		}
		status, _, body, ev, err := t.get(ctx, e.path)
		if err != nil || status != http.StatusOK || !e.match(body) {
			continue
		}
		f := model.NewFinding(e.check, e.severity, t.label+e.path, e.title,
			fmt.Sprintf("%s%s can be opened by anyone.", t.label, e.path), e.why, e.fix,
			fmt.Sprintf("GET %s -> 200; body starts: %q", e.path, model.Clip(Redact(string(body)), 120)))
		f.Evidence = ev
		r.Findings = append(r.Findings, f)
	}
	for _, p := range dirListingPaths {
		status, _, body, ev, err := t.get(ctx, p)
		if err != nil || status != http.StatusOK || !isDirListing(body) {
			continue
		}
		f := model.NewFinding("dir-listing", model.Medium, t.label+p,
			"A folder on your website lists all its files",
			fmt.Sprintf("Opening %s%s shows a list of every file in that folder.", t.label, p),
			"Visitors can find and download files you never meant to share, such as backups or uploads.",
			"Turn off folder listings: nginx `autoindex off;`, Apache `Options -Indexes`.",
			fmt.Sprintf("GET %s -> 200; body contains a directory index", p))
		f.Evidence = ev
		r.Findings = append(r.Findings, f)
	}
	return r, nil
}

// outdated flags software whose version is old enough that it is likely past its
// support window. Distributions back-port fixes, so this stays a hint (low/medium).
var versionRE = regexp.MustCompile(`(?i)(nginx|apache|openssh|php)(?:\s+httpd)?[/_ ]?(\d+)\.(\d+)(?:\.(\d+))?`)

var minVersions = map[string]struct {
	major, minor, patch int
	severity            string
}{
	"nginx":   {1, 18, 0, model.Low},
	"apache":  {2, 4, 29, model.Low},
	"openssh": {8, 2, 0, model.Low},
	"php":     {8, 1, 0, model.Medium},
}

func outdated(s, asset string) (model.Finding, bool) {
	m := versionRE.FindStringSubmatch(s)
	if m == nil {
		return model.Finding{}, false
	}
	name := strings.ToLower(m[1])
	min := minVersions[name]
	v := [3]int{}
	for i := 0; i < 3; i++ {
		v[i], _ = strconv.Atoi(m[i+2])
	}
	if v[0] > min.major || (v[0] == min.major && (v[1] > min.minor || (v[1] == min.minor && v[2] >= min.patch))) {
		return model.Finding{}, false
	}
	return model.NewFinding("outdated-"+name, min.severity, asset,
		fmt.Sprintf("Old %s version (%s)", m[1], strings.TrimSpace(m[0])),
		fmt.Sprintf("Your server reports %q, which is several years old.", m[0]),
		"Old versions have publicly known security holes. Your system may still patch them quietly, but often it does not.",
		"Update the package (on Ubuntu: `sudo apt update && sudo apt upgrade`), or move to a supported release.",
		s), true
}
