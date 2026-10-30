package main

import "strings"

const maxLogLines = 1000

const readyLinePrefix = "Echo ready at "

// lineBuffer keeps the most recent log lines for the GUI log page.
type lineBuffer struct {
	lines   []string
	partial string
}

// append accepts a chunk that may contain partial lines. text is the current
// display contents, and ready is true when this chunk completed the server
// ready line.
func (b *lineBuffer) append(chunk string) (text string, ready bool) {
	b.partial += chunk
	for {
		newline := strings.IndexByte(b.partial, '\n')
		if newline < 0 {
			break
		}
		line := strings.TrimRight(b.partial[:newline], "\r")
		b.partial = b.partial[newline+1:]
		if strings.HasPrefix(line, readyLinePrefix) {
			ready = true
		}
		b.lines = append(b.lines, line)
	}
	if len(b.lines) > maxLogLines {
		b.lines = b.lines[len(b.lines)-maxLogLines:]
	}
	text = strings.Join(b.lines, "\r\n")
	if b.partial != "" {
		if text != "" {
			text += "\r\n"
		}
		text += b.partial
	}
	return text, ready
}
