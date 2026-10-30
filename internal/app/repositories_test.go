package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func useRepositoryConfig(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("AppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
}

func TestRepositoryHistoryPinsCurrentAndKeepsFive(t *testing.T) {
	useRepositoryConfig(t)
	ws, err := OpenWorkspace(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	original := ws.Root()
	dirs := []string{original}
	for i := 0; i < 5; i++ {
		dir := t.TempDir()
		dirs = append(dirs, dir)
		list, err := ws.Switch(dir)
		if err != nil || !list.Switched || !sameRepository(list.Current, dir) || !sameRepository(list.Items[0].Path, dir) {
			t.Fatalf("switch %d: %+v %v", i, list, err)
		}
		if list.Items[0].Name != filepath.Base(list.Items[0].Path) {
			t.Fatalf("missing default name: %+v", list.Items[0])
		}
	}
	list := ws.List()
	if len(list.Items) != maxRepositories {
		t.Fatalf("history length %d", len(list.Items))
	}
	if containsRepository(list.Items, dirs[0]) {
		t.Fatalf("oldest repository kept: %+v", list.Items)
	}
	again, err := ws.Switch(dirs[2])
	if err != nil || !again.Switched {
		t.Fatal(err)
	}
	if !sameRepository(again.Items[0].Path, dirs[2]) || len(again.Items) != maxRepositories || countRepository(again.Items, dirs[2]) != 1 {
		t.Fatalf("dedupe failed: %+v", again.Items)
	}
	same, err := ws.Switch(ws.Root())
	if err != nil || same.Switched || !sameRepository(ws.Root(), dirs[2]) {
		t.Fatalf("same repository reopened: %+v %v root %s", same, err, ws.Root())
	}
}

func TestRepositorySwitchFailureKeepsCurrent(t *testing.T) {
	useRepositoryConfig(t)
	ws, err := OpenWorkspace(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	original := ws.Root()
	marker := filepath.Join(original, "keep.md")
	if err = os.WriteFile(marker, []byte("# keep"), 0644); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err = os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = ws.Switch(file); err == nil {
		t.Fatal("accepted a file as a repository")
	}
	if !sameRepository(ws.Root(), original) {
		t.Fatalf("current changed to %s", ws.Root())
	}
	if _, err = os.Stat(marker); err != nil {
		t.Fatal(err)
	}
	list := ws.List()
	if len(list.Items) != 1 || !sameRepository(list.Items[0].Path, original) {
		t.Fatalf("history changed: %+v", list.Items)
	}
}

func TestRepositoryRemoveRejectsCurrentAndKeepsFiles(t *testing.T) {
	useRepositoryConfig(t)
	ws, err := OpenWorkspace(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	current := ws.Root()
	if err = ws.Remove(current); err == nil {
		t.Fatal("removed the open repository")
	}
	other := t.TempDir()
	marker := filepath.Join(other, "note.md")
	if err = os.WriteFile(marker, []byte("# stay"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = ws.Switch(other); err != nil {
		t.Fatal(err)
	}
	if _, err = ws.Switch(current); err != nil {
		t.Fatal(err)
	}
	if err = ws.Remove(other); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(marker); err != nil {
		t.Fatalf("history removal deleted files: %v", err)
	}
	if containsRepository(ws.List().Items, other) {
		t.Fatal("removed repository still listed")
	}
	if _, err = os.Stat(other); err != nil {
		t.Fatal(err)
	}
}

func TestRepositoryRenamePersists(t *testing.T) {
	useRepositoryConfig(t)
	root := t.TempDir()
	ws, err := OpenWorkspace(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = ws.Rename(ws.Root(), "  我的仓库  "); err != nil {
		t.Fatal(err)
	}
	list := ws.List()
	if len(list.Items) != 1 || list.Items[0].Name != "我的仓库" {
		t.Fatalf("name not updated: %+v", list.Items)
	}
	file, err := repositoriesPath()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var decoded repositoryFile
	if err = json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Repositories) != 1 || decoded.Repositories[0].Name != "我的仓库" || !sameRepository(decoded.Repositories[0].Path, ws.Root()) {
		t.Fatalf("history file: %+v", decoded.Repositories)
	}
	if err = ws.Rename(ws.Root(), "line\nbreak"); err == nil {
		t.Fatal("accepted a newline in the name")
	}
}

func TestLastRepositoryUsesNewestHistory(t *testing.T) {
	useRepositoryConfig(t)
	fallback := t.TempDir()
	recent := t.TempDir()
	ws, err := OpenWorkspace(fallback, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ws.Switch(recent); err != nil {
		t.Fatal(err)
	}
	if !sameRepository(LastRepository(), recent) {
		t.Fatalf("last repository %s, want %s", LastRepository(), recent)
	}
}

func TestLastRepositoryFallsBackWithoutHistory(t *testing.T) {
	useRepositoryConfig(t)
	got := LastRepository()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(filepath.Dir(exe), "notes")
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestOpenWorkspacePrefersHistoryUnlessExplicit(t *testing.T) {
	useRepositoryConfig(t)
	fallback := t.TempDir()
	recent := t.TempDir()
	ws, err := OpenWorkspace(fallback, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ws.Switch(recent); err != nil {
		t.Fatal(err)
	}
	restored, err := OpenWorkspace(fallback, false)
	if err != nil {
		t.Fatal(err)
	}
	if !sameRepository(restored.Root(), recent) {
		t.Fatalf("startup opened %s, want recent %s", restored.Root(), recent)
	}
	forced, err := OpenWorkspace(fallback, true)
	if err != nil {
		t.Fatal(err)
	}
	if !sameRepository(forced.Root(), fallback) || !sameRepository(forced.List().Items[0].Path, fallback) {
		t.Fatalf("explicit directory ignored: %+v", forced.List())
	}
}

func TestOpenWorkspaceFallsBackWhenHistoryCannotOpen(t *testing.T) {
	useRepositoryConfig(t)
	fallback := t.TempDir()
	file := filepath.Join(t.TempDir(), "notdir")
	if err := os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	config, err := repositoriesPath()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(config), 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(repositoryFile{Repositories: []Repository{{Path: file, Name: "坏的", LastOpened: time.Now().UTC().Format(time.RFC3339)}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(config, data, 0600); err != nil {
		t.Fatal(err)
	}
	ws, err := OpenWorkspace(fallback, false)
	if err != nil {
		t.Fatal(err)
	}
	if !sameRepository(ws.Root(), fallback) {
		t.Fatalf("fallback not used: %s", ws.Root())
	}
	if _, err = OpenWorkspace(file, true); err == nil {
		t.Fatal("explicit file path was accepted")
	}
}

func TestRepositorySwitchNotifiesExistingClient(t *testing.T) {
	useRepositoryConfig(t)
	ws, err := OpenWorkspace(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	client := make(chan []byte, 1)
	ws.addClient(client)
	if _, err = ws.Switch(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	select {
	case data := <-client:
		if !bytes.Contains(data, []byte(`"switched"`)) {
			t.Fatalf("event: %s", data)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for switch event")
	}
}

func TestRepositoryHTTPPickAndDelete(t *testing.T) {
	useRepositoryConfig(t)
	ws, err := OpenWorkspace(t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(ws, false).(*handler)
	before := ws.Root()
	h.pickFolder = func() (string, bool, error) { return "", true, nil }
	rr := request(t, h, "POST", "/api/repositories/pick", map[string]any{})
	if rr.Code != http.StatusOK || !bytes.Contains(rr.Body.Bytes(), []byte(`"canceled":true`)) || !sameRepository(ws.Root(), before) {
		t.Fatalf("cancel: %d %s root %s", rr.Code, rr.Body.String(), ws.Root())
	}
	other := t.TempDir()
	h.pickFolder = func() (string, bool, error) { return other, false, nil }
	rr = request(t, h, "POST", "/api/repositories/pick", map[string]any{})
	var picked RepositoryList
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &picked) != nil || !picked.Switched || !sameRepository(picked.Current, other) {
		t.Fatalf("pick: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "DELETE", "/api/repositories?path="+url.QueryEscape(picked.Current), nil)
	if rr.Code == http.StatusOK {
		t.Fatalf("deleted current repository: %s", rr.Body.String())
	}
	rr = request(t, h, "PUT", "/api/repositories", map[string]string{"path": picked.Current, "name": "挑选的仓库"})
	if rr.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "GET", "/api/repositories", nil)
	var listed RepositoryList
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &listed) != nil || listed.Items[0].Name != "挑选的仓库" {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
}

func containsRepository(items []Repository, path string) bool {
	return countRepository(items, path) > 0
}

func countRepository(items []Repository, path string) int {
	count := 0
	for _, item := range items {
		if sameRepository(item.Path, path) {
			count++
		}
	}
	return count
}
