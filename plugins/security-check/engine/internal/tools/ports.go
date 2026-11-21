package tools

import (
	"context"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

// TopPorts is the common-port list the shallow scan tries (about 100 ports).
var TopPorts = []int{
	21, 22, 23, 25, 53, 80, 81, 110, 111, 135, 139, 143, 389, 443, 445, 465, 587,
	636, 873, 990, 993, 995, 1080, 1433, 1521, 1723, 1883, 2049, 2082, 2083, 2086,
	2087, 2181, 2375, 2376, 2379, 2380, 3000, 3001, 3128, 3306, 3389, 4000, 4369,
	4443, 4848, 5000, 5001, 5005, 5432, 5601, 5672, 5900, 5984, 5985, 6000, 6379,
	6443, 7001, 7474, 8000, 8001, 8008, 8009, 8080, 8081, 8086, 8088, 8089, 8090,
	8161, 8443, 8500, 8888, 9000, 9001, 9042, 9090, 9092, 9093, 9100, 9200, 9300,
	9418, 9443, 9999, 10000, 10250, 11211, 15672, 25565, 27017, 27018, 28017,
	50000, 50070,
}

// AllPorts is every TCP port, for the deep sweep.
func AllPorts() []int {
	out := make([]int, 65535)
	for i := range out {
		out[i] = i + 1
	}
	return out
}

// scanParallel is how many ports are tried at once. A firewall that drops
// (rather than refuses) makes each closed port cost the full connect timeout,
// so the all-ports sweep needs more in flight to fit its time budget.
func scanParallel(ports int) int {
	if ports > 1000 {
		return 256
	}
	return 64
}

// riskyPort describes a service that should not face the internet.
type riskyPort struct {
	name, severity, why, fix string
}

const firewallFix = "Close this port to the internet with your firewall (for example `ufw deny %d`), or make the service listen only on 127.0.0.1. If something outside really needs it, allow only that one address."

var riskyPorts = map[int]riskyPort{
	2375:  {"Docker control port", model.Critical, "Anyone who reaches this port can start programs on your server with full control, without a password.", "Turn off Docker's unencrypted network port (remove `-H tcp://0.0.0.0:2375` from the Docker service) and block port 2375 in your firewall."},
	5432:  {"PostgreSQL database", model.High, "Your database answers anyone on the internet. Only a password stands between a stranger and your data, and automated scanners try common passwords all day.", ""},
	3306:  {"MySQL database", model.High, "Your database answers anyone on the internet. Only a password stands between a stranger and your data, and automated scanners try common passwords all day.", ""},
	6379:  {"Redis store", model.High, "Redis often has no password at all. Anyone who reaches it can read or wipe its data, and sometimes take over the server.", ""},
	27017: {"MongoDB database", model.High, "Open MongoDB databases are found and emptied by automated scanners within hours.", ""},
	9200:  {"Elasticsearch", model.High, "Elasticsearch usually has no login. Anyone who reaches it can read or delete everything stored in it.", ""},
	11211: {"Memcached", model.High, "Memcached has no login. Strangers can read cached data and use your server to flood others with traffic.", ""},
	23:    {"Telnet", model.High, "Telnet sends passwords unencrypted, so anyone on the path can read them.", ""},
	5900:  {"VNC remote screen", model.High, "Remote-screen access open to the internet is a common way in, and VNC passwords are short and easy to guess.", ""},
	445:   {"Windows file sharing (SMB)", model.High, "File sharing exposed to the internet has a long history of serious break-ins.", ""},
	21:    {"FTP file transfer", model.Medium, "FTP sends passwords and files unencrypted.", "Switch to SFTP (it comes with SSH) and turn the FTP service off, or block port 21."},
	3389:  {"Windows Remote Desktop", model.Medium, "Remote Desktop open to the internet gets constant password-guessing traffic.", ""},
}

func portScan(ctx context.Context, env *Env, in model.Intent) (Result, error) {
	ip, err := netip.ParseAddr(in.Target)
	if err != nil {
		return Result{}, fmt.Errorf("port_scan target %q is not an IP", in.Target)
	}
	var (
		mu   sync.Mutex
		open []int
		wg   sync.WaitGroup
		sem  = make(chan struct{}, scanParallel(len(env.Ports)))
	)
	for _, p := range env.Ports {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(p int) {
			defer func() { <-sem; wg.Done() }()
			cctx, cancel := context.WithTimeout(ctx, env.ConnectTimeout)
			defer cancel()
			c, err := env.Dial(cctx, "tcp", joinTarget(ip, p))
			if err != nil {
				return
			}
			c.Close()
			mu.Lock()
			open = append(open, p)
			mu.Unlock()
		}(p)
	}
	wg.Wait()
	sort.Ints(open)

	var r Result
	r.Assets = append(r.Assets, model.Asset{Kind: "host", Key: ip.String()})
	for _, p := range open {
		t := joinTarget(ip, p)
		r.Facts = append(r.Facts, model.Fact{Kind: "open_port", Target: t, Data: map[string]string{"port": strconv.Itoa(p)}})
		r.Assets = append(r.Assets, model.Asset{Kind: "port", Key: t + "/tcp"})
		if rp, ok := riskyPorts[p]; ok {
			fix := rp.fix
			if fix == "" {
				fix = fmt.Sprintf(firewallFix, p)
			}
			r.Findings = append(r.Findings, model.NewFinding("open-risky-port", rp.severity, t,
				fmt.Sprintf("%s is open to the internet (port %d)", rp.name, p),
				fmt.Sprintf("Port %d on your server, used by %s, accepts connections from anywhere.", p, rp.name),
				rp.why, fix,
				fmt.Sprintf("TCP connect to %s succeeded", t)))
		}
	}
	names := make([]string, 0, len(open))
	for _, p := range open {
		names = append(names, strconv.Itoa(p))
	}
	// A sweep cut short (budget or stop) did not try every port, so it must not
	// say none answered.
	if len(open) == 0 && ctx.Err() == nil {
		r.Findings = append(r.Findings, model.NewFinding("no-open-ports", model.Info, ip.String(),
			"No open ports answered",
			fmt.Sprintf("None of the %d ports we tried answered.", len(env.Ports)),
			"Either the server is well locked down, or the copy we checked was not reachable. If you run a website, this check could not see it.",
			"Nothing to do if you expect the server to be closed.",
			fmt.Sprintf("0 of %d ports open", len(env.Ports))))
	} else {
		r.Findings = append(r.Findings, model.NewFinding("open-ports", model.Info, ip.String(),
			fmt.Sprintf("%d open port(s): %s", len(open), strings.Join(names, ", ")),
			"These are the doors on your server that answer anyone on the internet.",
			"Every open door is something that must be kept up to date. Fewer is safer.",
			"Close any you do not recognise with your firewall.",
			fmt.Sprintf("open: %s (of %d tried)", strings.Join(names, ","), len(env.Ports))))
	}
	return r, nil
}
