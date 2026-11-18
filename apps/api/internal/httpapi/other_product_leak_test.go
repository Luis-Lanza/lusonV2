package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/inventory"
	"luson/api/internal/pricing"
)

// An other product shares the catalog identity with batteries, so every battery
// screen is one missing predicate away from reading a NULL brand. This test pins
// the observable answer of the shared surfaces: the product never shows up there
// and its presence never turns a battery listing into an error.
func TestOtherProductsStayOutOfBatteryScreens(t *testing.T) {
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
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("operational fixture setup")
	}
	svc, err := auth.New(p, func() time.Time { return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal("service initialization")
	}
	cfg, err := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatal(err)
	}
	base := httpapi.New(svc, cfg, inventory.New(p))
	h, err := httpapi.NewWithBranchPrices(base, svc, cfg, pricing.New(p))
	if err != nil {
		t.Fatal(err)
	}
	warehouse, token, err := svc.Login(ctx, creds[0].Username, creds[0].Password, "127.0.0.1", "")
	if err != nil || warehouse.Identity.Location.ID != 1 {
		t.Fatal("warehouse login")
	}
	cookie := &http.Cookie{Name: "luson_session", Value: token}
	request := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: status %d body %s", path, w.Code, w.Body.String())
		}
		return w
	}
	metadata := func() inventory.Metadata {
		t.Helper()
		var m inventory.Metadata
		if json.Unmarshal(request("/api/inventory/metadata").Body.Bytes(), &m) != nil {
			t.Fatal("metadata body")
		}
		return m
	}
	type inventoryPage struct {
		TotalVariants int64 `json:"total_variants"`
	}
	inventoryTotal := func(query string) int64 {
		t.Helper()
		var page inventoryPage
		if json.Unmarshal(request("/api/inventory?location_id=1"+query).Body.Bytes(), &page) != nil {
			t.Fatal("inventory body")
		}
		return page.TotalVariants
	}
	type pricesPage struct {
		Total int64 `json:"total"`
	}
	pricesTotal := func(query string) int64 {
		t.Helper()
		var page pricesPage
		if json.Unmarshal(request("/api/catalog/prices?page=1&page_size=10"+query).Body.Bytes(), &page) != nil {
			t.Fatal("price matrix body")
		}
		return page.Total
	}

	// Before: the seeded catalogue is all batteries.
	if got := len(metadata().Brands); got != 11 {
		t.Fatalf("seeded brands: got %d want 11", got)
	}
	if got := inventoryTotal(""); got != 190 {
		t.Fatalf("seeded variants: got %d want 190", got)
	}
	if got := pricesTotal(""); got != 95 {
		t.Fatalf("seeded batteries: got %d want 95", got)
	}

	// The product the catalog screen creates: a free name, one polarity-less
	// variant — which the balance fan-out stocks with zero in every branch — and
	// one custom field.
	var entry int64
	if err := p.QueryRow(ctx,
		"INSERT INTO catalog_entries(kind,name) VALUES('other','Agua acidulada') RETURNING id").Scan(&entry); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, "INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)", entry); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
		VALUES($1,'volumen en L','number','L',5)`, entry); err != nil {
		t.Fatal(err)
	}

	// After: no battery surface reads it, and none of them fails on its NULL
	// brand, model or capacity.
	if got := len(metadata().Brands); got != 11 {
		t.Fatalf("the brand list must not gain a product: got %d want 11", got)
	}
	for _, brand := range metadata().Brands {
		if strings.TrimSpace(brand) == "" {
			t.Fatal("the brand list must never contain an empty brand")
		}
	}
	if got := inventoryTotal(""); got != 190 {
		t.Fatalf("the inventory listing must not count the product variant: got %d want 190", got)
	}
	if got := inventoryTotal("&search=Agua"); got != 0 {
		t.Fatalf("searching the product name must find no battery: got %d", got)
	}
	if got := pricesTotal(""); got != 95 {
		t.Fatalf("the price matrix must not count the product: got %d want 95", got)
	}
	if got := pricesTotal("&search=Agua"); got != 0 {
		t.Fatalf("the price matrix must not find the product: got %d", got)
	}
}
