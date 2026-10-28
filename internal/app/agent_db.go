package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const agentSchemaVersion = 1

var errAgentClosed = errors.New("笔记库已关闭")

type AgentToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type AgentConversation struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Mode      string `json:"mode"`
	NotePath  string `json:"notePath"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type AgentMessage struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	Role           string          `json:"role"`
	Content        string          `json:"content"`
	ToolCalls      []AgentToolCall `json:"toolCalls,omitempty"`
	ToolCallID     string          `json:"toolCallId,omitempty"`
	Outcome        string          `json:"outcome,omitempty"`
	CreatedAt      string          `json:"createdAt"`
}

type Agent struct {
	mu       sync.Mutex
	root     string
	db       *sql.DB
	closed   bool
	inflight sync.WaitGroup
	seq      uint64
	cancels  map[uint64]context.CancelFunc
}

func agentNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
}

func validAgentMode(mode string) bool {
	return mode == "note" || mode == "chat"
}

func sqliteDSN(path string) string {
	slash := filepath.ToSlash(path)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	return (&url.URL{
		Scheme:   "file",
		Path:     slash,
		RawQuery: "_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)",
	}).String()
}

func openAgent(root string) (*Agent, error) {
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		return nil, err
	}
	dbPath := filepath.Join(root, ".echo", "agent.db")
	db, err := sql.Open("sqlite", sqliteDSN(dbPath))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		_ = db.Close()
		return nil, err
	}
	agent := &Agent{root: root, db: db, cancels: map[uint64]context.CancelFunc{}}
	if err = agent.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return agent, nil
}

func (a *Agent) migrate() error {
	var version int
	if err := a.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > agentSchemaVersion {
		return fmt.Errorf("聊天记录由更新版本的 Echo 创建，请升级后再打开")
	}
	if version == agentSchemaVersion {
		return nil
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	schema := `
CREATE TABLE conversations (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	mode TEXT NOT NULL,
	note_path TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	role TEXT NOT NULL,
	content TEXT NOT NULL DEFAULT '',
	tool_calls TEXT NOT NULL DEFAULT '',
	tool_call_id TEXT NOT NULL DEFAULT '',
	outcome TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	UNIQUE (conversation_id, seq)
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);
`
	if _, err = tx.Exec(schema); err != nil {
		return err
	}
	if _, err = tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", agentSchemaVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) agentService() (*Agent, error) {
	s.agentMu.Lock()
	defer s.agentMu.Unlock()
	if s.agentClosed {
		return nil, errAgentClosed
	}
	if s.agent != nil {
		return s.agent, nil
	}
	agent, err := openAgent(s.root)
	if err != nil {
		return nil, err
	}
	s.agent = agent
	return agent, nil
}

func (s *Store) closeAgent() {
	s.agentMu.Lock()
	s.agentClosed = true
	agent := s.agent
	s.agentMu.Unlock()
	if agent != nil {
		agent.shutdown()
	}
}

func (a *Agent) shutdown() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		a.inflight.Wait()
		return
	}
	a.closed = true
	cancels := make([]context.CancelFunc, 0, len(a.cancels))
	for _, cancel := range a.cancels {
		cancels = append(cancels, cancel)
	}
	a.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	a.inflight.Wait()
	a.mu.Lock()
	if a.db != nil {
		_ = a.db.Close()
		a.db = nil
	}
	a.mu.Unlock()
}

// start tracks an in-flight request so closing the notebook can cancel it
// before the database is closed.
func (a *Agent) start(ctx context.Context) (context.Context, func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.db == nil {
		return nil, nil, errAgentClosed
	}
	ctx, cancel := context.WithCancel(ctx)
	a.seq++
	id := a.seq
	a.cancels[id] = cancel
	a.inflight.Add(1)
	return ctx, func() {
		cancel()
		a.mu.Lock()
		delete(a.cancels, id)
		a.mu.Unlock()
		a.inflight.Done()
	}, nil
}

func (a *Agent) withDB(fn func(*sql.DB) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db == nil {
		return errAgentClosed
	}
	return fn(a.db)
}

func encodeToolCalls(calls []AgentToolCall) (string, error) {
	if len(calls) == 0 {
		return "", nil
	}
	data, err := json.Marshal(calls)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeToolCalls(raw string) ([]AgentToolCall, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var calls []AgentToolCall
	if err := json.Unmarshal([]byte(raw), &calls); err != nil {
		return nil, fmt.Errorf("聊天记录中的工具调用已损坏")
	}
	return calls, nil
}

type wrappedError struct {
	message string
	cause   error
}

func (e *wrappedError) Error() string { return e.message }
func (e *wrappedError) Unwrap() error { return e.cause }

func notFound(message string) error {
	return &wrappedError{message: message, cause: os.ErrNotExist}
}

func scanConversation(row interface{ Scan(...any) error }) (AgentConversation, error) {
	var conversation AgentConversation
	err := row.Scan(&conversation.ID, &conversation.Title, &conversation.Mode, &conversation.NotePath, &conversation.CreatedAt, &conversation.UpdatedAt)
	return conversation, err
}

func scanMessage(row interface{ Scan(...any) error }) (AgentMessage, error) {
	var message AgentMessage
	var tools string
	err := row.Scan(&message.ID, &message.ConversationID, &message.Role, &message.Content, &tools, &message.ToolCallID, &message.Outcome, &message.CreatedAt)
	if err != nil {
		return AgentMessage{}, err
	}
	message.ToolCalls, err = decodeToolCalls(tools)
	return message, err
}

const conversationColumns = `id, title, mode, note_path, created_at, updated_at`
const messageColumns = `id, conversation_id, role, content, tool_calls, tool_call_id, outcome, created_at`

func (a *Agent) ListConversations() ([]AgentConversation, error) {
	var conversations []AgentConversation
	err := a.withDB(func(db *sql.DB) error {
		rows, err := db.Query(`SELECT ` + conversationColumns + ` FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			conversation, err := scanConversation(rows)
			if err != nil {
				return err
			}
			conversations = append(conversations, conversation)
		}
		return rows.Err()
	})
	if conversations == nil {
		conversations = []AgentConversation{}
	}
	return conversations, err
}

func (a *Agent) GetConversation(id string) (AgentConversation, []AgentMessage, error) {
	var conversation AgentConversation
	var messages []AgentMessage
	err := a.withDB(func(db *sql.DB) error {
		var err error
		conversation, err = scanConversation(db.QueryRow(`SELECT `+conversationColumns+` FROM conversations WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("找不到该对话")
		}
		if err != nil {
			return err
		}
		rows, err := db.Query(`SELECT `+messageColumns+` FROM messages WHERE conversation_id = ? ORDER BY seq ASC`, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			message, err := scanMessage(rows)
			if err != nil {
				return err
			}
			messages = append(messages, message)
		}
		return rows.Err()
	})
	if messages == nil {
		messages = []AgentMessage{}
	}
	return conversation, messages, err
}

func (a *Agent) CreateConversation(mode, notePath, title string) (AgentConversation, error) {
	if !validAgentMode(mode) {
		return AgentConversation{}, fmt.Errorf("无效的对话模式")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = "新的对话"
	}
	now := agentNow()
	conversation := AgentConversation{ID: newID(), Title: title, Mode: mode, NotePath: notePath, CreatedAt: now, UpdatedAt: now}
	err := a.withDB(func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO conversations (id, title, mode, note_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
			conversation.ID, conversation.Title, conversation.Mode, conversation.NotePath, conversation.CreatedAt, conversation.UpdatedAt)
		return err
	})
	return conversation, err
}

func (a *Agent) RenameConversation(id, title string) (AgentConversation, error) {
	title = strings.TrimSpace(title)
	title = strings.Join(strings.Fields(title), " ")
	if title == "" || strings.ContainsAny(title, "\r\n\x00") || len([]rune(title)) > 80 {
		return AgentConversation{}, fmt.Errorf("对话标题不能为空、不能包含换行，且不能超过 80 个字符")
	}
	var conversation AgentConversation
	err := a.withDB(func(db *sql.DB) error {
		result, err := db.Exec(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`, title, agentNow(), id)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return notFound("找不到该对话")
		}
		conversation, err = scanConversation(db.QueryRow(`SELECT `+conversationColumns+` FROM conversations WHERE id = ?`, id))
		return err
	})
	return conversation, err
}

func (a *Agent) DeleteConversation(id string) error {
	return a.withDB(func(db *sql.DB) error {
		result, err := db.Exec(`DELETE FROM conversations WHERE id = ?`, id)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return notFound("找不到该对话")
		}
		return nil
	})
}

func (a *Agent) AddMessages(conversationID string, mode, notePath, title string, messages []AgentMessage) ([]AgentMessage, error) {
	if len(messages) == 0 {
		return nil, fmt.Errorf("没有可保存的消息")
	}
	now := agentNow()
	saved := make([]AgentMessage, len(messages))
	err := a.withDB(func(db *sql.DB) error {
		var exists int
		if err := db.QueryRow(`SELECT COUNT(1) FROM conversations WHERE id = ?`, conversationID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return notFound("找不到该对话")
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		var seq int
		if err = tx.QueryRow(`SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conversation_id = ?`, conversationID).Scan(&seq); err != nil {
			return err
		}
		for i, message := range messages {
			if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
				return fmt.Errorf("无效的消息角色")
			}
			tools, err := encodeToolCalls(message.ToolCalls)
			if err != nil {
				return err
			}
			seq++
			message.ID = newID()
			message.ConversationID = conversationID
			message.CreatedAt = now
			if _, err = tx.Exec(`INSERT INTO messages (id, conversation_id, seq, role, content, tool_calls, tool_call_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				message.ID, conversationID, seq, message.Role, message.Content, tools, message.ToolCallID, message.Outcome, message.CreatedAt); err != nil {
				return err
			}
			saved[i] = message
		}
		if title == "" {
			if err = tx.QueryRow(`SELECT title FROM conversations WHERE id = ?`, conversationID).Scan(&title); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(`UPDATE conversations SET mode = ?, note_path = ?, title = ?, updated_at = ? WHERE id = ?`, mode, notePath, title, now, conversationID); err != nil {
			return err
		}
		return tx.Commit()
	})
	return saved, err
}

func outcomeText(outcome, detail string) string {
	var text string
	switch outcome {
	case "accepted":
		text = "用户保留了这次修改，当前笔记已包含这些改动。"
	case "rejected":
		text = "用户撤销了这次修改，笔记已恢复为修改前的内容。不要假设这些修改已经生效。"
	default:
		text = "修改已显示在编辑器中，等待用户确认。"
	}
	detail = strings.TrimSpace(detail)
	if detail != "" {
		text += "\n" + detail
	}
	return text
}

func (a *Agent) SetOutcome(messageID, outcome, detail string) error {
	if outcome != "accepted" && outcome != "rejected" {
		return fmt.Errorf("无效的修改结果")
	}
	if len([]rune(detail)) > 2000 {
		detail = string([]rune(detail)[:2000])
	}
	return a.withDB(func(db *sql.DB) error {
		message, err := scanMessage(db.QueryRow(`SELECT `+messageColumns+` FROM messages WHERE id = ?`, messageID))
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("找不到该消息")
		}
		if err != nil {
			return err
		}
		if message.Role != "assistant" {
			return fmt.Errorf("只能标记助手的修改结果")
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.Exec(`UPDATE messages SET outcome = ? WHERE id = ?`, outcome, messageID); err != nil {
			return err
		}
		content := outcomeText(outcome, detail)
		for _, call := range message.ToolCalls {
			if _, err = tx.Exec(`UPDATE messages SET content = ? WHERE conversation_id = ? AND role = 'tool' AND tool_call_id = ?`, content, message.ConversationID, call.ID); err != nil {
				return err
			}
		}
		return tx.Commit()
	})
}

func (a *Agent) DeleteMessage(id string) error {
	return a.withDB(func(db *sql.DB) error {
		_, err := db.Exec(`DELETE FROM messages WHERE id = ?`, id)
		return err
	})
}
