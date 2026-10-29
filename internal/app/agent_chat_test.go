package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func enableAgent(t *testing.T, h http.Handler, base string) {
	t.Helper()
	rr := request(t, h, "PUT", "/api/agent/config", agentConfigUpdate{
		Enabled: true, BaseURL: base, APIKey: "sk-test-secret", Model: "test-model",
		ContextTokens: 4000, MaxOutputTokens: 200, Temperature: 0, SystemPrompt: "s",
	})
	if rr.Code != 200 {
		t.Fatalf("config: %d %s", rr.Code, rr.Body.String())
	}
}

type upstreamCapture struct {
	mu   sync.Mutex
	body []byte
	auth string
}

func (c *upstreamCapture) remember(r *http.Request) {
	data, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(data))
	c.mu.Lock()
	c.body = data
	c.auth = r.Header.Get("Authorization")
	c.mu.Unlock()
}

func TestAgentChatRequiresSetup(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "POST", "/api/agent/chat", map[string]any{"mode": "chat", "message": "你好"})
	if rr.Code != 400 || !strings.Contains(rr.Body.String(), "开启 Agent") {
		t.Fatalf("disabled: %d %s", rr.Code, rr.Body.String())
	}
}

func TestAgentChatStreamsTextAndKeepsNoteOutOfHistory(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	var seen upstreamCapture
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		seen.remember(r)
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		for _, payload := range []string{
			`{"choices":[{"delta":{"content":"你"}}]}`,
			`{"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()
	h := NewHandler(attachStore(s), false)
	enableAgent(t, h, upstream.URL+"/v1")
	missing := request(t, h, "POST", "/api/agent/chat", map[string]any{"mode": "note", "message": "改一下"})
	if missing.Code != 400 {
		t.Fatalf("note without a path: %d %s", missing.Code, missing.Body.String())
	}
	rr := request(t, h, "POST", "/api/agent/chat", map[string]any{
		"mode": "note", "message": "改一下", "note": map[string]string{"path": "日记.md", "content": "Hello\nWorld"},
	})
	if rr.Code != 200 {
		t.Fatalf("chat: %d %s", rr.Code, rr.Body.String())
	}
	events := decodeSSE(t, rr.Body.String())
	if events[0]["type"] != "meta" || events[len(events)-1]["type"] != "done" {
		t.Fatalf("events: %#v", events)
	}
	var text strings.Builder
	for _, event := range events {
		if event["type"] == "delta" {
			text.WriteString(event["text"].(string))
		}
	}
	if text.String() != "你好" {
		t.Fatal(text.String())
	}
	seen.mu.Lock()
	body, auth := string(seen.body), seen.auth
	seen.mu.Unlock()
	if auth != "Bearer sk-test-secret" || strings.Contains(body, "sk-test-secret") {
		t.Fatalf("auth: %s", auth)
	}
	if !strings.Contains(body, "1|Hello") || !strings.Contains(body, "2|World") || !strings.Contains(body, `"tools"`) {
		t.Fatalf("upstream body missing note or tools: %s", body)
	}
	var outbound struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(seen.body, &outbound); err != nil {
		t.Fatal(err)
	}
	if outbound.Model != "test-model" {
		t.Fatal(outbound.Model)
	}
	agent, err := s.agentService()
	if err != nil {
		t.Fatal(err)
	}
	conversations, err := agent.ListConversations()
	if err != nil || len(conversations) != 1 || conversations[0].Title != "改一下" || conversations[0].NotePath != "日记.md" {
		t.Fatalf("conversations: %+v %v", conversations, err)
	}
	_, messages, err := agent.GetConversation(conversations[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Content != "改一下" || strings.Contains(messages[0].Content, "Hello") || messages[1].Content != "你好" {
		t.Fatalf("stored: %+v", messages)
	}
}

func TestAgentChatStreamsToolCalls(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	arguments := `{"edits":[{"search":"你好","replace":"世界"}]}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		payloads := []any{
			map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_1", "type": "function", "function": map[string]string{"name": "edit_note", "arguments": ""}}}}}}},
			map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]string{"arguments": arguments}}}}}}},
			map[string]any{"choices": []any{map[string]any{"delta": map[string]any{}, "finish_reason": "tool_calls"}}},
		}
		for _, payload := range payloads {
			data, _ := json.Marshal(payload)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	h := NewHandler(attachStore(s), false)
	enableAgent(t, h, upstream.URL+"/v1")
	rr := request(t, h, "POST", "/api/agent/chat", map[string]any{"mode": "chat", "message": "改"})
	if rr.Code != 200 {
		t.Fatalf("chat: %d %s", rr.Code, rr.Body.String())
	}
	events := decodeSSE(t, rr.Body.String())
	var kinds []string
	var args strings.Builder
	for _, event := range events {
		kinds = append(kinds, event["type"].(string))
		if event["type"] == "tool_delta" {
			args.WriteString(event["arguments"].(string))
		}
		if event["type"] == "tool_end" && event["arguments"] != arguments {
			t.Fatalf("tool_end: %#v", event)
		}
	}
	if !containsAll(kinds, "tool_start", "tool_delta", "tool_end", "done") || args.String() != arguments {
		t.Fatalf("events %v args %s", kinds, args.String())
	}
	agent, _ := s.agentService()
	conversations, _ := agent.ListConversations()
	_, messages, err := agent.GetConversation(conversations[0].ID)
	if err != nil || len(messages) != 3 || messages[1].ToolCalls[0].Name != "edit_note" || messages[2].Content != outcomeText("", "") {
		t.Fatalf("stored %#v %v", messages, err)
	}
	if err = agent.SetOutcome(messages[1].ID, "accepted", ""); err != nil {
		t.Fatal(err)
	}
	_, messages, _ = agent.GetConversation(conversations[0].ID)
	if !strings.Contains(messages[2].Content, "保留") {
		t.Fatal(messages[2].Content)
	}
}

func TestAgentChatReadsPlainJSONAndReasoning(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		fmt.Fprint(w, `{"choices":[{"message":{"reasoning_content":"先想","content":"再答"}}]}`)
	}))
	defer upstream.Close()
	h := NewHandler(attachStore(s), false)
	enableAgent(t, h, upstream.URL+"/v1")
	rr := request(t, h, "POST", "/api/agent/chat", map[string]any{"mode": "chat", "message": "你好"})
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), "先想") || !strings.Contains(rr.Body.String(), "再答") {
		t.Fatalf("plain json: %d %s", rr.Code, rr.Body.String())
	}
}

func TestAgentChatReportsEmptyModelOutput(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", `{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}`)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	h := NewHandler(attachStore(s), false)
	enableAgent(t, h, upstream.URL+"/v1")
	rr := request(t, h, "POST", "/api/agent/chat", map[string]any{"mode": "chat", "message": "你好"})
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), "模型没有返回内容") {
		t.Fatalf("empty: %d %s", rr.Code, rr.Body.String())
	}
}

func TestAgentChatSavesPartialWhenCancelled(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	started := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		fmt.Fprintf(w, "data: %s\n\n", `{"choices":[{"delta":{"content":"部分"}}]}`)
		flusher.Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer upstream.Close()
	h := NewHandler(attachStore(s), false)
	enableAgent(t, h, upstream.URL+"/v1")
	payload, _ := json.Marshal(map[string]any{"mode": "chat", "message": "停一下"})
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/agent/chat", bytes.NewReader(payload))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rr := &lockedResponse{ResponseRecorder: httptest.NewRecorder()}
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(rr, req)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(rr.String(), "部分") {
		if time.Now().After(deadline) {
			t.Fatal("partial text was not streamed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return")
	}
	agent, err := s.agentService()
	if err != nil {
		t.Fatal(err)
	}
	conversations, err := agent.ListConversations()
	if err != nil || len(conversations) != 1 {
		t.Fatalf("conversations: %+v %v", conversations, err)
	}
	_, messages, err := agent.GetConversation(conversations[0].ID)
	if err != nil || len(messages) != 2 || messages[1].Content != "部分" {
		t.Fatalf("partial: %#v %v", messages, err)
	}
}

func TestAgentContextDropsOldTurns(t *testing.T) {
	cfg := defaultAgentConfig()
	cfg.SystemPrompt = "s"
	cfg.ContextTokens = 500
	cfg.MaxOutputTokens = 50
	history := make([]AgentMessage, 0, 20)
	for i := 0; i < 10; i++ {
		history = append(history, AgentMessage{Role: "user", Content: strings.Repeat("a", 400) + fmt.Sprintf(" MARK%d", i)})
	}
	messages := buildModelMessages(cfg, "chat", "", "", history)
	encoded, _ := json.Marshal(messages)
	text := string(encoded)
	if !strings.Contains(text, "MARK9") || strings.Contains(text, "MARK0") {
		t.Fatalf("history was not trimmed: %s", text)
	}
	note := buildModelMessages(cfg, "note", "日记.md", "Hello", []AgentMessage{{Role: "user", Content: "改"}})
	noteText, _ := json.Marshal(note)
	if !strings.Contains(string(noteText), "1|Hello") {
		t.Fatal(string(noteText))
	}
	rejected := buildModelMessages(defaultAgentConfig(), "chat", "", "", []AgentMessage{
		{Role: "user", Content: "旧问题"},
		{Role: "assistant", Content: "", ToolCalls: []AgentToolCall{{ID: "c", Name: "edit_note", Arguments: "{}"}}},
		{Role: "tool", ToolCallID: "c", Content: outcomeText("rejected", "")},
		{Role: "user", Content: "新问题"},
	})
	rejectedText, _ := json.Marshal(rejected)
	if !strings.Contains(string(rejectedText), "撤销") || !strings.Contains(string(rejectedText), "新问题") {
		t.Fatal(string(rejectedText))
	}
}

func decodeSSE(t *testing.T, body string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, block := range strings.Split(body, "\n\n") {
		block = strings.TrimSpace(block)
		if !strings.HasPrefix(block, "data:") {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(block, "data:"))), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if len(events) == 0 {
		t.Fatalf("no events in %s", body)
	}
	return events
}

type lockedResponse struct {
	*httptest.ResponseRecorder
	mu sync.Mutex
}

func (r *lockedResponse) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ResponseRecorder.Write(p)
}

func (r *lockedResponse) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.Body.String()
}

func containsAll(values []string, wants ...string) bool {
	seen := map[string]bool{}
	for _, value := range values {
		seen[value] = true
	}
	for _, want := range wants {
		if !seen[want] {
			return false
		}
	}
	return true
}
