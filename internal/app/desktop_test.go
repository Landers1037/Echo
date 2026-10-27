package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDirectoryOpenerKeepsPathAsOneArgument(t *testing.T) {
	for _, test := range []struct {
		goos, directory, program string
		args                     []string
	}{
		{"darwin", "/Users/me/中文 notes", "open", []string{"--", "/Users/me/中文 notes"}},
		{"linux", "/home/me/中文 notes", "xdg-open", []string{"/home/me/中文 notes"}},
	} {
		t.Run(test.goos, func(t *testing.T) {
			program, args, err := directoryOpener(test.goos, test.directory)
			if err != nil || program != test.program || !reflect.DeepEqual(args, test.args) {
				t.Fatalf("opener: %q %q %v", program, args, err)
			}
		})
	}
	if _, _, err := directoryOpener("unsupported", "/notes"); err == nil {
		t.Fatal("unsupported desktop was accepted")
	}
}

func TestOpenNotebookDirectoryRejectsUnavailablePaths(t *testing.T) {
	root := t.TempDir()
	if err := openNotebookDirectory(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing directory was accepted")
	}
	file := filepath.Join(root, "note.md")
	if err := os.WriteFile(file, []byte("# Note"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := openNotebookDirectory(file); err == nil {
		t.Fatal("a note file was accepted as a directory")
	}
}

func TestOpenStorageAlwaysOpensCurrentNotebookRoot(t *testing.T) {
	s := testStore(t)
	h := NewHandler(attachStore(s), false).(*handler)
	var opened []string
	h.openDirectory = func(directory string) error { opened = append(opened, directory); return nil }
	if rr := request(t, h, "GET", "/api/storage/open", nil); rr.Code == http.StatusOK || len(opened) != 0 {
		t.Fatal("GET opened the desktop")
	}
	rr := request(t, h, "POST", "/api/storage/open?path=../outside", map[string]string{"path": "/other/directory"})
	if rr.Code != http.StatusOK || len(opened) != 1 || opened[0] != s.Root() {
		t.Fatalf("unexpected opened path: %v, response: %d %s", opened, rr.Code, rr.Body.String())
	}
	h.openDirectory = func(string) error { return errors.New("desktop launcher unavailable") }
	rr = request(t, h, "POST", "/api/storage/open", nil)
	if rr.Code == http.StatusOK || !strings.Contains(rr.Body.String(), "desktop launcher unavailable") {
		t.Fatalf("launcher failure hidden: %d %s", rr.Code, rr.Body.String())
	}
}

func TestOpenStorageUsesLocalRequestGuards(t *testing.T) {
	h := NewHandler(attachStore(testStore(t)), false).(*handler)
	called := false
	h.openDirectory = func(string) error { called = true; return nil }
	for _, test := range []struct{ host, origin, fetchSite string }{
		{"127.0.0.1:8080", "https://evil.example", ""},
		{"evil.example", "", ""},
		{"127.0.0.1:8080", "", "cross-site"},
	} {
		req := httptest.NewRequest("POST", "http://"+test.host+"/api/storage/open", nil)
		req.Header.Set("Origin", test.origin)
		req.Header.Set("Sec-Fetch-Site", test.fetchSite)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusForbidden || called {
			t.Fatalf("untrusted request opened desktop: %+v %d", test, rr.Code)
		}
	}
}
