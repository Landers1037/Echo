//go:build !windows

package app

import (
	"fmt"
	"os/exec"
	"runtime"
)

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
