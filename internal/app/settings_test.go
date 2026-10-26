package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditorFontSizeLegacySettingsAndPersistence(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		t.Fatal(err)
	}
	// Older notebooks have no editorFontSize field.
	if err := os.WriteFile(filepath.Join(root, ".echo", "state.json"), []byte(`{"settings":{"theme":"dark","accent":"#9379b7","assetsDir":".assets"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(s, false)
	rr := request(t, h, "GET", "/api/settings", nil)
	var settings Settings
	if err := json.Unmarshal(rr.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || settings.EditorFontSize != 14 || settings.Theme != "dark" || settings.Shortcuts == nil {
		t.Fatalf("legacy settings: %d %+v", rr.Code, settings)
	}
	rr = request(t, h, "PUT", "/api/settings", map[string]any{"editorFontSize": 20})
	if rr.Code != 200 || s.state.Settings.EditorFontSize != 20 {
		t.Fatalf("save font size: %d %s", rr.Code, rr.Body.String())
	}
	// Updating unrelated settings from an older client preserves the saved size.
	rr = request(t, h, "PUT", "/api/settings", map[string]any{"editorLineNumbers": false})
	if rr.Code != 200 || s.state.Settings.EditorFontSize != 20 {
		t.Fatalf("partial update lost font size: %d %s", rr.Code, rr.Body.String())
	}
	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.state.Settings.EditorFontSize != 20 || reopened.state.Settings.Theme != "dark" {
		t.Fatalf("font size not persisted: %+v", reopened.state.Settings)
	}
}

func TestEditorFontSizeValidationPreservesSettings(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s, false)
	stateFile := filepath.Join(s.root, ".echo", "state.json")
	before, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []any{0, 11, 33, -1, 18.5, "20"} {
		rr := request(t, h, "PUT", "/api/settings", map[string]any{"editorFontSize": size})
		if rr.Code != 400 || s.state.Settings.EditorFontSize != 14 {
			t.Fatalf("accepted invalid size %v: %d %s", size, rr.Code, rr.Body.String())
		}
		after, err := os.ReadFile(stateFile)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("invalid size %v changed saved settings: %v", size, err)
		}
	}
	for _, size := range []int{12, 32} {
		rr := request(t, h, "PUT", "/api/settings", map[string]any{"editorFontSize": size})
		if rr.Code != 200 || s.state.Settings.EditorFontSize != size {
			t.Fatalf("rejected valid size %d: %d %s", size, rr.Code, rr.Body.String())
		}
	}
}

func TestMultiTabsPersistence(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if s.state.Settings.MultiTabs {
		t.Fatal("multiTabs should default to false")
	}
	h := NewHandler(s, false)
	rr := request(t, h, "PUT", "/api/settings", map[string]any{"multiTabs": true})
	if rr.Code != 200 || !s.state.Settings.MultiTabs {
		t.Fatalf("save multiTabs: %d %s", rr.Code, rr.Body.String())
	}
	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if !reopened.state.Settings.MultiTabs || reopened.state.Settings.EditorFontSize != 14 || reopened.state.Settings.Theme != "system" {
		t.Fatalf("multiTabs not persisted: %+v", reopened.state.Settings)
	}
}

func TestShortcutPersistenceAndReplacement(t *testing.T) {
	s := testStore(t)
	if s.state.Settings.Shortcuts == nil {
		t.Fatal("shortcuts should default to an empty map")
	}
	h := NewHandler(s, false)
	rr := request(t, h, "PUT", "/api/settings", map[string]any{"shortcuts": map[string]string{"bold": "Mod-Shift-b", "italic": ""}})
	if rr.Code != 200 || s.state.Settings.Shortcuts["bold"] != "Mod-Shift-b" || s.state.Settings.Shortcuts["italic"] != "" || len(s.state.Settings.Shortcuts) != 2 {
		t.Fatalf("save shortcuts: %d %s", rr.Code, rr.Body.String())
	}
	reopened, err := Open(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.state.Settings.Shortcuts["bold"] != "Mod-Shift-b" || reopened.state.Settings.Shortcuts["italic"] != "" {
		t.Fatalf("shortcuts not persisted: %+v", reopened.state.Settings.Shortcuts)
	}
	rr = request(t, h, "PUT", "/api/settings", map[string]any{"shortcuts": map[string]string{}})
	if rr.Code != 200 || len(s.state.Settings.Shortcuts) != 0 {
		t.Fatalf("empty shortcuts should replace previous overrides: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "PUT", "/api/settings", map[string]any{"shortcuts": map[string]string{"bold": "Mod-e"}})
	if rr.Code != 200 {
		t.Fatal(rr.Body.String())
	}
	rr = request(t, h, "PUT", "/api/settings", map[string]any{"editorLineNumbers": false})
	if rr.Code != 200 || s.state.Settings.EditorLineNumbers || s.state.Settings.Shortcuts["bold"] != "Mod-e" || len(s.state.Settings.Shortcuts) != 1 {
		t.Fatalf("partial update should keep shortcuts: %d %+v", rr.Code, s.state.Settings)
	}
}

func TestShortcutValidationPreservesSettings(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s, false)
	stateFile := filepath.Join(s.root, ".echo", "state.json")
	before, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	many := map[string]string{}
	for i := 0; i < 65; i++ {
		many[fmt.Sprintf("action%d", i)] = fmt.Sprintf("Alt-%d", i)
	}
	cases := []map[string]any{
		{"shortcuts": map[string]string{"bold": "Mod-e", "italic": "Mod-e"}},
		{"shortcuts": map[string]string{"bad-id": "Mod-b"}},
		{"shortcuts": map[string]string{"bold": "Mod-b extra"}},
		{"shortcuts": map[string]string{"bold": strings.Repeat("a", 41)}},
		{"shortcuts": many},
	}
	for _, body := range cases {
		rr := request(t, h, "PUT", "/api/settings", body)
		if rr.Code != 400 {
			t.Fatalf("accepted %v: %d %s", body["shortcuts"], rr.Code, rr.Body.String())
		}
		after, readErr := os.ReadFile(stateFile)
		if readErr != nil || !bytes.Equal(before, after) {
			t.Fatalf("invalid shortcuts changed saved settings: %v", readErr)
		}
	}
}
