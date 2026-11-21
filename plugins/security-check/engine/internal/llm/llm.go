// Package llm calls the engine's own LLM providers and rotates between them: it
// stays on the provider that last answered, and moves on when that one refuses,
// errors, is rate-limited or has spent its own token budget. Keys come from the env
// var each provider names; the engine never reads a key from the box it runs on.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Provider is one entry (one profile) of SECCHECK_LLM_PROVIDERS.
type Provider struct {
	Kind      string `json:"kind"` // anthropic | openai
	BaseURL   string `json:"base_url"`
	Model     string `json:"model"`
	APIKeyEnv string `json:"api_key_env"`
	// MaxTokens is this profile's own token budget for the run; 0 = only the run's
	// budget applies. A spent profile is skipped, the others carry on.
	MaxTokens int `json:"max_tokens,omitempty"`
}

// Name is how attempts and spend name the profile.
func (p Provider) Name() string { return p.Kind + ":" + p.Model }

// ParseProviders reads the SECCHECK_LLM_PROVIDERS JSON list.
func ParseProviders(raw string) ([]Provider, error) {
	var ps []Provider
	if err := json.Unmarshal([]byte(raw), &ps); err != nil {
		return nil, fmt.Errorf("SECCHECK_LLM_PROVIDERS: %w", err)
	}
	for i, p := range ps {
		if p.Kind != "anthropic" && p.Kind != "openai" {
			return nil, fmt.Errorf("SECCHECK_LLM_PROVIDERS[%d]: kind %q is not anthropic or openai", i, p.Kind)
		}
		if p.Model == "" || p.APIKeyEnv == "" {
			return nil, fmt.Errorf("SECCHECK_LLM_PROVIDERS[%d]: model and api_key_env are required", i)
		}
		if p.MaxTokens < 0 {
			return nil, fmt.Errorf("SECCHECK_LLM_PROVIDERS[%d]: max_tokens is negative", i)
		}
	}
	return ps, nil
}

// Attempt records how one provider answered.
type Attempt struct {
	Provider string
	Outcome  string // ok | refused | error | rate_limited | skipped
	Detail   string
}

var (
	// ErrAllFailed means no provider can answer for the rest of the run: each one
	// refused, errored or spent its budget.
	ErrAllFailed = errors.New("every LLM provider refused or failed")
	// ErrNoneReady means every usable provider is rate-limited right now; a later
	// call may succeed once one cools down.
	ErrNoneReady = errors.New("every usable LLM provider is rate-limited right now")
)

// Default and longest wait after a rate limit, when the provider names none or
// names one longer than a run can afford to wait on one profile.
const (
	defaultCooldown = 30 * time.Second
	maxCooldown     = 5 * time.Minute
)

// Spend is one profile's tokens against its own budget.
type Spend struct {
	Provider  string `json:"provider"`
	Tokens    int    `json:"tokens"`
	MaxTokens int    `json:"max_tokens,omitempty"`
}

// Client rotates between providers. One Client lives for one run; it is safe for
// concurrent use, calls are serialised.
type Client struct {
	Providers []Provider
	HTTP      *http.Client
	Getenv    func(string) string
	Now       func() time.Time

	mu        sync.Mutex
	cur       int         // where the next call starts: the last provider that answered
	used      []int       // tokens per provider
	coolUntil []time.Time // rate-limited until
}

// NewClient builds a client with a plain HTTP client (provider APIs are not scan
// targets, so they do not go through the scope guard).
func NewClient(ps []Provider, getenv func(string) string) *Client {
	return &Client{Providers: ps, HTTP: &http.Client{Timeout: 90 * time.Second}, Getenv: getenv, Now: time.Now}
}

// Spent reports each profile's tokens so far, in configuration order.
func (c *Client) Spent() []Spend {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	out := make([]Spend, len(c.Providers))
	for i, p := range c.Providers {
		out[i] = Spend{Provider: p.Name(), Tokens: c.used[i], MaxTokens: p.MaxTokens}
	}
	return out
}

func (c *Client) init() {
	if len(c.used) != len(c.Providers) {
		c.used = make([]int, len(c.Providers))
		c.coolUntil = make([]time.Time, len(c.Providers))
	}
	if c.Now == nil {
		c.Now = time.Now
	}
}

// Complete sends one prompt. It starts at the provider that answered last and goes
// round the list once. accept validates the answer; a rejected answer counts as a
// failure and the next provider is tried. tokens counts every attempt.
func (c *Client) Complete(ctx context.Context, system, user string, accept func(string) error) (text string, tokens int, attempts []Attempt, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	n, start := len(c.Providers), c.cur
	cooling := false
	for k := 0; k < n; k++ {
		i := (start + k) % n
		p := c.Providers[i]
		name := p.Name()
		if p.MaxTokens > 0 && c.used[i] >= p.MaxTokens {
			attempts = append(attempts, Attempt{name, "skipped", fmt.Sprintf("budget spent (%d of %d tokens)", c.used[i], p.MaxTokens)})
			continue
		}
		if now := c.Now(); now.Before(c.coolUntil[i]) {
			cooling = true
			attempts = append(attempts, Attempt{name, "skipped", "rate-limited for " + c.coolUntil[i].Sub(now).Round(time.Second).String()})
			continue
		}
		out, used, refused, err := c.call(ctx, p, system, user)
		tokens += used
		c.used[i] += used
		var rl *rateLimited
		switch {
		case errors.As(err, &rl):
			cooling = true
			c.coolUntil[i] = c.Now().Add(rl.wait)
			attempts = append(attempts, Attempt{name, "rate_limited", rl.Error()})
		case err != nil:
			attempts = append(attempts, Attempt{name, "error", err.Error()})
		case refused || looksLikeRefusal(out):
			attempts = append(attempts, Attempt{name, "refused", clip(out, 200)})
		default:
			if aerr := accept(out); aerr != nil {
				attempts = append(attempts, Attempt{name, "error", "unusable answer: " + aerr.Error()})
				break
			}
			attempts = append(attempts, Attempt{name, "ok", ""})
			c.cur = i
			return out, tokens, attempts, nil
		}
		// Rotate: the next call starts after the one that let us down.
		c.cur = (i + 1) % n
		if ctx.Err() != nil {
			break
		}
	}
	if cooling {
		return "", tokens, attempts, ErrNoneReady
	}
	return "", tokens, attempts, ErrAllFailed
}

// rateLimited is an HTTP 429 (or Anthropic's 529 overloaded) with the wait to honour.
type rateLimited struct {
	status int
	wait   time.Duration
}

func (e *rateLimited) Error() string {
	return fmt.Sprintf("HTTP %d: rate-limited, resting it %s", e.status, e.wait)
}

// retryAfter reads Retry-After (seconds or an HTTP date), clamped to maxCooldown.
func retryAfter(h string, now time.Time) time.Duration {
	h = strings.TrimSpace(h)
	d := defaultCooldown
	if secs, err := strconv.Atoi(h); err == nil && secs >= 0 {
		d = time.Duration(secs) * time.Second
	} else if t, err := http.ParseTime(h); err == nil {
		d = t.Sub(now)
	}
	if d <= 0 {
		d = time.Second
	}
	if d > maxCooldown {
		d = maxCooldown
	}
	return d
}

var refusalRE = regexp.MustCompile(`(?i)^\W*(i['’]?m sorry|i am sorry|sorry,? but|i can(?:no|['’])t|i won['’]t|i will not|i['’]?m (?:not able|unable)|i am (?:not able|unable)|as an ai)`)

func looksLikeRefusal(s string) bool { return refusalRE.MatchString(strings.TrimSpace(s)) }

func (c *Client) call(ctx context.Context, p Provider, system, user string) (string, int, bool, error) {
	key := c.Getenv(p.APIKeyEnv)
	if key == "" {
		return "", 0, false, fmt.Errorf("env %s is empty", p.APIKeyEnv)
	}
	switch p.Kind {
	case "anthropic":
		return c.anthropic(ctx, p, key, system, user)
	default:
		return c.openai(ctx, p, key, system, user)
	}
}

func (c *Client) post(ctx context.Context, url string, hdr map[string]string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == 529 {
		return &rateLimited{status: resp.StatusCode, wait: retryAfter(resp.Header.Get("Retry-After"), c.Now())}
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, clip(string(data), 200))
	}
	return json.Unmarshal(data, out)
}

func (c *Client) anthropic(ctx context.Context, p Provider, key, system, user string) (string, int, bool, error) {
	base := strings.TrimRight(p.BaseURL, "/")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	var resp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	err := c.post(ctx, base+"/v1/messages",
		map[string]string{"x-api-key": key, "anthropic-version": "2023-06-01"},
		map[string]any{
			"model": p.Model, "max_tokens": 2048, "system": system,
			"messages": []map[string]string{{"role": "user", "content": user}},
		}, &resp)
	if err != nil {
		return "", 0, false, err
	}
	var b strings.Builder
	for _, part := range resp.Content {
		if part.Type == "text" {
			b.WriteString(part.Text)
		}
	}
	return b.String(), resp.Usage.InputTokens + resp.Usage.OutputTokens, resp.StopReason == "refusal", nil
}

func (c *Client) openai(ctx context.Context, p Provider, key, system, user string) (string, int, bool, error) {
	base := strings.TrimRight(p.BaseURL, "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	var resp struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content string `json:"content"`
				Refusal string `json:"refusal"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	err := c.post(ctx, base+"/chat/completions",
		map[string]string{"Authorization": "Bearer " + key},
		map[string]any{
			"model": p.Model,
			"messages": []map[string]string{
				{"role": "system", "content": system},
				{"role": "user", "content": user},
			},
		}, &resp)
	if err != nil {
		return "", 0, false, err
	}
	used := resp.Usage.TotalTokens
	if used == 0 {
		used = resp.Usage.PromptTokens + resp.Usage.CompletionTokens
	}
	if len(resp.Choices) == 0 {
		return "", used, false, errors.New("no choices in answer")
	}
	ch := resp.Choices[0]
	refused := ch.Message.Refusal != "" || ch.FinishReason == "content_filter"
	return ch.Message.Content, used, refused, nil
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") + "…"
}
