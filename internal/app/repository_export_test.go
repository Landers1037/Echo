package app

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"database/sql"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestRepositoryExportName(t *testing.T) {
	root := filepath.Join(t.TempDir(), "笔记库")
	if got := repositoryExportName(root, "zip"); got != "笔记库.zip" {
		t.Fatalf("zip name: %s", got)
	}
	if got := repositoryExportName(root, "tar"); got != "笔记库.tar" {
		t.Fatalf("tar name: %s", got)
	}
	if got := sanitizeExportBase("a:b*c"); got != "a_b_c" {
		t.Fatalf("sanitized: %s", got)
	}
	if got := sanitizeExportBase(" ... "); got != "笔记库" {
		t.Fatalf("empty name: %s", got)
	}
}

func TestRepositoryExportArchivesNotesAssetsAndSkipsExcludedPaths(t *testing.T) {
	s := testStore(t)
	create(t, s, "中文/测试.md", "# 中文\n")
	create(t, s, "nested/keep.md", "# keep\n")
	create(t, s, ".hidden/note.md", "# hidden\n")
	create(t, s, "node_modules/pkg/README.md", "# package\n")
	create(t, s, "logs/inside.md", "# log\n")
	create(t, s, "gone.md", "# gone\n")
	if _, err := s.createDrawing("diagrams/flow.excalidraw", ""); err != nil {
		t.Fatal(err)
	}
	putStorageAsset(t, s, ".assets/picture.png", "png-bytes")
	putStorageAsset(t, s, ".assets/notes.txt", "plain-text")
	if err := os.Mkdir(filepath.Join(s.root, "kept-empty"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "debug.log"), []byte("debug"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.root, ".echo-write-partial"), []byte("partial"), 0644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("OUTSIDE-SECRET"), 0644); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(s.root, "linked.txt"))
	_ = os.Symlink(outside, filepath.Join(s.root, "linked-dir"))
	settings := s.state.Settings
	settings.ScanExcludes = []string{"node_modules", "logs/", "*.log"}
	if err := s.updateSettings(settings); err != nil {
		t.Fatal(err)
	}
	if err := s.recycle("gone.md"); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(attachStore(s), false)
	if rr := request(t, h, "GET", "/api/storage/export", nil); rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "请选择 ZIP 或 TAR") {
		t.Fatalf("missing format: %d %s", rr.Code, rr.Body.String())
	}
	if rr := request(t, h, "GET", "/api/storage/export?format=rar", nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("rar accepted: %d %s", rr.Code, rr.Body.String())
	}
	if rr := request(t, h, "POST", "/api/storage/export?format=zip", nil); rr.Code != http.StatusNotFound {
		t.Fatalf("post accepted: %d %s", rr.Code, rr.Body.String())
	}

	var first map[string][]byte
	for _, format := range []string{"zip", "ZIP", "tar"} {
		rr := request(t, h, "GET", "/api/storage/export?format="+format, nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", format, rr.Code, rr.Body.String())
		}
		normalized := strings.ToLower(format)
		contentType := repositoryExportType(normalized)
		if rr.Header().Get("Content-Type") != contentType {
			t.Fatalf("%s content type: %s", format, rr.Header().Get("Content-Type"))
		}
		if rr.Header().Get("Content-Length") != strconv.Itoa(rr.Body.Len()) {
			t.Fatalf("%s length: header %s body %d", format, rr.Header().Get("Content-Length"), rr.Body.Len())
		}
		_, params, err := mime.ParseMediaType(rr.Header().Get("Content-Disposition"))
		if err != nil {
			t.Fatal(err)
		}
		if params["filename"] != repositoryExportName(s.root, normalized) {
			t.Fatalf("%s filename: %#v", format, params)
		}
		files := readExportArchive(t, normalized, rr.Body.Bytes())
		if first == nil {
			first = files
			assertRepositoryArchive(t, s, files)
			continue
		}
		if len(files) != len(first) {
			t.Fatalf("%s file count %d, zip %d", format, len(files), len(first))
		}
		for name, body := range first {
			got, ok := files[name]
			if !ok || !bytes.Equal(got, body) {
				t.Fatalf("%s missing or different %s", format, name)
			}
		}
	}
}

func TestRepositoryExportRejectsOversizedLibrary(t *testing.T) {
	previous := maxRepositoryExportBytes
	maxRepositoryExportBytes = 1
	t.Cleanup(func() { maxRepositoryExportBytes = previous })
	s := testStore(t)
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "GET", "/api/storage/export?format=zip", nil)
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "无法一次导出") {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
}

func TestRepositoryExportSnapshotsSQLite(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() {
		s.closeAgent()
		s.closeAnnotations()
	})
	agent, err := s.agentService()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = agent.CreateConversation("chat", "", "导出测试"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.annotationService(); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "GET", "/api/storage/export?format=zip", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	files := readExportArchive(t, "zip", rr.Body.Bytes())
	for _, name := range []string{".echo/agent.db-wal", ".echo/agent.db-shm", ".echo/annotations.db-wal", ".echo/annotations.db-shm"} {
		if _, ok := files[name]; ok {
			t.Fatalf("live sqlite sidecar archived: %s", name)
		}
	}
	db := files[".echo/agent.db"]
	if !bytes.HasPrefix(db, []byte("SQLite format 3\x00")) {
		t.Fatalf("agent database header: %q", db[:min(len(db), 16)])
	}
	if !bytes.HasPrefix(files[".echo/annotations.db"], []byte("SQLite format 3\x00")) {
		t.Fatal("annotations database was not exported")
	}
	opened := openSQLiteSnapshot(t, db)
	var title string
	if err = opened.QueryRow(`SELECT title FROM conversations`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "导出测试" {
		t.Fatalf("conversation: %s", title)
	}
}

func assertRepositoryArchive(t *testing.T, s *Store, files map[string][]byte) {
	t.Helper()
	for _, name := range []string{"中文/", "中文/测试.md", "nested/", "nested/keep.md", ".hidden/note.md", "diagrams/flow.excalidraw", ".assets/picture.png", ".assets/notes.txt", "kept-empty/", ".echo/", ".echo/state.json", ".echo/trash/", "欢迎使用 Echo.md"} {
		if _, ok := files[name]; !ok {
			t.Fatalf("missing %s in %#v", name, archiveKeys(files))
		}
	}
	welcome, err := os.ReadFile(filepath.Join(s.root, "欢迎使用 Echo.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(files["欢迎使用 Echo.md"], welcome) || !bytes.Equal(files["中文/测试.md"], []byte("# 中文\n")) || !bytes.Equal(files[".assets/picture.png"], []byte("png-bytes")) || !bytes.Equal(files[".assets/notes.txt"], []byte("plain-text")) {
		t.Fatal("archived file contents differ")
	}
	drawing, err := os.ReadFile(filepath.Join(s.root, "diagrams", "flow.excalidraw"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(files["diagrams/flow.excalidraw"], drawing) {
		t.Fatal("drawing contents differ")
	}
	if !bytes.Contains(files[".echo/state.json"], []byte("gone.md")) {
		t.Fatal("state.json lost the recycled note")
	}
	foundTrash := false
	for name, body := range files {
		if strings.HasPrefix(name, ".echo/trash/") && name != ".echo/trash/" && bytes.Equal(body, []byte("# gone\n")) {
			foundTrash = true
		}
		if strings.Contains(name, "node_modules") || strings.HasPrefix(name, "logs/") || name == "logs" || name == "debug.log" || name == "gone.md" || name == ".echo-write-partial" || name == "linked.txt" || name == "linked-dir" || strings.HasPrefix(name, "linked-dir/") {
			t.Fatalf("unexpected path %s", name)
		}
		if bytes.Contains(body, []byte("OUTSIDE-SECRET")) {
			t.Fatalf("symlink target archived in %s", name)
		}
	}
	if !foundTrash {
		t.Fatalf("recycled note missing: %#v", archiveKeys(files))
	}
}

func archiveKeys(files map[string][]byte) []string {
	keys := make([]string, 0, len(files))
	for name := range files {
		keys = append(keys, name)
	}
	return keys
}

func readExportArchive(t *testing.T, format string, data []byte) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	switch format {
	case "zip":
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range reader.File {
			body, err := readZipFile(file)
			if err != nil {
				t.Fatal(err)
			}
			files[file.Name] = body
		}
	case "tar":
		reader := tar.NewReader(bytes.NewReader(data))
		for {
			header, err := reader.Next()
			if err == io.EOF {
				return files
			}
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			files[header.Name] = body
		}
	default:
		t.Fatalf("unknown format %s", format)
	}
	return files
}

func readZipFile(file *zip.File) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func openSQLiteSnapshot(t *testing.T, data []byte) *sql.DB {
	t.Helper()
	file := filepath.Join(t.TempDir(), "agent.db")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", sqliteDSN(file))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
