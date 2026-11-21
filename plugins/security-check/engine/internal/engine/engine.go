// Package engine runs the planner loop: a planner proposes intents, the gate
// approves or denies each one, workers run one approved intent each and stop,
// their facts feed the next round, until nothing new is left or a budget runs out.
package engine

import (
	"context"
	"fmt"
	"io"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/llm"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/report"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/scope"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/store"
	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/tools"
)

// Config is one run.
type Config struct {
	Scope       *scope.Scope
	Store       *store.Store
	Env         *tools.Env
	LLM         *llm.Client // nil = deterministic planner only
	Approval    string      // AutoSafe | DenyAll
	MaxDuration time.Duration
	MaxTokens   int
	Version     string
	Workers     int // parallel workers per round (default 4)
	MaxRounds   int // planner rounds (default 8)
	Log         io.Writer
}

type run struct {
	cfg      Config
	catalog  map[string]tools.Tool
	start    time.Time
	tokens   int
	step     int
	goal     int64
	facts    []model.Fact
	seen     map[string]bool
	findings map[string]model.Finding
	order    []string
	rep      *report.Report
	llmOff   bool
	// What decides a finding's Source at finish (baselineReach): every parent
	// the baseline proposed each intent from, the intent behind each fact, and
	// the intents behind each finding.
	baseProps map[string][]int64
	factBy    map[int64]string
	foundBy   map[string][]string
	// traffic is what each intent sent and got back (the evidence proxy, DIVE-8921).
	traffic map[string][]model.Exchange
}

// Run executes the scan and returns the report (also on budget stops). The error
// is non-nil only for a failure that should exit 1; the report then says "error".
func Run(ctx context.Context, cfg Config) (*report.Report, error) {
	if cfg.Workers <= 0 {
		cfg.Workers = 4
	}
	if cfg.MaxRounds <= 0 {
		cfg.MaxRounds = 8
	}
	if cfg.Log == nil {
		cfg.Log = io.Discard
	}
	r := &run{
		cfg: cfg, catalog: tools.Catalog(), start: time.Now(),
		seen: map[string]bool{}, findings: map[string]model.Finding{},
		baseProps: map[string][]int64{}, factBy: map[int64]string{}, foundBy: map[string][]string{},
		traffic: map[string][]model.Exchange{},
	}
	r.rep = &report.Report{
		RunID: cfg.Scope.RunID, StartedAt: r.start.UTC().Format(time.RFC3339),
		EngineVersion: cfg.Version, Scope: cfg.Scope,
	}
	reason, err := r.loop(ctx)
	if err != nil {
		reason = report.StopError
		fmt.Fprintf(cfg.Log, "error: %v\n", err)
	}
	r.finish(reason)
	if ferr := cfg.Store.FinishRun(cfg.Scope.RunID, reason, r.tokens, time.Now()); ferr != nil && err == nil {
		err = ferr
		r.rep.StoppedReason = report.StopError
	}
	return r.rep, err
}

func (r *run) logf(format string, a ...any) { fmt.Fprintf(r.cfg.Log, format+"\n", a...) }

// overBudget is checked between steps.
func (r *run) overBudget() string {
	if r.cfg.MaxTokens > 0 && r.tokens > r.cfg.MaxTokens {
		return report.StopBudgetTokens
	}
	if time.Since(r.start) >= r.cfg.MaxDuration {
		return report.StopBudgetTime
	}
	return ""
}

func (r *run) loop(parent context.Context) (string, error) {
	cfg := r.cfg
	if err := cfg.Store.StartRun(cfg.Scope.RunID, cfg.Version, cfg.Approval, cfg.Scope, r.start); err != nil {
		return "", err
	}
	goal, err := cfg.Store.AddNode(cfg.Scope.RunID, 0, "goal", map[string]any{
		"goal": "shallow self-check of the owner's cloned server", "targets": cfg.Scope.Targets, "depth": "shallow",
	})
	if err != nil {
		return "", err
	}
	r.goal = goal
	ctx, cancel := context.WithDeadline(parent, r.start.Add(cfg.MaxDuration))
	defer cancel()

	for round := 1; round <= cfg.MaxRounds; round++ {
		if stop := r.overBudget(); stop != "" {
			return stop, nil
		}
		if parent.Err() != nil {
			return "", parent.Err()
		}
		proposed, err := r.plan(ctx)
		if err != nil {
			return "", err
		}
		if stop := r.overBudget(); stop != "" {
			return stop, nil
		}
		var fresh []model.Intent
		for _, in := range proposed {
			if k := in.Key(); !r.seen[k] {
				r.seen[k] = true
				fresh = append(fresh, in)
			}
		}
		if len(fresh) == 0 {
			return report.StopDone, nil
		}
		r.logf("round %d: %d new step(s)", round, len(fresh))
		stop, err := r.execute(ctx, fresh)
		if err != nil || stop != "" {
			return stop, err
		}
	}
	return report.StopDone, nil
}

// plan returns this round's proposals: the deterministic baseline plus, when an
// LLM is configured and has not failed, whatever the LLM adds.
func (r *run) plan(ctx context.Context) ([]model.Intent, error) {
	out := baseline(r.cfg.Scope, r.cfg.Env.NmapPath != "", r.facts)
	for _, in := range out {
		r.baseProps[in.Key()] = append(r.baseProps[in.Key()], in.ParentNode)
	}
	if r.cfg.LLM == nil || r.llmOff {
		return out, nil
	}
	prompt, err := plannerPrompt(r.cfg.Scope, r.catalog, r.facts, r.seen)
	if err != nil {
		return nil, err
	}
	var plan plannerOutput
	_, used, attempts, err := r.cfg.LLM.Complete(ctx, ScopeLock(r.cfg.Scope)+"\n\n"+plannerTask, prompt, func(text string) error {
		p, perr := parsePlan(text)
		plan = p
		return perr
	})
	r.tokens += used
	if _, nerr := r.cfg.Store.AddNode(r.cfg.Scope.RunID, r.goal, "fact", map[string]any{
		"planner": "llm", "attempts": attempts, "tokens": used,
	}); nerr != nil {
		return nil, nerr
	}
	if err != nil {
		r.llmOff = true
		r.logf("llm planner: %v; using the deterministic planner for the rest of the run", err)
		return out, nil
	}
	return append(out, plan.Intents...), nil
}

type outcome struct {
	node int64
	in   model.Intent
	res  tools.Result
	err  error
	ex   []model.Exchange
}

// execute gates every intent, runs the approved ones (one worker per intent, at
// most cfg.Workers at a time) and folds their results back in.
func (r *run) execute(ctx context.Context, intents []model.Intent) (string, error) {
	cfg := r.cfg
	var (
		wg       sync.WaitGroup
		sem      = make(chan struct{}, cfg.Workers)
		mu       sync.Mutex
		outcomes []outcome
		stop     string
	)
	for _, in := range intents {
		r.step++
		parent := in.ParentNode
		if parent == 0 {
			parent = r.goal
		}
		node, err := cfg.Store.AddNode(cfg.Scope.RunID, parent, "intent", in)
		if err != nil {
			return "", err
		}
		d := Gate(cfg.Scope, r.catalog, cfg.Approval, in)
		decision := "denied"
		if d.Approved {
			decision = "approved"
		}
		r.rep.Approvals = append(r.rep.Approvals, report.Approval{Step: r.step, Tool: in.Tool, Target: in.Target, Decision: decision, Reason: d.Reason})
		if err := cfg.Store.AddApproval(cfg.Scope.RunID, r.step, in.Tool, in.Target, decision, d.Reason, node); err != nil {
			return "", err
		}
		if !d.Approved {
			r.logf("step %d: denied %s %s: %s", r.step, in.Tool, in.Target, d.Reason)
			continue
		}
		if stop = r.overBudget(); stop != "" {
			break
		}
		r.logf("step %d: run %s %s", r.step, in.Tool, in.Target)
		wg.Add(1)
		sem <- struct{}{}
		go func(node int64, in model.Intent) {
			defer func() { <-sem; wg.Done() }()
			// Each worker records through its own proxy, so its traffic is its own.
			rec := tools.NewRecorder()
			env := *cfg.Env
			env.Rec, env.Dial = rec, rec.Dial(cfg.Env.Dial)
			res, err := runTool(ctx, r.catalog[in.Tool], &env, in)
			mu.Lock()
			outcomes = append(outcomes, outcome{node, in, res, err, rec.Exchanges()})
			mu.Unlock()
		}(node, in)
	}
	wg.Wait()
	for _, o := range outcomes {
		if err := r.absorb(o); err != nil {
			return "", err
		}
	}
	return stop, nil
}

// runTool is one worker: it runs exactly one intent and stops. A panic in a probe
// becomes that step's error rather than the end of the run.
func runTool(ctx context.Context, t tools.Tool, env *tools.Env, in model.Intent) (res tools.Result, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("probe panicked: %v", p)
		}
	}()
	return t.Run(ctx, env, in)
}

func (r *run) absorb(o outcome) error {
	st, id := r.cfg.Store, r.cfg.Scope.RunID
	r.traffic[o.in.Key()] = append(r.traffic[o.in.Key()], o.ex...)
	if err := st.AddTraffic(id, o.node, o.ex); err != nil {
		return err
	}
	if o.err != nil {
		r.logf("%s %s: %v", o.in.Tool, o.in.Target, o.err)
		_, err := st.AddNode(id, o.node, "fact", map[string]string{"tool": o.in.Tool, "target": o.in.Target, "error": o.err.Error()})
		return err
	}
	for _, f := range o.res.Facts {
		n, err := st.AddNode(id, o.node, "fact", f)
		if err != nil {
			return err
		}
		f.Node = n
		r.factBy[n] = o.in.Key()
		r.facts = append(r.facts, f)
	}
	for _, a := range o.res.Assets {
		if err := st.UpsertAsset(id, a, time.Now()); err != nil {
			return err
		}
	}
	for _, f := range o.res.Findings {
		if len(f.Evidence) == 0 {
			f.Evidence = evidenceFor(f.Asset, o.ex)
		}
		r.foundBy[f.ID] = append(r.foundBy[f.ID], o.in.Key())
		if err := r.addFinding(f, o.node); err != nil {
			return err
		}
	}
	return nil
}

// maxEvidence caps the exchanges one finding carries; the full trail is in the store.
const maxEvidence = 4

// evidenceFor picks a finding's evidence from its step's traffic: the exchanges
// with the address the finding is about, else all of them; a bare connect only
// when nothing else was said.
func evidenceFor(asset string, ex []model.Exchange) []model.Exchange {
	var hit []model.Exchange
	for _, e := range ex {
		if e.Target != "" && strings.Contains(asset, e.Target) {
			hit = append(hit, e)
		}
	}
	if len(hit) == 0 {
		hit = ex
	}
	var talk []model.Exchange
	for _, e := range hit {
		if !tools.ConnectOnly(e) {
			talk = append(talk, e)
		}
	}
	if len(talk) > 0 {
		hit = talk
	}
	if len(hit) > maxEvidence {
		hit = hit[:maxEvidence]
	}
	return hit
}

// baselineReach returns the intents a run WITHOUT an LLM would also run: the
// baseline proposed them from the goal, or from a fact that such an intent
// produced. The baseline is stateless and also proposes from facts only an LLM
// step found (a port the LLM scanned), so being proposed by it is not enough:
// the whole chain back to the goal must be baseline. Resolved at finish because
// the LLM can reach an intent a round before the baseline does.
func (r *run) baselineReach() map[string]bool {
	reach := map[string]bool{}
	for changed := true; changed; {
		changed = false
		for k, parents := range r.baseProps {
			if reach[k] {
				continue
			}
			for _, p := range parents {
				if p == 0 || reach[r.factBy[p]] {
					reach[k], changed = true, true
					break
				}
			}
		}
	}
	return reach
}

func (r *run) addFinding(f model.Finding, parent int64) error {
	if _, dup := r.findings[f.ID]; dup {
		return nil
	}
	n, err := r.cfg.Store.AddNode(r.cfg.Scope.RunID, parent, "finding", f)
	if err != nil {
		return err
	}
	if err := r.cfg.Store.AddFinding(r.cfg.Scope.RunID, f, n); err != nil {
		return err
	}
	r.findings[f.ID] = f
	r.order = append(r.order, f.ID)
	return nil
}

// finish adds whole-run findings and fills the report.
func (r *run) finish(reason string) {
	// One no-https finding per host, not per port: :80 and :443 answering plain
	// HTTP is one unencrypted website (DIVE-8908).
	plain, plainBy, tls := map[string][]string{}, map[string][]string{}, false
	for _, f := range r.facts {
		if f.Kind == "service" && f.Data["proto"] == "http" {
			host, port, err := net.SplitHostPort(f.Target)
			if err != nil {
				host = f.Target
			}
			plain[host] = append(plain[host], port)
			plainBy[host] = append(plainBy[host], r.factBy[f.Node])
		}
		if f.Kind == "service" && f.Data["proto"] == "tls" {
			tls = true
		}
	}
	if len(plain) > 0 && !tls {
		hosts := make([]string, 0, len(plain))
		for h := range plain {
			hosts = append(hosts, h)
		}
		sort.Strings(hosts)
		for _, h := range hosts {
			ports := plain[h]
			sort.Strings(ports)
			f := model.NewFinding("no-https", model.Medium, h,
				"Your website is not encrypted",
				"Your server answers web requests only without encryption (plain HTTP, no HTTPS).",
				"Anything visitors send, such as passwords or form contents, can be read or changed by anyone on the network path.",
				"Turn on HTTPS with a free Let's Encrypt certificate: `sudo apt install certbot` then `sudo certbot --nginx` (or `--apache`), and redirect HTTP to HTTPS.",
				fmt.Sprintf("HTTP answered on %s port(s) %s; no TLS service found on any scanned port, with or without the site's name (SNI)", h, strings.Join(ports, ", ")))
			r.foundBy[f.ID] = plainBy[h]
			var ex []model.Exchange
			for _, k := range plainBy[h] {
				ex = append(ex, r.traffic[k]...)
			}
			f.Evidence = evidenceFor(h, ex)
			_ = r.addFinding(f, r.goal)
		}
	}
	reach := r.baselineReach()
	for _, id := range r.order {
		f := r.findings[id]
		f.Source = model.SourcePlanner
		for _, k := range r.foundBy[id] {
			if reach[k] {
				f.Source = model.SourceBaseline
				break
			}
		}
		r.rep.Findings = append(r.rep.Findings, f)
	}
	end := time.Now()
	r.rep.FinishedAt = end.UTC().Format(time.RFC3339)
	r.rep.StoppedReason = reason
	r.rep.Budget = report.Budget{
		TokensUsed: r.tokens, Seconds: int(end.Sub(r.start).Round(time.Second) / time.Second),
		MaxTokens: r.cfg.MaxTokens, MaxSeconds: int(r.cfg.MaxDuration / time.Second),
	}
	r.rep.Finalize()
}
