package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/testpg"
)

func TestT3PasswordLifecycle(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	creds := make([]bootstrap.Credentials, 3)
	for i := range creds {
		creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if err := bootstrap.Provision(ctx, p, creds); err != nil {
		t.Fatal(err)
	}
	// A fourth personal account shares a branch without becoming that location.
	hash, err := auth.HashPassword(creds[1].Password)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash,display_name) VALUES(2,'personal_four',$1,'Personal Four')`, hash); err != nil {
		t.Fatal(err)
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	h := httpapi.New(svc, cfg)
	session, token, err := svc.Login(ctx, "personal_four", creds[1].Password, "127.0.0.1", "")
	if err != nil {
		t.Fatal(err)
	}
	if session.Identity.AccountID != 4 || session.Identity.Location.ID != 2 {
		t.Fatal("independent identity lost")
	}
	request := func(method, path, body, media, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", media)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", auth.CSRF(token))
		r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/api/inventory", "/api/transfers", "/api/events", "/api/admin/accounts"} {
		blocked := request("GET", path, "", "", "")
		if blocked.Code != 403 || blocked.Body.String() != "{\"error\":\"password_change_required\"}\n" {
			t.Fatalf("temporary session route %s: %d", path, blocked.Code)
		}
	}
	current := request("GET", "/api/auth/session", "", "", "")
	var data struct {
		Identity struct {
			DisplayName string `json:"display_name"`
			MustChange  *bool  `json:"must_change_password"`
		}
	}
	if json.Unmarshal(current.Body.Bytes(), &data) != nil || current.Code != 200 || data.Identity.DisplayName != "Personal Four" || data.Identity.MustChange == nil || !*data.Identity.MustChange {
		t.Fatal("restricted identity contract")
	}
	operational := svc.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	r := httptest.NewRequest("GET", "/operation", nil)
	r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
	w := httptest.NewRecorder()
	operational.ServeHTTP(w, r)
	if w.Code != 403 || w.Body.String() != "password change required\n" {
		t.Fatal("mandatory password session operated")
	}
	snapshot := func() string {
		t.Helper()
		var state string
		if p.QueryRow(ctx, `SELECT json_build_array((SELECT json_agg(a ORDER BY id) FROM auth_accounts a),(SELECT json_agg(s ORDER BY token_hash) FROM auth_sessions s))::text`).Scan(&state) != nil {
			t.Fatal("snapshot failed")
		}
		return state
	}
	_, sibling, err := svc.Login(ctx, "personal_four", creds[1].Password, "127.0.0.2", "")
	if err != nil {
		t.Fatal(err)
	}
	newPassword := testpg.Random(t)
	validBody := `{"current_password":"` + creds[1].Password + `","new_password":"` + newPassword + `"}`
	for _, tc := range []struct {
		name, body, media, origin string
		status                    int
		code                      string
	}{
		{"origin first", "bad", "text/plain", "https://evil.test", 403, "forbidden"},
		{"media", validBody, "text/plain", cfg.Origin, 400, "invalid_request"},
		{"duplicate", `{"current_password":"a","current_password":"b","new_password":"c"}`, "application/json", cfg.Origin, 400, "invalid_request"},
		{"unknown", `{"current_password":"a","new_password":"b","extra":true}`, "application/json", cfg.Origin, 400, "invalid_request"},
		{"missing", `{"new_password":"abcdefghijklm"}`, "application/json", cfg.Origin, 400, "invalid_request"},
		{"utf8", string([]byte{'{', '"', 0xff, '"', ':', '1', '}'}), "application/json", cfg.Origin, 400, "invalid_request"},
		{"oversize", strings.Repeat("x", 1025), "application/json", cfg.Origin, 400, "invalid_request"},
		{"short", `{"current_password":"` + creds[1].Password + `","new_password":"short"}`, "application/json", cfg.Origin, 400, "invalid_request"},
		{"same", `{"current_password":"` + creds[1].Password + `","new_password":"` + creds[1].Password + `"}`, "application/json", cfg.Origin, 400, "invalid_request"},
		{"wrong", `{"current_password":"wrong-password","new_password":"` + newPassword + `"}`, "application/json", cfg.Origin, 401, "invalid_credentials"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := snapshot()
			w := request("POST", "/api/auth/password", tc.body, tc.media, tc.origin)
			if w.Code != tc.status || w.Body.String() != `{"error":"`+tc.code+`"}`+"\n" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("rejection: %d %s", w.Code, w.Body.String())
			}
			if snapshot() != before {
				t.Fatal("rejection mutated authority")
			}
		})
	}
	changed := request("POST", "/api/auth/password", validBody, "application/json", cfg.Origin)
	if changed.Code != 204 || changed.Body.Len() != 0 || len(changed.Result().Cookies()) != 1 || changed.Result().Cookies()[0].MaxAge != -1 {
		t.Fatalf("change contract: %d %s", changed.Code, changed.Body.String())
	}
	if _, _, err := svc.Peek(ctx, sibling); err != auth.ErrSession {
		t.Fatal("other session survived password change")
	}
	if _, err := svc.Current(ctx, token); err != auth.ErrSession {
		t.Fatal("old session survived")
	}
	if _, _, err := svc.Peek(ctx, token); err != auth.ErrSession {
		t.Fatal("old passive session survived")
	}
	var must bool
	var version int
	var stored string
	if p.QueryRow(ctx, `SELECT must_change_password,authority_version,password_hash FROM auth_accounts WHERE id=4`).Scan(&must, &version, &stored) != nil || must || version != 2 || !auth.VerifyPassword(stored, newPassword) {
		t.Fatal("password authority not committed")
	}
	ordinary, fresh, err := svc.Login(ctx, "personal_four", newPassword, "127.0.0.2", "")
	if err != nil || ordinary.Identity.AccountID != 4 || ordinary.Identity.MustChangePassword {
		t.Fatal("new login failed")
	}
	ordinarySession := request("GET", "/api/auth/session", "", "", "")
	if ordinarySession.Code != 200 || strings.Contains(ordinarySession.Body.String(), "\"identity\"") {
		t.Fatal("old HTTP authority survived")
	}
	// Reassignment alone with a version bump retires both active and passive authority.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET authority_version=authority_version+1,location_id=3 WHERE id=4`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Peek(ctx, fresh); err != auth.ErrSession {
		t.Fatal("reassignment authority survived")
	}
	_, fresh, err = svc.Login(ctx, "personal_four", newPassword, "127.0.0.2", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{`UPDATE auth_accounts SET authority_version=authority_version+1 WHERE id=4`, `UPDATE auth_accounts SET enabled=false WHERE id=4`} {
		if _, err := p.Exec(ctx, mutation); err != nil {
			t.Fatal(err)
		}
		if _, _, err := svc.Peek(ctx, fresh); err != auth.ErrSession {
			t.Fatal("passive stale authority accepted")
		}
		if _, err := svc.Current(ctx, fresh); err != auth.ErrSession {
			t.Fatal("active stale authority accepted")
		}
	}
	if _, _, err := svc.Login(ctx, "personal_four", newPassword, "127.0.0.3", ""); err != auth.ErrCredentials {
		t.Fatal("disabled login accepted")
	}
}
