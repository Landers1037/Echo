package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func create(t *testing.T, s *Store, name, content string) Note {
	t.Helper()
	note, err := s.createNote(name, content)
	if err != nil {
		t.Fatal(err)
	}
	return note
}
func request(t *testing.T, h http.Handler, method, route string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, "http://127.0.0.1:8080"+route, reader)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestMetadataPreservesUnknownFieldsAndRejectsInvalid(t *testing.T) {
	content := "---\ntitle: Keep this\ncustom:\n  nested: yes\necho:\n  customFlag: true\n  tags: [old]\n  group: before\n---\n# My note\n"
	updated, err := writeMetadata(content, Metadata{Tags: []string{"new", "new", "  two  "}, Group: "after"})
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"title: Keep this", "nested: yes", "customFlag: true", "# My note"} {
		if !strings.Contains(updated, expected) {
			t.Errorf("lost %s: %s", expected, updated)
		}
	}
	meta, err := readMetadata(updated)
	if err != nil || meta.Group != "after" || len(meta.Tags) != 2 {
		t.Fatalf("metadata %+v %v", meta, err)
	}
	for _, invalid := range []string{"---\necho: [invalid]\n---\nBody", "---\ninvalid: [\n---\nBody", "---\nmissing end"} {
		if _, err := writeMetadata(invalid, Metadata{}); err == nil {
			t.Errorf("accepted invalid metadata %q", invalid)
		}
	}
}
func TestFileConflictAndTrashRestore(t *testing.T) {
	s := testStore(t)
	note := create(t, s, "中文/测试.md", "# First\n")
	file, _ := s.notePath(note.Path)
	if err := os.WriteFile(file, []byte("# External\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveNote(note.Path, "# Mine", note.Revision, false); err == nil {
		t.Fatal("overwrote external edit")
	}
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "PUT", "/api/notes", map[string]any{"path": note.Path, "content": "# Mine", "revision": note.Revision})
	if rr.Code != 409 {
		t.Fatalf("expected conflict got %d %s", rr.Code, rr.Body.String())
	}
	if err := s.recycle(note.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.readNote(note.Path); !os.IsNotExist(err) {
		t.Fatalf("not removed: %v", err)
	}
	if err := s.restore(s.state.Trash[len(s.state.Trash)-1].ID); err != nil {
		t.Fatal(err)
	}
	restored, err := s.readNote(note.Path)
	if err != nil || restored.Content != "# External\n" {
		t.Fatalf("restore: %+v %v", restored, err)
	}
}
func TestPathAndOriginGuards(t *testing.T) {
	s := testStore(t)
	for _, name := range []string{"../outside.md", "a/../../b.md", "C:/secret.md", "/abs.md", ".echo/state.json", ".ECHO/state.json", "a/../b.md", "a. /b.md"} {
		if _, err := s.safePath(name); err == nil {
			t.Errorf("accepted %s", name)
		}
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.root, "linked")); err == nil {
		if _, err = s.safePath("linked/file.md"); err == nil {
			t.Fatal("accepted symlink")
		}
	}
	h := NewHandler(attachStore(s), false)
	req := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/notes", strings.NewReader(`{"path":"evil.md"}`))
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 403 {
		t.Fatalf("origin accepted: %d", rr.Code)
	}
	req = httptest.NewRequest("GET", "http://rebind.evil/api/notes", nil)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 403 {
		t.Fatal("non-local host accepted")
	}
}
func TestMoveRewritesOwnAndIncomingLinks(t *testing.T) {
	s := testStore(t)
	note := create(t, s, "old/note.md", "# Move\n![image](../.assets/a.png)\n[Other](../other.md)\n")
	create(t, s, "other.md", "# Other\n[Moved](old/note.md)\n")
	asset, _ := s.safePath(".assets/a.png")
	if err := atomicWrite(asset, []byte("image"), 0644); err != nil {
		t.Fatal(err)
	}
	moved, err := s.move(note.Path, "new/deep/note.md", note.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(moved.Content, "../../.assets/a.png") || !strings.Contains(moved.Content, "../../other.md") {
		t.Fatalf("bad moved links %s", moved.Content)
	}
	other, _ := s.readNote("other.md")
	if !strings.Contains(other.Content, "new/deep/note.md") {
		t.Fatalf("incoming link stale: %s", other.Content)
	}
}
func TestBatchMetadataRollbackAndFiltering(t *testing.T) {
	s := testStore(t)
	a := create(t, s, "a.md", "# A\nneedle in body\n")
	b := create(t, s, "b.md", "---\nbroken: [\n---\n# B")
	tags := []string{"one", "two"}
	group := "Work"
	if _, err := s.batchMetadata([]string{a.Path, b.Path}, &tags, &group, nil); err == nil {
		t.Fatal("accepted invalid metadata")
	}
	current, _ := s.readNote(a.Path)
	if current.Revision != a.Revision {
		t.Fatal("partial batch write")
	}
	if _, err := s.batchMetadata([]string{a.Path}, &tags, &group, map[string]string{a.Path: a.Revision}); err != nil {
		t.Fatal(err)
	}
	rr := request(t, NewHandler(attachStore(s), false), "GET", "/api/notes?q=needle&group=Work&tags=one,two", nil)
	if rr.Code != 200 {
		t.Fatal(rr.Body.String())
	}
	var notes []Note
	_ = json.Unmarshal(rr.Body.Bytes(), &notes)
	if len(notes) != 1 || notes[0].Path != "a.md" {
		t.Fatalf("filter failed: %s", rr.Body.String())
	}
}
func TestTasksIgnoreCodeAndUpdateSourceOnly(t *testing.T) {
	s := testStore(t)
	content := "# Tasks\n\n- [ ] real\n\n```markdown\n- [ ] fenced\n```\n\n    - [ ] indented\n\n- [x] complete\n  - [ ] nested\n"
	note := create(t, s, "tasks.md", content)
	tasks := parseTasks(note)
	if len(tasks) != 3 {
		t.Fatalf("tasks %+v", tasks)
	}
	status := "doing"
	updated, err := s.updateTask(TaskUpdate{NotePath: note.Path, Line: tasks[0].Line, ID: tasks[0].ID, Revision: note.Revision, Status: &status})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(updated.Content, "- [ ] real <!-- echo-task:") || !strings.Contains(updated.Content, "\"status\":\"doing\"") {
		t.Fatal(updated.Content)
	}
	if !strings.Contains(updated.Content, "```markdown\n- [ ] fenced\n```\n\n    - [ ] indented") {
		t.Fatal("modified unrelated source")
	}
	if parseTasks(updated)[0].ID != tasks[0].ID {
		t.Fatal("task ID changed")
	}
}
func TestMonthlyRecurrenceAndReminderClaims(t *testing.T) {
	location, _ := time.LoadLocation("Asia/Shanghai")
	due := time.Date(2026, 1, 31, 9, 0, 0, 0, location)
	next := nextOccurrence(due, "monthly", 31, due)
	if next.Month() != time.February || next.Day() != 28 {
		t.Fatalf("month overflow %s", next)
	}
	next = nextOccurrence(next, "monthly", 31, next)
	if next.Month() != time.March || next.Day() != 31 {
		t.Fatalf("lost anchor %s", next)
	}
	s := testStore(t)
	note := create(t, s, "reminder.md", "# Reminder\n- [ ] overdue <!-- echo-task: {\"id\":\"stable-id\",\"status\":\"todo\",\"due\":\"2020-01-01T09:00:00+08:00\",\"timezone\":\"Asia/Shanghai\"} -->\n")
	s.checkReminders(time.Now())
	s.checkReminders(time.Now())
	if len(s.state.Reminders) != 1 {
		t.Fatalf("duplicate reminders: %+v", s.state.Reminders)
	}
	h := NewHandler(attachStore(s), false)
	id := s.state.Reminders[0].ID
	for i := 0; i < 2; i++ {
		rr := request(t, h, "POST", "/api/reminders/ack", map[string]string{"id": id})
		var result map[string]bool
		_ = json.Unmarshal(rr.Body.Bytes(), &result)
		if result["claimed"] != (i == 0) {
			t.Fatalf("claim %d: %s", i, rr.Body.String())
		}
	}
	reopened, err := Open(s.root)
	if err != nil {
		t.Fatal(err)
	}
	reopened.checkReminders(time.Now())
	if len(reopened.state.Reminders) != 1 || !reopened.state.Reminders[0].Acknowledged {
		t.Fatal("claim did not persist")
	}
	status := "done"
	repeat := "monthly"
	updated, err := s.updateTask(TaskUpdate{NotePath: note.Path, Line: 2, Revision: note.Revision, Status: &status, Repeat: &repeat})
	if err != nil {
		t.Fatal(err)
	}
	task := parseTasks(updated)[0]
	if task.Status != "todo" {
		t.Fatal("repeated task not reset")
	}
	nextTime, err := parseTaskTime(task.Due, task.Timezone)
	if err != nil || !nextTime.After(time.Now()) {
		t.Fatalf("recurrence %s %v", task.Due, err)
	}
}
func TestAssetMigrationAndExportResources(t *testing.T) {
	s := testStore(t)
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0}
	asset, _ := s.safePath(".assets/image.png")
	if err := atomicWrite(asset, png, 0644); err != nil {
		t.Fatal(err)
	}
	note := create(t, s, "folder/note.md", "# Images\n![photo](../.assets/image.png)\n![outside](https://example.com/a.png)\n")
	settings := s.state.Settings
	settings.AssetsDir = "resources"
	if err := s.updateSettings(settings); err != nil {
		t.Fatal(err)
	}
	note, _ = s.readNote(note.Path)
	if !strings.Contains(note.Content, "../resources/image.png") {
		t.Fatal(note.Content)
	}
	if _, err := os.Stat(filepath.Join(s.root, "resources", "image.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(asset); !os.IsNotExist(err) {
		t.Fatalf("old resource still exists: %v", err)
	}
	snapshot, assets, err := s.snapshot([]string{note.Path})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Missing) != 0 || len(snapshot.External) != 1 || !strings.HasPrefix(snapshot.Notes[0].Assets["../resources/image.png"], "data:image/png;base64,") {
		t.Fatalf("snapshot %+v", snapshot)
	}
	data, err := markdownBundle(snapshot, assets)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	foundImage := false
	foundNote := false
	for _, file := range archive.File {
		if strings.HasPrefix(file.Name, ".assets/") {
			foundImage = true
		}
		if file.Name == note.Path {
			reader, _ := file.Open()
			content, _ := io.ReadAll(reader)
			_ = reader.Close()
			foundNote = strings.Contains(string(content), "../.assets/")
		}
	}
	if !foundImage || !foundNote {
		t.Fatalf("bundle resource references invalid: image=%v note=%v", foundImage, foundNote)
	}
}
func TestMissingAssetExportRequiresExplicitContinue(t *testing.T) {
	s := testStore(t)
	create(t, s, "missing.md", "# Missing\n![gone](.assets/no.png)\n")
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "POST", "/api/exports", map[string]any{"paths": []string{"missing.md"}, "format": "snapshot"})
	if rr.Code != 422 {
		t.Fatalf("expected missing warning got %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "POST", "/api/exports", map[string]any{"paths": []string{"missing.md"}, "format": "snapshot", "allowMissing": true})
	if rr.Code != 200 {
		t.Fatal(rr.Body.String())
	}
}

func TestEmptyNoteStillReturnsContentField(t *testing.T) {
	s := testStore(t)
	create(t, s, "empty.md", "")
	rr := request(t, NewHandler(attachStore(s), false), "GET", "/api/notes?path=empty.md", nil)
	var result map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if value, ok := result["content"]; !ok || value != "" {
		t.Fatalf("missing empty content: %s", rr.Body.String())
	}
}

func TestReferencesAndLiteralExamplesSurviveResourceMigration(t *testing.T) {
	s := testStore(t)
	image, _ := s.safePath(".assets/reference.png")
	if err := atomicWrite(image, []byte{137, 80, 78, 71, 13, 10, 26, 10}, 0644); err != nil {
		t.Fatal(err)
	}
	content := "---\nexample: '![demo](.assets/example.png)'\n---\n# Reference\n![reference][photo]\n\n[photo]: .assets/reference.png \"title\"\n\n`![inline](.assets/inline.png)`\n\n```md\n![code](.assets/code.png)\n```\n"
	note := create(t, s, "reference.md", content)
	snapshot, _, err := s.snapshot([]string{note.Path})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Notes[0].Assets) != 1 || len(snapshot.Missing) != 0 {
		t.Fatalf("literal or reference parsing failed: %+v", snapshot)
	}
	settings := s.state.Settings
	settings.AssetsDir = "images"
	if err = s.updateSettings(settings); err != nil {
		t.Fatal(err)
	}
	updated, _ := s.readNote(note.Path)
	if !strings.Contains(updated.Content, "[photo]: images/reference.png") {
		t.Fatal(updated.Content)
	}
	for _, literal := range []string{"![demo](.assets/example.png)", "![inline](.assets/inline.png)", "![code](.assets/code.png)"} {
		if !strings.Contains(updated.Content, literal) {
			t.Fatalf("rewrote literal %s: %s", literal, updated.Content)
		}
	}
}

func TestMigrationRecoveryKeepsExternalNoteAndJournal(t *testing.T) {
	s := testStore(t)
	note := create(t, s, "external.md", "# Before\n")
	j := migrationJournal{From: ".assets", To: "new-assets", Originals: map[string]string{note.Path: note.Content}, Updated: map[string]string{note.Path: "# During\n"}, Settings: s.state.Settings, Files: []string{}, Hashes: map[string]string{}}
	if err := s.writeJournal(j); err != nil {
		t.Fatal(err)
	}
	file, _ := s.notePath(note.Path)
	if err := atomicWrite(file, []byte("# External edit\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverMigration(); err == nil {
		t.Fatal("recovery ignored external edit")
	}
	current, _ := s.readNote(note.Path)
	if current.Content != "# External edit\n" {
		t.Fatal("external edit lost")
	}
	if _, err := os.Stat(s.journalPath()); err != nil {
		t.Fatal("recovery journal lost")
	}
	rr := request(t, NewHandler(attachStore(s), false), "PUT", "/api/notes", map[string]any{"path": note.Path, "revision": current.Revision, "content": "# Overwrite"})
	if rr.Code != 400 {
		t.Fatalf("write allowed while recovery pending: %d", rr.Code)
	}
}

func TestCommittedMigrationVerifiesDestinationBeforeDeletingSource(t *testing.T) {
	s := testStore(t)
	source, _ := s.safePath(".assets/original.png")
	data := []byte("original image data")
	if err := atomicWrite(source, data, 0644); err != nil {
		t.Fatal(err)
	}
	j := migrationJournal{From: ".assets", To: "new-assets", Settings: s.state.Settings, Files: []string{"original.png"}, Hashes: map[string]string{"original.png": revision(data)}, Committed: true}
	if err := s.writeJournal(j); err != nil {
		t.Fatal(err)
	}
	if err := s.recoverMigration(); err == nil {
		t.Fatal("missing destination accepted")
	}
	current, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(current, data) {
		t.Fatal("only resource copy was deleted")
	}
	if _, err = os.Stat(s.journalPath()); err != nil {
		t.Fatal("recovery journal lost")
	}
}

func TestEncodedPathsAndHashFilenamesAfterMove(t *testing.T) {
	if target, ok := localReference("folder/note.md", "../.assets/100%2525.png"); !ok || target != ".assets/100%25.png" {
		t.Fatalf("path decoded twice: %s %v", target, ok)
	}
	link := relativeLink("folder/note.md", ".assets/a#b?c%.png", "")
	if link != "../.assets/a%23b%3Fc%25.png" {
		t.Fatalf("unsafe generated link %s", link)
	}
	if target, ok := localReference("folder/note.md", link); !ok || target != ".assets/a#b?c%.png" {
		t.Fatalf("path did not roundtrip %s %v", target, ok)
	}
}

func TestExclusiveCreateAndCheckedBatchNeverOverwriteExternalFiles(t *testing.T) {
	s := testStore(t)
	note := create(t, s, "safe.md", "# Original\n")
	file, _ := s.notePath(note.Path)
	if err := exclusiveWrite(file, []byte("new"), 0644); !os.IsExist(err) {
		t.Fatalf("existing file was not protected: %v", err)
	}
	if err := atomicWrite(file, []byte("# External\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writeMany(map[string]string{note.Path: "# Ours\n"}, map[string]string{note.Path: note.Revision}); err == nil {
		t.Fatal("stale multi-note write accepted")
	}
	current, _ := s.readNote(note.Path)
	if current.Content != "# External\n" {
		t.Fatal("external content lost")
	}
}
func TestMigrationRecoveryRollsBackInterruptedWrites(t *testing.T) {
	s := testStore(t)
	note := create(t, s, "recover.md", "# Before\n![a](.assets/a.png)\n")
	j := migrationJournal{From: ".assets", To: "new-assets", Originals: map[string]string{note.Path: note.Content}, Settings: s.state.Settings, Files: []string{"a.png"}}
	j.Updated = map[string]string{note.Path: "# changed"}
	j.Hashes = map[string]string{"a.png": revision([]byte("copy"))}
	if err := s.writeJournal(j); err != nil {
		t.Fatal(err)
	}
	file, _ := s.notePath(note.Path)
	_ = atomicWrite(file, []byte("# changed"), 0644)
	asset, _ := s.safePath("new-assets/a.png")
	_ = atomicWrite(asset, []byte("copy"), 0644)
	reopened, err := Open(s.root)
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := reopened.readNote(note.Path)
	if restored.Content != note.Content {
		t.Fatal("interrupted migration not rolled back")
	}
	if _, err = os.Stat(asset); !os.IsNotExist(err) {
		t.Fatal("staged image survived rollback")
	}
}

func findTreeEntry(entries []TreeEntry, target string) (TreeEntry, bool) {
	for _, entry := range entries {
		if entry.Path == target {
			return entry, true
		}
		if child, ok := findTreeEntry(entry.Children, target); ok {
			return child, true
		}
	}
	return TreeEntry{}, false
}

func TestDrawingsCreateSaveMoveExportAndCleanup(t *testing.T) {
	s := testStore(t)
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "POST", "/api/drawings", map[string]any{"path": "图表/架构.excalidraw"})
	if rr.Code != 201 {
		t.Fatalf("create %d %s", rr.Code, rr.Body.String())
	}
	var created Drawing
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Path != "图表/架构.excalidraw" || !strings.Contains(created.Content, `"type":"excalidraw"`) || created.Revision == "" {
		t.Fatalf("created %+v", created)
	}
	tree, err := s.tree()
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := findTreeEntry(tree, created.Path)
	if !ok || entry.Type != "drawing" || entry.Name != "架构.excalidraw" {
		t.Fatalf("tree entry %+v %v", entry, ok)
	}
	for _, body := range []any{
		map[string]any{"path": "图表/坏.md"},
		map[string]any{"path": ".assets/内部.excalidraw"},
		map[string]any{"path": "图表/坏.excalidraw", "content": `{"type":"not-excalidraw"}`},
		map[string]any{"path": "图表/架构.excalidraw"},
	} {
		if rr = request(t, h, "POST", "/api/drawings", body); rr.Code < 400 {
			t.Fatalf("accepted invalid drawing %v: %d %s", body, rr.Code, rr.Body.String())
		}
	}
	updatedContent := `{"type":"excalidraw","elements":[{"id":"box"}]}`
	if rr = request(t, h, "PUT", "/api/drawings", map[string]any{"path": created.Path, "content": updatedContent, "revision": "stale"}); rr.Code != http.StatusConflict {
		t.Fatalf("conflict %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "PUT", "/api/drawings", map[string]any{"path": created.Path, "content": updatedContent, "revision": created.Revision})
	if rr.Code != 200 {
		t.Fatalf("save %d %s", rr.Code, rr.Body.String())
	}
	var saved Drawing
	if err = json.Unmarshal(rr.Body.Bytes(), &saved); err != nil || saved.Content != updatedContent || saved.Revision == created.Revision {
		t.Fatalf("saved %+v %v", saved, err)
	}
	note := create(t, s, "记录.md", "# 记录\n![架构](图表/架构.excalidraw)\n")
	rr = request(t, h, "POST", "/api/drawings/move", map[string]any{"path": saved.Path, "target": "资料/架构.excalidraw", "revision": saved.Revision})
	if rr.Code != 200 {
		t.Fatalf("move %d %s", rr.Code, rr.Body.String())
	}
	note, err = s.readNote(note.Path)
	if err != nil || !strings.Contains(note.Content, "%E8%B5%84%E6%96%99/%E6%9E%B6%E6%9E%84.excalidraw") || strings.Contains(note.Content, "图表/架构.excalidraw") {
		t.Fatalf("reference not rewritten: %s %v", note.Content, err)
	}
	rr = request(t, h, "POST", "/api/drawings", map[string]any{"notePath": note.Path})
	if rr.Code != 201 {
		t.Fatalf("attach %d %s", rr.Code, rr.Body.String())
	}
	var attached struct {
		Drawing
		MarkdownPath string `json:"markdownPath"`
	}
	if err = json.Unmarshal(rr.Body.Bytes(), &attached); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(attached.Path, ".assets/") || !strings.HasSuffix(attached.Path, ".excalidraw") || attached.MarkdownPath != attached.Path {
		t.Fatalf("attached %+v", attached)
	}
	if _, ok = findTreeEntry(mustTree(t, s), attached.Path); ok {
		t.Fatal("asset drawing appeared in the directory tree")
	}
	note, err = s.saveNote(note.Path, note.Content+"\n![绘图]("+attached.MarkdownPath+")\n", note.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	unused, err := s.unusedAssets()
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range unused.Files {
		if file.Path == attached.Path {
			t.Fatalf("referenced drawing listed as unused: %+v", unused.Files)
		}
	}
	snapshot, assets, err := s.snapshot([]string{note.Path})
	if err != nil {
		t.Fatal(err)
	}
	embedded := snapshot.Notes[0].Assets[attached.MarkdownPath]
	if len(snapshot.Missing) != 0 || !strings.HasPrefix(embedded, "data:application/vnd.excalidraw+json;base64,") {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if _, ok = assets[attached.Path]; !ok {
		t.Fatal("drawing missing from export bundle assets")
	}
	rr = request(t, h, "DELETE", "/api/drawings?path="+url.QueryEscape(attached.Path), nil)
	if rr.Code != 200 {
		t.Fatalf("delete attached %d %s", rr.Code, rr.Body.String())
	}
	standalone := "资料/架构.excalidraw"
	rr = request(t, h, "DELETE", "/api/drawings?path="+url.QueryEscape(standalone), nil)
	if rr.Code != 200 {
		t.Fatalf("delete %d %s", rr.Code, rr.Body.String())
	}
	if _, ok = findTreeEntry(mustTree(t, s), standalone); ok {
		t.Fatal("deleted drawing remained in the tree")
	}
	if len(s.state.Trash) == 0 {
		t.Fatal("drawing was not recycled")
	}
	if err = s.restore(s.state.Trash[len(s.state.Trash)-1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.readDrawing(standalone); err != nil {
		t.Fatal(err)
	}
}

func mustTree(t *testing.T, s *Store) []TreeEntry {
	t.Helper()
	tree, err := s.tree()
	if err != nil {
		t.Fatal(err)
	}
	return tree
}
