package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxRepositories = 5

type Repository struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	LastOpened string `json:"lastOpened"`
}

type RepositoryList struct {
	Current  string       `json:"current"`
	Items    []Repository `json:"items"`
	Switched bool         `json:"switched"`
	Canceled bool         `json:"canceled"`
}

type repositoryFile struct {
	Repositories []Repository `json:"repositories"`
}

// Workspace owns the active notebook and the recent-repository list. SSE
// clients live here so a switch keeps existing event streams attached.
type Workspace struct {
	mu          sync.Mutex
	clientsMu   sync.Mutex
	store       *Store
	cancel      context.CancelFunc
	base        context.Context
	started     bool
	history     []Repository
	historyFile string
	clients     map[chan []byte]bool
}

func repositoriesPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("无法定位仓库历史目录：%w", err)
	}
	return filepath.Join(dir, "Echo", "repositories.json"), nil
}

// LastRepository returns the most recently opened notebook. When no history
// exists, it falls back to a notes directory next to the executable.
func LastRepository() string {
	fallback := defaultNotesDir()
	file, err := repositoriesPath()
	if err != nil {
		return fallback
	}
	history, err := loadRepositories(file)
	if err != nil {
		return fallback
	}
	for _, item := range history {
		if strings.TrimSpace(item.Path) != "" {
			return item.Path
		}
	}
	return fallback
}

func defaultNotesDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "notes"
	}
	return filepath.Join(filepath.Dir(exe), "notes")
}

func loadRepositories(file string) ([]Repository, error) {
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return []Repository{}, nil
	}
	if err != nil {
		return nil, err
	}
	var decoded repositoryFile
	if err = json.Unmarshal(data, &decoded); err != nil {
		return nil, fmt.Errorf("仓库历史损坏，请检查 %s: %w", file, err)
	}
	if decoded.Repositories == nil {
		return []Repository{}, nil
	}
	return decoded.Repositories, nil
}

// OpenWorkspace opens the notebook selected at startup. An explicit data
// directory always wins. Otherwise the most recent repository is opened, and
// a failure falls back to fallback.
func OpenWorkspace(fallback string, explicit bool) (*Workspace, error) {
	file, err := repositoriesPath()
	if err != nil {
		return nil, err
	}
	history, err := loadRepositories(file)
	if err != nil {
		return nil, err
	}
	root := fallback
	if !explicit {
		for _, item := range history {
			if strings.TrimSpace(item.Path) != "" {
				root = item.Path
				break
			}
		}
	}
	store, err := Open(root)
	if err != nil && !explicit && root != fallback {
		store, err = Open(fallback)
	}
	if err != nil {
		return nil, err
	}
	ws := &Workspace{store: store, clients: map[chan []byte]bool{}, history: history, historyFile: file}
	store.broadcast = ws.broadcast
	if err = ws.remember(store.Root()); err != nil {
		return nil, err
	}
	return ws, nil
}

// attachStore binds a store to an in-memory workspace for handlers that do
// not persist repository history.
func attachStore(store *Store) *Workspace {
	ws := &Workspace{
		store:   store,
		clients: map[chan []byte]bool{},
		history: []Repository{{Path: store.Root(), Name: filepath.Base(store.Root()), LastOpened: time.Now().UTC().Format(time.RFC3339Nano)}},
	}
	store.broadcast = ws.broadcast
	return ws
}

func (w *Workspace) current() *Store {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.store
}

func (w *Workspace) Root() string { return w.current().Root() }

func (w *Workspace) Run(ctx context.Context) {
	w.mu.Lock()
	w.base = ctx
	runCtx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	store := w.store
	w.started = true
	w.mu.Unlock()
	go store.Run(runCtx)
	<-ctx.Done()
	w.mu.Lock()
	cancel = w.cancel
	store = w.store
	w.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	store.closeAgent()
}

func (w *Workspace) List() RepositoryList {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.listLocked()
}

func (w *Workspace) listLocked() RepositoryList {
	items := make([]Repository, len(w.history))
	copy(items, w.history)
	return RepositoryList{Current: w.store.Root(), Items: items}
}

func (w *Workspace) Switch(raw string) (RepositoryList, error) {
	resolved, err := canonicalRepositoryPath(raw)
	if err != nil {
		return RepositoryList{}, err
	}
	w.mu.Lock()
	if sameRepository(w.store.Root(), resolved) {
		w.touch(w.store.Root())
		err = w.saveLocked()
		list := w.listLocked()
		w.mu.Unlock()
		return list, err
	}
	w.mu.Unlock()

	next, err := Open(resolved)
	if err != nil {
		return RepositoryList{}, err
	}
	next.broadcast = w.broadcast

	w.mu.Lock()
	if sameRepository(w.store.Root(), next.Root()) {
		w.touch(next.Root())
		err = w.saveLocked()
		list := w.listLocked()
		w.mu.Unlock()
		return list, err
	}
	old := w.store
	oldCancel := w.cancel
	w.store = next
	if w.started && w.base != nil && w.base.Err() == nil {
		runCtx, cancel := context.WithCancel(w.base)
		w.cancel = cancel
		go next.Run(runCtx)
	}
	w.touch(next.Root())
	saveErr := w.saveLocked()
	list := w.listLocked()
	list.Switched = true
	w.mu.Unlock()

	old.mu.Lock()
	old.broadcast = nil
	old.mu.Unlock()
	if oldCancel != nil {
		oldCancel()
	}
	old.closeAgent()
	w.broadcast(map[string]any{"type": "switched"})
	return list, saveErr
}

func (w *Workspace) Rename(raw, name string) error {
	name = strings.TrimSpace(name)
	if strings.ContainsAny(name, "\r\n\x00") || utf8.RuneCountInString(name) > 80 {
		return fmt.Errorf("仓库名称不能包含换行，且不能超过 80 个字符")
	}
	query, err := normalizeRepositoryQuery(raw)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	index := w.indexOf(query)
	if index < 0 {
		return fmt.Errorf("找不到该仓库记录")
	}
	if name == "" {
		name = filepath.Base(w.history[index].Path)
	}
	w.history[index].Name = name
	return w.saveLocked()
}

func (w *Workspace) Remove(raw string) error {
	query, err := normalizeRepositoryQuery(raw)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if sameRepository(w.store.Root(), query) {
		return fmt.Errorf("不能删除当前打开的仓库")
	}
	index := w.indexOf(query)
	if index < 0 {
		return fmt.Errorf("找不到该仓库记录")
	}
	w.history = append(w.history[:index], w.history[index+1:]...)
	return w.saveLocked()
}

func (w *Workspace) remember(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.touch(path)
	return w.saveLocked()
}

func (w *Workspace) touch(path string) {
	kept := Repository{}
	found := false
	rest := make([]Repository, 0, len(w.history))
	for _, item := range w.history {
		if repositoryKey(item.Path) == repositoryKey(path) {
			if !found {
				kept = item
				found = true
			}
			continue
		}
		rest = append(rest, item)
	}
	if !found {
		kept = Repository{Path: path, Name: filepath.Base(path)}
	}
	kept.Path = path
	if strings.TrimSpace(kept.Name) == "" {
		kept.Name = filepath.Base(path)
	}
	kept.LastOpened = time.Now().UTC().Format(time.RFC3339Nano)
	history := append([]Repository{kept}, rest...)
	if len(history) > maxRepositories {
		history = history[:maxRepositories]
	}
	w.history = history
}

func (w *Workspace) indexOf(path string) int {
	for i, item := range w.history {
		if sameRepository(item.Path, path) {
			return i
		}
	}
	return -1
}

func (w *Workspace) saveLocked() error {
	if w.historyFile == "" {
		return nil
	}
	data, err := json.MarshalIndent(repositoryFile{Repositories: w.history}, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(w.historyFile), 0700); err != nil {
		return err
	}
	return atomicWrite(w.historyFile, data, 0600)
}

func (w *Workspace) addClient(client chan []byte) {
	w.clientsMu.Lock()
	defer w.clientsMu.Unlock()
	w.clients[client] = true
}

func (w *Workspace) removeClient(client chan []byte) {
	w.clientsMu.Lock()
	defer w.clientsMu.Unlock()
	delete(w.clients, client)
}

func (w *Workspace) broadcast(event any) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	w.clientsMu.Lock()
	defer w.clientsMu.Unlock()
	for client := range w.clients {
		select {
		case client <- data:
		default:
		}
	}
}

func canonicalRepositoryPath(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("请提供仓库路径")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("无法访问仓库目录：%w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("仓库路径不是文件夹")
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func normalizeRepositoryQuery(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("请提供仓库路径")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func repositoryKey(path string) string {
	return storageKey(filepath.Clean(path))
}

func sameRepository(left, right string) bool {
	if repositoryKey(left) == repositoryKey(right) {
		return true
	}
	return repositoryKey(canonicalOrClean(left)) == repositoryKey(canonicalOrClean(right))
}

func canonicalOrClean(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return abs
	}
	return resolved
}
