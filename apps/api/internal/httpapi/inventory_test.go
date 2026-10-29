package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/inventory"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInventoryAnonymous(t *testing.T) {
	h := httpapi.New(nil, config.Auth{})
	for _, path := range []string{"/api/inventory", "/api/inventory/metadata"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 401 || w.Body.String() != "{\"error\":\"unauthenticated\"}\n" {
			t.Errorf("%s: status %d, want JSON 401", path, w.Code)
		}
	}
}

func TestInventoryHTTPPostgres(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("fixture initialization")
	}
	creds := make([]bootstrap.Credentials, 3)
	for i := range creds {
		creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, creds) != nil {
		t.Fatal("private test provisioning")
	}
	// Inventory contracts exercise sessions after the mandatory password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("inventory operational fixture setup")
	}
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	svc, err := auth.New(p, func() time.Time { return now })
	if err != nil {
		t.Fatal("service initialization")
	}
	cfg, err := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatal(err)
	}
	h := httpapi.New(svc, cfg, inventory.New(p))
	request := func(method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("JSON/security headers")
		}
		return w
	}
	expectError := func(w *httptest.ResponseRecorder, status int, code string) {
		t.Helper()
		if w.Code != status || w.Body.String() != fmt.Sprintf("{\"error\":\"%s\"}\n", code) || len(w.Result().Cookies()) != 0 {
			t.Fatalf("sanitized error status %d want %d", w.Code, status)
		}
	}
	tokens := make([]string, 3)
	cookies := make([]*http.Cookie, 3)
	for i, c := range creds {
		session, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil || session.Identity.Location.ID != i+1 {
			t.Fatal("assigned login")
		}
		tokens[i] = token
		cookies[i] = &http.Cookie{Name: "luson_session", Value: token}
	}
	snapshot := func() string {
		t.Helper()
		var data string
		err := p.QueryRow(ctx, `SELECT jsonb_build_array(
   (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM locations l),
   (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM catalog_entries e),
   (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog_variants v),
   (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b))::text`).Scan(&data)
		if err != nil {
			t.Fatal("read-only snapshot failed")
		}
		return data
	}
	before := snapshot()
	for i, cookie := range cookies {
		meta := request("GET", "/api/inventory/metadata", "", cookie)
		var metadata inventory.Metadata
		if json.Unmarshal(meta.Body.Bytes(), &metadata) != nil || meta.Code != 200 || len(metadata.Locations) != 3 || len(metadata.Brands) != 11 {
			t.Fatal("metadata route")
		}
		for location := 1; location <= 3; location++ {
			w := request("GET", fmt.Sprintf("/api/inventory?location_id=%d", location), `{"actor":{"location_id":3}}`, cookie)
			var page inventory.Page
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.Location != metadata.Locations[location-1] || page.Page != 1 || page.PageSize != 10 || page.TotalVariants != 190 || len(page.Items) != 10 {
				t.Fatal("nine account/location matrix")
			}
			for _, item := range page.Items {
				if item.Existing != int64((item.VariantID*7+location*11)%31) || item.Reserved != 0 || item.Available != item.Existing {
					t.Fatal("per-location stock")
				}
			}
		}
		assigned := request("GET", "/api/auth/session", "", cookie)
		var session struct {
			Authenticated bool          `json:"authenticated"`
			Identity      auth.Identity `json:"identity"`
		}
		if json.Unmarshal(assigned.Body.Bytes(), &session) != nil || !session.Authenticated || session.Identity.Location.ID != i+1 || session.Identity.Username != creds[i].Username {
			t.Fatal("consultation changed actor assignment")
		}
	}
	for _, query := range []string{
		"", "location_id=0", "location_id=4", "location_id=-1", "location_id=+1", "location_id=1.0", "location_id=1&location_id=2",
		"location_id=1&page=0", "location_id=1&page=1000001", "location_id=1&page=999999999999999999999999", "location_id=1&page=1&page=1",
		"location_id=1&page_size=11", "location_id=1&page_size=10&page_size=25", "location_id=1&polarity=l", "location_id=1&polarity=", "location_id=1&polarity=L&polarity=R",
		"location_id=1&brand=unknown", "location_id=1&brand=", "location_id=1&brand=a&brand=a", "location_id=1&search=a&search=b",
		"location_id=1&search=%FF", "location_id=1&search=%00", "location_id=1&search=%ZZ", "location_id=1&search=" + strings.Repeat("x", 129),
		"location_id=1&actor=2", "location_id=1&capacity_ah=6.5", "location_id=1&search=x;page=1", "location_id=1&%FF=a",
	} {
		expectError(request("GET", "/api/inventory?"+query, "", cookies[0]), 400, "invalid_request")
	}
	expectError(request("GET", "/api/inventory/metadata?location_id=1", "", cookies[0]), 400, "invalid_request")
	for _, path := range []string{"/api/inventory?location_id=1", "/api/inventory/metadata"} {
		for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
			w := request(verb, path, "", cookies[0])
			expectError(w, 405, "method_not_allowed")
			if w.Header().Get("Allow") != "GET" {
				t.Fatal("Allow GET missing")
			}
		}
		expectError(request("GET", path, ""), 401, "unauthenticated")
		expectError(request("GET", path, "", &http.Cookie{Name: "luson_session", Value: "invalid"}), 401, "unauthenticated")
		for _, pair := range [][]*http.Cookie{{cookies[0], cookies[0]}, {cookies[0], cookies[1]}, {cookies[1], cookies[0]}} {
			expectError(request("GET", path, "", pair...), 400, "invalid_request")
		}
	}
	if snapshot() != before {
		t.Fatal("consultation mutated catalog/balances")
	}
	if svc.Logout(ctx, tokens[0]) != nil {
		t.Fatal("test revocation")
	}
	expectError(request("GET", "/api/inventory?location_id=1", "", cookies[0]), 401, "unauthenticated")
	now = now.Add(auth.IdleTTL)
	recreated, err := auth.New(p, func() time.Time { return now })
	if err != nil {
		t.Fatal("service recreation")
	}
	h = httpapi.New(recreated, cfg, inventory.New(p))
	expectError(request("GET", "/api/inventory/metadata", "", cookies[1]), 401, "unauthenticated")
	anonymous := request("GET", "/api/auth/session", "", cookies[1])
	var public map[string]json.RawMessage
	if json.Unmarshal(anonymous.Body.Bytes(), &public) != nil || string(public["authenticated"]) != "false" || public["expires_at"] != nil {
		t.Fatal("anonymous public session changed")
	}
	now = now.Add(time.Minute)
	_, fresh, err := recreated.Login(ctx, creds[2].Username, creds[2].Password, "127.0.0.3", "")
	if err != nil {
		t.Fatal("fresh session")
	}
	cookies[2] = &http.Cookie{Name: "luson_session", Value: fresh}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	r := httptest.NewRequest("GET", "/api/inventory?location_id=1", nil).WithContext(canceled)
	r.AddCookie(cookies[2])
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	expectError(w, 503, "service_unavailable")
	// Resolve identity successfully but fail the inventory store independently.
	closed := testpg.Open(t)
	closed.Close()
	h = httpapi.New(recreated, cfg, inventory.New(closed))
	expectError(request("GET", "/api/inventory?location_id=1", "", cookies[2]), 503, "service_unavailable")
	p.Close()
	expectError(request("GET", "/api/inventory/metadata", "", cookies[2]), 503, "service_unavailable")
}
