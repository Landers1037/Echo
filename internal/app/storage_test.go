package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func putStorageAsset(t *testing.T, s *Store, name, content string) {
	t.Helper()
	file, err := s.safePath(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(file, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestStorageUsageCountsRealFiles(t *testing.T) {
	s := testStore(t)
	initial, err := s.storageUsage()
	if err != nil {
		t.Fatal(err)
	}
	create(t, s, "folder/note.md", "# 中文笔记\n")
	create(t, s, ".hidden/note.md", "# Hidden\n")
	create(t, s, "discarded.md", "# In trash\n")
	if err := s.recycle("discarded.md"); err != nil {
		t.Fatal(err)
	}
	putStorageAsset(t, s, ".assets/a.png", "image-data")
	putStorageAsset(t, s, ".assets/sub/b.WEBP", "webp")
	putStorageAsset(t, s, ".assets/readme.md", "asset documentation")
	putStorageAsset(t, s, ".assets/keep.txt", "not an image")
	h := NewHandler(s, false)
	rr := request(t, h, "GET", "/api/storage", nil)
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	var usage StorageUsage
	if err := json.Unmarshal(rr.Body.Bytes(), &usage); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(s.root, ".echo", "state.json"))
	if usage.DatabaseBytes != info.Size() || usage.Root != s.root || usage.AssetsDir != ".assets" {
		t.Fatalf("metadata stats: %+v", usage)
	}
	if usage.NoteCount != initial.NoteCount+2 || usage.NoteBytes != initial.NoteBytes+int64(len("# 中文笔记\n# Hidden\n")) {
		t.Fatalf("note stats: %+v", usage)
	}
	if usage.AssetCount != 2 || usage.AssetBytes != int64(len("image-datawebp")) {
		t.Fatalf("asset stats: %+v", usage)
	}
}

func TestStorageCleanupProtectsAllReferencedImages(t *testing.T) {
	s := testStore(t)
	protected := []string{"inline.png", "reference.png", "link.png", "encoded space.png", "html.png", "yaml.png", "wiki.png", "recycled.png", "folder-recycled.png", "hidden.png", "punct(ok).png"}
	for _, name := range append(append([]string{}, protected...), "unused.png", "code-only.png") {
		putStorageAsset(t, s, ".assets/"+name, "image-data")
	}
	putStorageAsset(t, s, ".assets/keep.txt", "not an image")
	content := "---\ncover: ../.assets/yaml.png\n---\n# Images\n![inline](../.assets/inline.png)\n![reference][photo]\n\n[photo]: ../.assets/reference.png \"Title\"\n\n[file](../.assets/link.png)\n![encoded](<../.assets/encoded%20space.png>)\n<img src=\"../.assets/html.png\">\n![[.assets/wiki.png]]\n![punctuation](../.assets/punct\\(ok\\).png)\n`![example](../.assets/code-only.png)`\n"
	create(t, s, "folder/note.md", content)
	create(t, s, ".hidden/note.md", "![hidden](../.assets/hidden.png)")
	create(t, s, "old/note.md", "![image](../.assets/recycled.png)")
	if err := s.recycle("old/note.md"); err != nil {
		t.Fatal(err)
	}
	create(t, s, "archive/nested/note.md", "![image](../../.assets/folder-recycled.png)")
	if err := s.recycle("archive"); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(s, false)
	rr := request(t, h, "GET", "/api/storage/unused-assets", nil)
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	var scan UnusedAssets
	if err := json.Unmarshal(rr.Body.Bytes(), &scan); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, file := range scan.Files {
		names = append(names, file.Path)
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != ".assets/code-only.png" || names[1] != ".assets/unused.png" {
		t.Fatalf("unexpected cleanup candidates: %v", names)
	}
	rr = request(t, h, "POST", "/api/storage/cleanup", map[string]string{"token": scan.Token})
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	var result AssetCleanup
	if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RemovedCount != 2 || result.RemovedBytes != 20 || len(result.Failed) != 0 {
		t.Fatalf("cleanup result: %+v", result)
	}
	for _, name := range protected {
		if _, err := os.Stat(filepath.Join(s.root, ".assets", name)); err != nil {
			t.Errorf("referenced image removed %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(s.root, ".assets", "keep.txt")); err != nil {
		t.Fatal(err)
	}
	note, err := s.readNote("folder/note.md")
	if err != nil || note.Content != content {
		t.Fatal("cleanup modified note contents")
	}
	if rr := request(t, h, "POST", "/api/storage/cleanup", map[string]string{"token": scan.Token}); rr.Code != 409 {
		t.Fatalf("replayed stale scan: %d", rr.Code)
	}
}

func TestStorageCleanupRejectsChangedNotesAndAssets(t *testing.T) {
	s := testStore(t)
	putStorageAsset(t, s, ".assets/unused.png", "image")
	scan, err := s.unusedAssets()
	if err != nil {
		t.Fatal(err)
	}
	note := create(t, s, "new-reference.md", "![new](.assets/unused.png)")
	h := NewHandler(s, false)
	if rr := request(t, h, "POST", "/api/storage/cleanup", map[string]string{"token": scan.Token}); rr.Code != 409 {
		t.Fatalf("new reference not protected: %d %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.root, ".assets", "unused.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveNote(note.Path, "# Removed reference", note.Revision, false); err != nil {
		t.Fatal(err)
	}
	scan, err = s.unusedAssets()
	if err != nil {
		t.Fatal(err)
	}
	putStorageAsset(t, s, ".assets/unused.png", "externally replaced image data")
	if rr := request(t, h, "POST", "/api/storage/cleanup", map[string]string{"token": scan.Token}); rr.Code != 409 {
		t.Fatalf("changed file not protected: %d", rr.Code)
	}
	if rr := request(t, h, "POST", "/api/storage/cleanup", map[string]string{"token": ""}); rr.Code != 409 {
		t.Fatalf("missing token accepted: %d", rr.Code)
	}
}

func TestStorageScanStopsOnUnreadableReferencesAndSkipsSymlinks(t *testing.T) {
	s := testStore(t)
	putStorageAsset(t, s, ".assets/unused.png", "image")
	create(t, s, "broken.md", "---\ncover: [invalid\n---\n")
	if _, err := s.unusedAssets(); err == nil {
		t.Fatal("invalid frontmatter allowed cleanup")
	}
	if _, err := s.storageUsage(); err != nil {
		t.Fatalf("invalid frontmatter blocked size stats: %v", err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "outside.png"), []byte("outside"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.root, ".assets", "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	usage, err := s.storageUsage()
	if err != nil || usage.AssetCount != 1 {
		t.Fatalf("followed resource symlink: %+v %v", usage, err)
	}
}
