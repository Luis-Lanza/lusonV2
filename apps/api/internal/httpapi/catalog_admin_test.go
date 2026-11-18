package httpapi

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
	"luson/api/internal/catalog"
	"luson/api/internal/catalogadmin"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// The battery body is a canonical flat document: the exact key set, no duplicate
// keys, no aliases, no nulls, no nesting and a bounded body. The single admitted
// array is the polarity list of a creation.
func TestCatalogAdminBatteryBodyDecoding(t *testing.T) {
	decode := func(body string, withPolarities bool) (catalogBatteryBody, error) {
		r := httptest.NewRequest("POST", "/api/catalog/batteries", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return catalogBatteryFields(r, withPolarities)
	}
	got, err := decode(`{"model":"NS40ZL","brand":"CAR","capacity_ah":"045.0","polarities":["L","R"]}`, true)
	if err != nil || got.brand != "CAR" || got.model != "NS40ZL" || got.capacity != catalog.Decimal("45") ||
		len(got.polarities) != 2 || got.polarities[0] != catalog.Left || got.polarities[1] != catalog.Right {
		t.Fatalf("canonical body %v %v", got, err)
	}
	if got, err = decode(`{"brand":"CAR","model":"NS40ZL","capacity_ah":"45"}`, false); err != nil ||
		got.brand != "CAR" || len(got.polarities) != 0 {
		t.Fatalf("canonical edit body %v %v", got, err)
	}
	for _, c := range []struct {
		name           string
		body           string
		withPolarities bool
	}{
		{"duplicate_key", `{"brand":"A","brand":"B","model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"unknown_key", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"],"cells":[]}`, true},
		{"missing_brand", `{"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"missing_model", `{"brand":"A","capacity_ah":"45","polarities":["L"]}`, true},
		{"missing_capacity", `{"brand":"A","model":"M","polarities":["L"]}`, true},
		{"missing_polarities", `{"brand":"A","model":"M","capacity_ah":"45"}`, true},
		{"polarities_on_edit", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}`, false},
		{"empty_polarities", `{"brand":"A","model":"M","capacity_ah":"45","polarities":[]}`, true},
		{"three_polarities", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L","R","L"]}`, true},
		{"numeric_polarity", `{"brand":"A","model":"M","capacity_ah":"45","polarities":[1]}`, true},
		{"nested_polarity", `{"brand":"A","model":"M","capacity_ah":"45","polarities":[["L"]]}`, true},
		{"polarities_string", `{"brand":"A","model":"M","capacity_ah":"45","polarities":"LR"}`, true},
		{"polarities_null", `{"brand":"A","model":"M","capacity_ah":"45","polarities":null}`, true},
		{"numeric_brand", `{"brand":1,"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"null_brand", `{"brand":null,"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"nested_brand", `{"brand":{"value":"A"},"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"capacity_number", `{"brand":"A","model":"M","capacity_ah":45,"polarities":["L"]}`, true},
		{"capacity_zero", `{"brand":"A","model":"M","capacity_ah":"0","polarities":["L"]}`, true},
		{"trailing_content", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}{}`, true},
		{"top_level_array", `[{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}]`, true},
		{"empty_body", ``, true},
		{"unterminated", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]`, true},
		{"oversized", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"],"pad":"` + strings.Repeat("x", 4096) + `"}`, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got, err := decode(c.body, c.withPolarities); err == nil {
				t.Fatalf("admitted %q as %v", c.name, got)
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/catalog/batteries", strings.NewReader(`{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}`))
	r.Header.Set("Content-Type", "text/plain")
	if _, err := catalogBatteryFields(r, true); err == nil {
		t.Fatal("admitted a non-JSON content type")
	}
	r = httptest.NewRequest("POST", "/api/catalog/batteries", strings.NewReader(`{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}`))
	r.Header.Add("Content-Type", "application/json")
	r.Header.Add("Content-Type", "application/json")
	if _, err := catalogBatteryFields(r, true); err == nil {
		t.Fatal("admitted two content type headers")
	}
}

// Only the battery collection and its one-segment identity belong to this
// contract. An ambiguous path is not_found before the handler runs, and the
// catalogue price list is forwarded untouched.
func TestCatalogAdminPathSafety(t *testing.T) {
	for _, c := range []struct {
		target string
		want   bool
	}{
		{"/api/catalog/batteries", true},
		{"/api/catalog/batteries/96", true},
		{"/api/catalog/batteries/96/", true},
		{"/api/catalog/batteries//96", false},
		{"/api/catalog/batteries/./96", false},
		{"/api/catalog/batteries/96/..", false},
		{"/api/catalog/batteries%2F96", false},
		{"/api/catalog/batteries/96%00", false},
		{"/api/catalog/batteries/96\\", false},
		{"/api/catalog/prices", true},
		{"/api/catalog/batteriesX", true},
		{"/api/inventory/1", true},
	} {
		r := httptest.NewRequest("GET", c.target, nil)
		if got := catalogBatteryPath(r); got != c.want {
			t.Fatalf("catalogBatteryPath(%q) = %v, want %v", c.target, got, c.want)
		}
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{"/api/catalog/batteries", true},
		{"/api/catalog/batteries/96", true},
		{"/api/catalog/batteriesX", false},
		{"/api/catalog/prices", false},
	} {
		if got := catalogBatteryRoute(c.path); got != c.want {
			t.Fatalf("catalogBatteryRoute(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestCatalogAdminBatteryRecordValidation(t *testing.T) {
	valid := catalogadmin.Battery{
		ID: 96, Brand: "CAR", Model: "NS40ZL", Capacity: "45",
		Variants: []catalogadmin.Variant{
			{ID: 191, Polarity: catalog.Left},
			{ID: 192, Polarity: catalog.Right},
		},
		PricedBranches: 0,
	}
	record, err := catalogBatteryRecord(valid)
	if err != nil {
		t.Fatalf("refused the allocated battery: %v", err)
	}
	if record.ID != 96 || record.Capacity != "45" || len(record.Variants) != 2 ||
		record.Variants[0].Polarity != "L" || record.Variants[1].ID != 192 || record.PricedBranches != 0 {
		t.Fatalf("record %v", record)
	}
	for _, c := range []struct {
		name   string
		mutate func(*catalogadmin.Battery)
	}{
		{"zero_id", func(b *catalogadmin.Battery) { b.ID = 0 }},
		{"empty_brand", func(b *catalogadmin.Battery) { b.Brand = "" }},
		{"blank_model", func(b *catalogadmin.Battery) { b.Model = " " }},
		{"non_canonical_capacity", func(b *catalogadmin.Battery) { b.Capacity = "45.0" }},
		{"padded_capacity", func(b *catalogadmin.Battery) { b.Capacity = "045" }},
		{"unparsable_capacity", func(b *catalogadmin.Battery) { b.Capacity = "fortyfive" }},
		{"no_variants", func(b *catalogadmin.Battery) { b.Variants = nil }},
		{"three_variants", func(b *catalogadmin.Battery) {
			b.Variants = []catalogadmin.Variant{{ID: 1, Polarity: catalog.Left}, {ID: 2, Polarity: catalog.Right}, {ID: 3, Polarity: catalog.Left}}
		}},
		{"unknown_polarity", func(b *catalogadmin.Battery) { b.Variants[0].Polarity = "X" }},
		{"descending_polarities", func(b *catalogadmin.Battery) {
			b.Variants = []catalogadmin.Variant{{ID: 1, Polarity: catalog.Right}, {ID: 2, Polarity: catalog.Left}}
		}},
		{"zero_variant_id", func(b *catalogadmin.Battery) { b.Variants[0].ID = 0 }},
		{"negative_priced_branches", func(b *catalogadmin.Battery) { b.PricedBranches = -1 }},
	} {
		t.Run(c.name, func(t *testing.T) {
			battery := valid
			battery.Variants = append([]catalogadmin.Variant(nil), valid.Variants...)
			c.mutate(&battery)
			if _, err := catalogBatteryRecord(battery); err == nil {
				t.Fatalf("accepted %s", c.name)
			}
		})
	}
}

// The battery contract answers its own refusals with stable codes and keeps the
// administration surface's authentication/authorization refusals byte-identical.
func TestCatalogAdminFailureCodes(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		body   string
	}{
		{catalogadmin.ErrHasStock, 409, "{\"error\":\"catalog_battery_has_stock\"}\n"},
		{catalogadmin.ErrHasPending, 409, "{\"error\":\"catalog_battery_has_pending\"}\n"},
		{catalogadmin.ErrNotFound, 404, "{\"error\":\"not_found\"}\n"},
		{catalogadmin.ErrInvalid, 400, "{\"error\":\"invalid_request\"}\n"},
		{catalogadmin.ErrForbidden, 403, "{\"error\":\"forbidden\"}\n"},
		{catalogadmin.ErrConflict, 409, "{\"error\":\"conflict\"}\n"},
		{catalogadmin.ErrUnavailable, 503, "{\"error\":\"service_unavailable\"}\n"},
		{auth.ErrSession, 401, "{\"error\":\"unauthenticated\"}\n"},
		{auth.ErrAdminForbidden, 403, "{\"error\":\"forbidden\"}\n"},
		{auth.ErrAdminNotFound, 404, "{\"error\":\"not_found\"}\n"},
	} {
		w := httptest.NewRecorder()
		catalogBatteryFailure(w, c.err)
		if w.Code != c.status || w.Body.String() != c.body {
			t.Fatalf("%v answered %d %q, want %d %q", c.err, w.Code, w.Body.String(), c.status, c.body)
		}
		if got := w.Header().Get("Content-Type"); got != "application/json" {
			t.Fatalf("refusal content type %q", got)
		}
	}
}

// catalogBatteryIdentityFixture is the battery contract on a fresh installation, with
// the warehouse administrator logged in. It needs the isolated test PostgreSQL and
// fails closed inside testpg.Open, like every other database fixture here.
type catalogBatteryIdentityFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	token   string
}

func catalogBatteryIdentity(t *testing.T) *catalogBatteryIdentityFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("catalog identity fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("catalog identity test provisioning failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("catalog identity operational fixture setup failed")
	}
	service, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("catalog identity auth fixture failed")
	}
	cfg := transferConfig(t)
	base, err := NewWithStockEntries(service, cfg, inventory.New(p), transfers.New(p),
		stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("catalog identity base constructor failed")
	}
	handler, err := NewWithCatalogAdmin(base, service, cfg, catalogadmin.New(p, service))
	if err != nil {
		t.Fatal("catalog identity constructor failed")
	}
	_, token, err := service.Login(ctx, credentials[0].Username, credentials[0].Password, "127.0.0.1", "")
	if err != nil {
		t.Fatal("catalog identity login failed")
	}
	return &catalogBatteryIdentityFixture{ctx: ctx, p: p, cfg: cfg, handler: handler, token: token}
}

func (f *catalogBatteryIdentityFixture) serve(t *testing.T, verb, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(verb, target, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.token})
	r.Header.Set("X-CSRF-Token", auth.CSRF(f.token))
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("catalog identity security headers changed")
	}
	return w
}

// The kind is part of the catalog identity, so a battery route that reads, edits or
// archives by id alone acts on a product: DELETE /api/catalog/batteries/{product}
// answered 204 and retired an other product, while a product is not a battery
// identity at all. Both writes answer not_found exactly like an unknown id, and the
// product is left active; a real battery keeps its own edit and archive.
func TestCatalogAdminBatteryRoutesNeverTouchProducts(t *testing.T) {
	f := catalogBatteryIdentity(t)
	var product int64
	if err := f.p.QueryRow(f.ctx, `INSERT INTO catalog_entries(kind,name)
 VALUES('other','Agua acidulada') RETURNING id`).Scan(&product); err != nil {
		t.Fatal("product fixture failed")
	}
	if _, err := f.p.Exec(f.ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, product); err != nil {
		t.Fatal("product variant fixture failed")
	}
	productActive := func(stage string) {
		t.Helper()
		var active bool
		if err := f.p.QueryRow(f.ctx, `SELECT deleted_at IS NULL AND kind='other' AND name='Agua acidulada'
 FROM catalog_entries WHERE id=$1`, int32(product)).Scan(&active); err != nil {
			t.Fatalf("%s: product read failed: %v", stage, err)
		}
		if !active {
			t.Fatalf("%s: the product must still be active", stage)
		}
	}
	productActive("before")

	// An edit of a product through the battery route is not found: it is not a battery.
	if w := f.serve(t, http.MethodPatch, fmt.Sprintf("/api/catalog/batteries/%d", product),
		`{"brand":"CAR","model":"NS40ZL","capacity_ah":"45"}`); w.Code != 404 ||
		w.Body.String() != "{\"error\":\"not_found\"}\n" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("editing a product through the battery route answered %d %q", w.Code, w.Body.String())
	}
	productActive("after the refused edit")
	// An archive of a product through the battery route is not found either, and the
	// product is not retired.
	if w := f.serve(t, http.MethodDelete, fmt.Sprintf("/api/catalog/batteries/%d", product), ""); w.Code != 404 ||
		w.Body.String() != "{\"error\":\"not_found\"}\n" {
		t.Fatalf("archiving a product through the battery route answered %d %q", w.Code, w.Body.String())
	}
	productActive("after the refused archive")

	// The battery behaviour is unchanged: a created battery edits and archives exactly
	// as it did, and a repeated archive stays the same successful no-op.
	created := f.serve(t, http.MethodPost, "/api/catalog/batteries",
		`{"brand":"NUEVA","model":"M1","capacity_ah":"60","polarities":["L","R"]}`)
	if created.Code != 201 {
		t.Fatalf("the battery must still be created: %d %s", created.Code, created.Body.String())
	}
	var battery struct {
		ID       int64  `json:"id"`
		Brand    string `json:"brand"`
		Model    string `json:"model"`
		Capacity string `json:"capacity_ah"`
	}
	if json.Unmarshal(created.Body.Bytes(), &battery) != nil || battery.ID < 1 {
		t.Fatalf("the created battery is not the record this test asked for: %s", created.Body.String())
	}
	edited := f.serve(t, http.MethodPatch, fmt.Sprintf("/api/catalog/batteries/%d", battery.ID),
		`{"brand":"NUEVA","model":"M2","capacity_ah":"65"}`)
	if edited.Code != 200 {
		t.Fatalf("the battery must still be edited: %d %s", edited.Code, edited.Body.String())
	}
	if json.Unmarshal(edited.Body.Bytes(), &battery) != nil || battery.Model != "M2" || battery.Capacity != "65" {
		t.Fatalf("the edited battery is not the edited record: %s", edited.Body.String())
	}
	for attempt := 1; attempt <= 2; attempt++ {
		if w := f.serve(t, http.MethodDelete, fmt.Sprintf("/api/catalog/batteries/%d", battery.ID), ""); w.Code != 204 {
			t.Fatalf("archive %d of the battery answered %d %q", attempt, w.Code, w.Body.String())
		}
	}
	var retired bool
	if err := f.p.QueryRow(f.ctx, `SELECT deleted_at IS NOT NULL FROM catalog_entries WHERE id=$1`,
		int32(battery.ID)).Scan(&retired); err != nil || !retired {
		t.Fatalf("the battery must be retired: %v %v", retired, err)
	}
}
