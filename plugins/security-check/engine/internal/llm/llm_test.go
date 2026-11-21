package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const goodPlan = `{"intents":[],"done":true}`

// anthropicFake answers like the Messages API.
func anthropicFake(t *testing.T, stopReason, text string, in, out int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "k-anthropic" || r.Header.Get("anthropic-version") == "" {
			t.Errorf("bad anthropic request: %s key=%q", r.URL.Path, r.Header.Get("x-api-key"))
		}
		var body struct {
			System string `json:"system"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(body.System, "SCOPE-LOCK") {
			t.Errorf("system prompt lost: %q", body.System)
		}
		fmt.Fprintf(w, `{"content":[{"type":"text","text":%q}],"stop_reason":%q,"usage":{"input_tokens":%d,"output_tokens":%d}}`, text, stopReason, in, out)
	}))
}

// openaiFake answers like chat completions.
func openaiFake(t *testing.T, status int, content, refusal string, total int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer k-openai" {
			t.Errorf("bad openai request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.WriteHeader(status)
		fmt.Fprintf(w, `{"choices":[{"finish_reason":"stop","message":{"content":%q,"refusal":%q}}],"usage":{"total_tokens":%d}}`, content, refusal, total)
	}))
}

func env(name string) string {
	return map[string]string{"KA": "k-anthropic", "KO": "k-openai"}[name]
}

func accept(text string) error {
	if !strings.Contains(text, "{") {
		return errors.New("no JSON")
	}
	return nil
}

func TestFailoverPastRefusalsAndErrors(t *testing.T) {
	refuser := anthropicFake(t, "refusal", "", 30, 5)
	defer refuser.Close()
	politeNo := openaiFake(t, 200, "I'm sorry, but I can't help with scanning servers.", "", 40)
	defer politeNo.Close()
	broken := openaiFake(t, 500, "", "", 0)
	defer broken.Close()
	refusalField := openaiFake(t, 200, "", "I can't do that", 10)
	defer refusalField.Close()
	good := anthropicFake(t, "end_turn", goodPlan, 100, 20)
	defer good.Close()

	c := NewClient([]Provider{
		{Kind: "openai", BaseURL: broken.URL, Model: "m0", APIKeyEnv: "MISSING"}, // no key in env
		{Kind: "anthropic", BaseURL: refuser.URL, Model: "m1", APIKeyEnv: "KA"},
		{Kind: "openai", BaseURL: politeNo.URL + "/v1", Model: "m2", APIKeyEnv: "KO"},
		{Kind: "openai", BaseURL: broken.URL + "/v1", Model: "m3", APIKeyEnv: "KO"},
		{Kind: "openai", BaseURL: refusalField.URL + "/v1", Model: "m4", APIKeyEnv: "KO"},
		{Kind: "anthropic", BaseURL: good.URL, Model: "m5", APIKeyEnv: "KA"},
	}, env)
	text, tokens, attempts, err := c.Complete(context.Background(), "SCOPE-LOCK", "plan", accept)
	if err != nil {
		t.Fatal(err)
	}
	if text != goodPlan {
		t.Fatalf("text %q", text)
	}
	want := []string{"error", "refused", "refused", "error", "refused", "ok"}
	if len(attempts) != len(want) {
		t.Fatalf("attempts %+v", attempts)
	}
	for i, a := range attempts {
		if a.Outcome != want[i] {
			t.Errorf("attempt %d (%s): %s, want %s (%s)", i, a.Provider, a.Outcome, want[i], a.Detail)
		}
	}
	if tokens != 35+40+10+120 {
		t.Errorf("tokens %d, want %d (refused answers still count)", tokens, 35+40+10+120)
	}
}

func TestUnusableAnswerFailsOver(t *testing.T) {
	prose := anthropicFake(t, "end_turn", "Here is my plan: scan everything.", 10, 10)
	defer prose.Close()
	c := NewClient([]Provider{{Kind: "anthropic", BaseURL: prose.URL, Model: "m", APIKeyEnv: "KA"}}, env)
	_, tokens, attempts, err := c.Complete(context.Background(), "SCOPE-LOCK", "plan", accept)
	if !errors.Is(err, ErrAllFailed) || tokens != 20 || attempts[0].Outcome != "error" {
		t.Fatalf("err=%v tokens=%d attempts=%+v", err, tokens, attempts)
	}
}

func TestParseProviders(t *testing.T) {
	ps, err := ParseProviders(`[{"kind":"anthropic","model":"x","api_key_env":"K"},{"kind":"openai","base_url":"http://127.0.0.1:1/v1","model":"y","api_key_env":"K2"}]`)
	if err != nil || len(ps) != 2 {
		t.Fatalf("%v %+v", err, ps)
	}
	for _, bad := range []string{`{}`, `[{"kind":"ollama","model":"x","api_key_env":"K"}]`, `[{"kind":"openai","model":"x"}]`} {
		if _, err := ParseProviders(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

// scripted answers each call with the next status/text in turn (the last repeats)
// and counts its calls.
type scripted struct {
	srv   *httptest.Server
	calls int
}

func newScripted(t *testing.T, answers ...string) *scripted {
	s := &scripted{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := answers[min(s.calls, len(answers)-1)]
		s.calls++
		switch a {
		case "429", "529":
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(map[string]int{"429": 429, "529": 529}[a])
		case "refuse":
			fmt.Fprint(w, `{"content":[],"stop_reason":"refusal","usage":{"input_tokens":5,"output_tokens":0}}`)
		default:
			fmt.Fprintf(w, `{"content":[{"type":"text","text":%q}],"stop_reason":"end_turn","usage":{"input_tokens":%s,"output_tokens":0}}`, goodPlan, a)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func rotating(clk *clock, ps ...Provider) *Client {
	c := NewClient(ps, env)
	c.Now = clk.now
	return c
}

func outcomes(as []Attempt) string {
	var b []string
	for _, a := range as {
		b = append(b, a.Provider+"="+a.Outcome)
	}
	return strings.Join(b, " ")
}

func ask(t *testing.T, c *Client) ([]Attempt, error) {
	t.Helper()
	_, _, as, err := c.Complete(context.Background(), "SCOPE-LOCK", "plan", accept)
	return as, err
}

// The client stays on the provider that answered and only moves on when it lets
// the run down: a refusal moves the NEXT call's start too, so a refusing provider
// is not asked first every round.
func TestRotationStaysOnTheProviderThatAnswered(t *testing.T) {
	a := newScripted(t, "refuse", "10")
	b := newScripted(t, "10")
	clk := &clock{time.Unix(0, 0)}
	c := rotating(clk,
		Provider{Kind: "anthropic", BaseURL: a.srv.URL, Model: "a", APIKeyEnv: "KA"},
		Provider{Kind: "anthropic", BaseURL: b.srv.URL, Model: "b", APIKeyEnv: "KA"})
	for i, want := range []string{
		"anthropic:a=refused anthropic:b=ok",
		"anthropic:b=ok",
		"anthropic:b=ok",
	} {
		as, err := ask(t, c)
		if err != nil || outcomes(as) != want {
			t.Fatalf("call %d: %q err=%v, want %q", i, outcomes(as), err, want)
		}
	}
	if a.calls != 1 || b.calls != 3 {
		t.Errorf("calls a=%d b=%d, want 1 and 3", a.calls, b.calls)
	}
}

// A 429 (or Anthropic's 529 overloaded) rests that provider for its Retry-After;
// while every usable provider rests the answer is ErrNoneReady, not ErrAllFailed,
// and the provider is asked again once the wait is over.
func TestRateLimitRestsTheProviderThenComesBack(t *testing.T) {
	a := newScripted(t, "429", "10")
	b := newScripted(t, "529", "10")
	clk := &clock{time.Unix(0, 0)}
	c := rotating(clk,
		Provider{Kind: "anthropic", BaseURL: a.srv.URL, Model: "a", APIKeyEnv: "KA"},
		Provider{Kind: "anthropic", BaseURL: b.srv.URL, Model: "b", APIKeyEnv: "KA"})

	as, err := ask(t, c)
	if !errors.Is(err, ErrNoneReady) || outcomes(as) != "anthropic:a=rate_limited anthropic:b=rate_limited" {
		t.Fatalf("first: %q err=%v", outcomes(as), err)
	}
	clk.t = clk.t.Add(30 * time.Second)
	as, err = ask(t, c)
	if !errors.Is(err, ErrNoneReady) || outcomes(as) != "anthropic:a=skipped anthropic:b=skipped" || a.calls+b.calls != 2 {
		t.Fatalf("resting: %q err=%v calls=%d", outcomes(as), err, a.calls+b.calls)
	}
	clk.t = clk.t.Add(31 * time.Second)
	as, err = ask(t, c)
	if err != nil || outcomes(as) != "anthropic:a=ok" {
		t.Fatalf("after the wait: %q err=%v", outcomes(as), err)
	}
}

// Each profile has its own token budget: a spent one is skipped and the run goes
// on with the others; once all are spent the LLM is done for the run.
func TestPerProfileBudget(t *testing.T) {
	a := newScripted(t, "60")
	b := newScripted(t, "40")
	clk := &clock{time.Unix(0, 0)}
	c := rotating(clk,
		Provider{Kind: "anthropic", BaseURL: a.srv.URL, Model: "a", APIKeyEnv: "KA", MaxTokens: 100},
		Provider{Kind: "anthropic", BaseURL: b.srv.URL, Model: "b", APIKeyEnv: "KA", MaxTokens: 50})
	for i, want := range []string{
		"anthropic:a=ok",                          // a: 60
		"anthropic:a=ok",                          // a: 120, over its 100
		"anthropic:a=skipped anthropic:b=ok",      // b: 40
		"anthropic:b=ok",                          // b: 80, over its 50
		"anthropic:b=skipped anthropic:a=skipped", // both spent
	} {
		as, err := ask(t, c)
		if outcomes(as) != want {
			t.Fatalf("call %d: %q err=%v, want %q", i, outcomes(as), err, want)
		}
		if i == 4 && !errors.Is(err, ErrAllFailed) {
			t.Fatalf("all spent: err=%v, want ErrAllFailed", err)
		}
	}
	got := c.Spent()
	if len(got) != 2 || got[0] != (Spend{"anthropic:a", 120, 100}) || got[1] != (Spend{"anthropic:b", 80, 50}) {
		t.Errorf("spent %+v", got)
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 21, 4, 0, 0, 0, time.UTC)
	for h, want := range map[string]time.Duration{
		"":                              defaultCooldown,
		"junk":                          defaultCooldown,
		"7":                             7 * time.Second,
		"0":                             time.Second,
		"86400":                         maxCooldown,
		"Sat, 21 Nov 2026 04:00:20 GMT": 20 * time.Second,
	} {
		if got := retryAfter(h, now); got != want {
			t.Errorf("Retry-After %q: %s, want %s", h, got, want)
		}
	}
	if _, err := ParseProviders(`[{"kind":"openai","model":"x","api_key_env":"K","max_tokens":-1}]`); err == nil {
		t.Errorf("negative max_tokens accepted")
	}
}
