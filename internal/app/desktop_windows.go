package app

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	seeMaskNoAsync = 0x00000100
	seeMaskNoUI    = 0x00000400
	swShowNormal   = 1
	coinitShellSTA = 0x2 | 0x4 // APARTMENTTHREADED | DISABLE_OLE1DDE
)

var (
	shell32        = syscall.NewLazyDLL("shell32.dll")
	ole32          = syscall.NewLazyDLL("ole32.dll")
	shellExecuteEx = shell32.NewProc("ShellExecuteExW")
	coInitializeEx = ole32.NewProc("CoInitializeEx")
	coUninitialize = ole32.NewProc("CoUninitialize")
)

// shellExecuteInfo matches SHELLEXECUTEINFOW on both 32-bit and 64-bit Windows.
type shellExecuteInfo struct {
	Size       uint32
	Mask       uint32
	Window     uintptr
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	Show       int32
	Instance   uintptr
	IDList     uintptr
	Class      *uint16
	ClassKey   uintptr
	HotKey     uint32
	Icon       uintptr
	Process    uintptr
}

func openShellDirectory(directory string, execute func(*shellExecuteInfo) error) error {
	file, err := syscall.UTF16PtrFromString(directory)
	if err != nil {
		return fmt.Errorf("笔记库目录无效：%w", err)
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	info := shellExecuteInfo{
		Mask: seeMaskNoAsync | seeMaskNoUI,
		Verb: verb,
		File: file,
		Show: swShowNormal,
	}
	info.Size = uint32(unsafe.Sizeof(info))
	if err := execute(&info); err != nil {
		return fmt.Errorf("无法打开文件浏览器：%w", err)
	}
	return nil
}

func pickFolderOnDesktop() (string, bool, error) {
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms",
		"$owner = New-Object System.Windows.Forms.Form",
		"$owner.TopMost = $true",
		"$owner.ShowInTaskbar = $false",
		"$owner.Opacity = 0",
		"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
		"$dialog.Description = '选择一个笔记仓库文件夹'",
		"$dialog.ShowNewFolderButton = $true",
		"$owner.Show()",
		"$owner.Activate()",
		"$result = $dialog.ShowDialog($owner)",
		"$owner.Close()",
		"if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }",
		"$bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)",
		"[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
	}, "; ")
	command := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", script)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := command.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
			return "", true, nil
		}
		return "", false, fmt.Errorf("无法打开文件夹选择器：%w", err)
	}
	folder := strings.TrimSpace(string(out))
	if folder == "" {
		return "", true, nil
	}
	return folder, false, nil
}

func openDirectoryOnDesktop(directory string) error {
	// Shell extensions can require STA COM. Keep initialization, execution and
	// cleanup on the same thread; this HTTP worker has no Windows message loop.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := coInitializeEx.Call(0, coinitShellSTA)
	if int32(result) < 0 {
		return fmt.Errorf("无法初始化 Windows Shell：HRESULT 0x%08X", uint32(result))
	}
	defer coUninitialize.Call()
	return openShellDirectory(directory, func(info *shellExecuteInfo) error {
		// NOASYNC completes the shell handoff before returning; SW_SHOWNORMAL
		// explicitly requests a visible window even when Echo starts hidden.
		ok, _, callErr := shellExecuteEx.Call(uintptr(unsafe.Pointer(info)))
		if ok == 0 {
			if callErr != syscall.Errno(0) {
				return callErr
			}
			return fmt.Errorf("Windows Shell 拒绝打开目录（代码 %d）", info.Instance)
		}
		return nil
	})
}
