package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const noteToolsJSON = `[
  {"type":"function","function":{"name":"edit_note","description":"用精确查找替换修改当前笔记。每处 search 必须与笔记原文逐字一致且只出现一次，不要包含行号前缀。可一次提交多处互不重叠的修改，并先写 search 再写 replace。","parameters":{"type":"object","properties":{"edits":{"type":"array","description":"按原文出现顺序排列的修改","items":{"type":"object","properties":{"search":{"type":"string","description":"要替换的原文，必须完全匹配且唯一"},"replace":{"type":"string","description":"替换后的文本，可为空字符串表示删除"}},"required":["search","replace"]}}},"required":["edits"]}}},
  {"type":"function","function":{"name":"append_to_note","description":"把文本追加到当前笔记末尾。","parameters":{"type":"object","properties":{"text":{"type":"string","description":"要追加的文本"}},"required":["text"]}}},
  {"type":"function","function":{"name":"rewrite_note","description":"用新内容整篇替换当前笔记。只在需要重写大部分内容时使用。","parameters":{"type":"object","properties":{"content":{"type":"string","description":"替换后的完整笔记"}},"required":["content"]}}}
]`

func init() {
	if !json.Valid([]byte(noteToolsJSON)) {
		panic("note tools JSON is invalid")
	}
}

var agentHTTP = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 90 * time.Second,
		ExpectContinueTimeout: time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("重定向次数过多")
		}
		if req.URL.Scheme != "https" && req.URL.Scheme != "http" {
			return fmt.Errorf("不允许的重定向")
		}
		return nil
	},
}

type apiMessage struct {
	Role       string        `json:"role"`
	Content    *string       `json:"content,omitempty"`
	ToolCalls  []apiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

type apiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type completionRequest struct {
	Model       string          `json:"model"`
	Messages    []apiMessage    `json:"messages"`
	Temperature float64         `json:"temperature"`
	MaxTokens   int             `json:"max_tokens"`
	Stream      bool            `json:"stream"`
	Tools       json.RawMessage `json:"tools,omitempty"`
}

type agentEvent struct {
	Type           string `json:"type"`
	ConversationID string `json:"conversationId,omitempty"`
	Title          string `json:"title,omitempty"`
	UserMessageID  string `json:"userMessageId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	Text           string `json:"text,omitempty"`
	ID             string `json:"id,omitempty"`
	Name           string `json:"name,omitempty"`
	Arguments      string `json:"arguments,omitempty"`
	Error          string `json:"error,omitempty"`
}

func apiText(role, content string) apiMessage {
	text := content
	return apiMessage{Role: role, Content: &text}
}

func estimateTokens(text string) int {
	if text == "" {
		return 0
	}
	ascii, other := 0, 0
	for _, r := range text {
		if r <= 127 {
			ascii++
		} else {
			other++
		}
	}
	// Over-estimate so a long note is trimmed before it overflows the window.
	return (ascii+3)/4 + other*2
}

func messageTokens(message AgentMessage) int {
	n := 4 + estimateTokens(message.Role) + estimateTokens(message.Content) + estimateTokens(message.ToolCallID)
	for _, call := range message.ToolCalls {
		n += 4 + estimateTokens(call.Name) + estimateTokens(call.Arguments)
	}
	return n
}

func conversationTitle(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	runes := []rune(message)
	if len(runes) == 0 {
		return "新的对话"
	}
	if len(runes) > 30 {
		return string(runes[:30]) + "…"
	}
	return message
}

func clipText(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

func numberedNote(content string, maxTokens int) string {
	if maxTokens < 32 {
		maxTokens = 32
	}
	lines := strings.Split(content, "\n")
	var b strings.Builder
	used := 0
	for i, line := range lines {
		row := fmt.Sprintf("%d|%s\n", i+1, line)
		cost := estimateTokens(row)
		if used+cost > maxTokens {
			b.WriteString("…|（后面的内容因上下文长度被截断）\n")
			break
		}
		b.WriteString(row)
		used += cost
	}
	return b.String()
}

func noteInstructions(path, content string, maxTokens int) string {
	var b strings.Builder
	b.WriteString("你正在笔记模式下工作，只能修改用户当前打开的这一篇笔记。需要修改笔记时必须调用工具，不要把整篇新笔记直接写在回复里。\n")
	b.WriteString("工具规则：\n")
	b.WriteString("- 局部修改用 edit_note。每处 search 必须与笔记原文逐字一致（不要包含行号前缀），并且在全文中只出现一次。可以一次提交多处互不重叠的修改。请先输出 search，再输出 replace。\n")
	b.WriteString("- 只在文末追加内容时用 append_to_note。\n")
	b.WriteString("- 只有需要重写大部分内容时才用 rewrite_note。\n")
	b.WriteString("- 可以先用一两句话说明打算做什么。\n")
	if path != "" {
		b.WriteString("当前笔记路径：")
		b.WriteString(path)
		b.WriteString("\n")
	}
	b.WriteString("下面是当前笔记全文。每一行开头的“行号|”只用于定位，不属于笔记原文。\n")
	b.WriteString(numberedNote(content, maxTokens))
	return b.String()
}

func groupTurns(messages []AgentMessage) [][]AgentMessage {
	var turns [][]AgentMessage
	for _, message := range messages {
		if len(turns) == 0 || message.Role == "user" {
			turns = append(turns, nil)
		}
		turns[len(turns)-1] = append(turns[len(turns)-1], message)
	}
	return turns
}

func turnToAPI(turn []AgentMessage) []apiMessage {
	out := make([]apiMessage, 0, len(turn))
	for _, message := range turn {
		switch message.Role {
		case "user":
			out = append(out, apiText("user", message.Content))
		case "assistant":
			text := message.Content
			item := apiMessage{Role: "assistant", Content: &text}
			for _, call := range message.ToolCalls {
				var tool apiToolCall
				tool.ID = call.ID
				tool.Type = "function"
				tool.Function.Name = call.Name
				tool.Function.Arguments = call.Arguments
				item.ToolCalls = append(item.ToolCalls, tool)
			}
			out = append(out, item)
		case "tool":
			text := message.Content
			out = append(out, apiMessage{Role: "tool", Content: &text, ToolCallID: message.ToolCallID})
		}
	}
	return out
}

func trimHistory(history []AgentMessage, budget int) []apiMessage {
	turns := groupTurns(history)
	kept := make([][]AgentMessage, 0, len(turns))
	used := 0
	for i := len(turns) - 1; i >= 0; i-- {
		cost := 0
		for _, message := range turns[i] {
			cost += messageTokens(message)
		}
		if len(kept) > 0 && used+cost > budget {
			break
		}
		kept = append(kept, turns[i])
		used += cost
	}
	out := make([]apiMessage, 0, len(history))
	for i := len(kept) - 1; i >= 0; i-- {
		out = append(out, turnToAPI(kept[i])...)
	}
	return out
}

func buildModelMessages(cfg AgentConfig, mode, notePath, noteContent string, history []AgentMessage) []apiMessage {
	system := strings.TrimSpace(cfg.SystemPrompt)
	if system == "" {
		system = defaultAgentSystemPrompt
	}
	messages := []apiMessage{apiText("system", system)}
	noteTokens := 0
	if mode == "note" {
		budget := cfg.ContextTokens - cfg.MaxOutputTokens - estimateTokens(system) - 256
		if budget < 256 {
			budget = 256
		}
		note := noteInstructions(notePath, noteContent, budget)
		noteTokens = estimateTokens(note)
		messages = append(messages, apiText("system", note))
	}
	historyBudget := cfg.ContextTokens - cfg.MaxOutputTokens - estimateTokens(system) - noteTokens
	if historyBudget < 0 {
		historyBudget = 0
	}
	return append(messages, trimHistory(history, historyBudget)...)
}

func chatCompletionsURL(base string) (string, error) {
	base, err := validateBaseURL(base)
	if err != nil {
		return "", err
	}
	if strings.HasSuffix(base, "/chat/completions") {
		return base, nil
	}
	return base + "/chat/completions", nil
}

func (h *handler) agentRoutes(w http.ResponseWriter, r *http.Request) error {
	agent, err := h.ws.current().agentService()
	if err != nil {
		return err
	}
	switch r.URL.Path {
	case "/api/agent/config":
		return agent.serveConfig(w, r)
	case "/api/agent/test":
		return agent.serveTest(w, r)
	case "/api/agent/conversations":
		return agent.serveConversations(w, r)
	case "/api/agent/chat":
		return agent.handleChat(w, r)
	case "/api/agent/messages/outcome":
		return agent.serveOutcome(w, r)
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}

func (a *Agent) serveConfig(w http.ResponseWriter, r *http.Request) error {
	switch r.Method {
	case http.MethodGet:
		view, err := a.View()
		if err != nil {
			return err
		}
		jsonResponse(w, 200, view)
		return nil
	case http.MethodPut:
		var update agentConfigUpdate
		if err := decode(r, &update); err != nil {
			return err
		}
		view, err := a.UpdateConfig(update)
		if err != nil {
			return err
		}
		jsonResponse(w, 200, view)
		return nil
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}

func (a *Agent) serveTest(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPost {
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
	var req struct {
		BaseURL string `json:"baseURL"`
		APIKey  string `json:"apiKey"`
		Model   string `json:"model"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	reply, err := a.testConnection(r.Context(), req.BaseURL, req.APIKey, req.Model)
	if err != nil {
		return err
	}
	jsonResponse(w, 200, map[string]any{"ok": true, "reply": reply})
	return nil
}

func (a *Agent) testConnection(parent context.Context, baseURL, apiKey, model string) (string, error) {
	ctx, stop, err := a.start(parent)
	if err != nil {
		return "", err
	}
	defer stop()
	cfg, err := a.Config()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(baseURL) != "" {
		cfg.BaseURL = strings.TrimSpace(baseURL)
	}
	if key := normalizeAPIKey(apiKey); key != "" {
		cfg.APIKey = key
	}
	if strings.TrimSpace(model) != "" {
		cfg.Model = strings.TrimSpace(model)
	}
	if cfg.APIKey == "" {
		return "", fmt.Errorf("请先填写 API Key")
	}
	if _, err = validateBaseURL(cfg.BaseURL); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body := completionRequest{
		Model: cfg.Model, Messages: []apiMessage{apiText("user", "ping")}, Temperature: 0, MaxTokens: 16, Stream: false,
	}
	raw, err := a.complete(ctx, cfg, body)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err = json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("模型接口返回了无法解析的内容")
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return "", fmt.Errorf("模型接口错误：%s", clipText(strings.ReplaceAll(parsed.Error.Message, cfg.APIKey, "****"), 300))
	}
	reply := ""
	if len(parsed.Choices) > 0 {
		reply = clipText(parsed.Choices[0].Message.Content, 200)
	}
	return reply, nil
}

func (a *Agent) complete(ctx context.Context, cfg AgentConfig, body completionRequest) ([]byte, error) {
	endpoint, err := chatCompletionsURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Echo")
	resp, err := agentHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接模型接口：%s", clipText(strings.ReplaceAll(err.Error(), cfg.APIKey, "****"), 300))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("读取模型接口响应失败")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, publicUpstreamError(resp.StatusCode, string(data), cfg.APIKey)
	}
	return data, nil
}

func publicUpstreamError(status int, body, key string) error {
	if key != "" {
		body = strings.ReplaceAll(body, key, "****")
	}
	body = clipText(body, 300)
	if body == "" {
		return fmt.Errorf("模型接口返回 %d", status)
	}
	return fmt.Errorf("模型接口返回 %d：%s", status, body)
}

func (a *Agent) serveConversations(w http.ResponseWriter, r *http.Request) error {
	switch r.Method {
	case http.MethodGet:
		if id := r.URL.Query().Get("id"); id != "" {
			conversation, messages, err := a.GetConversation(id)
			if err != nil {
				return err
			}
			jsonResponse(w, 200, map[string]any{"conversation": conversation, "messages": messages})
			return nil
		}
		conversations, err := a.ListConversations()
		if err != nil {
			return err
		}
		jsonResponse(w, 200, conversations)
		return nil
	case http.MethodPost:
		var req struct {
			Mode     string `json:"mode"`
			NotePath string `json:"notePath"`
		}
		if err := decode(r, &req); err != nil {
			return err
		}
		if req.Mode == "" {
			req.Mode = "note"
		}
		conversation, err := a.CreateConversation(req.Mode, strings.TrimSpace(req.NotePath), "新的对话")
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusCreated, conversation)
		return nil
	case http.MethodPut:
		var req struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		}
		if err := decode(r, &req); err != nil {
			return err
		}
		conversation, err := a.RenameConversation(req.ID, req.Title)
		if err != nil {
			return err
		}
		jsonResponse(w, 200, conversation)
		return nil
	case http.MethodDelete:
		if err := a.DeleteConversation(r.URL.Query().Get("id")); err != nil {
			return err
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return nil
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}

func (a *Agent) serveOutcome(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPatch {
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
	var req struct {
		ID      string `json:"id"`
		Outcome string `json:"outcome"`
		Detail  string `json:"detail"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if err := a.SetOutcome(req.ID, req.Outcome, req.Detail); err != nil {
		return err
	}
	jsonResponse(w, 200, map[string]bool{"ok": true})
	return nil
}

type chatPayload struct {
	ConversationID string `json:"conversationId"`
	Mode           string `json:"mode"`
	Message        string `json:"message"`
	Note           *struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	} `json:"note"`
}

func (a *Agent) handleChat(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPost {
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
	var req chatPayload
	if err := decode(r, &req); err != nil {
		return err
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		return fmt.Errorf("请输入消息")
	}
	if len(message) > 400_000 {
		return fmt.Errorf("消息过长")
	}
	if !validAgentMode(req.Mode) {
		return fmt.Errorf("无效的对话模式")
	}
	notePath, noteContent := "", ""
	if req.Note != nil {
		notePath = strings.TrimSpace(req.Note.Path)
		noteContent = req.Note.Content
	}
	if len(noteContent) > 2*1024*1024 {
		return fmt.Errorf("笔记内容过长")
	}
	if req.Mode == "note" && notePath == "" {
		return fmt.Errorf("笔记模式需要打开一篇笔记")
	}
	ctx, stop, err := a.start(r.Context())
	if err != nil {
		return err
	}
	defer stop()
	cfg, err := a.Config()
	if err != nil {
		return err
	}
	if !cfg.Enabled {
		return fmt.Errorf("请先在设置中开启 Agent")
	}
	if cfg.APIKey == "" {
		return fmt.Errorf("请先配置 API Key")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return fmt.Errorf("请先配置模型")
	}

	var conversation AgentConversation
	var history []AgentMessage
	title := conversationTitle(message)
	if req.ConversationID == "" {
		conversation, err = a.CreateConversation(req.Mode, notePath, title)
	} else {
		conversation, history, err = a.GetConversation(req.ConversationID)
		if err == nil {
			title = conversation.Title
			hasUser := false
			for _, item := range history {
				if item.Role == "user" {
					hasUser = true
					break
				}
			}
			if !hasUser && (title == "" || title == "新的对话") {
				title = conversationTitle(message)
			}
			if notePath == "" {
				notePath = conversation.NotePath
			}
		}
	}
	if err != nil {
		return err
	}
	saved, err := a.AddMessages(conversation.ID, req.Mode, notePath, title, []AgentMessage{{Role: "user", Content: message}})
	if err != nil {
		return err
	}
	userMessage := saved[0]
	history = append(history, userMessage)
	messages := buildModelMessages(cfg, req.Mode, notePath, noteContent, history)
	body := completionRequest{Model: cfg.Model, Messages: messages, Temperature: cfg.Temperature, MaxTokens: cfg.MaxOutputTokens, Stream: true}
	if req.Mode == "note" {
		body.Tools = json.RawMessage(noteToolsJSON)
	}
	resp, err := a.openStream(ctx, cfg, body)
	if err != nil {
		writeAgentFailure(w, http.StatusBadGateway, err, conversation.ID, title)
		return nil
	}
	defer resp.Body.Close()
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAgentFailure(w, http.StatusInternalServerError, fmt.Errorf("当前连接不支持流式输出"), conversation.ID, title)
		return nil
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if err = writeAgentEvent(w, flusher, agentEvent{Type: "meta", ConversationID: conversation.ID, Title: title, UserMessageID: userMessage.ID}); err != nil {
		return nil
	}
	content, calls, streamErr := readUpstream(ctx, resp.Body, func(event agentEvent) error {
		return writeAgentEvent(w, flusher, event)
	})
	var assistantID string
	if content != "" || len(calls) > 0 || (streamErr == nil && ctx.Err() == nil) {
		batch := []AgentMessage{{Role: "assistant", Content: content, ToolCalls: calls}}
		for _, call := range calls {
			batch = append(batch, AgentMessage{Role: "tool", ToolCallID: call.ID, Content: outcomeText("", "")})
		}
		stored, saveErr := a.AddMessages(conversation.ID, req.Mode, notePath, title, batch)
		if saveErr == nil && len(stored) > 0 {
			assistantID = stored[0].ID
		} else if streamErr == nil {
			streamErr = saveErr
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	if streamErr != nil {
		_ = writeAgentEvent(w, flusher, agentEvent{Type: "error", Error: clipText(strings.ReplaceAll(streamErr.Error(), cfg.APIKey, "****"), 300), ConversationID: conversation.ID, MessageID: assistantID})
	}
	if assistantID != "" {
		_ = writeAgentEvent(w, flusher, agentEvent{Type: "done", ConversationID: conversation.ID, MessageID: assistantID})
	}
	return nil
}

func writeAgentFailure(w http.ResponseWriter, status int, err error, conversationID, title string) {
	jsonResponse(w, status, map[string]any{"error": err.Error(), "conversationId": conversationID, "title": title})
}

func writeAgentEvent(w http.ResponseWriter, flusher http.Flusher, event agentEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func (a *Agent) openStream(ctx context.Context, cfg AgentConfig, body completionRequest) (*http.Response, error) {
	endpoint, err := chatCompletionsURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "Echo")
	resp, err := agentHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接模型接口：%s", clipText(strings.ReplaceAll(err.Error(), cfg.APIKey, "****"), 300))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return nil, publicUpstreamError(resp.StatusCode, string(data), cfg.APIKey)
	}
	return resp, nil
}

type upstreamChunk struct {
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}

type toolBuf struct {
	index     int
	id        string
	name      string
	args      strings.Builder
	emitted   int
	announced bool
}

func readUpstream(ctx context.Context, body io.Reader, emit func(agentEvent) error) (string, []AgentToolCall, error) {
	reader := bufio.NewReaderSize(body, 64*1024)
	tools := map[int]*toolBuf{}
	var order []int
	var text strings.Builder
	closed := false
	closeTools := func() error {
		if closed {
			return nil
		}
		closed = true
		for _, index := range order {
			buf := tools[index]
			if buf == nil || !buf.announced {
				continue
			}
			if err := emit(agentEvent{Type: "tool_end", ID: buf.id, Name: buf.name, Arguments: buf.args.String()}); err != nil {
				return err
			}
		}
		return nil
	}
	for {
		if err := ctx.Err(); err != nil {
			_ = closeTools()
			return text.String(), toolCallsFrom(tools, order), err
		}
		raw, readErr := reader.ReadString('\n')
		if len(raw) > 8<<20 {
			return text.String(), toolCallsFrom(tools, order), fmt.Errorf("模型接口返回了过长的数据")
		}
		line := strings.TrimSpace(raw)
		if line != "" {
			if strings.HasPrefix(line, "data:") {
				payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if payload == "[DONE]" {
					if err := closeTools(); err != nil {
						return text.String(), toolCallsFrom(tools, order), err
					}
					return text.String(), toolCallsFrom(tools, order), nil
				}
				if payload != "" {
					finished, err := applyUpstreamPayload(payload, &text, tools, &order, emit)
					if err != nil {
						return text.String(), toolCallsFrom(tools, order), err
					}
					if finished {
						if err = closeTools(); err != nil {
							return text.String(), toolCallsFrom(tools, order), err
						}
					}
				}
			} else if !strings.HasPrefix(line, ":") && !strings.HasPrefix(line, "event:") && !strings.HasPrefix(line, "id:") && !strings.HasPrefix(line, "retry:") {
				var probe struct {
					Error *struct {
						Message string `json:"message"`
					} `json:"error"`
				}
				if json.Unmarshal([]byte(line), &probe) == nil && probe.Error != nil && probe.Error.Message != "" {
					return text.String(), toolCallsFrom(tools, order), errors.New(clipText(probe.Error.Message, 300))
				}
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				if err := closeTools(); err != nil {
					return text.String(), toolCallsFrom(tools, order), err
				}
				return text.String(), toolCallsFrom(tools, order), nil
			}
			_ = closeTools()
			return text.String(), toolCallsFrom(tools, order), readErr
		}
	}
}

func applyUpstreamPayload(payload string, text *strings.Builder, tools map[int]*toolBuf, order *[]int, emit func(agentEvent) error) (bool, error) {
	var chunk upstreamChunk
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return false, fmt.Errorf("无法解析模型输出")
	}
	if chunk.Error != nil && chunk.Error.Message != "" {
		return false, errors.New(clipText(chunk.Error.Message, 300))
	}
	finished := false
	for _, choice := range chunk.Choices {
		if choice.Delta.Content != "" {
			text.WriteString(choice.Delta.Content)
			if err := emit(agentEvent{Type: "delta", Text: choice.Delta.Content}); err != nil {
				return false, err
			}
		}
		for _, call := range choice.Delta.ToolCalls {
			buf := tools[call.Index]
			if buf == nil {
				buf = &toolBuf{index: call.Index}
				tools[call.Index] = buf
				*order = append(*order, call.Index)
			}
			if call.ID != "" {
				buf.id = call.ID
			}
			if call.Function.Name != "" {
				buf.name += call.Function.Name
			}
			if call.Function.Arguments != "" {
				buf.args.WriteString(call.Function.Arguments)
			}
			if !buf.announced && buf.name != "" {
				if buf.id == "" {
					buf.id = fmt.Sprintf("tool-%d", buf.index)
				}
				buf.announced = true
				if err := emit(agentEvent{Type: "tool_start", ID: buf.id, Name: buf.name}); err != nil {
					return false, err
				}
			}
			if buf.announced && buf.args.Len() > buf.emitted {
				chunk := buf.args.String()[buf.emitted:]
				buf.emitted = buf.args.Len()
				if err := emit(agentEvent{Type: "tool_delta", ID: buf.id, Arguments: chunk}); err != nil {
					return false, err
				}
			}
		}
		if choice.FinishReason != nil && *choice.FinishReason != "" {
			finished = true
		}
	}
	return finished, nil
}

func toolCallsFrom(tools map[int]*toolBuf, order []int) []AgentToolCall {
	calls := make([]AgentToolCall, 0, len(order))
	for _, index := range order {
		buf := tools[index]
		if buf == nil || !buf.announced {
			continue
		}
		calls = append(calls, AgentToolCall{ID: buf.id, Name: buf.name, Arguments: buf.args.String()})
	}
	return calls
}
