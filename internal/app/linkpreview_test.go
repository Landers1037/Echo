package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func usePreviewClient(t *testing.T, blockPrivate bool) {
	t.Helper()
	linkPreviewClientMu.Lock()
	previous := linkPreviewClient
	linkPreviewClient = newLinkPreviewClient(blockPrivate)
	linkPreviewClientMu.Unlock()
	t.Cleanup(func() {
		linkPreviewClientMu.Lock()
		linkPreviewClient = previous
		linkPreviewClientMu.Unlock()
	})
}

func solidPNG(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestCanonicalLinkAndBlockedAddresses(t *testing.T) {
	canonical, err := canonicalLink(" HTTPS://RENJ.io:443/a#room ")
	if err != nil || canonical != "https://renj.io/a" {
		t.Fatalf("canonical %q %v", canonical, err)
	}
	canonical, err = canonicalLink("//renj.io")
	if err != nil || canonical != "https://renj.io/" {
		t.Fatalf("protocol-relative %q %v", canonical, err)
	}
	for _, raw := range []string{"javascript:alert(1)", "file:///tmp/a", "https://user:pass@renj.io", "https://renj.io/a b", ""} {
		if _, err = canonicalLink(raw); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	if !blockedIP(net.ParseIP("127.0.0.1")) || !blockedIP(net.ParseIP("10.1.2.3")) || !blockedIP(net.ParseIP("169.254.169.254")) || !blockedIP(net.ParseIP("::1")) {
		t.Fatal("private addresses should be blocked")
	}
	if blockedIP(net.ParseIP("8.8.8.8")) || blockedIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("public addresses should be allowed")
	}
}

func TestExtractPreviewReadsOpenGraph(t *testing.T) {
	title, description, image := extractPreview(`<html><head>
		<meta content="a&amp;b" property="og:image">
		<meta name="twitter:title" content="  备用  ">
		<meta property="og:title" content="卧室 &amp; 房间">
		<meta content="一间房间" name="description">
		<title>忽略</title>
	</head></html>`)
	if title != "卧室 & 房间" || description != "一间房间" || image != "a&b" {
		t.Fatalf("extracted %q %q %q", title, description, image)
	}
	title, _, image = extractPreview(`<html><head><title> 只有标题 </title></head></html>`)
	if title != "只有标题" || image != "" {
		t.Fatalf("title fallback %q %q", title, image)
	}
}

func TestLinkPreviewCachesThumbnailUntilRefresh(t *testing.T) {
	usePreviewClient(t, false)
	pagePNG := solidPNG(t, color.NRGBA{R: 180, G: 40, B: 40, A: 255})
	nextPNG := solidPNG(t, color.NRGBA{R: 40, G: 80, B: 180, A: 255})
	var mu sync.Mutex
	hits := 0
	fail := false
	imageBytes := pagePNG
	title := "卧室 &amp; 房间"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		failed := fail
		current := imageBytes
		currentTitle := title
		mu.Unlock()
		if failed {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if r.URL.Path == "/cover.png" {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(current)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><html><head><meta content="%s" property="og:title"><meta property="og:image" content="/cover.png"><title>备用</title></head></html>`, currentTitle)
	}))
	defer srv.Close()

	s := testStore(t)
	h := NewHandler(attachStore(s), false)
	page := srv.URL + "/room"
	route := "/api/link-previews?url=" + url.QueryEscape(page)
	rr := request(t, h, "GET", route, nil)
	if rr.Code != 200 {
		t.Fatalf("preview: %d %s", rr.Code, rr.Body.String())
	}
	var preview LinkPreview
	if err := json.Unmarshal(rr.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if !preview.HasImage || preview.Title != "卧室 & 房间" || preview.Site != "127.0.0.1" || preview.Image == "" {
		t.Fatalf("preview %+v", preview)
	}
	mu.Lock()
	afterFetch := hits
	mu.Unlock()
	if afterFetch != 2 {
		t.Fatalf("hits %d, want page and thumbnail", afterFetch)
	}
	img := request(t, h, "GET", preview.Image, nil)
	if img.Code != 200 || img.Header().Get("Content-Type") != "image/png" || !bytes.Equal(img.Body.Bytes(), pagePNG) {
		t.Fatalf("image %d %s %d bytes", img.Code, img.Header().Get("Content-Type"), img.Body.Len())
	}
	stored, err := os.ReadFile(filepath.Join(s.root, ".echo", "link-cache", linkCacheID(preview.URL), "image"))
	if err != nil || !bytes.Equal(stored, pagePNG) {
		t.Fatalf("thumbnail not stored locally: %v", err)
	}

	rr = request(t, h, "GET", route, nil)
	mu.Lock()
	cachedHits := hits
	mu.Unlock()
	if rr.Code != 200 || cachedHits != afterFetch {
		t.Fatalf("cached preview contacted the page again: %d hits %d body %s", rr.Code, cachedHits, rr.Body.String())
	}

	mu.Lock()
	fail = true
	mu.Unlock()
	rr = request(t, h, "POST", "/api/link-previews", map[string]string{"url": page})
	if rr.Code != 400 {
		t.Fatalf("refresh while down: %d %s", rr.Code, rr.Body.String())
	}
	img = request(t, h, "GET", preview.Image, nil)
	if img.Code != 200 || !bytes.Equal(img.Body.Bytes(), pagePNG) {
		t.Fatal("failed refresh replaced the cached thumbnail")
	}

	mu.Lock()
	fail = false
	imageBytes = nextPNG
	title = "新的房间"
	mu.Unlock()
	rr = request(t, h, "POST", "/api/link-previews", map[string]string{"url": page})
	if rr.Code != 200 {
		t.Fatalf("refresh: %d %s", rr.Code, rr.Body.String())
	}
	var refreshed LinkPreview
	if err = json.Unmarshal(rr.Body.Bytes(), &refreshed); err != nil {
		t.Fatal(err)
	}
	if refreshed.Title != "新的房间" || !refreshed.HasImage || refreshed.Image != preview.Image {
		t.Fatalf("refreshed %+v", refreshed)
	}
	img = request(t, h, "GET", refreshed.Image+"&v=2", nil)
	if img.Code != 200 || !bytes.Equal(img.Body.Bytes(), nextPNG) {
		t.Fatal("refresh did not replace the local thumbnail")
	}
}

func TestLinkPreviewWithoutThumbnailStaysCached(t *testing.T) {
	usePreviewClient(t, false)
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><title>只有标题</title></head><body>没有图片</body></html>`))
	}))
	defer srv.Close()
	s := testStore(t)
	h := NewHandler(attachStore(s), false)
	route := "/api/link-previews?url=" + url.QueryEscape(srv.URL)
	rr := request(t, h, "GET", route, nil)
	var preview LinkPreview
	if err := json.Unmarshal(rr.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || preview.HasImage || preview.Image != "" || preview.Title != "只有标题" || hits != 1 {
		t.Fatalf("preview %d %+v hits %d", rr.Code, preview, hits)
	}
	rr = request(t, h, "GET", route, nil)
	if rr.Code != 200 || hits != 1 {
		t.Fatalf("refetched a page that has no thumbnail: %d hits %d", rr.Code, hits)
	}
}

func TestLinkPreviewUsesDirectImage(t *testing.T) {
	usePreviewClient(t, false)
	pngBytes := solidPNG(t, color.NRGBA{G: 120, A: 255})
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	}))
	defer srv.Close()
	s := testStore(t)
	preview, err := s.LinkPreview(context.Background(), srv.URL+"/pic.png", false)
	if err != nil || !preview.HasImage || hits != 1 {
		t.Fatalf("%v %+v hits %d", err, preview, hits)
	}
	if _, err = s.LinkPreview(context.Background(), srv.URL+"/pic.png", false); err != nil || hits != 1 {
		t.Fatalf("image link refetched: %v hits %d", err, hits)
	}
}

func TestLinkPreviewDoesNotDialPrivateAddresses(t *testing.T) {
	usePreviewClient(t, true)
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := testStore(t)
	preview, err := s.LinkPreview(context.Background(), srv.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	if preview.HasImage || hits != 0 {
		t.Fatalf("private target fetched: %+v hits %d", preview, hits)
	}
	if _, err = s.LinkPreview(context.Background(), srv.URL, false); err != nil || hits != 0 {
		t.Fatalf("cached miss dialed again: %v hits %d", err, hits)
	}
}

func TestLinkPreviewRejectsUnsafeRedirect(t *testing.T) {
	usePreviewClient(t, false)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "file:///etc/passwd", http.StatusFound)
	}))
	defer srv.Close()
	s := testStore(t)
	preview, err := s.LinkPreview(context.Background(), srv.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	if preview.HasImage {
		t.Fatalf("followed unsafe redirect: %+v", preview)
	}
}

func TestLinkPreviewSingleflight(t *testing.T) {
	usePreviewClient(t, false)
	pngBytes := solidPNG(t, color.NRGBA{R: 1, G: 2, B: 3, A: 255})
	var mu sync.Mutex
	entered := 0
	release := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	defer finish()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cover.png" {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
			return
		}
		mu.Lock()
		entered++
		mu.Unlock()
		<-release
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><meta property="og:image" content="/cover.png"><title>一次</title></head></html>`))
	}))
	defer srv.Close()
	s := testStore(t)
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			preview, err := s.LinkPreview(context.Background(), srv.URL, false)
			if err != nil || !preview.HasImage {
				errCh <- fmt.Errorf("%v %+v", err, preview)
				return
			}
			errCh <- nil
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		count := entered
		mu.Unlock()
		if count >= 1 || time.Now().After(deadline) {
			if count != 1 {
				t.Fatalf("fetches %d", count)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(40 * time.Millisecond)
	mu.Lock()
	count := entered
	mu.Unlock()
	if count != 1 {
		t.Fatalf("duplicate fetch %d", count)
	}
	finish()
	wg.Wait()
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
}

func TestLinkPreviewRejectsUnsafeTargets(t *testing.T) {
	s := testStore(t)
	h := NewHandler(attachStore(s), false)
	rr := request(t, h, "GET", "/api/link-previews?url="+url.QueryEscape("javascript:alert(1)"), nil)
	if rr.Code != 400 {
		t.Fatalf("javascript url: %d %s", rr.Code, rr.Body.String())
	}
	rr = request(t, h, "GET", "/api/link-previews/image?id=../state.json", nil)
	if rr.Code != 400 {
		t.Fatalf("path traversal: %d %s", rr.Code, rr.Body.String())
	}
	if entries, err := os.ReadDir(filepath.Join(s.root, ".echo", "link-cache")); err == nil && len(entries) != 0 {
		t.Fatalf("unsafe request wrote a cache: %d", len(entries))
	}
}
