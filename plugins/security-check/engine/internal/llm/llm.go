// Package llm calls the engine's own LLM providers in order and fails over when
// one refuses or errors. Keys come from the env var each provider names; the engine
// never reads a key from the box it runs on.
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
	"strings"
	"time"
)

// Provider is one entry of SECCHECK_LLM_PROVIDERS.
type Provider struct {
	Kind      string `json:"kind"` // anthropic | openai
	BaseURL   string `json:"base_url"`
	Model     string `json:"model"`
	APIKeyEnv string `json:"api_key_env"`
}

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
	}
	return ps, nil
}

// Attempt records how one provider answered.
type Attempt struct {
	Provider string
	Outcome  string // ok | refused | error
	Detail   string
}

// ErrAllFailed means every provider refused or errored.
var ErrAllFailed = errors.New("every LLM provider refused or failed")

// Client tries providers in order.
type Client struct {
	Providers []Provider
	HTTP      *http.Client
	Getenv    func(string) string
}

// NewClient builds a client with a plain HTTP client (provider APIs are not scan
// targets, so they do not go through the scope guard).
func NewClient(ps []Provider, getenv func(string) string) *Client {
	return &Client{Providers: ps, HTTP: &http.Client{Timeout: 90 * time.Second}, Getenv: getenv}
}

// Complete sends one prompt. accept validates the answer; a rejected answer counts
// as a failure and the next provider is tried. tokens counts every attempt.
func (c *Client) Complete(ctx context.Context, system, user string, accept func(string) error) (text string, tokens int, attempts []Attempt, err error) {
	for _, p := range c.Providers {
		name := p.Kind + ":" + p.Model
		out, used, refused, err := c.call(ctx, p, system, user)
		tokens += used
		switch {
		case err != nil:
			attempts = append(attempts, Attempt{name, "error", err.Error()})
		case refused || looksLikeRefusal(out):
			attempts = append(attempts, Attempt{name, "refused", clip(out, 200)})
		default:
			if aerr := accept(out); aerr != nil {
				attempts = append(attempts, Attempt{name, "error", "unusable answer: " + aerr.Error()})
				continue
			}
			attempts = append(attempts, Attempt{name, "ok", ""})
			return out, tokens, attempts, nil
		}
		if ctx.Err() != nil {
			break
		}
	}
	return "", tokens, attempts, ErrAllFailed
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
