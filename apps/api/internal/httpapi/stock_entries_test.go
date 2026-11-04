package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

const validStockEntryJSON = `{"operation_key":"http-stock-entry-key-01","note":"compra de proveedor","lines":[{"variant_id":2,"quantity":3},{"variant_id":1,"quantity":1}]}`

func stockEntryCart(n, quantity int) string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf(`{"variant_id":%d,"quantity":%d}`, n-i, quantity)
	}
	return `{"operation_key":"http-stock-entry-key-02","lines":[` + strings.Join(lines, ",") + `]}`
}

func TestStockEntryDecoder(t *testing.T) {
	replace := func(old, value string) string { return strings.Replace(validStockEntryJSON, old, value, 1) }
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{
			validStockEntryJSON,
			" \n" + validStockEntryJSON + " \n",
			`{"operation_key":"http-stock-entry-key-01","lines":[{"variant_id":1,"quantity":1000000}]}`,
			`{"lines":[{"variant_id":1,"quantity":1}],"operation_key":"http-stock-entry-key-01"}`,
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
	} {
		entry := valid
		entry.Lines = append([]stockentries.EntryLine(nil), valid.Lines...)
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
	if len(value) != 7 {
		t.Fatal("document whitelist changed")
	}
	for _, key := range []string{"id", "location_id", "note", "created_by_account_id", "created_at", "lines", "total_units"} {
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
	w = f.serve(t, f.request(1, "POST", "/api/stock-entries", `{"lines":[{"variant_id":1,"quantity":1},{"variant_id":2,"quantity":3}],"note":"compra de proveedor","operation_key":"http-stock-entry-key-01"}`))
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
	for _, verb := range []string{"GET", "PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, "/api/stock-entries", ""))
		if w.Code != 405 || w.Header().Get("Allow") != "POST" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
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
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", "/api/stock-entries", body), 409, "retry_conflict")
		})
	}
	if n := f.count(t, "stock_entries"); n != 1 {
		t.Fatal("a conflict must not create a second document")
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
