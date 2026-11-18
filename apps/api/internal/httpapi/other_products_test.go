package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/otherproducts"
)

const (
	otherProductOrigin  = "http://localhost:8080"
	otherProductSession = "0123456789012345678901234567890123456789012"
)

// otherProductsStub is the catalog authority the surface is mounted with, so the
// routes, the gate, the framing and the error table are exercised without a
// database. Every call is counted: a refusal before the store must never reach it.
type otherProductsStub struct {
	gate error

	page    otherproducts.Page
	product otherproducts.Product

	listErr   error
	createErr error
	editErr   error
	retireErr error

	listCalls   int
	createCalls int
	editCalls   int
	retireCalls int

	query  otherproducts.Query
	create otherproducts.CreateInput
	edit   otherproducts.EditInput
	id     int64
}

func (s *otherProductsStub) Administrator(context.Context, string) error { return s.gate }

func (s *otherProductsStub) List(_ context.Context, _ string, query otherproducts.Query) (otherproducts.Page, error) {
	s.listCalls++
	s.query = query
	return s.page, s.listErr
}

func (s *otherProductsStub) Create(_ context.Context, _ string, in otherproducts.CreateInput) (otherproducts.Product, error) {
	s.createCalls++
	s.create = in
	return s.product, s.createErr
}

func (s *otherProductsStub) Edit(_ context.Context, _ string, id int64, in otherproducts.EditInput) (otherproducts.Product, error) {
	s.editCalls++
	s.id = id
	s.edit = in
	return s.product, s.editErr
}

func (s *otherProductsStub) Retire(_ context.Context, _ string, id int64) error {
	s.retireCalls++
	s.id = id
	return s.retireErr
}

// otherProductsRequest builds one request of this contract. The session cookie,
// the same origin and the CSRF token are the exact framing GuardMutation admits.
func otherProductsRequest(method, target, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}

func otherProductsAuthenticate(r *http.Request) *http.Request {
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: otherProductSession})
	r.Header.Set("Origin", otherProductOrigin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("X-CSRF-Token", auth.CSRF(otherProductSession))
	return r
}

func otherProductsWrite(method, target, body string) *http.Request {
	return otherProductsAuthenticate(otherProductsRequest(method, target, body))
}

// otherProductsHandler mounts the contract on a base handler that answers a
// recognizable 418, so forwarding is observable.
func otherProductsHandler(t *testing.T, store OtherProducts) http.Handler {
	t.Helper()
	service, err := auth.New(nil, nil)
	if err != nil {
		t.Fatalf("authentication service: %v", err)
	}
	cfg, err := config.ParseAuth(config.LocalTrial, otherProductOrigin, "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatalf("auth configuration: %v", err)
	}
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("base"))
	})
	handler, err := NewWithOtherProducts(base, service, cfg, store)
	if err != nil {
		t.Fatalf("mount: %v", err)
	}
	return handler
}

func otherProductsServe(t *testing.T, handler http.Handler, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func otherProductDecimal(value string) *catalog.Decimal {
	parsed := catalog.Decimal(value)
	return &parsed
}

func otherProductValue(value string) *string { return &value }

// otherProductExample is the product of the Contract: a free name and two typed
// fields, one numeric with a unit and one textual.
func otherProductExample() otherproducts.Product {
	return otherproducts.Product{
		ID:   113,
		Name: "Agua acidulada",
		Fields: []otherproducts.Field{
			{Name: "volumen en L", Kind: otherproducts.KindNumber, Unit: "L", Number: otherProductDecimal("5")},
			{Name: "origen", Kind: otherproducts.KindText, Text: otherProductValue("importado")},
		},
	}
}

const otherProductExampleJSON = `{"id":113,"name":"Agua acidulada","fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"},{"name":"origen","kind":"text","text":"importado"}]}`

const otherProductExampleBody = `{"name":"Agua acidulada","fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"},{"name":"origen","kind":"text","text":"importado"}]}`

// The four routes of the Contract answer the record, the page and the empty
// retirement exactly, and every response is Cache-Control: no-store.
func TestOtherProductsRoutes(t *testing.T) {
	stub := &otherProductsStub{
		product: otherProductExample(),
		page: otherproducts.Page{
			Products: []otherproducts.Product{otherProductExample()},
			Page:     1,
			PageSize: 10,
			Total:    1,
		},
	}
	handler := otherProductsHandler(t, stub)

	for _, c := range []struct {
		name   string
		r      *http.Request
		status int
		body   string
	}{
		{
			name:   "list",
			r:      otherProductsWrite(http.MethodGet, otherProductRoutePath, ""),
			status: 200,
			body:   `{"products":[` + otherProductExampleJSON + `],"page":1,"page_size":10,"total_products":1}` + "\n",
		},
		{
			name:   "create",
			r:      otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody),
			status: 201,
			body:   otherProductExampleJSON + "\n",
		},
		{
			name:   "edit",
			r:      otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/113", otherProductExampleBody),
			status: 200,
			body:   otherProductExampleJSON + "\n",
		},
		{
			name:   "retire",
			r:      otherProductsWrite(http.MethodDelete, otherProductRoutePath+"/113", ""),
			status: 204,
			body:   "",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := otherProductsServe(t, handler, c.r)
			if w.Code != c.status || w.Body.String() != c.body {
				t.Fatalf("%s answered %d %q, want %d %q", c.name, w.Code, w.Body.String(), c.status, c.body)
			}
			if got := w.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("%s Cache-Control = %q, want no-store", c.name, got)
			}
		})
	}
	if stub.createCalls != 1 || stub.create.Name != "Agua acidulada" || len(stub.create.Fields) != 2 ||
		stub.create.Fields[1].Kind != otherproducts.KindText || stub.create.Fields[1].Text == nil ||
		*stub.create.Fields[1].Text != "importado" {
		t.Fatalf("creation reached the store as %v", stub.create)
	}
	if stub.editCalls != 1 || stub.id != 113 || stub.edit.Name != "Agua acidulada" || len(stub.edit.Fields) != 2 {
		t.Fatalf("edit reached the store as %d %v", stub.id, stub.edit)
	}
	if stub.retireCalls != 1 || stub.id != 113 {
		t.Fatalf("retirement reached the store as %d", stub.id)
	}
}

// The read filter is the price matrix's own page contract: the defaults when
// nothing is asked, and each admitted parameter on its own.
func TestOtherProductsListQuery(t *testing.T) {
	stub := &otherProductsStub{page: otherproducts.Page{Products: []otherproducts.Product{}, Page: 1, PageSize: 10}}
	handler := otherProductsHandler(t, stub)
	for _, c := range []struct {
		target string
		want   otherproducts.Query
	}{
		{otherProductRoutePath, otherproducts.Query{Page: 1, PageSize: 10}},
		{otherProductRoutePath + "?search=Agua", otherproducts.Query{Search: "Agua", Page: 1, PageSize: 10}},
		{otherProductRoutePath + "?search=agua%20acidulada", otherproducts.Query{Search: "agua acidulada", Page: 1, PageSize: 10}},
		{otherProductRoutePath + "?page=2&page_size=25", otherproducts.Query{Page: 2, PageSize: 25}},
		{otherProductRoutePath + "?page_size=50", otherproducts.Query{Page: 1, PageSize: 50}},
	} {
		w := otherProductsServe(t, handler, otherProductsWrite(http.MethodGet, c.target, ""))
		if w.Code != 200 {
			t.Fatalf("%s answered %d %s", c.target, w.Code, w.Body.String())
		}
		if stub.query != c.want {
			t.Fatalf("%s reached the store as %v, want %v", c.target, stub.query, c.want)
		}
	}
}

// The search bound is the number of runes the shipped client already bounds by, not
// the number of bytes: one accented rune is two bytes in UTF-8, so a legitimate
// 128-rune search of 256 bytes was refused for a bound the client and the server
// state as runes. Only the 129th rune is inadmissible.
func TestOtherProductsSearchBoundIsRunes(t *testing.T) {
	stub := &otherProductsStub{page: otherproducts.Page{Products: []otherproducts.Product{}, Page: 1, PageSize: 10}}
	handler := otherProductsHandler(t, stub)
	admitted := strings.Repeat("ñ", otherProductMaxSearch)
	w := otherProductsServe(t, handler,
		otherProductsWrite(http.MethodGet, otherProductRoutePath+"?search="+url.QueryEscape(admitted), ""))
	if w.Code != 200 {
		t.Fatalf("a %d-rune search of %d bytes must be admitted: %d %s", otherProductMaxSearch, len(admitted), w.Code, w.Body.String())
	}
	if stub.query.Search != admitted || stub.query.Page != 1 || stub.query.PageSize != 10 || stub.listCalls != 1 {
		t.Fatalf("the admitted search reached the store as %v", stub.query)
	}
	refused := strings.Repeat("ñ", otherProductMaxSearch+1)
	w = otherProductsServe(t, handler,
		otherProductsWrite(http.MethodGet, otherProductRoutePath+"?search="+url.QueryEscape(refused), ""))
	if w.Code != 400 || w.Body.String() != `{"error":"invalid_request"}`+"\n" || stub.listCalls != 1 {
		t.Fatalf("a %d-rune search must be refused before the store: %d %s", otherProductMaxSearch+1, w.Code, w.Body.String())
	}
}

// The administration gate precedes every method, framing and body decision: an
// anonymous caller is unauthenticated even when the request is otherwise broken,
// and the store is never asked.
func TestOtherProductsGate(t *testing.T) {
	stub := &otherProductsStub{product: otherProductExample()}
	handler := otherProductsHandler(t, stub)
	for _, c := range []struct {
		name   string
		gate   error
		r      *http.Request
		status int
		body   string
	}{
		{
			name:   "anonymous_read",
			r:      otherProductsRequest(http.MethodGet, otherProductRoutePath, ""),
			status: 401,
			body:   `{"error":"unauthenticated"}` + "\n",
		},
		{
			name:   "anonymous_broken_write",
			r:      otherProductsRequest(http.MethodPost, otherProductRoutePath+"?page=1", "{}"),
			status: 401,
			body:   `{"error":"unauthenticated"}` + "\n",
		},
		{
			name: "duplicate_session_cookie",
			r: func() *http.Request {
				r := otherProductsWrite(http.MethodGet, otherProductRoutePath, "")
				r.AddCookie(&http.Cookie{Name: sessionCookie, Value: otherProductSession})
				return r
			}(),
			status: 400,
			body:   `{"error":"invalid_request"}` + "\n",
		},
		{
			name:   "branch_administrator",
			gate:   auth.ErrAdminForbidden,
			r:      otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody),
			status: 403,
			body:   `{"error":"forbidden"}` + "\n",
		},
		{
			name:   "unknown_session",
			gate:   auth.ErrSession,
			r:      otherProductsWrite(http.MethodGet, otherProductRoutePath, ""),
			status: 401,
			body:   `{"error":"unauthenticated"}` + "\n",
		},
		{
			name:   "rate_limited",
			gate:   auth.ErrLimited,
			r:      otherProductsWrite(http.MethodGet, otherProductRoutePath, ""),
			status: 429,
			body:   `{"error":"rate_limited"}` + "\n",
		},
		{
			name:   "authority_unavailable",
			gate:   errors.New("authority unavailable"),
			r:      otherProductsWrite(http.MethodGet, otherProductRoutePath, ""),
			status: 503,
			body:   `{"error":"service_unavailable"}` + "\n",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			stub.gate = c.gate
			w := otherProductsServe(t, handler, c.r)
			if w.Code != c.status || w.Body.String() != c.body {
				t.Fatalf("%s answered %d %q, want %d %q", c.name, w.Code, w.Body.String(), c.status, c.body)
			}
		})
	}
	if stub.listCalls != 0 || stub.createCalls != 0 || stub.editCalls != 0 || stub.retireCalls != 0 {
		t.Fatalf("a refused caller reached the store: %d %d %d %d",
			stub.listCalls, stub.createCalls, stub.editCalls, stub.retireCalls)
	}
}

// The same-origin and CSRF guard, the query-string refusal, the method and the id
// are all decided before the store is asked and before any body is read.
func TestOtherProductsWriteGuards(t *testing.T) {
	stub := &otherProductsStub{product: otherProductExample()}
	handler := otherProductsHandler(t, stub)
	for _, c := range []struct {
		name string
		r    *http.Request
	}{
		{name: "missing_origin", r: func() *http.Request {
			r := otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody)
			r.Header.Del("Origin")
			return r
		}()},
		{name: "foreign_origin", r: func() *http.Request {
			r := otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody)
			r.Header.Set("Origin", "http://evil.example")
			return r
		}()},
		{name: "cross_site", r: func() *http.Request {
			r := otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody)
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			return r
		}()},
		{name: "missing_csrf", r: func() *http.Request {
			r := otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody)
			r.Header.Del("X-CSRF-Token")
			return r
		}()},
		{name: "foreign_csrf", r: func() *http.Request {
			r := otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody)
			r.Header.Set("X-CSRF-Token", auth.CSRF("another-session-token-0123456789012345678"))
			return r
		}()},
		{name: "query_on_create", r: otherProductsWrite(http.MethodPost, otherProductRoutePath+"?page=1", otherProductExampleBody)},
		{name: "bare_query_on_create", r: otherProductsWrite(http.MethodPost, otherProductRoutePath+"?", otherProductExampleBody)},
		{name: "query_on_edit", r: otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/113?page=1", otherProductExampleBody)},
		{name: "bare_query_on_edit", r: otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/113?", otherProductExampleBody)},
		{name: "query_on_retire", r: otherProductsWrite(http.MethodDelete, otherProductRoutePath+"/113?page=1", "")},
		{name: "unknown_query_key", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?brand=TOYO", "")},
		{name: "duplicate_query_key", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?page=1&page=2", "")},
		{name: "empty_query_value", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?search=", "")},
		{name: "zero_page", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?page=0", "")},
		{name: "padded_page", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?page=01", "")},
		{name: "page_bound", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?page=1000001", "")},
		{name: "bad_page_size", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?page_size=15", "")},
		{name: "long_search", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"?search="+strings.Repeat("a", otherProductMaxSearch+1), "")},
		{name: "put_on_collection", r: otherProductsWrite(http.MethodPut, otherProductRoutePath, otherProductExampleBody)},
		{name: "get_on_item", r: otherProductsWrite(http.MethodGet, otherProductRoutePath+"/113", "")},
		{name: "put_on_item", r: otherProductsWrite(http.MethodPut, otherProductRoutePath+"/113", otherProductExampleBody)},
		{name: "zero_id", r: otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/0", otherProductExampleBody)},
		{name: "padded_id", r: otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/0113", otherProductExampleBody)},
		{name: "signed_id", r: otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/+113", otherProductExampleBody)},
		{name: "fraction_id", r: otherProductsWrite(http.MethodPatch, otherProductRoutePath+"/113.0", otherProductExampleBody)},
		{name: "text_id", r: otherProductsWrite(http.MethodDelete, otherProductRoutePath+"/agua", "")},
		{name: "id_bound", r: otherProductsWrite(http.MethodDelete, otherProductRoutePath+"/2147483648", "")},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := otherProductsServe(t, handler, c.r)
			switch w.Code {
			case 400:
				if w.Body.String() != `{"error":"invalid_request"}`+"\n" {
					t.Fatalf("%s answered %q", c.name, w.Body.String())
				}
			case 403:
				if w.Body.String() != `{"error":"forbidden"}`+"\n" {
					t.Fatalf("%s answered %q", c.name, w.Body.String())
				}
			case 405:
				if w.Header().Get("Allow") == "" {
					t.Fatalf("%s answered 405 without an Allow header", c.name)
				}
			default:
				t.Fatalf("%s answered %d %s", c.name, w.Code, w.Body.String())
			}
		})
	}
	if stub.listCalls != 0 || stub.createCalls != 0 || stub.editCalls != 0 || stub.retireCalls != 0 {
		t.Fatalf("a refused request reached the store: %d %d %d %d",
			stub.listCalls, stub.createCalls, stub.editCalls, stub.retireCalls)
	}
}

// The catalog's own refusals, and the administration surface's own refusals, keep
// their frozen codes through this contract's mapping.
func TestOtherProductsFailureCodes(t *testing.T) {
	for _, c := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"invalid_request", otherproducts.ErrInvalid, 400, `{"error":"invalid_request"}` + "\n"},
		{"unauthenticated", auth.ErrSession, 401, `{"error":"unauthenticated"}` + "\n"},
		{"forbidden", otherproducts.ErrForbidden, 403, `{"error":"forbidden"}` + "\n"},
		{"admin_forbidden", auth.ErrAdminForbidden, 403, `{"error":"forbidden"}` + "\n"},
		{"not_found", otherproducts.ErrNotFound, 404, `{"error":"not_found"}` + "\n"},
		{"conflict", otherproducts.ErrConflict, 409, `{"error":"conflict"}` + "\n"},
		{"has_stock", otherproducts.ErrHasStock, 409, `{"error":"catalog_product_has_stock"}` + "\n"},
		{"has_pending", otherproducts.ErrHasPending, 409, `{"error":"catalog_product_has_pending"}` + "\n"},
		{"rate_limited", auth.ErrLimited, 429, `{"error":"rate_limited"}` + "\n"},
		{"unavailable", otherproducts.ErrUnavailable, 503, `{"error":"service_unavailable"}` + "\n"},
		{"unknown", errors.New("boom"), 503, `{"error":"service_unavailable"}` + "\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			otherProductFailure(w, c.err)
			if w.Code != c.status || w.Body.String() != c.body {
				t.Fatalf("%v answered %d %q, want %d %q", c.err, w.Code, w.Body.String(), c.status, c.body)
			}
			if got := w.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("refusal content type %q", got)
			}
		})
	}
	// A refusal the store reports reaches the caller through the route unchanged.
	stub := &otherProductsStub{createErr: otherproducts.ErrHasStock}
	handler := otherProductsHandler(t, stub)
	w := otherProductsServe(t, handler, otherProductsWrite(http.MethodPost, otherProductRoutePath, otherProductExampleBody))
	if w.Code != 409 || w.Body.String() != `{"error":"catalog_product_has_stock"}`+"\n" || stub.createCalls != 1 {
		t.Fatalf("store refusal answered %d %q after %d calls", w.Code, w.Body.String(), stub.createCalls)
	}
}

// Only the collection and its one-segment identity belong to this contract. An
// ambiguous path is not_found before the handler runs, and every other path is
// forwarded untouched.
func TestOtherProductsPathSafety(t *testing.T) {
	for _, c := range []struct {
		target string
		want   bool
	}{
		{"/api/catalog/other-products", true},
		{"/api/catalog/other-products/113", true},
		{"/api/catalog/other-products/113/", true},
		{"/api/catalog/other-products//113", false},
		{"/api/catalog/other-products/./113", false},
		{"/api/catalog/other-products/113/..", false},
		{"/api/catalog/other-products%2F113", false},
		{"/api/catalog/other-products/113%00", false},
		{"/api/catalog/other-products/113\\", false},
		{"/api/catalog/batteries", true},
		{"/api/catalog/other-productsX", true},
		{"/api/inventory/1", true},
	} {
		r := httptest.NewRequest("GET", c.target, nil)
		if got := otherProductPath(r); got != c.want {
			t.Fatalf("otherProductPath(%q) = %v, want %v", c.target, got, c.want)
		}
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{"/api/catalog/other-products", true},
		{"/api/catalog/other-products/113", true},
		{"/api/catalog/other-productsX", false},
		{"/api/catalog/batteries", false},
		{"/api/catalog/prices", false},
	} {
		if got := otherProductRoute(c.path); got != c.want {
			t.Fatalf("otherProductRoute(%q) = %v, want %v", c.path, got, c.want)
		}
	}

	stub := &otherProductsStub{page: otherproducts.Page{Products: []otherproducts.Product{}, Page: 1, PageSize: 10}}
	handler := otherProductsHandler(t, stub)
	w := otherProductsServe(t, handler, otherProductsRequest("GET", "/api/catalog/other-products//113", ""))
	if w.Code != 404 || w.Body.String() != `{"error":"not_found"}`+"\n" {
		t.Fatalf("ambiguous path answered %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("ambiguous path answered without no-store")
	}
	w = otherProductsServe(t, handler, otherProductsRequest("GET", "/api/inventory/1", ""))
	if w.Code != http.StatusTeapot || w.Body.String() != "base" {
		t.Fatalf("a foreign path was not forwarded: %d %q", w.Code, w.Body.String())
	}
	w = otherProductsServe(t, handler, otherProductsWrite(http.MethodGet, otherProductRoutePath+"/113/more", ""))
	if w.Code != 404 || w.Body.String() != `{"error":"not_found"}`+"\n" {
		t.Fatalf("an unknown route below the collection answered %d %q", w.Code, w.Body.String())
	}
	if stub.listCalls != 0 {
		t.Fatalf("a foreign path reached the store")
	}
}

// The body is one bounded flat document with an exact key set at both levels: no
// duplicate keys, no unknown keys, no aliases, no nulls and no nesting.
func TestOtherProductsDocumentDecoding(t *testing.T) {
	decode := func(body string) (otherProductBody, error) {
		r := httptest.NewRequest(http.MethodPost, otherProductRoutePath, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return otherProductDocument(r)
	}
	got, err := decode(`{"name":" Agua acidulada ","fields":[
		{"name":"volumen en L","kind":"number","unit":"L","number":"005.000"},
		{"text":"importado","kind":"text","name":"origen"}]}`)
	if err != nil {
		t.Fatalf("refused the admitted document: %v", err)
	}
	if got.name != " Agua acidulada " || len(got.fields) != 2 {
		t.Fatalf("decoded %q with %d fields", got.name, len(got.fields))
	}
	if number := got.fields[0].Number; number == nil || *number != "5" || got.fields[0].Unit != "L" {
		t.Fatalf("decoded number %v", got.fields[0])
	}
	if text := got.fields[1].Text; text == nil || *text != "importado" || got.fields[0].Text != nil {
		t.Fatalf("decoded text %v", got.fields[1])
	}
	if empty, err := decode(`{"name":"Agua acidulada","fields":[]}`); err != nil ||
		empty.fields == nil || len(empty.fields) != 0 {
		t.Fatalf("a product without custom fields must be admitted: %v", err)
	}
	// A number field is the column's own decimal text: zero and a negative value are
	// values, and a padded spelling is canonicalized instead of refused.
	for _, c := range []struct{ value, want string }{
		{"0", "0"},
		{"-5", "-5"},
		{"005.500", "5.5"},
		{"000.000", "0"},
	} {
		body, err := decode(`{"name":"Agua acidulada","fields":[{"name":"volumen","kind":"number","number":"` + c.value + `"}]}`)
		if err != nil || len(body.fields) != 1 || body.fields[0].Number == nil || string(*body.fields[0].Number) != c.want {
			t.Fatalf("number %q decoded as %v, %v; want %q", c.value, body.fields, err, c.want)
		}
	}
	for _, c := range []struct{ name, body string }{
		{"empty_body", ``},
		{"truncated", `{"name":"Agua acidulada","fields":[]`},
		{"trailing_content", `{"name":"Agua acidulada","fields":[]}{}`},
		{"top_level_array", `[{"name":"Agua acidulada","fields":[]}]`},
		{"null_root", `null`},
		{"duplicate_name", `{"name":"Agua","name":"Agua acidulada","fields":[]}`},
		{"escaped_duplicate_name", `{"\u006eame":"Agua","name":"Agua acidulada","fields":[]}`},
		{"unknown_key", `{"id":1,"name":"Agua acidulada","fields":[]}`},
		{"unknown_field_key", `{"name":"Agua acidulada","fields":[{"name":"origen","kind":"text","text":"v","extra":"x"}]}`},
		{"missing_name", `{"fields":[]}`},
		{"missing_fields", `{"name":"Agua acidulada"}`},
		{"null_name", `{"name":null,"fields":[]}`},
		{"numeric_name", `{"name":1,"fields":[]}`},
		{"nested_name", `{"name":{"value":"Agua acidulada"},"fields":[]}`},
		{"null_fields", `{"name":"Agua acidulada","fields":null}`},
		{"object_fields", `{"name":"Agua acidulada","fields":{}}`},
		{"string_field", `{"name":"Agua acidulada","fields":["origen"]}`},
		{"missing_field_kind", `{"name":"Agua acidulada","fields":[{"name":"origen","text":"v"}]}`},
		{"missing_field_name", `{"name":"Agua acidulada","fields":[{"kind":"text","text":"v"}]}`},
		{"duplicate_field_key", `{"name":"Agua acidulada","fields":[{"name":"origen","name":"otro","kind":"text","text":"v"}]}`},
		{"numeric_field_name", `{"name":"Agua acidulada","fields":[{"name":1,"kind":"text","text":"v"}]}`},
		{"null_field_text", `{"name":"Agua acidulada","fields":[{"name":"origen","kind":"text","text":null}]}`},
		{"numeric_field_number", `{"name":"Agua acidulada","fields":[{"name":"volumen","kind":"number","number":5}]}`},
		{"empty_unit", `{"name":"Agua acidulada","fields":[{"name":"volumen","kind":"number","unit":"","number":"5"}]}`},
		{"non_canonical_number", `{"name":"Agua acidulada","fields":[{"name":"volumen","kind":"number","number":"cinco"}]}`},
		{"too_many_fields", `{"name":"Agua acidulada","fields":[` +
			strings.Repeat(`{"name":"campo","kind":"text","text":"v"},`, otherProductMaxFields) +
			`{"name":"campo","kind":"text","text":"v"}]}`},
		{"oversized", `{"name":"Agua acidulada","fields":[],"pad":"` + strings.Repeat("x", otherProductBodyLimit) + `"}`},
		{"invalid_utf8", `{"name":"Agua acidulada","fields":[],"pad":"` + "\xff" + `"}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got, err := decode(c.body); err == nil {
				t.Fatalf("admitted %q as %q", c.name, got.name)
			}
		})
	}
	r := httptest.NewRequest(http.MethodPost, otherProductRoutePath, strings.NewReader(otherProductExampleBody))
	r.Header.Set("Content-Type", "text/plain")
	if _, err := otherProductDocument(r); err == nil {
		t.Fatal("admitted a non-JSON content type")
	}
	r = httptest.NewRequest(http.MethodPost, otherProductRoutePath, strings.NewReader(otherProductExampleBody))
	r.Header.Add("Content-Type", "application/json")
	r.Header.Add("Content-Type", "application/json")
	if _, err := otherProductDocument(r); err == nil {
		t.Fatal("admitted two content type headers")
	}
}

// A record or a page the catalog cannot hold never leaves this process as a
// payload.
func TestOtherProductsRecordValidation(t *testing.T) {
	valid := otherProductExample()
	record, err := otherProductRecord(valid)
	if err != nil {
		t.Fatalf("refused the persisted product: %v", err)
	}
	if record.ID != 113 || record.Fields[0].Number == nil || *record.Fields[0].Number != "5" ||
		record.Fields[0].Text != nil || record.Fields[1].Unit != nil || record.Fields[1].Text == nil {
		t.Fatalf("record %v", record)
	}
	for _, c := range []struct {
		name   string
		mutate func(*otherproducts.Product)
	}{
		{"zero_id", func(p *otherproducts.Product) { p.ID = 0 }},
		{"id_out_of_range", func(p *otherproducts.Product) { p.ID = 1 << 40 }},
		{"empty_name", func(p *otherproducts.Product) { p.Name = "" }},
		{"untrimmed_name", func(p *otherproducts.Product) { p.Name = " Agua acidulada" }},
		{"short_name", func(p *otherproducts.Product) { p.Name = "ab" }},
		{"long_name", func(p *otherproducts.Product) { p.Name = strings.Repeat("a", 65) }},
		{"control_name", func(p *otherproducts.Product) { p.Name = "Agua\tacidulada" }},
		{"empty_fields_nil", func(p *otherproducts.Product) { p.Fields = nil }},
		{"unknown_kind", func(p *otherproducts.Product) { p.Fields[0].Kind = otherproducts.Kind("cash") }},
		{"untrimmed_field_name", func(p *otherproducts.Product) { p.Fields[0].Name = " volumen en L" }},
		{"blank_field_name", func(p *otherproducts.Product) { p.Fields[1].Name = "  " }},
		{"long_unit", func(p *otherproducts.Product) { p.Fields[0].Unit = strings.Repeat("u", 9) }},
		{"number_with_text", func(p *otherproducts.Product) { p.Fields[0].Text = otherProductValue("cinco") }},
		{"text_with_unit", func(p *otherproducts.Product) { p.Fields[1].Unit = "L" }},
		{"empty_text", func(p *otherproducts.Product) { p.Fields[1].Text = otherProductValue("") }},
		{"duplicate_field_names", func(p *otherproducts.Product) { p.Fields[1].Name = "Volumen en L" }},
		{"too_many_fields", func(p *otherproducts.Product) {
			fields := make([]otherproducts.Field, 0, 21)
			for i := 0; i < 21; i++ {
				fields = append(fields, otherproducts.Field{
					Name: "campo " + string(rune('a'+i)), Kind: otherproducts.KindText, Text: otherProductValue("v"),
				})
			}
			p.Fields = fields
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			product := otherProductExample()
			product.Fields = append([]otherproducts.Field(nil), valid.Fields...)
			c.mutate(&product)
			if _, err := otherProductRecord(product); !errors.Is(err, otherproducts.ErrUnavailable) {
				t.Fatalf("accepted %s", c.name)
			}
		})
	}

	page := otherproducts.Page{
		Products: []otherproducts.Product{otherProductExample()},
		Page:     1,
		PageSize: 10,
		Total:    1,
	}
	if _, err := otherProductPageRecord(page); err != nil {
		t.Fatalf("refused the admitted page: %v", err)
	}
	empty := otherproducts.Page{Products: []otherproducts.Product{}, Page: 2, PageSize: 10, Total: 1}
	if got, err := otherProductPageRecord(empty); err != nil || got.Products == nil || len(got.Products) != 0 {
		t.Fatalf("a page beyond the last one must be an empty page: %v", err)
	}
	for _, c := range []struct {
		name   string
		mutate func(*otherproducts.Page)
	}{
		{"zero_page", func(p *otherproducts.Page) { p.Page = 0 }},
		{"bad_page_size", func(p *otherproducts.Page) { p.PageSize = 15 }},
		{"negative_total", func(p *otherproducts.Page) { p.Total = -1 }},
		{"over_window", func(p *otherproducts.Page) { p.Page = 2 }},
		{"too_many_rows", func(p *otherproducts.Page) {
			p.PageSize = 10
			p.Total = 20
			p.Products = make([]otherproducts.Product, 11)
		}},
		{"unordered_rows", func(p *otherproducts.Page) {
			second := otherProductExample()
			second.ID = 114
			p.Products = []otherproducts.Product{second, otherProductExample()}
			p.Total = 2
		}},
		{"invalid_row", func(p *otherproducts.Page) { p.Products[0].Name = "" }},
	} {
		t.Run(c.name, func(t *testing.T) {
			broken := page
			broken.Products = []otherproducts.Product{otherProductExample()}
			c.mutate(&broken)
			if _, err := otherProductPageRecord(broken); !errors.Is(err, otherproducts.ErrUnavailable) {
				t.Fatalf("accepted %s", c.name)
			}
		})
	}
}

// The composed constructor refuses an incomplete composition before it mounts
// anything.
func TestOtherProductsMountValidation(t *testing.T) {
	service, err := auth.New(nil, nil)
	if err != nil {
		t.Fatalf("authentication service: %v", err)
	}
	cfg, err := config.ParseAuth(config.LocalTrial, otherProductOrigin, "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatalf("auth configuration: %v", err)
	}
	base := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	stub := &otherProductsStub{}
	if _, err := NewWithOtherProducts(nil, service, cfg, stub); !errors.Is(err, otherproducts.ErrUnavailable) {
		t.Fatal("mounted without a base handler")
	}
	if _, err := NewWithOtherProducts(base, nil, cfg, stub); !errors.Is(err, otherproducts.ErrUnavailable) {
		t.Fatal("mounted without an authentication service")
	}
	if _, err := NewWithOtherProducts(base, service, cfg, nil); !errors.Is(err, otherproducts.ErrUnavailable) {
		t.Fatal("mounted without a store")
	}
	if _, err := NewWithOtherProducts(base, service, config.Auth{Origin: "http://evil.example"}, stub); !errors.Is(err, otherproducts.ErrUnavailable) {
		t.Fatal("mounted with an inadmissible configuration")
	}
	if _, err := NewWithOtherProducts(base, service, cfg, stub); err != nil {
		t.Fatalf("refused the complete composition: %v", err)
	}
}
