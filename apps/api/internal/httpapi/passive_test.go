package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"luson/api/internal/auth"
)

func passiveState(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var state string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(jsonb_build_array(account_id,last_seen_at,idle_deadline,absolute_deadline,revoked_at) ORDER BY account_id)::text FROM auth_sessions`).Scan(&state) != nil {
		t.Fatal("session timestamp snapshot failed")
	}
	return state
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
