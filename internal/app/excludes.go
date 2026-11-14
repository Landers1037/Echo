package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
)

const maxScanExcludes = 100
const maxScanExcludeLen = 200

// excludePattern is a .gitignore-style subset: comments and blank lines are
// dropped, "!" is rejected, and a matching directory is not descended into.
type excludePattern struct {
	dirOnly  bool
	basename bool
	segments []string
}

func normalizeScanExcludes(lines []string) ([]string, error) {
	if len(lines) == 0 {
		return []string{}, nil
	}
	patterns, canonical, err := compileScanExcludes(lines)
	if err != nil {
		return nil, err
	}
	for _, pattern := range patterns {
		if pattern.coversLibrary() {
			return nil, fmt.Errorf("排除规则不能覆盖整个笔记库")
		}
	}
	return canonical, nil
}

func compileScanExcludes(lines []string) ([]excludePattern, []string, error) {
	patterns := []excludePattern{}
	canonical := []string{}
	seen := map[string]bool{}
	for _, line := range lines {
		pattern, stored, skip, err := parseExcludePattern(line)
		if err != nil {
			return nil, nil, err
		}
		if skip || seen[stored] {
			continue
		}
		seen[stored] = true
		patterns = append(patterns, pattern)
		canonical = append(canonical, stored)
	}
	if len(patterns) > maxScanExcludes {
		return nil, nil, fmt.Errorf("排除规则最多 %d 条", maxScanExcludes)
	}
	return patterns, canonical, nil
}

func parseExcludePattern(line string) (excludePattern, string, bool, error) {
	raw := strings.TrimSpace(line)
	if raw == "" || strings.HasPrefix(raw, "#") {
		return excludePattern{}, "", true, nil
	}
	if strings.ContainsRune(raw, '\x00') {
		return excludePattern{}, "", false, fmt.Errorf("排除规则包含无效字符")
	}
	if utf8.RuneCountInString(raw) > maxScanExcludeLen {
		return excludePattern{}, "", false, fmt.Errorf("排除规则不能超过 %d 个字符", maxScanExcludeLen)
	}
	if strings.HasPrefix(raw, "!") {
		return excludePattern{}, "", false, fmt.Errorf("不支持否定排除规则")
	}
	body := strings.ReplaceAll(raw, "\\", "/")
	if strings.Contains(body, ":") {
		return excludePattern{}, "", false, fmt.Errorf("排除规则无效：%s", raw)
	}
	dirOnly := strings.HasSuffix(body, "/")
	body = strings.TrimRight(body, "/")
	anchored := strings.HasPrefix(body, "/")
	body = strings.TrimLeft(body, "/")
	if body == "" || strings.Contains(body, "//") {
		return excludePattern{}, "", false, fmt.Errorf("排除规则无效：%s", raw)
	}
	segments := strings.Split(body, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return excludePattern{}, "", false, fmt.Errorf("排除规则不能包含 ..")
		}
		if segment != "**" {
			if _, err := path.Match(segment, "x"); err != nil {
				return excludePattern{}, "", false, fmt.Errorf("排除规则无效：%s", raw)
			}
		}
	}
	collapsed := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment == "**" && len(collapsed) > 0 && collapsed[len(collapsed)-1] == "**" {
			continue
		}
		collapsed = append(collapsed, segment)
	}
	stored := strings.Join(collapsed, "/")
	if anchored {
		stored = "/" + stored
	}
	if dirOnly {
		stored += "/"
	}
	return excludePattern{dirOnly: dirOnly, basename: !anchored && len(collapsed) == 1, segments: collapsed}, stored, false, nil
}

func (p excludePattern) coversLibrary() bool {
	return p.matches("note.md", false) && p.matches("folder", true)
}

func (p excludePattern) matches(rel string, isDir bool) bool {
	if p.dirOnly && !isDir {
		return false
	}
	parts := strings.Split(rel, "/")
	if p.basename {
		return matchExcludePart(p.segments[0], parts[len(parts)-1])
	}
	return matchExcludeSegments(p.segments, parts)
}

func matchExcludePart(pattern, name string) bool {
	if runtime.GOOS == "windows" {
		pattern = strings.ToLower(pattern)
		name = strings.ToLower(name)
	}
	if pattern == "**" {
		return name != ""
	}
	ok, err := path.Match(pattern, name)
	return err == nil && ok
}

func matchExcludeSegments(pattern, parts []string) bool {
	var walk func(i, j int) bool
	walk = func(i, j int) bool {
		for i < len(pattern) {
			if pattern[i] == "**" {
				if i == len(pattern)-1 {
					return true
				}
				for j <= len(parts) {
					if walk(i+1, j) {
						return true
					}
					j++
				}
				return false
			}
			if j >= len(parts) || !matchExcludePart(pattern[i], parts[j]) {
				return false
			}
			i++
			j++
		}
		return j == len(parts)
	}
	return walk(0, 0)
}

func pathExcluded(lines []string, rel string, isDir bool) bool {
	patterns, _, err := compileScanExcludes(lines)
	if err != nil || len(patterns) == 0 {
		return false
	}
	rel = path.Clean(strings.ReplaceAll(rel, "\\", "/"))
	if rel == "." || rel == "" || rel == ".." || strings.HasPrefix(rel, "../") {
		return false
	}
	if excludeMatch(patterns, rel, isDir) {
		return true
	}
	for parent := path.Dir(rel); parent != "." && parent != "/"; parent = path.Dir(parent) {
		if excludeMatch(patterns, parent, true) {
			return true
		}
	}
	return false
}

func excludeMatch(patterns []excludePattern, rel string, isDir bool) bool {
	for _, pattern := range patterns {
		if pattern.matches(rel, isDir) {
			return true
		}
	}
	return false
}

func (s *Store) pathExcluded(rel string, isDir bool) bool {
	return pathExcluded(s.state.Settings.ScanExcludes, rel, isDir)
}

// NormalizeScanExcludes canonicalizes startup and settings exclude rules.
func NormalizeScanExcludes(lines []string) ([]string, error) {
	return normalizeScanExcludes(lines)
}

// ReadScanExcludes reads scanExcludes from a notebook without creating it or
// walking its notes. A missing notebook or state file yields an empty list.
func ReadScanExcludes(root string) ([]string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return []string{}, nil
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if resolved, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		abs = resolved
	} else if !os.IsNotExist(evalErr) {
		return nil, evalErr
	}
	data, err := os.ReadFile(filepath.Join(abs, ".echo", "state.json"))
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var state diskState
	if err = json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("state.json 损坏，请从备份恢复: %w", err)
	}
	return normalizeScanExcludes(state.Settings.ScanExcludes)
}

// ExcludeDirsToPatterns converts selected directories into anchored directory
// excludes ("/relative/path/"). Directories outside the notebook, the notebook
// itself, and the reserved .echo directory are returned in rejected. root must
// already be a directory; a failure to resolve it is returned in err.
func ExcludeDirsToPatterns(root string, dirs []string) ([]string, []string, error) {
	rootDir, err := canonicalDirectory(root)
	if err != nil {
		if strings.TrimSpace(root) == "" {
			return nil, nil, fmt.Errorf("请先选择笔记目录")
		}
		return nil, nil, fmt.Errorf("笔记目录无效：%w", err)
	}
	accepted := []string{}
	rejected := []string{}
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		pattern, reason := excludeDirPattern(rootDir, dir)
		if reason != "" {
			rejected = append(rejected, dir+"："+reason)
			continue
		}
		accepted = append(accepted, pattern)
	}
	normalized, err := normalizeScanExcludes(accepted)
	if err != nil {
		return nil, rejected, err
	}
	return normalized, rejected, nil
}

func excludeDirPattern(root, dir string) (string, string) {
	resolved, err := canonicalDirectory(dir)
	if err != nil {
		return "", err.Error()
	}
	rel, err := relativeInsideDirectory(root, resolved)
	if err != nil {
		return "", err.Error()
	}
	if rel == "." {
		return "", "不能排除整个笔记库"
	}
	pattern := "/" + rel + "/"
	if _, err = normalizeScanExcludes([]string{pattern}); err != nil {
		return "", err.Error()
	}
	return pattern, ""
}

func canonicalDirectory(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("路径为空")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("无法访问目录：%w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("无法访问目录：%w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是文件夹")
	}
	return filepath.Clean(resolved), nil
}

func relativeInsideDirectory(root, dir string) (string, error) {
	root = filepath.Clean(root)
	dir = filepath.Clean(dir)
	if strings.EqualFold(dir, root) {
		return ".", nil
	}
	if len(dir) <= len(root) || !strings.EqualFold(dir[:len(root)], root) || (dir[len(root)] != filepath.Separator && dir[len(root)] != '/') {
		return "", fmt.Errorf("不在笔记目录内")
	}
	rel := path.Clean(filepath.ToSlash(dir[len(root)+1:]))
	if rel == "." || rel == "" || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("不在笔记目录内")
	}
	for _, part := range strings.Split(rel, "/") {
		if strings.EqualFold(part, ".echo") {
			return "", fmt.Errorf("不能排除 .echo 配置目录")
		}
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("排除目录无效")
		}
	}
	return rel, nil
}

func (s *Store) ensureScanned(name string, isDir bool) error {
	if name == s.state.Settings.AssetsDir || strings.HasPrefix(name, s.state.Settings.AssetsDir+"/") {
		return nil
	}
	if s.pathExcluded(name, isDir) {
		return fmt.Errorf("目标位于扫描排除路径，不会出现在笔记库中")
	}
	return nil
}
