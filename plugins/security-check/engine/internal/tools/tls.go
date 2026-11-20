package tools

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

// now is replaced in tests.
var now = time.Now

func handshake(ctx context.Context, env *Env, target, sni string, version uint16) (*tls.ConnectionState, error) {
	cctx, cancel := context.WithTimeout(ctx, env.IOTimeout)
	defer cancel()
	c, err := env.Dial(cctx, "tcp", target)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	cfg := &tls.Config{ServerName: sni, InsecureSkipVerify: true} //nolint:gosec // we verify by hand below
	if version != 0 {
		cfg.MinVersion, cfg.MaxVersion = version, version
	}
	tc := tls.Client(c, cfg)
	if err := tc.HandshakeContext(cctx); err != nil {
		return nil, err
	}
	st := tc.ConnectionState()
	return &st, nil
}

func tlsProbe(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	ip, _, err := splitTarget(in.Target)
	if err != nil {
		return Result{}, err
	}
	sni, err := vhost(env, in, "sni", ip)
	if err != nil {
		return Result{}, err
	}
	st, err := handshake(ctx, env, in.Target, sni, 0)
	if err != nil {
		return Result{}, fmt.Errorf("TLS handshake: %w", err)
	}
	if len(st.PeerCertificates) == 0 {
		return Result{}, fmt.Errorf("TLS handshake: no certificate")
	}
	label := in.Target
	if sni != "" {
		label = sni + " (" + in.Target + ")"
	}
	cert := st.PeerCertificates[0]
	sum := sha256.Sum256(cert.Raw)
	fp := hex.EncodeToString(sum[:])
	r := Result{
		Facts: []model.Fact{{Kind: "tls", Target: in.Target, Data: map[string]string{
			"sni": sni, "version": tls.VersionName(st.Version), "subject": cert.Subject.String(),
			"issuer": cert.Issuer.String(), "not_after": cert.NotAfter.UTC().Format(time.RFC3339),
		}}},
		Assets: []model.Asset{{Kind: "cert", Key: fp, Data: map[string]string{
			"subject": cert.Subject.String(), "issuer": cert.Issuer.String(),
			"not_after": cert.NotAfter.UTC().Format(time.RFC3339), "seen_on": label,
		}}},
	}
	certProof := fmt.Sprintf("subject=%q issuer=%q not_after=%s dns_names=%v sha256=%s",
		cert.Subject.String(), cert.Issuer.String(), cert.NotAfter.UTC().Format(time.RFC3339), cert.DNSNames, fp[:16])

	for _, v := range []uint16{tls.VersionTLS10, tls.VersionTLS11} {
		if _, err := handshake(ctx, env, in.Target, sni, v); err == nil {
			name := tls.VersionName(v)
			r.Findings = append(r.Findings, model.NewFinding("old-tls-"+strings.ToLower(strings.ReplaceAll(name, " ", "")), model.Medium, label,
				fmt.Sprintf("Your server still accepts the outdated %s encryption", name),
				fmt.Sprintf("%s accepts connections using %s, a version retired in 2021.", label, name),
				"Old encryption versions have known weaknesses that can let someone on the network read or change traffic.",
				"Allow only TLS 1.2 and 1.3. nginx: `ssl_protocols TLSv1.2 TLSv1.3;`. Apache: `SSLProtocol -all +TLSv1.2 +TLSv1.3`.",
				fmt.Sprintf("handshake with min=max=%s succeeded", name)))
		}
	}

	t := now()
	switch {
	case t.After(cert.NotAfter):
		r.Findings = append(r.Findings, model.NewFinding("cert-expired", model.High, label,
			"Your site's security certificate has expired",
			fmt.Sprintf("The certificate for %s expired on %s.", label, cert.NotAfter.UTC().Format("2 Jan 2006")),
			"Browsers show visitors a full-page warning, and most will leave.",
			"Renew the certificate. With Let's Encrypt: `sudo certbot renew`, and check the renewal timer runs (`systemctl list-timers | grep certbot`).",
			certProof))
	case cert.NotAfter.Sub(t) < 14*24*time.Hour:
		r.Findings = append(r.Findings, model.NewFinding("cert-expiring", model.Medium, label,
			"Your site's security certificate expires soon",
			fmt.Sprintf("The certificate for %s expires on %s.", label, cert.NotAfter.UTC().Format("2 Jan 2006")),
			"When it expires, browsers will warn visitors away from your site.",
			"Renew it now and make sure automatic renewal works (`sudo certbot renew --dry-run`).",
			certProof))
	}

	selfSigned := bytes.Equal(cert.RawIssuer, cert.RawSubject)
	inter := x509.NewCertPool()
	for _, c := range st.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	_, verr := cert.Verify(x509.VerifyOptions{Intermediates: inter, CurrentTime: t})
	if selfSigned || verr != nil {
		what := "The certificate is not signed by an authority browsers trust."
		if selfSigned {
			what = "The certificate is self-signed: the server vouches for itself, so browsers do not trust it."
		}
		r.Findings = append(r.Findings, model.NewFinding("cert-untrusted", model.Medium, label,
			"Browsers will not trust your site's certificate", what,
			"Visitors see a security warning, and they cannot tell your real site from an impostor.",
			"Get a free trusted certificate from Let's Encrypt: `sudo apt install certbot` then `sudo certbot --nginx` (or `--apache`).",
			certProof+fmt.Sprintf(" verify=%v", verr)))
	}
	if sni != "" {
		if err := cert.VerifyHostname(sni); err != nil {
			r.Findings = append(r.Findings, model.NewFinding("cert-name-mismatch", model.Medium, label,
				"Your certificate is for a different name",
				fmt.Sprintf("The certificate served for %s does not list that name.", sni),
				"Browsers show a warning for this name, which teaches visitors to click through warnings.",
				fmt.Sprintf("Issue a certificate that includes %s (Let's Encrypt: `sudo certbot -d %s`).", sni, sni),
				certProof))
		}
	}
	return r, nil
}
