package app

import (
	"archive/tar"
	"archive/zip"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

const maxRepositoryExportFiles = 100000

var maxRepositoryExportBytes int64 = 4 << 30

type repositoryEntry struct {
	name   string
	full   string
	info   os.FileInfo
	inline bool
	data   []byte
}

func repositoryExportType(format string) string {
	if format == "tar" {
		return "application/x-tar"
	}
	return "application/zip"
}

func repositoryExportName(root, format string) string {
	base := sanitizeExportBase(filepath.Base(root))
	if format == "tar" {
		return base + ".tar"
	}
	return base + ".zip"
}

func sanitizeExportBase(base string) string {
	var cleaned strings.Builder
	for _, r := range base {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			cleaned.WriteRune('_')
			continue
		}
		cleaned.WriteRune(r)
	}
	name := strings.Trim(cleaned.String(), " .")
	if name == "" || name == ".." {
		return "笔记库"
	}
	return name
}

func repositoryTooLargeError() error {
	const unit int64 = 1024 * 1024 * 1024
	if maxRepositoryExportBytes >= unit && maxRepositoryExportBytes%unit == 0 {
		return fmt.Errorf("笔记库超过 %dGB，无法一次导出", maxRepositoryExportBytes/unit)
	}
	return fmt.Errorf("笔记库过大，无法一次导出")
}

func repositoryArchivePath(rel string, dir bool) (string, error) {
	name := path.Clean(filepath.ToSlash(rel))
	if name == "." || name == ".." || strings.HasPrefix(name, "../") || path.IsAbs(name) || strings.ContainsAny(name, ":\\") {
		return "", fmt.Errorf("无法打包路径 %s", rel)
	}
	if dir {
		return name + "/", nil
	}
	return name, nil
}

func echoArchiveBase(name string) (bool, string) {
	key := filepath.ToSlash(name)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	if key == ".echo" {
		return true, ""
	}
	if strings.HasPrefix(key, ".echo/") {
		return true, path.Base(key)
	}
	return false, ""
}

func skipEchoArchiveName(base string) bool {
	switch base {
	case "agent.db-wal", "agent.db-shm", "agent.db-journal", "annotations.db-wal", "annotations.db-shm", "annotations.db-journal", "versions.db-wal", "versions.db-shm", "versions.db-journal":
		return true
	default:
		return false
	}
}

func repositoryDBKind(name string) string {
	key := filepath.ToSlash(name)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	switch key {
	case ".echo/agent.db":
		return "agent"
	case ".echo/annotations.db":
		return "annotations"
	case ".echo/versions.db":
		return "versions"
	default:
		return ""
	}
}

func (s *Store) writeRepositoryExport(format string, w io.Writer) error {
	switch format {
	case "zip", "tar":
	default:
		return fmt.Errorf("请选择 ZIP 或 TAR")
	}
	entries, err := s.repositoryEntries()
	if err != nil {
		return err
	}
	if format == "tar" {
		return writeRepositoryTar(entries, w)
	}
	return writeRepositoryZip(entries, w)
}

func (s *Store) repositoryEntries() ([]repositoryEntry, error) {
	entries := []repositoryEntry{}
	var total int64
	err := filepath.WalkDir(s.root, func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(s.root, file)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if name == "." {
			return nil
		}
		if strings.HasPrefix(path.Base(name), ".echo-write-") {
			return nil
		}
		echo, base := echoArchiveBase(name)
		if echo && skipEchoArchiveName(base) {
			return nil
		}
		if !echo && s.pathExcluded(name, entry.IsDir()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.IsDir() && !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		archiveName, err := repositoryArchivePath(name, entry.IsDir())
		if err != nil {
			return err
		}
		item := repositoryEntry{name: archiveName, full: file, info: info}
		size := info.Size()
		if entry.IsDir() {
			size = 0
		} else if kind := repositoryDBKind(name); kind != "" {
			data, err := s.exportDatabase(kind)
			if err != nil {
				return err
			}
			item.inline = true
			item.data = data
			size = int64(len(data))
		}
		if size < 0 || size > maxRepositoryExportBytes || total > maxRepositoryExportBytes-size {
			return repositoryTooLargeError()
		}
		if len(entries) >= maxRepositoryExportFiles {
			return fmt.Errorf("笔记库文件过多，无法一次导出")
		}
		total += size
		entries = append(entries, item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *Store) exportDatabase(kind string) ([]byte, error) {
	switch kind {
	case "agent":
		agent, err := s.agentService()
		if err != nil {
			return nil, err
		}
		return agent.exportDatabase()
	case "annotations":
		service, err := s.annotationService()
		if err != nil {
			return nil, err
		}
		return service.exportDatabase()
	case "versions":
		service, err := s.versionService()
		if err != nil {
			return nil, err
		}
		return service.exportDatabase()
	default:
		return nil, fmt.Errorf("未知数据库")
	}
}

func (a *Agent) exportDatabase() ([]byte, error) {
	var data []byte
	err := a.withDB(func(db *sql.DB) error {
		var err error
		data, err = vacuumSQLite(db)
		if err != nil {
			return fmt.Errorf("无法导出聊天记录：%w", err)
		}
		return nil
	})
	return data, err
}

func (a *Annotations) exportDatabase() ([]byte, error) {
	var data []byte
	err := a.withDB(func(db *sql.DB) error {
		var err error
		data, err = vacuumSQLite(db)
		if err != nil {
			return fmt.Errorf("无法导出标注数据：%w", err)
		}
		return nil
	})
	return data, err
}

// vacuumSQLite writes a standalone database. Reading the live file can fail
// while SQLite holds it open, and a WAL snapshot would be incomplete.
func vacuumSQLite(db *sql.DB) ([]byte, error) {
	tmp, err := os.CreateTemp("", "echo-sqlite-*")
	if err != nil {
		return nil, err
	}
	name := tmp.Name()
	if err = tmp.Close(); err != nil {
		_ = os.Remove(name)
		return nil, err
	}
	if err = os.Remove(name); err != nil {
		return nil, err
	}
	defer os.Remove(name)
	quoted := strings.ReplaceAll(filepath.ToSlash(name), "'", "''")
	if _, err = db.Exec("VACUUM INTO '" + quoted + "'"); err != nil {
		return nil, err
	}
	return os.ReadFile(name)
}

func writeRepositoryZip(entries []repositoryEntry, w io.Writer) error {
	archive := zip.NewWriter(w)
	for _, entry := range entries {
		header, err := zip.FileInfoHeader(entry.info)
		if err != nil {
			return err
		}
		header.Name = entry.name
		header.NonUTF8 = false
		if entry.info.IsDir() {
			if !strings.HasSuffix(header.Name, "/") {
				header.Name += "/"
			}
			header.Method = zip.Store
			header.UncompressedSize64 = 0
		} else {
			header.Method = zip.Deflate
			if entry.inline {
				header.UncompressedSize64 = uint64(len(entry.data))
			}
		}
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		if entry.info.IsDir() {
			continue
		}
		if err = copyRepositoryEntry(writer, entry); err != nil {
			return err
		}
	}
	return archive.Close()
}

func writeRepositoryTar(entries []repositoryEntry, w io.Writer) error {
	archive := tar.NewWriter(w)
	for _, entry := range entries {
		header, err := tar.FileInfoHeader(entry.info, "")
		if err != nil {
			return err
		}
		header.Name = entry.name
		header.Format = tar.FormatPAX
		if entry.info.IsDir() {
			if !strings.HasSuffix(header.Name, "/") {
				header.Name += "/"
			}
			header.Typeflag = tar.TypeDir
			header.Size = 0
		} else if entry.inline {
			header.Size = int64(len(entry.data))
		}
		if err = archive.WriteHeader(header); err != nil {
			return err
		}
		if entry.info.IsDir() {
			continue
		}
		if entry.inline {
			if _, err = archive.Write(entry.data); err != nil {
				return fmt.Errorf("打包 %s 失败: %w", entry.name, err)
			}
			continue
		}
		file, err := os.Open(entry.full)
		if err != nil {
			return fmt.Errorf("打包 %s 失败: %w", entry.name, err)
		}
		written, copyErr := io.Copy(archive, io.LimitReader(file, header.Size))
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("打包 %s 失败: %w", entry.name, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("打包 %s 失败: %w", entry.name, closeErr)
		}
		if written != header.Size {
			return fmt.Errorf("打包 %s 时文件发生变化，请重试", entry.name)
		}
	}
	return archive.Close()
}

func copyRepositoryEntry(w io.Writer, entry repositoryEntry) error {
	if entry.inline {
		if _, err := w.Write(entry.data); err != nil {
			return fmt.Errorf("打包 %s 失败: %w", entry.name, err)
		}
		return nil
	}
	file, err := os.Open(entry.full)
	if err != nil {
		return fmt.Errorf("打包 %s 失败: %w", entry.name, err)
	}
	defer file.Close()
	if _, err = io.Copy(w, file); err != nil {
		return fmt.Errorf("打包 %s 失败: %w", entry.name, err)
	}
	return nil
}
