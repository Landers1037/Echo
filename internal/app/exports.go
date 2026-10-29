package app

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
)

type SnapshotNote struct {
	Note
	Assets map[string]string `json:"assets"`
}
type ExportSnapshot struct {
	Notes    []SnapshotNote `json:"notes"`
	Missing  []string       `json:"missing"`
	External []string       `json:"external"`
}
type exportAsset struct {
	data   []byte
	target string
	source string
}

func assetMIME(name string, data []byte) string {
	if value := mime.TypeByExtension(path.Ext(name)); strings.HasPrefix(value, "image/") {
		return strings.Split(value, ";")[0]
	}
	return http.DetectContentType(data)
}
func (s *Store) snapshot(paths []string) (ExportSnapshot, map[string]exportAsset, error) {
	snapshot := ExportSnapshot{Notes: []SnapshotNote{}, Missing: []string{}, External: []string{}}
	assets := map[string]exportAsset{}
	seen := map[string]bool{}
	if len(paths) == 0 {
		return snapshot, assets, fmt.Errorf("请选择要导出的笔记")
	}
	paths = append([]string{}, paths...)
	sort.Strings(paths)
	total := 0
	for _, name := range paths {
		if seen[name] {
			continue
		}
		seen[name] = true
		note, err := s.readNote(name)
		if err != nil {
			return snapshot, assets, err
		}
		item := SnapshotNote{Note: note, Assets: map[string]string{}}
		for _, source := range markdownImageSources(note.Content) {
			if strings.HasPrefix(source, "data:image/") {
				continue
			}
			target, ok := localReference(note.Path, source)
			if !ok {
				if strings.HasPrefix(source, "https://") || strings.HasPrefix(source, "http://") {
					snapshot.External = append(snapshot.External, note.Path+": "+source)
				} else {
					snapshot.Missing = append(snapshot.Missing, note.Path+": "+source)
				}
				continue
			}
			asset, exists := assets[target]
			if !exists {
				file, e := s.safePath(target)
				if e != nil {
					snapshot.Missing = append(snapshot.Missing, note.Path+": "+source)
					continue
				}
				data, e := os.ReadFile(file)
				if e != nil {
					snapshot.Missing = append(snapshot.Missing, note.Path+": "+source)
					continue
				}
				if !isDrawingName(target) && !strings.HasPrefix(assetMIME(target, data), "image/") {
					snapshot.Missing = append(snapshot.Missing, note.Path+": "+source)
					continue
				}
				total += len(data)
				if total > 128*1024*1024 {
					return snapshot, assets, fmt.Errorf("单次导出图片总大小不能超过 128MB，请分批导出")
				}
				asset = exportAsset{data: data, target: target, source: source}
				assets[target] = asset
			}
			mediaType := assetMIME(target, asset.data)
			if kind := drawingMediaType(target); kind != "" {
				mediaType = kind
			}
			item.Assets[source] = "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(asset.data)
		}
		snapshot.Notes = append(snapshot.Notes, item)
	}
	snapshot.Missing = normalizeNames(snapshot.Missing)
	snapshot.External = normalizeNames(snapshot.External)
	return snapshot, assets, nil
}
func markdownBundle(snapshot ExportSnapshot, assets map[string]exportAsset) ([]byte, error) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	mapping := map[string]string{}
	keys := []string{}
	for key := range assets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	written := map[string]bool{}
	for _, key := range keys {
		asset := assets[key]
		name := path.Join(".assets", revision(asset.data)[:24]+strings.ToLower(path.Ext(key)))
		mapping[key] = name
		if written[name] {
			continue
		}
		written[name] = true
		file, err := archive.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err = file.Write(asset.data); err != nil {
			return nil, err
		}
	}
	for _, note := range snapshot.Notes {
		content := rewriteLinks(note.Content, note.Path, note.Path, func(target string) string {
			if mapped, ok := mapping[target]; ok {
				return mapped
			}
			return target
		})
		file, err := archive.Create(note.Path)
		if err != nil {
			return nil, err
		}
		if _, err = file.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
