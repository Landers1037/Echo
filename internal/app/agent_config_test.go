package app

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestAgentConfigHidesKeyAndKeepsItWhenOmitted(t *testing.T) {
	s, agent := openTestAgent(t)
	h := NewHandler(attachStore(s), false)
	view, err := agent.View()
	if err != nil {
		t.Fatal(err)
	}
	if view.Enabled || view.HasKey || view.BaseURL != defaultAgentBaseURL || view.Model != defaultAgentModel || view.ContextTokens != defaultContextTokens || view.MaxOutputTokens != defaultMaxOutputTokens || view.Temperature != defaultAgentTemperature {
		t.Fatalf("defaults: %+v", view)
	}
	saved := request(t, h, "PUT", "/api/agent/config", agentConfigUpdate{
		Enabled: true, BaseURL: "https://example.com/v1/", APIKey: "Bearer sk-test-secret", Model: "demo",
		ContextTokens: 8000, MaxOutputTokens: 1000, Temperature: 0, SystemPrompt: "简短回答",
	})
	if saved.Code != 200 || strings.Contains(saved.Body.String(), "sk-test-secret") {
		t.Fatalf("save leaked or failed: %d %s", saved.Code, saved.Body.String())
	}
	var body AgentConfigView
	if err = json.Unmarshal(saved.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Enabled || !body.HasKey || body.APIKeyHint != "****cret" || body.BaseURL != "https://example.com/v1" || body.Temperature != 0 || body.Model != "demo" {
		t.Fatalf("view: %+v", body)
	}
	kept := request(t, h, "PUT", "/api/agent/config", agentConfigUpdate{
		Enabled: true, BaseURL: "https://example.com/v1", APIKey: "  ", Model: "demo",
		ContextTokens: 8000, MaxOutputTokens: 1000, Temperature: 0.7, SystemPrompt: "简短回答",
	})
	if kept.Code != 200 {
		t.Fatalf("keep key: %d %s", kept.Code, kept.Body.String())
	}
	cfg, err := agent.Config()
	if err != nil || cfg.APIKey != "sk-test-secret" || cfg.Temperature != 0.7 {
		t.Fatalf("stored key: %+v %v", cfg, err)
	}
	file, err := os.ReadFile(agentConfigPath(s.root))
	if err != nil || !strings.Contains(string(file), "sk-test-secret") {
		t.Fatalf("file: %v %s", err, file)
	}
	got := request(t, h, "GET", "/api/agent/config", nil)
	if got.Code != 200 || strings.Contains(got.Body.String(), "sk-test-secret") {
		t.Fatalf("get leaked: %d %s", got.Code, got.Body.String())
	}
	invalid := request(t, h, "PUT", "/api/agent/config", agentConfigUpdate{
		Enabled: true, BaseURL: "ftp://example.com", APIKey: "sk-test-secret", Model: "demo",
		ContextTokens: 8000, MaxOutputTokens: 1000, Temperature: 0.7,
	})
	if invalid.Code != 400 || !strings.Contains(invalid.Body.String(), "API 地址") {
		t.Fatalf("invalid url: %d %s", invalid.Code, invalid.Body.String())
	}
	cfg, err = agent.Config()
	if err != nil || cfg.BaseURL != "https://example.com/v1" {
		t.Fatalf("config changed after invalid save: %+v %v", cfg, err)
	}

	fresh := testStore(t)
	t.Cleanup(func() { fresh.closeAgent() })
	denied := request(t, NewHandler(attachStore(fresh), false), "PUT", "/api/agent/config", agentConfigUpdate{
		Enabled: true, BaseURL: "https://example.com/v1", Model: "demo", ContextTokens: 8000, MaxOutputTokens: 1000, Temperature: 0.7,
	})
	if denied.Code == 200 {
		t.Fatalf("enabled without a key: %s", denied.Body.String())
	}
}
