package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNoteVersionsCreateListRestoreDeleteAndLabels(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeVersions() })

	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "GET", "/api/version-repo/status", nil)
	var status VersionRepoStatus
	if err := json.Unmarshal(rr.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || status.Initialized {
		t.Fatalf("expected uninitialized status: %d %+v", rr.Code, status)
	}

	rr = request(t, h, "POST", "/api/version-repo/init", nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || !status.Initialized {
		t.Fatalf("init failed: %d %s", rr.Code, rr.Body.String())
	}

	note, err := s.createNote("日记.md", "# day one\n")
	if err != nil {
		t.Fatal(err)
	}
	rr = request(t, h, "POST", "/api/note-versions", map[string]any{"path": note.Path})
	var first NoteVersion
	if err := json.Unmarshal(rr.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 201 || first.Source != "manual" || !strings.HasSuffix(first.Label, "-v1") {
		t.Fatalf("create version: %d %+v %s", rr.Code, first, rr.Body.String())
	}

	if _, err = s.saveNote(note.Path, "# day two\n", note.Revision, false); err != nil {
		t.Fatal(err)
	}
	note, err = s.readNote(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	rr = request(t, h, "POST", "/api/note-versions", map[string]any{"path": note.Path})
	var second NoteVersion
	if err := json.Unmarshal(rr.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 201 || !strings.HasSuffix(second.Label, "-v2") {
		t.Fatalf("second version label: %+v", second)
	}

	rr = request(t, h, "GET", "/api/note-versions?path="+note.Path, nil)
	var list []NoteVersion
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || len(list) != 2 || list[0].ID != second.ID {
		t.Fatalf("list order: %d %+v", rr.Code, list)
	}

	rr = request(t, h, "POST", "/api/note-versions/restore", map[string]any{"versionId": first.ID, "revision": note.Revision})
	var restored Note
	if err := json.Unmarshal(rr.Body.Bytes(), &restored); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || restored.Content != "# day one\n" {
		t.Fatalf("restore: %d %s", rr.Code, rr.Body.String())
	}

	rr = request(t, h, "DELETE", "/api/note-versions?id="+second.ID, nil)
	if rr.Code != 200 {
		t.Fatalf("delete: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "GET", "/api/note-versions?path="+note.Path, nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != first.ID {
		t.Fatalf("after delete: %+v", list)
	}
}

func TestNoteVersionsDedupObjectsAndRelocate(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeVersions() })
	if _, err = s.initVersionRepo(); err != nil {
		t.Fatal(err)
	}
	a, err := s.createNote("a.md", "same\n")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.createNote("folder/b.md", "same\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.createNoteVersion(a.Path, "manual"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.createNoteVersion(b.Path, "manual"); err != nil {
		t.Fatal(err)
	}
	status, err := s.versionRepoStatus()
	if err != nil {
		t.Fatal(err)
	}
	if status.ObjectCount != 1 || status.VersionCount != 2 {
		t.Fatalf("dedup objects: %+v", status)
	}

	if _, err = s.move("folder", "archive", "", true); err != nil {
		t.Fatal(err)
	}
	list, err := s.listNoteVersions("archive/b.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("relocated versions: %+v", list)
	}
	if _, err = s.listNoteVersions("folder/b.md"); err == nil {
		// empty list is ok, path just has no versions
	}
	empty, err := s.listNoteVersions("folder/b.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("old path should be empty: %+v", empty)
	}
}

func TestNoteVersionsDailyAutoSkipsUnchanged(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeVersions() })
	s.state.Settings.VersionRepoEnabled = true
	s.state.Settings.AutoVersionDaily = true
	if err = s.persist(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.initVersionRepo(); err != nil {
		t.Fatal(err)
	}
	note, err := s.createNote("auto.md", "# auto\n")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.Local)
	s.runDailyVersions(now)
	list, err := s.listNoteVersions(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Source != "auto" {
		t.Fatalf("first auto: %+v", list)
	}
	s.runDailyVersions(now)
	list, err = s.listNoteVersions(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("same day should not re-run: %+v", list)
	}
	versions, err := s.versionService()
	if err != nil {
		t.Fatal(err)
	}
	if err = versions.metaSet("last_auto_day", "2026-10-30"); err != nil {
		t.Fatal(err)
	}
	s.runDailyVersions(now)
	list, err = s.listNoteVersions(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("unchanged content should skip: %+v", list)
	}
	if _, err = s.saveNote(note.Path, "# changed\n", note.Revision, false); err != nil {
		t.Fatal(err)
	}
	if err = versions.metaSet("last_auto_day", "2026-10-30"); err != nil {
		t.Fatal(err)
	}
	s.runDailyVersions(now)
	list, err = s.listNoteVersions(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("changed note should snapshot: %+v", list)
	}
}

func TestNoteVersionsMigratesLegacySchemaWithoutLabel(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", sqliteDSN(filepath.Join(root, ".echo", "versions.db")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`
CREATE TABLE objects (hash TEXT PRIMARY KEY NOT NULL, refs INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0);
CREATE TABLE versions (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  FOREIGN KEY(object_hash) REFERENCES objects(hash)
);
CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
INSERT INTO meta(key, value) VALUES('initialized', '1');
INSERT INTO objects(hash, refs, size) VALUES('abc', 1, 4);
INSERT INTO versions(id, path, object_hash, created_at, source) VALUES('v1', '旧.md', 'abc', '2026-10-31T00:00:00.000000000Z', 'manual');
PRAGMA user_version = 2;
`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeVersions() })
	if err = os.WriteFile(filepath.Join(root, "旧.md"), []byte("# old\n"), 0644); err != nil {
		t.Fatal(err)
	}
	renamed, err := s.renameNoteVersion("v1", "兼容迁移")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Label != "兼容迁移" {
		t.Fatalf("label after migrate: %+v", renamed)
	}
}

func TestNoteVersionsRenameLabel(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeVersions() })
	if _, err = s.initVersionRepo(); err != nil {
		t.Fatal(err)
	}
	note, err := s.createNote("命名.md", "# name\n")
	if err != nil {
		t.Fatal(err)
	}
	created, err := s.createNoteVersion(note.Path, "manual")
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "PUT", "/api/note-versions", map[string]any{"id": created.ID, "label": "  发布前定稿  "})
	var renamed NoteVersion
	if err := json.Unmarshal(rr.Body.Bytes(), &renamed); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || renamed.Label != "发布前定稿" {
		t.Fatalf("rename: %d %+v %s", rr.Code, renamed, rr.Body.String())
	}
	list, err := s.listNoteVersions(note.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Label != "发布前定稿" {
		t.Fatalf("persisted label: %+v", list)
	}
	rr = request(t, h, "PUT", "/api/note-versions", map[string]any{"id": created.ID, "label": "   "})
	if rr.Code < 400 {
		t.Fatalf("empty label should fail: %d %s", rr.Code, rr.Body.String())
	}
}

func TestNoteVersionsRejectBeforeInit(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.closeVersions() })
	if _, err = s.createNote("x.md", "x"); err != nil {
		t.Fatal(err)
	}
	_, err = s.createNoteVersion("x.md", "manual")
	if !errors.Is(err, errVersionRepoNotReady) {
		t.Fatalf("expected not ready, got %v", err)
	}
}

func TestNoteVersionsSettingsDefaults(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".echo", "state.json"), []byte(`{"settings":{"theme":"dark","accent":"#9379b7","assetsDir":".assets"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if s.state.Settings.VersionRepoEnabled || !s.state.Settings.AutoVersionDaily {
		t.Fatalf("legacy defaults: %+v", s.state.Settings)
	}
}
