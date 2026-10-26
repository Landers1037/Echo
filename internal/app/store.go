package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Settings struct {
	Theme              string            `json:"theme"`
	Accent             string            `json:"accent"`
	Animations         bool              `json:"animations"`
	EditorFontSize     int               `json:"editorFontSize"`
	EditorLineNumbers  bool              `json:"editorLineNumbers"`
	PreviewLineNumbers bool              `json:"previewLineNumbers"`
	MultiTabs          bool              `json:"multiTabs"`
	AssetsDir          string            `json:"assetsDir"`
	Shortcuts          map[string]string `json:"shortcuts"`
}
type Note struct {
	Path          string   `json:"path"`
	Title         string   `json:"title"`
	Metadata      Metadata `json:"metadata"`
	Revision      string   `json:"revision"`
	Modified      string   `json:"modified"`
	Content       string   `json:"content"`
	MetadataError string   `json:"metadataError,omitempty"`
}
type TreeEntry struct {
	Path     string      `json:"path"`
	Name     string      `json:"name"`
	Type     string      `json:"type"`
	Children []TreeEntry `json:"children,omitempty"`
}
type TrashEntry struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	DeletedAt string `json:"deletedAt"`
}
type HistoryEntry struct {
	TaskID      string `json:"taskId"`
	NotePath    string `json:"notePath"`
	Due         string `json:"due"`
	CompletedAt string `json:"completedAt"`
}
type diskState struct {
	Settings  Settings       `json:"settings"`
	Groups    []string       `json:"groups"`
	Tags      []string       `json:"tags"`
	Trash     []TrashEntry   `json:"trash"`
	Reminders []Reminder     `json:"reminders"`
	History   []HistoryEntry `json:"history"`
}
type Store struct {
	mu          sync.Mutex
	root        string
	state       diskState
	clients     map[chan []byte]bool
	fingerprint string
}
type Conflict struct{ Current Note }

func (e *Conflict) Error() string { return "笔记已被其他窗口或外部程序修改" }

func defaults() Settings {
	return Settings{Theme: "system", Accent: "#72967b", Animations: true, EditorFontSize: 14, EditorLineNumbers: true, PreviewLineNumbers: false, MultiTabs: false, AssetsDir: ".assets", Shortcuts: map[string]string{}}
}
func newID() string { var b [12]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }
func revision(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func Open(root string) (*Store, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(absolute, 0755); err != nil {
		return nil, err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	s := &Store{root: absolute, clients: map[chan []byte]bool{}, state: diskState{Settings: defaults(), Groups: []string{}, Tags: []string{}, Trash: []TrashEntry{}, Reminders: []Reminder{}, History: []HistoryEntry{}}}
	for _, name := range []string{".echo", filepath.Join(".echo", "trash"), filepath.Join(".echo", "state.json"), filepath.Join(".echo", "asset-migration.json")} {
		if info, statErr := os.Lstat(filepath.Join(absolute, name)); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf(".echo 配置目录不能包含符号链接")
		}
	}
	if err = os.MkdirAll(filepath.Join(absolute, ".echo", "trash"), 0700); err != nil {
		return nil, err
	}
	statePath := filepath.Join(absolute, ".echo", "state.json")
	data, err := os.ReadFile(statePath)
	first := os.IsNotExist(err)
	if err == nil {
		if err = json.Unmarshal(data, &s.state); err != nil {
			return nil, fmt.Errorf("state.json 损坏，请从备份恢复: %w", err)
		}
	} else if !first {
		return nil, err
	}
	if s.state.Settings.AssetsDir == "" {
		s.state.Settings.AssetsDir = ".assets"
	}
	if s.state.Settings.Shortcuts == nil {
		s.state.Settings.Shortcuts = map[string]string{}
	}
	if err = s.recoverMigration(); err != nil {
		return nil, err
	}
	if s.state.Settings.EditorFontSize < 12 || s.state.Settings.EditorFontSize > 32 {
		s.state.Settings.EditorFontSize = defaults().EditorFontSize
	}
	if _, err = s.safePath(s.state.Settings.AssetsDir); err != nil {
		return nil, err
	}
	if first {
		notes, e := s.listNotes()
		if e != nil {
			return nil, e
		}
		if len(notes) == 0 {
			if _, err = s.createNote("欢迎使用 Echo.md", welcome); err != nil {
				return nil, err
			}
		}
		if err = s.persist(); err != nil {
			return nil, err
		}
	}
	s.fingerprint = s.makeFingerprint()
	return s, nil
}
func (s *Store) Root() string { return s.root }
func cleanRelative(name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, ":") || strings.ContainsRune(name, '\x00') {
		return "", fmt.Errorf("无效的相对路径")
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." || strings.EqualFold(part, ".echo") || strings.TrimRight(part, " .") != part {
			return "", fmt.Errorf("路径超出笔记库或使用保留名称")
		}
	}
	name = path.Clean(name)
	if name == "." || name == ".." || strings.HasPrefix(name, "../") {
		return "", fmt.Errorf("无效路径")
	}
	return name, nil
}
func (s *Store) safePath(name string) (string, error) {
	clean, err := cleanRelative(name)
	if err != nil {
		return "", err
	}
	current := s.root
	for _, part := range strings.Split(clean, "/") {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("不允许访问符号链接")
		}
		if err != nil && !os.IsNotExist(err) {
			return "", err
		}
	}
	return current, nil
}
func (s *Store) notePath(name string) (string, error) {
	name, err := cleanRelative(name)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(path.Ext(name), ".md") {
		return "", fmt.Errorf("笔记必须使用 .md 扩展名")
	}
	if name == s.state.Settings.AssetsDir || strings.HasPrefix(name, s.state.Settings.AssetsDir+"/") {
		return "", fmt.Errorf("不能在资源目录中保存笔记")
	}
	return s.safePath(name)
}
func atomicWrite(name string, data []byte, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(name), ".echo-write-*")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, name)
}

// New names must never replace a file concurrently created by another editor.
func exclusiveWrite(name string, data []byte, mode fs.FileMode) (err error) {
	if err = os.MkdirAll(filepath.Dir(name), 0755); err != nil {
		return err
	}
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer func() {
		_ = file.Close()
		if err != nil {
			_ = os.Remove(name)
		}
	}()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	return file.Close()
}
func (s *Store) persist() error {
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.root, ".echo", "state.json"), data, 0600)
}
func (s *Store) readNote(name string) (Note, error) {
	var err error
	name, err = cleanRelative(name)
	if err != nil {
		return Note{}, err
	}
	file, err := s.notePath(name)
	if err != nil {
		return Note{}, err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return Note{}, err
	}
	info, err := os.Stat(file)
	if err != nil {
		return Note{}, err
	}
	meta, metaErr := readMetadata(string(data))
	title := strings.TrimSuffix(path.Base(strings.ReplaceAll(name, "\\", "/")), path.Ext(name))
	_, body, _, _ := frontmatter(string(data))
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "# ") {
			title = strings.TrimSpace(strings.TrimPrefix(line, "# "))
			break
		}
	}
	note := Note{Path: filepath.ToSlash(name), Title: title, Metadata: meta, Revision: revision(data), Modified: info.ModTime().UTC().Format(time.RFC3339Nano), Content: string(data)}
	if metaErr != nil {
		note.MetadataError = metaErr.Error()
	}
	return note, nil
}
func (s *Store) listNotes() ([]Note, error) {
	notes := []Note{}
	err := filepath.WalkDir(s.root, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if file == s.root {
			return nil
		}
		rel, _ := filepath.Rel(s.root, file)
		rel = filepath.ToSlash(rel)
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") || rel == s.state.Settings.AssetsDir {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(file), ".md") {
			note, e := s.readNote(rel)
			if e != nil {
				return e
			}
			notes = append(notes, note)
		}
		return nil
	})
	sort.Slice(notes, func(i, j int) bool { return notes[i].Path < notes[j].Path })
	return notes, err
}
func (s *Store) createNote(name, content string) (Note, error) {
	name, err := cleanRelative(name)
	if err != nil {
		return Note{}, err
	}
	file, err := s.notePath(name)
	if err != nil {
		return Note{}, err
	}
	if _, err = os.Lstat(file); err == nil {
		return Note{}, fmt.Errorf("目标笔记已经存在")
	}
	if !os.IsNotExist(err) {
		return Note{}, err
	}
	if err = exclusiveWrite(file, []byte(content), 0644); err != nil {
		return Note{}, err
	}
	return s.readNote(name)
}
func (s *Store) saveNote(name, content, rev string, force bool) (Note, error) {
	current, err := s.readNote(name)
	if err != nil {
		return Note{}, err
	}
	if !force && (rev == "" || rev != current.Revision) {
		return Note{}, &Conflict{Current: current}
	}
	file, err := s.notePath(name)
	if err != nil {
		return Note{}, err
	}
	if err = atomicWrite(file, []byte(content), 0644); err != nil {
		return Note{}, err
	}
	return s.readNote(name)
}
func (s *Store) tree() ([]TreeEntry, error) {
	var walk func(string) ([]TreeEntry, error)
	walk = func(dir string) ([]TreeEntry, error) {
		full := s.root
		if dir != "" {
			var err error
			full, err = s.safePath(dir)
			if err != nil {
				return nil, err
			}
		}
		entries, err := os.ReadDir(full)
		if err != nil {
			return nil, err
		}
		result := []TreeEntry{}
		for _, entry := range entries {
			p := path.Join(dir, entry.Name())
			if strings.HasPrefix(entry.Name(), ".") || entry.Type()&os.ModeSymlink != 0 || p == s.state.Settings.AssetsDir {
				continue
			}
			if entry.IsDir() {
				children, e := walk(p)
				if e != nil {
					return nil, e
				}
				result = append(result, TreeEntry{Path: p, Name: entry.Name(), Type: "folder", Children: children})
			} else if strings.EqualFold(path.Ext(entry.Name()), ".md") {
				result = append(result, TreeEntry{Path: p, Name: entry.Name(), Type: "note"})
			}
		}
		sort.SliceStable(result, func(i, j int) bool {
			if result[i].Type != result[j].Type {
				return result[i].Type == "folder"
			}
			return result[i].Name < result[j].Name
		})
		return result, nil
	}
	return walk("")
}
func (s *Store) recycle(name string) error {
	file, err := s.safePath(name)
	if err != nil {
		return err
	}
	info, err := os.Stat(file)
	if err != nil {
		return err
	}
	if !info.IsDir() && !strings.EqualFold(path.Ext(name), ".md") {
		return fmt.Errorf("只能删除笔记或文件夹")
	}
	if name == s.state.Settings.AssetsDir || strings.HasPrefix(s.state.Settings.AssetsDir, name+"/") {
		return fmt.Errorf("不能删除资源目录")
	}
	entry := TrashEntry{ID: newID(), Path: filepath.ToSlash(name), DeletedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	to := filepath.Join(s.root, ".echo", "trash", entry.ID)
	if err = os.Rename(file, to); err != nil {
		return err
	}
	s.state.Trash = append(s.state.Trash, entry)
	if err = s.persist(); err != nil {
		s.state.Trash = s.state.Trash[:len(s.state.Trash)-1]
		_ = os.Rename(to, file)
		return err
	}
	return nil
}
func (s *Store) restore(id string) error {
	for i, entry := range s.state.Trash {
		if entry.ID != id {
			continue
		}
		to, err := s.safePath(entry.Path)
		if err != nil {
			return err
		}
		if _, err = os.Stat(to); !os.IsNotExist(err) {
			return fmt.Errorf("原路径已有文件，请先移动同名文件")
		}
		if err = os.MkdirAll(filepath.Dir(to), 0755); err != nil {
			return err
		}
		from := filepath.Join(s.root, ".echo", "trash", id)
		if err = os.Rename(from, to); err != nil {
			return err
		}
		old := append([]TrashEntry{}, s.state.Trash...)
		s.state.Trash = append(s.state.Trash[:i], s.state.Trash[i+1:]...)
		if err = s.persist(); err != nil {
			s.state.Trash = old
			_ = os.Rename(to, from)
			return err
		}
		return nil
	}
	return os.ErrNotExist
}
func (s *Store) publish(event any) {
	data, _ := json.Marshal(event)
	for client := range s.clients {
		select {
		case client <- data:
		default:
		}
	}
}
func (s *Store) changed() {
	s.fingerprint = s.makeFingerprint()
	s.publish(map[string]any{"type": "changed"})
}
func (s *Store) makeFingerprint() string {
	notes, err := s.listNotes()
	if err != nil {
		return "error:" + err.Error()
	}
	var b strings.Builder
	for _, note := range notes {
		b.WriteString(note.Path)
		b.WriteString(note.Revision)
	}
	if tree, err := s.tree(); err == nil {
		data, _ := json.Marshal(tree)
		b.Write(data)
	}
	return revision([]byte(b.String()))
}
func (s *Store) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			fingerprint := s.makeFingerprint()
			if fingerprint != s.fingerprint {
				s.fingerprint = fingerprint
				s.publish(map[string]any{"type": "changed"})
			}
			s.checkReminders(time.Now())
			s.mu.Unlock()
		}
	}
}
func isNotFound(err error) bool { return errors.Is(err, os.ErrNotExist) }

const welcome = `---
echo:
  tags: [开始使用, 灵感]
  group: 我的空间
---
# 在 Echo，留住每一个想法

这是属于你的安静书写空间。笔记以普通 Markdown 文件保存在本机，随时可以带走。

## 从一个小小的想法开始

用左侧的 **新建笔记** 开启写作，在顶部切换「源码」与「预览」。你也可以直接把图片粘贴进编辑器。

> 好记性不如一份随手可得的笔记。

## 今天想完成的事

- [ ] 写下今天的第一个想法
- [ ] 为笔记添加标签与分组
- [x] 找到一个让自己专注的地方

## Markdown 随手记

| 操作 | 快捷键 |
| --- | --- |
| 保存笔记 | Ctrl + S |
| 加粗文字 | Ctrl + B |
| 查找 | Ctrl + F |

` + "```typescript\nconst idea = '让记录变得简单';\nconsole.log(idea);\n```\n" + `
你可以在设置中切换外观、强调色和动画，让 Echo 更像你。
`
