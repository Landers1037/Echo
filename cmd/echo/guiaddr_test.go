package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseGUIListen(t *testing.T) {
	parsed, err := parseGUIListen(" 127.0.0.1 ", "080")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "127.0.0.1" || parsed.Port != "80" || parsed.Addr != "127.0.0.1:80" || parsed.PageURL != "http://127.0.0.1:80" {
		t.Fatalf("%+v", parsed)
	}
	parsed, err = parseGUIListen("::1", "8080")
	if err != nil || parsed.Addr != "[::1]:8080" || parsed.PageURL != "http://[::1]:8080" {
		t.Fatalf("%+v %v", parsed, err)
	}
	parsed, err = parseGUIListen("0.0.0.0", "8080")
	if err != nil || parsed.Addr != "0.0.0.0:8080" || parsed.PageURL != "http://127.0.0.1:8080" {
		t.Fatalf("%+v %v", parsed, err)
	}
	parsed, err = parseGUIListen("::", "9090")
	if err != nil || parsed.Addr != "[::]:9090" || parsed.PageURL != "http://[::1]:9090" {
		t.Fatalf("%+v %v", parsed, err)
	}
	parsed, err = parseGUIListen("192.168.1.8", "9000")
	if err != nil || parsed.PageURL != "http://192.168.1.8:9000" {
		t.Fatalf("%+v %v", parsed, err)
	}
	parsed, err = parseGUIListen("localhost", "8080")
	if err != nil || parsed.Addr != "localhost:8080" {
		t.Fatalf("%+v %v", parsed, err)
	}
	if _, err = parseGUIListen("", "8080"); err == nil {
		t.Fatal("empty host accepted")
	}
	if _, err = parseGUIListen("example.com", "8080"); err == nil {
		t.Fatal("hostname accepted")
	}
	if _, err = parseGUIListen("127.0.0.1", "0"); err == nil {
		t.Fatal("port 0 accepted")
	}
	if _, err = parseGUIListen("127.0.0.1", "65536"); err == nil {
		t.Fatal("port 65536 accepted")
	}
}

func TestGUIListenRemembersHostAndPort(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("AppData", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	first := loadGUIListen()
	if first.Host != defaultGUIHost || first.Port != defaultGUIPort {
		t.Fatalf("default %+v", first)
	}
	chosen, err := parseGUIListen("192.168.1.8", "9000")
	if err != nil {
		t.Fatal(err)
	}
	if err = saveGUIListen(chosen); err != nil {
		t.Fatal(err)
	}
	loaded := loadGUIListen()
	if loaded.Host != "192.168.1.8" || loaded.Port != "9000" || loaded.PageURL != chosen.PageURL {
		t.Fatalf("loaded %+v", loaded)
	}
	if _, err = os.Stat(filepath.Join(dir, "Echo", "gui.json")); err != nil {
		t.Fatal(err)
	}
}
