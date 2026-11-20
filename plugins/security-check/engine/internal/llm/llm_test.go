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
