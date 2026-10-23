package app

import (
	"errors"
	"strings"
	"syscall"
	"testing"
	"unicode/utf16"
	"unsafe"
)

func TestWindowsDirectoryOpenRequestsVisibleSynchronousShell(t *testing.T) {
	directory := `D:\中文笔记 & spaces\我的空间`
	called := false
	err := openShellDirectory(directory, func(info *shellExecuteInfo) error {
		called = true
		file := syscall.UTF16ToString(unsafe.Slice(info.File, len(utf16.Encode([]rune(directory)))+1))
		if file != directory || syscall.UTF16ToString(unsafe.Slice(info.Verb, 5)) != "open" {
			t.Fatalf("unexpected shell target: %s", file)
		}
		if info.Show != swShowNormal || info.Mask&seeMaskNoAsync == 0 || info.Mask&seeMaskNoUI == 0 {
			t.Fatalf("missing visible, synchronous shell flags: %+v", info)
		}
		if info.Parameters != nil {
			t.Fatal("directory path was passed as command-line parameters")
		}
		wantSize := uint32(60)
		if unsafe.Sizeof(uintptr(0)) == 8 {
			wantSize = 112
		}
		if info.Size != wantSize {
			t.Fatalf("SHELLEXECUTEINFO size: %d, want %d", info.Size, wantSize)
		}
		return nil
	})
	if err != nil || !called {
		t.Fatalf("shell not invoked: %v", err)
	}
}

func TestWindowsDirectoryOpenPropagatesShellFailure(t *testing.T) {
	err := openShellDirectory(`D:\Notes`, func(*shellExecuteInfo) error { return syscall.ERROR_ACCESS_DENIED })
	if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) || !strings.Contains(err.Error(), "无法打开文件浏览器") {
		t.Fatalf("shell error was lost: %v", err)
	}
	err = openShellDirectory("invalid\x00path", func(*shellExecuteInfo) error {
		t.Fatal("invalid directory reached Windows Shell")
		return nil
	})
	if err == nil {
		t.Fatal("invalid directory was accepted")
	}
}
