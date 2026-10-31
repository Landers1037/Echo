package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const noteVersionSchemaVersion = 2
const maxVersionLabelRunes = 80

var errVersionsClosed = errors.New("笔记库已关闭")
var errVersionRepoNotReady = errors.New("版本仓库尚未初始化")

type NoteVersion struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	ObjectHash string `json:"objectHash"`
	CreatedAt  string `json:"createdAt"`
	Source     string `json:"source"`
	Label      string `json:"label"`
}

type VersionRepoStatus struct {
	Initialized   bool   `json:"initialized"`
	Enabled       bool   `json:"enabled"`
	AutoDaily     bool   `json:"autoDaily"`
	VersionCount  int    `json:"versionCount"`
	ObjectCount   int    `json:"objectCount"`
	ObjectBytes   int64  `json:"objectBytes"`
	LastCreatedAt string `json:"lastCreatedAt,omitempty"`
	LastAutoDay   string `json:"lastAutoDay,omitempty"`
	DirtyNotes    int    `json:"dirtyNotes"`
}

type NoteVersions struct {
	mu     sync.Mutex
	root   string
	db     *sql.DB
	closed bool
}

func versionNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
}

func contentHash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func objectRelPath(hash string) string {
	if len(hash) < 2 {
		return hash
	}
	return filepath.Join(hash[:2], hash)
}

func openNoteVersions(root string) (*NoteVersions, error) {
	if err := os.MkdirAll(filepath.Join(root, ".echo"), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", sqliteDSN(filepath.Join(root, ".echo", "versions.db")))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	versions := &NoteVersions{root: root, db: db}
	if err = versions.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return versions, nil
}

func (v *NoteVersions) migrate() error {
	var version int
	if err := v.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version > noteVersionSchemaVersion {
		return fmt.Errorf("版本仓库数据库由更新版本的 Echo 创建，请升级应用")
	}
	tx, err := v.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`
CREATE TABLE IF NOT EXISTS objects (
  hash TEXT PRIMARY KEY NOT NULL,
  refs INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(object_hash) REFERENCES objects(hash)
);
CREATE INDEX IF NOT EXISTS versions_path_created ON versions(path, created_at DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);`); err != nil {
		return err
	}
	// Older installs created versions without label; always repair missing columns
	// even when user_version was already bumped.
	if err = ensureSQLiteColumn(tx, "versions", "label", `ALTER TABLE versions ADD COLUMN label TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if version != noteVersionSchemaVersion {
		if _, err = tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, noteVersionSchemaVersion)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func ensureSQLiteColumn(tx *sql.Tx, table, column, alterSQL string) error {
	rows, err := tx.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err = rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if strings.EqualFold(name, column) {
			return nil
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	_, err = tx.Exec(alterSQL)
	return err
}

func normalizeVersionLabel(label string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", fmt.Errorf("版本名称不能为空")
	}
	if strings.ContainsAny(label, "\r\n\x00") {
		return "", fmt.Errorf("版本名称不能包含换行")
	}
	if utf8.RuneCountInString(label) > maxVersionLabelRunes {
		return "", fmt.Errorf("版本名称不能超过 %d 个字符", maxVersionLabelRunes)
	}
	return label, nil
}

func (v *NoteVersions) close() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.closed = true
	if v.db != nil {
		_ = v.db.Close()
		v.db = nil
	}
}

func (v *NoteVersions) exportDatabase() ([]byte, error) {
	var data []byte
	err := v.withDB(func(db *sql.DB) error {
		var err error
		data, err = vacuumSQLite(db)
		if err != nil {
			return fmt.Errorf("无法导出版本仓库：%w", err)
		}
		return nil
	})
	return data, err
}

func (v *NoteVersions) withDB(fn func(*sql.DB) error) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.db == nil {
		return errVersionsClosed
	}
	return fn(v.db)
}

func (v *NoteVersions) objectsDir() string {
	return filepath.Join(v.root, ".echo", "version-objects")
}

func (v *NoteVersions) objectPath(hash string) string {
	return filepath.Join(v.objectsDir(), objectRelPath(hash))
}

func (v *NoteVersions) ensureInitialized() error {
	return v.withDB(func(db *sql.DB) error {
		if err := os.MkdirAll(v.objectsDir(), 0700); err != nil {
			return err
		}
		_, err := db.Exec(`INSERT INTO meta(key, value) VALUES('initialized', '1')
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		return err
	})
}

func (v *NoteVersions) isInitialized() (bool, error) {
	var ready bool
	err := v.withDB(func(db *sql.DB) error {
		var value string
		err := db.QueryRow(`SELECT value FROM meta WHERE key = 'initialized'`).Scan(&value)
		if errors.Is(err, sql.ErrNoRows) {
			ready = false
			return nil
		}
		if err != nil {
			return err
		}
		ready = value == "1"
		return nil
	})
	return ready, err
}

func (v *NoteVersions) requireReady() error {
	ready, err := v.isInitialized()
	if err != nil {
		return err
	}
	if !ready {
		return errVersionRepoNotReady
	}
	return nil
}

func (v *NoteVersions) metaGet(key string) (string, error) {
	var value string
	err := v.withDB(func(db *sql.DB) error {
		err := db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
		if errors.Is(err, sql.ErrNoRows) {
			value = ""
			return nil
		}
		return err
	})
	return value, err
}

func (v *NoteVersions) metaSet(key, value string) error {
	return v.withDB(func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO meta(key, value) VALUES(?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
		return err
	})
}

func (s *Store) versionService() (*NoteVersions, error) {
	s.versionsMu.Lock()
	defer s.versionsMu.Unlock()
	if s.versionsClosed {
		return nil, errVersionsClosed
	}
	if s.versions != nil {
		return s.versions, nil
	}
	versions, err := openNoteVersions(s.root)
	if err != nil {
		return nil, err
	}
	s.versions = versions
	return versions, nil
}

func (s *Store) closeVersions() {
	s.versionsMu.Lock()
	s.versionsClosed = true
	versions := s.versions
	s.versions = nil
	s.versionsMu.Unlock()
	if versions != nil {
		versions.close()
	}
}

func (s *Store) initVersionRepo() (VersionRepoStatus, error) {
	versions, err := s.versionService()
	if err != nil {
		return VersionRepoStatus{}, err
	}
	if err = versions.ensureInitialized(); err != nil {
		return VersionRepoStatus{}, err
	}
	return s.versionRepoStatus()
}

func (s *Store) versionRepoStatus() (VersionRepoStatus, error) {
	// Settings reads are done without taking s.mu so callers that already hold
	// the store lock (init / restore routes) do not deadlock.
	status := VersionRepoStatus{
		Enabled:   s.state.Settings.VersionRepoEnabled,
		AutoDaily: s.state.Settings.AutoVersionDaily,
	}
	info, err := os.Lstat(filepath.Join(s.root, ".echo", "versions.db"))
	if errors.Is(err, os.ErrNotExist) {
		return status, nil
	}
	if err != nil {
		return status, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return status, fmt.Errorf(".echo 配置目录不能包含符号链接")
	}

	versions, err := s.versionService()
	if err != nil {
		return status, err
	}
	ready, err := versions.isInitialized()
	if err != nil {
		return status, err
	}
	status.Initialized = ready
	if !ready {
		return status, nil
	}

	err = versions.withDB(func(db *sql.DB) error {
		if err := db.QueryRow(`SELECT COUNT(*) FROM versions`).Scan(&status.VersionCount); err != nil {
			return err
		}
		if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(size), 0) FROM objects`).Scan(&status.ObjectCount, &status.ObjectBytes); err != nil {
			return err
		}
		var last sql.NullString
		if err := db.QueryRow(`SELECT created_at FROM versions ORDER BY created_at DESC LIMIT 1`).Scan(&last); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if last.Valid {
			status.LastCreatedAt = last.String
		}
		return nil
	})
	if err != nil {
		return status, err
	}
	status.LastAutoDay, err = versions.metaGet("last_auto_day")
	if err != nil {
		return status, err
	}
	if status.Enabled {
		status.DirtyNotes, err = s.countDirtyVersionNotes(versions)
		if err != nil {
			return status, err
		}
	}
	return status, nil
}

func (s *Store) countDirtyVersionNotes(versions *NoteVersions) (int, error) {
	notes, err := s.listNotes()
	if err != nil {
		return 0, err
	}
	latest := map[string]string{}
	err = versions.withDB(func(db *sql.DB) error {
		rows, err := db.Query(`SELECT path, object_hash FROM versions v
			WHERE created_at = (SELECT MAX(created_at) FROM versions WHERE path = v.path)`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var pathName, hash string
			if err = rows.Scan(&pathName, &hash); err != nil {
				return err
			}
			latest[pathName] = hash
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}
	dirty := 0
	for _, note := range notes {
		hash := contentHash([]byte(note.Content))
		if latest[note.Path] != hash {
			dirty++
		}
	}
	return dirty, nil
}

func (s *Store) createNoteVersion(notePath, source string) (NoteVersion, error) {
	if source != "auto" && source != "manual" {
		return NoteVersion{}, fmt.Errorf("无效的版本来源")
	}
	notePath, err := cleanRelative(notePath)
	if err != nil {
		return NoteVersion{}, err
	}
	if !strings.EqualFold(path.Ext(notePath), ".md") {
		return NoteVersion{}, fmt.Errorf("只能为 Markdown 笔记创建版本")
	}
	note, err := s.readNote(notePath)
	if err != nil {
		return NoteVersion{}, err
	}
	versions, err := s.versionService()
	if err != nil {
		return NoteVersion{}, err
	}
	if err = versions.requireReady(); err != nil {
		return NoteVersion{}, err
	}
	content := []byte(note.Content)
	hash := contentHash(content)
	createdAt := versionNow()
	id := newID()

	err = versions.withDB(func(db *sql.DB) error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()

		var refs int
		err = tx.QueryRow(`SELECT refs FROM objects WHERE hash = ?`, hash).Scan(&refs)
		if errors.Is(err, sql.ErrNoRows) {
			if err = os.MkdirAll(filepath.Dir(versions.objectPath(hash)), 0700); err != nil {
				return err
			}
			if err = atomicWrite(versions.objectPath(hash), content, 0600); err != nil {
				return err
			}
			if _, err = tx.Exec(`INSERT INTO objects(hash, refs, size) VALUES(?, 1, ?)`, hash, len(content)); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else {
			if _, err = tx.Exec(`UPDATE objects SET refs = refs + 1 WHERE hash = ?`, hash); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(`INSERT INTO versions(id, path, object_hash, created_at, source, label) VALUES(?, ?, ?, ?, ?, '')`,
			id, notePath, hash, createdAt, source); err != nil {
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		return NoteVersion{}, err
	}
	items, err := s.listNoteVersions(notePath)
	if err != nil {
		return NoteVersion{ID: id, Path: notePath, ObjectHash: hash, CreatedAt: createdAt, Source: source}, nil
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return NoteVersion{ID: id, Path: notePath, ObjectHash: hash, CreatedAt: createdAt, Source: source}, nil
}

func (s *Store) listNoteVersions(notePath string) ([]NoteVersion, error) {
	notePath, err := cleanRelative(notePath)
	if err != nil {
		return nil, err
	}
	versions, err := s.versionService()
	if err != nil {
		return nil, err
	}
	if err = versions.requireReady(); err != nil {
		return nil, err
	}
	var items []NoteVersion
	err = versions.withDB(func(db *sql.DB) error {
		rows, err := db.Query(`SELECT id, path, object_hash, created_at, source, label FROM versions WHERE path = ? ORDER BY created_at ASC, id ASC`, notePath)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item NoteVersion
			var custom string
			if err = rows.Scan(&item.ID, &item.Path, &item.ObjectHash, &item.CreatedAt, &item.Source, &custom); err != nil {
				return err
			}
			item.Label = custom
			items = append(items, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []NoteVersion{}
	}
	labelNoteVersions(items)
	// Newest first for UI.
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].ID > items[j].ID
		}
		return items[i].CreatedAt > items[j].CreatedAt
	})
	return items, nil
}

func labelNoteVersions(items []NoteVersion) {
	counts := map[string]int{}
	for i := range items {
		custom := strings.TrimSpace(items[i].Label)
		day := localVersionDay(items[i].CreatedAt)
		counts[day]++
		if custom != "" {
			items[i].Label = custom
			continue
		}
		items[i].Label = fmt.Sprintf("%s-v%d", day, counts[day])
	}
}

func (s *Store) renameNoteVersion(id, label string) (NoteVersion, error) {
	label, err := normalizeVersionLabel(label)
	if err != nil {
		return NoteVersion{}, err
	}
	versions, err := s.versionService()
	if err != nil {
		return NoteVersion{}, err
	}
	if err = versions.requireReady(); err != nil {
		return NoteVersion{}, err
	}
	var notePath string
	err = versions.withDB(func(db *sql.DB) error {
		err := db.QueryRow(`SELECT path FROM versions WHERE id = ?`, id).Scan(&notePath)
		if errors.Is(err, sql.ErrNoRows) {
			return os.ErrNotExist
		}
		if err != nil {
			return err
		}
		_, err = db.Exec(`UPDATE versions SET label = ? WHERE id = ?`, label, id)
		return err
	})
	if err != nil {
		return NoteVersion{}, err
	}
	items, err := s.listNoteVersions(notePath)
	if err != nil {
		return NoteVersion{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return NoteVersion{}, os.ErrNotExist
}

func localVersionDay(createdAt string) string {
	t, err := time.Parse("2006-01-02T15:04:05.000000000Z", createdAt)
	if err != nil {
		if t, err = time.Parse(time.RFC3339Nano, createdAt); err != nil {
			return createdAt
		}
	}
	return t.In(time.Local).Format("2006-01-02")
}

func (s *Store) readNoteVersionContent(id string) (string, string, error) {
	versions, err := s.versionService()
	if err != nil {
		return "", "", err
	}
	if err = versions.requireReady(); err != nil {
		return "", "", err
	}
	var notePath, hash string
	err = versions.withDB(func(db *sql.DB) error {
		return db.QueryRow(`SELECT path, object_hash FROM versions WHERE id = ?`, id).Scan(&notePath, &hash)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", os.ErrNotExist
	}
	if err != nil {
		return "", "", err
	}
	data, err := os.ReadFile(versions.objectPath(hash))
	if err != nil {
		return "", "", err
	}
	return notePath, string(data), nil
}

func (s *Store) restoreNoteVersion(id, revision string) (Note, error) {
	notePath, content, err := s.readNoteVersionContent(id)
	if err != nil {
		return Note{}, err
	}
	return s.saveNote(notePath, content, revision, false)
}

func (s *Store) deleteNoteVersion(id string) error {
	versions, err := s.versionService()
	if err != nil {
		return err
	}
	if err = versions.requireReady(); err != nil {
		return err
	}
	return versions.withDB(func(db *sql.DB) error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		var hash string
		err = tx.QueryRow(`SELECT object_hash FROM versions WHERE id = ?`, id).Scan(&hash)
		if errors.Is(err, sql.ErrNoRows) {
			return os.ErrNotExist
		}
		if err != nil {
			return err
		}
		if _, err = tx.Exec(`DELETE FROM versions WHERE id = ?`, id); err != nil {
			return err
		}
		var refs int
		if err = tx.QueryRow(`SELECT refs FROM objects WHERE hash = ?`, hash).Scan(&refs); err != nil {
			return err
		}
		if refs <= 1 {
			if _, err = tx.Exec(`DELETE FROM objects WHERE hash = ?`, hash); err != nil {
				return err
			}
			_ = os.Remove(versions.objectPath(hash))
		} else if _, err = tx.Exec(`UPDATE objects SET refs = refs - 1 WHERE hash = ?`, hash); err != nil {
			return err
		}
		return tx.Commit()
	})
}

func (s *Store) relocateNoteVersions(from, to string) (func() error, error) {
	noop := func() error { return nil }
	info, err := os.Lstat(filepath.Join(s.root, ".echo", "versions.db"))
	if errors.Is(err, os.ErrNotExist) {
		return noop, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf(".echo 配置目录不能包含符号链接")
	}
	versions, err := s.versionService()
	if err != nil {
		return nil, err
	}
	ready, err := versions.isInitialized()
	if err != nil {
		return nil, err
	}
	if !ready {
		return noop, nil
	}
	type change struct {
		id      string
		oldPath string
		newPath string
	}
	var changes []change
	err = versions.withDB(func(db *sql.DB) error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		like := escapeLikePrefix(from)
		rows, err := tx.Query(`SELECT id, path FROM versions WHERE path = ? OR path LIKE ? ESCAPE '\'`, from, like)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, notePath string
			if err = rows.Scan(&id, &notePath); err != nil {
				rows.Close()
				return err
			}
			changes = append(changes, change{id: id, oldPath: notePath, newPath: remapPrefix(notePath, from, to)})
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for _, item := range changes {
			if _, err = tx.Exec(`UPDATE versions SET path = ? WHERE id = ?`, item.newPath, item.id); err != nil {
				return err
			}
		}
		return tx.Commit()
	})
	if err != nil {
		return nil, err
	}
	undo := func() error {
		return versions.withDB(func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()
			for i := len(changes) - 1; i >= 0; i-- {
				item := changes[i]
				if _, err = tx.Exec(`UPDATE versions SET path = ? WHERE id = ?`, item.oldPath, item.id); err != nil {
					return err
				}
			}
			return tx.Commit()
		})
	}
	return undo, nil
}

func (s *Store) runDailyVersions(now time.Time) {
	s.mu.Lock()
	enabled := s.state.Settings.VersionRepoEnabled
	auto := s.state.Settings.AutoVersionDaily
	s.mu.Unlock()
	if !enabled || !auto {
		return
	}
	info, err := os.Lstat(filepath.Join(s.root, ".echo", "versions.db"))
	if err != nil {
		return
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return
	}
	versions, err := s.versionService()
	if err != nil {
		return
	}
	ready, err := versions.isInitialized()
	if err != nil || !ready {
		return
	}
	day := now.In(time.Local).Format("2006-01-02")
	last, err := versions.metaGet("last_auto_day")
	if err != nil {
		return
	}
	if last == day {
		return
	}
	notes, err := s.listNotes()
	if err != nil {
		return
	}
	latest := map[string]string{}
	_ = versions.withDB(func(db *sql.DB) error {
		rows, err := db.Query(`SELECT path, object_hash FROM versions v
			WHERE created_at = (SELECT MAX(created_at) FROM versions WHERE path = v.path)`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var pathName, hash string
			if err = rows.Scan(&pathName, &hash); err != nil {
				return err
			}
			latest[pathName] = hash
		}
		return rows.Err()
	})
	for _, note := range notes {
		hash := contentHash([]byte(note.Content))
		if latest[note.Path] == hash {
			continue
		}
		if _, err = s.createNoteVersion(note.Path, "auto"); err != nil {
			continue
		}
	}
	_ = versions.metaSet("last_auto_day", day)
}

func (h *handler) versionRoutes(w http.ResponseWriter, r *http.Request) error {
	s := h.ws.current()
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if _, err := os.Stat(s.journalPath()); err == nil {
			return fmt.Errorf("资源迁移尚待恢复，已暂时停止写入以保护笔记。请备份数据后重启并查看恢复提示")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	switch r.URL.Path {
	case "/api/version-repo/status":
		if r.Method != http.MethodGet {
			jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
			return nil
		}
		status, err := s.versionRepoStatus()
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, status)
		return nil
	case "/api/version-repo/init":
		if r.Method != http.MethodPost {
			jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
			return nil
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		status, err := s.initVersionRepo()
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, status)
		return nil
	case "/api/note-versions":
		return h.serveNoteVersions(s, w, r)
	case "/api/note-versions/restore":
		if r.Method != http.MethodPost {
			jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
			return nil
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		var input struct {
			ID       string `json:"versionId"`
			Revision string `json:"revision"`
		}
		if err := decode(r, &input); err != nil {
			return err
		}
		note, err := s.restoreNoteVersion(input.ID, input.Revision)
		if err != nil {
			return err
		}
		s.changed()
		jsonResponse(w, http.StatusOK, note)
		return nil
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}

func (h *handler) serveNoteVersions(s *Store, w http.ResponseWriter, r *http.Request) error {
	switch r.Method {
	case http.MethodGet:
		items, err := s.listNoteVersions(r.URL.Query().Get("path"))
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, items)
		return nil
	case http.MethodPost:
		s.mu.Lock()
		defer s.mu.Unlock()
		var input struct {
			Path string `json:"path"`
		}
		if err := decode(r, &input); err != nil {
			return err
		}
		item, err := s.createNoteVersion(input.Path, "manual")
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusCreated, item)
		return nil
	case http.MethodPut:
		s.mu.Lock()
		defer s.mu.Unlock()
		var input struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		}
		if err := decode(r, &input); err != nil {
			return err
		}
		item, err := s.renameNoteVersion(input.ID, input.Label)
		if err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, item)
		return nil
	case http.MethodDelete:
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := s.deleteNoteVersion(r.URL.Query().Get("id")); err != nil {
			return err
		}
		jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
		return nil
	default:
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
		return nil
	}
}
