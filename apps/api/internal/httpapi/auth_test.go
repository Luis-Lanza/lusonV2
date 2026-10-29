package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAuthPostgres(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('auth_accounts','auth_sessions','auth_throttle')`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("authentication migration tables = %d, want 3", n)
	}
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	service, err := auth.New(p, func() time.Time { return now })
	if err != nil {
		t.Fatal("auth service failed")
	}
	cfg, err := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.New(service, cfg)
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if err := bootstrap.Provision(ctx, p, credentials); err != nil {
		t.Fatal(err)
	}
	// This legacy suite exercises ordinary operational sessions.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal(err)
	}
	request := func(h http.Handler, method, path, body, csrf, origin string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:3210"
		req.Header.Set("X-Forwarded-For", testpg.Random(t))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	decode := func(w *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var data map[string]any
		if json.Unmarshal(w.Body.Bytes(), &data) != nil {
			t.Fatal("response not JSON")
		}
		return data
	}
	sessionCookie := func(w *httptest.ResponseRecorder) *http.Cookie {
		t.Helper()
		for _, c := range w.Result().Cookies() {
			if c.Name == "luson_session" {
				return c
			}
		}
		t.Fatal("session cookie absent")
		return nil
	}
	pre := request(handler, "GET", "/api/auth/session", "", "", "")
	if pre.Code != 200 || decode(pre)["authenticated"] != false {
		t.Fatal("anonymous session contract")
	}
	csrf := decode(pre)["csrf_token"].(string)
	preCookie := pre.Result().Cookies()[0]
	if !preCookie.HttpOnly || preCookie.Path != "/" || preCookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("prelogin CSRF cookie flags")
	}
	loginBody := func(c bootstrap.Credentials) string { b, _ := json.Marshal(c); return string(b) }
	for _, bad := range []struct {
		body, csrf, origin string
		code               int
	}{
		{loginBody(credentials[0]), csrf, "https://evil.test", 403},
		{loginBody(credentials[0]), "wrong", cfg.Origin, 403},
		{loginBody(credentials[0]), csrf, "", 403},
		{`{"username":"a","password":"b","actor":1}`, csrf, cfg.Origin, 400},
		{`{"username":"a","username":"b","password":"b"}`, csrf, cfg.Origin, 400},
		{`{"username":1,"password":"b"}`, csrf, cfg.Origin, 400},
		{`{"username":null,"password":"b"}`, csrf, cfg.Origin, 400},
		{`{} {}`, csrf, cfg.Origin, 400},
		{strings.Repeat("x", 2049), csrf, cfg.Origin, 400},
	} {
		w := request(handler, "POST", "/api/auth/login", bad.body, bad.csrf, bad.origin, preCookie)
		if w.Code != bad.code {
			t.Fatalf("validation status %d, want %d", w.Code, bad.code)
		}
	}
	wrong := credentials[0]
	wrong.Password = testpg.Random(t)
	unknown := bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	var generic []byte
	for _, c := range []bootstrap.Credentials{{}, wrong, unknown} {
		w := request(handler, "POST", "/api/auth/login", loginBody(c), csrf, cfg.Origin, preCookie)
		if w.Code != 401 {
			t.Fatal("bad credentials status")
		}
		if generic != nil && !bytes.Equal(generic, w.Body.Bytes()) {
			t.Fatal("credential existence leaked")
		}
		generic = append([]byte(nil), w.Body.Bytes()...)
	}
	now = now.Add(time.Minute)
	var first *http.Cookie
	for i, c := range credentials {
		w := request(handler, "POST", "/api/auth/login", loginBody(c), csrf, cfg.Origin, preCookie)
		if w.Code != 200 {
			t.Fatalf("assigned login status %d", w.Code)
		}
		identity := decode(w)["identity"].(map[string]any)
		location := identity["location"].(map[string]any)
		if identity["username"] != c.Username || int(location["id"].(float64)) != i+1 {
			t.Fatal("server assignment wrong")
		}
		cookie := sessionCookie(w)
		if !cookie.HttpOnly || cookie.Path != "/" || cookie.Domain != "" || cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
			t.Fatal("trial session cookie flags")
		}
		if i == 0 {
			first = cookie
		}
	}
	persisted, err := auth.New(p, func() time.Time { return now })
	if err != nil {
		t.Fatal("service recreation failed")
	}
	recreated := httpapi.New(persisted, cfg)
	productionCfg := cfg
	productionCfg.Secure = true
	securePre := request(httpapi.New(persisted, productionCfg), "GET", "/api/auth/session", "", "", "")
	if !securePre.Result().Cookies()[0].Secure {
		t.Fatal("HTTPS cookie lacks Secure")
	}
	current := request(recreated, "GET", "/api/auth/session?actor=3&location=3", "", "", "", first)
	if current.Code != 200 || decode(current)["identity"].(map[string]any)["location"].(map[string]any)["id"] != float64(1) {
		t.Fatal("persisted session or forged location contract")
	}
	protected := service.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity, ok := auth.IdentityFrom(r.Context())
		if !ok || identity.Location.ID != 1 {
			t.Error("authenticated context absent")
		}
		w.WriteHeader(204)
	}))
	if request(protected, "GET", "/later", "", "", "", first).Code != 204 {
		t.Fatal("middleware rejected valid session")
	}
	if request(protected, "GET", "/later", "", "", "", first, first).Code != 401 {
		t.Fatal("ambiguous session cookies accepted")
	}
	// Ambiguity must not become absence, even with valid anonymous CSRF.
	otherLogin := request(handler, "POST", "/api/auth/login", loginBody(credentials[1]), csrf, cfg.Origin, preCookie)
	if otherLogin.Code != 200 {
		t.Fatal("duplicate-cookie setup login failed")
	}
	other := sessionCookie(otherLogin)
	for pairIndex, pair := range [][]*http.Cookie{{first, first}, {first, other}, {other, first}} {
		for _, endpoint := range []string{"session", "login", "logout"} {
			pairName := []string{"identical", "different", "reversed"}[pairIndex]
			t.Run("ambiguous_"+pairName+"_"+endpoint, func(t *testing.T) {
				var before, after string
				// Compare all persisted authentication state, without logging secrets.
				snapshot := `SELECT json_build_array(
				 (SELECT json_agg(s ORDER BY token_hash) FROM auth_sessions s),
				 (SELECT json_agg(a ORDER BY location_id) FROM auth_accounts a),
				 (SELECT json_agg(b ORDER BY bucket) FROM auth_throttle b))::text`
				if err := p.QueryRow(ctx, snapshot).Scan(&before); err != nil {
					t.Fatal("state snapshot failed")
				}
				verb := "POST"
				if endpoint == "session" {
					verb = "GET"
				}
				w := request(handler, verb, "/api/auth/"+endpoint, loginBody(credentials[0]), csrf, cfg.Origin, preCookie, pair[0], pair[1])
				if err := p.QueryRow(ctx, snapshot).Scan(&after); err != nil {
					t.Fatal("state snapshot failed")
				}
				if before != after {
					t.Error("ambiguous request mutated persisted authentication state")
				}
				if w.Code < 400 || w.Code >= 500 {
					t.Errorf("ambiguous %s status %d, want 4xx", endpoint, w.Code)
				}
				if len(w.Result().Cookies()) != 0 {
					t.Error("ambiguous request issued or cleared cookies")
				}
			})
		}
	}
	csrfCurrent := decode(current)["csrf_token"].(string)
	renewed := request(recreated, "POST", "/api/auth/login", loginBody(credentials[0]), csrfCurrent, cfg.Origin, first)
	if renewed.Code != 200 {
		t.Fatal("renewal login failed")
	}
	replacement := sessionCookie(renewed)
	if replacement.Value == first.Value {
		t.Fatal("session fixation")
	}
	if request(protected, "GET", "/later", "", "", "", first).Code != 401 {
		t.Fatal("old session survives replacement")
	}
	for _, bad := range []struct {
		method, csrf, origin string
		code                 int
	}{{"GET", csrfCurrent, cfg.Origin, 405}, {"POST", "wrong", cfg.Origin, 403}, {"POST", csrfCurrent, "https://evil.test", 403}} {
		if request(recreated, bad.method, "/api/auth/logout", "", bad.csrf, bad.origin, replacement).Code != bad.code {
			t.Fatal("logout mutation guard")
		}
	}
	current = request(recreated, "GET", "/api/auth/session", "", "", "", replacement)
	logout := request(recreated, "POST", "/api/auth/logout", "", decode(current)["csrf_token"].(string), cfg.Origin, replacement)
	if logout.Code != 204 {
		t.Fatal("logout failed")
	}
	cleared := sessionCookie(logout)
	if cleared.MaxAge != -1 || cleared.Path != "/" || !cleared.HttpOnly || cleared.SameSite != http.SameSiteStrictMode {
		t.Fatal("logout cookie not correctly cleared")
	}
	if request(protected, "GET", "/later", "", "", "", replacement).Code != 401 {
		t.Fatal("revoked session resurrected")
	}
	if request(recreated, "POST", "/api/auth/logout", "", csrf, cfg.Origin, preCookie).Code != 204 {
		t.Fatal("legitimate already-anonymous logout rejected")
	}
	// Direct service tests exercise deterministic clocks without HTTP or sleeping.
	now = now.Add(time.Minute)
	_, token, err := service.Login(ctx, credentials[0].Username, credentials[0].Password, "192.0.2.1", "")
	if err != nil {
		t.Fatal("expiry test login failed")
	}
	fingerprint := sha256.Sum256([]byte(token))
	var before, after time.Time
	if err := p.QueryRow(ctx, "SELECT last_seen_at FROM auth_sessions WHERE token_hash=$1", fingerprint[:]).Scan(&before); err != nil {
		t.Fatal("token hash not persisted")
	}
	now = now.Add(30 * time.Second)
	if _, err := service.Current(ctx, token); err != nil {
		t.Fatal("early session read failed")
	}
	if err := p.QueryRow(ctx, "SELECT last_seen_at FROM auth_sessions WHERE token_hash=$1", fingerprint[:]).Scan(&after); err != nil || !before.Equal(after) {
		t.Fatal("activity renewed too frequently")
	}
	now = now.Add(31 * time.Second)
	if _, err := service.Current(ctx, token); err != nil {
		t.Fatal("activity renewal failed")
	}
	if err := p.QueryRow(ctx, "SELECT last_seen_at FROM auth_sessions WHERE token_hash=$1", fingerprint[:]).Scan(&after); err != nil || !after.Equal(now) {
		t.Fatal("activity not renewed")
	}
	now = now.Add(auth.IdleTTL)
	if _, err := service.Current(ctx, token); err != auth.ErrSession {
		t.Fatal("idle expiry accepted")
	}
	now = now.Add(time.Minute)
	_, token, err = service.Login(ctx, credentials[0].Username, credentials[0].Password, "192.0.2.1", "")
	if err != nil {
		t.Fatal("absolute test login failed")
	}
	for elapsed := time.Duration(0); elapsed < auth.AbsoluteTTL; elapsed += 10 * time.Minute {
		now = now.Add(10 * time.Minute)
		_, err = service.Current(ctx, token)
	}
	if err != auth.ErrSession {
		t.Fatal("absolute expiry accepted")
	}
	now = now.Add(time.Minute)
	for i := 0; i < auth.IPLimit; i++ {
		_, _, err = service.Login(ctx, unknown.Username, unknown.Password, "192.0.2.9", "")
		if err != auth.ErrCredentials {
			t.Fatal("early throttle")
		}
	}
	if _, _, err = service.Login(ctx, unknown.Username, unknown.Password, "192.0.2.9", ""); err != auth.ErrLimited {
		t.Fatal("throttle missing")
	}
	restarted, err := auth.New(p, func() time.Time { return now })
	if err != nil {
		t.Fatal("recreated service failed")
	}
	if _, _, err = restarted.Login(ctx, unknown.Username, unknown.Password, "192.0.2.9", ""); err != auth.ErrLimited {
		t.Fatal("throttle not persistent")
	}
	now = now.Add(auth.ThrottleWindow)
	if _, _, err = restarted.Login(ctx, unknown.Username, unknown.Password, "192.0.2.9", ""); err != auth.ErrCredentials {
		t.Fatal("throttle clock reset failed")
	}
	now = now.Add(time.Minute)
	for i := 0; i < auth.IPLimit; i++ {
		if request(handler, "POST", "/api/auth/login", loginBody(wrong), csrf, cfg.Origin, preCookie).Code != 401 {
			t.Fatal("forwarded-IP throttle early")
		}
	}
	if request(handler, "POST", "/api/auth/login", loginBody(wrong), csrf, cfg.Origin, preCookie).Code != 429 {
		t.Fatal("untrusted forwarded IP bypassed throttle")
	}
	now = now.Add(time.Minute)
	_, token, err = service.Login(ctx, credentials[0].Username, credentials[0].Password, "192.0.2.25", "")
	if err != nil {
		t.Fatal("revocation race setup failed")
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := service.Current(ctx, token)
			if err != nil && err != auth.ErrSession {
				t.Error("concurrent touch failed")
			}
		}()
	}
	if err := service.Logout(ctx, token); err != nil {
		t.Fatal("concurrent logout failed")
	}
	wg.Wait()
	if _, err := service.Current(ctx, token); err != auth.ErrSession {
		t.Fatal("concurrent touch resurrected session")
	}
	var raw int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name='auth_sessions' AND column_name IN ('token','csrf_token')`).Scan(&raw); err != nil || raw != 0 {
		t.Fatal("raw session secrets persisted")
	}
}

func TestAuthIndependentThrottleDimensions(t *testing.T) {
	// Choose deterministic distinct buckets, not probabilistic random noncollisions.
	distinct := func(prefix string, count int) []string {
		seen := map[uint32]bool{}
		values := []string{}
		for i := 0; len(values) < count; i++ {
			value := fmt.Sprintf("%s%d", prefix, i)
			sum := sha256.Sum256([]byte(value))
			bucket := binary.BigEndian.Uint32(sum[:4]) % 4096
			if !seen[bucket] {
				seen[bucket] = true
				values = append(values, value)
			}
		}
		return values
	}
	users := distinct("unknown-user-", auth.GlobalLimit+2)
	ips := distinct("192.0.2.", auth.GlobalLimit+2)
	for _, dimension := range []string{"ip", "user", "global"} {
		t.Run(dimension, func(t *testing.T) {
			p := testpg.Open(t)
			ctx := context.Background()
			if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
				t.Fatal("fixture initialization failed")
			}
			now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
			s, err := auth.New(p, func() time.Time { return now })
			if err != nil {
				t.Fatal("service creation failed")
			}
			limit := auth.GlobalLimit
			if dimension == "ip" {
				limit = auth.IPLimit
			} else if dimension == "user" {
				limit = auth.UserLimit
			}
			attempt := func(i int) error {
				user, ip := users[i], ips[i]
				if dimension == "ip" {
					ip = ips[0]
				} else if dimension == "user" {
					user = users[0]
				}
				_, _, err := s.Login(ctx, user, "invalid bounded credential", ip, "")
				return err
			}
			for i := 0; i < limit; i++ {
				if attempt(i) != auth.ErrCredentials {
					t.Fatalf("attempt %d limited before independent %s budget", i+1, dimension)
				}
			}
			if attempt(limit) != auth.ErrLimited {
				t.Fatal("independent budget not enforced")
			}
			if dimension != "global" {
				if _, _, err := s.Login(ctx, users[limit+1], "invalid bounded credential", ips[limit+1], ""); err != auth.ErrCredentials {
					t.Fatal("unexhausted dimensions incorrectly blocked")
				}
			}
			now = now.Add(auth.ThrottleWindow)
			if attempt(limit) != auth.ErrCredentials {
				t.Fatal("independent budget did not reset at deadline")
			}
		})
	}
}

func TestAuthExpiredSessionAfterRestart(t *testing.T) {
	for _, deadline := range []time.Duration{auth.IdleTTL, auth.AbsoluteTTL} {
		t.Run(deadline.String(), func(t *testing.T) {
			p := testpg.Open(t)
			ctx := context.Background()
			if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
				t.Fatal("fixture initialization failed")
			}
			creds := make([]bootstrap.Credentials, 3)
			for i := range creds {
				creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
			}
			if err := bootstrap.Provision(ctx, p, creds); err != nil {
				t.Fatal("fixture provisioning failed")
			}
			now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
			s, err := auth.New(p, func() time.Time { return now })
			if err != nil {
				t.Fatal("service creation failed")
			}
			_, token, err := s.Login(ctx, creds[0].Username, creds[0].Password, "192.0.2.1", "")
			if err != nil {
				t.Fatal("expiry setup failed")
			}
			// Keep idle expiry out of the absolute-deadline case.
			if deadline == auth.AbsoluteTTL {
				for elapsed := 10 * time.Minute; elapsed < deadline; elapsed += 10 * time.Minute {
					now = now.Add(10 * time.Minute)
					if _, err := s.Current(ctx, token); err != nil {
						t.Fatal("live session expired prematurely")
					}
				}
				now = now.Add(10 * time.Minute)
			} else {
				now = now.Add(deadline)
			}
			fresh, err := auth.New(p, func() time.Time { return now })
			if err != nil {
				t.Fatal("fresh service creation failed")
			}
			cfg, _ := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
			h := httpapi.New(fresh, cfg)
			var before, after string
			snapshot := `SELECT json_agg(s ORDER BY token_hash)::text FROM auth_sessions s`
			if err := p.QueryRow(ctx, snapshot).Scan(&before); err != nil {
				t.Fatal("expiry snapshot failed")
			}
			r := httptest.NewRequest("GET", "/api/auth/session", nil)
			r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			var body map[string]any
			if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != 200 || body["authenticated"] != false || body["identity"] != nil {
				t.Fatal("expired persisted session recovered identity after restart")
			}
			if _, err := fresh.Current(ctx, token); err != auth.ErrSession {
				t.Fatal("expired persisted session renewed after restart")
			}
			if err := p.QueryRow(ctx, snapshot).Scan(&after); err != nil || before != after {
				t.Fatal("expired persisted session state changed")
			}
		})
	}
}
