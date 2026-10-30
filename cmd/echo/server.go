package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"echo/internal/app"
)

func runServer(ctx context.Context, dataDir string, explicit bool, addr string, dev bool, loopbackOnly bool, out io.Writer) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if loopbackOnly && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("Echo is a personal local app: --addr must use a loopback address")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	workspace, err := app.OpenWorkspace(dataDir, explicit)
	if err != nil {
		_ = listener.Close()
		return err
	}
	go workspace.Run(ctx)
	server := &http.Server{
		Handler:           app.NewHandler(workspace, dev),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	if err = ctx.Err(); err != nil {
		_ = listener.Close()
		return nil
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Fprintf(out, "Echo ready at http://%s\nNotebook: %s\n", addr, workspace.Root())
	err = server.Serve(listener)
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
