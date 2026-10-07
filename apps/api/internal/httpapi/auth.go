// Package httpapi exposes authentication and read-only inventory JSON contracts.
package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const sessionCookie = "luson_session"
const preCookie = "luson_prelogin"

type API struct {
	service *auth.Service
	cfg     config.Auth
}

// An optional store adds inventory without changing existing auth callers.
func New(service *auth.Service, cfg config.Auth, stores ...*inventory.Store) http.Handler {
	api := &API{service, cfg}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/session", api.session)
	mux.HandleFunc("/api/auth/login", api.login)
	mux.HandleFunc("/api/auth/logout", api.logout)
	var store *inventory.Store
	if len(stores) > 0 {
		store = stores[0]
	}
	api.registerInventory(mux, store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func failure(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]string{"error": code})
}
func method(w http.ResponseWriter, r *http.Request, want string) bool {
	if r.Method == want {
		return true
	}
	w.Header().Set("Allow", want)
	failure(w, 405, "method_not_allowed")
	return false
}
func (a *API) cookie(w http.ResponseWriter, name, value string, maxAge int, expires time.Time) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: a.cfg.Secure, SameSite: http.SameSiteStrictMode, MaxAge: maxAge, Expires: expires})
}

// Absence is legitimate; multiple authority cookies are never equivalent to it.
func readCookie(r *http.Request, name string) (string, bool) {
	cookies := r.CookiesNamed(name)
	if len(cookies) > 1 {
		return "", false
	}
	if len(cookies) == 0 {
		return "", true
	}
	return cookies[0].Value, true
}

// GuardMutation is reusable for future authenticated mutation routes.
// There is no forwarded-origin/IP trust and no permissive CORS configuration.
func (a *API) GuardMutation(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Origin") != a.cfg.Origin || len(r.Header.Values("Origin")) != 1 {
		failure(w, 403, "forbidden")
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		failure(w, 403, "forbidden")
		return false
	}
	token, unambiguous := readCookie(r, sessionCookie)
	if unambiguous && token == "" {
		token, unambiguous = readCookie(r, preCookie)
	}
	if !unambiguous {
		failure(w, 400, "invalid_request")
		return false
	}
	header := r.Header.Get("X-CSRF-Token")
	if len(token) != 43 || len(header) != 43 || len(r.Header.Values("X-CSRF-Token")) != 1 || subtle.ConstantTimeCompare([]byte(header), []byte(auth.CSRF(token))) != 1 {
		failure(w, 403, "forbidden")
		return false
	}
	return true
}
func (a *API) session(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, "GET") {
		return
	}
	token, unambiguous := readCookie(r, sessionCookie)
	if !unambiguous {
		failure(w, 400, "invalid_request")
		return
	}
	if token != "" {
		session, err := a.service.Current(r.Context(), token)
		if err == nil {
			respond(w, 200, map[string]any{"authenticated": true, "identity": session.Identity, "csrf_token": auth.CSRF(token), "expires_at": session.ExpiresAt})
			return
		}
		if !errors.Is(err, auth.ErrSession) {
			failure(w, 503, "service_unavailable")
			return
		}
		a.cookie(w, sessionCookie, "", -1, time.Unix(1, 0))
	}
	token, err := auth.RandomToken()
	if err != nil {
		failure(w, 503, "service_unavailable")
		return
	}
	a.cookie(w, preCookie, token, 600, time.Time{})
	respond(w, 200, map[string]any{"authenticated": false, "csrf_token": auth.CSRF(token)})
}

// Decode a small flat object explicitly to reject duplicates and unknown keys.
func credentials(r *http.Request) (string, string, error) {
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		return "", "", errors.New("invalid content type")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1025))
	if err != nil || len(body) > 1024 || !utf8.Valid(body) {
		return "", "", errors.New("invalid body")
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return "", "", errors.New("expected object")
	}
	fields := map[string]string{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return "", "", err
		}
		name, ok := key.(string)
		if !ok || (name != "username" && name != "password") {
			return "", "", errors.New("unknown field")
		}
		if _, exists := fields[name]; exists {
			return "", "", errors.New("duplicate field")
		}
		value, err := decoder.Token()
		if err != nil {
			return "", "", err
		}
		text, ok := value.(string)
		if !ok {
			return "", "", errors.New("credential must be a string")
		}
		fields[name] = text
	}
	if _, err := decoder.Token(); err != nil {
		return "", "", err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return "", "", errors.New("trailing input")
	}
	return fields["username"], fields["password"], nil
}
func (a *API) login(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, "POST") || !a.GuardMutation(w, r) {
		return
	}
	user, password, err := credentials(r)
	if err != nil {
		failure(w, 400, "invalid_request")
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(ip) == nil {
		failure(w, 400, "invalid_request")
		return
	}
	previous, _ := readCookie(r, sessionCookie) // GuardMutation established uniqueness.
	session, token, err := a.service.Login(r.Context(), user, password, ip, previous)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrCredentials):
			failure(w, 401, "invalid_credentials")
		case errors.Is(err, auth.ErrLimited):
			w.Header().Set("Retry-After", "60")
			failure(w, 429, "rate_limited")
		default:
			failure(w, 503, "service_unavailable")
		}
		return
	}
	a.cookie(w, sessionCookie, token, int(auth.AbsoluteTTL.Seconds()), session.ExpiresAt)
	a.cookie(w, preCookie, "", -1, time.Unix(1, 0))
	respond(w, 200, map[string]any{"authenticated": true, "identity": session.Identity, "csrf_token": auth.CSRF(token), "expires_at": session.ExpiresAt})
}
func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, "POST") || !a.GuardMutation(w, r) {
		return
	}
	token, _ := readCookie(r, sessionCookie) // GuardMutation established uniqueness.
	if err := a.service.Logout(r.Context(), token); err != nil {
		failure(w, 503, "service_unavailable")
		return
	}
	a.cookie(w, sessionCookie, "", -1, time.Unix(1, 0))
	a.cookie(w, preCookie, "", -1, time.Unix(1, 0))
	w.WriteHeader(204)
}
