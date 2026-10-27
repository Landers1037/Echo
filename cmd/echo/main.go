package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"echo/internal/app"
)

func main() {
	dataDir := flag.String("data-dir", "notes", "Markdown notebook directory")
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	dev := flag.Bool("dev", false, "Allow the local Vite development origin")
	flag.Parse()
	explicitDataDir := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "data-dir" {
			explicitDataDir = true
		}
	})
	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatal(err)
	}
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		log.Fatal("Echo is a personal local app: --addr must use a loopback address")
	}
	workspace, err := app.OpenWorkspace(*dataDir, explicitDataDir)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go workspace.Run(ctx)
	server := &http.Server{Addr: *addr, Handler: app.NewHandler(workspace, *dev), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Printf("Echo ready at http://%s\nNotebook: %s\n", *addr, workspace.Root())
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
