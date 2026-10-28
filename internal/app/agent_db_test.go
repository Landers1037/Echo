package app

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
)

func openTestAgent(t *testing.T) (*Store, *Agent) {
	t.Helper()
	s := testStore(t)
	t.Cleanup(func() { s.closeAgent() })
	agent, err := s.agentService()
	if err != nil {
		t.Fatal(err)
	}
	return s, agent
}

func TestAgentConversationLifecycle(t *testing.T) {
	s, agent := openTestAgent(t)
	created, err := agent.CreateConversation("note", "日记.md", "")
	if err != nil {
		t.Fatal(err)
	}
	if created.Title != "新的对话" || created.Mode != "note" || created.NotePath != "日记.md" || created.ID == "" {
		t.Fatalf("conversation: %+v", created)
	}
	saved, err := agent.AddMessages(created.ID, "note", "日记.md", "第一句", []AgentMessage{{Role: "user", Content: "帮我改标题"}})
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := agent.AddMessages(created.ID, "note", "日记.md", "第一句", []AgentMessage{
		{Role: "assistant", Content: "好", ToolCalls: []AgentToolCall{{ID: "call-1", Name: "edit_note", Arguments: `{"edits":[]}`}}},
		{Role: "tool", ToolCallID: "call-1", Content: outcomeText("", "")},
	})
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := agent.RenameConversation(created.ID, "  周记  ")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Title != "周记" {
		t.Fatal(renamed.Title)
	}
	if _, err = agent.RenameConversation(created.ID, ""); err == nil {
		t.Fatal("expected empty title to fail")
	}
	listed, err := agent.ListConversations()
	if err != nil || len(listed) != 1 || listed[0].Title != "周记" {
		t.Fatalf("list: %+v %v", listed, err)
	}
	loaded, messages, err := agent.GetConversation(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Title != "周记" || len(messages) != 3 || messages[0].ID != saved[0].ID || messages[1].ToolCalls[0].Name != "edit_note" || messages[2].Role != "tool" {
		t.Fatalf("messages: %+v", messages)
	}
	if err = agent.SetOutcome(assistant[0].ID, "rejected", "找不到匹配文本"); err != nil {
		t.Fatal(err)
	}
	_, messages, err = agent.GetConversation(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if messages[1].Outcome != "rejected" || messages[2].Content != outcomeText("rejected", "找不到匹配文本") {
		t.Fatalf("outcome: %+v %+v", messages[1], messages[2])
	}
	if err = agent.DeleteConversation(created.ID); err != nil {
		t.Fatal(err)
	}
	var left int
	if err = agent.withDB(func(db *sql.DB) error { return db.QueryRow(`SELECT COUNT(1) FROM messages`).Scan(&left) }); err != nil || left != 0 {
		t.Fatalf("orphaned messages %d: %v", left, err)
	}
	if _, _, err = agent.GetConversation(created.ID); !errors.Is(err, os.ErrNotExist) || err.Error() != "找不到该对话" {
		t.Fatalf("delete: %v", err)
	}
	agent.shutdown()
	reopened, err := openAgent(s.root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.shutdown()
	listed, err = reopened.ListConversations()
	if err != nil || len(listed) != 0 {
		t.Fatalf("reopen: %+v %v", listed, err)
	}
	var version int
	if err = reopened.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		t.Fatalf("version %d: %v", version, err)
	}
}

func TestAgentCloseCancelsRequests(t *testing.T) {
	s, agent := openTestAgent(t)
	ctx, stop, err := agent.start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		<-ctx.Done()
		stop()
	}()
	s.closeAgent()
	if ctx.Err() == nil {
		t.Fatal("expected the request to be cancelled")
	}
	if _, err = s.agentService(); !errors.Is(err, errAgentClosed) {
		t.Fatal(err)
	}
}
