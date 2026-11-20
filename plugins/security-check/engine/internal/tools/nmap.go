package tools

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"strconv"
	"strings"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

// nmapScan runs `nmap -sV --top-ports 100` against one in-scope IP. -n turns off
// nmap's own DNS so it can never look a name up.
func nmapScan(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	if env.NmapPath == "" {
		return Result{}, errors.New("nmap is not installed")
	}
	ip, err := netip.ParseAddr(in.Target)
	if err != nil || !env.Scope.AllowsIP(ip) {
		return Result{}, fmt.Errorf("nmap target %q is not an in-scope IP", in.Target)
	}
	cmd := exec.CommandContext(ctx, env.NmapPath, "-n", "-Pn", "-sV", "--top-ports", "100",
		"--host-timeout", "300s", "-oX", "-", ip.String())
	out, err := cmd.Output()
	if err != nil {
		return Result{}, fmt.Errorf("nmap: %w", err)
	}
	return parseNmapXML(out)
}

type nmapRun struct {
	Hosts []struct {
		Addresses []struct {
			Addr string `xml:"addr,attr"`
		} `xml:"address"`
		Ports []struct {
			Protocol string `xml:"protocol,attr"`
			PortID   int    `xml:"portid,attr"`
			State    struct {
				State string `xml:"state,attr"`
			} `xml:"state"`
			Service struct {
				Name      string `xml:"name,attr"`
				Product   string `xml:"product,attr"`
				Version   string `xml:"version,attr"`
				ExtraInfo string `xml:"extrainfo,attr"`
				Tunnel    string `xml:"tunnel,attr"`
			} `xml:"service"`
		} `xml:"ports>port"`
	} `xml:"host"`
}

func parseNmapXML(raw []byte) (Result, error) {
	var run nmapRun
	if err := xml.Unmarshal(raw, &run); err != nil {
		return Result{}, fmt.Errorf("nmap XML: %w", err)
	}
	var r Result
	for _, h := range run.Hosts {
		if len(h.Addresses) == 0 {
			continue
		}
		ip, err := netip.ParseAddr(h.Addresses[0].Addr)
		if err != nil {
			continue
		}
		for _, p := range h.Ports {
			if p.Protocol != "tcp" || p.State.State != "open" {
				continue
			}
			t := joinTarget(ip, p.PortID)
			product := strings.TrimSpace(p.Service.Product + " " + p.Service.Version)
			data := map[string]string{
				"port": strconv.Itoa(p.PortID), "service": p.Service.Name, "product": product, "tunnel": p.Service.Tunnel,
			}
			r.Facts = append(r.Facts, model.Fact{Kind: "nmap_service", Target: t, Data: data})
			r.Assets = append(r.Assets, model.Asset{Kind: "service", Key: t, Data: data})
			if f, ok := outdated(product, t); ok {
				r.Findings = append(r.Findings, f)
			}
		}
	}
	return r, nil
}
