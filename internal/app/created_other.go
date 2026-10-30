//go:build !windows

package app

import (
	"os"
	"time"
)

func fileCreated(info os.FileInfo) time.Time {
	if info == nil {
		return time.Time{}
	}
	return info.ModTime().UTC()
}
