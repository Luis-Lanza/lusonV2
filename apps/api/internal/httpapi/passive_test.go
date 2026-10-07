package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/inventory"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

func passiveState(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var state string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(jsonb_build_array(account_id,last_seen_at,idle_deadline,absolute_deadline,revoked_at) ORDER BY account_id)::text FROM auth_sessions`).Scan(&state) != nil {
		t.Fatal("session timestamp snapshot failed")
	}
	return state
}
func TestR03CookieNeutralValidation(t *testing.T) {
	root := t
	t.Run("cookie_neutral_contract", func(t *testing.T) {
		env := eventFixture(t)
		f := env.f
		registerTransferAudit(root, f.p)
		rows := func() string {
			t.Helper()
			var data string
			if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(s) ORDER BY account_id,token_hash)::text FROM auth_sessions s`).Scan(&data) != nil {
				t.Fatal("complete session row snapshot failed")
			}
			return data
		}
		request := func(r *http.Request) *httptest.ResponseRecorder {
			t.Helper()
			before := rows()
			w := f.serve(t, r)
			if len(w.Header().Values("Set-Cookie")) != 0 || rows() != before {
				t.Fatal("validation wrote cookies or modified complete session rows")
			}
			return w
		}
		anonymous := func(w *httptest.ResponseRecorder) {
			t.Helper()
			if w.Code != 200 || w.Body.String() != "{\"authenticated\":false}\n" {
				t.Fatal("anonymous validation issued authority/bootstrap data")
			}
		}
		f.clock.Add(int64(2 * time.Minute))
		for actor := 1; actor <= 3; actor++ {
			for _, header := range []string{"", "1"} {
				session, _, err := f.svc.Peek(f.ctx, f.tokens[actor-1])
				if err != nil {
					t.Fatal("expected live test session unavailable")
				}
				r := f.newRequest(actor, "GET", "/api/auth/validate", "")
				if header != "" {
					r.Header.Set(passiveHeader, header)
				}
				w := request(r)
				data := transferObject(t, w, 200)
				if len(data) != 4 || string(data["authenticated"]) != "true" {
					t.Fatal("authenticated validation whitelist changed")
				}
				var identity auth.Identity
				var csrf string
				var expires time.Time
				if json.Unmarshal(data["identity"], &identity) != nil || identity != session.Identity || json.Unmarshal(data["csrf_token"], &csrf) != nil || csrf != auth.CSRF(f.tokens[actor-1]) || json.Unmarshal(data["expires_at"], &expires) != nil || !expires.Equal(session.ExpiresAt) {
					t.Fatal("validation identity/CSRF/absolute expiry changed")
				}
			}
		}
		for _, token := range []string{"", "invalid", f.tokens[1] + "="} {
			r := f.newRequest(0, "GET", "/api/auth/validate", "")
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
			anonymous(request(r))
		}
		r := f.newRequest(0, "GET", "/api/auth/validate", "")
		r.AddCookie(&http.Cookie{Name: preCookie, Value: "test-prelogin-cookie"})
		r.AddCookie(&http.Cookie{Name: preCookie, Value: "another-prelogin-cookie"})
		anonymous(request(r))
		r = f.newRequest(2, "GET", "/api/auth/validate", "")
		r.Header.Del("Origin")
		r.Header.Del("Sec-Fetch-Site")
		transferObject(t, request(r), 200)
		for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
			w := request(f.newRequest(2, verb, "/api/auth/validate", ""))
			expectTransferError(t, w, 405, "method_not_allowed")
			if w.Header().Get("Allow") != "GET" {
				t.Fatal("validation Allow changed")
			}
		}
		for _, query := range []string{"?", "?token=ignored", "?location_id=1", "?%ZZ"} {
			expectTransferError(t, request(f.newRequest(2, "GET", "/api/auth/validate"+query, "")), 400, "invalid_request")
		}
		for _, route := range []string{"/api/auth/validate/", "/api/auth/validate//", "/api/auth/validate/../session", "/api/auth/./validate", "/api//auth/validate"} {
			expectTransferError(t, request(f.newRequest(2, "GET", route, "")), 404, "not_found")
		}
		for _, route := range []string{"/api/auth/%76alidate", "/%61pi/auth/validate"} {
			expectTransferError(t, request(f.newRequest(2, "GET", route, "")), 400, "invalid_request")
		}
		for _, tc := range []struct {
			key    string
			values []string
			status int
			code   string
		}{
			{"Origin", []string{"https://evil.test"}, 403, "forbidden"}, {"Origin", []string{f.cfg.Origin, f.cfg.Origin}, 403, "forbidden"}, {"Origin", []string{""}, 403, "forbidden"},
			{"Sec-Fetch-Site", []string{"same-site"}, 403, "forbidden"}, {"Sec-Fetch-Site", []string{"cross-site"}, 403, "forbidden"}, {"Sec-Fetch-Site", []string{"same-origin", "same-origin"}, 403, "forbidden"}, {"Sec-Fetch-Site", []string{""}, 403, "forbidden"},
			{passiveHeader, []string{""}, 400, "invalid_request"}, {passiveHeader, []string{"0"}, 400, "invalid_request"}, {passiveHeader, []string{"1,1"}, 400, "invalid_request"}, {passiveHeader, []string{"1", "1"}, 400, "invalid_request"},
		} {
			for _, actor := range []int{0, 2} {
				r := f.newRequest(actor, "GET", "/api/auth/validate", "")
				r.Header.Del(tc.key)
				for _, value := range tc.values {
					r.Header.Add(tc.key, value)
				}
				expectTransferError(t, request(r), tc.status, tc.code)
			}
		}
		r = f.newRequest(2, "GET", "/api/auth/validate", "")
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
		expectTransferError(t, request(r), 400, "invalid_request")
		for _, cancelMode := range []bool{false, true} {
			ctx, stop := context.WithCancel(f.ctx)
			if cancelMode {
				stop()
				ctx, stop = context.WithDeadline(f.ctx, time.Unix(1, 0))
			}
			stop()
			r = f.newRequest(2, "GET", "/api/auth/validate", "").WithContext(ctx)
			expectTransferError(t, request(r), 503, "service_unavailable")
		}
		// Expired/revoked old-cookie probes remain anonymous and cookie-neutral.
		f.clock.Add(int64(auth.IdleTTL))
		anonymous(request(f.newRequest(2, "GET", "/api/auth/validate", "")))
		f.clock.Add(-int64(auth.IdleTTL))
		if f.svc.Logout(f.ctx, f.tokens[2]) != nil {
			t.Fatal("test validation revocation failed")
		}
		anonymous(request(f.newRequest(3, "GET", "/api/auth/validate", "")))
		newer, err := auth.RandomToken()
		if err != nil {
			t.Fatal("synthetic newer cookie generation failed")
		}
		syntheticLogin := httptest.NewRecorder()
		http.SetCookie(syntheticLogin, &http.Cookie{Name: sessionCookie, Value: newer, HttpOnly: true, SameSite: http.SameSiteStrictMode, Path: "/"})
		stale := request(f.newRequest(3, "GET", "/api/auth/validate", ""))
		anonymous(stale)
		if len(syntheticLogin.Result().Cookies()) != 1 || len(stale.Header().Values("Set-Cookie")) != 0 {
			t.Fatal("old-cookie probe can overwrite synthetic newer cookie")
		}
		r = f.newRequest(0, "GET", "/api/auth/validate", "")
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: newer})
		anonymous(request(r))
		// This is response-header mechanism evidence, not a browser ordering repro.
		original := f.handler
		closed := testpg.Open(t)
		closed.Close()
		unavailable, err := auth.New(closed, nil)
		if err != nil {
			t.Fatal("unavailable service setup failed")
		}
		f.handler, err = NewWithRealtime(unavailable, f.cfg, inventory.New(f.p), transfers.New(f.p), env.broker)
		if err != nil {
			t.Fatal("unavailable validation composition failed")
		}
		expectTransferError(t, request(f.newRequest(2, "GET", "/api/auth/validate", "")), 503, "service_unavailable")
		anonymous(request(f.newRequest(0, "GET", "/api/auth/validate", "")))
		f.handler = original
		w := httptest.NewRecorder()
		(&API{cfg: f.cfg}).validateSession(w, f.newRequest(2, "GET", "/api/auth/validate", ""))
		expectTransferError(t, w, 503, "service_unavailable")
		legacy, err := NewWithTransfers(f.svc, f.cfg, inventory.New(f.p), transfers.New(f.p))
		if err != nil {
			t.Fatal("legacy validation constructor failed")
		}
		for _, handler := range []http.Handler{New(f.svc, f.cfg), legacy} {
			for _, verb := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, f.newRequest(2, verb, "/api/auth/validate", ""))
				if w.Code != 404 || len(w.Header().Values("Set-Cookie")) != 0 {
					t.Fatal("legacy constructor registered validation route")
				}
			}
		}
	})
}

func TestR03PassiveReads(t *testing.T) {
	root := t
	t.Run("snapshots_and_reconnects_do_not_touch", func(t *testing.T) {
		f := transferFixture(t)
		registerTransferAudit(root, f.p)
		created := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", validTransferJSON), 201)
		before := passiveState(t, f)
		for cycle := 0; cycle < 3; cycle++ {
			f.clock.Add(int64(2 * time.Minute))
			for _, path := range []string{"/api/auth/session", "/api/inventory?location_id=3", "/api/inventory/metadata", "/api/transfers", "/api/transfers/" + created.ID} {
				r := f.newRequest(2, "GET", path, "")
				r.Header.Set(passiveHeader, "1")
				w := f.serve(t, r)
				if w.Code != 200 || passiveState(t, f) != before {
					t.Fatal("passive GET renewed session authority")
				}
				if path == "/api/auth/session" {
					var data struct {
						Expires time.Time `json:"expires_at"`
					}
					if json.Unmarshal(w.Body.Bytes(), &data) != nil || !data.Expires.Equal(time.Unix(0, f.clock.Load()).Add(auth.AbsoluteTTL-time.Duration((cycle+1)*2)*time.Minute)) {
						t.Fatal("passive session changed absolute expiry DTO")
					}
				}
			}
		}
		r := f.newRequest(3, "GET", "/api/transfers/"+created.ID, "")
		r.Header.Set(passiveHeader, "1")
		expectTransferError(t, f.serve(t, r), 404, "not_found")
		r = f.newRequest(3, "GET", "/api/transfers", "")
		r.Header.Set(passiveHeader, "1")
		total, records := transferWirePage(t, f.serve(t, r))
		if total != 0 || len(records) != 0 || passiveState(t, f) != before {
			t.Fatal("passive private counts/authority changed")
		}
		for _, path := range []string{"/api/auth/session", "/api/inventory?location_id=1", "/api/transfers", "/api/transfers/" + created.ID} {
			before = passiveState(t, f)
			f.clock.Add(int64(2 * time.Minute))
			if f.request(t, 2, "GET", path, "").Code != 200 || passiveState(t, f) == before {
				t.Fatal("explicit GET no longer renews Current authority")
			}
		}
	})
	t.Run("strict_early_header_and_anonymous_cookie_policy", func(t *testing.T) {
		f := transferFixture(t)
		for _, path := range []string{"/api/auth/session", "/api/inventory?location_id=1", "/api/transfers", "/api/transfers/1"} {
			for _, values := range [][]string{{""}, {"0"}, {"true"}, {"1, 1"}, {"1", "1"}, {"1", "0"}} {
				for _, actor := range []int{0, 2} {
					r := f.newRequest(actor, "GET", path, "")
					for _, v := range values {
						r.Header.Add(passiveHeader, v)
					}
					expectTransferError(t, f.serve(t, r), 400, "invalid_request")
				}
			}
		}
		for _, mode := range []bool{false, true} {
			r := f.newRequest(0, "GET", "/api/auth/session", "")
			if mode {
				r.Header.Set(passiveHeader, "1")
			}
			w := f.serve(t, r)
			data := transferObject(t, w, 200)
			if string(data["authenticated"]) != "false" || data["expires_at"] != nil || len(w.Result().Cookies()) != 1 {
				t.Fatal("anonymous restoration contract changed")
			}
			cookie := w.Result().Cookies()[0]
			if cookie.Name != preCookie || !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 600 {
				t.Fatal("prelogin cookie semantics changed")
			}
		}
	})
	t.Run("mutation_header_cannot_select_peek_or_bypass_csrf", func(t *testing.T) {
		f := transferFixture(t)
		before := passiveState(t, f)
		f.clock.Add(int64(2 * time.Minute))
		r := f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
		r.Header.Set(passiveHeader, "garbage")
		transferWireRecord(t, f.serve(t, r), 201)
		if passiveState(t, f) == before {
			t.Fatal("POST used passive validation")
		}
		r = f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
		r.Header.Set(passiveHeader, "1")
		r.Header.Del("X-CSRF-Token")
		expectTransferError(t, f.serve(t, r), 403, "forbidden")
		r = f.newRequest(1, "POST", "/api/transfers", validTransferJSON)
		r.Header.Set(passiveHeader, "1")
		expectTransferError(t, f.serve(t, r), 403, "forbidden")
		r = f.newRequest(2, "POST", "/api/auth/logout", "")
		r.Header.Set(passiveHeader, "1")
		r.Header.Del("X-CSRF-Token")
		expectTransferError(t, f.serve(t, r), 403, "forbidden")
		r = f.newRequest(0, "POST", "/api/auth/login", `{}`)
		r.Header.Set(passiveHeader, "1")
		expectTransferError(t, f.serve(t, r), 403, "forbidden")
	})
	t.Run("expired_and_revoked_restoration", func(t *testing.T) {
		f := transferFixture(t)
		before := passiveState(t, f)
		f.clock.Add(int64(auth.IdleTTL))
		r := f.newRequest(2, "GET", "/api/auth/session", "")
		r.Header.Set(passiveHeader, "1")
		w := f.serve(t, r)
		data := transferObject(t, w, 200)
		if string(data["authenticated"]) != "false" || passiveState(t, f) != before {
			t.Fatal("expired passive restoration renewed authority")
		}
		f.clock.Add(-int64(auth.IdleTTL))
		if f.svc.Logout(f.ctx, f.tokens[2]) != nil {
			t.Fatal("test passive revocation failed")
		}
		r = f.newRequest(3, "GET", "/api/auth/session", "")
		r.Header.Set(passiveHeader, "1")
		w = f.serve(t, r)
		if string(transferObject(t, w, 200)["authenticated"]) != "false" {
			t.Fatal("revoked passive restoration authenticated")
		}
	})
}
