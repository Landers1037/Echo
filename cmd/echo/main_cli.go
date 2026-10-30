//go:build !gui || !windows

package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runServer(ctx, *dataDir, explicitDataDir, *addr, *dev, true, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
