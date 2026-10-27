//go:build !windows

package app

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

func pickFolderOnDesktop() (string, bool, error) {
	switch runtime.GOOS {
	case "darwin":
		return pickDarwinFolder()
	case "linux":
		return pickLinuxFolder()
	default:
		return "", false, fmt.Errorf("当前系统不支持选择文件夹")
	}
}

func pickDarwinFolder() (string, bool, error) {
	command := exec.Command("osascript", "-e", `POSIX path of (choose folder with prompt "选择一个笔记仓库文件夹")`)
	out, err := command.CombinedOutput()
	if err != nil {
		message := string(out)
		if strings.Contains(message, "User canceled") || strings.Contains(message, "-128") {
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

func pickLinuxFolder() (string, bool, error) {
	if _, err := exec.LookPath("zenity"); err != nil {
		return "", false, fmt.Errorf("当前系统无法打开文件夹选择器，请安装 zenity")
	}
	command := exec.Command("zenity", "--file-selection", "--directory", "--title=选择一个笔记仓库文件夹")
	out, err := command.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
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
	program, args, err := directoryOpener(runtime.GOOS, directory)
	if err != nil {
		return err
	}
	command := exec.Command(program, args...)
	if err := command.Start(); err != nil {
		return fmt.Errorf("无法打开文件浏览器：%w", err)
	}
	go func() { _ = command.Wait() }()
	return nil
}
