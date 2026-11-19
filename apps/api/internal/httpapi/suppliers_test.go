package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/suppliers"
	"luson/api/internal/testpg"
)

// supplierHTTPFixture mounts the supplier contract over an isolated database with
// the three provisioned accounts, so the real session authority, the real store and
// the frozen wire shapes are exercised together.
type supplierHTTPFixture struct {
	ctx    context.Context
	p      *pgxpool.Pool
	cfg    config.Auth
	tokens []string

	battery     int64
	batteryLeft int64
	batteryRght int64
	product     int64
	productOnly int64

	handler http.Handler
}

func suppliersFixture(t *testing.T) *supplierHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("supplier HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("supplier HTTP provisioning failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("supplier HTTP operational fixture setup failed")
	}
	service, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("supplier HTTP auth fixture failed")
	}
	f := &supplierHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := service.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("supplier HTTP login failed")
		}
		f.tokens[i] = token
	}
	f.battery, f.batteryLeft, f.batteryRght = f.batteryEntry(t, "NS40ZL HTTP")
	f.product, f.productOnly = f.productEntry(t, "Agua acidulada")
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("base"))
	})
	f.handler, err = NewWithSuppliers(base, service, f.cfg, suppliers.New(p))
	if err != nil {
		t.Fatal("supplier HTTP constructor failed")
	}
	return f
}

// batteryEntry writes one battery catalogue entry with its two polarities.
func (f *supplierHTTPFixture) batteryEntry(t *testing.T, model string) (int64, int64, int64) {
	t.Helper()
	var entry, left, right int64
	if err := f.p.QueryRow(f.ctx, `INSERT INTO catalog_entries(kind,brand,model,capacity_ah)
 VALUES('battery','CAR',$1,35) RETURNING id`, model).Scan(&entry); err != nil {
		t.Fatal("battery entry fixture failed")
	}
	for i, polarity := range []string{"L", "R"} {
		var variant int64
		if err := f.p.QueryRow(f.ctx, `INSERT INTO catalog_variants(catalog_entry_id,polarity)
 VALUES($1,$2) RETURNING id`, entry, polarity).Scan(&variant); err != nil {
			t.Fatal("battery variant fixture failed")
		}
		if i == 0 {
			left = variant
		} else {
			right = variant
		}
	}
	return entry, left, right
}

// productEntry writes one other-product catalogue entry with its single
// polarity-less variant.
func (f *supplierHTTPFixture) productEntry(t *testing.T, name string) (int64, int64) {
	t.Helper()
	var entry, variant int64
	if err := f.p.QueryRow(f.ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product entry fixture failed")
	}
	if err := f.p.QueryRow(f.ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`, entry).Scan(&variant); err != nil {
		t.Fatal("product variant fixture failed")
	}
	return entry, variant
}

// retireEntry retires one catalogue entry, never deleting it.
func (f *supplierHTTPFixture) retireEntry(t *testing.T, entry int64) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, `UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1`, entry); err != nil {
		t.Fatal("catalogue entry retirement fixture failed")
	}
}

// request is one request of this contract with the exact framing GuardMutation
// admits: the session cookie, the same origin, the same-origin fetch metadata and
// the CSRF token derived from the session.
func (f *supplierHTTPFixture) request(actor int, verb, path, body string) *http.Request {
	r := httptest.NewRequest(verb, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if actor > 0 {
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[actor-1]})
		r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[actor-1]))
	}
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func (f *supplierHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("supplier security headers changed")
	}
	return w
}

// snapshot captures the two tables this domain owns, so a refused request is proven
// to leave nothing behind.
func (f *supplierHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	if err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'suppliers',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM suppliers s),
  'offers',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.supplier_id,o.catalog_entry_id),'[]'::jsonb) FROM supplier_offers o))::text`).Scan(&data); err != nil {
		t.Fatal("supplier snapshot failed")
	}
	return data
}

func (f *supplierHTTPFixture) expect(t *testing.T, w *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if w.Code != status || w.Body.String() != body {
		t.Fatalf("answered %d %q, want %d %q", w.Code, w.Body.String(), status, body)
	}
}

// rejected proves a refused request answered the frozen error and stored nothing.
func (f *supplierHTTPFixture) rejected(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	if w.Code != status || w.Body.String() != fmt.Sprintf("{\"error\":%q}\n", code) || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%s %s answered %d %q, want %d %q", r.Method, r.URL.Path, w.Code, w.Body.String(), status, code)
	}
	if after := f.snapshot(t); after != before {
		t.Fatalf("%s %s changed stored state", r.Method, r.URL.Path)
	}
}

// created is one supplier creation through the contract, returning the allocated
// identity.
func (f *supplierHTTPFixture) created(t *testing.T, actor int, name, contact string) int64 {
	t.Helper()
	body := `{"name":` + quote(name) + `,"contact":` + quote(contact) + `}`
	w := f.serve(t, f.request(actor, http.MethodPost, "/api/suppliers", body))
	if w.Code != http.StatusCreated {
		t.Fatalf("create %q answered %d %s", name, w.Code, w.Body.String())
	}
	var record struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(w.Body.Bytes(), &record) != nil || record.ID < 1 {
		t.Fatalf("create %q answered %q", name, w.Body.String())
	}
	return record.ID
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// The seven routes of the frozen contract answer their exact shapes: the record,
// the page, the offer set, the assignable entries and the offered variants.
func TestSuppliersRoutesShapes(t *testing.T) {
	f := suppliersFixture(t)
	created := `{"id":1,"name":"Distribuidora Norte","contact":"555-1234"}` + "\n"

	w := f.serve(t, f.request(1, http.MethodPost, "/api/suppliers",
		`{"name":"  Distribuidora Norte  ","contact":"555-1234"}`))
	f.expect(t, w, http.StatusCreated, created)

	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers", ""))
	f.expect(t, w, http.StatusOK,
		`{"suppliers":[{"id":1,"name":"Distribuidora Norte","contact":"555-1234","retired":false,"kinds":[],"offers":0}],`+
			`"page":1,"page_size":10,"total_suppliers":1}`+"\n")

	offers := fmt.Sprintf(`{"catalog_entry_ids":[%d,%d]}`, f.battery, f.product)
	detail := fmt.Sprintf(`{"id":1,"name":"Distribuidora Norte","contact":"555-1234","retired":false,"offers":[`+
		`{"catalog_entry_id":%d,"kind":"battery","brand":"CAR","model":"NS40ZL HTTP","capacity_ah":"35"},`+
		`{"catalog_entry_id":%d,"kind":"other","name":"Agua acidulada"}],`+
		`"kinds":["battery","other"]}`, f.battery, f.product) + "\n"

	w = f.serve(t, f.request(1, http.MethodPut, "/api/suppliers/1/offers", offers))
	f.expect(t, w, http.StatusOK, detail)

	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers/1", ""))
	f.expect(t, w, http.StatusOK, detail)

	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers/catalog?kind=other&search=acidulada&page_size=10", ""))
	f.expect(t, w, http.StatusOK, fmt.Sprintf(`{"entries":[{"catalog_entry_id":%d,"kind":"other","name":"Agua acidulada"}],`+
		`"page_size":10,"total_entries":1}`+"\n", f.product))

	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers/1/catalog?kind=battery", ""))
	f.expect(t, w, http.StatusOK, fmt.Sprintf(`{"items":[`+
		`{"variant_id":%d,"kind":"battery","name":"CAR · NS40ZL HTTP","detail":"35 Ah · L",`+
		`"battery":{"brand":"CAR","model":"NS40ZL HTTP","capacity_ah":"35","polarity":"L"},"fields":null,"catalog_entry_id":%d},`+
		`{"variant_id":%d,"kind":"battery","name":"CAR · NS40ZL HTTP","detail":"35 Ah · R",`+
		`"battery":{"brand":"CAR","model":"NS40ZL HTTP","capacity_ah":"35","polarity":"R"},"fields":null,"catalog_entry_id":%d}],`+
		`"page_size":500}`+"\n", f.batteryLeft, f.battery, f.batteryRght, f.battery))

	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers/1/catalog?kind=other", ""))
	f.expect(t, w, http.StatusOK, fmt.Sprintf(`{"items":[`+
		`{"variant_id":%d,"kind":"other","name":"Agua acidulada","detail":"Agua acidulada","battery":null,"fields":[],`+
		`"catalog_entry_id":%d}],"page_size":500}`+"\n", f.productOnly, f.product))

	w = f.serve(t, f.request(1, http.MethodPatch, "/api/suppliers/1",
		`{"name":"Distribuidora Norte SA","contact":""}`))
	f.expect(t, w, http.StatusOK, `{"id":1,"name":"Distribuidora Norte SA","contact":""}`+"\n")

	// A PATCH never changes the offer set: the whole set is still there.
	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers/1", ""))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), fmt.Sprintf(`"catalog_entry_id":%d`, f.battery)) ||
		!strings.Contains(w.Body.String(), fmt.Sprintf(`"catalog_entry_id":%d`, f.product)) {
		t.Fatalf("an edit changed the offer set: %d %s", w.Code, w.Body.String())
	}

	w = f.serve(t, f.request(1, http.MethodDelete, "/api/suppliers/1", ""))
	if w.Code != http.StatusNoContent || w.Body.String() != "" {
		t.Fatalf("retire answered %d %q", w.Code, w.Body.String())
	}
	w = f.serve(t, f.request(1, http.MethodGet, "/api/suppliers", ""))
	f.expect(t, w, http.StatusOK,
		`{"suppliers":[{"id":1,"name":"Distribuidora Norte SA","contact":"","retired":true,`+
			`"kinds":["battery","other"],"offers":2}],"page":1,"page_size":10,"total_suppliers":1}`+"\n")
}

// Only the warehouse administrator is admitted; everything else is refused before
// any method, framing or body decision and before the store is asked.
func TestSuppliersAuthority(t *testing.T) {
	f := suppliersFixture(t)
	for _, c := range []struct {
		name   string
		r      *http.Request
		status int
		code   string
	}{
		{
			name:   "anonymous_read",
			r:      f.request(0, http.MethodGet, "/api/suppliers", ""),
			status: 401, code: "unauthenticated",
		},
		{
			name:   "anonymous_broken_write",
			r:      f.request(0, http.MethodPost, "/api/suppliers?page=1", "{}"),
			status: 401, code: "unauthenticated",
		},
		{
			name: "duplicate_session_cookie",
			r: func() *http.Request {
				r := f.request(1, http.MethodGet, "/api/suppliers", "")
				r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
				return r
			}(),
			status: 400, code: "invalid_request",
		},
		{
			name:   "branch_administrator_list",
			r:      f.request(2, http.MethodGet, "/api/suppliers", ""),
			status: 403, code: "forbidden",
		},
		{
			name:   "branch_administrator_create",
			r:      f.request(2, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}`),
			status: 403, code: "forbidden",
		},
		{
			name:   "branch_administrator_read",
			r:      f.request(2, http.MethodGet, "/api/suppliers/1", ""),
			status: 403, code: "forbidden",
		},
		{
			name:   "branch_administrator_offers",
			r:      f.request(2, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":[]}`),
			status: 403, code: "forbidden",
		},
		{
			name:   "branch_administrator_retire",
			r:      f.request(2, http.MethodDelete, "/api/suppliers/1", ""),
			status: 403, code: "forbidden",
		},
		{
			name:   "branch_administrator_catalog",
			r:      f.request(2, http.MethodGet, "/api/suppliers/catalog", ""),
			status: 403, code: "forbidden",
		},
		{
			name:   "branch_administrator_offered_variants",
			r:      f.request(2, http.MethodGet, "/api/suppliers/1/catalog", ""),
			status: 403, code: "forbidden",
		},
		{
			name: "missing_origin",
			r: func() *http.Request {
				r := f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}`)
				r.Header.Del("Origin")
				return r
			}(),
			status: 403, code: "forbidden",
		},
		{
			name: "foreign_origin",
			r: func() *http.Request {
				r := f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}`)
				r.Header.Set("Origin", "http://evil.example")
				return r
			}(),
			status: 403, code: "forbidden",
		},
		{
			name: "cross_site",
			r: func() *http.Request {
				r := f.request(1, http.MethodDelete, "/api/suppliers/1", "")
				r.Header.Set("Sec-Fetch-Site", "cross-site")
				return r
			}(),
			status: 403, code: "forbidden",
		},
		{
			name: "missing_csrf",
			r: func() *http.Request {
				r := f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":[]}`)
				r.Header.Del("X-CSRF-Token")
				return r
			}(),
			status: 403, code: "forbidden",
		},
		{
			name: "foreign_csrf",
			r: func() *http.Request {
				r := f.request(1, http.MethodPatch, "/api/suppliers/1", `{"name":"Distribuidora","contact":""}`)
				r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[1]))
				return r
			}(),
			status: 403, code: "forbidden",
		},
	} {
		t.Run(c.name, func(t *testing.T) { f.rejected(t, c.r, c.status, c.code) })
	}
}

// Every malformed document, query string, identity, method and body is refused
// before the store writes anything, and a write never carries a query string.
func TestSuppliersFraming(t *testing.T) {
	f := suppliersFixture(t)
	f.created(t, 1, "Norte", "555")
	long := strings.Repeat("a", 129)
	for _, c := range []struct {
		name   string
		r      *http.Request
		status int
		code   string
	}{
		{name: "short_name", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"ab","contact":""}`), status: 400, code: "invalid_request"},
		{name: "long_name", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"`+strings.Repeat("a", 65)+`","contact":""}`), status: 400, code: "invalid_request"},
		{name: "control_name", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Dis\ttribuidora","contact":""}`), status: 400, code: "invalid_request"},
		{name: "long_contact", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":"`+strings.Repeat("a", 201)+`"}`), status: 400, code: "invalid_request"},
		{name: "control_contact", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":"a\u0000b"}`), status: 400, code: "invalid_request"},
		{name: "unknown_key", r: f.request(1, http.MethodPost, "/api/suppliers", `{"id":2,"name":"Distribuidora","contact":""}`), status: 400, code: "invalid_request"},
		{name: "missing_contact", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora"}`), status: 400, code: "invalid_request"},
		{name: "missing_name", r: f.request(1, http.MethodPost, "/api/suppliers", `{"contact":""}`), status: 400, code: "invalid_request"},
		{name: "duplicate_key", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","name":"Otra","contact":""}`), status: 400, code: "invalid_request"},
		{name: "numeric_name", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":1,"contact":""}`), status: 400, code: "invalid_request"},
		{name: "null_contact", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":null}`), status: 400, code: "invalid_request"},
		{name: "array_root", r: f.request(1, http.MethodPost, "/api/suppliers", `[]`), status: 400, code: "invalid_request"},
		{name: "empty_body", r: f.request(1, http.MethodPost, "/api/suppliers", " "), status: 400, code: "invalid_request"},
		{name: "trailing_content", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}{}`), status: 400, code: "invalid_request"},
		{name: "query_on_create", r: f.request(1, http.MethodPost, "/api/suppliers?page=1", `{"name":"Distribuidora","contact":""}`), status: 400, code: "invalid_request"},
		{name: "bare_query_on_create", r: f.request(1, http.MethodPost, "/api/suppliers?", `{"name":"Distribuidora","contact":""}`), status: 400, code: "invalid_request"},
		{name: "query_on_patch", r: f.request(1, http.MethodPatch, "/api/suppliers/1?page=1", `{"name":"Distribuidora","contact":""}`), status: 400, code: "invalid_request"},
		{name: "query_on_retire", r: f.request(1, http.MethodDelete, "/api/suppliers/1?", ""), status: 400, code: "invalid_request"},
		{name: "query_on_offers", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers?page=1", `{"catalog_entry_ids":[]}`), status: 400, code: "invalid_request"},
		{name: "query_on_detail", r: f.request(1, http.MethodGet, "/api/suppliers/1?page=1", ""), status: 400, code: "invalid_request"},
		{name: "offers_zero_id", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":[0]}`), status: 400, code: "invalid_request"},
		{name: "offers_negative_id", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":[-1]}`), status: 400, code: "invalid_request"},
		{name: "offers_string_id", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":["1"]}`), status: 400, code: "invalid_request"},
		{name: "offers_object", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":{}}`), status: 400, code: "invalid_request"},
		{name: "offers_null", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":null}`), status: 400, code: "invalid_request"},
		{name: "offers_missing", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{}`), status: 400, code: "invalid_request"},
		{name: "offers_unknown_key", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":[],"supplier_id":1}`), status: 400, code: "invalid_request"},
		{name: "offers_duplicate_key", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers", `{"catalog_entry_ids":[],"catalog_entry_ids":[]}`), status: 400, code: "invalid_request"},
		{name: "offers_too_many", r: f.request(1, http.MethodPut, "/api/suppliers/1/offers",
			`{"catalog_entry_ids":[`+strings.Repeat("1,", supplierMaxOffers)+`1]}`), status: 400, code: "invalid_request"},
		{name: "query_unknown_key", r: f.request(1, http.MethodGet, "/api/suppliers?search=Norte", ""), status: 400, code: "invalid_request"},
		{name: "query_duplicate_key", r: f.request(1, http.MethodGet, "/api/suppliers?page=1&page=2", ""), status: 400, code: "invalid_request"},
		{name: "query_empty_value", r: f.request(1, http.MethodGet, "/api/suppliers?page=", ""), status: 400, code: "invalid_request"},
		{name: "query_zero_page", r: f.request(1, http.MethodGet, "/api/suppliers?page=0", ""), status: 400, code: "invalid_request"},
		{name: "query_padded_page", r: f.request(1, http.MethodGet, "/api/suppliers?page=01", ""), status: 400, code: "invalid_request"},
		{name: "query_page_size", r: f.request(1, http.MethodGet, "/api/suppliers?page_size=15", ""), status: 400, code: "invalid_request"},
		{name: "catalog_all_kind", r: f.request(1, http.MethodGet, "/api/suppliers/catalog?kind=all", ""), status: 400, code: "invalid_request"},
		{name: "catalog_unknown_kind", r: f.request(1, http.MethodGet, "/api/suppliers/catalog?kind=Battery", ""), status: 400, code: "invalid_request"},
		{name: "catalog_long_search", r: f.request(1, http.MethodGet, "/api/suppliers/catalog?search="+long, ""), status: 400, code: "invalid_request"},
		{name: "catalog_page", r: f.request(1, http.MethodGet, "/api/suppliers/catalog?page=2", ""), status: 400, code: "invalid_request"},
		{name: "offered_all_kind", r: f.request(1, http.MethodGet, "/api/suppliers/1/catalog?kind=all", ""), status: 400, code: "invalid_request"},
		{name: "offered_page_size", r: f.request(1, http.MethodGet, "/api/suppliers/1/catalog?page_size=10", ""), status: 400, code: "invalid_request"},
		{name: "zero_id", r: f.request(1, http.MethodGet, "/api/suppliers/0", ""), status: 400, code: "invalid_request"},
		{name: "padded_id", r: f.request(1, http.MethodGet, "/api/suppliers/01", ""), status: 400, code: "invalid_request"},
		{name: "signed_id", r: f.request(1, http.MethodGet, "/api/suppliers/+1", ""), status: 400, code: "invalid_request"},
		{name: "fraction_id", r: f.request(1, http.MethodGet, "/api/suppliers/1.0", ""), status: 400, code: "invalid_request"},
		{name: "text_id", r: f.request(1, http.MethodGet, "/api/suppliers/norte", ""), status: 400, code: "invalid_request"},
		{name: "overflow_id", r: f.request(1, http.MethodGet, "/api/suppliers/99999999999999999999", ""), status: 400, code: "invalid_request"},
	} {
		t.Run(c.name, func(t *testing.T) { f.rejected(t, c.r, c.status, c.code) })
	}
	// A non-JSON content type and two content types are never an alias for JSON.
	r := f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}`)
	r.Header.Set("Content-Type", "text/plain")
	f.rejected(t, r, 400, "invalid_request")
	r = f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}`)
	r.Header.Add("Content-Type", "application/json")
	f.rejected(t, r, 400, "invalid_request")
	r = f.request(1, http.MethodPost, "/api/suppliers", `{"name":"Distribuidora","contact":""}`)
	r.Header.Del("Content-Type")
	f.rejected(t, r, 400, "invalid_request")

	for _, c := range []struct {
		method, target, allow string
	}{
		{http.MethodPut, "/api/suppliers", "GET, POST"},
		{http.MethodDelete, "/api/suppliers", "GET, POST"},
		{http.MethodPost, "/api/suppliers/catalog", "GET"},
		{http.MethodPut, "/api/suppliers/1", "GET, PATCH, DELETE"},
		{http.MethodPost, "/api/suppliers/1", "GET, PATCH, DELETE"},
		{http.MethodGet, "/api/suppliers/1/offers", "PUT"},
		{http.MethodPost, "/api/suppliers/1/catalog", "GET"},
	} {
		w := f.serve(t, f.request(1, c.method, c.target, ""))
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != c.allow {
			t.Fatalf("%s %s answered %d with Allow %q", c.method, c.target, w.Code, w.Header().Get("Allow"))
		}
	}
}

// The database's own rules reach the wire with their frozen codes: a duplicate
// active name and a repeated retirement are conflicts, a retired or unknown
// supplier is a lookup, and a retired or unknown catalogue entry is a rejected
// request.
func TestSuppliersConflicts(t *testing.T) {
	f := suppliersFixture(t)
	norte := f.created(t, 1, "Norte", "555")
	sur := f.created(t, 1, "Sur", "")
	retiredEntry, _ := f.productEntry(t, "Agua retirada")
	f.retireEntry(t, retiredEntry)

	for _, c := range []struct {
		name   string
		r      *http.Request
		status int
		code   string
	}{
		{name: "duplicate_create", r: f.request(1, http.MethodPost, "/api/suppliers", `{"name":" norte ","contact":""}`), status: 409, code: "conflict"},
		{name: "duplicate_rename", r: f.request(1, http.MethodPatch, fmt.Sprintf("/api/suppliers/%d", sur), `{"name":"NORTE","contact":""}`), status: 409, code: "conflict"},
		{name: "retired_entry", r: f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", norte), fmt.Sprintf(`{"catalog_entry_ids":[%d]}`, retiredEntry)), status: 400, code: "invalid_request"},
		{name: "unknown_entry", r: f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", norte), `{"catalog_entry_ids":[1073741824]}`), status: 400, code: "invalid_request"},
		{name: "unknown_supplier_read", r: f.request(1, http.MethodGet, "/api/suppliers/999", ""), status: 404, code: "not_found"},
		{name: "unknown_supplier_edit", r: f.request(1, http.MethodPatch, "/api/suppliers/999", `{"name":"Otra","contact":""}`), status: 404, code: "not_found"},
		{name: "unknown_supplier_retire", r: f.request(1, http.MethodDelete, "/api/suppliers/999", ""), status: 404, code: "not_found"},
		{name: "unknown_supplier_offers", r: f.request(1, http.MethodPut, "/api/suppliers/999/offers", `{"catalog_entry_ids":[]}`), status: 404, code: "not_found"},
		{name: "unknown_supplier_variants", r: f.request(1, http.MethodGet, "/api/suppliers/999/catalog", ""), status: 404, code: "not_found"},
	} {
		t.Run(c.name, func(t *testing.T) { f.rejected(t, c.r, c.status, c.code) })
	}

	// A retired supplier is refused: assignments and the ingress picker are closed,
	// while its own detail stays readable and marked.
	w := f.serve(t, f.request(1, http.MethodDelete, fmt.Sprintf("/api/suppliers/%d", norte), ""))
	if w.Code != http.StatusNoContent {
		t.Fatalf("retire answered %d", w.Code)
	}
	w = f.serve(t, f.request(1, http.MethodGet, fmt.Sprintf("/api/suppliers/%d", norte), ""))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"retired":true`) {
		t.Fatalf("a retired supplier must stay readable: %d %s", w.Code, w.Body.String())
	}
	for _, c := range []struct {
		name   string
		r      *http.Request
		status int
		code   string
	}{
		{name: "retired_retire", r: f.request(1, http.MethodDelete, fmt.Sprintf("/api/suppliers/%d", norte), ""), status: 409, code: "conflict"},
		{name: "retired_edit", r: f.request(1, http.MethodPatch, fmt.Sprintf("/api/suppliers/%d", norte), `{"name":"Otra","contact":""}`), status: 404, code: "not_found"},
		{name: "retired_offers", r: f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", norte), `{"catalog_entry_ids":[]}`), status: 409, code: "conflict"},
		{name: "retired_variants", r: f.request(1, http.MethodGet, fmt.Sprintf("/api/suppliers/%d/catalog", norte), ""), status: 409, code: "conflict"},
	} {
		t.Run(c.name, func(t *testing.T) {
			before := f.snapshot(t)
			w := f.serve(t, c.r)
			if w.Code != c.status || w.Body.String() != fmt.Sprintf("{\"error\":%q}\n", c.code) {
				t.Fatalf("%s answered %d %q", c.name, w.Code, w.Body.String())
			}
			if after := f.snapshot(t); after != before {
				t.Fatalf("%s changed stored state", c.name)
			}
		})
	}
	// The retired name is free again for a new, active supplier.
	f.created(t, 1, "Norte", "")
}

// The assignment is entry level and it replaces the whole set: one offered battery
// entry becomes every one of its variants in the ingress picker, and the picker of
// one supplier never shows another supplier's offers.
func TestSuppliersAssignmentReplacesTheWholeSet(t *testing.T) {
	f := suppliersFixture(t)
	first := f.created(t, 1, "Distribuidora Norte", "")
	second := f.created(t, 1, "Distribuidora Sur", "")

	w := f.serve(t, f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", first),
		fmt.Sprintf(`{"catalog_entry_ids":[%d]}`, f.battery)))
	if w.Code != http.StatusOK {
		t.Fatalf("assign answered %d %s", w.Code, w.Body.String())
	}
	variants := func(supplier int64) []map[string]any {
		t.Helper()
		w := f.serve(t, f.request(1, http.MethodGet, fmt.Sprintf("/api/suppliers/%d/catalog", supplier), ""))
		if w.Code != http.StatusOK {
			t.Fatalf("picker answered %d %s", w.Code, w.Body.String())
		}
		var page struct {
			Items    []map[string]any `json:"items"`
			PageSize int              `json:"page_size"`
		}
		if json.Unmarshal(w.Body.Bytes(), &page) != nil || page.PageSize != suppliers.OfferedVariantsPageSize {
			t.Fatalf("picker body %s", w.Body.String())
		}
		return page.Items
	}
	items := variants(first)
	if len(items) != 2 {
		t.Fatalf("one offered battery must expand to its variants: %v", items)
	}
	for i, want := range []int64{f.batteryLeft, f.batteryRght} {
		if int64(items[i]["variant_id"].(float64)) != want ||
			int64(items[i]["catalog_entry_id"].(float64)) != f.battery ||
			items[i]["kind"] != "battery" {
			t.Fatalf("variant %d = %v", i, items[i])
		}
		if _, leaked := items[i]["existing"]; leaked {
			t.Fatalf("the ingress picker leaked a stock number: %v", items[i])
		}
	}
	if other := variants(second); other == nil || len(other) != 0 {
		t.Fatalf("a supplier without offers published variants: %v", other)
	}

	// The replacement is the whole set, and an empty list is the state of a supplier
	// that offers nothing.
	w = f.serve(t, f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", first),
		fmt.Sprintf(`{"catalog_entry_ids":[%d,%d,%d]}`, f.battery, f.product, f.product)))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"offers":[`) {
		t.Fatalf("replace answered %d %s", w.Code, w.Body.String())
	}
	w = f.serve(t, f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", first), `{"catalog_entry_ids":[]}`))
	if w.Code != http.StatusOK {
		t.Fatalf("clear answered %d %s", w.Code, w.Body.String())
	}
	var detail struct {
		Offers []map[string]any `json:"offers"`
		Kinds  []string         `json:"kinds"`
	}
	if json.Unmarshal(w.Body.Bytes(), &detail) != nil || detail.Offers == nil || len(detail.Offers) != 0 ||
		detail.Kinds == nil || len(detail.Kinds) != 0 {
		t.Fatalf("a cleared supplier answered %s", w.Body.String())
	}
	if items := variants(first); len(items) != 0 {
		t.Fatalf("a cleared supplier still published variants: %v", items)
	}
}

// Only the collection, its one-segment identity and the two fixed sub-resources
// belong to this contract: an ambiguous path is not_found before any handler runs
// and every other path is forwarded untouched.
func TestSuppliersPathSafety(t *testing.T) {
	for _, c := range []struct {
		target string
		want   bool
	}{
		{"/api/suppliers", true},
		{"/api/suppliers/1", true},
		{"/api/suppliers/1/offers", true},
		{"/api/suppliers/1/catalog", true},
		{"/api/suppliers/catalog", true},
		{"/api/suppliers//1", false},
		{"/api/suppliers/./1", false},
		{"/api/suppliers/1/..", false},
		{"/api/suppliers%2F1", false},
		{"/api/suppliers/1%00", false},
		{"/api/suppliers/1\\", false},
		{"/api/supplier", true},
		{"/api/suppliersX", true},
		{"/api/stock-entries", true},
	} {
		r := httptest.NewRequest(http.MethodGet, c.target, nil)
		if got := supplierPath(r); got != c.want {
			t.Fatalf("supplierPath(%q) = %v, want %v", c.target, got, c.want)
		}
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{"/api/suppliers", true},
		{"/api/suppliers/1", true},
		{"/api/suppliersX", false},
		{"/api/catalog/batteries", false},
	} {
		if got := supplierRoute(c.path); got != c.want {
			t.Fatalf("supplierRoute(%q) = %v, want %v", c.path, got, c.want)
		}
	}

	f := suppliersFixture(t)
	w := f.serve(t, f.request(1, http.MethodGet, "/api/suppliers//1", ""))
	if w.Code != http.StatusNotFound || w.Body.String() != `{"error":"not_found"}`+"\n" {
		t.Fatalf("an ambiguous path answered %d %q", w.Code, w.Body.String())
	}
	w = f.serve(t, f.request(0, http.MethodGet, "/api/stock-entries", ""))
	if w.Code != http.StatusTeapot || w.Body.String() != "base" {
		t.Fatalf("a foreign path was not forwarded: %d %q", w.Code, w.Body.String())
	}
	for _, target := range []string{"/api/suppliers/1/more", "/api/suppliers/catalog/1", "/api/suppliers/1/offers/x"} {
		w = f.serve(t, f.request(1, http.MethodGet, target, ""))
		if w.Code != http.StatusNotFound || w.Body.String() != `{"error":"not_found"}`+"\n" {
			t.Fatalf("an unknown route %q answered %d %q", target, w.Code, w.Body.String())
		}
	}
}

// The composed constructor refuses an incomplete composition before it mounts
// anything.
func TestSuppliersMountValidation(t *testing.T) {
	service, err := auth.New(nil, nil)
	if err != nil {
		t.Fatalf("authentication service: %v", err)
	}
	cfg := transferConfig(t)
	base := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	store := suppliers.New(nil)
	if _, err := NewWithSuppliers(nil, service, cfg, store); !errors.Is(err, suppliers.ErrUnavailable) {
		t.Fatal("mounted without a base handler")
	}
	if _, err := NewWithSuppliers(base, nil, cfg, store); !errors.Is(err, suppliers.ErrUnavailable) {
		t.Fatal("mounted without an authentication service")
	}
	if _, err := NewWithSuppliers(base, service, cfg, nil); !errors.Is(err, suppliers.ErrUnavailable) {
		t.Fatal("mounted without a store")
	}
	if _, err := NewWithSuppliers(base, service, config.Auth{Origin: "http://evil.example"}, store); !errors.Is(err, suppliers.ErrUnavailable) {
		t.Fatal("mounted with an inadmissible configuration")
	}
	if _, err := NewWithSuppliers(base, service, cfg, store); err != nil {
		t.Fatalf("refused the complete composition: %v", err)
	}
}

// The list is paged with the active suppliers first by name and the retired ones
// last, each row marked and carrying its derived kinds and offer count.
func TestSuppliersListOrdering(t *testing.T) {
	f := suppliersFixture(t)
	bravo := f.created(t, 1, "Bravo", "")
	alfa := f.created(t, 1, "alfa", "")
	if w := f.serve(t, f.request(1, http.MethodPut, fmt.Sprintf("/api/suppliers/%d/offers", bravo),
		fmt.Sprintf(`{"catalog_entry_ids":[%d]}`, f.product))); w.Code != http.StatusOK {
		t.Fatalf("assign answered %d", w.Code)
	}
	if w := f.serve(t, f.request(1, http.MethodDelete, fmt.Sprintf("/api/suppliers/%d", alfa), "")); w.Code != http.StatusNoContent {
		t.Fatalf("retire answered %d", w.Code)
	}
	w := f.serve(t, f.request(1, http.MethodGet, "/api/suppliers?page=1&page_size=10", ""))
	var page struct {
		Suppliers []struct {
			ID      int64    `json:"id"`
			Name    string   `json:"name"`
			Retired bool     `json:"retired"`
			Kinds   []string `json:"kinds"`
			Offers  int64    `json:"offers"`
		} `json:"suppliers"`
		Page           int   `json:"page"`
		PageSize       int   `json:"page_size"`
		TotalSuppliers int64 `json:"total_suppliers"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("list answered %d %s", w.Code, w.Body.String())
	}
	if page.Page != 1 || page.PageSize != 10 || page.TotalSuppliers != 2 || len(page.Suppliers) != 2 {
		t.Fatalf("page = %+v", page)
	}
	if page.Suppliers[0].ID != bravo || page.Suppliers[0].Retired || len(page.Suppliers[0].Kinds) != 1 ||
		page.Suppliers[0].Kinds[0] != "other" || page.Suppliers[0].Offers != 1 {
		t.Fatalf("first row = %+v", page.Suppliers[0])
	}
	if page.Suppliers[1].ID != alfa || !page.Suppliers[1].Retired || page.Suppliers[1].Offers != 0 {
		t.Fatalf("second row = %+v", page.Suppliers[1])
	}
}
