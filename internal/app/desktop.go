package app

import (
	"fmt"
	"os"
)

func directoryOpener(goos, directory string) (string, []string, error) {
	switch goos {
	case "darwin":
		return "open", []string{"--", directory}, nil
	case "linux":
		return "xdg-open", []string{directory}, nil
	default:
		return "", nil, fmt.Errorf("当前系统不支持自动打开文件浏览器，请手动打开：%s", directory)
	}
}

func openNotebookDirectory(directory string) error {
	info, err := os.Stat(directory)
	if err != nil {
		return fmt.Errorf("无法访问笔记库目录：%w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("笔记库路径不是文件夹：%s", directory)
	}
	return openDirectoryOnDesktop(directory)
}
