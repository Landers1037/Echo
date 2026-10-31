package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const linkPreviewMaxBytes = 4 << 20

type LinkPreview struct {
	URL      string `json:"url"`
	Title    string `json:"title,omitempty"`
	Site     string `json:"site,omitempty"`
	HasImage bool   `json:"hasImage"`
	Image    string `json:"image,omitempty"`
}

type linkCacheMeta struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Site        string `json:"site,omitempty"`
	ImageType   string `json:"imageType,omitempty"`
	HasImage    bool   `json:"hasImage"`
}

type linkCall struct {
	done    chan struct{}
	preview LinkPreview
	err     error
}

var (
	linkPreviewClientMu sync.Mutex
	linkPreviewClient   = newLinkPreviewClient(true)
)

func previewClient() *http.Client {
	linkPreviewClientMu.Lock()
	defer linkPreviewClientMu.Unlock()
	return linkPreviewClient
}

func newLinkPreviewClient(blockPrivate bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.MaxIdleConns = 8
	transport.IdleConnTimeout = 30 * time.Second
	if blockPrivate {
		dialer := &net.Dialer{Timeout: 8 * time.Second}
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialPublic(ctx, dialer, network, addr)
		}
	}
	return &http.Client{
		Timeout:   20 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("重定向次数过多")
			}
			if _, err := canonicalLink(req.URL.String()); err != nil {
				return err
			}
			return nil
		},
	}
}

func blockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	if ip.Equal(net.IPv4bcast) {
		return true
	}
	return false
}

func dialPublic(ctx context.Context, dialer *net.Dialer, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if ip := net.ParseIP(host); ip != nil {
		if blockedIP(ip) {
			return nil, fmt.Errorf("不允许访问该地址")
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var last error
	for _, item := range ips {
		if blockedIP(item.IP) {
			last = fmt.Errorf("不允许访问该地址")
			continue
		}
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(item.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	if last != nil {
		return nil, last
	}
	return nil, fmt.Errorf("无法访问链接")
}

func canonicalLink(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 || strings.ContainsAny(raw, " \t\r\n") {
		return "", fmt.Errorf("无效链接")
	}
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (!strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https")) {
		return "", fmt.Errorf("只能解析 http 或 https 链接")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("链接不能包含账号信息")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", fmt.Errorf("无效链接")
	}
	port := parsed.Port()
	if (parsed.Scheme == "http" && port == "80") || (parsed.Scheme == "https" && port == "443") {
		port = ""
	}
	if port == "" {
		if strings.Contains(host, ":") {
			parsed.Host = "[" + host + "]"
		} else {
			parsed.Host = host
		}
	} else {
		parsed.Host = net.JoinHostPort(host, port)
	}
	parsed.Fragment = ""
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), nil
}

func linkCacheID(canonical string) string { return revision([]byte(canonical)) }

func linkSite(canonical string) string {
	parsed, err := url.Parse(canonical)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

func validLinkID(id string) bool {
	if len(id) != 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func allowedImageType(value string) bool {
	switch value {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

// LinkPreview returns a locally cached preview. Remote pages are fetched only
// when no cache exists, or when refresh is set.
func (s *Store) LinkPreview(ctx context.Context, raw string, refresh bool) (LinkPreview, error) {
	canonical, err := canonicalLink(raw)
	if err != nil {
		return LinkPreview{}, err
	}
	if !refresh {
		if preview, ok := s.loadCachedPreview(canonical); ok {
			return preview, nil
		}
	}
	key := canonical
	if refresh {
		key += "\nrefresh"
	}
	s.linkMu.Lock()
	if s.linkFlight == nil {
		s.linkFlight = map[string]*linkCall{}
	}
	if flight, ok := s.linkFlight[key]; ok {
		s.linkMu.Unlock()
		select {
		case <-flight.done:
			return flight.preview, flight.err
		case <-ctx.Done():
			return LinkPreview{}, ctx.Err()
		}
	}
	flight := &linkCall{done: make(chan struct{})}
	s.linkFlight[key] = flight
	s.linkMu.Unlock()
	defer func() {
		close(flight.done)
		s.linkMu.Lock()
		delete(s.linkFlight, key)
		s.linkMu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	preview, err := s.fetchAndStore(ctx, canonical)
	flight.preview, flight.err = preview, err
	return preview, err
}

func (s *Store) fetchAndStore(ctx context.Context, canonical string) (LinkPreview, error) {
	id := linkCacheID(canonical)
	meta := linkCacheMeta{URL: canonical, Site: linkSite(canonical)}
	body, contentType, finalURL, truncated, err := fetchLink(ctx, canonical)
	if err != nil {
		return s.finishFetchError(canonical, meta, err)
	}
	if kind := imageTypeOf(contentType, body); kind != "" && !truncated {
		stored, err := s.saveLinkCache(meta, body, kind)
		if err != nil {
			return LinkPreview{}, err
		}
		return previewFromMeta(stored, id), nil
	}
	if looksLikeHTML(contentType, body) {
		title, description, imageRef := extractPreview(string(body))
		meta.Title = title
		meta.Description = description
		if imageRef != "" && finalURL != nil {
			if imageURL, resolveErr := resolveLinkRef(finalURL, imageRef); resolveErr == nil && imageURL != canonical {
				imgBody, imgType, _, imgTrunc, imgErr := fetchLink(ctx, imageURL)
				if errors.Is(imgErr, context.Canceled) {
					return LinkPreview{}, imgErr
				}
				if imgErr == nil && !imgTrunc {
					if kind := imageTypeOf(imgType, imgBody); kind != "" {
						stored, err := s.saveLinkCache(meta, imgBody, kind)
						if err != nil {
							return LinkPreview{}, err
						}
						return previewFromMeta(stored, id), nil
					}
				}
			}
		}
	}
	stored, err := s.saveLinkCache(meta, nil, "")
	if err != nil {
		return LinkPreview{}, err
	}
	return previewFromMeta(stored, id), nil
}

func isContextCanceled(err error) bool {
	return errors.Is(err, context.Canceled)
}

func (s *Store) finishFetchError(canonical string, meta linkCacheMeta, err error) (LinkPreview, error) {
	if isContextCanceled(err) {
		return LinkPreview{}, err
	}
	if existing, ok := s.loadCachedPreview(canonical); ok {
		return existing, fmt.Errorf("暂时无法刷新链接")
	}
	stored, saveErr := s.saveLinkCache(meta, nil, "")
	if saveErr != nil {
		return LinkPreview{}, saveErr
	}
	return previewFromMeta(stored, linkCacheID(canonical)), nil
}

func fetchLink(ctx context.Context, target string) (body []byte, contentType string, final *url.URL, truncated bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, "", nil, false, fmt.Errorf("无效链接")
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	resp, err := previewClient().Do(req)
	if err != nil {
		if isContextCanceled(err) {
			return nil, "", nil, false, context.Canceled
		}
		return nil, "", nil, false, fmt.Errorf("无法访问链接")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, "", nil, false, fmt.Errorf("无法访问链接")
	}
	data, truncated, err := readCapped(resp.Body, linkPreviewMaxBytes)
	if err != nil {
		if isContextCanceled(err) {
			return nil, "", nil, false, context.Canceled
		}
		return nil, "", nil, false, fmt.Errorf("无法访问链接")
	}
	return data, resp.Header.Get("Content-Type"), resp.Request.URL, truncated, nil
}

func readCapped(r io.Reader, max int) ([]byte, bool, error) {
	data, err := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > max {
		return data[:max], true, nil
	}
	return data, false, nil
}

func previewFromMeta(meta linkCacheMeta, id string) LinkPreview {
	preview := LinkPreview{URL: meta.URL, Title: meta.Title, Site: meta.Site, HasImage: meta.HasImage}
	if meta.HasImage {
		preview.Image = "/api/link-previews/image?id=" + id
	}
	return preview
}

func (s *Store) loadCachedPreview(canonical string) (LinkPreview, bool) {
	id := linkCacheID(canonical)
	dir, err := s.existingLinkCacheDir(id)
	if err != nil {
		return LinkPreview{}, false
	}
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return LinkPreview{}, false
	}
	var meta linkCacheMeta
	if json.Unmarshal(data, &meta) != nil || meta.URL != canonical {
		return LinkPreview{}, false
	}
	if meta.HasImage {
		info, statErr := os.Lstat(filepath.Join(dir, "image"))
		if statErr != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > linkPreviewMaxBytes || !allowedImageType(meta.ImageType) {
			return LinkPreview{}, false
		}
	}
	return previewFromMeta(meta, id), true
}

func (s *Store) saveLinkCache(meta linkCacheMeta, image []byte, imageType string) (linkCacheMeta, error) {
	dir, err := s.prepareLinkCacheDir(linkCacheID(meta.URL))
	if err != nil {
		return meta, err
	}
	imagePath := filepath.Join(dir, "image")
	if len(image) > 0 && allowedImageType(imageType) {
		meta.HasImage = true
		meta.ImageType = imageType
		if err = os.Remove(imagePath); err != nil && !os.IsNotExist(err) {
			return meta, err
		}
		if err = atomicWrite(imagePath, image, 0600); err != nil {
			return meta, err
		}
	} else {
		meta.HasImage = false
		meta.ImageType = ""
		if err = os.Remove(imagePath); err != nil && !os.IsNotExist(err) {
			return meta, err
		}
	}
	data, err := json.Marshal(meta)
	if err != nil {
		return meta, err
	}
	return meta, atomicWrite(filepath.Join(dir, "meta.json"), data, 0600)
}

func (h *handler) linkPreviews(w http.ResponseWriter, r *http.Request) error {
	s := h.ws.current()
	switch r.URL.Path {
	case "/api/link-previews/image":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
			return nil
		}
		return s.serveLinkPreviewImage(w, r)
	case "/api/link-previews":
		refresh := false
		target := r.URL.Query().Get("url")
		if r.Method == http.MethodPost {
			var body struct {
				URL string `json:"url"`
			}
			if err := decode(r, &body); err != nil {
				return err
			}
			target = body.URL
			refresh = true
		} else if r.Method != http.MethodGet && r.Method != http.MethodHead {
			jsonResponse(w, http.StatusNotFound, map[string]string{"error": "接口或请求方法不存在"})
			return nil
		}
		preview, err := s.LinkPreview(r.Context(), target, refresh)
		if err != nil {
			return err
		}
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return nil
		}
		jsonResponse(w, http.StatusOK, preview)
		return nil
	default:
		return os.ErrNotExist
	}
}

func (s *Store) serveLinkPreviewImage(w http.ResponseWriter, r *http.Request) error {
	id := r.URL.Query().Get("id")
	if !validLinkID(id) {
		return fmt.Errorf("无效的链接缩略图")
	}
	dir, err := s.existingLinkCacheDir(id)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("找不到链接缩略图: %w", os.ErrNotExist)
		}
		return err
	}
	metaBytes, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("找不到链接缩略图: %w", os.ErrNotExist)
		}
		return err
	}
	var meta linkCacheMeta
	if json.Unmarshal(metaBytes, &meta) != nil || !meta.HasImage || !allowedImageType(meta.ImageType) {
		return fmt.Errorf("找不到链接缩略图: %w", os.ErrNotExist)
	}
	file := filepath.Join(dir, "image")
	info, err := os.Lstat(file)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("找不到链接缩略图: %w", os.ErrNotExist)
		}
		return err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > linkPreviewMaxBytes {
		return fmt.Errorf("找不到链接缩略图: %w", os.ErrNotExist)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	if int64(len(data)) != info.Size() || imageTypeOf(meta.ImageType, data) != meta.ImageType {
		return fmt.Errorf("找不到链接缩略图: %w", os.ErrNotExist)
	}
	w.Header().Set("Content-Type", meta.ImageType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
	return nil
}

func (s *Store) prepareLinkCacheDir(id string) (string, error) {
	if !validLinkID(id) {
		return "", fmt.Errorf("无效的链接缓存")
	}
	echoDir := filepath.Join(s.root, ".echo")
	info, err := os.Lstat(echoDir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("链接缓存目录不可用")
	}
	base := filepath.Join(echoDir, "link-cache")
	info, err = os.Lstat(base)
	if os.IsNotExist(err) {
		if err = os.Mkdir(base, 0700); err != nil && !os.IsExist(err) {
			return "", err
		}
	} else if err != nil {
		return "", err
	} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("链接缓存目录不可用")
	}
	dir := filepath.Join(base, id)
	info, err = os.Lstat(dir)
	if os.IsNotExist(err) {
		if err = os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return "", err
		}
		return dir, nil
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("链接缓存目录不可用")
	}
	return dir, nil
}

func (s *Store) existingLinkCacheDir(id string) (string, error) {
	if !validLinkID(id) {
		return "", fmt.Errorf("无效的链接缓存")
	}
	base := filepath.Join(s.root, ".echo", "link-cache")
	info, err := os.Lstat(base)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("链接缓存目录不可用")
	}
	dir := filepath.Join(base, id)
	info, err = os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("链接缓存目录不可用")
	}
	return dir, nil
}

func resolveLinkRef(base *url.URL, ref string) (string, error) {
	ref = strings.TrimSpace(html.UnescapeString(ref))
	if ref == "" || strings.HasPrefix(strings.ToLower(ref), "data:") {
		return "", fmt.Errorf("无效的缩略图地址")
	}
	parsed, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	if base == nil {
		return canonicalLink(ref)
	}
	return canonicalLink(base.ResolveReference(parsed).String())
}

func extractPreview(page string) (title, description, image string) {
	tags := scanMeta(page)
	title = cleanPreviewText(firstText(metaContent(tags, "og:title", "twitter:title"), pageTitle(page)), 160)
	description = cleanPreviewText(metaContent(tags, "og:description", "twitter:description", "description"), 240)
	image = strings.TrimSpace(metaContent(tags, "og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"))
	return title, description, image
}

func metaContent(tags []map[string]string, keys ...string) string {
	for _, key := range keys {
		for _, tag := range tags {
			name := tag["property"]
			if name == "" {
				name = tag["name"]
			}
			if !strings.EqualFold(strings.TrimSpace(name), key) {
				continue
			}
			if content := strings.TrimSpace(tag["content"]); content != "" {
				return content
			}
		}
	}
	return ""
}

func firstText(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func scanMeta(page string) []map[string]string {
	var tags []map[string]string
	for i := 0; i < len(page); i++ {
		if page[i] != '<' || !hasPrefixFold(page[i:], "<meta") {
			continue
		}
		if i+5 < len(page) && isNameByte(page[i+5]) {
			continue
		}
		attrs, next := readAttrs(page, i+5)
		if next <= i {
			break
		}
		if len(attrs) > 0 {
			tags = append(tags, attrs)
		}
		i = next - 1
	}
	return tags
}

func pageTitle(page string) string {
	start := findFold(page, "<title", 0)
	if start < 0 || (start+6 < len(page) && isNameByte(page[start+6])) {
		return ""
	}
	open := strings.IndexByte(page[start:], '>')
	if open < 0 {
		return ""
	}
	contentStart := start + open + 1
	end := findFold(page, "</title", contentStart)
	if end < 0 {
		return ""
	}
	return stripTags(page[contentStart:end])
}

func readAttrs(page string, i int) (map[string]string, int) {
	attrs := map[string]string{}
	for i < len(page) {
		c := page[i]
		if c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '/' {
			i++
			continue
		}
		if c == '>' {
			return attrs, i + 1
		}
		nameStart := i
		for i < len(page) {
			c = page[i]
			if c == '=' || c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '>' || c == '/' {
				break
			}
			i++
		}
		name := strings.ToLower(page[nameStart:i])
		for i < len(page) && (page[i] == ' ' || page[i] == '\n' || page[i] == '\r' || page[i] == '\t') {
			i++
		}
		if i >= len(page) || page[i] != '=' {
			if name != "" {
				attrs[name] = ""
			}
			continue
		}
		i++
		for i < len(page) && (page[i] == ' ' || page[i] == '\n' || page[i] == '\r' || page[i] == '\t') {
			i++
		}
		if i >= len(page) {
			break
		}
		var value string
		if page[i] == '"' || page[i] == '\'' {
			quote := page[i]
			i++
			start := i
			for i < len(page) && page[i] != quote {
				i++
			}
			value = page[start:i]
			if i < len(page) {
				i++
			}
		} else {
			start := i
			for i < len(page) && page[i] != ' ' && page[i] != '\n' && page[i] != '\r' && page[i] != '\t' && page[i] != '>' {
				i++
			}
			value = page[start:i]
		}
		if name != "" {
			attrs[name] = html.UnescapeString(strings.TrimSpace(value))
		}
	}
	return attrs, i
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

func findFold(s, needle string, from int) int {
	if from < 0 || len(needle) == 0 || from > len(s) {
		return -1
	}
	n := len(needle)
	for i := from; i+n <= len(s); i++ {
		if strings.EqualFold(s[i:i+n], needle) {
			return i
		}
	}
	return -1
}

func isNameByte(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == ':' || c == '_'
}

func stripTags(value string) string {
	var b strings.Builder
	in := false
	for _, r := range value {
		switch {
		case r == '<':
			in = true
		case r == '>':
			in = false
		case !in:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func cleanPreviewText(value string, limit int) string {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(value) {
		if r == '\u00a0' || r == '\t' || r == '\n' || r == '\r' || r == ' ' {
			space = b.Len() > 0
			continue
		}
		if r < 32 || r == 127 {
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	text := b.String()
	runes := []rune(text)
	if limit > 0 && len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

func sniffImage(data []byte) string {
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return "image/jpeg"
	}
	if len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}) {
		return "image/png"
	}
	if len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	return ""
}

func imageTypeOf(contentType string, data []byte) string {
	sniffed := sniffImage(data)
	if sniffed == "" {
		return ""
	}
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if strings.Contains(media, "html") || strings.HasPrefix(media, "text/") || media == "application/json" || media == "application/xml" {
		return ""
	}
	return sniffed
}

func looksLikeHTML(contentType string, data []byte) bool {
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if strings.Contains(media, "html") || media == "application/xhtml+xml" {
		return true
	}
	if strings.HasPrefix(media, "image/") {
		return false
	}
	sample := data
	if len(sample) > 768 {
		sample = sample[:768]
	}
	folded := strings.ToLower(string(sample))
	return strings.Contains(folded, "<html") || strings.Contains(folded, "<meta") || strings.Contains(folded, "<title") || strings.Contains(folded, "<!doctype html")
}
