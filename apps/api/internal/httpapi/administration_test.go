package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"luson/api/internal/realtime"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/inventory"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

type t5Fixture struct {
	t      *testing.T
	ctx    context.Context
	p      *pgxpool.Pool
	svc    *auth.Service
	h      http.Handler
	tokens [3]string
	creds  []bootstrap.Credentials
}

func t5Setup(t *testing.T) *t5Fixture {
	t.Helper()
	f := &t5Fixture{t: t, ctx: context.Background(), p: testpg.Open(t)}
	if err := bootstrap.Initialize(f.ctx, f.p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		f.creds = append(f.creds, bootstrap.Credentials{Username: fmt.Sprintf("operator_%d", i), Password: testpg.Random(t)})
	}
	if err := bootstrap.Provision(f.ctx, f.p, f.creds); err != nil {
		t.Fatal(err)
	}
	// Isolated fixture starts with completed initial password changes.
	if _, err := f.p.Exec(f.ctx, `UPDATE auth_accounts SET must_change_password=false,display_name='Persona'`); err != nil {
		t.Fatal(err)
	}
	var err error
	f.svc, err = auth.New(f.p, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range f.creds {
		_, f.tokens[i], err = f.svc.Login(f.ctx, c.Username, c.Password, fmt.Sprintf("192.0.2.%d", i+1), "")
		if err != nil {
			t.Fatal(err)
		}
	}
	cfg, _ := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	f.h, err = httpapi.NewWithTransfers(f.svc, cfg, inventory.New(f.p), transfers.New(f.p))
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *t5Fixture) request(token, verb, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(verb, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost:8080")
	if token != "" {
		r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
		r.Header.Set("X-CSRF-Token", auth.CSRF(token))
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}
func t5Exact(t *testing.T, w *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if w.Code != status || w.Body.String() != body || len(w.Result().Cookies()) != 0 {
		t.Fatalf("got %d %q cookies=%d; want %d %q", w.Code, w.Body.String(), len(w.Result().Cookies()), status, body)
	}
}
func t5Error(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	t5Exact(t, w, status, `{"error":"`+code+`"}`+"\n")
}
func (f *t5Fixture) snapshot() string {
	f.t.Helper()
	var out string
	for _, p := range []string{"/api/admin/accounts", "/api/admin/branches", "/api/inventory/metadata", "/api/inventory?location_id=1&page_size=50", "/api/transfers/counts"} {
		w := f.request(f.tokens[0], "GET", p, "")
		if w.Code != 200 && !(strings.HasPrefix(p, "/api/admin/") && w.Code == 404) {
			f.t.Fatalf("snapshot %s: %d %s", p, w.Code, w.Body.String())
		}
		out += w.Body.String()
	}
	return out
}

type t5Account struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	LocationID  int    `json:"location_id"`
	Enabled     bool   `json:"enabled"`
	MustChange  bool   `json:"must_change_password"`
}

func (f *t5Fixture) accounts() []t5Account {
	f.t.Helper()
	w := f.request(f.tokens[0], "GET", "/api/admin/accounts", "")
	if w.Code != 200 || len(w.Result().Cookies()) != 0 {
		f.t.Fatalf("directory: %d %s", w.Code, w.Body.String())
	}
	var list []t5Account
	if json.Unmarshal(w.Body.Bytes(), &list) != nil {
		f.t.Fatal("directory JSON")
	}
	return list
}
func (f *t5Fixture) create(user string, location int, password string) t5Account {
	f.t.Helper()
	body, _ := json.Marshal(map[string]any{"username": user, "display_name": "Operador personal", "location_id": location, "temporary_password": password})
	w := f.request(f.tokens[0], "POST", "/api/admin/accounts", string(body))
	var a t5Account
	if w.Code != 201 || len(w.Result().Cookies()) != 0 || json.Unmarshal(w.Body.Bytes(), &a) != nil || strings.Contains(w.Body.String(), password) || strings.Contains(w.Body.String(), "hash") {
		f.t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	return a
}
func TestT5Directory(t *testing.T) {
	f := t5Setup(t)
	t5Exact(t, f.request(f.tokens[0], "GET", "/api/admin/accounts", ""), 200, "[{\"id\":\"1\",\"username\":\"operator_0\",\"display_name\":\"Persona\",\"location_id\":1,\"enabled\":true,\"must_change_password\":false},{\"id\":\"2\",\"username\":\"operator_1\",\"display_name\":\"Persona\",\"location_id\":2,\"enabled\":true,\"must_change_password\":false},{\"id\":\"3\",\"username\":\"operator_2\",\"display_name\":\"Persona\",\"location_id\":3,\"enabled\":true,\"must_change_password\":false}]\n")
	t5Exact(t, f.request(f.tokens[0], "GET", "/api/admin/branches", ""), 200, "[{\"id\":1,\"name\":\"Almacén\"},{\"id\":2,\"name\":\"Sucursal A\"},{\"id\":3,\"name\":\"Sucursal B\"}]\n")
	// Existing session identity and branch-scoped inventory remain available.
	if w := f.request(f.tokens[1], "GET", "/api/auth/session", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"account_id":2`) {
		t.Fatal("session preservation")
	}
	if w := f.request(f.tokens[1], "GET", "/api/inventory?location_id=2", ""); w.Code != 200 {
		t.Fatalf("existing branch inventory: %d %s", w.Code, w.Body.String())
	}
}

type t5Unread struct{ read bool }

func (b *t5Unread) Read([]byte) (int, error) { b.read = true; return 0, io.ErrUnexpectedEOF }
func (*t5Unread) Close() error               { return nil }
func TestT5AuthorityBeforeBody(t *testing.T) {
	f := t5Setup(t)
	for _, tc := range []struct {
		name, token string
		status      int
		code        string
	}{
		{"anonymous", "", 401, "unauthenticated"}, {"operator", f.tokens[1], 403, "forbidden"}, {"invalid", strings.Repeat("a", 43), 401, "unauthenticated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, path := range []string{"/api/admin/accounts", "/api/admin/branches", "/api/admin/accounts/2", "/api/admin/accounts/2/password"} {
				b := &t5Unread{}
				r := httptest.NewRequest("POST", path, b)
				r.Header.Set("Origin", "http://localhost:8080")
				if tc.token != "" {
					r.AddCookie(&http.Cookie{Name: "luson_session", Value: tc.token})
					r.Header.Set("X-CSRF-Token", auth.CSRF(tc.token))
				}
				w := httptest.NewRecorder()
				f.h.ServeHTTP(w, r)
				t5Error(t, w, tc.status, tc.code)
				if b.read {
					t.Fatal("unauthorized body read")
				}
			}
		})
	}
	if _, err := f.p.Exec(f.ctx, `UPDATE auth_accounts SET must_change_password=true WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	b := &t5Unread{}
	r := httptest.NewRequest("POST", "/api/admin/accounts", b)
	r.AddCookie(&http.Cookie{Name: "luson_session", Value: f.tokens[0]})
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	t5Error(t, w, 403, "password_change_required")
	if b.read {
		t.Fatal("temporary body read")
	}
}
func TestT5CreateTemporaryOperator(t *testing.T) {
	f := t5Setup(t)
	password := "  private-password-ñ  "
	a := f.create("new_person", 2, password)
	if a.ID != "4" || a.LocationID != 2 || !a.Enabled || !a.MustChange {
		t.Fatalf("independent account: %+v", a)
	}
	session, token, err := f.svc.Login(f.ctx, "new_person", password, "192.0.2.10", "")
	if err != nil || session.Identity.AccountID != 4 || session.Identity.Location.ID != 2 || !session.Identity.MustChangePassword {
		t.Fatal("temporary login", err)
	}
	t5Error(t, f.request(token, "GET", "/api/inventory", ""), 403, "password_change_required")
	next := testpg.Random(t)
	body, _ := json.Marshal(map[string]string{"current_password": password, "new_password": next})
	w := f.request(token, "POST", "/api/auth/password", string(body))
	if w.Code != 204 || w.Body.Len() != 0 || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("own password contract")
	}
	session, token, err = f.svc.Login(f.ctx, "new_person", next, "192.0.2.11", "")
	if err != nil || session.Identity.MustChangePassword {
		t.Fatal("completed login", err)
	}
	if w := f.request(token, "GET", "/api/inventory?location_id=2", ""); w.Code != 200 {
		t.Fatalf("operator stock: %d", w.Code)
	}
	t5Error(t, f.request(token, "GET", "/api/admin/accounts", ""), 403, "forbidden")
}
func TestT5ProfileAndLifecycle(t *testing.T) {
	f := t5Setup(t)
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"display_name":"Nombre nuevo"}`), 204, "")
	if s, _, err := f.svc.Peek(f.ctx, f.tokens[1]); err != nil || s.Identity.DisplayName != "Nombre nuevo" {
		t.Fatal("profile retired authority", err)
	}
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":2,"enabled":true}`), 204, "")
	if _, _, err := f.svc.Peek(f.ctx, f.tokens[1]); err != nil {
		t.Fatal("no-op retired authority")
	}
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":3}`), 204, "")
	if _, _, err := f.svc.Peek(f.ctx, f.tokens[1]); err != auth.ErrSession {
		t.Fatal("reassignment retained session")
	}
	s, token, err := f.svc.Login(f.ctx, f.creds[1].Username, f.creds[1].Password, "192.0.2.12", "")
	if err != nil || s.Identity.Location.ID != 3 {
		t.Fatal("reassigned login")
	}
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"enabled":false}`), 204, "")
	if _, _, err = f.svc.Peek(f.ctx, token); err != auth.ErrSession {
		t.Fatal("deactivation retained session")
	}
	if _, _, err = f.svc.Login(f.ctx, f.creds[1].Username, f.creds[1].Password, "192.0.2.13", ""); err != auth.ErrCredentials {
		t.Fatal("disabled login")
	}
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"enabled":true}`), 204, "")
	if _, _, err = f.svc.Peek(f.ctx, token); err != auth.ErrSession {
		t.Fatal("reactivation restored session")
	}
	if _, _, err = f.svc.Login(f.ctx, f.creds[1].Username, f.creds[1].Password, "192.0.2.14", ""); err != nil {
		t.Fatal("reactivated login", err)
	}
}
func TestT5Reset(t *testing.T) {
	f := t5Setup(t)
	_, sibling, err := f.svc.Login(f.ctx, f.creds[1].Username, f.creds[1].Password, "192.0.2.21", "")
	if err != nil {
		t.Fatal(err)
	}
	next := testpg.Random(t)
	t5Exact(t, f.request(f.tokens[0], "POST", "/api/admin/accounts/2/password", `{"temporary_password":"`+next+`"}`), 204, "")
	for _, old := range []string{f.tokens[1], sibling} {
		if _, _, err := f.svc.Peek(f.ctx, old); err != auth.ErrSession {
			t.Fatal("reset retained session")
		}
	}
	if _, _, err := f.svc.Login(f.ctx, f.creds[1].Username, f.creds[1].Password, "192.0.2.15", ""); err != auth.ErrCredentials {
		t.Fatal("old password accepted")
	}
	s, token, err := f.svc.Login(f.ctx, f.creds[1].Username, next, "192.0.2.16", "")
	if err != nil || !s.Identity.MustChangePassword {
		t.Fatal("reset not temporary", err)
	}
	t5Error(t, f.request(token, "GET", "/api/transfers/counts", ""), 403, "password_change_required")
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"enabled":false}`), 204, "")
	second := testpg.Random(t)
	t5Exact(t, f.request(f.tokens[0], "POST", "/api/admin/accounts/2/password", `{"temporary_password":"`+second+`"}`), 204, "")
	list := f.accounts()
	if list[1].Enabled || !list[1].MustChange {
		t.Fatal("reset reactivated disabled account")
	}
	if _, _, err = f.svc.Login(f.ctx, f.creds[1].Username, second, "192.0.2.17", ""); err != auth.ErrCredentials {
		t.Fatal("disabled reset login")
	}
}
func TestT5ProtectedAndStrictPayloads(t *testing.T) {
	f := t5Setup(t)
	before := f.snapshot()
	for _, tc := range []struct {
		verb, path, body string
		status           int
		code             string
	}{
		{"PATCH", "/api/admin/accounts/1", `{"enabled":false}`, 403, "forbidden"},
		{"PATCH", "/api/admin/accounts/1", `{"location_id":2}`, 403, "forbidden"},
		{"POST", "/api/admin/accounts/1/password", `{"temporary_password":"private-reset-value"}`, 403, "forbidden"},
		{"DELETE", "/api/admin/accounts/2", "", 405, "method_not_allowed"},
		{"POST", "/api/admin/branches", `{"name":"Almacén"}`, 400, "invalid_request"},
		{"POST", "/api/admin/branches", `{"name":"Otra","kind":"warehouse"}`, 400, "invalid_request"},
		{"POST", "/api/admin/branches", `{"name":"Otra","role":"admin"}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/2", `{"role":"admin"}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/2", `{"must_change_password":false}`, 400, "invalid_request"},
		{"POST", "/api/admin/accounts/2/password", `{"temporary_password":"short"}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/2", `{"location_id":1}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/2", `{"location_id":32768}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/2", `{"location_id":99}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/02", `{"enabled":false}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/9223372036854775808", `{"enabled":false}`, 400, "invalid_request"},
		{"PATCH", "/api/admin/accounts/99", `{"enabled":false}`, 404, "not_found"},
	} {
		t.Run(tc.verb+tc.path+tc.body, func(t *testing.T) {
			t5Error(t, f.request(f.tokens[0], tc.verb, tc.path, tc.body), tc.status, tc.code)
			if f.snapshot() != before {
				t.Fatal("rejection changed public state/counters")
			}
		})
	}
	valid := `{"username":"new_user","display_name":"Persona","location_id":2,"temporary_password":"private-password-42"}`
	bodies := []string{`{}`, `null`, `[]`, valid + `{}`, strings.Repeat(" ", 4097), strings.Replace(valid, "Persona", "\xff", 1),
		strings.Replace(valid, `"username":`, `"Username":`, 1), strings.Replace(valid, `"username":`, `"username":"other","username":`, 1),
		strings.Replace(valid, `"location_id":2`, `"location_id":"2"`, 1), strings.Replace(valid, `"location_id":2`, `"location_id":2.0`, 1), strings.Replace(valid, `"location_id":2`, `"location_id":1`, 1),
		strings.Replace(valid, `"new_user"`, `"x"`, 1), strings.Replace(valid, `"Persona"`, `null`, 1), strings.Replace(valid, `"Persona"`, `" "`, 1), strings.Replace(valid, `"private-password-42"`, `"short"`, 1), strings.Replace(valid, `"private-password-42"`, `"`+strings.Repeat("a", 129)+`"`, 1), strings.Replace(valid, `"private-password-42"`, `"password-with-\u0000-nul"`, 1),
	}
	for _, field := range []string{`"role":"admin"`, `"id":"1"`, `"enabled":true`, `"must_change_password":false`, `"authority_version":1`, `"password_hash":"x"`} {
		bodies = append(bodies, strings.TrimSuffix(valid, "}")+","+field+"}")
	}
	for i, body := range bodies {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t5Error(t, f.request(f.tokens[0], "POST", "/api/admin/accounts", body), 400, "invalid_request")
			if f.snapshot() != before {
				t.Fatal("invalid create changed state/counters")
			}
		})
	}
	a := f.create("new_user", 2, "private-password-42")
	if a.ID != "4" {
		t.Fatal("rejected create consumed identity")
	}
	t5Error(t, f.request(f.tokens[0], "POST", "/api/admin/accounts", valid), 409, "conflict")
}
func TestT5NewBranch(t *testing.T) {
	f := t5Setup(t)
	oldStock := f.oldInventory()
	oldCounts := f.request(f.tokens[0], "GET", "/api/transfers/counts", "").Body.String()
	broker, err := realtime.New(f.p)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	if err = broker.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer broker.Shutdown(context.Background())
	warehouse, err := broker.Subscribe(1)
	if err != nil {
		t.Fatal(err)
	}
	defer warehouse.Close()
	t5Event(t, warehouse, realtime.Resync)
	t5Exact(t, f.request(f.tokens[0], "POST", "/api/admin/branches", `{"name":"Sucursal Nueva"}`), 201, "{\"id\":4,\"name\":\"Sucursal Nueva\"}\n")
	a := f.create("branch_four", 4, "private-password-four")
	if a.ID != "4" || a.LocationID != 4 {
		t.Fatal("coincident independent IDs")
	}
	t5Event(t, warehouse, realtime.Inventory)
	branch, err := broker.Subscribe(4)
	if err != nil {
		t.Fatal("new realtime audience", err)
	}
	defer branch.Close()
	t5Event(t, branch, realtime.Resync)
	seen := map[int]bool{}
	for page := 1; page <= 4; page++ {
		w := f.request(f.tokens[0], "GET", fmt.Sprintf("/api/inventory?location_id=4&page_size=50&page=%d", page), "")
		if w.Code != 200 || len(w.Result().Cookies()) != 0 {
			t.Fatalf("inventory: %d %s", w.Code, w.Body.String())
		}
		var stock inventory.Page
		if err := json.Unmarshal(w.Body.Bytes(), &stock); err != nil {
			t.Fatal(err)
		}
		if stock.TotalVariants != 190 || stock.Location.ID != 4 {
			t.Fatal("catalog cardinality/location")
		}
		for _, item := range stock.Items {
			if seen[item.VariantID] || item.Existing != 0 || item.Reserved != 0 || item.Available != 0 {
				t.Fatal("duplicate or nonzero stock")
			}
			seen[item.VariantID] = true
		}
	}
	if len(seen) != 190 {
		t.Fatal("incomplete branch catalog")
	}
	if f.oldInventory() != oldStock || f.request(f.tokens[0], "GET", "/api/transfers/counts", "").Body.String() != oldCounts {
		t.Fatal("branch creation changed old stock/business counters")
	}
	metadata := f.request(f.tokens[0], "GET", "/api/inventory/metadata", "")
	var meta inventory.Metadata
	if metadata.Code != 200 || json.Unmarshal(metadata.Body.Bytes(), &meta) != nil || len(meta.Locations) != 4 || meta.Locations[3].ID != 4 {
		t.Fatal("new branch metadata")
	}
	// Complete the temporary password via the existing public service.
	_, token, err := f.svc.Login(f.ctx, "branch_four", "private-password-four", "192.0.2.18", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.svc.ChangePassword(f.ctx, token, "private-password-four", "completed-password-four"); err != nil {
		t.Fatal(err)
	}
	_, token, err = f.svc.Login(f.ctx, "branch_four", "completed-password-four", "192.0.2.19", "")
	if err != nil {
		t.Fatal(err)
	}
	w := f.request(token, "POST", "/api/transfers", `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"branch-four-request-001","items":[{"variant_id":1,"quantity":"1"}]}`)
	if w.Code != 201 || len(w.Result().Cookies()) != 0 {
		t.Fatalf("new branch transfer: %d %s", w.Code, w.Body.String())
	}
	t5Event(t, branch, realtime.Transfers)
	t5Exact(t, f.request(token, "GET", "/api/transfers/counts", ""), 200, `{"pending_total":"1","action_count":"0","actions":{"approve":"0","dispatch":"0","receive":"0","review_count":"0","review_dispatch_reconciliation":"0","review_restitution":"0"}}`+"\n")
}
func (f *t5Fixture) oldInventory() string {
	f.t.Helper()
	var result string
	for location := 1; location <= 3; location++ {
		for page := 1; page <= 4; page++ {
			w := f.request(f.tokens[0], "GET", fmt.Sprintf("/api/inventory?location_id=%d&page_size=50&page=%d", location, page), "")
			if w.Code != 200 || len(w.Result().Cookies()) != 0 {
				f.t.Fatal("old inventory unavailable")
			}
			result += w.Body.String()
		}
	}
	return result
}
func TestT5PasswordBoundaries(t *testing.T) {
	f := t5Setup(t)
	for i, password := range []string{strings.Repeat("a", 12), strings.Repeat("ñ", 64)} {
		user := fmt.Sprintf("boundary_%d", i)
		a := f.create(user, 2, password)
		s, _, err := f.svc.Login(f.ctx, user, password, fmt.Sprintf("192.0.2.%d", 30+i), "")
		if err != nil || fmt.Sprint(s.Identity.AccountID) != a.ID || !s.Identity.MustChangePassword {
			t.Fatal("password byte boundary", err)
		}
	}
}
func TestT5LoginResetRace(t *testing.T) {
	f := t5Setup(t)
	next := "race-reset-password-42"
	var token string
	var loginErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, token, loginErr = f.svc.Login(f.ctx, f.creds[1].Username, f.creds[1].Password, "192.0.2.40", "")
	}()
	w := f.request(f.tokens[0], "POST", "/api/admin/accounts/2/password", `{"temporary_password":"`+next+`"}`)
	wg.Wait()
	t5Exact(t, w, 204, "")
	if loginErr != nil && loginErr != auth.ErrCredentials {
		t.Fatal("login race", loginErr)
	}
	for _, old := range []string{f.tokens[1], token} {
		if old != "" {
			if _, _, err := f.svc.Peek(f.ctx, old); err != auth.ErrSession {
				t.Fatal("pre-reset login authority survived")
			}
		}
	}
	s, _, err := f.svc.Login(f.ctx, f.creds[1].Username, next, "192.0.2.41", "")
	if err != nil || !s.Identity.MustChangePassword {
		t.Fatal("post-reset login", err)
	}
}
func t5Event(t *testing.T, sub *realtime.Subscription, want realtime.Event) {
	t.Helper()
	select {
	case got, ok := <-sub.Events:
		if !ok || got != want {
			t.Fatalf("event %q want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("realtime timeout")
	}
}
func TestT5LifecycleRules(t *testing.T) {
	for _, rule := range []string{"reassign", "deactivate", "reactivate"} {
		t.Run(rule, func(t *testing.T) {
			f := t5Setup(t)
			body := `{"location_id":3}`
			if rule == "deactivate" {
				body = `{"enabled":false}`
			}
			if rule == "reactivate" {
				if _, err := f.p.Exec(f.ctx, `UPDATE auth_accounts SET enabled=false WHERE id=2`); err != nil {
					t.Fatal(err)
				}
				body = `{"enabled":true}`
			}
			t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", body), 204, "")
			if rule != "reactivate" {
				if _, _, err := f.svc.Peek(f.ctx, f.tokens[1]); err != auth.ErrSession {
					t.Fatal("authority survived")
				}
			}
		})
	}
}
func TestT5MutationGuards(t *testing.T) {
	f := t5Setup(t)
	before := f.snapshot()
	for _, rule := range []string{"origin", "csrf", "media", "duplicate_cookie"} {
		t.Run(rule, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/admin/branches", strings.NewReader(`{"name":"Nueva"}`))
			r.Header.Set("Origin", "http://localhost:8080")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[0]))
			r.AddCookie(&http.Cookie{Name: "luson_session", Value: f.tokens[0]})
			status, code := 403, "forbidden"
			switch rule {
			case "origin":
				r.Header.Set("Origin", "https://evil.test")
			case "csrf":
				r.Header.Del("X-CSRF-Token")
			case "media":
				r.Header.Set("Content-Type", "text/plain")
				status, code = 400, "invalid_request"
			case "duplicate_cookie":
				r.AddCookie(&http.Cookie{Name: "luson_session", Value: f.tokens[0]})
				status, code = 400, "invalid_request"
			}
			w := httptest.NewRecorder()
			f.h.ServeHTTP(w, r)
			t5Error(t, w, status, code)
			if f.snapshot() != before {
				t.Fatal("guard rejection changed state")
			}
		})
	}
}
func TestT5ConcurrentLifecycle(t *testing.T) {
	f := t5Setup(t)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, body := range []string{`{"enabled":false}`, `{"location_id":3}`} {
		wg.Add(1)
		go func(body string) {
			defer wg.Done()
			codes <- f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", body).Code
		}(body)
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 204 {
			t.Fatalf("concurrent lifecycle: %d", code)
		}
	}
	list := f.accounts()
	if list[1].Enabled || list[1].LocationID != 3 {
		t.Fatal("concurrent edit lost update")
	}
	if _, _, err := f.svc.Peek(f.ctx, f.tokens[1]); err != auth.ErrSession {
		t.Fatal("concurrent retirement lost")
	}
}
