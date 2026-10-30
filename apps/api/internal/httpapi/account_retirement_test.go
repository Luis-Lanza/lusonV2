package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/testpg"
)

// These tests deliberately use the existing admitted, isolated T5 fixture.
// Credentials stay in fixture memory; failure messages never print login bodies.
func retirementLogin(t *testing.T, f *t5Fixture, index int) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": f.creds[index].Username, "password": f.creds[index].Password})
	w := f.request(f.tokens[index], "POST", "/api/auth/login", string(body))
	if w.Code != 200 {
		t.Fatalf("fixture HTTP login: status %d", w.Code)
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "luson_session" && cookie.Value != "" {
			return cookie.Value
		}
	}
	t.Fatal("fixture HTTP login omitted session")
	return ""
}

func retirementDeniedLogin(t *testing.T, f *t5Fixture, password string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": f.creds[1].Username, "password": password})
	// A valid surviving session supplies CSRF, so this cannot pass on a guard 401.
	t5Error(t, f.request(f.tokens[0], "POST", "/api/auth/login", string(body)), 401, "invalid_credentials")
}

func retirementDetached(t *testing.T, f *t5Fixture, token string) {
	t.Helper()
	for _, passive := range []bool{false, true} {
		r := httptest.NewRequest("GET", "/api/auth/session", nil)
		r.Header.Set("Origin", "http://localhost:8080")
		r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
		if passive {
			r.Header.Set("X-Luson-Passive", "1")
		}
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		var data struct {
			Authenticated bool            `json:"authenticated"`
			Identity      json.RawMessage `json:"identity"`
			CSRF          string          `json:"csrf_token"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &data) != nil || data.Authenticated || len(data.Identity) != 0 || len(data.CSRF) != 43 {
			t.Fatal("retired session retained current/passive authority")
		}
		// Session discovery intentionally clears stale authority and issues prelogin.
		cookies := w.Result().Cookies()
		if len(cookies) != 2 || cookies[0].Name != "luson_session" || cookies[0].MaxAge != -1 || cookies[1].Name != "luson_prelogin" {
			t.Fatal("detached session cookie contract")
		}
	}
	t5Error(t, f.request(token, "GET", "/api/inventory?location_id=2", ""), 401, "unauthenticated")
}

func retirementSurvivors(t *testing.T, f *t5Fixture) {
	t.Helper()
	for _, index := range []int{0, 2} {
		w := f.request(f.tokens[index], "GET", "/api/auth/session", "")
		var data struct {
			Authenticated bool `json:"authenticated"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &data) != nil || !data.Authenticated || len(w.Result().Cookies()) != 0 {
			t.Fatal("retirement damaged unrelated authority")
		}
	}
	if w := f.request(f.tokens[2], "GET", "/api/inventory?location_id=3", ""); w.Code != 200 || len(w.Result().Cookies()) != 0 {
		t.Fatal("other operator lost inventory access")
	}
}

func TestAccountRetirementSuccess(t *testing.T) {
	f := t5Setup(t)
	before := f.accounts()
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/"+before[1].ID, ""), 204, "")
	if got := f.accounts(); !reflect.DeepEqual(got, []t5Account{before[0], before[2]}) {
		t.Fatal("directory must omit only the retired account, preserving DTOs")
	}
	retirementDetached(t, f, f.tokens[1])
	retirementDeniedLogin(t, f, f.creds[1].Password)
	retirementSurvivors(t, f)
}

func TestAccountRetirementArchivedTarget(t *testing.T) {
	f := t5Setup(t)
	// Temporary deactivation remains visible and reversible before retirement.
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"enabled":false}`), 204, "")
	if list := f.accounts(); len(list) != 3 || list[1].Enabled {
		t.Fatal("disabled account disappeared")
	}
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"enabled":true}`), 204, "")
	live := retirementLogin(t, f, 1)
	// Both logins present the already-revoked original token, not each other.
	sibling := retirementLogin(t, f, 1)
	for _, token := range []string{live, sibling} {
		w := f.request(token, "GET", "/api/auth/session", "")
		var data struct {
			Authenticated bool `json:"authenticated"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &data) != nil || !data.Authenticated {
			t.Fatal("retirement requires two initially live target sessions")
		}
	}
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	before := f.snapshot()
	next := testpg.Random(t)
	for _, tc := range []struct {
		verb, path, body string
		status           int
		code             string
	}{
		{"PATCH", "/api/admin/accounts/2", `{"enabled":true}`, 404, "not_found"},
		{"PATCH", "/api/admin/accounts/2", `{"display_name":"Renamed"}`, 404, "not_found"},
		{"PATCH", "/api/admin/accounts/2", `{"location_id":3}`, 404, "not_found"},
		{"POST", "/api/admin/accounts/2/password", `{"temporary_password":"` + next + `"}`, 404, "not_found"},
		{"DELETE", "/api/admin/accounts/2", "", 204, ""},
		{"DELETE", "/api/admin/accounts/99", "", 404, "not_found"},
	} {
		t.Run(tc.verb+tc.path+tc.code, func(t *testing.T) {
			w := f.request(f.tokens[0], tc.verb, tc.path, tc.body)
			if tc.code == "" {
				t5Exact(t, w, tc.status, "")
			} else {
				t5Error(t, w, tc.status, tc.code)
			}
			if f.snapshot() != before {
				t.Fatal("archived-target request changed public state/counters")
			}
		})
	}
	for _, token := range []string{f.tokens[1], sibling, live} {
		retirementDetached(t, f, token)
	}
	body, _ := json.Marshal(map[string]string{"current_password": f.creds[1].Password, "new_password": next})
	t5Error(t, f.request(live, "POST", "/api/auth/password", string(body)), 401, "unauthenticated")
	retirementDeniedLogin(t, f, f.creds[1].Password)
	retirementDeniedLogin(t, f, next)
	if f.snapshot() != before {
		t.Fatal("detached authority changed public state/counters")
	}
	retirementSurvivors(t, f)
}

func TestAccountRetirementGuards(t *testing.T) {
	f := t5Setup(t)
	before := f.snapshot()
	for _, tc := range []struct {
		name, token, method, origin, csrf, path string
		status                                  int
		code                                    string
	}{
		{"anonymous", "", "DELETE", "http://localhost:8080", "", "/api/admin/accounts/2", 401, "unauthenticated"},
		{"operator", f.tokens[1], "DELETE", "http://localhost:8080", auth.CSRF(f.tokens[1]), "/api/admin/accounts/2", 403, "forbidden"},
		{"authority before method", f.tokens[1], "PUT", "http://localhost:8080", auth.CSRF(f.tokens[1]), "/api/admin/accounts/2", 403, "forbidden"},
		{"origin", f.tokens[0], "DELETE", "https://evil.test", auth.CSRF(f.tokens[0]), "/api/admin/accounts/2", 403, "forbidden"},
		{"csrf", f.tokens[0], "DELETE", "http://localhost:8080", "", "/api/admin/accounts/2", 403, "forbidden"},
		{"protected warehouse", f.tokens[0], "DELETE", "http://localhost:8080", auth.CSRF(f.tokens[0]), "/api/admin/accounts/1", 403, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &t5Unread{}
			r := httptest.NewRequest(tc.method, tc.path, b)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-CSRF-Token", tc.csrf)
			if tc.token != "" {
				r.AddCookie(&http.Cookie{Name: "luson_session", Value: tc.token})
			}
			w := httptest.NewRecorder()
			f.h.ServeHTTP(w, r)
			t5Error(t, w, tc.status, tc.code)
			if b.read {
				t.Fatal("rejected retirement read body")
			}
			if f.snapshot() != before {
				t.Fatal("guard rejection changed public state/counters")
			}
		})
	}
	retirementSurvivors(t, f)
	if w := f.request(f.tokens[1], "GET", "/api/inventory?location_id=2", ""); w.Code != 200 {
		t.Fatal("rejected DELETE retired target")
	}
}
