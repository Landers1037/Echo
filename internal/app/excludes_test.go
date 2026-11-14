package app

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestScanExcludePatterns(t *testing.T) {
	normalized, err := normalizeScanExcludes([]string{" # deps", "", "node_modules\\", "dist", "dist", "foo/**/**/bar"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(normalized, []string{"node_modules/", "dist", "foo/**/bar"}) {
		t.Fatalf("normalized: %#v", normalized)
	}
	if got, err := normalizeScanExcludes(nil); err != nil || len(got) != 0 {
		t.Fatalf("nil excludes: %#v %v", got, err)
	}
	for _, line := range []string{"!keep", "*", "**", "**/*", "/*", "secret/../x", "["} {
		if _, err := normalizeScanExcludes([]string{line}); err == nil {
			t.Fatalf("accepted %q", line)
		}
	}
	long := strings.Repeat("a", maxScanExcludeLen+1)
	if _, err := normalizeScanExcludes([]string{long}); err == nil {
		t.Fatal("accepted an overlong rule")
	}
	tooMany := make([]string, maxScanExcludes+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("rule-%03d", i)
	}
	if _, err := normalizeScanExcludes(tooMany); err == nil {
		t.Fatal("accepted more than 100 rules")
	}

	cases := []struct {
		lines []string
		rel   string
		dir   bool
		want  bool
	}{
		{[]string{"node_modules"}, "pkg/node_modules/readme.md", false, true},
		{[]string{"node_modules"}, "notes/readme.md", false, false},
		{[]string{"node_modules/"}, "node_modules", true, true},
		{[]string{"node_modules/"}, "node_modules", false, false},
		{[]string{"node_modules/"}, "node_modules/pkg/readme.md", false, true},
		{[]string{"/build"}, "build/out.md", false, true},
		{[]string{"/build"}, "src/build/out.md", false, false},
		{[]string{"*.log"}, "dir/app.log", false, true},
		{[]string{"*.log"}, "dir/app.md", false, false},
		{[]string{"foo/*.log"}, "foo/a.log", false, true},
		{[]string{"foo/*.log"}, "foo/bar/a.log", false, false},
		{[]string{"**/temp"}, "a/b/temp/file.md", false, true},
		{[]string{"**/temp"}, "a/b/template.md", false, false},
	}
	for _, tc := range cases {
		if got := pathExcluded(tc.lines, tc.rel, tc.dir); got != tc.want {
			t.Errorf("pathExcluded(%q, %q, %v) = %v, want %v", tc.lines, tc.rel, tc.dir, got, tc.want)
		}
	}
	folded := pathExcluded([]string{"Node_Modules"}, "node_modules/pkg/README.md", false)
	if runtime.GOOS == "windows" {
		if !folded {
			t.Fatal("Windows should match excludes without case")
		}
	} else if folded {
		t.Fatal("case-sensitive systems should keep pattern case")
	}
}

func TestScanExcludesSkipDiscoveryAndStorage(t *testing.T) {
	s := testStore(t)
	create(t, s, "keep.md", "# Keep\n- [ ] visible task\n![kept](.assets/kept.png)\n")
	create(t, s, "node_modules/pkg/README.md", "# Package\n- [ ] hidden task\n![pkg](../../.assets/from-package.png)\n")
	create(t, s, "vendor/lib.md", "# Vendor\n")
	create(t, s, "nested/vendor/note.md", "# Nested\n")
	create(t, s, "logs/inside.md", "# Logs\n")
	if _, err := s.createDrawing("node_modules/diagram.excalidraw", ""); err != nil {
		t.Fatal(err)
	}
	putStorageAsset(t, s, ".assets/kept.png", "kept")
	putStorageAsset(t, s, ".assets/from-package.png", "package")
	putStorageAsset(t, s, ".assets/from-trash.png", "trash")
	create(t, s, "node_modules/old.md", "![old](../.assets/from-trash.png)\n")
	if err := s.recycle("node_modules/old.md"); err != nil {
		t.Fatal(err)
	}
	settings := s.state.Settings
	settings.ScanExcludes = []string{"# generated", "node_modules", "/vendor", "logs/"}
	if err := s.updateSettings(settings); err != nil {
		t.Fatal(err)
	}

	notes, err := s.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, note := range notes {
		got = append(got, note.Path)
	}
	want := []string{"keep.md", "nested/vendor/note.md", "欢迎使用 Echo.md"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("notes: %#v", got)
	}
	tree, err := s.tree()
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	var flatten func([]TreeEntry)
	flatten = func(entries []TreeEntry) {
		for _, entry := range entries {
			paths = append(paths, entry.Path)
			flatten(entry.Children)
		}
	}
	flatten(tree)
	for _, path := range paths {
		if path == "node_modules" || strings.HasPrefix(path, "node_modules/") || path == "vendor" || strings.HasPrefix(path, "vendor/") || path == "logs" || strings.HasPrefix(path, "logs/") {
			t.Fatalf("excluded path remained visible: %s in %#v", path, paths)
		}
	}
	if !containsPath(paths, "nested/vendor/note.md") || !containsPath(paths, "keep.md") {
		t.Fatalf("visible notes missing: %#v", paths)
	}
	usage, err := s.storageUsage()
	if err != nil {
		t.Fatal(err)
	}
	if usage.NoteCount != len(want) {
		t.Fatalf("note count: %+v", usage)
	}
	unused, err := s.unusedAssets()
	if err != nil {
		t.Fatal(err)
	}
	unusedNames := []string{}
	for _, file := range unused.Files {
		unusedNames = append(unusedNames, file.Path)
	}
	sort.Strings(unusedNames)
	if !reflect.DeepEqual(unusedNames, []string{".assets/from-package.png", ".assets/from-trash.png"}) {
		t.Fatalf("unused assets: %#v", unusedNames)
	}
	tasks, err := s.allTasks()
	if err != nil {
		t.Fatal(err)
	}
	visible := 0
	for _, task := range tasks {
		if task.NotePath == "node_modules/pkg/README.md" || strings.HasPrefix(task.NotePath, "node_modules/") {
			t.Fatalf("excluded task: %+v", task)
		}
		if task.NotePath == "keep.md" && task.Text == "visible task" {
			visible++
		}
	}
	if visible != 1 {
		t.Fatalf("tasks: %+v", tasks)
	}
	if _, err := s.readNote("node_modules/pkg/README.md"); err != nil {
		t.Fatal(err)
	}
	hidden, err := s.readNote("node_modules/pkg/README.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveNote(hidden.Path, hidden.Content+"\n", hidden.Revision, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.createNote("node_modules/new.md", "# New\n"); err == nil {
		t.Fatal("created a note inside an excluded directory")
	}
	if _, err := s.createNote("ok/new.md", "# New\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.createDrawing(".assets/embedded.excalidraw", ""); err != nil {
		t.Fatal(err)
	}
	keep, err := s.readNote("keep.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.move(keep.Path, "node_modules/keep.md", keep.Revision, false); err == nil {
		t.Fatal("moved a note into an excluded directory")
	}
	h := NewHandler(attachStore(s), false)
	if rr := request(t, h, "POST", "/api/folders", map[string]string{"path": "node_modules/nested"}); rr.Code != 400 {
		t.Fatalf("folder in excluded path: %d %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.root, "node_modules", "nested")); !os.IsNotExist(err) {
		t.Fatal("excluded folder was created")
	}
}

func TestScanExcludesRejectInvalidRulesAndPreserveLegacy(t *testing.T) {
	s := testStore(t)
	if s.state.Settings.ScanExcludes == nil {
		t.Fatal("new library stored nil excludes")
	}
	settings := s.state.Settings
	settings.ScanExcludes = []string{"!keep"}
	if err := s.updateSettings(settings); err == nil {
		t.Fatal("saved a negated exclude")
	}
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "PUT", "/api/settings", map[string]any{"scanExcludes": []string{"# comment", "node_modules\\", "dist", "dist"}})
	if rr.Code != 200 {
		t.Fatalf("save excludes: %d %s", rr.Code, rr.Body.String())
	}
	reopened, err := Open(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopened.state.Settings.ScanExcludes, []string{"node_modules/", "dist"}) {
		t.Fatalf("persisted excludes: %#v", reopened.state.Settings.ScanExcludes)
	}
	if rr := request(t, h, "PUT", "/api/settings", map[string]any{"scanExcludes": []string{"*"}}); rr.Code != 400 {
		t.Fatalf("entire library exclude: %d %s", rr.Code, rr.Body.String())
	}

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".echo", "state.json"), []byte(`{"settings":{"assetsDir":".assets"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	legacy, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy.state.Settings.ScanExcludes) != 0 {
		t.Fatalf("legacy excludes: %#v", legacy.state.Settings.ScanExcludes)
	}
	if err := os.WriteFile(filepath.Join(root, ".echo", "state.json"), []byte(`{"settings":{"assetsDir":".assets","scanExcludes":["*"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root); err == nil || !strings.Contains(err.Error(), "整个笔记库") {
		t.Fatalf("corrupt excludes opened: %v", err)
	}
}

func TestReadScanExcludes(t *testing.T) {
	if got, err := ReadScanExcludes(""); err != nil || len(got) != 0 {
		t.Fatalf("empty root: %#v %v", got, err)
	}
	missing := t.TempDir()
	if got, err := ReadScanExcludes(missing); err != nil || len(got) != 0 {
		t.Fatalf("missing state: %#v %v", got, err)
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, ".echo", "state.json")
	if err := os.WriteFile(state, []byte(`{"settings":{"scanExcludes":[" # deps","","node_modules\\","dist","dist"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadScanExcludes(root)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"node_modules/", "dist"}) {
		t.Fatalf("read excludes: %#v", got)
	}
	if err := os.WriteFile(state, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadScanExcludes(root); err == nil || !strings.Contains(err.Error(), "损坏") {
		t.Fatalf("corrupt state: %v", err)
	}
	if err := os.WriteFile(state, []byte(`{"settings":{"scanExcludes":["*"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadScanExcludes(root); err == nil || !strings.Contains(err.Error(), "整个笔记库") {
		t.Fatalf("invalid rules: %v", err)
	}
}

func TestExcludeDirsToPatterns(t *testing.T) {
	root := t.TempDir()
	nodeModules := filepath.Join(root, "node_modules")
	nested := filepath.Join(root, "My Notes", "cache")
	if err := os.MkdirAll(filepath.Join(nodeModules, "pkg"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".echo", "trash"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "keep.md")
	if err := os.WriteFile(file, []byte("# keep\n"), 0644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	patterns, rejected, err := ExcludeDirsToPatterns(root, []string{
		nodeModules,
		nested,
		nodeModules,
		filepath.Join(root, "My Notes", "cache") + string(filepath.Separator),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rejected) != 0 {
		t.Fatalf("unexpected rejects: %#v", rejected)
	}
	if !reflect.DeepEqual(patterns, []string{"/node_modules/", "/My Notes/cache/"}) {
		t.Fatalf("patterns: %#v", patterns)
	}
	_, rejected, err = ExcludeDirsToPatterns(root, []string{root, outside, file, filepath.Join(root, ".echo"), filepath.Join(root, ".echo", "trash")})
	if err != nil {
		t.Fatal(err)
	}
	if len(rejected) != 5 {
		t.Fatalf("rejected: %#v", rejected)
	}
	joined := strings.Join(rejected, "\n")
	for _, want := range []string{"不能排除整个笔记库", "不在笔记目录内", "不是文件夹", "不能排除 .echo 配置目录"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("rejected %q missing from %s", want, joined)
		}
	}
	if _, _, err = ExcludeDirsToPatterns("", []string{nodeModules}); err == nil || !strings.Contains(err.Error(), "笔记目录") {
		t.Fatalf("empty root: %v", err)
	}
	if _, _, err = ExcludeDirsToPatterns(filepath.Join(root, "missing-notebook"), []string{nodeModules}); err == nil {
		t.Fatal("missing notebook accepted")
	}
	if runtime.GOOS == "windows" {
		folded := filepath.Join(strings.ToUpper(root), "NODE_MODULES")
		patterns, rejected, err = ExcludeDirsToPatterns(strings.ToLower(root), []string{folded})
		if err != nil || len(rejected) != 0 || !reflect.DeepEqual(patterns, []string{"/node_modules/"}) {
			t.Fatalf("windows case: %#v %#v %v", patterns, rejected, err)
		}
	}
}

func TestOpenWithOptionsAppliesExcludesBeforeFirstScan(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "pkg", "README.md"), []byte("# hidden\n"), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := OpenWithOptions(root, OpenOptions{ApplyScanExcludes: true, ScanExcludes: []string{"/node_modules/"}})
	if err != nil {
		t.Fatal(err)
	}
	notes, err := s.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 1 || notes[0].Path != "欢迎使用 Echo.md" {
		t.Fatalf("notes: %#v", notePaths(notes))
	}
	if !reflect.DeepEqual(s.state.Settings.ScanExcludes, []string{"/node_modules/"}) {
		t.Fatalf("excludes: %#v", s.state.Settings.ScanExcludes)
	}
	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopened.state.Settings.ScanExcludes, []string{"/node_modules/"}) {
		t.Fatalf("persisted: %#v", reopened.state.Settings.ScanExcludes)
	}
	notes, err = reopened.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	if containsPath(notePaths(notes), "node_modules/pkg/README.md") {
		t.Fatalf("excluded note indexed: %#v", notePaths(notes))
	}

	withKeep := t.TempDir()
	if err := os.MkdirAll(filepath.Join(withKeep, "pkg", "node_modules"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(withKeep, "keep.md"), []byte("# keep\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(withKeep, "pkg", "node_modules", "README.md"), []byte("# hidden\n"), 0644); err != nil {
		t.Fatal(err)
	}
	patterns, rejected, err := ExcludeDirsToPatterns(withKeep, []string{filepath.Join(withKeep, "pkg", "node_modules")})
	if err != nil || len(rejected) != 0 {
		t.Fatalf("convert nested: %#v %#v %v", patterns, rejected, err)
	}
	keptStore, err := OpenWithOptions(withKeep, OpenOptions{ApplyScanExcludes: true, ScanExcludes: patterns})
	if err != nil {
		t.Fatal(err)
	}
	notes, err = keptStore.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	paths := notePaths(notes)
	if !containsPath(paths, "keep.md") || containsPath(paths, "pkg/node_modules/README.md") || containsPath(paths, "欢迎使用 Echo.md") {
		t.Fatalf("first scan paths: %#v", paths)
	}
}

func TestOpenWithOptionsReplacesAndClearsStoredExcludes(t *testing.T) {
	s := testStore(t)
	if err := os.MkdirAll(filepath.Join(s.root, "node_modules"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "node_modules", "hidden.md"), []byte("# hidden\n"), 0644); err != nil {
		t.Fatal(err)
	}
	excluded, err := OpenWithOptions(s.root, OpenOptions{ApplyScanExcludes: true, ScanExcludes: []string{"node_modules"}})
	if err != nil {
		t.Fatal(err)
	}
	notes, err := excluded.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	if containsPath(notePaths(notes), "node_modules/hidden.md") {
		t.Fatal("hidden note was indexed")
	}
	if !reflect.DeepEqual(excluded.state.Settings.ScanExcludes, []string{"node_modules"}) {
		t.Fatalf("stored: %#v", excluded.state.Settings.ScanExcludes)
	}
	info, err := os.Stat(filepath.Join(s.root, ".echo", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	written := info.ModTime()
	time.Sleep(20 * time.Millisecond)
	same, err := OpenWithOptions(s.root, OpenOptions{ApplyScanExcludes: true, ScanExcludes: []string{"node_modules"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(same.state.Settings.ScanExcludes, []string{"node_modules"}) {
		t.Fatalf("unchanged open: %#v", same.state.Settings.ScanExcludes)
	}
	info, err = os.Stat(filepath.Join(s.root, ".echo", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.ModTime().After(written) {
		t.Fatal("unchanged excludes rewrote state.json")
	}
	ignored, err := OpenWithOptions(s.root, OpenOptions{ScanExcludes: []string{"/vendor/"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ignored.state.Settings.ScanExcludes, []string{"node_modules"}) {
		t.Fatalf("apply flag ignored: %#v", ignored.state.Settings.ScanExcludes)
	}
	cleared, err := OpenWithOptions(s.root, OpenOptions{ApplyScanExcludes: true, ScanExcludes: nil})
	if err != nil {
		t.Fatal(err)
	}
	notes, err = cleared.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	if !containsPath(notePaths(notes), "node_modules/hidden.md") {
		t.Fatalf("cleared excludes still hide the note: %#v", notePaths(notes))
	}
	if len(cleared.state.Settings.ScanExcludes) != 0 {
		t.Fatalf("cleared: %#v", cleared.state.Settings.ScanExcludes)
	}
	if _, err = OpenWithOptions(s.root, OpenOptions{ApplyScanExcludes: true, ScanExcludes: []string{"*"}}); err == nil {
		t.Fatal("invalid startup excludes accepted")
	}
	preserved, err := Open(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if len(preserved.state.Settings.ScanExcludes) != 0 {
		t.Fatalf("failed apply changed excludes: %#v", preserved.state.Settings.ScanExcludes)
	}
}

func TestOpenWithOptionsRepairsInvalidStoredExcludes(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".echo", "state.json"), []byte(`{"settings":{"assetsDir":".assets","scanExcludes":["*"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "keep.md"), []byte("# keep\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root); err == nil {
		t.Fatal("invalid excludes still open")
	}
	s, err := OpenWithOptions(root, OpenOptions{ApplyScanExcludes: true, ScanExcludes: []string{"/node_modules/"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.state.Settings.ScanExcludes, []string{"/node_modules/"}) {
		t.Fatalf("repaired: %#v", s.state.Settings.ScanExcludes)
	}
	notes, err := s.listNotes()
	if err != nil {
		t.Fatal(err)
	}
	if !containsPath(notePaths(notes), "keep.md") {
		t.Fatalf("notes: %#v", notePaths(notes))
	}
}

func TestOpenWorkspaceWithOptionsAppliesExcludes(t *testing.T) {
	useRepositoryConfig(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "node_modules"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "README.md"), []byte("# hidden\n"), 0644); err != nil {
		t.Fatal(err)
	}
	ws, err := OpenWorkspaceWithOptions(root, true, OpenOptions{ApplyScanExcludes: true, ScanExcludes: []string{"/node_modules/"}})
	if err != nil {
		t.Fatal(err)
	}
	notes, err := ws.current().listNotes()
	if err != nil {
		t.Fatal(err)
	}
	if containsPath(notePaths(notes), "node_modules/README.md") || !containsPath(notePaths(notes), "欢迎使用 Echo.md") {
		t.Fatalf("workspace notes: %#v", notePaths(notes))
	}
}

func notePaths(notes []Note) []string {
	paths := make([]string, len(notes))
	for i, note := range notes {
		paths[i] = note.Path
	}
	return paths
}

func containsPath(paths []string, want string) bool {
	for _, path := range paths {
		if path == want {
			return true
		}
	}
	return false
}
