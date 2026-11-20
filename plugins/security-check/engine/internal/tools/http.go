package tools

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

type httpTarget struct {
	scheme, vhost, label string
	port                 int
	client               *http.Client
	base                 string
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
		scheme: scheme, vhost: vh, port: port, label: scheme + "://" + label,
		client: httpClient(env, vh),
		base:   scheme + "://" + joinTarget(ip, port),
	}, nil
}

// get fetches path and returns status, headers and up to 64 KiB of body.
func (t *httpTarget) get(ctx context.Context, path string) (int, http.Header, []byte, error) {
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
	status, hdr, _, err := t.get(ctx, "/")
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

	if status < 400 {
		var missing []string
		if t.scheme == "https" && hdr.Get("Strict-Transport-Security") == "" {
			missing = append(missing, "Strict-Transport-Security (always use the encrypted site)")
		}
		csp := hdr.Get("Content-Security-Policy")
		if csp == "" {
			missing = append(missing, "Content-Security-Policy (limits which scripts may run)")
		}
		if hdr.Get("X-Frame-Options") == "" && !strings.Contains(csp, "frame-ancestors") {
			missing = append(missing, "X-Frame-Options (stops other sites embedding yours)")
		}
		if !strings.EqualFold(hdr.Get("X-Content-Type-Options"), "nosniff") {
			missing = append(missing, "X-Content-Type-Options: nosniff (stops browsers guessing file types)")
		}
		if len(missing) > 0 {
			r.Findings = append(r.Findings, model.NewFinding("missing-safety-headers", model.Low, t.label,
				fmt.Sprintf("Your site is missing %d browser safety setting(s)", len(missing)),
				"Your site does not send these settings to visitors' browsers: "+strings.Join(missing, "; ")+".",
				"These settings make browsers block common tricks, such as another site showing yours inside a hidden frame or slipping in its own scripts.",
				"Add the missing headers in your web server or app config. Most sites can start with: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and on HTTPS `Strict-Transport-Security: max-age=31536000`.",
				fmt.Sprintf("GET / -> %d; missing: %s", status, strings.Join(headerNames(missing), ", "))))
		}
	}
	return r, nil
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

func headerNames(missing []string) []string {
	out := make([]string, len(missing))
	for i, m := range missing {
		out[i] = strings.Fields(m)[0]
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
		status, _, body, err := t.get(ctx, e.path)
		if err != nil || status != http.StatusOK || !e.match(body) {
			continue
		}
		r.Findings = append(r.Findings, model.NewFinding(e.check, e.severity, t.label+e.path, e.title,
			fmt.Sprintf("%s%s can be opened by anyone.", t.label, e.path), e.why, e.fix,
			fmt.Sprintf("GET %s -> 200; body starts: %q", e.path, model.Clip(string(body), 120))))
	}
	for _, p := range dirListingPaths {
		status, _, body, err := t.get(ctx, p)
		if err != nil || status != http.StatusOK || !isDirListing(body) {
			continue
		}
		r.Findings = append(r.Findings, model.NewFinding("dir-listing", model.Medium, t.label+p,
			"A folder on your website lists all its files",
			fmt.Sprintf("Opening %s%s shows a list of every file in that folder.", t.label, p),
			"Visitors can find and download files you never meant to share, such as backups or uploads.",
			"Turn off folder listings: nginx `autoindex off;`, Apache `Options -Indexes`.",
			fmt.Sprintf("GET %s -> 200; body contains a directory index", p)))
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
