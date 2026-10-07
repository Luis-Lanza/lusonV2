// Package webui composes immutable compiled public assets with an unchanged API.
package webui

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var assetName = regexp.MustCompile(`^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css|woff|woff2)$`)
var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2",
}

type publicFile struct {
	body               []byte
	contentType, cache string
}

// New snapshots the trusted build-only directory at startup. No request opens
// a filesystem path; subsequent symlink substitutions cannot expose data. The
// runtime image supplies a root-owned directory on a read-only filesystem.
func New(directory string, api http.Handler) (http.Handler, error) {
	refused := errors.New("invalid public asset directory")
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || api == nil {
		return nil, refused
	}
	files := make(map[string]publicFile)
	err = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.Type()&os.ModeSymlink != 0 {
			return refused
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(directory, path)
		if err != nil {
			return refused
		}
		rel = filepath.ToSlash(rel)
		isIndex := rel == "index.html"
		asset := strings.TrimPrefix(rel, "assets/")
		if !isIndex && !(strings.HasPrefix(rel, "assets/") && !strings.Contains(asset, "/") && assetName.MatchString(asset)) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 16<<20 {
			return refused
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return refused
		}
		cache := "public, max-age=31536000, immutable"
		if isIndex {
			cache = "no-cache"
		}
		files["/"+rel] = publicFile{body, contentTypes[filepath.Ext(rel)], cache}
		return nil
	})
	if err != nil || len(files["/index.html"].body) == 0 {
		return nil, refused
	}
	files["/"] = files["/index.html"]
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		escaped := strings.ToLower(r.URL.EscapedPath())
		invalid := strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") || strings.Contains(escaped, "%2e") || strings.Contains(r.URL.Path, "\\") || strings.Contains(r.URL.Path, "//")
		for _, segment := range strings.Split(r.URL.Path, "/") {
			if strings.HasPrefix(segment, ".") {
				invalid = true
			}
		}
		if invalid {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.NotFound(w, r)
			return
		}
		// Dispatch without ServeMux path cleaning or a frontend fallback. API owns
		// all ordinary statuses/methods, including unknown API routes. Unsafe raw
		// paths are denied first so the inner mux cannot redirect to index.html.
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		file, found := files[r.URL.Path]
		if !found {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", file.contentType)
		w.Header().Set("Cache-Control", file.cache)
		w.Header().Set("Content-Length", strconv.Itoa(len(file.body)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(file.body)
		}
	}), nil
}
