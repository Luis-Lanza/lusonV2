package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/inventory"
	"luson/api/internal/otherproducts"
	"luson/api/internal/sales"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/transfers"
)

// The branch point of sale is the catalogue's busiest reader and it paginates, so
// it reads the battery table with its own count, page and scan. An other product
// joins that same table with a NULL brand, model, capacity and polarity and a
// polarity-less variant that the balance fan-out stocks with zero in every
// branch. Without the kind predicate the product's variant is counted, reaches a
// page and then cannot be scanned into a battery row, so the counter answers
// 503 service_unavailable instead of the catalogue — on an ordinary page of a
// branch that only ever sold batteries.
//
// This test creates the product through the real catalog route and then asks the
// real point of sale five different pages of the seeded catalogue. It pins the
// whole observable contract of the sweep: the total stays the batteries' own 190,
// no served row lacks its brand or model, and the product's own name matches
// nothing.

// catalogKindFixture is the composed API of a fresh installation: the branch point
// of sale and the other-product catalog on one handler, with the warehouse
// administrator and the clerk of branch A logged in.
type catalogKindFixture struct {
	ctx     context.Context
	cfg     config.Auth
	handler http.Handler
	admin   string
	clerk   string
}

// newCatalogKindFixture needs the isolated test PostgreSQL. Admission fails closed
// inside testpg.Open, exactly like every other database fixture in this repository.
func newCatalogKindFixture(t *testing.T) *catalogKindFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("catalogue kind fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("catalogue kind test provisioning failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("catalogue kind operational fixture setup failed")
	}
	service, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("catalogue kind auth fixture failed")
	}
	cfg, err := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatal("catalogue kind auth configuration failed")
	}
	base, err := httpapi.NewWithStockEntries(service, cfg, inventory.New(p), transfers.New(p),
		stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("catalogue kind base constructor failed")
	}
	pointOfSale, err := httpapi.NewWithSales(base, service, cfg, sales.New(p))
	if err != nil {
		t.Fatal("catalogue kind point-of-sale constructor failed")
	}
	handler, err := httpapi.NewWithOtherProducts(pointOfSale, service, cfg, otherproducts.New(p, service))
	if err != nil {
		t.Fatal("catalogue kind catalogue constructor failed")
	}
	f := &catalogKindFixture{ctx: ctx, cfg: cfg, handler: handler}
	for i := range credentials {
		_, token, err := service.Login(ctx, credentials[i].Username, credentials[i].Password,
			fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("catalogue kind login failed")
		}
		// Account 1 is the warehouse administrator, account 2 the clerk of branch A.
		if i == 0 {
			f.admin = token
		}
		if i == 1 {
			f.clerk = token
		}
	}
	return f
}

func (f *catalogKindFixture) request(token, verb, target, body string) *http.Request {
	r := httptest.NewRequest(verb, target, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
		r.Header.Set("X-CSRF-Token", auth.CSRF(token))
	}
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func (f *catalogKindFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("catalogue kind security headers changed")
	}
	return w
}

// kindSellableRow is the battery identity every served row must carry.
type kindSellableRow struct {
	VariantID int64  `json:"variant_id"`
	Brand     string `json:"brand"`
	Model     string `json:"model"`
	Polarity  string `json:"polarity"`
}

type kindSellablePage struct {
	Page          int               `json:"page"`
	PageSize      int               `json:"page_size"`
	TotalVariants int64             `json:"total_variants"`
	Items         []kindSellableRow `json:"items"`
}

// sellablePage serves one window of the branch A counter and refuses anything but
// the catalogue's own answer, so a 503 is a failure of this test and not a row.
func (f *catalogKindFixture) sellablePage(t *testing.T, window string) kindSellablePage {
	t.Helper()
	w := f.serve(t, f.request(f.clerk, "GET", "/api/sales/sellable?"+window, ""))
	if w.Code != 200 {
		t.Fatalf("the counter must serve %s: %d %s", window, w.Code, w.Body.String())
	}
	var page kindSellablePage
	if json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("the counter page %s is not a catalogue page: %s", window, w.Body.String())
	}
	return page
}

// assertBatteryOnly proves one window is exactly the seeded batteries: the total
// is the batteries' own count and no row arrives without the identity a battery
// row is made of.
func (f *catalogKindFixture) assertBatteryOnly(t *testing.T, window string, total int64) {
	t.Helper()
	page := f.sellablePage(t, window)
	if page.TotalVariants != total {
		t.Fatalf("%s must count %d battery variants: got %d", window, total, page.TotalVariants)
	}
	if len(page.Items) > page.PageSize {
		t.Fatalf("%s served %d rows for a page size of %d", window, len(page.Items), page.PageSize)
	}
	for _, item := range page.Items {
		if item.VariantID < 1 || item.Brand == "" || item.Model == "" ||
			(item.Polarity != "L" && item.Polarity != "R") {
			t.Fatalf("%s served a row that is not a battery: %+v", window, item)
		}
	}
}

func TestSellableCatalogueStaysBatteryOnly(t *testing.T) {
	f := newCatalogKindFixture(t)
	const seededVariants = 190 // every battery of the catalogue has two polarities
	// The counter paginates, so the product is reachable from several windows: the
	// last page is where an extra variant of the table would land.
	windows := []string{
		"page=1&page_size=50",
		"page=2&page_size=50",
		"page=3&page_size=50",
		"page=4&page_size=50",
		"page=1&page_size=10",
	}
	// Before: the seeded catalogue is batteries only, and every window agrees.
	for _, window := range windows {
		f.assertBatteryOnly(t, window, seededVariants)
	}

	// The product the catalog screen creates, through the real route: a free name,
	// one polarity-less variant — which the balance fan-out stocks with zero in
	// every branch — and the two example fields.
	created := f.serve(t, f.request(f.admin, "POST", "/api/catalog/other-products",
		`{"name":"Agua acidulada","fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"},`+
			`{"name":"origen","kind":"text","text":"importado"}]}`))
	if created.Code != 201 {
		t.Fatalf("the catalog must create the product: %d %s", created.Code, created.Body.String())
	}
	var product struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if json.Unmarshal(created.Body.Bytes(), &product) != nil || product.ID < 1 || product.Name != "Agua acidulada" {
		t.Fatalf("the created product is not the record this test asked for: %s", created.Body.String())
	}

	// After: the branch point of sale still serves exactly the batteries, on every
	// window, with no row stripped of its brand, model or polarity.
	for _, window := range windows {
		f.assertBatteryOnly(t, window, seededVariants)
	}
	// The product is never found through the battery search either.
	for _, search := range []string{"Agua", "agua acidulada", "Agua acidulada"} {
		page := f.sellablePage(t, "page=1&page_size=50&search="+url.QueryEscape(search))
		if page.TotalVariants != 0 || len(page.Items) != 0 {
			t.Fatalf("searching %q must find no battery: %+v", search, page)
		}
	}
}
