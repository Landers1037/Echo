package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"echo/internal/web"
)

type handler struct {
	store         *Store
	dev           bool
	web           http.Handler
	openDirectory func(string) error
}

func NewHandler(store *Store, dev bool) http.Handler {
	return &handler{store: store, dev: dev, web: web.Handler(), openDirectory: openNotebookDirectory}
}
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, err error) {
	var conflict *Conflict
	if errors.As(err, &conflict) {
		jsonResponse(w, http.StatusConflict, map[string]any{"error": err.Error(), "current": conflict.Current})
		return
	}
	status := http.StatusBadRequest
	if errors.Is(err, errStorageChanged) {
		status = http.StatusConflict
	}
	if isNotFound(err) {
		status = http.StatusNotFound
	}
	jsonResponse(w, status, map[string]any{"error": err.Error()})
}
func decode(r *http.Request, value any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 32*1024*1024))
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("请求 JSON 无效: %w", err)
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fmt.Errorf("请求包含多余内容或超过大小限制")
	}
	return nil
}
func localHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	if !localHost(r.Host) {
		jsonResponse(w, http.StatusForbidden, map[string]any{"error": "仅允许本机访问"})
		return
	}
	origin := r.Header.Get("Origin")
	if origin != "" {
		parsed, err := url.Parse(origin)
		allowed := err == nil && parsed.Host == r.Host && (parsed.Scheme == "http" || parsed.Scheme == "https")
		if h.dev && err == nil && localHost(parsed.Host) && (parsed.Host == "localhost:5173" || parsed.Host == "127.0.0.1:5173") {
			allowed = true
		}
		if !allowed {
			jsonResponse(w, http.StatusForbidden, map[string]any{"error": "请求来源不受信任"})
			return
		}
		if h.dev {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		jsonResponse(w, http.StatusForbidden, map[string]any{"error": "不允许跨站写入"})
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		h.web.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/api/events" {
		h.events(w, r)
		return
	}
	h.store.mu.Lock()
	defer h.store.mu.Unlock()
	if err := h.api(w, r); err != nil {
		fail(w, err)
	}
}
func (h *handler) api(w http.ResponseWriter, r *http.Request) error {
	s := h.store
	if r.Method != "GET" && r.Method != "HEAD" {
		if _, err := os.Stat(s.journalPath()); err == nil {
			return fmt.Errorf("资源迁移尚待恢复，已暂时停止写入以保护笔记。请备份数据后重启并查看恢复提示")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	query := r.URL.Query()
	method := r.Method
	switch r.URL.Path {
	case "/api/health":
		jsonResponse(w, 200, map[string]any{"ok": true, "dataDir": s.root})
		return nil
	case "/api/tree":
		if method != "GET" {
			break
		}
		tree, err := s.tree()
		if err != nil {
			return err
		}
		jsonResponse(w, 200, tree)
		return nil
	case "/api/notes", "/api/search":
		switch method {
		case "GET":
			if name := query.Get("path"); name != "" {
				note, err := s.readNote(name)
				if err != nil {
					return err
				}
				jsonResponse(w, 200, note)
				return nil
			}
			notes, err := s.listNotes()
			if err != nil {
				return err
			}
			filtered := []Note{}
			q := strings.ToLower(query.Get("q"))
			group, groupFilter := query["group"]
			tags := []string{}
			for _, tag := range query["tags"] {
				tags = append(tags, strings.Split(tag, ",")...)
			}
			for _, note := range notes {
				if q != "" && !strings.Contains(strings.ToLower(note.Path+"\n"+note.Content), q) {
					continue
				}
				if groupFilter && len(group) > 0 && note.Metadata.Group != group[0] {
					continue
				}
				match := true
				for _, tag := range tags {
					if tag == "" {
						continue
					}
					found := false
					for _, actual := range note.Metadata.Tags {
						if actual == tag {
							found = true
							break
						}
					}
					if !found {
						match = false
						break
					}
				}
				if !match {
					continue
				}
				note.Content = ""
				filtered = append(filtered, note)
			}
			jsonResponse(w, 200, filtered)
			return nil
		case "POST":
			var request struct {
				Path    string  `json:"path"`
				Content *string `json:"content"`
			}
			if err := decode(r, &request); err != nil {
				return err
			}
			content := "# " + strings.TrimSuffix(path.Base(request.Path), path.Ext(request.Path)) + "\n\n"
			if request.Content != nil {
				content = *request.Content
			}
			note, err := s.createNote(request.Path, content)
			if err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 201, note)
			return nil
		case "PUT":
			var request struct {
				Path     string `json:"path"`
				Content  string `json:"content"`
				Revision string `json:"revision"`
				Force    bool   `json:"force"`
			}
			if err := decode(r, &request); err != nil {
				return err
			}
			note, err := s.saveNote(request.Path, request.Content, request.Revision, request.Force)
			if err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 200, note)
			return nil
		case "DELETE":
			if err := s.recycle(query.Get("path")); err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return nil
		}
	case "/api/notes/move", "/api/folders/move":
		if method != "POST" {
			break
		}
		var request struct {
			Path     string `json:"path"`
			Target   string `json:"target"`
			Revision string `json:"revision"`
		}
		if err := decode(r, &request); err != nil {
			return err
		}
		folder := r.URL.Path == "/api/folders/move"
		note, err := s.move(request.Path, request.Target, request.Revision, folder)
		if err != nil {
			return err
		}
		s.changed()
		if folder {
			jsonResponse(w, 200, map[string]bool{"ok": true})
		} else {
			jsonResponse(w, 200, note)
		}
		return nil
	case "/api/notes/batch":
		if method != "POST" {
			break
		}
		var request struct {
			Paths     []string          `json:"paths"`
			Tags      *[]string         `json:"tags"`
			Group     *string           `json:"group"`
			Revisions map[string]string `json:"revisions"`
		}
		if err := decode(r, &request); err != nil {
			return err
		}
		notes, err := s.batchMetadata(request.Paths, request.Tags, request.Group, request.Revisions)
		if err != nil {
			return err
		}
		s.changed()
		jsonResponse(w, 200, notes)
		return nil
	case "/api/folders":
		if method == "POST" {
			var request struct {
				Path string `json:"path"`
			}
			if err := decode(r, &request); err != nil {
				return err
			}
			file, err := s.safePath(request.Path)
			if err != nil {
				return err
			}
			if strings.HasPrefix(path.Base(request.Path), ".") {
				return fmt.Errorf("文件夹名称不能以点开头")
			}
			if _, err = os.Stat(file); !os.IsNotExist(err) {
				return fmt.Errorf("目标已经存在")
			}
			if err = os.MkdirAll(file, 0755); err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 201, map[string]bool{"ok": true})
			return nil
		}
		if method == "DELETE" {
			if err := s.recycle(query.Get("path")); err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return nil
		}
	case "/api/trash":
		if method != "GET" {
			break
		}
		entries := append([]TrashEntry{}, s.state.Trash...)
		jsonResponse(w, 200, entries)
		return nil
	case "/api/trash/restore":
		if method != "POST" {
			break
		}
		var request struct {
			ID string `json:"id"`
		}
		if err := decode(r, &request); err != nil {
			return err
		}
		if err := s.restore(request.ID); err != nil {
			return err
		}
		s.changed()
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return nil
	case "/api/groups", "/api/tags":
		kind := strings.TrimPrefix(r.URL.Path, "/api/")
		if method == "GET" {
			names, err := s.categories(kind)
			if err != nil {
				return err
			}
			jsonResponse(w, 200, names)
			return nil
		}
		if method == "POST" || method == "PUT" || method == "DELETE" {
			var request struct {
				Name    string `json:"name"`
				NewName string `json:"newName"`
			}
			if method == "DELETE" {
				request.Name = query.Get("name")
			} else if err := decode(r, &request); err != nil {
				return err
			}
			if err := s.categoryChange(kind, method, request.Name, request.NewName); err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return nil
		}
	case "/api/storage/open":
		if method == "POST" {
			if err := h.openDirectory(s.root); err != nil {
				return err
			}
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return nil
		}
	case "/api/storage":
		if method == "GET" {
			usage, err := s.storageUsage()
			if err != nil {
				return err
			}
			jsonResponse(w, 200, usage)
			return nil
		}
	case "/api/storage/unused-assets":
		if method == "GET" {
			unused, err := s.unusedAssets()
			if err != nil {
				return err
			}
			jsonResponse(w, 200, unused)
			return nil
		}
	case "/api/storage/cleanup":
		if method == "POST" {
			var request struct {
				Token string `json:"token"`
			}
			if err := decode(r, &request); err != nil {
				return err
			}
			result, err := s.cleanupAssets(request.Token)
			if err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 200, result)
			return nil
		}
	case "/api/settings":
		if method == "GET" {
			jsonResponse(w, 200, s.state.Settings)
			return nil
		}
		if method == "PUT" {
			settings := s.state.Settings
			previousShortcuts := settings.Shortcuts
			// Decoding into an existing map merges keys, so clear it first and restore only when the request omits shortcuts.
			settings.Shortcuts = nil
			if err := decode(r, &settings); err != nil {
				return err
			}
			if settings.Shortcuts == nil {
				settings.Shortcuts = previousShortcuts
			}
			if err := s.updateSettings(settings); err != nil {
				return err
			}
			s.changed()
			jsonResponse(w, 200, s.state.Settings)
			return nil
		}
	case "/api/assets":
		if method == "GET" || method == "HEAD" {
			file, err := s.safePath(query.Get("path"))
			if err != nil {
				return err
			}
			data, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			contentType := assetMIME(file, data)
			if !strings.HasPrefix(contentType, "image/") || contentType == "image/svg+xml" {
				return fmt.Errorf("只允许读取受支持的图片资源")
			}
			w.Header().Set("Content-Type", contentType)
			w.Header().Set("Cache-Control", "private, max-age=300")
			http.ServeContent(w, r, path.Base(file), time.Time{}, strings.NewReader(string(data)))
			return nil
		}
		if method == "POST" {
			return h.upload(w, r)
		}
	case "/api/tasks":
		if method == "GET" {
			tasks, err := s.allTasks()
			if err != nil {
				return err
			}
			jsonResponse(w, 200, tasks)
			return nil
		}
		if method == "PUT" {
			var update TaskUpdate
			if err := decode(r, &update); err != nil {
				return err
			}
			note, err := s.updateTask(update)
			if err != nil {
				return err
			}
			s.changed()
			s.checkReminders(time.Now())
			jsonResponse(w, 200, note)
			return nil
		}
	case "/api/reminders":
		if method != "GET" {
			break
		}
		s.checkReminders(time.Now())
		reminders := []Reminder{}
		for _, reminder := range s.state.Reminders {
			if !reminder.Acknowledged {
				reminders = append(reminders, reminder)
			}
		}
		jsonResponse(w, 200, reminders)
		return nil
	case "/api/reminders/ack":
		if method != "POST" {
			break
		}
		var request struct {
			ID string `json:"id"`
		}
		if err := decode(r, &request); err != nil {
			return err
		}
		claimed := false
		for i := range s.state.Reminders {
			if s.state.Reminders[i].ID == request.ID && !s.state.Reminders[i].Acknowledged {
				s.state.Reminders[i].Acknowledged = true
				if err := s.persist(); err != nil {
					s.state.Reminders[i].Acknowledged = false
					return err
				}
				claimed = true
				break
			}
		}
		jsonResponse(w, 200, map[string]bool{"claimed": claimed})
		return nil
	case "/api/exports":
		if method != "POST" {
			break
		}
		var request struct {
			Paths        []string `json:"paths"`
			Format       string   `json:"format"`
			AllowMissing bool     `json:"allowMissing"`
		}
		if err := decode(r, &request); err != nil {
			return err
		}
		if request.Format == "md" {
			if len(request.Paths) != 1 {
				return fmt.Errorf("直接 Markdown 导出需要选择一篇笔记")
			}
			note, err := s.readNote(request.Paths[0])
			if err != nil {
				return err
			}
			download(w, path.Base(note.Path), "text/markdown; charset=utf-8", []byte(note.Content))
			return nil
		}
		snapshot, assets, err := s.snapshot(request.Paths)
		if err != nil {
			return err
		}
		if len(snapshot.Missing) > 0 && !request.AllowMissing {
			jsonResponse(w, http.StatusUnprocessableEntity, map[string]any{"error": "部分图片资源缺失，请确认是否继续", "missing": snapshot.Missing, "external": snapshot.External})
			return nil
		}
		if request.Format == "snapshot" {
			jsonResponse(w, 200, snapshot)
			return nil
		}
		if request.Format == "bundle" {
			data, err := markdownBundle(snapshot, assets)
			if err != nil {
				return err
			}
			download(w, "Echo-notes.zip", "application/zip", data)
			return nil
		}
		return fmt.Errorf("不支持的导出格式")
	}
	jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
	return nil
}
func download(w http.ResponseWriter, name, contentType string, data []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
func (h *handler) upload(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, 21*1024*1024)
	if err := r.ParseMultipartForm(21 * 1024 * 1024); err != nil {
		return fmt.Errorf("图片上传失败或超过 20MB")
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return fmt.Errorf("请提供 file 图片字段")
	}
	defer file.Close()
	note, err := h.store.readNote(r.URL.Query().Get("notePath"))
	if err != nil {
		return err
	}
	data, err := readLimited(file, 20*1024*1024)
	if err != nil {
		return err
	}
	typeName := http.DetectContentType(data)
	extension := ""
	switch typeName {
	case "image/png":
		extension = ".png"
	case "image/jpeg":
		extension = ".jpg"
	case "image/gif":
		extension = ".gif"
	case "image/webp":
		extension = ".webp"
	default:
		return fmt.Errorf("只支持 PNG、JPEG、GIF 和 WebP 图片")
	}
	if len(data) == 0 {
		return fmt.Errorf("图片不能为空")
	}
	name := path.Join(h.store.state.Settings.AssetsDir, newID()+extension)
	target, err := h.store.safePath(name)
	if err != nil {
		return err
	}
	if err = atomicWrite(target, data, 0644); err != nil {
		return err
	}
	_ = header
	jsonResponse(w, 201, map[string]string{"path": name, "url": "/api/assets?path=" + url.QueryEscape(name), "markdownPath": relativeLink(note.Path, name, name)})
	return nil
}
func (h *handler) events(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		jsonResponse(w, 405, map[string]string{"error": "需要 GET 请求"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	client := make(chan []byte, 16)
	h.store.mu.Lock()
	h.store.clients[client] = true
	h.store.mu.Unlock()
	defer func() { h.store.mu.Lock(); delete(h.store.clients, client); h.store.mu.Unlock() }()
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-client:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
