//go:build windows

package app

import (
	"os"
	"syscall"
	"time"
)

func fileCreated(info os.FileInfo) time.Time {
	if info == nil {
		return time.Time{}
	}
	stat, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || stat == nil {
		return info.ModTime().UTC()
	}
	created := time.Unix(0, stat.CreationTime.Nanoseconds()).UTC()
	if created.IsZero() {
		return info.ModTime().UTC()
	}
	return created
}
