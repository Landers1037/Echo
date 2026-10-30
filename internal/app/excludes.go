package app

import (
	"fmt"
	"path"
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

func (s *Store) ensureScanned(name string, isDir bool) error {
	if name == s.state.Settings.AssetsDir || strings.HasPrefix(name, s.state.Settings.AssetsDir+"/") {
		return nil
	}
	if s.pathExcluded(name, isDir) {
		return fmt.Errorf("目标位于扫描排除路径，不会出现在笔记库中")
	}
	return nil
}
