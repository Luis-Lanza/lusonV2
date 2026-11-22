package closings_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/testpg"
)

// The administration of the motive catalogue is exercised through the public HTTP surface, on the
// handler the server composes, against the isolated PostgreSQL fixture: the gate, the canonical body,
// the mapped SQLSTATEs and the rows the routes publish are all the production path.

type catalogueHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
}

func catalogueFixture(t *testing.T) *catalogueHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("catalogue HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("catalogue HTTP test provisioning failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("catalogue HTTP fixture setup failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET display_name='Administración' WHERE id=1`); err != nil {
		t.Fatal("catalogue HTTP administrator name setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("catalogue HTTP auth fixture failed")
	}
	cfg, err := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatal("catalogue HTTP configuration failed")
	}
	f := &catalogueHTTPFixture{ctx: ctx, p: p, cfg: cfg, tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("catalogue HTTP login failed")
		}
		f.tokens[i] = token
	}
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	f.handler, err = httpapi.NewWithClosings(base, svc, cfg, closings.New(p))
	if err != nil {
		t.Fatal("catalogue HTTP constructor failed")
	}
	return f
}

func (f *catalogueHTTPFixture) request(actor int, verb, path, body string) *http.Request {
	r := httptest.NewRequest(verb, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if actor > 0 {
		r.AddCookie(&http.Cookie{Name: "luson_session", Value: f.tokens[actor-1]})
		r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[actor-1]))
	}
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func (f *catalogueHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("catalogue security headers changed")
	}
	return w
}

// snapshot is the whole catalogue and the counts this administration can move, so a refused request
// is proven to leave the table and the movements exactly as they were (S13).
func (f *catalogueHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'categories',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM branch_cash_categories c),
  'category_count',(SELECT count(*) FROM branch_cash_categories),
  'movement_count',(SELECT count(*) FROM branch_cash_movements))::text`).Scan(&data)
	if err != nil {
		t.Fatal("catalogue snapshot failed")
	}
	return data
}

func (f *catalogueHTTPFixture) refused(t *testing.T, r *http.Request, status int, body string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	if w.Code != status || w.Body.String() != body+"\n" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("refusal mismatch: %d %s, want %d %s", w.Code, w.Body.String(), status, body)
	}
	if f.snapshot(t) != before {
		t.Fatal("a refused catalogue request changed stored state")
	}
}

type catalogueCategoryWire struct {
	ID        int64   `json:"id"`
	Label     string  `json:"label"`
	SortOrder int16   `json:"sort_order"`
	State     string  `json:"state"`
	RetiredAt *string `json:"retired_at"`
	RetiredBy *string `json:"retired_by"`
}

func decodeCatalogueCategories(t *testing.T, w *httptest.ResponseRecorder, status int) []catalogueCategoryWire {
	t.Helper()
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("catalogue answer mismatch: %d %s", w.Code, w.Body.String())
	}
	var raw struct {
		Categories []map[string]json.RawMessage `json:"categories"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("the catalogue answer is not decodable: %s", w.Body.String())
	}
	if len(raw.Categories) == 0 && !strings.HasPrefix(strings.TrimSpace(w.Body.String()), `{"categories":[`) {
		t.Fatalf("the catalogue answer has no list: %s", w.Body.String())
	}
	for _, row := range raw.Categories {
		if len(row) != 6 {
			t.Fatalf("a catalogue row states exactly six keys: %s", w.Body.String())
		}
		for _, key := range []string{"id", "label", "sort_order", "state", "retired_at", "retired_by"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("catalogue key %q is missing: %s", key, w.Body.String())
			}
		}
	}
	var answer struct {
		Categories []catalogueCategoryWire `json:"categories"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatalf("the catalogue answer is not decodable: %s", w.Body.String())
	}
	return answer.Categories
}

func decodeCatalogueAnswer(t *testing.T, w *httptest.ResponseRecorder, status int) catalogueCategoryWire {
	t.Helper()
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("catalogue answer mismatch: %d %s", w.Code, w.Body.String())
	}
	var raw struct {
		Category map[string]json.RawMessage `json:"category"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("the catalogue answer is not decodable: %s", w.Body.String())
	}
	if len(raw.Category) != 6 {
		t.Fatalf("the catalogue answer states exactly six keys: %s", w.Body.String())
	}
	var answer struct {
		Category catalogueCategoryWire `json:"category"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatalf("the catalogue answer is not decodable: %s", w.Body.String())
	}
	return answer.Category
}

// decodePublicCatalogue reads the branch route exactly as S12 pins it: one list of options that
// state only their identity and their label.
func decodePublicCatalogue(t *testing.T, w *httptest.ResponseRecorder) []catalogueCategoryWire {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("public catalogue answer mismatch: %d %s", w.Code, w.Body.String())
	}
	var raw struct {
		Categories []map[string]json.RawMessage `json:"categories"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("the public catalogue answer is not decodable: %s", w.Body.String())
	}
	for _, row := range raw.Categories {
		if len(row) != 2 {
			t.Fatalf("a public option states exactly its identity and label: %s", w.Body.String())
		}
	}
	var answer struct {
		Categories []catalogueCategoryWire `json:"categories"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatalf("the public catalogue answer is not decodable: %s", w.Body.String())
	}
	return answer.Categories
}

func (f *catalogueHTTPFixture) categoryID(t *testing.T, label string) int64 {
	t.Helper()
	var id int64
	if err := f.p.QueryRow(f.ctx, `SELECT id FROM branch_cash_categories WHERE label=$1`, label).Scan(&id); err != nil {
		t.Fatalf("the motive %q could not be read: %v", label, err)
	}
	return id
}

func catalogueContains(categories []catalogueCategoryWire, label string) *catalogueCategoryWire {
	for index := range categories {
		if categories[index].Label == label {
			return &categories[index]
		}
	}
	return nil
}

// TestAdminCashCategoriesListAndCreate pins S5 and S13 over HTTP: the administration lists every
// motive in place order, active and archived alike, and a new motive is always appended at the end.
func TestAdminCashCategoriesListAndCreate(t *testing.T) {
	f := catalogueFixture(t)

	want := []string{"Alquiler", "Internet", "Energía eléctrica", "Agua", "Limpieza", "Sueldos",
		"Transporte", "Insumos de tienda", "Mantenimiento", "Impuestos", "Otros gastos"}
	categories := decodeCatalogueCategories(t, f.serve(t, f.request(1, "GET",
		"/api/admin/cash-categories", "")), 200)
	if len(categories) != len(want) {
		t.Fatalf("the catalogue states %d motives, want %d: %+v", len(categories), len(want), categories)
	}
	for index, label := range want {
		category := categories[index]
		if category.Label != label || category.ID < 1 || category.State != "active" ||
			category.RetiredAt != nil || category.RetiredBy != nil {
			t.Fatalf("the catalogue must be the seed in place order: %+v", categories)
		}
		if category.SortOrder != int16(index+1) {
			t.Fatalf("the place of %q is %d, want %d", label, category.SortOrder, index+1)
		}
	}

	created := decodeCatalogueAnswer(t, f.serve(t, f.request(1, "POST",
		"/api/admin/cash-categories", `{"label":"Fletes"}`)), 201)
	if created.Label != "Fletes" || created.SortOrder != 12 || created.State != "active" ||
		created.RetiredAt != nil || created.RetiredBy != nil {
		t.Fatalf("a created motive is appended as an active last row: %+v", created)
	}
	second := decodeCatalogueAnswer(t, f.serve(t, f.request(1, "POST",
		"/api/admin/cash-categories", `{"label":"Uniformes"}`)), 201)
	if second.SortOrder != 13 {
		t.Fatalf("the next motive follows the previous one: %+v", second)
	}
	categories = decodeCatalogueCategories(t, f.serve(t, f.request(1, "GET",
		"/api/admin/cash-categories", "")), 200)
	if len(categories) != len(want)+2 || categories[len(categories)-1].Label != "Uniformes" {
		t.Fatalf("the catalogue keeps the created motives at the end: %+v", categories)
	}
	// The public read is unchanged: it offers active motives only, without the administration keys.
	public := decodePublicCatalogue(t, f.serve(t, f.request(2, "GET",
		"/api/closings/cash-categories", "")))
	if len(public) != len(want)+2 {
		t.Fatalf("the branch list must include the created motives: %+v", public)
	}
}

// TestAdminCashCategoriesRenameKeepsHistory pins S4: a rename changes the offered label and never
// rewrites the copy a movement already recorded.
func TestAdminCashCategoriesRenameKeepsHistory(t *testing.T) {
	f := catalogueFixture(t)
	agua := f.categoryID(t, "Agua")

	// The branch records a contribution and then an expense with the seeded motive, through the same
	// routes the counter uses, so the copy of the label is the one the database writes.
	if w := f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"aporte","amount":"100.00","description":"Fondo de la caja"}`)); w.Code != 201 {
		t.Fatalf("the contribution must be recorded: %d %s", w.Code, w.Body.String())
	}
	w := f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		fmt.Sprintf(`{"kind":"gasto","amount":"10.00","category_id":%d,"description":"Flete"}`, agua)))
	if w.Code != 201 {
		t.Fatalf("the expense must be recorded: %d %s", w.Code, w.Body.String())
	}
	var movement int64
	if err := json.Unmarshal(w.Body.Bytes(), &struct {
		ID *int64 `json:"id"`
	}{ID: &movement}); err != nil || movement < 1 {
		t.Fatalf("the recorded movement states its identity: %s", w.Body.String())
	}

	renamed := decodeCatalogueAnswer(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/admin/cash-categories/%d/rename", agua), `{"label":"Agua potable"}`)), 200)
	if renamed.ID != agua || renamed.Label != "Agua potable" || renamed.SortOrder != 4 {
		t.Fatalf("the rename keeps the identity and the place: %+v", renamed)
	}
	var kept string
	if err := f.p.QueryRow(f.ctx, `SELECT category_label FROM branch_cash_movements WHERE id=$1`,
		movement).Scan(&kept); err != nil {
		t.Fatalf("the movement copy could not be read: %v", err)
	}
	if kept != "Agua" {
		t.Fatalf("the movement must keep the label it recorded, got %q", kept)
	}
	public := decodePublicCatalogue(t, f.serve(t, f.request(2, "GET",
		"/api/closings/cash-categories", "")))
	if category := catalogueContains(public, "Agua potable"); category == nil || category.ID != agua {
		t.Fatalf("the rename must be offered to the branch: %+v", public)
	}
}

// TestAdminCashCategoriesRetireReactivate pins S3 and S12 over HTTP: an archived motive stops being
// offered, keeps the instant and the author of its retirement, and a reactivation clears both.
func TestAdminCashCategoriesRetireReactivate(t *testing.T) {
	f := catalogueFixture(t)
	agua := f.categoryID(t, "Agua")

	retired := decodeCatalogueAnswer(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/admin/cash-categories/%d/retire", agua), "")), 200)
	if retired.State != "retired" || retired.RetiredAt == nil || retired.RetiredBy == nil {
		t.Fatalf("a retired motive states its retirement: %+v", retired)
	}
	moment, err := time.Parse(time.RFC3339Nano, *retired.RetiredAt)
	if err != nil || !strings.HasSuffix(*retired.RetiredAt, "Z") || moment.Location() != time.UTC {
		t.Fatalf("the retirement instant is RFC 3339 in UTC: %+v", retired)
	}
	if *retired.RetiredBy != "Administración" {
		t.Fatalf("the retirement names the acting account: %+v", retired)
	}
	categories := decodeCatalogueCategories(t, f.serve(t, f.request(1, "GET",
		"/api/admin/cash-categories", "")), 200)
	stored := catalogueContains(categories, "Agua")
	if stored == nil || stored.State != "retired" || stored.RetiredAt == nil ||
		*stored.RetiredAt != *retired.RetiredAt || stored.RetiredBy == nil ||
		*stored.RetiredBy != *retired.RetiredBy {
		t.Fatalf("the administration keeps listing the archived motive: %+v", categories)
	}
	// The branch read is unchanged (S12): an archived motive is not one of its options.
	public := decodePublicCatalogue(t, f.serve(t, f.request(2, "GET",
		"/api/closings/cash-categories", "")))
	if catalogueContains(public, "Agua") != nil {
		t.Fatalf("an archived motive must not be offered: %+v", public)
	}

	reactivated := decodeCatalogueAnswer(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/admin/cash-categories/%d/reactivate", agua), "")), 200)
	if reactivated.State != "active" || reactivated.RetiredAt != nil || reactivated.RetiredBy != nil {
		t.Fatalf("a reactivated motive clears its retirement: %+v", reactivated)
	}
	public = decodePublicCatalogue(t, f.serve(t, f.request(2, "GET",
		"/api/closings/cash-categories", "")))
	if catalogueContains(public, "Agua") == nil {
		t.Fatalf("a reactivated motive is offered again: %+v", public)
	}
}

// TestAdminCashCategoriesRetirePinned pins S10 over HTTP: the catch-all is never archived and the
// refusal leaves the table exactly as it was.
func TestAdminCashCategoriesRetirePinned(t *testing.T) {
	f := catalogueFixture(t)
	var pinned int64
	if err := f.p.QueryRow(f.ctx, `SELECT id FROM branch_cash_categories WHERE pinned`).Scan(&pinned); err != nil {
		t.Fatalf("the catch-all could not be read: %v", err)
	}
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/admin/cash-categories/%d/retire", pinned), ""),
		409, `{"error":"category_pinned"}`)
}

// TestAdminCashCategoriesRetireLastActive pins S10 over HTTP: the last offered motive is never
// archived. The seeded catch-all is pinned and cannot be archived, so the fixture states the shape
// the guard exists for -- one unpinned row still offered -- before the route is asked.
func TestAdminCashCategoriesRetireLastActive(t *testing.T) {
	f := catalogueFixture(t)
	last := f.categoryID(t, "Impuestos")
	if _, err := f.p.Exec(f.ctx, `ALTER TABLE branch_cash_categories DISABLE TRIGGER guard_branch_cash_category_write`); err != nil {
		t.Fatalf("the guard could not be disabled for the fixture: %v", err)
	}
	if _, err := f.p.Exec(f.ctx, `UPDATE branch_cash_categories SET pinned=false`); err != nil {
		t.Fatalf("the fixture pin could not be stated: %v", err)
	}
	if _, err := f.p.Exec(f.ctx, `UPDATE branch_cash_categories SET retired_at=now(),retired_by='fixture'
 WHERE id<>$1`, last); err != nil {
		t.Fatalf("the other motives could not be archived by the fixture: %v", err)
	}
	if _, err := f.p.Exec(f.ctx, `ALTER TABLE branch_cash_categories ENABLE TRIGGER guard_branch_cash_category_write`); err != nil {
		t.Fatalf("the guard could not be enabled again: %v", err)
	}
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/admin/cash-categories/%d/retire", last), ""),
		409, `{"error":"last_category"}`)
}

// TestAdminCashCategoriesDuplicateLabel pins S13 over HTTP: the unique label is its own rejection on
// both writes, and neither rejection leaves anything behind.
func TestAdminCashCategoriesDuplicateLabel(t *testing.T) {
	f := catalogueFixture(t)
	f.refused(t, f.request(1, "POST", "/api/admin/cash-categories", `{"label":"Agua"}`),
		409, `{"error":"duplicate_label"}`)
	internet := f.categoryID(t, "Internet")
	f.refused(t, f.request(1, "POST",
		fmt.Sprintf("/api/admin/cash-categories/%d/rename", internet), `{"label":"Agua"}`),
		409, `{"error":"duplicate_label"}`)
}

// TestAdminCashCategoriesUnknownMotive pins S13 over HTTP: a motive this installation does not hold
// is its own rejection on every write that names one.
func TestAdminCashCategoriesUnknownMotive(t *testing.T) {
	f := catalogueFixture(t)
	f.refused(t, f.request(1, "POST", "/api/admin/cash-categories/999999/rename",
		`{"label":"Fletes"}`), 404, `{"error":"category_unknown"}`)
	f.refused(t, f.request(1, "POST", "/api/admin/cash-categories/999999/retire", ""),
		404, `{"error":"category_unknown"}`)
	f.refused(t, f.request(1, "POST", "/api/admin/cash-categories/999999/reactivate", ""),
		404, `{"error":"category_unknown"}`)
}

// TestAdminCashCategoriesInvalidRequest pins the label shape and the unknown key of S13: the body is
// judged before the catalogue is touched, and a refused body writes nothing.
func TestAdminCashCategoriesInvalidRequest(t *testing.T) {
	f := catalogueFixture(t)
	for _, body := range []string{`{"label":""}`, `{"label":" Agua "}`, `{"label":"Fletes","sort_order":12}`,
		`{}`, `{"label":1}`} {
		f.refused(t, f.request(1, "POST", "/api/admin/cash-categories", body),
			400, `{"error":"invalid_request"}`)
	}
}

// TestAdminCashCategoriesGate pins S7 over HTTP: a branch session is refused on the read and on every
// write, before any statement of the catalogue is reached.
func TestAdminCashCategoriesGate(t *testing.T) {
	f := catalogueFixture(t)
	f.refused(t, f.request(2, "GET", "/api/admin/cash-categories", ""),
		403, `{"error":"forbidden"}`)
	f.refused(t, f.request(2, "POST", "/api/admin/cash-categories", `{"label":"Fletes"}`),
		403, `{"error":"forbidden"}`)
}

// TestAdminCashCategoriesMethods pins the method contract of every administration route: only the
// listed methods are served, each refusal advertises its own Allow, and nothing is written.
func TestAdminCashCategoriesMethods(t *testing.T) {
	f := catalogueFixture(t)
	for _, tc := range []struct {
		method, target, allow string
	}{
		{"DELETE", "/api/admin/cash-categories", "GET, POST"},
		{"GET", "/api/admin/cash-categories/1/rename", "POST"},
		{"GET", "/api/admin/cash-categories/1/retire", "POST"},
		{"GET", "/api/admin/cash-categories/1/reactivate", "POST"},
	} {
		before := f.snapshot(t)
		w := f.serve(t, f.request(1, tc.method, tc.target, ""))
		if w.Code != 405 || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s %s must be a method refusal: %d %s", tc.method, tc.target, w.Code, w.Body.String())
		}
		if w.Header().Get("Allow") != tc.allow {
			t.Fatalf("%s %s must advertise %q, got %q", tc.method, tc.target, tc.allow, w.Header().Get("Allow"))
		}
		if f.snapshot(t) != before {
			t.Fatal("a method refusal changed the catalogue")
		}
	}
}
