package app

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func annotationStroke() map[string]any {
	return map[string]any{"points": []any{[]any{0.1, 0.2}, []any{0.4, 1.5}}, "width": 0.004}
}

func annotationHighlight() map[string]any {
	return map[string]any{"start": 0, "end": 2, "quote": "记录"}
}

func TestAnnotationLifecycle(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAnnotations() })
	create(t, s, "日记.md", "# 日记\n")
	h := NewHandler(attachStore(s), false)

	rr := request(t, h, "GET", "/api/annotations?path=日记.md", nil)
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"visible":false`) || !strings.Contains(rr.Body.String(), `"items":[]`) {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "POST", "/api/annotations", map[string]any{
		"notePath": "日记.md", "kind": "stroke", "anchorLine": 1, "anchorText": "  日记  ", "color": "#E3B341", "data": annotationStroke(), "comment": "",
	})
	if rr.Code != 201 {
		t.Fatalf("create stroke: %d %s", rr.Code, rr.Body.String())
	}
	var stroke Annotation
	decodeJSON(t, rr, &stroke)
	if stroke.Color != "#e3b341" || stroke.AnchorText != "日记" || stroke.Kind != "stroke" || stroke.ID == "" {
		t.Fatalf("stroke: %+v", stroke)
	}
	rr = request(t, h, "POST", "/api/annotations", map[string]any{
		"notePath": "日记.md", "kind": "highlight", "anchorLine": 1, "anchorText": "日记", "color": "#7dba8d", "data": annotationHighlight(), "comment": "这里",
	})
	if rr.Code != 201 {
		t.Fatalf("create highlight: %d %s", rr.Code, rr.Body.String())
	}
	var highlight Annotation
	decodeJSON(t, rr, &highlight)
	rr = request(t, h, "PUT", "/api/annotations", map[string]any{"id": highlight.ID, "comment": "改过的批注"})
	if rr.Code != 200 {
		t.Fatalf("update: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "PUT", "/api/annotations/visibility", map[string]any{"path": "日记.md", "visible": true})
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"visible":true`) {
		t.Fatalf("visibility: %d %s", rr.Code, rr.Body.String())
	}
	annotations, err := s.annotationService()
	if err != nil {
		t.Fatal(err)
	}
	list, err := annotations.List("日记.md")
	if err != nil || !list.Visible || len(list.Items) != 2 || list.Items[1].Comment != "改过的批注" {
		t.Fatalf("list after update: %+v %v", list, err)
	}
	rr = request(t, h, "DELETE", "/api/annotations?id="+stroke.ID, nil)
	if rr.Code != 200 {
		t.Fatalf("delete: %d %s", rr.Code, rr.Body.String())
	}
	list, err = annotations.List("日记.md")
	if err != nil || len(list.Items) != 1 || list.Items[0].ID != highlight.ID {
		t.Fatalf("after delete: %+v %v", list, err)
	}

	for _, item := range []struct {
		route string
		body  any
	}{
		{"/api/annotations", map[string]any{"notePath": "日记.md", "kind": "box", "anchorLine": 1, "anchorText": "日记", "color": "#e3b341", "data": annotationStroke()}},
		{"/api/annotations", map[string]any{"notePath": "日记.md", "kind": "stroke", "anchorLine": 1, "anchorText": "日记", "color": "red", "data": annotationStroke()}},
		{"/api/annotations", map[string]any{"notePath": "日记.md", "kind": "highlight", "anchorLine": 1, "anchorText": "日记", "color": "#e3b341", "data": map[string]any{"start": 3, "end": 1, "quote": "记录"}}},
		{"/api/annotations", map[string]any{"notePath": "不存在.md", "kind": "stroke", "anchorLine": 1, "anchorText": "日记", "color": "#e3b341", "data": annotationStroke()}},
		{"/api/annotations", map[string]any{"notePath": "../日记.md", "kind": "stroke", "anchorLine": 1, "anchorText": "日记", "color": "#e3b341", "data": annotationStroke()}},
		{"/api/annotations", map[string]any{"notePath": "日记.md", "kind": "highlight", "anchorLine": 1, "anchorText": "日记", "color": "#e3b341", "data": annotationHighlight(), "comment": strings.Repeat("注", 2001)}},
	} {
		rr = request(t, h, "POST", item.route, item.body)
		if rr.Code == 200 || rr.Code == 201 {
			t.Fatalf("accepted invalid annotation %#v: %s", item.body, rr.Body.String())
		}
	}
	rr = request(t, h, "GET", "/api/annotations?path=不存在.md", nil)
	if rr.Code != 404 {
		t.Fatalf("missing note: %d %s", rr.Code, rr.Body.String())
	}
	if err = annotations.Delete(highlight.ID); err != nil {
		t.Fatal(err)
	}
	if err = annotations.Delete(highlight.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestAnnotationMoveRewritesPaths(t *testing.T) {
	s := testStore(t)
	t.Cleanup(func() { s.closeAnnotations() })
	note := create(t, s, "项目/记录.md", "# 记录\n")
	create(t, s, "其他.md", "# 其他\n")
	annotations, err := s.annotationService()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = annotations.Create("项目/记录.md", annotationWrite{Kind: "highlight", AnchorLine: 1, AnchorText: "记录", Color: "#e3b341", Data: mustJSON(t, annotationHighlight()), Comment: "留下"}); err != nil {
		t.Fatal(err)
	}
	if err = annotations.SetVisible("项目/记录.md", true); err != nil {
		t.Fatal(err)
	}
	if err = annotations.SetVisible("其他.md", true); err != nil {
		t.Fatal(err)
	}
	if err = annotations.SetVisible("归档/项目/记录.md", false); err != nil {
		t.Fatal(err)
	}
	undo, err := annotations.Relocate("项目", "归档/项目")
	if err != nil {
		t.Fatal(err)
	}
	moved, err := annotations.List("归档/项目/记录.md")
	if err != nil || !moved.Visible || len(moved.Items) != 1 || moved.Items[0].Comment != "留下" {
		t.Fatalf("moved: %+v %v", moved, err)
	}
	left, err := annotations.List("其他.md")
	if err != nil || !left.Visible || len(left.Items) != 0 {
		t.Fatalf("untouched: %+v %v", left, err)
	}
	if err = undo(); err != nil {
		t.Fatal(err)
	}
	restored, err := annotations.List("项目/记录.md")
	if err != nil || !restored.Visible || len(restored.Items) != 1 {
		t.Fatalf("undo: %+v %v", restored, err)
	}
	displaced, err := annotations.List("归档/项目/记录.md")
	if err != nil || displaced.Visible || len(displaced.Items) != 0 {
		t.Fatalf("displaced preference: %+v %v", displaced, err)
	}
	if _, err = s.move(note.Path, "归档/记录.md", note.Revision, false); err != nil {
		t.Fatal(err)
	}
	afterMove, err := annotations.List("归档/记录.md")
	if err != nil || !afterMove.Visible || len(afterMove.Items) != 1 {
		t.Fatalf("store move: %+v %v", afterMove, err)
	}
	if _, err = s.move("归档", "资料", "", true); err != nil {
		t.Fatal(err)
	}
	afterFolder, err := annotations.List("资料/记录.md")
	if err != nil || len(afterFolder.Items) != 1 || !afterFolder.Visible {
		t.Fatalf("folder move: %+v %v", afterFolder, err)
	}
}

func TestAnnotationCloseAndSchema(t *testing.T) {
	s := testStore(t)
	annotations, err := openAnnotations(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = annotations.db.Exec("PRAGMA user_version = 2"); err != nil {
		t.Fatal(err)
	}
	annotations.close()
	if _, err = openAnnotations(s.root); err == nil || !strings.Contains(err.Error(), "请升级") {
		t.Fatalf("newer schema: %v", err)
	}
	if err = osRemoveAnnotations(s); err != nil {
		t.Fatal(err)
	}
	opened, err := s.annotationService()
	if err != nil {
		t.Fatal(err)
	}
	s.closeAnnotations()
	if _, err = opened.List("日记.md"); !errors.Is(err, errAnnotationsClosed) {
		t.Fatalf("closed db: %v", err)
	}
	if _, err = s.annotationService(); !errors.Is(err, errAnnotationsClosed) {
		t.Fatalf("reopen after close: %v", err)
	}
}

func osRemoveAnnotations(s *Store) error {
	for _, name := range []string{"annotations.db", "annotations.db-wal", "annotations.db-shm"} {
		if err := os.Remove(filepath.Join(s.root, ".echo", name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func decodeJSON(t *testing.T, rr *httptest.ResponseRecorder, value any) {
	t.Helper()
	if err := json.Unmarshal(rr.Body.Bytes(), value); err != nil {
		t.Fatalf("json: %v body=%s", err, rr.Body.String())
	}
}
