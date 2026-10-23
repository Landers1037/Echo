package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var files embed.FS

func Handler() http.Handler {
	root, _ := fs.Sub(files, "dist")
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(root, "index.html"); err != nil {
			http.Error(w, "Frontend not built. Run npm run dev, or npm run build.", http.StatusServiceUnavailable)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == ".placeholder" || strings.HasPrefix(name, ".") {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(root, name); err != nil && !strings.Contains(path.Base(name), ".") {
			r.URL.Path = "/"
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fileServer.ServeHTTP(w, r)
	})
}
