package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
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
	if rr.Code != 200 || settings.EditorFontSize != 14 || settings.Theme != "dark" {
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
