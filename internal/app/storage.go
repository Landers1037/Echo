package app

import (
	"errors"
	"fmt"
	"html"
	"io/fs"
	"mime"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"gopkg.in/yaml.v3"
)

type StorageUsage struct {
	Root          string `json:"root"`
	AssetsDir     string `json:"assetsDir"`
	DatabaseBytes int64  `json:"databaseBytes"`
	NoteBytes     int64  `json:"noteBytes"`
	NoteCount     int    `json:"noteCount"`
	AssetBytes    int64  `json:"assetBytes"`
	AssetCount    int    `json:"assetCount"`
}

type UnusedAsset struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	modified time.Time
}

type UnusedAssets struct {
	AssetsDir string        `json:"assetsDir"`
	Files     []UnusedAsset `json:"files"`
	Bytes     int64         `json:"bytes"`
	Token     string        `json:"token"`
}

type AssetCleanup struct {
	RemovedCount int      `json:"removedCount"`
	RemovedBytes int64    `json:"removedBytes"`
	Failed       []string `json:"failed"`
}

var errStorageChanged = errors.New("笔记或图片资源已变化，请重新检查后清理")
var storageHTMLReference = regexp.MustCompile(`(?i)(?:src|href)\s*=\s*["']([^"'<>]+)["']`)
var storageWikiReference = regexp.MustCompile(`!?\[\[([^\]\r\n]+)\]\]`)
var storageTrashID = regexp.MustCompile(`^[0-9a-f]{24}$`)

func storageKey(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(name)
	}
	return name
}

func storageAssetName(name string) bool {
	if isDrawingName(name) {
		return true
	}
	return strings.HasPrefix(mime.TypeByExtension(strings.ToLower(path.Ext(name))), "image/")
}

func withinStorageDir(name, directory string) bool {
	name, directory = storageKey(name), storageKey(directory)
	return name == directory || strings.HasPrefix(name, directory+"/")
}

// logicalRoot preserves the original paths of recycled notes, so their relative
// image references still protect resources that will be needed after restore.
func walkStorageNotes(root, logicalRoot string, excluded func(string, bool) bool, visit func(string, string, fs.FileInfo) error) error {
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if logicalRoot != "" && excluded != nil && excluded(logicalRoot, info.IsDir()) {
		return nil
	}
	return filepath.WalkDir(root, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		name := path.Join(logicalRoot, filepath.ToSlash(rel))
		if name == "." {
			name = logicalRoot
		}
		if entry.IsDir() {
			if file != root && (strings.EqualFold(entry.Name(), ".echo") || (excluded != nil && name != "" && excluded(name, true))) {
				return filepath.SkipDir
			}
			return nil
		}
		if excluded != nil && name != "" && excluded(name, false) {
			return nil
		}
		if !strings.EqualFold(path.Ext(name), ".md") || !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return visit(name, file, info)
	})
}

func (s *Store) storageAssets(visit func(UnusedAsset, fs.FileInfo) error) error {
	root, err := s.safePath(s.state.Settings.AssetsDir)
	if err != nil {
		return err
	}
	if _, err = os.Lstat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !entry.Type().IsRegular() || !storageAssetName(file) {
			return nil
		}
		rel, err := filepath.Rel(s.root, file)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return visit(UnusedAsset{Path: filepath.ToSlash(rel), Size: info.Size(), modified: info.ModTime()}, info)
	})
}

func (s *Store) storageUsage() (StorageUsage, error) {
	usage := StorageUsage{Root: s.root, AssetsDir: s.state.Settings.AssetsDir}
	info, err := os.Lstat(filepath.Join(s.root, ".echo", "state.json"))
	if err != nil {
		return usage, err
	}
	if !info.Mode().IsRegular() {
		return usage, fmt.Errorf("配置数据文件不是普通文件")
	}
	usage.DatabaseBytes = info.Size()
	err = walkStorageNotes(s.root, "", s.pathExcluded, func(name, _ string, info fs.FileInfo) error {
		if !withinStorageDir(name, usage.AssetsDir) {
			usage.NoteCount++
			usage.NoteBytes += info.Size()
		}
		return nil
	})
	if err != nil {
		return usage, err
	}
	err = s.storageAssets(func(asset UnusedAsset, _ fs.FileInfo) error {
		usage.AssetCount++
		usage.AssetBytes += asset.Size
		return nil
	})
	return usage, err
}

func storageReferences(content string) ([]string, error) {
	header, body, _, err := frontmatter(content)
	if err != nil {
		return nil, err
	}
	sources := []string{}
	if header != "" {
		var doc yaml.Node
		if err := yaml.Unmarshal([]byte(header), &doc); err != nil {
			return nil, fmt.Errorf("YAML 文件头无效: %w", err)
		}
		var scalars func(*yaml.Node)
		scalars = func(node *yaml.Node) {
			if node.Kind == yaml.ScalarNode {
				sources = append(sources, node.Value)
			}
			for _, child := range node.Content {
				scalars(child)
			}
		}
		scalars(&doc)
	}
	document := goldmark.DefaultParser().Parse(text.NewReader([]byte(body)))
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			var destination []byte
			switch item := node.(type) {
			case *ast.Image:
				destination = item.Destination
			case *ast.Link:
				destination = item.Destination
			}
			if destination != nil {
				sources = append(sources, string(util.URLEscape(destination, true)))
			}
		}
		return ast.WalkContinue, nil
	})
	// Keep HTML and wiki references conservatively, even though Echo does not
	// render raw HTML. Other Markdown editors may still use these images.
	for _, match := range storageHTMLReference.FindAllStringSubmatch(content, -1) {
		sources = append(sources, html.UnescapeString(match[1]))
	}
	for _, match := range storageWikiReference.FindAllStringSubmatch(content, -1) {
		source := strings.SplitN(match[1], "|", 2)[0]
		sources = append(sources, source, "/"+strings.TrimPrefix(source, "/"))
	}
	return sources, nil
}

func (s *Store) unusedAssets() (UnusedAssets, error) {
	result := UnusedAssets{AssetsDir: s.state.Settings.AssetsDir, Files: []UnusedAsset{}}
	references := map[string]bool{}
	var signature strings.Builder
	signature.WriteString(result.AssetsDir + "\x00")
	visit := func(name, file string, _ fs.FileInfo) error {
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		sources, err := storageReferences(string(data))
		if err != nil {
			return fmt.Errorf("无法检查笔记 %s 的图片引用: %w", name, err)
		}
		fmt.Fprintf(&signature, "note:%s\x00%s\x00", name, revision(data))
		for _, source := range sources {
			if target, ok := localReference(name, source); ok {
				references[storageKey(target)] = true
			}
		}
		return nil
	}
	if err := walkStorageNotes(s.root, "", s.pathExcluded, visit); err != nil {
		return result, err
	}
	for _, entry := range s.state.Trash {
		if !storageTrashID.MatchString(entry.ID) {
			return result, fmt.Errorf("回收站记录无效，无法安全检查图片引用")
		}
		root := filepath.Join(s.root, ".echo", "trash", entry.ID)
		if err := walkStorageNotes(root, entry.Path, s.pathExcluded, visit); err != nil && !os.IsNotExist(err) {
			return result, err
		}
	}
	err := s.storageAssets(func(asset UnusedAsset, info fs.FileInfo) error {
		fmt.Fprintf(&signature, "asset:%s\x00%d\x00%s\x00", asset.Path, asset.Size, info.ModTime().UTC())
		if !references[storageKey(asset.Path)] {
			result.Files = append(result.Files, asset)
			result.Bytes += asset.Size
		}
		return nil
	})
	result.Token = revision([]byte(signature.String()))
	return result, err
}

func (s *Store) cleanupAssets(token string) (AssetCleanup, error) {
	result := AssetCleanup{Failed: []string{}}
	current, err := s.unusedAssets()
	if err != nil {
		return result, err
	}
	if token == "" || token != current.Token {
		return result, errStorageChanged
	}
	if len(current.Files) == 0 {
		return result, nil
	}
	libraryRoot, err := os.OpenRoot(s.root)
	if err != nil {
		return result, err
	}
	defer libraryRoot.Close()
	assetsRoot, err := libraryRoot.OpenRoot(current.AssetsDir)
	if err != nil {
		return result, err
	}
	defer assetsRoot.Close()
	for _, asset := range current.Files {
		_, err := s.safePath(asset.Path)
		name := strings.TrimPrefix(asset.Path, current.AssetsDir+"/")
		if err == nil {
			var info fs.FileInfo
			info, err = assetsRoot.Lstat(name)
			if err == nil && (!info.Mode().IsRegular() || info.Size() != asset.Size || !info.ModTime().Equal(asset.modified)) {
				err = fmt.Errorf("文件已变化，请重新检查")
			}
		}
		if err == nil {
			err = assetsRoot.Remove(name)
		}
		if err != nil {
			result.Failed = append(result.Failed, asset.Path+"："+err.Error())
			continue
		}
		result.RemovedCount++
		result.RemovedBytes += asset.Size
	}
	return result, nil
}
