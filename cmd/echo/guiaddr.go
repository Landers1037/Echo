package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultGUIHost = "127.0.0.1"
	defaultGUIPort = "8080"
)

type guiListen struct {
	Host    string
	Port    string
	Addr    string
	PageURL string
}

type guiSettings struct {
	Host string `json:"host"`
	Port string `json:"port"`
}

func parseGUIListen(host, port string) (guiListen, error) {
	host = strings.TrimSpace(host)
	host = strings.Trim(host, "[]")
	port = strings.TrimSpace(port)
	if host == "" {
		return guiListen{}, fmt.Errorf("请填写监听 IP 地址")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return guiListen{}, fmt.Errorf("端口必须是 1 到 65535 之间的数字")
	}
	port = strconv.Itoa(number)
	if !strings.EqualFold(host, "localhost") && net.ParseIP(host) == nil {
		return guiListen{}, fmt.Errorf("请填写有效的 IP 地址")
	}
	browseHost := browserHost(host)
	return guiListen{
		Host:    host,
		Port:    port,
		Addr:    net.JoinHostPort(host, port),
		PageURL: "http://" + net.JoinHostPort(browseHost, port),
	}, nil
}

func browserHost(host string) string {
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsUnspecified() {
		return host
	}
	if ip.To4() != nil {
		return "127.0.0.1"
	}
	return "::1"
}

func loadGUIListen() guiListen {
	fallback, _ := parseGUIListen(defaultGUIHost, defaultGUIPort)
	file, err := guiSettingsPath()
	if err != nil {
		return fallback
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return fallback
	}
	var saved guiSettings
	if err = json.Unmarshal(data, &saved); err != nil {
		return fallback
	}
	parsed, err := parseGUIListen(saved.Host, saved.Port)
	if err != nil {
		return fallback
	}
	return parsed
}

func saveGUIListen(listen guiListen) error {
	file, err := guiSettingsPath()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(guiSettings{Host: listen.Host, Port: listen.Port}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(file, data, 0600)
}

func guiSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Echo", "gui.json"), nil
}
