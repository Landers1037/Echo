package app

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

var markdownLink = regexp.MustCompile(`(!?\[[^\]\r\n]*\]\(\s*)(<[^>\r\n]+>|[^\s)]+)([^)\r\n]*\))`)
var markdownDefinition = regexp.MustCompile(`(?m)^( {0,3}\[[^\]\r\n]+\]:\s*)(<[^>\r\n]+>|[^\s\r\n]+)([^\r\n]*)`)
var shortcutActionID = regexp.MustCompile(`^[a-zA-Z0-9]+$`)
var shortcutBinding = regexp.MustCompile(`^((Mod|Ctrl|Alt|Shift|Meta)-)*[^\s-]+$`)

func validateShortcuts(shortcuts map[string]string) error {
	if len(shortcuts) > 64 {
		return fmt.Errorf("快捷键数量过多")
	}
	seen := map[string]bool{}
	for action, binding := range shortcuts {
		if len(action) > 40 || !shortcutActionID.MatchString(action) {
			return fmt.Errorf("无效的快捷键动作")
		}
		if binding == "" {
			continue
		}
		if len(binding) > 40 || !shortcutBinding.MatchString(binding) {
			return fmt.Errorf("无效的快捷键")
		}
		if seen[binding] {
			return fmt.Errorf("快捷键不能重复")
		}
		seen[binding] = true
	}
	return nil
}

func markdownImageSources(content string) []string {
	_, body, _, _ := frontmatter(content)
	document := goldmark.DefaultParser().Parse(text.NewReader([]byte(body)))
	sources := []string{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if image, ok := node.(*ast.Image); ok {
				sources = append(sources, string(image.Destination))
			}
		}
		return ast.WalkContinue, nil
	})
	return normalizeNames(sources)
}

func rewriteMarkdownMatches(content string, pattern *regexp.Regexp, replacement func([]string) string) string {
	_, body, _, err := frontmatter(content)
	if err != nil {
		return content
	}
	prefix := content[:len(content)-len(body)]
	type span struct{ start, end int }
	literals := []span{}
	document := goldmark.DefaultParser().Parse(text.NewReader([]byte(body)))
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if node.Kind() == ast.KindCodeSpan {
			for child := node.FirstChild(); child != nil; child = child.NextSibling() {
				if literal, ok := child.(*ast.Text); ok {
					literals = append(literals, span{literal.Segment.Start, literal.Segment.Stop})
				}
			}
			return ast.WalkSkipChildren, nil
		}
		if node.Kind() == ast.KindCodeBlock || node.Kind() == ast.KindFencedCodeBlock || node.Kind() == ast.KindHTMLBlock {
			for i := 0; i < node.Lines().Len(); i++ {
				segment := node.Lines().At(i)
				literals = append(literals, span{segment.Start, segment.Stop})
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	var output strings.Builder
	position := 0
	for _, indices := range pattern.FindAllStringSubmatchIndex(body, -1) {
		start, end := indices[0], indices[1]
		literal := false
		for _, region := range literals {
			if start >= region.start && start < region.end {
				literal = true
				break
			}
		}
		if literal {
			continue
		}
		parts := []string{body[start:end]}
		for i := 2; i < len(indices); i += 2 {
			if indices[i] < 0 {
				parts = append(parts, "")
			} else {
				parts = append(parts, body[indices[i]:indices[i+1]])
			}
		}
		output.WriteString(body[position:start])
		output.WriteString(replacement(parts))
		position = end
	}
	output.WriteString(body[position:])
	return prefix + output.String()
}

func localReference(notePath, source string) (string, bool) {
	source = strings.Trim(source, "<>")
	u, err := url.Parse(source)
	if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(source, "//") || u.Path == "" {
		return "", false
	}
	decoded := u.Path // url.Parse has already unescaped Path exactly once.
	var target string
	if strings.HasPrefix(decoded, "/") {
		target = strings.TrimPrefix(decoded, "/")
	} else {
		target = path.Join(path.Dir(notePath), decoded)
	}
	target = path.Clean(target)
	if _, err = cleanRelative(target); err != nil {
		return "", false
	}
	return target, true
}
func relativeLink(notePath, target, source string) string {
	rel, err := filepath.Rel(filepath.FromSlash(path.Dir(notePath)), filepath.FromSlash(target))
	if err != nil {
		return source
	}
	u, _ := url.Parse(strings.Trim(source, "<>"))
	suffix := ""
	if u != nil {
		if u.RawQuery != "" {
			suffix += "?" + u.RawQuery
		}
		if u.Fragment != "" {
			suffix += "#" + url.PathEscape(u.Fragment)
		}
	}
	encoded := (&url.URL{Path: filepath.ToSlash(rel)}).EscapedPath()
	result := encoded + suffix
	if strings.ContainsAny(result, " ()") {
		return "<" + result + ">"
	}
	return result
}
func rewriteLinks(content, oldNote, newNote string, remap func(string) string) string {
	replace := func(parts []string) string {
		target, ok := localReference(oldNote, parts[2])
		if !ok {
			return parts[0]
		}
		mapped := remap(target)
		if mapped == target && oldNote == newNote {
			return parts[0]
		}
		return parts[1] + relativeLink(newNote, mapped, parts[2]) + parts[3]
	}
	content = rewriteMarkdownMatches(content, markdownLink, replace)
	return rewriteMarkdownMatches(content, markdownDefinition, replace)
}
func remapPrefix(target, from, to string) string {
	if target == from {
		return to
	}
	if strings.HasPrefix(target, from+"/") {
		return to + strings.TrimPrefix(target, from)
	}
	return target
}
func (s *Store) writeMany(changes map[string]string, expected ...map[string]string) (map[string]string, error) {
	originals := map[string]string{}
	for name := range changes {
		note, err := s.readNote(name)
		if err != nil {
			return nil, err
		}
		if len(expected) > 0 {
			if rev, ok := expected[0][name]; ok && rev != note.Revision {
				return nil, &Conflict{Current: note}
			}
		}
		originals[name] = note.Content
	}
	written := []string{}
	for name, content := range changes {
		full, err := s.notePath(name)
		if err == nil {
			current, e := s.readNote(name)
			if e != nil {
				err = e
			} else if current.Content != originals[name] {
				err = &Conflict{Current: current}
			}
		}
		if err == nil {
			err = atomicWrite(full, []byte(content), 0644)
		}
		if err != nil {
			for _, previous := range written {
				current, e := s.readNote(previous)
				if e != nil || current.Content != changes[previous] {
					continue /* never overwrite an external edit during rollback */
				}
				file, e := s.notePath(previous)
				if e == nil {
					_ = atomicWrite(file, []byte(originals[previous]), 0644)
				}
			}
			return nil, err
		}
		written = append(written, name)
	}
	return originals, nil
}
func (s *Store) rollbackNotes(originals map[string]string) error {
	for name, content := range originals {
		file, err := s.notePath(name)
		if err != nil {
			return fmt.Errorf("恢复笔记 %s: %w", name, err)
		}
		if err = atomicWrite(file, []byte(content), 0644); err != nil {
			return fmt.Errorf("恢复笔记 %s: %w", name, err)
		}
	}
	return nil
}
func (s *Store) move(from, to, rev string, folder bool) (Note, error) {
	var err error
	from, err = cleanRelative(from)
	if err != nil {
		return Note{}, err
	}
	to, err = cleanRelative(to)
	if err != nil {
		return Note{}, err
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return Note{}, fmt.Errorf("不能移动到自身或子目录")
	}
	if from == s.state.Settings.AssetsDir || to == s.state.Settings.AssetsDir || strings.HasPrefix(s.state.Settings.AssetsDir, from+"/") || strings.HasPrefix(to, s.state.Settings.AssetsDir+"/") {
		return Note{}, fmt.Errorf("不能移动资源目录")
	}
	if err = s.ensureScanned(to, folder); err != nil {
		return Note{}, err
	}
	drawing := !folder && isDrawingName(from)
	if drawing && !strings.EqualFold(path.Ext(from), path.Ext(to)) {
		return Note{}, fmt.Errorf("绘图必须保持原扩展名")
	}
	if !folder {
		if drawing {
			current, e := s.readDrawing(from)
			if e != nil {
				return Note{}, e
			}
			if current.Revision != rev {
				return Note{}, &Conflict{Current: Note{Path: current.Path, Content: current.Content, Revision: current.Revision, Modified: current.Modified}, message: "绘图已被其他窗口或外部程序修改"}
			}
			if _, e = s.drawingPath(to); e != nil {
				return Note{}, e
			}
		} else {
			current, e := s.readNote(from)
			if e != nil {
				return Note{}, e
			}
			if current.Revision != rev {
				return Note{}, &Conflict{Current: current}
			}
			if _, e = s.notePath(to); e != nil {
				return Note{}, e
			}
		}
	}
	oldFile, err := s.safePath(from)
	if err != nil {
		return Note{}, err
	}
	newFile, err := s.safePath(to)
	if err != nil {
		return Note{}, err
	}
	info, err := os.Stat(oldFile)
	if err != nil {
		return Note{}, err
	}
	if info.IsDir() != folder {
		return Note{}, fmt.Errorf("文件类型不匹配")
	}
	if _, err = os.Lstat(newFile); !os.IsNotExist(err) {
		return Note{}, fmt.Errorf("目标已经存在")
	}
	notes, err := s.listNotes()
	if err != nil {
		return Note{}, err
	}
	if err = os.MkdirAll(filepath.Dir(newFile), 0755); err != nil {
		return Note{}, err
	}
	if err = os.Rename(oldFile, newFile); err != nil {
		return Note{}, err
	}
	originals := map[string]string{}
	changes := map[string]string{}
	versions := map[string]string{}
	for _, note := range notes {
		newPath := remapPrefix(note.Path, from, to)
		updated := rewriteLinks(note.Content, note.Path, newPath, func(target string) string { return remapPrefix(target, from, to) })
		if updated != note.Content {
			originals[newPath] = note.Content
			changes[newPath] = updated
			versions[newPath] = note.Revision
		}
	}
	rollbackMove := func() error {
		if _, e := os.Lstat(oldFile); !os.IsNotExist(e) {
			return fmt.Errorf("原路径已被外部创建，已保留移动后的文件 %s", to)
		}
		return os.Rename(newFile, oldFile)
	}
	if _, err = s.writeMany(changes, versions); err != nil {
		if rollbackErr := rollbackMove(); rollbackErr != nil {
			return Note{}, fmt.Errorf("%v；%w", err, rollbackErr)
		}
		return Note{}, err
	}
	oldReminders := append([]Reminder{}, s.state.Reminders...)
	oldHistory := append([]HistoryEntry{}, s.state.History...)
	for i := range s.state.Reminders {
		s.state.Reminders[i].NotePath = remapPrefix(s.state.Reminders[i].NotePath, from, to)
	}
	for i := range s.state.History {
		s.state.History[i].NotePath = remapPrefix(s.state.History[i].NotePath, from, to)
	}
	undoAnnotations, err := s.relocateAnnotations(from, to)
	if err != nil {
		s.state.Reminders = oldReminders
		s.state.History = oldHistory
		s.rollbackNotes(originals)
		if rollbackErr := rollbackMove(); rollbackErr != nil {
			return Note{}, fmt.Errorf("%v；%w", err, rollbackErr)
		}
		return Note{}, err
	}
	if err = s.persist(); err != nil {
		s.state.Reminders = oldReminders
		s.state.History = oldHistory
		if undoErr := undoAnnotations(); undoErr != nil {
			return Note{}, fmt.Errorf("%v；恢复标注路径失败: %w", err, undoErr)
		}
		s.rollbackNotes(originals)
		if rollbackErr := rollbackMove(); rollbackErr != nil {
			return Note{}, fmt.Errorf("%v；%w", err, rollbackErr)
		}
		return Note{}, err
	}
	if folder || drawing {
		return Note{}, nil
	}
	return s.readNote(to)
}
func (s *Store) batchMetadata(paths []string, tags *[]string, group *string, revisions map[string]string) ([]Note, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("请选择笔记")
	}
	changes := map[string]string{}
	versions := map[string]string{}
	for _, name := range paths {
		note, err := s.readNote(name)
		if err != nil {
			return nil, err
		}
		if expected, ok := revisions[name]; ok && expected != note.Revision {
			return nil, &Conflict{Current: note}
		}
		meta := note.Metadata
		if tags != nil {
			meta.Tags = normalizeNames(*tags)
		}
		if group != nil {
			meta.Group = strings.TrimSpace(*group)
		}
		content, err := writeMetadata(note.Content, meta)
		if err != nil {
			return nil, err
		}
		changes[name] = content
		versions[name] = note.Revision
	}
	originals, err := s.writeMany(changes, versions)
	if err != nil {
		return nil, err
	}
	oldGroups := append([]string{}, s.state.Groups...)
	oldTags := append([]string{}, s.state.Tags...)
	if group != nil && strings.TrimSpace(*group) != "" {
		s.state.Groups = normalizeNames(append(s.state.Groups, *group))
	}
	if tags != nil {
		s.state.Tags = normalizeNames(append(s.state.Tags, (*tags)...))
	}
	if err = s.persist(); err != nil {
		s.state.Groups = oldGroups
		s.state.Tags = oldTags
		s.rollbackNotes(originals)
		return nil, err
	}
	result := []Note{}
	for _, name := range paths {
		note, err := s.readNote(name)
		if err != nil {
			return nil, err
		}
		result = append(result, note)
	}
	return result, nil
}
func (s *Store) categories(kind string) ([]string, error) {
	notes, err := s.listNotes()
	if err != nil {
		return nil, err
	}
	names := []string{}
	if kind == "groups" {
		names = append(names, s.state.Groups...)
		for _, note := range notes {
			names = append(names, note.Metadata.Group)
		}
	} else {
		names = append(names, s.state.Tags...)
		for _, note := range notes {
			names = append(names, note.Metadata.Tags...)
		}
	}
	names = normalizeNames(names)
	sort.Strings(names)
	return names, nil
}
func validName(name string) error {
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 100 || strings.ContainsAny(name, "\r\n\x00") {
		return fmt.Errorf("名称需要为 1–100 个字符")
	}
	return nil
}
func (s *Store) categoryChange(kind, method, name, newName string) error {
	name = strings.TrimSpace(name)
	newName = strings.TrimSpace(newName)
	if err := validName(name); err != nil {
		return err
	}
	if method == "PUT" {
		if err := validName(newName); err != nil {
			return err
		}
	}
	if method == "POST" {
		oldGroups := append([]string{}, s.state.Groups...)
		oldTags := append([]string{}, s.state.Tags...)
		if kind == "groups" {
			s.state.Groups = normalizeNames(append(s.state.Groups, name))
		} else {
			s.state.Tags = normalizeNames(append(s.state.Tags, name))
		}
		if err := s.persist(); err != nil {
			s.state.Groups = oldGroups
			s.state.Tags = oldTags
			return err
		}
		return nil
	}
	notes, err := s.listNotes()
	if err != nil {
		return err
	}
	changes := map[string]string{}
	versions := map[string]string{}
	for _, note := range notes {
		meta := note.Metadata
		changed := false
		if kind == "groups" && meta.Group == name {
			meta.Group = newName
			changed = true
		} else if kind == "tags" {
			tags := []string{}
			for _, tag := range meta.Tags {
				if tag == name {
					changed = true
					if newName != "" {
						tags = append(tags, newName)
					}
				} else {
					tags = append(tags, tag)
				}
			}
			meta.Tags = normalizeNames(tags)
		}
		if changed {
			content, e := writeMetadata(note.Content, meta)
			if e != nil {
				return e
			}
			changes[note.Path] = content
			versions[note.Path] = note.Revision
		}
	}
	originals, err := s.writeMany(changes, versions)
	if err != nil {
		return err
	}
	oldGroups := append([]string{}, s.state.Groups...)
	oldTags := append([]string{}, s.state.Tags...)
	values := s.state.Tags
	if kind == "groups" {
		values = s.state.Groups
	}
	updated := []string{}
	for _, value := range values {
		if value == name {
			if newName != "" {
				updated = append(updated, newName)
			}
		} else {
			updated = append(updated, value)
		}
	}
	if kind == "groups" {
		s.state.Groups = normalizeNames(updated)
	} else {
		s.state.Tags = normalizeNames(updated)
	}
	if err = s.persist(); err != nil {
		s.state.Groups = oldGroups
		s.state.Tags = oldTags
		s.rollbackNotes(originals)
		return err
	}
	return nil
}

type migrationJournal struct {
	From      string            `json:"from"`
	To        string            `json:"to"`
	Originals map[string]string `json:"originals"`
	Settings  Settings          `json:"settings"`
	Files     []string          `json:"files"`
	Committed bool              `json:"committed"`
	Updated   map[string]string `json:"updated,omitempty"`
	Hashes    map[string]string `json:"hashes,omitempty"`
}

func (s *Store) journalPath() string { return filepath.Join(s.root, ".echo", "asset-migration.json") }
func (s *Store) writeJournal(j migrationJournal) error {
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return atomicWrite(s.journalPath(), data, 0600)
}
func (s *Store) recoverMigration() error {
	data, err := os.ReadFile(s.journalPath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var j migrationJournal
	if err = json.Unmarshal(data, &j); err != nil {
		return fmt.Errorf("资源迁移日志损坏: %w", err)
	}
	from, fromErr := cleanRelative(j.From)
	to, toErr := cleanRelative(j.To)
	if fromErr != nil || toErr != nil || from == to || strings.HasPrefix(to, from+"/") || strings.HasPrefix(from, to+"/") {
		return fmt.Errorf("资源迁移日志路径无效，请保留日志并恢复备份")
	}
	for _, name := range j.Files {
		clean, e := cleanRelative(name)
		if e != nil || clean != name || j.Hashes[name] == "" {
			return fmt.Errorf("资源迁移日志文件路径无效")
		}
	}
	for name := range j.Originals {
		if _, ok := j.Updated[name]; !ok {
			return fmt.Errorf("资源迁移日志缺少笔记版本，已保留日志，请先备份后恢复")
		}
	}
	if !j.Committed {
		// Never overwrite an external edit made after migration began. Keep both
		// asset copies and the journal so that recovery can be resolved safely.
		for name, original := range j.Originals {
			file, e := s.notePath(name)
			if e != nil {
				return e
			}
			current, e := os.ReadFile(file)
			if e != nil {
				return fmt.Errorf("资源迁移恢复失败，日志已保留: %w", e)
			}
			if expected, ok := j.Updated[name]; ok && string(current) != original && string(current) != expected {
				return fmt.Errorf("笔记 %s 在迁移期间被外部修改，已保留迁移日志和资源副本，请先备份并解决冲突", name)
			}
		}
		if err = s.rollbackNotes(j.Originals); err != nil {
			return fmt.Errorf("资源迁移恢复失败，日志已保留: %w", err)
		}
		s.state.Settings = j.Settings
		if err = s.persist(); err != nil {
			return err
		}
		for _, name := range j.Files {
			file, e := s.safePath(path.Join(j.To, name))
			if e != nil {
				return e
			}
			current, e := os.ReadFile(file)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil {
				return e
			}
			if expected, ok := j.Hashes[name]; ok && revision(current) != expected {
				return fmt.Errorf("资源副本 %s 已被外部修改，迁移日志已保留", name)
			}
			if e = os.Remove(file); e != nil {
				return e
			}
		}
	} else {
		for _, name := range j.Files {
			destination, e := s.safePath(path.Join(j.To, name))
			if e != nil {
				return e
			}
			copied, e := os.ReadFile(destination)
			if e != nil || revision(copied) != j.Hashes[name] {
				return fmt.Errorf("新资源 %s 丢失或内容不匹配，已保留旧资源和迁移日志", name)
			}
			file, e := s.safePath(path.Join(j.From, name))
			if e != nil {
				return e
			}
			current, e := os.ReadFile(file)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil {
				return e
			}
			if expected, ok := j.Hashes[name]; ok && revision(current) != expected {
				continue /* retain external changes as an untouched backup */
			}
			if e = os.Remove(file); e != nil {
				return e
			}
		}
	}
	return os.Remove(s.journalPath())
}
func (s *Store) updateSettings(settings Settings) error {
	if settings.Theme != "system" && settings.Theme != "light" && settings.Theme != "dark" {
		return fmt.Errorf("无效主题")
	}
	if !validUIStyle(settings.UIStyle) {
		return fmt.Errorf("无效界面风格")
	}
	if !regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(settings.Accent) {
		return fmt.Errorf("强调色需要为 #RRGGBB")
	}
	if settings.EditorFontSize < 12 || settings.EditorFontSize > 32 {
		return fmt.Errorf("编辑器字体大小需要在 12–32 px 之间")
	}
	if settings.NoteWidth == "" {
		settings.NoteWidth = "default"
	}
	if !validNoteWidth(settings.NoteWidth) {
		return fmt.Errorf("无效笔记宽度")
	}
	if settings.Shortcuts == nil {
		settings.Shortcuts = map[string]string{}
	}
	if err := validateShortcuts(settings.Shortcuts); err != nil {
		return err
	}
	excludes, err := normalizeScanExcludes(settings.ScanExcludes)
	if err != nil {
		return err
	}
	settings.ScanExcludes = excludes
	dir, err := cleanRelative(settings.AssetsDir)
	if err != nil {
		return err
	}
	settings.AssetsDir = dir
	if _, err = s.safePath(dir); err != nil {
		return err
	}
	old := s.state.Settings
	if old.AssetsDir == dir {
		s.state.Settings = settings
		if err = s.persist(); err != nil {
			s.state.Settings = old
		}
		return err
	}
	if strings.HasPrefix(dir, old.AssetsDir+"/") || strings.HasPrefix(old.AssetsDir, dir+"/") {
		return fmt.Errorf("新旧资源目录不能互相嵌套")
	}
	to, _ := s.safePath(dir)
	if entries, e := os.ReadDir(to); e == nil && len(entries) > 0 {
		return fmt.Errorf("请选择不存在或为空的资源目录")
	} else if e != nil && !os.IsNotExist(e) {
		return e
	}
	notes, err := s.listNotes()
	if err != nil {
		return err
	}
	j := migrationJournal{From: old.AssetsDir, To: dir, Originals: map[string]string{}, Settings: old, Files: []string{}, Updated: map[string]string{}, Hashes: map[string]string{}}
	changes := map[string]string{}
	for _, note := range notes {
		content := rewriteLinks(note.Content, note.Path, note.Path, func(target string) string { return remapPrefix(target, old.AssetsDir, dir) })
		if content != note.Content {
			j.Originals[note.Path] = note.Content
			changes[note.Path] = content
			j.Updated[note.Path] = content
		}
	}
	from, pathErr := s.safePath(old.AssetsDir)
	if pathErr != nil {
		return pathErr
	}
	err = filepath.WalkDir(from, func(file string, entry fs.DirEntry, e error) error {
		if os.IsNotExist(e) {
			return nil
		}
		if e != nil {
			return e
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("资源目录不能包含符号链接")
		}
		if !entry.IsDir() {
			rel, _ := filepath.Rel(from, file)
			j.Files = append(j.Files, filepath.ToSlash(rel))
			data, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			j.Hashes[filepath.ToSlash(rel)] = revision(data)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err = s.writeJournal(j); err != nil {
		return err
	}
	for _, name := range j.Files {
		source, e := s.safePath(path.Join(j.From, name))
		if e != nil {
			err = e
			break
		}
		destination, e := s.safePath(path.Join(j.To, name))
		if e != nil {
			err = e
			break
		}
		var data []byte
		data, e = os.ReadFile(source)
		if e == nil && revision(data) != j.Hashes[name] {
			e = fmt.Errorf("资源 %s 在迁移期间被外部修改", name)
		}
		if e == nil {
			e = exclusiveWrite(destination, data, 0644)
		}
		if e != nil {
			err = e
			break
		}
	}
	if err == nil {
		versions := map[string]string{}
		for name, content := range j.Originals {
			versions[name] = revision([]byte(content))
		}
		_, err = s.writeMany(changes, versions)
	}
	if err == nil {
		s.state.Settings = settings
		err = s.persist()
	}
	if err != nil {
		s.state.Settings = old
		if recoverErr := s.recoverMigration(); recoverErr != nil {
			return fmt.Errorf("%v；%w", err, recoverErr)
		}
		return err
	}
	j.Committed = true
	if err = s.writeJournal(j); err != nil {
		s.state.Settings = old
		if recoverErr := s.recoverMigration(); recoverErr != nil {
			return fmt.Errorf("%v；%w", err, recoverErr)
		}
		return err
	}
	return s.recoverMigration()
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("文件超过大小限制")
	}
	return data, nil
}
