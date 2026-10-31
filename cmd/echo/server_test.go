package main

import "testing"

func TestListenAllowsRemote(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1", "localhost", "LOCALHOST"} {
		if listenAllowsRemote(host) {
			t.Fatalf("loopback %q should not enable remote", host)
		}
	}
	for _, host := range []string{"0.0.0.0", "::", "192.168.1.8", "10.0.0.2"} {
		if !listenAllowsRemote(host) {
			t.Fatalf("%q should enable remote", host)
		}
	}
}
