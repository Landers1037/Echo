package app

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const annotationSchemaVersion = 1
const maxAnnotationData = 512 * 1024
const maxAnnotationComment = 2000
const maxAnnotationPoints = 4000
const maxHighlightRunes = 4000

var errAnnotationsClosed = errors.New("笔记库已关闭")
var annotationColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type Annotation struct {
	ID         string          `json:"id"`
	NotePath   string          `json:"notePath"`
	Kind       string          `json:"kind"`
	AnchorLine int             `json:"anchorLine"`
	AnchorText string          `json:"anchorText"`
	Color      string          `json:"color"`
	Data       json.RawMessage `json:"data"`
	Comment    string          `json:"comment"`
	CreatedAt  string          `json:"createdAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

type AnnotationList struct {
	Visible bool         `json:"visible"`
	Items   []Annotation `json:"items"`
}

type Annotations struct {
	mu     sync.Mutex
	db     *sql.DB
	closed bool
}

type annotationWrite struct {
	NotePath   string          `json:"notePath"`
	Kind       string          `json:"kind"`
	AnchorLine int             `json:"anchorLine"`
	AnchorText string          `json:"anchorText"`
	Color      string          `json:"color"`
	Data       json.RawMessage `json:"data"`
	Comment    string          `json:"comment"`
}

type annotationPatch struct {
	ID      string          `json:"id"`
	Comment *string         `json:"comment"`
	Color   *string         `json:"color"`
	Data    json.RawMessage `json:"data"`
}

type annotationVisibility struct {
	Path    string `json:"path"`
	Visible bool   `json:"visible"`
}

type strokeData struct {
	Points [][2]float64 `json:"points"`
	Width  float64      `json:"width"`
}

type highlightData struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Quote string `json:"quote"`
}

type annotationPathChange struct {
	table   string
	id      string
	oldPath string
	newPath string
	// displaced is a preference row removed because the move took its path.
	displaced *annotationPref
}

type annotationPref struct {
	path    string
	visible bool
}

func openAnnotations(root string) (*Annotations, error) {
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", sqliteDSN(filepath.Join(root, ".echo", "annotations.db")))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	annotations := &Annotations{db: db}
	if err = annotations.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return annotations, nil
}

func (a *Annotations) migrate() error {
	var version int
	if err := a.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > annotationSchemaVersion {
		return fmt.Errorf("标注数据由更新版本的 Echo 创建，请升级后再打开")
	}
	if version == annotationSchemaVersion {
		return nil
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	schema := `
CREATE TABLE annotations (
	id TEXT PRIMARY KEY,
	note_path TEXT NOT NULL,
	kind TEXT NOT NULL,
	anchor_line INTEGER NOT NULL,
	anchor_text TEXT NOT NULL,
	color TEXT NOT NULL,
	data TEXT NOT NULL,
	comment TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_note ON annotations(note_path);
CREATE TABLE annotation_prefs (
	note_path TEXT PRIMARY KEY,
	visible INTEGER NOT NULL
);
`
	if _, err = tx.Exec(schema); err != nil {
		return err
	}
	if _, err = tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", annotationSchemaVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) annotationService() (*Annotations, error) {
	s.annotationsMu.Lock()
	defer s.annotationsMu.Unlock()
	if s.annotationsClosed {
		return nil, errAnnotationsClosed
	}
	if s.annotations != nil {
		return s.annotations, nil
	}
	annotations, err := openAnnotations(s.root)
	if err != nil {
		return nil, err
	}
	s.annotations = annotations
	return annotations, nil
}

func (s *Store) closeAnnotations() {
	s.annotationsMu.Lock()
	s.annotationsClosed = true
	annotations := s.annotations
	s.annotations = nil
	s.annotationsMu.Unlock()
	if annotations != nil {
		annotations.close()
	}
}

func (a *Annotations) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	if a.db != nil {
		_ = a.db.Close()
		a.db = nil
	}
}

func (a *Annotations) withDB(fn func(*sql.DB) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.db == nil {
		return errAnnotationsClosed
	}
	return fn(a.db)
}

func (s *Store) validateAnnotationNote(name string) (string, error) {
	s.mu.Lock()
	assets := s.state.Settings.AssetsDir
	s.mu.Unlock()
	name, err := cleanRelative(name)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(path.Ext(name), ".md") {
		return "", fmt.Errorf("笔记必须使用 .md 扩展名")
	}
	if name == assets || strings.HasPrefix(name, assets+"/") {
		return "", fmt.Errorf("不能在资源目录中保存笔记")
	}
	full, err := s.safePath(name)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("标注只能附加在笔记文件上")
	}
	return name, nil
}

func (h *handler) annotationRoutes(w http.ResponseWriter, r *http.Request) error {
	s := h.ws.current()
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if _, err := os.Stat(s.journalPath()); err == nil {
			return fmt.Errorf("资源迁移尚待恢复，已暂时停止写入以保护笔记。请备份数据后重启并查看恢复提示")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	annotations, err := s.annotationService()
	if err != nil {
		return err
	}
	switch r.URL.Path {
	case "/api/annotations":
		return annotations.serve(s, w, r)
	case "/api/annotations/visibility":
		return annotations.serveVisibility(s, w, r)
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}

func (a *Annotations) serve(s *Store, w http.ResponseWriter, r *http.Request) error {
	switch r.Method {
	case http.MethodGet:
		notePath, err := s.validateAnnotationNote(r.URL.Query().Get("path"))
		if err != nil {
			return err
		}
		list, err := a.List(notePath)
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, list)
		return nil
	case http.MethodPost:
		var input annotationWrite
		if err := decode(r, &input); err != nil {
			return err
		}
		notePath, err := s.validateAnnotationNote(input.NotePath)
		if err != nil {
			return err
		}
		created, err := a.Create(notePath, input)
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusCreated, created)
		return nil
	case http.MethodPut:
		var input annotationPatch
		if err := decode(r, &input); err != nil {
			return err
		}
		updated, err := a.Update(input)
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, updated)
		return nil
	case http.MethodDelete:
		if err := a.Delete(r.URL.Query().Get("id")); err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
		return nil
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}

func (a *Annotations) serveVisibility(s *Store, w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPut {
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
	var input annotationVisibility
	if err := decode(r, &input); err != nil {
		return err
	}
	notePath, err := s.validateAnnotationNote(input.Path)
	if err != nil {
		return err
	}
	if err = a.SetVisible(notePath, input.Visible); err != nil {
		return err
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"visible": input.Visible})
	return nil
}

func (a *Annotations) List(notePath string) (AnnotationList, error) {
	list := AnnotationList{Items: []Annotation{}}
	err := a.withDB(func(db *sql.DB) error {
		var visible int
		err := db.QueryRow(`SELECT visible FROM annotation_prefs WHERE note_path = ?`, notePath).Scan(&visible)
		if err == nil {
			list.Visible = visible != 0
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		rows, err := db.Query(`SELECT id, note_path, kind, anchor_line, anchor_text, color, data, comment, created_at, updated_at FROM annotations WHERE note_path = ? ORDER BY created_at ASC, id ASC`, notePath)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanAnnotation(rows)
			if err != nil {
				return err
			}
			list.Items = append(list.Items, item)
		}
		return rows.Err()
	})
	return list, err
}

func (a *Annotations) Create(notePath string, input annotationWrite) (Annotation, error) {
	kind, anchorText, color, data, comment, err := normalizeAnnotation(input.Kind, input.AnchorLine, input.AnchorText, input.Color, input.Data, input.Comment)
	if err != nil {
		return Annotation{}, err
	}
	now := agentNow()
	item := Annotation{ID: newID(), NotePath: notePath, Kind: kind, AnchorLine: input.AnchorLine, AnchorText: anchorText, Color: color, Data: json.RawMessage(data), Comment: comment, CreatedAt: now, UpdatedAt: now}
	err = a.withDB(func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO annotations (id, note_path, kind, anchor_line, anchor_text, color, data, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			item.ID, item.NotePath, item.Kind, item.AnchorLine, item.AnchorText, item.Color, data, item.Comment, item.CreatedAt, item.UpdatedAt)
		return err
	})
	return item, err
}

func (a *Annotations) Update(input annotationPatch) (Annotation, error) {
	id := strings.TrimSpace(input.ID)
	if id == "" || strings.ContainsRune(id, '\x00') || len(id) > 64 {
		return Annotation{}, fmt.Errorf("无效的标注")
	}
	if input.Comment == nil && input.Color == nil && len(input.Data) == 0 {
		return Annotation{}, fmt.Errorf("没有可更新的标注内容")
	}
	var updated Annotation
	err := a.withDB(func(db *sql.DB) error {
		current, err := scanAnnotation(db.QueryRow(`SELECT id, note_path, kind, anchor_line, anchor_text, color, data, comment, created_at, updated_at FROM annotations WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("找不到该标注")
		}
		if err != nil {
			return err
		}
		comment := current.Comment
		if input.Comment != nil {
			comment, err = normalizeComment(*input.Comment)
			if err != nil {
				return err
			}
		}
		color := current.Color
		if input.Color != nil {
			color, err = normalizeAnnotationColor(*input.Color)
			if err != nil {
				return err
			}
		}
		data := string(current.Data)
		if len(input.Data) > 0 {
			data, err = normalizeAnnotationData(current.Kind, input.Data)
			if err != nil {
				return err
			}
		}
		now := agentNow()
		if _, err = db.Exec(`UPDATE annotations SET color = ?, data = ?, comment = ?, updated_at = ? WHERE id = ?`, color, data, comment, now, id); err != nil {
			return err
		}
		updated, err = scanAnnotation(db.QueryRow(`SELECT id, note_path, kind, anchor_line, anchor_text, color, data, comment, created_at, updated_at FROM annotations WHERE id = ?`, id))
		return err
	})
	return updated, err
}

func (a *Annotations) Delete(id string) error {
	id = strings.TrimSpace(id)
	if id == "" || strings.ContainsRune(id, '\x00') || len(id) > 64 {
		return fmt.Errorf("无效的标注")
	}
	return a.withDB(func(db *sql.DB) error {
		result, err := db.Exec(`DELETE FROM annotations WHERE id = ?`, id)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return notFound("找不到该标注")
		}
		return nil
	})
}

func (a *Annotations) SetVisible(notePath string, visible bool) error {
	flag := 0
	if visible {
		flag = 1
	}
	return a.withDB(func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO annotation_prefs (note_path, visible) VALUES (?, ?) ON CONFLICT(note_path) DO UPDATE SET visible = excluded.visible`, notePath, flag)
		return err
	})
}

// relocateAnnotations rewrites stored note paths after a successful file move.
// The returned function restores only the rows this call changed.
func (s *Store) relocateAnnotations(from, to string) (func() error, error) {
	noop := func() error { return nil }
	if from == to {
		return noop, nil
	}
	s.annotationsMu.Lock()
	opened := s.annotations != nil
	closed := s.annotationsClosed
	s.annotationsMu.Unlock()
	if closed {
		return nil, errAnnotationsClosed
	}
	if !opened {
		info, err := os.Lstat(filepath.Join(s.root, ".echo", "annotations.db"))
		if errors.Is(err, os.ErrNotExist) {
			return noop, nil
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf(".echo 配置目录不能包含符号链接")
		}
	}
	annotations, err := s.annotationService()
	if err != nil {
		return nil, err
	}
	return annotations.Relocate(from, to)
}

func (a *Annotations) Relocate(from, to string) (func() error, error) {
	var changes []annotationPathChange
	err := a.withDB(func(db *sql.DB) error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		like := escapeLikePrefix(from)
		rows, err := tx.Query(`SELECT id, note_path FROM annotations WHERE note_path = ? OR note_path LIKE ? ESCAPE '\'`, from, like)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, notePath string
			if err = rows.Scan(&id, &notePath); err != nil {
				rows.Close()
				return err
			}
			changes = append(changes, annotationPathChange{table: "annotations", id: id, oldPath: notePath, newPath: remapPrefix(notePath, from, to)})
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		prefRows, err := tx.Query(`SELECT note_path, visible FROM annotation_prefs WHERE note_path = ? OR note_path LIKE ? ESCAPE '\'`, from, like)
		if err != nil {
			return err
		}
		var prefs []annotationPathChange
		for prefRows.Next() {
			var notePath string
			var visible int
			if err = prefRows.Scan(&notePath, &visible); err != nil {
				prefRows.Close()
				return err
			}
			prefs = append(prefs, annotationPathChange{table: "annotation_prefs", oldPath: notePath, newPath: remapPrefix(notePath, from, to)})
			_ = visible
		}
		if err = prefRows.Err(); err != nil {
			prefRows.Close()
			return err
		}
		prefRows.Close()
		for _, change := range changes {
			if _, err = tx.Exec(`UPDATE annotations SET note_path = ? WHERE id = ?`, change.newPath, change.id); err != nil {
				return err
			}
		}
		for index := range prefs {
			var visible int
			err = tx.QueryRow(`SELECT visible FROM annotation_prefs WHERE note_path = ?`, prefs[index].newPath).Scan(&visible)
			if err == nil {
				prefs[index].displaced = &annotationPref{path: prefs[index].newPath, visible: visible != 0}
				if _, err = tx.Exec(`DELETE FROM annotation_prefs WHERE note_path = ?`, prefs[index].newPath); err != nil {
					return err
				}
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if _, err = tx.Exec(`UPDATE annotation_prefs SET note_path = ? WHERE note_path = ?`, prefs[index].newPath, prefs[index].oldPath); err != nil {
				return err
			}
		}
		changes = append(changes, prefs...)
		return tx.Commit()
	})
	if err != nil {
		return nil, err
	}
	undo := func() error {
		if len(changes) == 0 {
			return nil
		}
		return a.withDB(func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()
			for index := len(changes) - 1; index >= 0; index-- {
				change := changes[index]
				if change.table == "annotations" {
					if _, err = tx.Exec(`UPDATE annotations SET note_path = ? WHERE id = ?`, change.oldPath, change.id); err != nil {
						return err
					}
					continue
				}
				if _, err = tx.Exec(`UPDATE annotation_prefs SET note_path = ? WHERE note_path = ?`, change.oldPath, change.newPath); err != nil {
					return err
				}
				if change.displaced != nil {
					flag := 0
					if change.displaced.visible {
						flag = 1
					}
					if _, err = tx.Exec(`INSERT INTO annotation_prefs (note_path, visible) VALUES (?, ?)`, change.displaced.path, flag); err != nil {
						return err
					}
				}
			}
			return tx.Commit()
		})
	}
	return undo, nil
}

func escapeLikePrefix(prefix string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(prefix) + "/%"
}

func scanAnnotation(row interface{ Scan(...any) error }) (Annotation, error) {
	var item Annotation
	var data string
	err := row.Scan(&item.ID, &item.NotePath, &item.Kind, &item.AnchorLine, &item.AnchorText, &item.Color, &data, &item.Comment, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return Annotation{}, err
	}
	item.Data = json.RawMessage(data)
	return item, nil
}

func normalizeAnnotation(kind string, anchorLine int, anchorText, color string, raw json.RawMessage, comment string) (string, string, string, string, string, error) {
	if kind != "stroke" && kind != "highlight" {
		return "", "", "", "", "", fmt.Errorf("无效的标注类型")
	}
	if anchorLine < 1 || anchorLine > 1000000 {
		return "", "", "", "", "", fmt.Errorf("标注锚点无效")
	}
	anchorText, err := normalizeAnchorText(anchorText)
	if err != nil {
		return "", "", "", "", "", err
	}
	color, err = normalizeAnnotationColor(color)
	if err != nil {
		return "", "", "", "", "", err
	}
	data, err := normalizeAnnotationData(kind, raw)
	if err != nil {
		return "", "", "", "", "", err
	}
	comment, err = normalizeComment(comment)
	if err != nil {
		return "", "", "", "", "", err
	}
	return kind, anchorText, color, data, comment, nil
}

func normalizeAnchorText(value string) (string, error) {
	if strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("锚点文本无效")
	}
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > 80 {
		value = string(runes[:80])
	}
	return value, nil
}

func normalizeAnnotationColor(value string) (string, error) {
	if !annotationColorPattern.MatchString(value) {
		return "", fmt.Errorf("标注颜色无效")
	}
	return strings.ToLower(value), nil
}

func normalizeComment(value string) (string, error) {
	if strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("批注不能包含空字符")
	}
	if utf8.RuneCountInString(value) > maxAnnotationComment {
		return "", fmt.Errorf("批注不能超过 2000 个字符")
	}
	return value, nil
}

func normalizeAnnotationData(kind string, raw json.RawMessage) (string, error) {
	if len(raw) == 0 || len(raw) > maxAnnotationData {
		return "", fmt.Errorf("标注数据无效")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	switch kind {
	case "stroke":
		var data strokeData
		if err := decoder.Decode(&data); err != nil {
			return "", fmt.Errorf("画线数据无效")
		}
		if err := ensureEOF(decoder); err != nil {
			return "", fmt.Errorf("画线数据无效")
		}
		if err := validateStroke(data); err != nil {
			return "", err
		}
		encoded, err := json.Marshal(data)
		return string(encoded), err
	case "highlight":
		var data highlightData
		if err := decoder.Decode(&data); err != nil {
			return "", fmt.Errorf("高亮数据无效")
		}
		if err := ensureEOF(decoder); err != nil {
			return "", fmt.Errorf("高亮数据无效")
		}
		if err := validateHighlight(data); err != nil {
			return "", err
		}
		encoded, err := json.Marshal(data)
		return string(encoded), err
	default:
		return "", fmt.Errorf("无效的标注类型")
	}
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return fmt.Errorf("多余内容")
	}
	return nil
}

func validateStroke(data strokeData) error {
	if len(data.Points) < 1 || len(data.Points) > maxAnnotationPoints {
		return fmt.Errorf("画线数据无效")
	}
	if math.IsNaN(data.Width) || math.IsInf(data.Width, 0) || data.Width <= 0 || data.Width > 0.2 {
		return fmt.Errorf("画线粗细无效")
	}
	for _, point := range data.Points {
		if !validStrokePoint(point[0], point[1]) {
			return fmt.Errorf("画线数据无效")
		}
	}
	return nil
}

func validStrokePoint(x, y float64) bool {
	if math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0) {
		return false
	}
	return x >= -0.5 && x <= 1.5 && y >= -2000 && y <= 20000
}

func validateHighlight(data highlightData) error {
	if data.Start < 0 || data.End <= data.Start || data.End-data.Start > maxHighlightRunes*2 {
		return fmt.Errorf("高亮范围无效")
	}
	if strings.TrimSpace(data.Quote) == "" || strings.ContainsRune(data.Quote, '\x00') || utf8.RuneCountInString(data.Quote) > maxHighlightRunes {
		return fmt.Errorf("高亮文本无效")
	}
	return nil
}
