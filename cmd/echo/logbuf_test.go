package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestLineBufferKeepsPartialAndDetectsReady(t *testing.T) {
	var buf lineBuffer
	text, ready := buf.append("starting")
	if ready || text != "starting" {
		t.Fatalf("partial: ready=%v text=%q", ready, text)
	}
	text, ready = buf.append("\nEcho ready at http://127.0.0.1:8080\nNotebook: notes")
	if !ready {
		t.Fatal("ready line was not detected")
	}
	if text != "starting\r\nEcho ready at http://127.0.0.1:8080\r\nNotebook: notes" {
		t.Fatalf("text = %q", text)
	}
}

func TestLineBufferDropsLinesBeyondLimit(t *testing.T) {
	var buf lineBuffer
	var b strings.Builder
	total := maxLogLines + 25
	for i := 0; i < total; i++ {
		fmt.Fprintf(&b, "line-%d\n", i)
	}
	text, ready := buf.append(b.String())
	if ready {
		t.Fatal("unexpected ready line")
	}
	lines := strings.Split(text, "\r\n")
	if len(lines) != maxLogLines {
		t.Fatalf("line count %d", len(lines))
	}
	if lines[0] != "line-25" || lines[len(lines)-1] != fmt.Sprintf("line-%d", total-1) {
		t.Fatalf("unexpected trimmed contents: %q ... %q", lines[0], lines[len(lines)-1])
	}
}
