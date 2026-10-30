package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWordCountSkipsSpaces(t *testing.T) {
	if got := wordCount("你好 世界\n"); got != 4 {
		t.Fatalf("spaces: %d", got)
	}
	if got := wordCount("# 标题\n\n你好 世界"); got != 7 {
		t.Fatalf("markdown: %d", got)
	}
	if got := wordCount("a\u3000b"); got != 2 {
		t.Fatalf("ideographic space: %d", got)
	}
}

func TestNoteCreatedTimeStaysStableAcrossSaveMoveAndTrash(t *testing.T) {
	const sentinel = "2020-01-02T03:04:05Z"
	s := testStore(t)
	note := create(t, s, "项目/资料/纪要.md", "# 标题\n\n你好 世界")
	if note.Created == "" {
		t.Fatal("missing created time")
	}
	if note.Words != 7 {
		t.Fatalf("words %d", note.Words)
	}
	s.state.NoteCreated[note.Path] = sentinel
	if err := s.persist(); err != nil {
		t.Fatal(err)
	}
	saved, err := s.saveNote(note.Path, "# 标题\n\n你好 世界\n又写了一句", note.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Created != sentinel {
		t.Fatalf("save changed created to %s", saved.Created)
	}
	if saved.Words != wordCount(saved.Content) {
		t.Fatalf("words %d", saved.Words)
	}
	reopened, err := Open(s.root)
	if err != nil {
		t.Fatal(err)
	}
	again, err := reopened.readNote(note.Path)
	if err != nil || again.Created != sentinel {
		t.Fatalf("reopen %q %v", again.Created, err)
	}
	if _, err = s.move("项目", "归档", "", true); err != nil {
		t.Fatal(err)
	}
	movedPath := "归档/资料/纪要.md"
	if s.state.NoteCreated[movedPath] != sentinel {
		t.Fatalf("moved created %#v", s.state.NoteCreated)
	}
	if _, ok := s.state.NoteCreated[note.Path]; ok {
		t.Fatal("old path still recorded")
	}
	if s.state.NoteCreated["欢迎使用 Echo.md"] == "" {
		t.Fatal("welcome created was dropped")
	}
	moved, err := s.readNote(movedPath)
	if err != nil || moved.Created != sentinel {
		t.Fatalf("read moved %q %v", moved.Created, err)
	}
	if err = s.recycle(movedPath); err != nil {
		t.Fatal(err)
	}
	entry := s.state.Trash[len(s.state.Trash)-1]
	if entry.Created != sentinel {
		t.Fatalf("trash created %s", entry.Created)
	}
	s.state.NoteCreated[movedPath] = "2024-05-06T07:08:09Z"
	if err = s.restore(entry.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := s.readNote(movedPath)
	if err != nil || restored.Created != sentinel {
		t.Fatalf("restore %q %v", restored.Created, err)
	}
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "GET", "/api/notes", nil)
	if rr.Code != 200 {
		t.Fatal(rr.Body.String())
	}
	var listed []Note
	if err = json.Unmarshal(rr.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	var found Note
	for _, item := range listed {
		if item.Path == movedPath {
			found = item
		}
	}
	if found.Content != "" || found.Created != sentinel || found.Words != restored.Words {
		t.Fatalf("list %+v", found)
	}
}

func TestExternalNoteCreationIsFrozen(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "外来.md")
	if err := os.WriteFile(file, []byte("甲乙"), 0644); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-72 * time.Hour)
	if err := os.Chtimes(file, past, past); err != nil {
		t.Fatal(err)
	}
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.readNote("外来.md")
	if err != nil || note.Created == "" || note.Words != 2 {
		t.Fatalf("%+v %v", note, err)
	}
	if err = os.Chtimes(file, time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	saved, err := s.saveNote(note.Path, "甲乙丙", note.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Created != note.Created || saved.Words != 3 {
		t.Fatalf("created %s -> %s words %d", note.Created, saved.Created, saved.Words)
	}
}
