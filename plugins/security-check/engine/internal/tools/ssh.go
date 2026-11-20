package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

var errProbeDone = errors.New("probe done: stopping before any password is sent")

// sshProbe reads the SSH version line, then asks which login methods the server
// offers. The password and keyboard-interactive callbacks only note that the method
// was offered and abort: no password is ever sent.
//
// Whether root may log in is not visible from outside: OpenSSH offers the same
// methods for every user name, so telling would take a login attempt.
func sshProbe(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	if _, _, err := splitTarget(in.Target); err != nil {
		return Result{}, err
	}
	greeting, err := readGreeting(ctx, env, in.Target)
	if err != nil {
		return Result{}, err
	}
	version := firstLine(greeting)
	if !strings.HasPrefix(version, "SSH-") {
		return Result{}, fmt.Errorf("no SSH version line, got %q", version)
	}

	cctx, cancel := context.WithTimeout(ctx, 2*env.IOTimeout)
	defer cancel()
	c, err := env.Dial(cctx, "tcp", in.Target)
	if err != nil {
		return Result{}, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * env.IOTimeout))

	var password, kbd, noAuth bool
	cfg := &ssh.ClientConfig{
		User: "root",
		Auth: []ssh.AuthMethod{
			ssh.PasswordCallback(func() (string, error) { password = true; return "", errProbeDone }),
			ssh.KeyboardInteractive(func(string, string, []string, []bool) ([]string, error) {
				kbd = true
				return nil, errProbeDone
			}),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // a probe, not a session
		Timeout:         2 * env.IOTimeout,
	}
	if sc, _, _, err := ssh.NewClientConn(c, in.Target, cfg); err == nil {
		noAuth = true // the "none" method succeeded: no credentials needed at all
		sc.Close()
	}
	return sshResult(in.Target, version, password, kbd, noAuth), nil
}

func sshResult(target, version string, password, kbd, noAuth bool) Result {
	r := Result{
		Facts: []model.Fact{{Kind: "ssh", Target: target, Data: map[string]string{
			"version": version, "password": fmt.Sprint(password), "keyboard_interactive": fmt.Sprint(kbd),
		}}},
		Assets: []model.Asset{{Kind: "service", Key: target, Data: map[string]string{"proto": "ssh", "banner": version}}},
	}
	r.Findings = append(r.Findings, model.NewFinding("ssh-version", model.Info, target,
		"SSH remote login is open",
		fmt.Sprintf("Your server answers SSH logins and reports its version as %q.", version),
		"SSH is how you manage the server, so it is normal to have it open. Keep it updated.",
		"Keep the system updated (`sudo apt update && sudo apt upgrade`).",
		version))
	if noAuth {
		r.Findings = append(r.Findings, model.NewFinding("ssh-no-auth", model.Critical, target,
			"Anyone can log in to your server over SSH without a password",
			"Your SSH server let us in as root without asking for any password or key. We disconnected straight away.",
			"Anyone on the internet can take full control of the server.",
			"Set `PermitEmptyPasswords no` and remove any `AuthenticationMethods none` line in /etc/ssh/sshd_config, give root a key-only login, then run `sudo systemctl reload ssh`.",
			fmt.Sprintf("%s accepted the \"none\" login method for user root", version)))
	}
	if password || kbd {
		r.Findings = append(r.Findings, model.NewFinding("ssh-password-login", model.Medium, target,
			"Your server accepts password logins over SSH",
			"Anyone on the internet can try to log in to your server with a password.",
			"Bots try millions of common passwords against every server. One weak or reused password is enough for them to get in. Key-based login cannot be guessed this way.",
			"Make sure you can log in with an SSH key first, then set `PasswordAuthentication no` and `KbdInteractiveAuthentication no` in /etc/ssh/sshd_config (and the files in /etc/ssh/sshd_config.d/), and run `sudo systemctl reload ssh`.",
			fmt.Sprintf("%s offered: password=%v keyboard-interactive=%v (no password was sent)", version, password, kbd)))
	}
	if f, ok := outdated(version, target); ok {
		r.Findings = append(r.Findings, f)
	}
	return r
}
