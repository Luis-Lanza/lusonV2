package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// stockEntrySupplierName is the name of the supplier the HTTP fixture seeds for
// every document. A fresh database starts the supplier identity at 1 and the
// fixture refuses to run otherwise, so the request bodies below can state the id
// they write.
const stockEntrySupplierName = "Proveedor Central"

const validStockEntryJSON = `{"operation_key":"http-stock-entry-key-01","supplier_id":1,"note":"compra de proveedor","lines":[{"variant_id":2,"quantity":3},{"variant_id":1,"quantity":1}]}`

func stockEntryCart(n, quantity int) string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf(`{"variant_id":%d,"quantity":%d}`, n-i, quantity)
	}
	return `{"operation_key":"http-stock-entry-key-02","supplier_id":1,"lines":[` + strings.Join(lines, ",") + `]}`
}

func TestStockEntryDecoder(t *testing.T) {
	replace := func(old, value string) string { return strings.Replace(validStockEntryJSON, old, value, 1) }
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{
			validStockEntryJSON,
			" \n" + validStockEntryJSON + " \n",
			`{"operation_key":"http-stock-entry-key-01","supplier_id":1,"lines":[{"variant_id":1,"quantity":1000000}]}`,
			`{"lines":[{"variant_id":1,"quantity":1}],"supplier_id":1,"operation_key":"http-stock-entry-key-01"}`,
			// The supplier is a canonical positive integer up to the bigint bound.
			replace(`"supplier_id":1`, `"supplier_id":9223372036854775807`),
			replace(`"http-stock-entry-key-01"`, strconv.Quote(strings.Repeat("a", 128))),
			replace(`"compra de proveedor"`, strconv.Quote(strings.Repeat("ñ", 500))),
		} {
			r := httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			got, err := decodeStockEntry(r)
			if err != nil || len(got.Lines) == 0 || got.OperationKey == "" {
				t.Fatalf("valid framing rejected: %v", err)
			}
		}
	})
	invalid := map[string]string{
		"empty_object":             `{}`,
		"array_root":               `[]`,
		"null_root":                `null`,
		"truncated":                validStockEntryJSON[:len(validStockEntryJSON)-1],
		"trailing":                 validStockEntryJSON + `{}`,
		"trailing_scalar":          validStockEntryJSON + `true`,
		"oversized":                validStockEntryJSON + strings.Repeat(" ", stockEntryBodyLimit),
		"unknown":                  replace(`"note":`, `"location_id":1,"note":`),
		"casefold":                 replace(`"lines":`, `"Lines":`),
		"duplicate":                replace(`"note":`, `"note":"a","note":`),
		"escaped_duplicate":        replace(`"note":`, `"\u006eote":"a","note":`),
		"duplicate_escaped_key":    replace(`"operation_key":`, `"operation_key":"x","\u006fperation_key":`),
		"nested_duplicate":         replace(`"variant_id":1`, `"variant_id":1,"variant_id":2`),
		"nested_escaped_duplicate": replace(`"quantity":1`, `"quantity":1,"\u0071uantity":1`),
		"nested_casefold":          replace(`"quantity":`, `"Quantity":`),
		"nested_unknown":           replace(`"quantity":`, `"location_id":1,"quantity":`),
		"missing_key":              replace(`"operation_key":"http-stock-entry-key-01",`, ``),
		"missing_supplier":         replace(`"supplier_id":1,`, ``),
		"string_supplier":          replace(`"supplier_id":1`, `"supplier_id":"1"`),
		"zero_supplier":            replace(`"supplier_id":1`, `"supplier_id":0`),
		"negative_supplier":        replace(`"supplier_id":1`, `"supplier_id":-1`),
		"padded_supplier":          replace(`"supplier_id":1`, `"supplier_id":01`),
		"float_supplier":           replace(`"supplier_id":1`, `"supplier_id":1.0`),
		"exponent_supplier":        replace(`"supplier_id":1`, `"supplier_id":1e0`),
		"null_supplier":            replace(`"supplier_id":1`, `"supplier_id":null`),
		"duplicate_supplier":       replace(`"supplier_id":1`, `"supplier_id":1,"supplier_id":1`),
		"supplier_overflow":        replace(`"supplier_id":1`, `"supplier_id":9223372036854775808`),
		"missing_lines":            replace(`,"lines":[{"variant_id":2,"quantity":3},{"variant_id":1,"quantity":1}]`, ``),
		"null_key":                 replace(`"http-stock-entry-key-01"`, `null`),
		"null_note":                replace(`"compra de proveedor"`, `null`),
		"null_lines":               replace(`[{"variant_id":2,"quantity":3},{"variant_id":1,"quantity":1}]`, `null`),
		"empty_lines":              replace(`[{"variant_id":2,"quantity":3},{"variant_id":1,"quantity":1}]`, `[]`),
		"null_line":                replace(`{"variant_id":2,"quantity":3}`, `null`),
		"duplicate_variant":        replace(`{"variant_id":1,"quantity":1}`, `{"variant_id":2,"quantity":1}`),
		"string_quantity":          replace(`"quantity":3`, `"quantity":"3"`),
		"float_quantity":           replace(`"quantity":3`, `"quantity":3.0`),
		"exponent_quantity":        replace(`"quantity":3`, `"quantity":3e0`),
		"zero_quantity":            replace(`"quantity":3`, `"quantity":0`),
		"negative_quantity":        replace(`"quantity":3`, `"quantity":-3`),
		"padded_quantity":          replace(`"quantity":3`, `"quantity":03`),
		"quantity_overflow":        replace(`"quantity":3`, `"quantity":9223372036854775808`),
		"string_variant":           replace(`"variant_id":2`, `"variant_id":"2"`),
		"zero_variant":             replace(`"variant_id":2`, `"variant_id":0`),
		"negative_variant":         replace(`"variant_id":2`, `"variant_id":-2`),
		"variant_bound":            replace(`"variant_id":2`, `"variant_id":2147483648`),
		"short_key":                replace(`"http-stock-entry-key-01"`, `"short"`),
		"long_key":                 replace(`"http-stock-entry-key-01"`, strconv.Quote(strings.Repeat("a", 129))),
		"unsafe_key":               replace(`"http-stock-entry-key-01"`, `"http stock entry key 01"`),
		"nul_key":                  replace(`"http-stock-entry-key-01"`, `"http-stock-entry-key-01\u0000"`),
		"invalid_utf8":             replace("compra", "compra-\xff"),
	}
	for name, body := range invalid {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			if _, err := decodeStockEntry(r); err != stockentries.ErrInvalid {
				t.Fatal("invalid framing accepted or unsanitized")
			}
		})
	}
	t.Run("too_many_lines", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(stockEntryCart(191, 1)))
		r.Header.Set("Content-Type", "application/json")
		if _, err := decodeStockEntry(r); err != stockentries.ErrInvalid {
			t.Fatal("more than 190 lines accepted")
		}
	})
	t.Run("max_lines", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(stockEntryCart(190, 1)))
		r.Header.Set("Content-Type", "application/json")
		if got, err := decodeStockEntry(r); err != nil || len(got.Lines) != 190 {
			t.Fatal("190 lines rejected")
		}
	})
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json", "application/json"}, {"application/json; charset=utf-8; x=y"}, {"application/json; charset=utf-8; charset=utf-8"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(validStockEntryJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, err := decodeStockEntry(r); err != stockentries.ErrInvalid {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/stock-entries", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, err := decodeStockEntry(r); err != stockentries.ErrInvalid {
		t.Fatal("body read error exposed")
	}
	if _, err := decodeStockEntry(nil); err != stockentries.ErrInvalid {
		t.Fatal("nil request accepted")
	}
}

func TestStockEntryFailureMapping(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{stockentries.ErrInvalid, 400, "invalid_request"},
		{stockentries.ErrForbidden, 403, "forbidden"},
		{stockentries.ErrNotFound, 404, "not_found"},
		{stockentries.ErrDecisionConflict, 409, "decision_conflict"},
		{stockentries.ErrRetryConflict, 409, "retry_conflict"},
		{stockentries.ErrInsufficientStock, 409, "insufficient_stock"},
		{stockentries.ErrUnavailable, 503, "service_unavailable"},
		{fmt.Errorf("opaque failure"), 503, "service_unavailable"},
	} {
		w := httptest.NewRecorder()
		stockEntryFailure(w, fmt.Errorf("wrapped: %w", tc.err))
		expectTransferError(t, w, tc.status, tc.code)
	}
}

func TestStockEntryRecord(t *testing.T) {
	valid := stockentries.Entry{
		ID: 7, LocationID: 1, Note: "compra", CreatedByAccountID: 1,
		CreatedAt:  time.Date(2026, 2, 3, 4, 5, 6, 789, time.UTC),
		Supplier:   &stockentries.Supplier{ID: 3, Name: "Proveedor Central"},
		Lines:      []stockentries.EntryLine{{VariantID: 1, Quantity: 2}, {VariantID: 3, Quantity: 4}},
		TotalUnits: 6,
	}
	dto, err := stockEntryRecord(valid)
	if err != nil {
		t.Fatal("persisted document rejected")
	}
	if dto.ID != 7 || dto.CreatedAt != "2026-02-03T04:05:06Z" || dto.LocationID != 1 ||
		dto.CreatedByAccountID != 1 || dto.TotalUnits != 6 || len(dto.Lines) != 2 ||
		dto.Lines[0].VariantID != 1 || dto.Lines[1].Quantity != 4 {
		t.Fatal("record does not match the frozen contract")
	}
	if dto.Supplier == nil || dto.Supplier.ID != 3 || dto.Supplier.Name != "Proveedor Central" {
		t.Fatal("record does not carry the supplier of the document")
	}
	// A historical document has no supplier and is still a valid record.
	historical := valid
	historical.Supplier = nil
	if record, err := stockEntryRecord(historical); err != nil || record.Supplier != nil {
		t.Fatal("a document without a supplier must stay readable as null")
	}
	for name, change := range map[string]func(*stockentries.Entry){
		"zero_id":          func(e *stockentries.Entry) { e.ID = 0 },
		"foreign_location": func(e *stockentries.Entry) { e.LocationID = 2 },
		"unknown_actor":    func(e *stockentries.Entry) { e.CreatedByAccountID = 0 },
		"zero_time":        func(e *stockentries.Entry) { e.CreatedAt = time.Time{} },
		"no_lines":         func(e *stockentries.Entry) { e.Lines = nil },
		"unsorted":         func(e *stockentries.Entry) { e.Lines[0], e.Lines[1] = e.Lines[1], e.Lines[0] },
		"repeated_variant": func(e *stockentries.Entry) { e.Lines[1].VariantID = 1 },
		"negative_line":    func(e *stockentries.Entry) { e.Lines[0].Quantity = -2 },
		"wrong_total":      func(e *stockentries.Entry) { e.TotalUnits = 7 },
		"long_note":        func(e *stockentries.Entry) { e.Note = strings.Repeat("a", 501) },
		"nul_note":         func(e *stockentries.Entry) { e.Note = "a\x00b" },
		"supplier_zero_id": func(e *stockentries.Entry) { e.Supplier = &stockentries.Supplier{ID: 0, Name: "Proveedor"} },
		"supplier_negative": func(e *stockentries.Entry) {
			e.Supplier = &stockentries.Supplier{ID: -1, Name: "Proveedor"}
		},
		"supplier_blank_name": func(e *stockentries.Entry) { e.Supplier = &stockentries.Supplier{ID: 1} },
		"supplier_long_name": func(e *stockentries.Entry) {
			e.Supplier = &stockentries.Supplier{ID: 1, Name: strings.Repeat("a", 65)}
		},
		"supplier_nul_name": func(e *stockentries.Entry) { e.Supplier = &stockentries.Supplier{ID: 1, Name: "Pro\x00veedor"} },
	} {
		entry := valid
		entry.Lines = append([]stockentries.EntryLine(nil), valid.Lines...)
		entry.Supplier = &stockentries.Supplier{ID: 3, Name: "Proveedor Central"}
		change(&entry)
		if _, err := stockEntryRecord(entry); err != stockentries.ErrUnavailable {
			t.Fatalf("%s must not reach the wire", name)
		}
	}
}

func TestStockEntryConstructor(t *testing.T) {
	cfg := transferConfig(t)
	for mask := 1; mask < 16; mask++ {
		t.Run(fmt.Sprintf("nil_mask_%d", mask), func(t *testing.T) {
			svc := &auth.Service{}
			stock := inventory.New(&pgxpool.Pool{})
			requests := transfers.New(&pgxpool.Pool{})
			entries := stockentries.New(&pgxpool.Pool{})
			if mask&1 != 0 {
				svc = nil
			}
			if mask&2 != 0 {
				stock = nil
			}
			if mask&4 != 0 {
				requests = nil
			}
			if mask&8 != 0 {
				entries = nil
			}
			h, err := NewWithStockEntries(svc, cfg, stock, requests, entries, nil)
			if err == nil || h != nil {
				t.Fatal("required nil dependency accepted")
			}
		})
	}
	if h, err := NewWithStockEntries(&auth.Service{}, config.Auth{}, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil); err == nil || h != nil {
		t.Fatal("invalid auth configuration accepted")
	}
	h, err := NewWithStockEntries(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil)
	if err != nil || h == nil {
		t.Fatal("explicit constructor unavailable")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(validStockEntryJSON)))
	expectTransferError(t, w, 401, "unauthenticated")
	for _, legacy := range []http.Handler{New(nil, cfg), New(nil, cfg, inventory.New(nil)), transferOnlyHandler(t, cfg)} {
		w := httptest.NewRecorder()
		legacy.ServeHTTP(w, httptest.NewRequest("POST", "/api/stock-entries", strings.NewReader(validStockEntryJSON)))
		if w.Code != 404 {
			t.Fatal("legacy constructor unexpectedly enabled stock ingress")
		}
	}
}

// transferOnlyHandler exposes the transfer-only factory without a database:
// the constructor validates dependencies, never their pools.
func transferOnlyHandler(t *testing.T, cfg config.Auth) http.Handler {
	t.Helper()
	h, err := NewWithTransfers(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}))
	if err != nil || h == nil {
		t.Fatal("transfer constructor unavailable")
	}
	return h
}

type stockEntryHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
}

// stockEntryFixture needs the isolated test PostgreSQL; without an admitted
// manifest every database test here fails closed, which is expected locally.
func stockEntryFixture(t *testing.T) *stockEntryHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("stock entry HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("stock entry HTTP test provisioning failed")
	}
	// Every document of these tests names this supplier, and a fresh database
	// starts the supplier identity at 1. Its offers cover every catalogue entry
	// that exists now; a test that adds a product offers it explicitly.
	var supplier int64
	if err := p.QueryRow(ctx, "INSERT INTO suppliers(name) VALUES($1) RETURNING id", stockEntrySupplierName).Scan(&supplier); err != nil {
		t.Fatal("stock entry supplier fixture setup failed")
	}
	if supplier != 1 {
		t.Fatalf("the first supplier must be the fixture supplier: got %d", supplier)
	}
	if _, err := p.Exec(ctx, `INSERT INTO supplier_offers(supplier_id,catalog_entry_id)
 SELECT $1::bigint,id FROM catalog_entries WHERE deleted_at IS NULL`, supplier); err != nil {
		t.Fatal("stock entry supplier offer fixture setup failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("stock entry HTTP operational fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("stock entry HTTP auth fixture failed")
	}
	f := &stockEntryHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("stock entry HTTP login failed")
		}
		f.tokens[i] = token
	}
	f.handler, err = NewWithStockEntries(svc, f.cfg, inventory.New(p), transfers.New(p), stockentries.New(p), nil)
	if err != nil {
		t.Fatal("stock entry HTTP constructor failed")
	}
	return f
}

func (f *stockEntryHTTPFixture) stock(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'entries',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM stock_entries e),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.entry_id,l.variant_id),'[]'::jsonb) FROM stock_entry_lines l),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("stock entry snapshot failed")
	}
	return data
}

// supplier inserts one supplier and offers it the catalogue entry of each given
// variant, exactly like the supplier routes write them.
func (f *stockEntryHTTPFixture) supplier(t *testing.T, name string, variants ...int64) int64 {
	t.Helper()
	var id int64
	if err := f.p.QueryRow(f.ctx, "INSERT INTO suppliers(name) VALUES($1) RETURNING id", name).Scan(&id); err != nil {
		t.Fatal("supplier fixture setup failed")
	}
	for _, variant := range variants {
		f.offer(t, id, variant)
	}
	return id
}

// offer assigns the catalogue entry of one variant to a supplier: an offer is
// entry-level, so a variant id is enough to state it.
func (f *stockEntryHTTPFixture) offer(t *testing.T, supplier, variant int64) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, `INSERT INTO supplier_offers(supplier_id,catalog_entry_id)
 SELECT $1::bigint,v.catalog_entry_id FROM catalog_variants v WHERE v.id=$2::bigint`, supplier, variant); err != nil {
		t.Fatalf("supplier offer fixture setup failed: %v", err)
	}
}

func (f *stockEntryHTTPFixture) request(actor int, verb, path, body string) *http.Request {
	r := httptest.NewRequest(verb, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Content-Type", "application/json")
	if actor > 0 {
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[actor-1]})
		r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[actor-1]))
	}
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func (f *stockEntryHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("stock entry security headers changed")
	}
	return w
}

// rejected proves a refused request wrote nothing anywhere.
func (f *stockEntryHTTPFixture) rejected(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.stock(t)
	w := f.serve(t, r)
	expectTransferError(t, w, status, code)
	if f.stock(t) != before {
		t.Fatal("a rejected stock ingress changed stored state")
	}
}

func stockEntryObject(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]json.RawMessage {
	t.Helper()
	var value map[string]json.RawMessage
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" || json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatalf("stock entry JSON response mismatch: status=%d want=%d", w.Code, status)
	}
	if len(value) != 8 {
		t.Fatal("document whitelist changed")
	}
	for _, key := range []string{"id", "location_id", "note", "supplier", "created_by_account_id", "created_at", "lines", "total_units"} {
		if value[key] == nil {
			t.Fatalf("document whitelist incomplete: %s", key)
		}
	}
	return value
}

func TestStockEntryHTTPSuccess(t *testing.T) {
	f := stockEntryFixture(t)
	before := f.stock(t)
	w := f.serve(t, f.request(1, "POST", "/api/stock-entries", validStockEntryJSON))
	value := stockEntryObject(t, w, 201)
	var document stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &document) != nil || document.ID < 1 || document.LocationID != 1 ||
		document.Note != "compra de proveedor" || document.CreatedByAccountID != 1 || document.TotalUnits != 4 ||
		len(document.Lines) != 2 || document.Lines[0].VariantID != 1 || document.Lines[0].Quantity != 1 ||
		document.Lines[1].VariantID != 2 || document.Lines[1].Quantity != 3 {
		t.Fatal("created document does not match the frozen contract")
	}
	// The response carries the supplier the document was written with.
	if document.Supplier == nil || document.Supplier.ID != 1 || document.Supplier.Name != stockEntrySupplierName {
		t.Fatal("the created document must carry its supplier")
	}
	if string(value["supplier"]) != `{"id":1,"name":"`+stockEntrySupplierName+`"}` {
		t.Fatalf("supplier framing changed: %s", value["supplier"])
	}
	if stamp, err := time.Parse(time.RFC3339, document.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != document.CreatedAt {
		t.Fatal("created_at is not RFC3339")
	}
	if string(value["location_id"]) != "1" || string(value["created_by_account_id"]) != "1" {
		t.Fatal("exact scalar framing changed")
	}
	// Balances grew by exactly the document and stored documents are durable.
	var existing int64
	if f.p.QueryRow(f.ctx, "SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=1").Scan(&existing) != nil {
		t.Fatal("balance read failed")
	}
	var persisted int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM stock_entry_lines WHERE entry_id=$1", document.ID).Scan(&persisted) != nil || persisted != 2 {
		t.Fatal("document lines were not persisted")
	}
	if f.stock(t) == before {
		t.Fatal("a created document must change stored state")
	}
	// An identical replay is 200 with the same document and no new writes.
	replayed := f.stock(t)
	w = f.serve(t, f.request(1, "POST", "/api/stock-entries", `{"supplier_id":1,"lines":[{"variant_id":1,"quantity":1},{"variant_id":2,"quantity":3}],"note":"compra de proveedor","operation_key":"http-stock-entry-key-01"}`))
	stockEntryObject(t, w, 200)
	var replay stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &replay) != nil || replay.ID != document.ID ||
		replay.CreatedAt != document.CreatedAt || replay.TotalUnits != document.TotalUnits ||
		len(replay.Lines) != len(document.Lines) {
		t.Fatal("replay must return the persisted document")
	}
	if f.stock(t) != replayed {
		t.Fatal("a replay must not change stored state")
	}
	if n := f.count(t, "stock_entries"); n != 1 {
		t.Fatal("a replay must not create a second document")
	}
}

func TestStockEntryHTTPRejections(t *testing.T) {
	f := stockEntryFixture(t)
	f.rejected(t, f.request(0, "POST", "/api/stock-entries", validStockEntryJSON), 401, "unauthenticated")
	f.rejected(t, f.request(2, "POST", "/api/stock-entries", validStockEntryJSON), 403, "forbidden")
	f.rejected(t, f.request(3, "POST", "/api/stock-entries", validStockEntryJSON), 403, "forbidden")
	for _, verb := range []string{"PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, "/api/stock-entries", ""))
		if w.Code != 405 || w.Header().Get("Allow") != "GET, POST" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
	foreign := f.request(1, "POST", "/api/stock-entries", validStockEntryJSON)
	foreign.Header.Set("Origin", "http://example.test")
	f.rejected(t, foreign, 403, "forbidden")
	noCSRF := f.request(1, "POST", "/api/stock-entries", validStockEntryJSON)
	noCSRF.Header.Del("X-CSRF-Token")
	f.rejected(t, noCSRF, 403, "forbidden")
	for name, body := range map[string]string{
		"unknown_field":     strings.Replace(validStockEntryJSON, `"note":`, `"location_id":1,"note":`, 1),
		"duplicate_key":     strings.Replace(validStockEntryJSON, `"note":`, `"note":"a","note":`, 1),
		"missing_key":       strings.Replace(validStockEntryJSON, `"operation_key":"http-stock-entry-key-01",`, ``, 1),
		"missing_supplier":  strings.Replace(validStockEntryJSON, `"supplier_id":1,`, ``, 1),
		"zero_supplier":     strings.Replace(validStockEntryJSON, `"supplier_id":1`, `"supplier_id":0`, 1),
		"string_supplier":   strings.Replace(validStockEntryJSON, `"supplier_id":1`, `"supplier_id":"1"`, 1),
		"short_key":         strings.Replace(validStockEntryJSON, `"http-stock-entry-key-01"`, `"short"`, 1),
		"empty_lines":       strings.Replace(validStockEntryJSON, `[{"variant_id":2,"quantity":3},{"variant_id":1,"quantity":1}]`, `[]`, 1),
		"duplicate_variant": strings.Replace(validStockEntryJSON, `{"variant_id":1,"quantity":1}`, `{"variant_id":2,"quantity":1}`, 1),
		"zero_quantity":     strings.Replace(validStockEntryJSON, `"quantity":3`, `"quantity":0`, 1),
		"huge_quantity":     strings.Replace(validStockEntryJSON, `"quantity":3`, `"quantity":1000001`, 1),
		"oversized_note":    strings.Replace(validStockEntryJSON, `"compra de proveedor"`, strconv.Quote(strings.Repeat("a", 501)), 1),
		"trailing_input":    validStockEntryJSON + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", "/api/stock-entries", body), 400, "invalid_request")
		})
	}
	t.Run("query_string", func(t *testing.T) {
		f.rejected(t, f.request(1, "POST", "/api/stock-entries?operation_key=x", validStockEntryJSON), 400, "invalid_request")
	})
}

func TestStockEntryHTTPReplayConflict(t *testing.T) {
	f := stockEntryFixture(t)
	first := f.serve(t, f.request(1, "POST", "/api/stock-entries", validStockEntryJSON))
	document := stockEntryObject(t, first, 201)
	var id int64
	if json.Unmarshal(document["id"], &id) != nil || id < 1 {
		t.Fatal("created document id missing")
	}
	for name, body := range map[string]string{
		"note":     strings.Replace(validStockEntryJSON, "compra de proveedor", "otra nota", 1),
		"quantity": strings.Replace(validStockEntryJSON, `"quantity":3`, `"quantity":4`, 1),
		// The supplier is part of the canonical payload, exactly like the note.
		"supplier": strings.Replace(validStockEntryJSON, `"supplier_id":1`, `"supplier_id":999999`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", "/api/stock-entries", body), 409, "retry_conflict")
		})
	}
	if n := f.count(t, "stock_entries"); n != 1 {
		t.Fatal("a conflict must not create a second document")
	}
}

// A new ingress document always names a supplier the warehouse can still use, and
// every line must belong to an entry that supplier offers. Each refusal is the
// wire code of its own rule and writes nothing.
func TestStockEntryHTTPSupplierRejections(t *testing.T) {
	f := stockEntryFixture(t)
	// An unknown supplier is a decision conflict, never a second document.
	f.rejected(t, f.request(1, "POST", "/api/stock-entries",
		`{"operation_key":"http-supplier-unknown-01","supplier_id":999999,"lines":[{"variant_id":1,"quantity":1}]}`), 409, "decision_conflict")
	// A retired supplier cannot admit a new document either.
	retired := f.supplier(t, "Proveedor Retirado", 1)
	if _, err := f.p.Exec(f.ctx, "UPDATE suppliers SET deleted_at=now() WHERE id=$1", retired); err != nil {
		t.Fatal("supplier retirement setup failed")
	}
	f.rejected(t, f.request(1, "POST", "/api/stock-entries",
		fmt.Sprintf(`{"operation_key":"http-supplier-retired-01","supplier_id":%d,"lines":[{"variant_id":1,"quantity":1}]}`, retired)), 409, "decision_conflict")
	// A line of an entry the supplier does not offer is a rejected payload, and
	// the offered line beside it is not written either.
	partial := f.supplier(t, "Proveedor Parcial", 1)
	existingOne, reservedOne := f.balance(t, 1, 1)
	existingThree, reservedThree := f.balance(t, 1, 3)
	for name, body := range map[string]string{
		"not_offered": fmt.Sprintf(`{"operation_key":"http-supplier-offer-01","supplier_id":%d,"lines":[{"variant_id":3,"quantity":2}]}`, partial),
		"mixed":       fmt.Sprintf(`{"operation_key":"http-supplier-offer-02","supplier_id":%d,"lines":[{"variant_id":1,"quantity":2},{"variant_id":3,"quantity":2}]}`, partial),
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", "/api/stock-entries", body), 400, "invalid_request")
		})
	}
	if got, reserved := f.balance(t, 1, 1); got != existingOne || reserved != reservedOne {
		t.Fatal("a refused document must not move the offered balance")
	}
	if got, reserved := f.balance(t, 1, 3); got != existingThree || reserved != reservedThree {
		t.Fatal("a refused document must not move the unoffered balance")
	}
	if n := f.count(t, "stock_entries"); n != 0 {
		t.Fatal("a refused document must not persist a document")
	}
	if n := f.count(t, "stock_entry_lines"); n != 0 {
		t.Fatal("a refused document must not persist a line")
	}
	// The same supplier still admits the entry it does offer, so the refusal is
	// the offer and not the supplier.
	document := f.create(t, fmt.Sprintf(`{"operation_key":"http-supplier-offered-01","supplier_id":%d,"lines":[{"variant_id":1,"quantity":1}]}`, partial))
	if document.Supplier == nil || document.Supplier.ID != partial || document.Supplier.Name != "Proveedor Parcial" {
		t.Fatal("the created document must carry its supplier")
	}
}

// stockEntryHistoryWire admits only the frozen history shape: four page keys and
// seven summary keys per row, with no per-line detail anywhere.
func stockEntryHistoryWire(t *testing.T, w *httptest.ResponseRecorder) stockEntryHistoryWireDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("history response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 4 {
		t.Fatal("history whitelist changed")
	}
	for _, key := range []string{"page", "page_size", "total_entries", "entries"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("history whitelist incomplete: %s", key)
		}
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(top["entries"], &rows) != nil {
		t.Fatal("history entries are not an array")
	}
	canonical := regexp.MustCompile(`^[1-9][0-9]*$`)
	for _, row := range rows {
		if len(row) != 7 {
			t.Fatal("history row whitelist changed")
		}
		for _, key := range []string{"id", "note", "supplier", "created_at", "lines", "total_units", "reversed_by"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("history row whitelist incomplete: %s", key)
			}
		}
		if reversed := string(row["reversed_by"]); reversed != "null" && !canonical.MatchString(reversed) {
			t.Fatal("reversed_by must be null or a canonical id")
		}
		// The supplier of a row is null or exactly an id and a non-blank name.
		if supplier := string(row["supplier"]); supplier != "null" {
			var value map[string]json.RawMessage
			if json.Unmarshal(row["supplier"], &value) != nil || len(value) != 2 ||
				!canonical.MatchString(string(value["id"])) {
				t.Fatal("supplier must be null or an id and a name")
			}
			var name string
			if json.Unmarshal(value["name"], &name) != nil || name == "" {
				t.Fatal("supplier name is missing")
			}
		}
	}
	var page stockEntryHistoryWireDTO
	if json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatal("history response is not decodable")
	}
	if len(page.Entries) != len(rows) {
		t.Fatal("history rows are inconsistent")
	}
	return page
}

type stockEntryHistoryWireDTO struct {
	Page         int                           `json:"page"`
	PageSize     int                           `json:"page_size"`
	TotalEntries int                           `json:"total_entries"`
	Entries      []stockEntryHistoryRowWireDTO `json:"entries"`
}

type stockEntryHistoryRowWireDTO struct {
	ID         int64                  `json:"id"`
	Note       string                 `json:"note"`
	Supplier   *stockEntrySupplierDTO `json:"supplier"`
	CreatedAt  string                 `json:"created_at"`
	Lines      int                    `json:"lines"`
	TotalUnits int64                  `json:"total_units"`
	ReversedBy *int64                 `json:"reversed_by"`
}

// reverse persists a counter-entry exactly like the correction screen will, so
// the history can be proven to expose it without a reversal route. It inherits
// the supplier of its original, exactly like the store does.
func (f *stockEntryHTTPFixture) reverse(t *testing.T, original int64, key, reason string, lines ...stockentries.Line) int64 {
	t.Helper()
	tx, err := f.p.BeginTx(f.ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal("counter-entry transaction failed")
	}
	defer tx.Rollback(context.WithoutCancel(f.ctx))
	var id int64
	if err := tx.QueryRow(f.ctx, `INSERT INTO stock_entries(operation_key,location_id,note,reverses_entry_id,reason,created_by_account_id,supplier_id)
 VALUES($1,1,'',$2,$3,1,(SELECT supplier_id FROM stock_entries WHERE id=$2)) RETURNING id`, key, original, reason).Scan(&id); err != nil {
		t.Fatalf("counter-entry insert failed: %v", err)
	}
	for _, line := range lines {
		if _, err := tx.Exec(f.ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
			t.Fatalf("counter-entry line failed: %v", err)
		}
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatalf("counter-entry commit failed: %v", err)
	}
	return id
}

func TestStockEntryHTTPHistory(t *testing.T) {
	f := stockEntryFixture(t)
	empty := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries", "")))
	if empty.Page != 1 || empty.PageSize != 25 || empty.TotalEntries != 0 || len(empty.Entries) != 0 {
		t.Fatal("an empty history must report one empty page")
	}
	if explicit := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries?page=1&page_size=25", ""))); explicit.TotalEntries != 0 {
		t.Fatal("the explicit defaults must answer exactly like the bare route")
	}
	ids := make([]int64, 0, 3)
	for i, body := range []string{
		`{"operation_key":"http-history-key-0001","supplier_id":1,"note":"Remito 0001","lines":[{"variant_id":1,"quantity":3}]}`,
		`{"operation_key":"http-history-key-0002","supplier_id":1,"note":"Remito 0002-00045871","lines":[{"variant_id":2,"quantity":14},{"variant_id":1,"quantity":4}]}`,
		`{"operation_key":"http-history-key-0003","supplier_id":1,"lines":[{"variant_id":2,"quantity":1}]}`,
	} {
		w := f.serve(t, f.request(1, "POST", "/api/stock-entries", body))
		var document stockEntryDTO
		if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &document) != nil {
			t.Fatalf("document %d was not created", i)
		}
		ids = append(ids, document.ID)
	}
	page := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries", "")))
	if page.TotalEntries != 3 || len(page.Entries) != 3 {
		t.Fatal("every persisted document must be listed once")
	}
	if page.Entries[0].ID != ids[2] || page.Entries[1].ID != ids[1] || page.Entries[2].ID != ids[0] {
		t.Fatal("history must be ordered newest first")
	}
	second := page.Entries[1]
	if second.Note != "Remito 0002-00045871" || second.Lines != 2 || second.TotalUnits != 18 || second.ReversedBy != nil {
		t.Fatal("summary does not match the frozen contract")
	}
	if stamp, err := time.Parse(time.RFC3339, second.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != second.CreatedAt {
		t.Fatal("created_at is not RFC3339")
	}
	if page.Entries[2].Note != "Remito 0001" || page.Entries[2].Lines != 1 {
		t.Fatal("the oldest document must be summarized exactly")
	}
	if page.Entries[0].Note != "" || page.Entries[0].Lines != 1 || page.Entries[0].TotalUnits != 1 {
		t.Fatal("an empty note and a single line must be summarized exactly")
	}
	// Every row carries the supplier of its own document.
	for _, row := range page.Entries {
		if row.Supplier == nil || row.Supplier.ID != 1 || row.Supplier.Name != stockEntrySupplierName {
			t.Fatal("a history row must carry the supplier of its document")
		}
	}
	// The list is a summary: a document's lines never appear here.
	if body := f.serve(t, f.request(1, "GET", "/api/stock-entries", "")).Body.String(); strings.Contains(body, "variant_id") || strings.Contains(body, "location_id") {
		t.Fatal("the history must never expose per-line or header detail")
	}
	counter := f.reverse(t, ids[0], "http-history-counter-01", "error de carga", stockentries.Line{VariantID: 1, Quantity: -3})
	after := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries", "")))
	if after.TotalEntries != 4 || len(after.Entries) != 4 {
		t.Fatal("the original document and its counter-entry must both be listed")
	}
	if after.Entries[0].ID != counter || after.Entries[0].TotalUnits != -3 || after.Entries[0].Lines != 1 || after.Entries[0].ReversedBy != nil {
		t.Fatal("the counter-entry must be listed first with its own negative total")
	}
	var original *stockEntryHistoryRowWireDTO
	for i, row := range after.Entries {
		if row.ID == ids[0] {
			original = &after.Entries[i]
		}
	}
	if original == nil || original.TotalUnits != 3 || original.ReversedBy == nil || *original.ReversedBy != counter {
		t.Fatal("a reversed document must expose its counter-entry and keep its total")
	}
	// A counter-entry inherits the supplier of its original, so both rows agree.
	if after.Entries[0].Supplier == nil || original.Supplier == nil || *after.Entries[0].Supplier != *original.Supplier {
		t.Fatal("the counter-entry row must repeat the supplier of its original")
	}
	first := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries?page=1&page_size=10", "")))
	if first.Page != 1 || first.PageSize != 10 || first.TotalEntries != 4 || len(first.Entries) != 4 {
		t.Fatal("a ten-row page must report its own size and the total")
	}
	last := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries?page=1&page_size=50", "")))
	if last.PageSize != 50 || len(last.Entries) != 4 {
		t.Fatal("a fifty-row page must answer the same documents")
	}
	beyond := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries?page=1000000&page_size=50", "")))
	if len(beyond.Entries) != 0 || beyond.TotalEntries != 4 {
		t.Fatal("a page beyond the last one must be empty and keep the total")
	}
}

func TestStockEntryHTTPHistoryRejections(t *testing.T) {
	f := stockEntryFixture(t)
	f.rejected(t, f.request(0, "GET", "/api/stock-entries", ""), 401, "unauthenticated")
	f.rejected(t, f.request(2, "GET", "/api/stock-entries", ""), 403, "forbidden")
	f.rejected(t, f.request(3, "GET", "/api/stock-entries", ""), 403, "forbidden")
	for name, query := range map[string]string{
		"zero_page":          "?page=0",
		"padded_page":        "?page=01",
		"page_above_bound":   "?page=1000001",
		"word_page":          "?page=abc",
		"empty_page":         "?page=",
		"negative_page":      "?page=-1",
		"exponent_page":      "?page=1e3",
		"duplicate_page":     "?page=1&page=1",
		"duplicate_size":     "?page_size=25&page_size=25",
		"unknown_key":        "?operation_key=x",
		"size_not_admitted":  "?page_size=15",
		"zero_size":          "?page_size=0",
		"empty_size":         "?page_size=",
		"trailing_separator": "?page=1&",
		"empty_query":        "?",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", "/api/stock-entries"+query, ""), 400, "invalid_request")
		})
	}
	for _, verb := range []string{"PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, "/api/stock-entries", ""))
		if w.Code != 405 || w.Header().Get("Allow") != "GET, POST" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
}

func TestStockEntryQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		raw        string
		page, size int
		ok         bool
	}{
		"defaults":       {"", 1, 25, true},
		"explicit":       {"page=1&page_size=25", 1, 25, true},
		"bound":          {"page=1000000", 1000000, 25, true},
		"ten":            {"page_size=10", 1, 10, true},
		"fifty_reversed": {"page_size=50&page=3", 3, 50, true},
		"zero_page":      {"page=0", 0, 0, false},
		"page_bound":     {"page=1000001", 0, 0, false},
		"padded":         {"page=01", 0, 0, false},
		"signed":         {"page=+1", 0, 0, false},
		"fraction":       {"page=1.0", 0, 0, false},
		"empty":          {"page=", 0, 0, false},
		"duplicate":      {"page=1&page=1", 0, 0, false},
		"unknown":        {"page=1&status=all", 0, 0, false},
		"size":           {"page_size=20", 0, 0, false},
		"no_equals":      {"page", 0, 0, false},
		"trailing":       {"page=1&", 0, 0, false},
		"oversized":      {"?" + strings.Repeat("a", 5000) + "=1", 0, 0, false},
	} {
		t.Run(name, func(t *testing.T) {
			page, size, err := stockEntryQuery(tc.raw)
			if tc.ok {
				if err != nil || page != tc.page || size != tc.size {
					t.Fatal("an admitted query was refused")
				}
				return
			}
			if !errors.Is(err, stockentries.ErrInvalid) {
				t.Fatal("an inadmissible query was accepted")
			}
		})
	}
}

func TestStockEntryPage(t *testing.T) {
	counter := int64(9)
	stamp := time.Date(2026, 11, 4, 14, 20, 0, 0, time.UTC)
	valid := stockentries.EntryPage{Page: 1, PageSize: 25, TotalEntries: 2, Entries: []stockentries.EntrySummary{
		{ID: 9, Note: "", CreatedAt: stamp, Lines: 1, TotalUnits: -2, Supplier: &stockentries.Supplier{ID: 4, Name: "Proveedor Sur"}},
		{ID: 7, Note: "Remito 0002", CreatedAt: stamp, Lines: 2, TotalUnits: 18, ReversedBy: &counter,
			Supplier: &stockentries.Supplier{ID: 4, Name: "Proveedor Sur"}},
	}}
	dto, err := stockEntryPage(valid)
	if err != nil {
		t.Fatal("a persisted page was rejected")
	}
	if dto.Page != 1 || dto.PageSize != 25 || dto.TotalEntries != 2 || len(dto.Entries) != 2 {
		t.Fatal("page does not match the frozen contract")
	}
	if dto.Entries[0].ID != 9 || dto.Entries[0].TotalUnits != -2 || dto.Entries[0].ReversedBy != nil ||
		dto.Entries[0].CreatedAt != "2026-11-04T14:20:00Z" {
		t.Fatal("a counter-entry row changed shape")
	}
	if dto.Entries[0].Supplier == nil || dto.Entries[0].Supplier.ID != 4 || dto.Entries[0].Supplier.Name != "Proveedor Sur" {
		t.Fatal("a row does not carry its supplier")
	}
	if dto.Entries[1].ReversedBy == nil || *dto.Entries[1].ReversedBy != 9 || dto.Entries[1].Lines != 2 {
		t.Fatal("a reversed row changed shape")
	}
	clone := func() stockentries.EntryPage {
		page := valid
		page.Entries = append([]stockentries.EntrySummary(nil), valid.Entries...)
		for i := range page.Entries {
			if valid.Entries[i].Supplier != nil {
				supplier := *valid.Entries[i].Supplier
				page.Entries[i].Supplier = &supplier
			}
		}
		return page
	}
	for name, change := range map[string]func(*stockentries.EntryPage){
		"zero_page":         func(p *stockentries.EntryPage) { p.Page = 0 },
		"page_above_bound":  func(p *stockentries.EntryPage) { p.Page = 1000001 },
		"size_not_admitted": func(p *stockentries.EntryPage) { p.PageSize = 20 },
		"negative_total":    func(p *stockentries.EntryPage) { p.TotalEntries = -1 },
		"total_below_page":  func(p *stockentries.EntryPage) { p.Page = 2; p.TotalEntries = 5; p.Entries = p.Entries[:1] },
		"zero_id":           func(p *stockentries.EntryPage) { p.Entries[0].ID = 0 },
		"zero_time":         func(p *stockentries.EntryPage) { p.Entries[0].CreatedAt = time.Time{} },
		"no_lines":          func(p *stockentries.EntryPage) { p.Entries[0].Lines = 0 },
		"too_many_lines":    func(p *stockentries.EntryPage) { p.Entries[0].Lines = 191 },
		"units_above_bound": func(p *stockentries.EntryPage) { p.Entries[0].TotalUnits = 190_000_001 },
		"units_below_bound": func(p *stockentries.EntryPage) { p.Entries[0].TotalUnits = -190_000_001 },
		"long_note":         func(p *stockentries.EntryPage) { p.Entries[0].Note = strings.Repeat("a", 501) },
		"nul_note":          func(p *stockentries.EntryPage) { p.Entries[0].Note = "a\x00b" },
		"unsorted":          func(p *stockentries.EntryPage) { p.Entries[0], p.Entries[1] = p.Entries[1], p.Entries[0] },
		"self_reversal":     func(p *stockentries.EntryPage) { p.Entries[0].ReversedBy = &p.Entries[0].ID },
		"stale_reversal":    func(p *stockentries.EntryPage) { stale := int64(3); p.Entries[0].ReversedBy = &stale },
		"supplier_zero_id": func(p *stockentries.EntryPage) {
			p.Entries[0].Supplier = &stockentries.Supplier{ID: 0, Name: "Proveedor"}
		},
		"supplier_blank_name": func(p *stockentries.EntryPage) {
			p.Entries[0].Supplier = &stockentries.Supplier{ID: 1}
		},
		"supplier_long_name": func(p *stockentries.EntryPage) {
			p.Entries[0].Supplier = &stockentries.Supplier{ID: 1, Name: strings.Repeat("a", 65)}
		},
	} {
		page := clone()
		change(&page)
		if _, err := stockEntryPage(page); !errors.Is(err, stockentries.ErrUnavailable) {
			t.Fatalf("%s must not reach the wire", name)
		}
	}
	overflowing := stockentries.EntryPage{Page: 1, PageSize: 10, TotalEntries: 11}
	for i := 11; i >= 1; i-- {
		overflowing.Entries = append(overflowing.Entries,
			stockentries.EntrySummary{ID: int64(i), CreatedAt: stamp, Lines: 1, TotalUnits: 1})
	}
	if _, err := stockEntryPage(overflowing); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("a page with more rows than its size must not reach the wire")
	}
}

func (f *stockEntryHTTPFixture) count(t *testing.T, table string) int {
	t.Helper()
	var n int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM "+table).Scan(&n) != nil {
		t.Fatal("count query failed")
	}
	return n
}

// countWhere is count with a fixed predicate of this fixture's own tables.
func (f *stockEntryHTTPFixture) countWhere(t *testing.T, table, predicate string, args ...any) int {
	t.Helper()
	var n int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM "+table+" WHERE "+predicate, args...).Scan(&n) != nil {
		t.Fatal("count query failed")
	}
	return n
}

// balance is one persisted warehouse balance.
func (f *stockEntryHTTPFixture) balance(t *testing.T, location, variant int) (int64, int64) {
	t.Helper()
	var existing, reserved int64
	if f.p.QueryRow(f.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=$1 AND variant_id=$2", location, variant).Scan(&existing, &reserved) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

const validStockEntryReversalJSON = `{"operation_key":"http-reverse-key-0001","reason":"error de carga"}`

func TestStockEntryReversalDecoder(t *testing.T) {
	body := func(change func(map[string]any)) string {
		var value map[string]any
		if json.Unmarshal([]byte(validStockEntryReversalJSON), &value) != nil {
			t.Fatal("reversal fixture is not valid JSON")
		}
		change(value)
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal("reversal fixture is not encodable")
		}
		return string(raw)
	}
	t.Run("valid", func(t *testing.T) {
		for _, raw := range []string{
			validStockEntryReversalJSON,
			" \n" + validStockEntryReversalJSON + " \n",
			`{"reason":"error de carga","operation_key":"http-reverse-key-0001"}`,
			body(func(v map[string]any) { v["reason"] = strings.Repeat("ñ", 500) }),
			body(func(v map[string]any) { v["operation_key"] = strings.Repeat("a", 128) }),
			body(func(v map[string]any) { v["reason"] = " motivo " }),
		} {
			r := httptest.NewRequest("POST", "/api/stock-entries/1/reverse", strings.NewReader(raw))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			key, reason, err := decodeStockEntryReversal(r)
			if err != nil || key == "" || reason == "" {
				t.Fatalf("valid reversal framing rejected: %v", err)
			}
		}
	})
	t.Run("canonical_reason", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/api/stock-entries/1/reverse", strings.NewReader(body(func(v map[string]any) { v["reason"] = "  error de carga  " })))
		r.Header.Set("Content-Type", "application/json")
		if _, reason, err := decodeStockEntryReversal(r); err != nil || reason != "error de carga" {
			t.Fatal("the admitted reason must be canonicalized once")
		}
	})
	for name, raw := range map[string]string{
		"empty_object":      `{}`,
		"array_root":        `[]`,
		"null_root":         `null`,
		"truncated":         validStockEntryReversalJSON[:len(validStockEntryReversalJSON)-1],
		"trailing":          validStockEntryReversalJSON + `{}`,
		"unknown_key":       body(func(v map[string]any) { v["lines"] = []any{} }),
		"bare_reversal":     body(func(v map[string]any) { v["target_id"] = 1 }),
		"missing_key":       body(func(v map[string]any) { delete(v, "operation_key") }),
		"missing_reason":    body(func(v map[string]any) { delete(v, "reason") }),
		"duplicate_key":     `{"operation_key":"http-reverse-key-0001","operation_key":"http-reverse-key-0002","reason":"m"}`,
		"escaped_duplicate": `{"operation_key":"http-reverse-key-0001","\u0072eason":"m","reason":"m"}`,
		"null_key":          body(func(v map[string]any) { v["operation_key"] = nil }),
		"null_reason":       body(func(v map[string]any) { v["reason"] = nil }),
		"numeric_reason":    body(func(v map[string]any) { v["reason"] = 7 }),
		"short_key":         body(func(v map[string]any) { v["operation_key"] = "short" }),
		"long_key":          body(func(v map[string]any) { v["operation_key"] = strings.Repeat("a", 129) }),
		"unsafe_key":        body(func(v map[string]any) { v["operation_key"] = "http reverse key 0001" }),
		"nul_key":           body(func(v map[string]any) { v["operation_key"] = "http-reverse-key-0001\u0000" }),
		"empty_reason":      body(func(v map[string]any) { v["reason"] = "" }),
		"blank_reason":      body(func(v map[string]any) { v["reason"] = "  \t\n" }),
		"long_reason":       body(func(v map[string]any) { v["reason"] = strings.Repeat("ñ", 501) }),
		"nul_reason":        body(func(v map[string]any) { v["reason"] = "error\u0000de carga" }),
		"invalid_utf8":      strings.NewReplacer("error de carga", "error-\xff").Replace(validStockEntryReversalJSON),
		"oversized":         validStockEntryReversalJSON + strings.Repeat(" ", stockEntryBodyLimit),
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-entries/1/reverse", strings.NewReader(raw))
			r.Header.Set("Content-Type", "application/json")
			if _, _, err := decodeStockEntryReversal(r); !errors.Is(err, stockentries.ErrInvalid) {
				t.Fatal("invalid reversal framing accepted or unsanitized")
			}
		})
	}
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json", "application/json"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-entries/1/reverse", strings.NewReader(validStockEntryReversalJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, _, err := decodeStockEntryReversal(r); !errors.Is(err, stockentries.ErrInvalid) {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/stock-entries/1/reverse", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, _, err := decodeStockEntryReversal(r); !errors.Is(err, stockentries.ErrInvalid) {
		t.Fatal("body read error exposed")
	}
	if _, _, err := decodeStockEntryReversal(nil); !errors.Is(err, stockentries.ErrInvalid) {
		t.Fatal("nil request accepted")
	}
}

// create posts one ingress document and returns it.
func (f *stockEntryHTTPFixture) create(t *testing.T, body string) stockEntryDTO {
	t.Helper()
	w := f.serve(t, f.request(1, "POST", "/api/stock-entries", body))
	stockEntryObject(t, w, 201)
	var document stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &document) != nil || document.ID < 1 {
		t.Fatal("created document is not decodable")
	}
	return document
}

func reversalPath(id any) string { return fmt.Sprintf("/api/stock-entries/%v/reverse", id) }

func TestStockEntryHTTPReversal(t *testing.T) {
	f := stockEntryFixture(t)
	var ingressOne, ingressTwo, reservedOne, reservedTwo int64
	if f.p.QueryRow(f.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=1 AND variant_id=1").Scan(&ingressOne, &reservedOne) != nil {
		t.Fatal("balance read failed")
	}
	if f.p.QueryRow(f.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=1 AND variant_id=2").Scan(&ingressTwo, &reservedTwo) != nil {
		t.Fatal("balance read failed")
	}
	original := f.create(t, `{"operation_key":"http-reversal-original-1","supplier_id":1,"note":"Remito 0007","lines":[{"variant_id":1,"quantity":3},{"variant_id":2,"quantity":2}]}`)
	w := f.serve(t, f.request(1, "POST", reversalPath(original.ID), validStockEntryReversalJSON))
	value := stockEntryObject(t, w, 201)
	var counter stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &counter) != nil {
		t.Fatal("counter-entry is not decodable")
	}
	// The derived lines are exactly the negation of the original document.
	if counter.ID <= original.ID || counter.LocationID != 1 || counter.CreatedByAccountID != 1 || counter.Note != "" {
		t.Fatal("counter-entry header does not match the frozen contract")
	}
	if len(counter.Lines) != 2 || counter.Lines[0].VariantID != 1 || counter.Lines[0].Quantity != -3 ||
		counter.Lines[1].VariantID != 2 || counter.Lines[1].Quantity != -2 || counter.TotalUnits != -5 {
		t.Fatal("counter-entry does not carry the derived negative lines")
	}
	if string(value["total_units"]) != "-5" || string(value["note"]) != `""` {
		t.Fatal("exact counter-entry framing changed")
	}
	// The counter-entry inherits the supplier of its original: the reversal body
	// never carries one.
	if counter.Supplier == nil || original.Supplier == nil || *counter.Supplier != *original.Supplier {
		t.Fatal("the counter-entry must inherit the supplier of its original")
	}
	if n := f.countWhere(t, "stock_entries", "id=$1 AND supplier_id=1", counter.ID); n != 1 {
		t.Fatal("the inherited supplier must be persisted with the counter-entry")
	}
	if stamp, err := time.Parse(time.RFC3339, counter.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != counter.CreatedAt {
		t.Fatal("counter-entry created_at is not RFC3339")
	}
	var reason string
	if f.p.QueryRow(f.ctx, "SELECT reason FROM stock_entries WHERE id=$1", counter.ID).Scan(&reason) != nil || reason != "error de carga" {
		t.Fatal("the reversal reason was not persisted")
	}
	// The original document is unchanged and now reports its counter-entry.
	page := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries", "")))
	if page.TotalEntries != 2 || len(page.Entries) != 2 {
		t.Fatal("the original and its counter-entry must both be listed")
	}
	if page.Entries[0].ID != counter.ID || page.Entries[0].TotalUnits != -5 || page.Entries[0].Lines != 2 {
		t.Fatal("the counter-entry must be listed first with its negative total")
	}
	if page.Entries[1].ID != original.ID || page.Entries[1].TotalUnits != 5 ||
		page.Entries[1].ReversedBy == nil || *page.Entries[1].ReversedBy != counter.ID {
		t.Fatal("the reversed document must keep its total and expose its counter-entry")
	}
	var existingOne, existingTwo int64
	if f.p.QueryRow(f.ctx, "SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=1").Scan(&existingOne) != nil {
		t.Fatal("balance read failed")
	}
	if f.p.QueryRow(f.ctx, "SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=2").Scan(&existingTwo) != nil {
		t.Fatal("balance read failed")
	}
	if existingOne != ingressOne || existingTwo != ingressTwo {
		t.Fatal("the counter-entry must restore every balance")
	}
	// An exact replay of the same key, target and canonical reason is 200.
	replayed := f.stock(t)
	w = f.serve(t, f.request(1, "POST", reversalPath(original.ID), `{"operation_key":"http-reverse-key-0001","reason":"  error de carga  "}`))
	stockEntryObject(t, w, 200)
	var replay stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &replay) != nil || replay.ID != counter.ID ||
		replay.TotalUnits != counter.TotalUnits || len(replay.Lines) != len(counter.Lines) {
		t.Fatal("a reversal replay must return the persisted counter-entry")
	}
	if f.stock(t) != replayed {
		t.Fatal("a reversal replay must not change stored state")
	}
	if n := f.count(t, "stock_entries"); n != 2 {
		t.Fatal("a reversal replay must not create a second document")
	}
}

func TestStockEntryHTTPReversalRejections(t *testing.T) {
	f := stockEntryFixture(t)
	original := f.create(t, `{"operation_key":"http-reversal-refusal-1","supplier_id":1,"lines":[{"variant_id":1,"quantity":2}]}`)
	path := reversalPath(original.ID)
	f.rejected(t, f.request(0, "POST", path, validStockEntryReversalJSON), 401, "unauthenticated")
	f.rejected(t, f.request(2, "POST", path, validStockEntryReversalJSON), 403, "forbidden")
	f.rejected(t, f.request(3, "POST", path, validStockEntryReversalJSON), 403, "forbidden")
	foreign := f.request(1, "POST", path, validStockEntryReversalJSON)
	foreign.Header.Set("Origin", "http://example.test")
	f.rejected(t, foreign, 403, "forbidden")
	noCSRF := f.request(1, "POST", path, validStockEntryReversalJSON)
	noCSRF.Header.Del("X-CSRF-Token")
	f.rejected(t, noCSRF, 403, "forbidden")
	for _, verb := range []string{"GET", "PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, path, ""))
		if w.Code != 405 || w.Header().Get("Allow") != "POST" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
	t.Run("query_string", func(t *testing.T) {
		f.rejected(t, f.request(1, "POST", path+"?reason=x", validStockEntryReversalJSON), 400, "invalid_request")
	})
	for name, body := range map[string]string{
		"unknown_field":  strings.Replace(validStockEntryReversalJSON, `"reason":`, `"note":"x","reason":`, 1),
		"duplicate_key":  strings.Replace(validStockEntryReversalJSON, `"reason":`, `"reason":"a","reason":`, 1),
		"missing_reason": strings.Replace(validStockEntryReversalJSON, `"operation_key":"http-reverse-key-0001",`, ``, 1),
		"empty_reason":   strings.Replace(validStockEntryReversalJSON, `"error de carga"`, `""`, 1),
		"blank_reason":   strings.Replace(validStockEntryReversalJSON, `"error de carga"`, `"   "`, 1),
		"long_reason":    strings.Replace(validStockEntryReversalJSON, `"error de carga"`, strconv.Quote(strings.Repeat("ñ", 501)), 1),
		"short_key":      strings.Replace(validStockEntryReversalJSON, `"http-reverse-key-0001"`, `"short"`, 1),
		"trailing":       validStockEntryReversalJSON + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", path, body), 400, "invalid_request")
		})
	}
	// Only a canonical positive id segment is admitted: an aliased spelling is
	// a malformed request, never silently cleaned into a different document.
	for name, segment := range map[string]string{
		"padded": "0" + strconv.FormatInt(original.ID, 10),
		"word":   "abc",
		"sign":   "+" + strconv.FormatInt(original.ID, 10),
		"zero":   "0",
		"huge":   "9223372036854775808",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", reversalPath(segment), validStockEntryReversalJSON), 400, "invalid_request")
		})
	}
	// Path aliases are refused before ServeMux can clean or redirect them.
	for name, alias := range map[string]string{
		"missing":           reversalPath(999999999),
		"doubled_slash":     "/api/stock-entries//" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"dot_segment":       "/api/stock-entries/./" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"dot_dot_segment":   "/api/stock-entries/../" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"trailing_slash":    path + "/",
		"encoded_id":        "/api/stock-entries/%3" + "1/reverse",
		"encoded_slash":     "/api/stock-entries/" + strconv.FormatInt(original.ID, 10) + "%2Freverse",
		"encoded_dot":       "/api/stock-entries/%2E/" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"encoded_backslash": "/api/stock-entries/" + strconv.FormatInt(original.ID, 10) + "/reverse%5C",
		"unknown_action":    "/api/stock-entries/" + strconv.FormatInt(original.ID, 10) + "/borrar",
		// A single document is a served read route now, so its POST is
		// method_not_allowed (covered by the detail contract); only a route below
		// it stays unknown here.
		"unknown_route": "/api/stock-entries/" + strconv.FormatInt(original.ID, 10) + "/detalle",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", alias, validStockEntryReversalJSON), 404, "not_found")
		})
	}
	if n := f.count(t, "stock_entries"); n != 1 {
		t.Fatal("a rejected reversal must not create a document")
	}
}

func TestStockEntryHTTPReversalConflicts(t *testing.T) {
	f := stockEntryFixture(t)
	first := f.create(t, `{"operation_key":"http-reversal-conflict-1","supplier_id":1,"lines":[{"variant_id":1,"quantity":2}]}`)
	second := f.create(t, `{"operation_key":"http-reversal-conflict-2","supplier_id":1,"lines":[{"variant_id":2,"quantity":3}]}`)
	w := f.serve(t, f.request(1, "POST", reversalPath(first.ID), validStockEntryReversalJSON))
	stockEntryObject(t, w, 201)
	var counter stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &counter) != nil || counter.ID <= second.ID {
		t.Fatal("counter-entry is not decodable")
	}
	// A key bound to another reason or another target is a retry conflict.
	f.rejected(t, f.request(1, "POST", reversalPath(first.ID), `{"operation_key":"http-reverse-key-0001","reason":"otro motivo"}`), 409, "retry_conflict")
	f.rejected(t, f.request(1, "POST", reversalPath(second.ID), validStockEntryReversalJSON), 409, "retry_conflict")
	// The original already has one counter-entry, and the counter-entry is itself
	// a reversal: neither may be reversed again.
	f.rejected(t, f.request(1, "POST", reversalPath(first.ID), `{"operation_key":"http-reverse-key-0002","reason":"error de carga"}`), 409, "decision_conflict")
	f.rejected(t, f.request(1, "POST", reversalPath(counter.ID), `{"operation_key":"http-reverse-key-0003","reason":"error de carga"}`), 409, "decision_conflict")
	if n := f.count(t, "stock_entries"); n != 3 {
		t.Fatal("a refused reversal must not create a document")
	}
}

func TestStockEntryHTTPReversalRejectsUncoveredStock(t *testing.T) {
	f := stockEntryFixture(t)
	original := f.create(t, `{"operation_key":"http-reversal-uncovered-1","supplier_id":1,"lines":[{"variant_id":1,"quantity":2},{"variant_id":3,"quantity":4}]}`)
	// The stock of the second line was consumed after the ingress.
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET existing=reserved WHERE location_id=1 AND variant_id=3"); err != nil {
		t.Fatal("consumption setup failed")
	}
	f.rejected(t, f.request(1, "POST", reversalPath(original.ID), validStockEntryReversalJSON), 409, "insufficient_stock")
	var reversedBy *int64
	if f.p.QueryRow(f.ctx, "SELECT (SELECT id FROM stock_entries WHERE reverses_entry_id=$1)", original.ID).Scan(&reversedBy) != nil || reversedBy != nil {
		t.Fatal("a refused reversal must not persist a counter-entry")
	}
}

// stockEntryDetailWire admits only the frozen detail shape: eleven header keys
// and seven line keys (the variant identity plus the quantity), with no operation
// key, cost, account or stored column outside the contract.
func stockEntryDetailWire(t *testing.T, w *httptest.ResponseRecorder) stockEntryDetailDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("detail response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 11 {
		t.Fatal("detail whitelist changed")
	}
	for _, key := range []string{"id", "location_id", "note", "supplier", "created_at", "created_by_account_id",
		"reverses_entry_id", "reversed_by", "reason", "lines", "total_units"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("detail whitelist incomplete: %s", key)
		}
	}
	var lines []map[string]json.RawMessage
	if json.Unmarshal(top["lines"], &lines) != nil || len(lines) == 0 {
		t.Fatal("detail lines are not an array")
	}
	for _, line := range lines {
		if len(line) != 7 {
			t.Fatal("detail line whitelist changed")
		}
		for _, key := range []string{"variant_id", "kind", "name", "detail", "battery", "fields", "quantity"} {
			if _, ok := line[key]; !ok {
				t.Fatalf("detail line whitelist incomplete: %s", key)
			}
		}
		// The line carries the variant identity of the contract, which is never a
		// blank name or detail and never a battery attribute a product lacks.
		var identity catalog.Identity
		identityJSON, marshalErr := json.Marshal(line)
		if marshalErr != nil || json.Unmarshal(identityJSON, &identity) != nil || identity.Valid() != nil {
			t.Fatal("detail line identity is malformed")
		}
		if !regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`).MatchString(string(line["quantity"])) {
			t.Fatal("quantity must be a canonical integer")
		}
	}
	var detail stockEntryDetailDTO
	if json.Unmarshal(w.Body.Bytes(), &detail) != nil {
		t.Fatal("detail response is not decodable")
	}
	if len(detail.Lines) != len(lines) {
		t.Fatal("detail lines are inconsistent")
	}
	return detail
}

// identityOfVariant is the persisted identity of one variant, read straight from
// the database, so the detail read is compared with the ledger instead of with
// itself.
func identityOfVariant(t *testing.T, f *stockEntryHTTPFixture, variant int64) catalog.Identity {
	t.Helper()
	var row catalog.Row
	var capacity *string
	err := f.p.QueryRow(f.ctx, `SELECT v.id,e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),
  e.capacity_ah::text,coalesce(v.polarity,''),coalesce(e.name,'')
 FROM catalog_variants v JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE v.id=$1`, int32(variant)).Scan(
		&row.VariantID, &row.CatalogEntryID, &row.Kind, &row.Brand, &row.Model, &capacity, &row.Polarity, &row.Name)
	if err != nil {
		t.Fatal("catalogue identity read failed")
	}
	if capacity != nil {
		row.Capacity = *capacity
	}
	known, err := catalog.ReadFields(f.ctx, f.p, []int32{int32(row.CatalogEntryID)})
	if err != nil {
		t.Fatal("persisted fields are not readable")
	}
	identity, err := row.Identity(known[row.CatalogEntryID])
	if err != nil {
		t.Fatalf("persisted identity of variant %d is not readable: %v", variant, err)
	}
	return identity
}

// sameIdentity compares two identities as the wire spells them, so a battery
// attribute or a typed field the read invented is a difference.
func sameIdentity(t *testing.T, got, want catalog.Identity) bool {
	t.Helper()
	gotJSON, gotErr := json.Marshal(got)
	wantJSON, wantErr := json.Marshal(want)
	return gotErr == nil && wantErr == nil && string(gotJSON) == string(wantJSON)
}

// foreignDocument persists a document of another location with the admission and
// balance triggers disabled for the shortest possible window: only the database
// may refuse such a document in normal operation, and this fixture needs one to
// prove the detail route never crosses the warehouse boundary.
func (f *stockEntryHTTPFixture) foreignDocument(t *testing.T) int64 {
	t.Helper()
	enable := func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		for _, statement := range []string{
			"ALTER TABLE stock_entry_lines ENABLE TRIGGER USER",
			"ALTER TABLE stock_entries ENABLE TRIGGER USER",
		} {
			_, _ = f.p.Exec(cleanup, statement)
		}
	}
	t.Cleanup(enable)
	for _, statement := range []string{
		"ALTER TABLE stock_entry_lines DISABLE TRIGGER USER",
		"ALTER TABLE stock_entries DISABLE TRIGGER USER",
	} {
		if _, err := f.p.Exec(f.ctx, statement); err != nil {
			t.Fatal("foreign document fixture setup failed")
		}
	}
	var id int64
	if err := f.p.QueryRow(f.ctx, `INSERT INTO stock_entries(operation_key,location_id,note,created_by_account_id)
 VALUES('http-foreign-detail-01',2,'sucursal',1) RETURNING id`).Scan(&id); err != nil {
		enable()
		t.Fatal("foreign document insert failed")
	}
	if _, err := f.p.Exec(f.ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(1), int64(1)); err != nil {
		enable()
		t.Fatal("foreign document line insert failed")
	}
	enable()
	return id
}

func detailPath(id any) string { return fmt.Sprintf("/api/stock-entries/%v", id) }

// historicalDocument persists one warehouse document exactly like the migration
// before suppliers wrote it: only the supplier trigger is disabled for the window
// of the insert, so the row keeps a NULL supplier while every other guard
// (location admission, balances, line sign) still runs.
func (f *stockEntryHTTPFixture) historicalDocument(t *testing.T) int64 {
	t.Helper()
	enable := func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_, _ = f.p.Exec(cleanup, "ALTER TABLE stock_entries ENABLE TRIGGER require_stock_entry_supplier")
	}
	t.Cleanup(enable)
	if _, err := f.p.Exec(f.ctx, "ALTER TABLE stock_entries DISABLE TRIGGER require_stock_entry_supplier"); err != nil {
		t.Fatal("historical document fixture setup failed")
	}
	var id int64
	if err := f.p.QueryRow(f.ctx, `INSERT INTO stock_entries(operation_key,location_id,note,created_by_account_id)
 VALUES('http-historical-entry-01',1,'ingreso historico',1) RETURNING id`).Scan(&id); err != nil {
		enable()
		t.Fatal("historical document insert failed")
	}
	for _, line := range []stockentries.Line{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 3}} {
		if _, err := f.p.Exec(f.ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
			enable()
			t.Fatal("historical document line insert failed")
		}
	}
	enable()
	return id
}

// seedOtherProduct writes one other product exactly like the catalog route does:
// a free name, one polarity-less variant that the balance fan-out stocks with
// zero in every active location, and one typed field.
func seedOtherProduct(t *testing.T, ctx context.Context, p *pgxpool.Pool, name, fieldName, unit, number string) int64 {
	t.Helper()
	var entry, variant int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product fixture setup failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, entry); err != nil {
		t.Fatal("product variant fixture setup failed")
	}
	if err := p.QueryRow(ctx, `SELECT id FROM catalog_variants WHERE catalog_entry_id=$1`, entry).Scan(&variant); err != nil {
		t.Fatal("product variant read failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,$2,'number',$3,$4::numeric)`, entry, fieldName, unit, number); err != nil {
		t.Fatal("product field fixture setup failed")
	}
	return variant
}

// An ingress document is of one kind. A product-only document is the wire line it
// always was and reads back with the product identity, and a document that names
// both kinds is refused whole with 400 invalid_request and writes nothing.
func TestStockEntryHTTPOtherProduct(t *testing.T) {
	f := stockEntryFixture(t)
	variant := seedOtherProduct(t, f.ctx, f.p, "Agua acidulada", "volumen en L", "L", "5")
	f.offer(t, 1, variant)
	w := f.serve(t, f.request(1, "POST", "/api/stock-entries",
		fmt.Sprintf(`{"operation_key":"http-other-entry-key-01","supplier_id":1,"note":"compra de proveedor","lines":[{"variant_id":%d,"quantity":6}]}`, variant)))
	stockEntryObject(t, w, 201)
	var document stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &document) != nil || document.ID < 1 || document.TotalUnits != 6 ||
		len(document.Lines) != 1 || document.Lines[0].VariantID != variant || document.Lines[0].Quantity != 6 {
		t.Fatal("a product-only document is still the wire document")
	}
	// The document is readable after it is written: the product line carries its own
	// identity and no invented battery attribute.
	detail := stockEntryDetailWire(t, f.serve(t, f.request(1, "GET", detailPath(document.ID), "")))
	if len(detail.Lines) != 1 || detail.TotalUnits != 6 {
		t.Fatal("the product ingress detail must carry its line")
	}
	line := detail.Lines[0]
	if line.Kind != catalog.OtherKind || line.Name != "Agua acidulada" ||
		line.Detail != "volumen en L: 5 L" || line.Battery != nil || len(line.Fields) != 1 ||
		line.Quantity != 6 || !sameIdentity(t, line.Identity, identityOfVariant(t, f, variant)) {
		t.Fatalf("the product line must carry its product identity: %+v", line)
	}
	// A document whose lines name both kinds is refused whole.
	for name, lines := range map[string]string{
		"battery_then_product": fmt.Sprintf(`{"operation_key":"http-other-mixed-key-01","supplier_id":1,"lines":[{"variant_id":1,"quantity":2},{"variant_id":%d,"quantity":3}]}`, variant),
		"product_then_battery": fmt.Sprintf(`{"operation_key":"http-other-mixed-key-02","supplier_id":1,"lines":[{"variant_id":%d,"quantity":3},{"variant_id":1,"quantity":2}]}`, variant),
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", "/api/stock-entries", lines), 400, "invalid_request")
		})
	}
	if n := f.count(t, "stock_entries"); n != 1 {
		t.Fatal("a mixed document must not persist a document")
	}
	// The same warehouse still admits the product alone, so the refusal is the
	// mixing and not the product.
	second := f.create(t, fmt.Sprintf(`{"operation_key":"http-other-entry-key-02","supplier_id":1,"lines":[{"variant_id":%d,"quantity":1}]}`, variant))
	if second.TotalUnits != 1 {
		t.Fatal("a product-only document must still be admitted")
	}
}

func TestStockEntryHTTPDetail(t *testing.T) {
	f := stockEntryFixture(t)
	original := f.create(t, `{"operation_key":"http-detail-original-1","supplier_id":1,"note":"Remito 0002-00045871","lines":[{"variant_id":9,"quantity":15},{"variant_id":4,"quantity":3}]}`)
	w := f.serve(t, f.request(1, "GET", detailPath(original.ID), ""))
	detail := stockEntryDetailWire(t, w)
	if detail.ID != original.ID || detail.LocationID != 1 || detail.CreatedByAccountID != 1 ||
		detail.Note != "Remito 0002-00045871" || detail.ReversesEntryID != nil || detail.ReversedBy != nil ||
		detail.Reason != "" || detail.TotalUnits != 18 || len(detail.Lines) != 2 {
		t.Fatal("detail does not match the frozen contract")
	}
	if stamp, err := time.Parse(time.RFC3339, detail.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != detail.CreatedAt {
		t.Fatal("detail created_at is not RFC3339")
	}
	// The detail carries the supplier the document names, with its stored name.
	if detail.Supplier == nil || detail.Supplier.ID != 1 || detail.Supplier.Name != stockEntrySupplierName {
		t.Fatal("the detail must carry the supplier of the document")
	}
	// Lines are ordered by variant id and carry the catalogue identity of each
	// variant exactly as the inventory read renders it.
	if detail.Lines[0].VariantID != 4 || detail.Lines[0].Quantity != 3 ||
		detail.Lines[1].VariantID != 9 || detail.Lines[1].Quantity != 15 {
		t.Fatal("detail lines are not the variant-ordered persisted lines")
	}
	for _, line := range detail.Lines {
		if !sameIdentity(t, line.Identity, identityOfVariant(t, f, int64(line.VariantID))) {
			t.Fatalf("line %d does not carry its catalogue identity", line.VariantID)
		}
	}
	// Nothing stored outside the contract reaches the wire.
	body := w.Body.String()
	for _, leaked := range []string{"operation_key", "cost", "contact", "username", "display_name", "updated_at", "location_name"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("detail leaked a stored field: %s", leaked)
		}
	}
	// The original reports its counter-entry once it exists, and the counter-entry
	// reports the original it reverses, its motive and its negative lines.
	w = f.serve(t, f.request(1, "POST", reversalPath(original.ID), validStockEntryReversalJSON))
	stockEntryObject(t, w, 201)
	var counter stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &counter) != nil {
		t.Fatal("counter-entry is not decodable")
	}
	counterDetail := stockEntryDetailWire(t, f.serve(t, f.request(1, "GET", detailPath(counter.ID), "")))
	if counterDetail.ID != counter.ID || counterDetail.ReversesEntryID == nil || *counterDetail.ReversesEntryID != original.ID ||
		counterDetail.ReversedBy != nil || counterDetail.Reason != "error de carga" || counterDetail.Note != "" ||
		counterDetail.TotalUnits != -18 {
		t.Fatal("counter-entry detail does not match the frozen contract")
	}
	if len(counterDetail.Lines) != 2 || counterDetail.Lines[0].VariantID != 4 || counterDetail.Lines[0].Quantity != -3 ||
		counterDetail.Lines[1].VariantID != 9 || counterDetail.Lines[1].Quantity != -15 {
		t.Fatal("counter-entry detail does not carry the exact negative lines")
	}
	for _, line := range counterDetail.Lines {
		if line.Identity.Valid() != nil || !sameIdentity(t, line.Identity, identityOfVariant(t, f, int64(line.VariantID))) {
			t.Fatalf("counter-entry line %d has no catalogue identity", line.VariantID)
		}
	}
	// The counter-entry detail repeats the supplier of its original.
	if counterDetail.Supplier == nil || detail.Supplier == nil || *counterDetail.Supplier != *detail.Supplier {
		t.Fatal("the counter-entry detail must repeat the supplier of its original")
	}
	reversed := stockEntryDetailWire(t, f.serve(t, f.request(1, "GET", detailPath(original.ID), "")))
	if reversed.ReversedBy == nil || *reversed.ReversedBy != counter.ID || reversed.ReversesEntryID != nil ||
		reversed.Reason != "" || reversed.TotalUnits != 18 {
		t.Fatal("a reversed document must expose its counter-entry and keep its own header")
	}
	// The collection routes are untouched by the detail route.
	history := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries", "")))
	if history.TotalEntries != 2 || len(history.Entries) != 2 {
		t.Fatal("the history route must keep answering after the detail route")
	}
}

func TestStockEntryHTTPDetailRejections(t *testing.T) {
	f := stockEntryFixture(t)
	original := f.create(t, `{"operation_key":"http-detail-refusal-1","supplier_id":1,"lines":[{"variant_id":1,"quantity":2}]}`)
	path := detailPath(original.ID)
	foreign := f.foreignDocument(t)
	f.rejected(t, f.request(0, "GET", path, ""), 401, "unauthenticated")
	f.rejected(t, f.request(2, "GET", path, ""), 403, "forbidden")
	f.rejected(t, f.request(3, "GET", path, ""), 403, "forbidden")
	for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, path, ""))
		if w.Code != 405 || w.Header().Get("Allow") != "GET" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
	// An unknown document and a document of another location are the same answer.
	f.rejected(t, f.request(1, "GET", detailPath(999999999), ""), 404, "not_found")
	f.rejected(t, f.request(1, "GET", detailPath(foreign), ""), 404, "not_found")
	// A non-canonical id segment is a malformed request, never a cleaned id.
	for name, segment := range map[string]string{
		"zero":     "0",
		"padded":   "0" + strconv.FormatInt(original.ID, 10),
		"sign":     "+" + strconv.FormatInt(original.ID, 10),
		"word":     "abc",
		"fraction": strconv.FormatInt(original.ID, 10) + ".0",
		"huge":     "9223372036854775808",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", detailPath(segment), ""), 400, "invalid_request")
		})
	}
	// A query string is not part of the detail contract.
	t.Run("query_string", func(t *testing.T) {
		f.rejected(t, f.request(1, "GET", path+"?page=1", ""), 400, "invalid_request")
	})
	t.Run("bare_query", func(t *testing.T) {
		f.rejected(t, f.request(1, "GET", path+"?", ""), 400, "invalid_request")
	})
	// Path aliases are refused before ServeMux can clean or redirect them.
	for name, alias := range map[string]string{
		"doubled_slash":     "/api/stock-entries//" + strconv.FormatInt(original.ID, 10),
		"dot_segment":       "/api/stock-entries/./" + strconv.FormatInt(original.ID, 10),
		"dot_dot_segment":   "/api/stock-entries/../" + strconv.FormatInt(original.ID, 10),
		"trailing_slash":    path + "/",
		"encoded_slash":     path + "%2F",
		"encoded_dot":       "/api/stock-entries/%2E/" + strconv.FormatInt(original.ID, 10),
		"encoded_backslash": path + "%5C",
		"unknown_action":    path + "/detalle",
		"reverse_trailing":  path + "/reverse/",
		"empty_segment":     "/api/stock-entries/",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", alias, ""), 404, "not_found")
		})
	}
	if n := f.count(t, "stock_entries"); n != 2 {
		t.Fatal("a rejected detail read must not create a document")
	}
}

// A document written before suppliers existed keeps a null supplier: it reads,
// lists and reverses exactly like any other document, and its supplier is null on
// the wire instead of an invented one.
func TestStockEntryHTTPHistoricalDocument(t *testing.T) {
	f := stockEntryFixture(t)
	existingOne, _ := f.balance(t, 1, 1)
	id := f.historicalDocument(t)
	// The detail exposes supplier:null and every other field unchanged.
	w := f.serve(t, f.request(1, "GET", detailPath(id), ""))
	detail := stockEntryDetailWire(t, w)
	if detail.ID != id || detail.Note != "ingreso historico" || detail.TotalUnits != 5 ||
		len(detail.Lines) != 2 || detail.Supplier != nil {
		t.Fatal("a historical document must read with a null supplier")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &raw) != nil || string(raw["supplier"]) != "null" {
		t.Fatal("the supplier of a historical document must be null on the wire")
	}
	// The history row keeps the same null supplier.
	page := stockEntryHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-entries", "")))
	if page.TotalEntries != 1 || len(page.Entries) != 1 || page.Entries[0].ID != id || page.Entries[0].Supplier != nil {
		t.Fatal("a historical document must be listed with a null supplier")
	}
	// It still reverses, and the counter-entry inherits the null supplier: the
	// reversal body never carries one.
	w = f.serve(t, f.request(1, "POST", reversalPath(id), validStockEntryReversalJSON))
	value := stockEntryObject(t, w, 201)
	var counter stockEntryDTO
	if json.Unmarshal(w.Body.Bytes(), &counter) != nil || counter.ID <= id {
		t.Fatal("the counter-entry of a historical document is not decodable")
	}
	if counter.Supplier != nil || counter.TotalUnits != -5 || string(value["supplier"]) != "null" {
		t.Fatal("the counter-entry of a historical document must keep the null supplier")
	}
	if n := f.countWhere(t, "stock_entries", "id=$1 AND supplier_id IS NULL", counter.ID); n != 1 {
		t.Fatal("the counter-entry must persist a null supplier")
	}
	if got, _ := f.balance(t, 1, 1); got != existingOne {
		t.Fatal("the counter-entry must restore the historical ingress")
	}
}
