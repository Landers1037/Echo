//go:build gui && windows

package main

import (
	"context"
	"fmt"
	"log"
	"os"
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
	app        *walk.Application
	mw         *walk.MainWindow
	setup      *walk.Composite
	logs       *walk.Composite
	path       *walk.LineEdit
	host       *walk.LineEdit
	port       *walk.LineEdit
	openBtn    *walk.PushButton
	browserBtn *walk.PushButton
	pageURL    string
	log        *guiLog

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
		MinSize:  Size{Width: 520, Height: 240},
		Size:     Size{Width: 640, Height: 460},
		Layout:   VBox{},
		Children: []Widget{
			Composite{
				AssignTo: &g.setup,
				Layout:   VBox{},
				Children: []Widget{
					Label{Text: "笔记目录"},
					LineEdit{AssignTo: &g.path, Text: app.LastRepository()},
					Composite{
						Layout: HBox{},
						Children: []Widget{
							Composite{
								Layout: VBox{},
								Children: []Widget{
									Label{Text: "监听 IP"},
									LineEdit{AssignTo: &g.host, Text: saved.Host},
								},
							},
							Composite{
								Layout:  VBox{},
								MinSize: Size{Width: 110},
								MaxSize: Size{Width: 140},
								Children: []Widget{
									Label{Text: "端口"},
									LineEdit{AssignTo: &g.port, Text: saved.Port, MaxLength: 5, MinSize: Size{Width: 110}},
								},
							},
						},
					},
					Composite{
						Layout: HBox{},
						Children: []Widget{
							PushButton{Text: "浏览...", OnClicked: g.browse},
							PushButton{AssignTo: &g.openBtn, Text: "打开", OnClicked: g.start},
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
	g.mw.SetExitOnClose(false)
	g.mw.ToolBar().SetVisible(false)
	g.mw.StatusBar().SetVisible(false)
	// Visible is applied before the window is shown, while IsWindowVisible is
	// still false, so the declarative flag does not clear WS_VISIBLE.
	g.logs.SetVisible(false)
	g.mw.RequestLayout()
	g.mw.Closing().Attach(g.onClose)
	g.log.bind(g.app)
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
}

func (g *guiApp) start() {
	dir := strings.TrimSpace(g.path.Text())
	if dir == "" {
		walk.MsgBox(g.mw, "Echo", "请先选择笔记目录", walk.MsgBoxIconInformation)
		return
	}
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
		err := runServer(ctx, dir, true, listen.Addr, false, false, g.log)
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
