package app

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultAgentBaseURL        = "https://api.openai.com/v1"
	defaultAgentModel          = "gpt-4o-mini"
	defaultContextTokens       = 32000
	defaultMaxOutputTokens     = 4096
	defaultAgentTemperature    = 0.7
	defaultAgentSystemPrompt   = "你是 Echo 笔记里的助手。用用户使用的语言回答，简洁、准确，不要编造笔记里没有的内容。"
	maxAgentSystemPromptRunes  = 20000
	defaultAgentTimeoutSeconds = 90
	minAgentTimeoutSeconds     = 5
	maxAgentTimeoutSeconds     = 600
)

type AgentConfig struct {
	Enabled         bool    `json:"enabled"`
	BaseURL         string  `json:"baseURL"`
	APIKey          string  `json:"apiKey,omitempty"`
	Model           string  `json:"model"`
	ContextTokens   int     `json:"contextTokens"`
	MaxOutputTokens int     `json:"maxOutputTokens"`
	Temperature     float64 `json:"temperature"`
	SystemPrompt    string  `json:"systemPrompt"`
	TimeoutSeconds  int     `json:"timeoutSeconds"`
}

type AgentConfigView struct {
	Enabled         bool    `json:"enabled"`
	BaseURL         string  `json:"baseURL"`
	HasKey          bool    `json:"hasKey"`
	APIKeyHint      string  `json:"apiKeyHint"`
	Model           string  `json:"model"`
	ContextTokens   int     `json:"contextTokens"`
	MaxOutputTokens int     `json:"maxOutputTokens"`
	Temperature     float64 `json:"temperature"`
	SystemPrompt    string  `json:"systemPrompt"`
	TimeoutSeconds  int     `json:"timeoutSeconds"`
}

type agentConfigUpdate struct {
	Enabled         bool    `json:"enabled"`
	BaseURL         string  `json:"baseURL"`
	APIKey          string  `json:"apiKey"`
	Model           string  `json:"model"`
	ContextTokens   int     `json:"contextTokens"`
	MaxOutputTokens int     `json:"maxOutputTokens"`
	Temperature     float64 `json:"temperature"`
	SystemPrompt    string  `json:"systemPrompt"`
	TimeoutSeconds  *int    `json:"timeoutSeconds"`
}

func defaultAgentConfig() AgentConfig {
	return AgentConfig{
		BaseURL:         defaultAgentBaseURL,
		Model:           defaultAgentModel,
		ContextTokens:   defaultContextTokens,
		MaxOutputTokens: defaultMaxOutputTokens,
		Temperature:     defaultAgentTemperature,
		SystemPrompt:    defaultAgentSystemPrompt,
		TimeoutSeconds:  defaultAgentTimeoutSeconds,
	}
}

func agentConfigPath(root string) string {
	return filepath.Join(root, ".echo", "agent.json")
}

func loadAgentConfig(root string) (AgentConfig, error) {
	data, err := os.ReadFile(agentConfigPath(root))
	if os.IsNotExist(err) {
		return defaultAgentConfig(), nil
	}
	if err != nil {
		return AgentConfig{}, err
	}
	cfg := defaultAgentConfig()
	if err = json.Unmarshal(data, &cfg); err != nil {
		return AgentConfig{}, fmt.Errorf("agent.json 损坏，请检查后重试: %w", err)
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = defaultAgentBaseURL
	}
	if cfg.Model == "" {
		cfg.Model = defaultAgentModel
	}
	if cfg.ContextTokens == 0 {
		cfg.ContextTokens = defaultContextTokens
	}
	if cfg.MaxOutputTokens == 0 {
		cfg.MaxOutputTokens = defaultMaxOutputTokens
	}
	if cfg.TimeoutSeconds == 0 {
		cfg.TimeoutSeconds = defaultAgentTimeoutSeconds
	}
	cfg.APIKey = normalizeAPIKey(cfg.APIKey)
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	return cfg, nil
}

func saveAgentConfig(root string, cfg AgentConfig) error {
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWrite(agentConfigPath(root), data, 0600)
}

func (a *Agent) Config() (AgentConfig, error) {
	a.mu.Lock()
	closed := a.closed
	root := a.root
	a.mu.Unlock()
	if closed {
		return AgentConfig{}, errAgentClosed
	}
	return loadAgentConfig(root)
}

func (a *Agent) View() (AgentConfigView, error) {
	cfg, err := a.Config()
	if err != nil {
		return AgentConfigView{}, err
	}
	return configView(cfg), nil
}

func configView(cfg AgentConfig) AgentConfigView {
	return AgentConfigView{
		Enabled: cfg.Enabled, BaseURL: cfg.BaseURL, HasKey: cfg.APIKey != "", APIKeyHint: apiKeyHint(cfg.APIKey),
		Model: cfg.Model, ContextTokens: cfg.ContextTokens, MaxOutputTokens: cfg.MaxOutputTokens,
		Temperature: cfg.Temperature, SystemPrompt: cfg.SystemPrompt, TimeoutSeconds: cfg.TimeoutSeconds,
	}
}

func apiKeyHint(key string) string {
	if key == "" {
		return ""
	}
	runes := []rune(key)
	if len(runes) <= 4 {
		return "****"
	}
	return "****" + string(runes[len(runes)-4:])
}

func normalizeAPIKey(key string) string {
	key = strings.TrimSpace(key)
	if len(key) >= 7 && strings.EqualFold(key[:7], "bearer ") {
		key = strings.TrimSpace(key[7:])
	}
	return key
}

func validateBaseURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return "", fmt.Errorf("API 地址必须是 http 或 https URL，密钥请填写在 API Key")
	}
	return raw, nil
}

func normalizeAgentConfig(current AgentConfig, update agentConfigUpdate) (AgentConfig, error) {
	next := current
	next.Enabled = update.Enabled
	base := strings.TrimSpace(update.BaseURL)
	if base == "" {
		base = defaultAgentBaseURL
	}
	base, err := validateBaseURL(base)
	if err != nil {
		return AgentConfig{}, err
	}
	next.BaseURL = base
	if key := normalizeAPIKey(update.APIKey); key != "" {
		next.APIKey = key
	}
	next.Model = strings.TrimSpace(update.Model)
	if next.Model == "" {
		next.Model = defaultAgentModel
	}
	if strings.ContainsAny(next.Model, "\r\n\x00") || len(next.Model) > 200 {
		return AgentConfig{}, fmt.Errorf("模型名称无效")
	}
	next.ContextTokens = update.ContextTokens
	next.MaxOutputTokens = update.MaxOutputTokens
	if next.ContextTokens < 1024 || next.ContextTokens > 2_000_000 {
		return AgentConfig{}, fmt.Errorf("上下文长度需要在 1024 到 2000000 之间")
	}
	if next.MaxOutputTokens < 1 || next.MaxOutputTokens > 128000 || next.MaxOutputTokens >= next.ContextTokens {
		return AgentConfig{}, fmt.Errorf("最大输出长度需要小于上下文长度，且在 1 到 128000 之间")
	}
	next.Temperature = update.Temperature
	if next.Temperature < 0 || next.Temperature > 2 {
		return AgentConfig{}, fmt.Errorf("温度需要在 0 到 2 之间")
	}
	next.SystemPrompt = update.SystemPrompt
	if update.TimeoutSeconds != nil {
		next.TimeoutSeconds = *update.TimeoutSeconds
	}
	if next.TimeoutSeconds < minAgentTimeoutSeconds || next.TimeoutSeconds > maxAgentTimeoutSeconds {
		return AgentConfig{}, fmt.Errorf("超时时间需要在 %d 到 %d 秒之间", minAgentTimeoutSeconds, maxAgentTimeoutSeconds)
	}
	if len([]rune(next.SystemPrompt)) > maxAgentSystemPromptRunes {
		return AgentConfig{}, fmt.Errorf("系统提示词过长")
	}
	if next.Enabled && next.APIKey == "" {
		return AgentConfig{}, fmt.Errorf("开启 Agent 前请先填写 API Key")
	}
	return next, nil
}

func (a *Agent) UpdateConfig(update agentConfigUpdate) (AgentConfigView, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return AgentConfigView{}, errAgentClosed
	}
	current, err := loadAgentConfig(a.root)
	if err != nil {
		return AgentConfigView{}, err
	}
	next, err := normalizeAgentConfig(current, update)
	if err != nil {
		return AgentConfigView{}, err
	}
	if err = saveAgentConfig(a.root, next); err != nil {
		return AgentConfigView{}, err
	}
	return configView(next), nil
}
