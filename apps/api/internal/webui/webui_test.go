package webui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func publicFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"index.html":                        "<!doctype html><div id=\"root\"></div>",
		"assets/index-A1b2c3D4.js":          "compiled",
		"assets/index-A1b2c3D4.css":         "body{}",
		"assets/inter-latin-A1b2c3D4.woff2": "font",
		"assets/inter-A1b2c3D4.woff":        "font",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestStaticRouting(t *testing.T) {
	root := publicFixture(t)
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(418)
		_, _ = w.Write([]byte(`{"error":"api-owned"}`))
	})
	handler, err := New(root, api)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api", "/api/auth/session", "/api/unknown"} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("POST", path, nil))
		if rr.Code != 418 || rr.Body.String() != `{"error":"api-owned"}` {
			t.Errorf("API dispatch %s: %d", path, rr.Code)
		}
	}
	for _, c := range []struct{ path, mime, cache string }{
		{"/", "text/html; charset=utf-8", "no-cache"},
		{"/index.html", "text/html; charset=utf-8", "no-cache"},
		{"/assets/index-A1b2c3D4.js", "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"},
		{"/assets/index-A1b2c3D4.css", "text/css; charset=utf-8", "public, max-age=31536000, immutable"},
		{"/assets/inter-latin-A1b2c3D4.woff2", "font/woff2", "public, max-age=31536000, immutable"},
		{"/assets/inter-A1b2c3D4.woff", "font/woff", "public, max-age=31536000, immutable"},
	} {
		var get *httptest.ResponseRecorder
		for _, method := range []string{"GET", "HEAD"} {
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, httptest.NewRequest(method, c.path, nil))
			if rr.Code != 200 || rr.Header().Get("Content-Type") != c.mime || rr.Header().Get("Cache-Control") != c.cache || rr.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("%s %s headers/status: %d %v", method, c.path, rr.Code, rr.Header())
			}
			if method == "GET" {
				get = rr
				if rr.Body.Len() == 0 {
					t.Error("GET empty")
				}
			} else if rr.Body.Len() != 0 || rr.Header().Get("Content-Length") != get.Header().Get("Content-Length") {
				t.Error("HEAD parity")
			}
		}
	}
	for _, path := range []string{"/api/../index.html", "/api/%2e%2e/index.html", "/api%2fauth/session", "/api/./unknown", "/api//unknown"} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != 404 {
			t.Errorf("unsafe API path must not dispatch: %s: %d", path, rr.Code)
		}
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest("POST", "/", nil))
	if rr.Code != 405 || rr.Header().Get("Allow") != "GET, HEAD" {
		t.Error("static method policy")
	}
}

func TestStaticDenials(t *testing.T) {
	root := publicFixture(t)
	for _, name := range []string{"secret.txt", ".env", "assets/index-A1b2c3D4.js.map", "assets/source.ts", "assets/plain.js"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("not public"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	handler, err := New(root, http.NotFoundHandler())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/unknown", "/login", "/apix", "/secret.txt", "/.env", "/src/main.tsx",
		"/assets/source.ts", "/assets/plain.js", "/assets/index-A1b2c3D4.js.map",
		"/assets/stale-Z9y8x7W6.js", "/assets/../index.html", "/assets/%2e%2e/index.html",
		"/assets%2findex-A1b2c3D4.js", "/assets%5cindex-A1b2c3D4.js", "/%2e/index.html",
		"//index.html", "/assets/./index-A1b2c3D4.js",
	} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != 404 || strings.Contains(rr.Body.String(), "id=\"root\"") {
			t.Errorf("denial %s: %d", path, rr.Code)
		}
	}
}

func TestStaticStartup(t *testing.T) {
	for _, scenario := range []string{"absent", "no-index", "empty-index", "index-link", "asset-link", "directory-link", "root-link"} {
		t.Run(scenario, func(t *testing.T) {
			root := publicFixture(t)
			switch scenario {
			case "absent":
				root += "-absent"
			case "no-index":
				root = t.TempDir()
			case "empty-index":
				if err := os.WriteFile(filepath.Join(root, "index.html"), nil, 0644); err != nil {
					t.Fatal(err)
				}
			case "index-link":
				root = t.TempDir()
				if err := os.Symlink(filepath.Join(publicFixture(t), "index.html"), filepath.Join(root, "index.html")); err != nil {
					t.Fatal(err)
				}
			case "asset-link":
				if err := os.Symlink(filepath.Join(root, "index.html"), filepath.Join(root, "assets/link-A1b2c3D4.js")); err != nil {
					t.Fatal(err)
				}
			case "directory-link":
				if err := os.Symlink(t.TempDir(), filepath.Join(root, "other")); err != nil {
					t.Fatal(err)
				}
			case "root-link":
				link := filepath.Join(t.TempDir(), "public")
				if err := os.Symlink(root, link); err != nil {
					t.Fatal(err)
				}
				root = link
			}
			if _, err := New(root, http.NotFoundHandler()); err == nil {
				t.Fatal("invalid public tree accepted")
			}
		})
	}
}
