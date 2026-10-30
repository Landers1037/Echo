package app

import (
	"os"
	"path/filepath"
	"time"
)

func wordCount(content string) int {
	count := 0
	for _, r := range content {
		if !isCountedSpace(r) {
			count++
		}
	}
	return count
}

func isCountedSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

func cloneStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func remapCreated(in map[string]string, from, to string) map[string]string {
	if len(in) == 0 {
		return in
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[remapPrefix(key, from, to)] = value
	}
	return out
}

func (s *Store) rememberCreated(notePath string, info os.FileInfo, explicit time.Time) (string, bool) {
	notePath = filepath.ToSlash(notePath)
	if s.state.NoteCreated == nil {
		s.state.NoteCreated = map[string]string{}
	}
	if created := s.state.NoteCreated[notePath]; created != "" {
		return created, false
	}
	when := explicit
	if when.IsZero() {
		when = fileCreated(info)
	}
	if when.IsZero() && info != nil {
		when = info.ModTime()
	}
	if when.IsZero() {
		when = time.Now()
	}
	created := when.UTC().Format(time.RFC3339Nano)
	s.state.NoteCreated[notePath] = created
	return created, true
}
