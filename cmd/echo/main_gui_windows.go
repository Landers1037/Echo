//go:build gui && windows

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"

	"echo/internal/app"

	"github.com/tailscale/walk"
	. "github.com/tailscale/walk/declarative"
	"github.com/tailscale/win"
)

func main() {
	logger := &guiLog{}
	log.SetOutput(logger)
	application, err := walk.InitApp()
	if err != nil {
		os.Exit(1)
	}
	ui := &guiApp{app: application, log: logger}
	if err = ui.create(); err != nil {
		walk.MsgBox(nil, "Echo", err.Error(), walk.MsgBoxIconError)
		os.Exit(1)
	}
	application.Run()
}

type guiApp struct {
	app            *walk.Application
	mw             *walk.MainWindow
	setup          *walk.Composite
	logs           *walk.Composite
	path           *walk.LineEdit
	host           *walk.LineEdit
	port           *walk.LineEdit
	excludes       *walk.ListBox
	removeBtn      *walk.PushButton
	clearBtn       *walk.PushButton
	openBtn        *walk.PushButton
	browserBtn     *walk.PushButton
	pageURL        string
	log            *guiLog
	loadedDir      string
	excludeRules   []string
	excludeLoadErr error

	mu      sync.Mutex
	running bool
	closed  bool
	cancel  context.CancelFunc
	done    chan struct{}
}

func (g *guiApp) create() error {
	saved := loadGUIListen()
	err := MainWindow{
		AssignTo: &g.mw,
		Title:    "Echo",
		Font:     Font{Family: "Segoe UI", PointSize: 9},
		MinSize:  Size{Width: 520, Height: 360},
		Size:     Size{Width: 600, Height: 440},
		Layout:   VBox{},
		Children: []Widget{
			Composite{
				AssignTo:      &g.setup,
				StretchFactor: 1,
				Layout:        VBox{},
				Children: []Widget{
					Label{Text: "笔记目录"},
					Composite{
						Layout: HBox{Spacing: 6},
						Children: []Widget{
							LineEdit{AssignTo: &g.path, Text: app.LastRepository(), StretchFactor: 1, OnEditingFinished: g.onPathEdited},
							PushButton{Text: "浏览...", OnClicked: g.browse, MinSize: Size{Width: 88}},
						},
					},
					Label{Text: "排除目录（跳过扫描，可多选）"},
					Composite{
						Layout:        HBox{Spacing: 6},
						StretchFactor: 1,
						Children: []Widget{
							ListBox{
								AssignTo:                 &g.excludes,
								MultiSelection:           true,
								StretchFactor:            1,
								MinSize:                  Size{Height: 96},
								Model:                    []string{},
								OnSelectedIndexesChanged: g.updateExcludeButtons,
								OnKeyDown:                g.onExcludeKey,
							},
							Composite{
								Layout: VBox{Spacing: 6},
								Children: []Widget{
									PushButton{Text: "添加目录...", OnClicked: g.addExcludes, MinSize: Size{Width: 88}},
									PushButton{AssignTo: &g.removeBtn, Text: "移除", OnClicked: g.removeExcludes, Enabled: false, MinSize: Size{Width: 88}},
									PushButton{AssignTo: &g.clearBtn, Text: "清空", OnClicked: g.clearExcludes, Enabled: false, MinSize: Size{Width: 88}},
								},
							},
						},
					},
					Composite{
						Layout: HBox{Spacing: 8, Alignment: AlignHNearVCenter},
						Children: []Widget{
							Composite{
								Layout:  VBox{},
								MinSize: Size{Width: 150},
								MaxSize: Size{Width: 180},
								Children: []Widget{
									Label{Text: "监听 IP"},
									LineEdit{AssignTo: &g.host, Text: saved.Host},
								},
							},
							Composite{
								Layout:  VBox{},
								MinSize: Size{Width: 90},
								MaxSize: Size{Width: 110},
								Children: []Widget{
									Label{Text: "端口"},
									LineEdit{AssignTo: &g.port, Text: saved.Port, MaxLength: 5},
								},
							},
							Composite{
								Layout: VBox{},
								Children: []Widget{
									Label{Text: " "},
									PushButton{AssignTo: &g.openBtn, Text: "启动", OnClicked: g.start, MinSize: Size{Width: 72}},
								},
							},
						},
					},
				},
			},
			Composite{
				AssignTo:      &g.logs,
				Visible:       false,
				StretchFactor: 1,
				Layout:        VBox{},
				Children: []Widget{
					TextEdit{
						AssignTo:      &g.log.view,
						ReadOnly:      true,
						VScroll:       true,
						HScroll:       true,
						MaxLength:     1 << 20,
						StretchFactor: 1,
					},
					PushButton{
						AssignTo:  &g.browserBtn,
						Enabled:   false,
						Text:      "在浏览器中打开",
						OnClicked: func() { openBrowser(g.pageURL) },
					},
				},
			},
		},
	}.Create()
	if err != nil {
		return err
	}
	// walk's window class loads resource ID 7 as HIcon; set it on the form too
	// so the title bar / taskbar match even if the class icon is unavailable.
	if icon, err := walk.NewIconFromResourceId(7); err == nil {
		_ = g.mw.SetIcon(icon)
	}
	g.mw.SetExitOnClose(false)
	g.mw.ToolBar().SetVisible(false)
	g.mw.StatusBar().SetVisible(false)
	// Visible is applied before the window is shown, while IsWindowVisible is
	// still false, so the declarative flag does not clear WS_VISIBLE.
	g.logs.SetVisible(false)
	g.mw.RequestLayout()
	g.mw.Closing().Attach(g.onClose)
	g.log.bind(g.app)
	g.reloadExcludes()
	return nil
}

func (g *guiApp) browse() {
	// walk roots the browser at InitialDirPath. An empty path makes
	// SHParseDisplayName block, so start from This PC and allow every drive.
	dialog := &walk.FileDialog{
		Title:          "选择笔记目录",
		InitialDirPath: `::{20D04FE0-3AEA-1069-A2D8-08002B30309D}`,
	}
	accepted, err := dialog.ShowBrowseFolder(g.mw)
	if err != nil {
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconError)
		return
	}
	if !accepted || strings.TrimSpace(dialog.FilePath) == "" {
		return
	}
	_ = g.path.SetText(dialog.FilePath)
	if !sameGUIDir(dialog.FilePath, g.loadedDir) {
		g.reloadExcludes()
	}
}

func (g *guiApp) onPathEdited() {
	if sameGUIDir(g.path.Text(), g.loadedDir) {
		return
	}
	g.reloadExcludes()
}

func (g *guiApp) reloadExcludes() {
	dir := strings.TrimSpace(g.path.Text())
	g.loadedDir = dir
	rules, err := app.ReadScanExcludes(dir)
	if err != nil && !strings.Contains(err.Error(), "排除规则") {
		g.excludeLoadErr = err
		g.setExcludeRules(nil)
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconError)
		return
	}
	g.excludeLoadErr = nil
	if err != nil {
		g.setExcludeRules(nil)
		walk.MsgBox(g.mw, "Echo", "已保存的排除规则无效，启动时会改用下面的列表。\n"+err.Error(), walk.MsgBoxIconWarning)
		return
	}
	g.setExcludeRules(rules)
}

func (g *guiApp) setExcludeRules(rules []string) {
	if rules == nil {
		rules = []string{}
	}
	g.excludeRules = append([]string{}, rules...)
	if g.excludes != nil {
		_ = g.excludes.SetModel(g.excludeRules)
	}
	g.updateExcludeButtons()
}

func (g *guiApp) updateExcludeButtons() {
	if g.removeBtn == nil || g.clearBtn == nil {
		return
	}
	selected := 0
	if g.excludes != nil {
		selected = len(g.excludes.SelectedIndexes())
	}
	g.removeBtn.SetEnabled(selected > 0)
	g.clearBtn.SetEnabled(len(g.excludeRules) > 0)
}

func (g *guiApp) onExcludeKey(key walk.Key) {
	if key == walk.KeyDelete {
		g.removeExcludes()
	}
}

func (g *guiApp) addExcludes() {
	dir := strings.TrimSpace(g.path.Text())
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		walk.MsgBox(g.mw, "Echo", "请先选择有效的笔记目录", walk.MsgBoxIconInformation)
		return
	}
	picked, err := pickFolders(g.mw.Handle(), dir)
	if err != nil {
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconError)
		return
	}
	if len(picked) == 0 {
		return
	}
	patterns, rejected, err := app.ExcludeDirsToPatterns(dir, picked)
	if err != nil {
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconError)
		return
	}
	if len(patterns) == 0 {
		if len(rejected) > 0 {
			walk.MsgBox(g.mw, "Echo", "没有添加目录：\n"+formatRejected(rejected), walk.MsgBoxIconInformation)
		}
		return
	}
	merged, err := app.NormalizeScanExcludes(append(append([]string{}, g.excludeRules...), patterns...))
	if err != nil {
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconError)
		return
	}
	g.excludeLoadErr = nil
	g.setExcludeRules(merged)
	if len(rejected) > 0 {
		walk.MsgBox(g.mw, "Echo", "以下目录未添加：\n"+formatRejected(rejected), walk.MsgBoxIconInformation)
	}
}

func (g *guiApp) removeExcludes() {
	if g.excludes == nil {
		return
	}
	indexes := append([]int{}, g.excludes.SelectedIndexes()...)
	if len(indexes) == 0 {
		return
	}
	sort.Sort(sort.Reverse(sort.IntSlice(indexes)))
	next := append([]string{}, g.excludeRules...)
	for _, index := range indexes {
		if index < 0 || index >= len(next) {
			continue
		}
		next = append(next[:index], next[index+1:]...)
	}
	g.excludeLoadErr = nil
	g.setExcludeRules(next)
}

func (g *guiApp) clearExcludes() {
	if len(g.excludeRules) == 0 {
		return
	}
	g.excludeLoadErr = nil
	g.setExcludeRules(nil)
}

func formatRejected(rejected []string) string {
	const maxLines = 8
	if len(rejected) <= maxLines {
		return strings.Join(rejected, "\n")
	}
	return strings.Join(rejected[:maxLines], "\n") + fmt.Sprintf("\n另外 %d 个目录未添加", len(rejected)-maxLines)
}

func sameGUIDir(left, right string) bool {
	left, right = strings.TrimSpace(left), strings.TrimSpace(right)
	if left == "" || right == "" {
		return strings.EqualFold(left, right)
	}
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return strings.EqualFold(left, right)
	}
	return strings.EqualFold(filepath.Clean(leftAbs), filepath.Clean(rightAbs))
}

func (g *guiApp) start() {
	dir := strings.TrimSpace(g.path.Text())
	if dir == "" {
		walk.MsgBox(g.mw, "Echo", "请先选择笔记目录", walk.MsgBoxIconInformation)
		return
	}
	if g.excludeLoadErr != nil && sameGUIDir(dir, g.loadedDir) {
		walk.MsgBox(g.mw, "Echo", g.excludeLoadErr.Error(), walk.MsgBoxIconError)
		return
	}
	excludes, err := app.NormalizeScanExcludes(g.excludeRules)
	if err != nil {
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconInformation)
		return
	}
	g.setExcludeRules(excludes)
	listen, err := parseGUIListen(g.host.Text(), g.port.Text())
	if err != nil {
		walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconInformation)
		return
	}
	_ = g.host.SetText(listen.Host)
	_ = g.port.SetText(listen.Port)
	if err = saveGUIListen(listen); err != nil {
		fmt.Fprintf(g.log, "未能记住监听地址: %s\n", err)
	}
	g.pageURL = listen.PageURL
	g.mu.Lock()
	if g.running || g.closed {
		g.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	g.running = true
	g.cancel = cancel
	g.done = done
	g.mu.Unlock()

	g.openBtn.SetEnabled(false)
	g.browserBtn.SetEnabled(false)
	g.showLogs()
	g.log.armReady(func() {
		g.app.Synchronize(func() {
			if g.isClosed() {
				return
			}
			g.browserBtn.SetEnabled(true)
			openBrowser(g.pageURL)
		})
	})
	go func() {
		err := runServerWithOptions(ctx, dir, true, listen.Addr, false, false, app.OpenOptions{ApplyScanExcludes: true, ScanExcludes: excludes}, g.log)
		g.mu.Lock()
		g.running = false
		closed := g.closed
		g.mu.Unlock()
		close(done)
		if closed {
			return
		}
		if err != nil {
			fmt.Fprintf(g.log, "启动失败: %s\n", err)
		}
		g.app.Synchronize(func() {
			if g.isClosed() {
				return
			}
			if err != nil {
				walk.MsgBox(g.mw, "Echo", err.Error(), walk.MsgBoxIconError)
			}
			if g.isClosed() {
				return
			}
			g.showSetup()
		})
	}()
}

func (g *guiApp) showLogs() {
	if g.isClosed() {
		return
	}
	g.setup.SetVisible(false)
	g.logs.SetVisible(true)
	g.mw.RequestLayout()
}

func (g *guiApp) showSetup() {
	if g.isClosed() {
		return
	}
	g.logs.SetVisible(false)
	g.setup.SetVisible(true)
	g.openBtn.SetEnabled(true)
	g.mw.RequestLayout()
}

func (g *guiApp) onClose(canceled *bool, _ walk.CloseReason) {
	g.log.markClosed()
	g.mu.Lock()
	g.closed = true
	running := g.running
	cancel := g.cancel
	done := g.done
	g.mu.Unlock()
	// Exit cancels walk's context, which closes the layout channel. Dispose
	// sends on that channel, so Exit has to happen after the window closes.
	if running && cancel != nil {
		g.mw.SetExitOnClose(false)
		cancel()
		go func() {
			<-done
			g.app.Exit(0)
		}()
		return
	}
	g.mw.SetExitOnClose(true)
}

func (g *guiApp) isClosed() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.closed
}

type guiLog struct {
	mu        sync.Mutex
	buf       lineBuffer
	app       *walk.Application
	view      *walk.TextEdit
	closed    bool
	scheduled bool
	pending   string
	readyFn   func()
}

func (g *guiLog) Write(p []byte) (int, error) {
	g.mu.Lock()
	text, ready := g.buf.append(string(p))
	g.pending = text
	app := g.app
	schedule := !g.scheduled && !g.closed && g.view != nil && app != nil
	if schedule {
		g.scheduled = true
	}
	readyFn := g.readyFn
	if ready {
		g.readyFn = nil
	} else {
		readyFn = nil
	}
	g.mu.Unlock()
	if schedule {
		app.Synchronize(g.flush)
	}
	if readyFn != nil {
		readyFn()
	}
	return len(p), nil
}

func (g *guiLog) bind(app *walk.Application) {
	g.mu.Lock()
	g.app = app
	g.scheduled = true
	g.mu.Unlock()
	app.Synchronize(g.flush)
}

func (g *guiLog) armReady(fn func()) {
	g.mu.Lock()
	g.readyFn = fn
	g.mu.Unlock()
}

func (g *guiLog) markClosed() {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
}

func (g *guiLog) flush() {
	g.mu.Lock()
	text := g.pending
	g.scheduled = false
	closed := g.closed
	view := g.view
	g.mu.Unlock()
	if closed || view == nil {
		return
	}
	_ = view.SetText(text)
	length := view.TextLength()
	view.SetTextSelection(length, length)
	view.ScrollToCaret()
}

func openBrowser(url string) {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return
	}
	file, err := syscall.UTF16PtrFromString(url)
	if err != nil {
		return
	}
	win.ShellExecute(0, verb, file, nil, nil, win.SW_SHOWNORMAL)
}
