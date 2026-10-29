package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
	"luson/api/internal/webui"
)

const validTransferJSON = `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"http-retry-key-00001","items":[{"variant_id":1,"quantity":"1"}]}`

func transferConfig(t *testing.T) config.Auth {
	t.Helper()
	cfg, err := config.ParseAuth(config.LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "")
	if err != nil {
		t.Fatal("test auth configuration failed")
	}
	return cfg
}
func TestR02TransfersConstructor(t *testing.T) {
	cfg := transferConfig(t)
	for mask := 1; mask < 8; mask++ {
		t.Run(fmt.Sprintf("nil_mask_%d", mask), func(t *testing.T) {
			svc := &auth.Service{}
			stock := inventory.New(&pgxpool.Pool{})
			requests := transfers.New(&pgxpool.Pool{})
			if mask&1 != 0 {
				svc = nil
			}
			if mask&2 != 0 {
				stock = nil
			}
			if mask&4 != 0 {
				requests = nil
			}
			h, err := NewWithTransfers(svc, cfg, stock, requests)
			if err == nil || h != nil {
				t.Fatal("required nil dependency accepted")
			}
		})
	}
	badConfigs := []config.Auth{{}, cfg, cfg, cfg, cfg}
	badConfigs[1].Secure = true
	badConfigs[2].Origin = "http://example.test"
	badConfigs[3].Origin += "/path"
	badConfigs[4].Listen = "0.0.0.0:8080"
	for i, bad := range badConfigs {
		t.Run(fmt.Sprintf("invalid_config_%d", i), func(t *testing.T) {
			if h, err := NewWithTransfers(&auth.Service{}, bad, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{})); err == nil || h != nil {
				t.Fatal("invalid auth configuration accepted")
			}
		})
	}
	h, err := NewWithTransfers(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}))
	if err != nil || h == nil {
		t.Fatal("explicit constructor unavailable")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/transfers", nil))
	expectTransferError(t, w, 401, "unauthenticated")
	for _, legacy := range []http.Handler{New(nil, cfg), New(nil, cfg, inventory.New(nil)), New(nil, cfg, inventory.New(nil), inventory.New(nil))} {
		for _, path := range []string{"/api/transfers", "/api/transfers/1"} {
			for _, verb := range []string{"GET", "POST", "HEAD"} {
				w := httptest.NewRecorder()
				legacy.ServeHTTP(w, httptest.NewRequest(verb, path, nil))
				if w.Code != 404 {
					t.Fatal("legacy constructor unexpectedly enabled transfers")
				}
			}
		}
	}
}
func transferMalformedBodies() map[string]string {
	replace := func(old, value string) string { return strings.Replace(validTransferJSON, old, value, 1) }
	return map[string]string{
		"unknown":                  replace(`"kind":`, `"actor":2,"kind":`),
		"identity_override":        replace(`"kind":`, `"creator_location_id":3,"kind":`),
		"reference_override":       replace(`"kind":`, `"reference":"TR-001","kind":`),
		"casefold":                 replace(`"kind":`, `"Kind":`),
		"duplicate":                replace(`"kind":`, `"kind":"request_stock","kind":`),
		"escaped_duplicate":        replace(`"kind":`, `"\u006bind":"request_stock","kind":`),
		"nested_duplicate":         replace(`"variant_id":1`, `"variant_id":1,"variant_id":2`),
		"nested_escaped_duplicate": replace(`"quantity":"1"`, `"quantity":"1","\u0071uantity":"1"`),
		"nested_casefold":          replace(`"quantity":`, `"Quantity":`),
		"nested_unknown":           replace(`"quantity":`, `"origin_location_id":1,"quantity":`),
		"missing_kind":             replace(`"kind":"request_stock",`, ``),
		"missing_counterparty":     replace(`"counterparty_location_id":1,`, ``),
		"missing_key":              replace(`"retry_key":"http-retry-key-00001",`, ``),
		"missing_quantity":         replace(`,"quantity":"1"`, ``),
		"null_kind":                replace(`"kind":"request_stock"`, `"kind":null`),
		"null_counterparty":        replace(`"counterparty_location_id":1`, `"counterparty_location_id":null`),
		"null_key":                 replace(`"retry_key":"http-retry-key-00001"`, `"retry_key":null`),
		"null_items":               replace(`[{"variant_id":1,"quantity":"1"}]`, `null`),
		"null_line":                replace(`[{"variant_id":1,"quantity":"1"}]`, `[null]`),
		"null_quantity":            replace(`"quantity":"1"`, `"quantity":null`),
		"numeric_quantity":         replace(`"quantity":"1"`, `"quantity":1`),
		"float_quantity":           replace(`"quantity":"1"`, `"quantity":"1.0"`),
		"exponent_quantity":        replace(`"quantity":"1"`, `"quantity":"1e0"`),
		"zero_quantity":            replace(`"quantity":"1"`, `"quantity":"0"`),
		"negative_quantity":        replace(`"quantity":"1"`, `"quantity":"-1"`),
		"signed_quantity":          replace(`"quantity":"1"`, `"quantity":"+1"`),
		"padded_quantity":          replace(`"quantity":"1"`, `"quantity":"01"`),
		"spaced_quantity":          replace(`"quantity":"1"`, `"quantity":" 1"`),
		"quantity_overflow":        replace(`"quantity":"1"`, `"quantity":"9223372036854775808"`),
		"string_id":                replace(`"variant_id":1`, `"variant_id":"1"`),
		"zero_id":                  replace(`"variant_id":1`, `"variant_id":0`),
		"negative_id":              replace(`"variant_id":1`, `"variant_id":-1`),
		"float_id":                 replace(`"variant_id":1`, `"variant_id":1.0`),
		"exponent_id":              replace(`"variant_id":1`, `"variant_id":1e0`),
		"padded_id":                replace(`"variant_id":1`, `"variant_id":01`),
		"id_bound":                 replace(`"variant_id":1`, `"variant_id":2147483648`),
		"counterparty_float":       replace(`"counterparty_location_id":1`, `"counterparty_location_id":1.0`),
		"counterparty_string":      replace(`"counterparty_location_id":1`, `"counterparty_location_id":"1"`),
		"counterparty_bound":       replace(`"counterparty_location_id":1`, `"counterparty_location_id":4`),
		"bad_enum":                 replace(`"request_stock"`, `"approved"`),
		"short_key":                replace(`"http-retry-key-00001"`, `"short"`),
		"long_key":                 replace(`"http-retry-key-00001"`, strconv.Quote(strings.Repeat("a", 129))),
		"unsafe_key":               replace(`"http-retry-key-00001"`, `"http retry key 00001"`),
		"nul_key":                  replace(`"http-retry-key-00001"`, `"http-retry-key-\u0000"`),
		"duplicate_variant":        replace(`[{"variant_id":1,"quantity":"1"}]`, `[{"variant_id":1,"quantity":"1"},{"variant_id":1,"quantity":"2"}]`),
		"empty_items":              replace(`[{"variant_id":1,"quantity":"1"}]`, `[]`),
		"empty_object":             `{}`, "array_root": `[]`, "null_root": `null`, "truncated": validTransferJSON[:len(validTransferJSON)-1],
		"trailing": validTransferJSON + `{}`, "trailing_scalar": validTransferJSON + `true`, "invalid_utf8": replace("http-retry", "http-\xffretry"), "oversized": validTransferJSON + strings.Repeat(" ", 64<<10),
	}
}
func transferCart(n int, quantity string) string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf(`{"variant_id":%d,"quantity":%q}`, n-i, quantity)
	}
	return strings.Replace(validTransferJSON, `[{"variant_id":1,"quantity":"1"}]`, `[`+strings.Join(lines, ",")+`]`, 1)
}
func TestR02TransfersDecoder(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{validTransferJSON, " \n" + validTransferJSON + " \n", transferCart(190, "9223372036854775807"), strings.Replace(validTransferJSON, `"http-retry-key-00001"`, strconv.Quote(strings.Repeat("a", 128)), 1)} {
			r := httptest.NewRequest("POST", "/api/transfers", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			got, err := decodeTransfer(r)
			if err != nil || len(got.Items) == 0 {
				t.Fatal("valid framing rejected")
			}
		}
	})
	invalid := transferMalformedBodies()
	invalid["too_many_items"] = transferCart(191, "1")
	for name, body := range invalid {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/transfers", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			if _, err := decodeTransfer(r); err != transfers.ErrInvalid {
				t.Fatal("invalid framing accepted or unsanitized")
			}
		})
	}
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json", "application/json"}, {"application/json; charset=utf-8; x=y"}, {"application/json; charset=utf-8; charset=utf-8"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/transfers", strings.NewReader(validTransferJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, err := decodeTransfer(r); err != transfers.ErrInvalid {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/transfers", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, err := decodeTransfer(r); err != transfers.ErrInvalid {
		t.Fatal("body read error exposed")
	}
	if _, err := decodeTransfer(nil); err != transfers.ErrInvalid {
		t.Fatal("nil request accepted")
	}
	t.Run("query_boundaries", func(t *testing.T) {
		omitted, err := transferQuery("")
		if err != nil || omitted.Status != "pending" || omitted.Page != 1 || omitted.PageSize != 25 {
			t.Fatal("omitted query defaults changed")
		}
		all, err := transferQuery("status=all")
		if err != nil || all.Status != "all" {
			t.Fatal("explicit all query rejected")
		}
		dto, err := transferPage(transfers.Page{Page: all.Page, PageSize: all.PageSize, Status: all.Status})
		if err != nil || dto.Status != "all" || dto.TotalCount != "0" || dto.Records == nil {
			t.Fatal("all query echo changed")
		}
		for _, raw := range []string{"", "page=1&page_size=10&status=pending", "status=pending&page_size=25&page=1000000", "page_size=50", "status=approved", "status=rejected", "status=all"} {
			if _, err := transferQuery(raw); err != nil {
				t.Fatal("valid bounded query rejected")
			}
		}
		for _, raw := range invalidTransferQueries() {
			if _, err := transferQuery(raw); err != transfers.ErrInvalid {
				t.Fatal("invalid query accepted")
			}
		}
	})
	t.Run("lossless_large_count", func(t *testing.T) {
		w := httptest.NewRecorder()
		page, err := transferPage(transfers.Page{Page: 1, PageSize: 25, Status: "pending", Total: math.MaxInt64})
		if err != nil {
			t.Fatal("valid normalized page rejected")
		}
		respond(w, 200, page)
		total, records := transferWirePage(t, w)
		if total != math.MaxInt64 || len(records) != 0 {
			t.Fatal("int64 total lost precision or records became null")
		}
	})
	t.Run("error_mapping", func(t *testing.T) {
		for _, tc := range []struct {
			err  error
			code int
			name string
		}{{transfers.ErrInvalid, 400, "invalid_request"}, {transfers.ErrForbidden, 403, "forbidden"}, {transfers.ErrNotFound, 404, "not_found"}, {transfers.ErrInsufficientStock, 409, "insufficient_stock"}, {transfers.ErrRetryConflict, 409, "retry_conflict"}, {transfers.ErrUnavailable, 503, "service_unavailable"}, {context.Canceled, 503, "service_unavailable"}, {context.DeadlineExceeded, 503, "service_unavailable"}, {errors.New("private backend error"), 503, "service_unavailable"}} {
			w := httptest.NewRecorder()
			transferFailure(w, fmt.Errorf("wrapped: %w", tc.err))
			expectTransferError(t, w, tc.code, tc.name)
		}
	})
}

type transferErrorReader struct{}

func (transferErrorReader) Read([]byte) (int, error) { return 0, errors.New("private reader error") }
func invalidTransferQueries() []string {
	return []string{"page=0", "page=01", "page=-1", "page=+1", "page=1.0", "page=1e0", "page=1000001", "page=9223372036854775808", "page=", "page", "page=1&page=1", "page_size=0", "page_size=11", "page_size=050", "page_size=50&page_size=50", "status=", "status=Pending", "status=ALL", "status=%61ll", "status=all&status=all", "status=unsupported", "status=pending&status=pending", "actor=2", "location_id=1", "csrf_token=ignored", "page=%31", "%70age=1", "page=%ZZ", "page=%FF", "page=1;status=pending", "page=1&&page_size=25", "&page=1", "page=1&", "page=1=1", "page=" + strings.Repeat("1", 4096)}
}

type transferHTTPFixture struct {
	ctx      context.Context
	p        *pgxpool.Pool
	svc      *auth.Service
	cfg      config.Auth
	handler  http.Handler
	tokens   []string
	clock    *atomic.Int64
	baseline string
}

func transferFixture(t *testing.T) *transferHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("transfer HTTP fixture initialization failed")
	}
	creds := make([]bootstrap.Credentials, 3)
	for i := range creds {
		creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, creds) != nil {
		t.Fatal("transfer HTTP test provisioning failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("transfer HTTP operational fixture setup failed")
	}
	clock := &atomic.Int64{}
	clock.Store(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC).UnixNano())
	svc, err := auth.New(p, func() time.Time { return time.Unix(0, clock.Load()).UTC() })
	if err != nil {
		t.Fatal("transfer HTTP auth fixture failed")
	}
	f := &transferHTTPFixture{ctx: ctx, p: p, svc: svc, cfg: transferConfig(t), tokens: make([]string, 3), clock: clock}
	for i, c := range creds {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("test assigned login failed")
		}
		f.tokens[i] = token
	}
	f.handler, err = NewWithTransfers(svc, f.cfg, inventory.New(p), transfers.New(p))
	if err != nil {
		t.Fatal("transfer HTTP constructor failed")
	}
	f.baseline = f.stock(t)
	t.Cleanup(func() { f.unchanged(t) })
	return f
}
func (f *transferHTTPFixture) stock(t *testing.T) string {
	t.Helper()
	var count int
	var data string
	if f.p.QueryRow(f.ctx, `SELECT count(*),jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id)::text FROM inventory_balances b`).Scan(&count, &data) != nil || count != 570 {
		t.Fatal("complete stock snapshot failed")
	}
	return data
}
func (f *transferHTTPFixture) unchanged(t *testing.T) {
	t.Helper()
	if f.stock(t) != f.baseline {
		t.Fatal("HTTP changed one of 570 balances")
	}
}
func (f *transferHTTPFixture) newRequest(actor int, verb, path, body string) *http.Request {
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
func (f *transferHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("transfer security headers changed")
	}
	f.unchanged(t)
	return w
}
func (f *transferHTTPFixture) request(t *testing.T, actor int, verb, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return f.serve(t, f.newRequest(actor, verb, path, body))
}
func expectTransferError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status || w.Body.String() != fmt.Sprintf("{\"error\":\"%s\"}\n", code) || w.Header().Get("Content-Type") != "application/json" || len(w.Result().Cookies()) != 0 {
		t.Fatalf("sanitized HTTP error mismatch: status=%d want=%d", w.Code, status)
	}
}
func transferObject(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]json.RawMessage {
	t.Helper()
	var value map[string]json.RawMessage
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" || json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatalf("transfer JSON response mismatch: status=%d want=%d", w.Code, status)
	}
	transferBusinessFieldCount(t, value)
	return value
}
func transferWireRecord(t *testing.T, w *httptest.ResponseRecorder, status int) transferDTO {
	t.Helper()
	value := transferObject(t, w, status)
	want := []string{"id", "reference", "creator_location_id", "creator_location_name", "kind", "origin_location_id", "origin_location_name", "destination_location_id", "destination_location_name", "approver_location_id", "approver_location_name", "status", "created_at", "items"}
	if value["activity"] != nil {
		want = append(want, "activity")
	}
	if len(value) != len(want) {
		t.Fatal("record whitelist changed")
	}
	for _, key := range want {
		if value[key] == nil {
			t.Fatal("record whitelist incomplete")
		}
	}
	var dto transferDTO
	if json.Unmarshal(w.Body.Bytes(), &dto) != nil || dto.ID == "" || dto.Status != "pending" || len(dto.Items) == 0 {
		t.Fatal("record DTO incomplete")
	}
	stamp, err := time.Parse(time.RFC3339Nano, dto.CreatedAt)
	if err != nil || !strings.HasSuffix(dto.CreatedAt, "Z") || stamp.UTC().Format(time.RFC3339Nano) != dto.CreatedAt {
		t.Fatal("timestamp is not canonical UTC")
	}
	var items []map[string]json.RawMessage
	if json.Unmarshal(value["items"], &items) != nil {
		t.Fatal("item framing failed")
	}
	for _, item := range items {
		if len(item) != 6 {
			t.Fatal("item whitelist changed")
		}
		for _, key := range []string{"variant_id", "brand", "model", "capacity_ah", "polarity", "quantity"} {
			if item[key] == nil {
				t.Fatal("item whitelist incomplete")
			}
		}
		for _, key := range []string{"capacity_ah", "quantity"} {
			var text string
			if json.Unmarshal(item[key], &text) != nil {
				t.Fatal("exact value became a JSON number")
			}
		}
	}
	return dto
}
func transferWirePage(t *testing.T, w *httptest.ResponseRecorder) (int64, []transferDTO) {
	t.Helper()
	obj := transferObject(t, w, 200)
	if len(obj) != 7 {
		t.Fatal("page whitelist changed")
	}
	for _, key := range []string{"page", "page_size", "status", "total_count", "records", "requires_action", "required_actions"} {
		if obj[key] == nil {
			t.Fatal("page whitelist incomplete")
		}
	}
	var total string
	var records []transferDTO
	if json.Unmarshal(obj["total_count"], &total) != nil || json.Unmarshal(obj["records"], &records) != nil || records == nil || string(obj["status"]) != `"pending"` {
		t.Fatal("lossless count/empty array/status changed")
	}
	n, err := strconv.ParseInt(total, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != total {
		t.Fatal("count is not canonical decimal string")
	}
	return n, records
}
func TestR02TransfersHTTP(t *testing.T) {
	root := t
	t.Run("flows_privacy_replay_inventory", func(t *testing.T) { f := transferFixture(t); registerTransferAudit(root, f.p); testTransferFlows(t, f) })
	t.Run("framing_guards_methods", testTransferGuards)
	t.Run("lossless_complete_catalog", testTransferExact)
	t.Run("pagination_and_concurrent_retries", testTransferPagination)
	t.Run("unavailable_and_request_context", testTransferUnavailable)
	for _, mode := range []string{"revoked", "idle_expired", "absolute_expired", "recreated_service"} {
		t.Run(mode, func(t *testing.T) { testTransferSessionFailure(t, mode) })
	}
	t.Run("api_static_dispatch", testTransferDispatch)
}
func testTransferFlows(t *testing.T, f *transferHTTPFixture) {
	total, records := transferWirePage(t, f.request(t, 3, "GET", "/api/transfers", ""))
	if total != 0 || len(records) != 0 {
		t.Fatal("empty authorized page failed")
	}
	var created []transferDTO
	for _, tc := range []struct {
		name                              string
		actor                             int
		kind                              string
		counterparty, origin, destination int
	}{
		{"warehouse_request_a", 2, "request_stock", 1, 1, 2}, {"branch_request_a", 2, "request_stock", 3, 3, 2}, {"warehouse_proposal_a", 2, "send_to_warehouse", 1, 2, 1},
		{"warehouse_request_b", 3, "request_stock", 1, 1, 3}, {"branch_request_b", 3, "request_stock", 2, 2, 3}, {"warehouse_proposal_b", 3, "send_to_warehouse", 1, 3, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":%q,"items":[{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"1"}]}`, tc.kind, tc.counterparty, "http-flow-key-"+tc.name)
			w := f.request(t, tc.actor, "POST", "/api/transfers", body)
			dto := transferWireRecord(t, w, 201)
			created = append(created, dto)
			approver := tc.origin
			if tc.kind == "send_to_warehouse" {
				approver = 1
			}
			if dto.CreatorLocationID != tc.actor || dto.OriginLocationID != tc.origin || dto.DestinationLocationID != tc.destination || dto.ApproverLocationID != approver || dto.Kind != transfers.Kind(tc.kind) || dto.Items[0].VariantID != 1 || w.Header().Get("Location") != "/api/transfers/"+dto.ID {
				t.Fatal("trusted direction or canonical cart changed")
			}
			// Reordering the cart preserves the actor-scoped canonical retry payload.
			replayBody := strings.Replace(body, `{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"1"}`, `{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}`, 1)
			replay := f.request(t, tc.actor, "POST", "/api/transfers", replayBody)
			if !reflect.DeepEqual(dto, transferWireRecord(t, replay, 200)) || replay.Body.String() != w.Body.String() {
				t.Fatal("retry changed immutable public record")
			}
			conflict := strings.Replace(body, `"quantity":"1"`, `"quantity":"2"`, 1)
			expectTransferError(t, f.request(t, tc.actor, "POST", "/api/transfers", conflict), 409, "retry_conflict")
			for actor := 1; actor <= 3; actor++ {
				got := f.request(t, actor, "GET", "/api/transfers/"+dto.ID, "")
				if actor == tc.origin || actor == tc.destination {
					if !reflect.DeepEqual(dto, transferWireRecord(t, got, 200)) {
						t.Fatal("participant detail differs")
					}
				} else {
					expectTransferError(t, got, 404, "not_found")
					missing := f.request(t, actor, "GET", "/api/transfers/9223372036854775807", "")
					expectTransferError(t, missing, 404, "not_found")
					if got.Body.String() != missing.Body.String() {
						t.Fatal("private record existence leaked")
					}
				}
			}
		})
	}
	for actor := 1; actor <= 3; actor++ {
		total, records := transferWirePage(t, f.request(t, actor, "GET", "/api/transfers", ""))
		want := make([]transferDTO, 0)
		for i := len(created) - 1; i >= 0; i-- {
			r := created[i]
			if r.OriginLocationID == actor || r.DestinationLocationID == actor {
				want = append(want, r)
			}
		}
		if total != int64(len(want)) || !transferListDTOsEqual(t, records, want) {
			t.Fatal("list scope/count or descending order leaked")
		}
	}
	// The same opaque key is independently scoped to each authenticated branch.
	first := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", validTransferJSON), 201)
	second := transferWireRecord(t, f.request(t, 3, "POST", "/api/transfers", validTransferJSON), 201)
	if first.ID == second.ID || first.CreatorLocationID != 2 || second.CreatorLocationID != 3 {
		t.Fatal("retry key crossed actor authority")
	}
	expectTransferError(t, f.request(t, 1, "POST", "/api/transfers", validTransferJSON), 403, "forbidden")
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", strings.Replace(validTransferJSON, `"counterparty_location_id":1`, `"counterparty_location_id":2`, 1)), 400, "invalid_request")
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", strings.Replace(strings.Replace(validTransferJSON, "http-retry-key-00001", "http-unknown-variant-key", 1), `"variant_id":1`, `"variant_id":2147483647`, 1)), 400, "invalid_request")
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", strings.Replace(strings.Replace(validTransferJSON, "http-retry-key-00001", "http-insufficient-stock-key", 1), `"quantity":"1"`, `"quantity":"9223372036854775807"`, 1)), 409, "insufficient_stock")
	// All nine account/location inventory consultations preserve assigned identity.
	for actor := 1; actor <= 3; actor++ {
		meta := f.request(t, actor, "GET", "/api/inventory/metadata", "")
		if meta.Code != 200 {
			t.Fatal("inventory metadata regression")
		}
		for location := 1; location <= 3; location++ {
			w := f.request(t, actor, "GET", fmt.Sprintf("/api/inventory?location_id=%d", location), "")
			var page inventory.Page
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.TotalVariants != 190 || page.Location.ID != location || len(page.Items) != 10 {
				t.Fatal("nine inventory/account matrix regression")
			}
			for _, item := range page.Items {
				if item.Existing != int64((item.VariantID*7+location*11)%31) || item.Reserved != 0 || item.Available != item.Existing {
					t.Fatal("opening inventory changed")
				}
			}
		}
		session := f.request(t, actor, "GET", "/api/auth/session", "")
		var data struct {
			Authenticated bool          `json:"authenticated"`
			Identity      auth.Identity `json:"identity"`
		}
		if json.Unmarshal(session.Body.Bytes(), &data) != nil || !data.Authenticated || data.Identity.Location.ID != actor {
			t.Fatal("consultation reassigned actor")
		}
	}
}
func testTransferGuards(t *testing.T) {
	f := transferFixture(t)
	for name, body := range transferMalformedBodies() {
		t.Run(name, func(t *testing.T) {
			expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", body), 400, "invalid_request")
		})
	}
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", transferCart(191, "1")), 400, "invalid_request")
	for _, raw := range invalidTransferQueries() {
		expectTransferError(t, f.request(t, 2, "GET", "/api/transfers?"+raw, ""), 400, "invalid_request")
	}
	for _, path := range []string{"/api/transfers?page=1", "/api/transfers?"} {
		expectTransferError(t, f.request(t, 2, "POST", path, validTransferJSON), 400, "invalid_request")
	}
	for _, id := range []string{"0", "01", "-1", "+1", "1.0", "1e0", "9223372036854775808", "1abc", "%31"} {
		expectTransferError(t, f.request(t, 2, "GET", "/api/transfers/"+id, ""), 400, "invalid_request")
	}
	expectTransferError(t, f.request(t, 2, "GET", "/api/transfers/1?page=1", ""), 400, "invalid_request")
	for _, path := range []string{"/api/transfers/1/approve", "/api/transfers/1/reject", "/api/transfers/1/cancel", "/api/transfers/1/dispatch", "/api/transfers/1/receive", "/api/transfers/approve", "/api/transfers/", "/api/transfers//1", "/api/transfers/../inventory"} {
		for _, verb := range []string{"GET", "POST", "HEAD"} {
			want := 404
			if path == "/api/transfers/1/approve" || path == "/api/transfers/1/reject" || path == "/api/transfers/1/cancel" || path == "/api/transfers/1/dispatch" || path == "/api/transfers/1/receive" {
				want = 405
				if verb == "POST" {
					want = 400
				}
			}
			if f.request(t, 2, verb, path, "").Code != want {
				t.Fatal("unsupported/unsafe route did not fail closed")
			}
		}
	}
	for _, tc := range []struct {
		path, allow string
		verbs       []string
	}{{"/api/transfers", "GET, POST", []string{"PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}}, {"/api/transfers/1", "GET", []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}}} {
		for _, verb := range tc.verbs {
			w := f.request(t, 2, verb, tc.path, validTransferJSON)
			expectTransferError(t, w, 405, "method_not_allowed")
			if w.Header().Get("Allow") != tc.allow {
				t.Fatal("exact Allow changed")
			}
		}
	}
	for _, verb := range []string{"GET", "POST"} {
		expectTransferError(t, f.request(t, 0, verb, "/api/transfers", validTransferJSON), 401, "unauthenticated")
		r := f.newRequest(0, verb, "/api/transfers", validTransferJSON)
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "invalid"})
		expectTransferError(t, f.serve(t, r), 401, "unauthenticated")
		// A syntactically valid unissued token is not a live session.
		r = f.newRequest(0, verb, "/api/transfers", validTransferJSON)
		unissued, err := auth.RandomToken()
		if err != nil {
			t.Fatal("unissued test token generation failed")
		}
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: unissued})
		expectTransferError(t, f.serve(t, r), 401, "unauthenticated")
		for _, other := range []int{2, 3} {
			r = f.newRequest(2, verb, "/api/transfers", validTransferJSON)
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[other-1]})
			expectTransferError(t, f.serve(t, r), 400, "invalid_request")
		}
	}
	for name, mutate := range map[string]func(*http.Request){
		"missing_origin": func(r *http.Request) { r.Header.Del("Origin") }, "foreign_origin": func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") },
		"duplicate_origin": func(r *http.Request) { r.Header.Add("Origin", f.cfg.Origin) }, "missing_csrf": func(r *http.Request) { r.Header.Del("X-CSRF-Token") },
		"wrong_csrf": func(r *http.Request) { r.Header.Set("X-CSRF-Token", strings.Repeat("a", 43)) }, "duplicate_csrf": func(r *http.Request) { r.Header.Add("X-CSRF-Token", auth.CSRF(f.tokens[1])) },
		"csrf_for_other_session": func(r *http.Request) { r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[2])) },
		"foreign_fetch_site":     func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, "duplicate_fetch_site": func(r *http.Request) { r.Header.Add("Sec-Fetch-Site", "same-origin") }, "empty_fetch_site": func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "") },
	} {
		t.Run(name, func(t *testing.T) {
			r := f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
			mutate(r)
			expectTransferError(t, f.serve(t, r), 403, "forbidden")
		})
	}
	for _, media := range []string{"text/plain", "application/json; charset=latin1", "application/json; extra=value", "application/json; charset=utf-8; charset=utf-8", "application/json;"} {
		r := f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
		r.Header.Set("Content-Type", media)
		expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	}
	r := f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
	r.Header.Add("Content-Type", "application/json")
	expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	var count int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM transfer_requests").Scan(&count) != nil || count != 0 {
		t.Fatal("refused requests persisted transfer data")
	}
	// FetchSite is optional, exactly as the shared mutation guard documents.
	r = f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
	r.Header.Del("Sec-Fetch-Site")
	transferWireRecord(t, f.serve(t, r), 201)
}
func testTransferExact(t *testing.T) {
	f := transferFixture(t)
	// Deliberate owned-fixture setup, not an HTTP effect; recapture all 570 rows.
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET existing=$1 WHERE location_id=1", int64(math.MaxInt64)); err != nil {
		t.Fatal("owned lossless stock setup failed")
	}
	if _, err := f.p.Exec(f.ctx, "SELECT setval('transfer_requests_id_seq',9007199254740992,true)"); err != nil {
		t.Fatal("owned lossless reference setup failed")
	}
	f.baseline = f.stock(t)
	body := transferCart(190, "9223372036854775807")
	w := f.request(t, 2, "POST", "/api/transfers", body)
	dto := transferWireRecord(t, w, 201)
	if dto.ID != "9007199254740993" || dto.Reference != "TR-9007199254740993" || len(dto.Items) != 190 {
		t.Fatal("large reference or full cart lost")
	}
	fractional := false
	for i, item := range dto.Items {
		if item.VariantID != int64(i+1) || item.Quantity != "9223372036854775807" || (item.Polarity != "L" && item.Polarity != "R") {
			t.Fatal("lossless complete item data changed")
		}
		if item.Brand == "TOYO_MOTO" && item.Model == "12N6,5_3B" && item.CapacityAH == "6.5" {
			fractional = true
		}
	}
	if !fractional {
		t.Fatal("fractional catalog capacity lost")
	}
	for _, actor := range []int{1, 2} {
		if !reflect.DeepEqual(dto, transferWireRecord(t, f.request(t, actor, "GET", "/api/transfers/"+dto.ID, ""), 200)) {
			t.Fatal("lossless detail differs")
		}
		total, records := transferWirePage(t, f.request(t, actor, "GET", "/api/transfers", ""))
		if total != 1 || len(records) != 1 || !transferListDTOsEqual(t, records, []transferDTO{dto}) {
			t.Fatal("lossless list differs")
		}
	}
	// Explicit fixture-only availability change proves HTTP replay still uses
	// the original immutable record rather than revalidating present stock.
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET existing=0 WHERE location_id=1"); err != nil {
		t.Fatal("owned replay stock setup failed")
	}
	f.baseline = f.stock(t)
	if !reflect.DeepEqual(dto, transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", body), 200)) {
		t.Fatal("max-int64 replay differs after availability change")
	}
	total, records := transferWirePage(t, f.request(t, 3, "GET", "/api/transfers", ""))
	if total != 0 || len(records) != 0 {
		t.Fatal("unrelated account learned large private request")
	}
}
func testTransferPagination(t *testing.T) {
	f := transferFixture(t)
	var expected []transferDTO
	for i := 0; i < 26; i++ {
		body := strings.Replace(validTransferJSON, "http-retry-key-00001", fmt.Sprintf("http-pagination-key-%03d", i), 1)
		expected = append(expected, transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", body), 201))
	}
	for _, tc := range []struct {
		query                   string
		page, size, first, last int
	}{{"", 1, 25, 1, 26}, {"page=2", 2, 25, 0, 1}, {"page_size=10&page=2&status=pending", 2, 10, 6, 16}, {"page_size=50", 1, 50, 0, 26}, {"page=1000000&page_size=50", 1000000, 50, 0, 0}} {
		w := f.request(t, 2, "GET", "/api/transfers?"+tc.query, "")
		obj := transferObject(t, w, 200)
		total, records := transferWirePage(t, w)
		var page, size int
		_ = json.Unmarshal(obj["page"], &page)
		_ = json.Unmarshal(obj["page_size"], &size)
		want := make([]transferDTO, 0)
		for i := tc.last - 1; i >= tc.first; i-- {
			want = append(want, expected[i])
		}
		if total != 26 || page != tc.page || size != tc.size || !transferListDTOsEqual(t, records, want) {
			t.Fatal("bounded pagination/count/order differs")
		}
	}
	total, records := transferWirePage(t, f.request(t, 3, "GET", "/api/transfers?page=1000000&page_size=50", ""))
	if total != 0 || len(records) != 0 {
		t.Fatal("far private page leaked count")
	}
	// Eight simultaneous identical HTTP retries create exactly one durable record.
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := f.newRequest(2, "POST", "/api/transfers", validTransferJSON)
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			results <- w
		}()
	}
	wg.Wait()
	close(results)
	newCount := 0
	var id string
	for w := range results {
		if w.Code == 201 {
			newCount++
		} else if w.Code != 200 {
			t.Fatal("concurrent retry status failed")
		}
		dto := transferWireRecord(t, w, w.Code)
		if id != "" && dto.ID != id {
			t.Fatal("concurrent retries allocated multiple IDs")
		}
		id = dto.ID
	}
	if newCount != 1 {
		t.Fatal("concurrent retries did not create exactly once")
	}
	total, _ = transferWirePage(t, f.request(t, 2, "GET", "/api/transfers", ""))
	if total != 27 {
		t.Fatal("durable retry count differs")
	}
	f.unchanged(t)
}
func testTransferUnavailable(t *testing.T) {
	f := transferFixture(t)
	for _, mode := range []string{"canceled", "deadline"} {
		ctx, cancel := context.WithCancel(f.ctx)
		if mode == "deadline" {
			cancel()
			ctx, cancel = context.WithDeadline(f.ctx, time.Unix(1, 0))
		}
		cancel()
		for _, tc := range []struct{ verb, path, body string }{{"POST", "/api/transfers", validTransferJSON}, {"GET", "/api/transfers", ""}, {"GET", "/api/transfers/1", ""}} {
			r := f.newRequest(2, tc.verb, tc.path, tc.body).WithContext(ctx)
			expectTransferError(t, f.serve(t, r), 503, "service_unavailable")
		}
	}
	closed := testpg.Open(t)
	closed.Close()
	for _, store := range []*transfers.Store{transfers.New(nil), transfers.New(closed)} {
		var err error
		f.handler, err = NewWithTransfers(f.svc, f.cfg, inventory.New(f.p), store)
		if err != nil {
			t.Fatal("opaque store constructor refused")
		}
		for _, tc := range []struct{ verb, path, body string }{{"POST", "/api/transfers", validTransferJSON}, {"GET", "/api/transfers", ""}, {"GET", "/api/transfers/1", ""}} {
			expectTransferError(t, f.request(t, 2, tc.verb, tc.path, tc.body), 503, "service_unavailable")
		}
	}
	unavailable, err := auth.New(closed, nil)
	if err != nil {
		t.Fatal("closed-pool service setup failed")
	}
	f.handler, err = NewWithTransfers(unavailable, f.cfg, inventory.New(f.p), transfers.New(f.p))
	if err != nil {
		t.Fatal("closed-pool handler setup failed")
	}
	expectTransferError(t, f.request(t, 2, "GET", "/api/transfers", ""), 503, "service_unavailable")
}
func testTransferSessionFailure(t *testing.T, mode string) {
	f := transferFixture(t)
	switch mode {
	case "revoked":
		if f.svc.Logout(f.ctx, f.tokens[1]) != nil {
			t.Fatal("test revocation failed")
		}
	case "idle_expired":
		f.clock.Add(int64(auth.IdleTTL))
	case "absolute_expired":
		f.clock.Add(int64(auth.AbsoluteTTL))
	case "recreated_service":
		f.clock.Add(int64(auth.IdleTTL))
		svc, err := auth.New(f.p, func() time.Time { return time.Unix(0, f.clock.Load()).UTC() })
		if err != nil {
			t.Fatal("test service recreation failed")
		}
		f.handler, err = NewWithTransfers(svc, f.cfg, inventory.New(f.p), transfers.New(f.p))
		if err != nil {
			t.Fatal("test recreated handler failed")
		}
	}
	for _, tc := range []struct{ verb, path, body string }{{"POST", "/api/transfers", validTransferJSON}, {"GET", "/api/transfers", ""}, {"GET", "/api/transfers/1", ""}} {
		expectTransferError(t, f.request(t, 2, tc.verb, tc.path, tc.body), 401, "unauthenticated")
	}
	var count int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM transfer_requests").Scan(&count) != nil || count != 0 {
		t.Fatal("dead session persisted transfer")
	}
}
func testTransferDispatch(t *testing.T) {
	f := transferFixture(t)
	directory := t.TempDir()
	index := []byte("<!doctype html><title>public test index</title>")
	if os.WriteFile(filepath.Join(directory, "index.html"), index, 0600) != nil {
		t.Fatal("public test asset failed")
	}
	handler, err := webui.New(directory, f.handler)
	if err != nil {
		t.Fatal("existing webui composition failed")
	}
	f.handler = handler
	transferWirePage(t, f.request(t, 2, "GET", "/api/transfers", ""))
	for _, path := range []string{"/api/transfers/1/approve", "/api/unknown"} {
		w := f.request(t, 2, "GET", path, "")
		want := 404
		if path == "/api/transfers/1/approve" {
			want = 405
		}
		if w.Code != want || strings.Contains(w.Body.String(), "public test index") {
			t.Fatal("API fell back to public index")
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || w.Body.String() != string(index) {
		t.Fatal("existing public dispatch changed")
	}
}

// Root cleanup runs after each child fixture's guarded drop; copied connection
// configuration comes only from an admitted pool and is never printed.
func registerTransferAudit(t *testing.T, p *pgxpool.Pool) {
	t.Helper()
	cfg := p.Config().ConnConfig.Copy()
	cfg.Database = "luson_test"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal("HTTP audit connection failed")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		defer admin.Close(ctx)
		var user, db string
		if admin.QueryRow(ctx, "SELECT current_user,current_database()").Scan(&user, &db) != nil || user != "luson_test" || db != "luson_test" {
			t.Fatal("HTTP audit identity refused")
		}
		for {
			var total, owned, foreign int
			if admin.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE datname ~ '^luson_test_[a-f0-9]{32}$'),count(*) FILTER (WHERE datname NOT IN ('luson_test','postgres','template0','template1')) FROM pg_database`).Scan(&total, &owned, &foreign) != nil {
				t.Fatal("HTTP audit catalog failed")
			}
			if total == 4 && owned == 0 && foreign == 0 {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("HTTP fixture databases did not settle")
			case <-time.After(10 * time.Millisecond):
			}
		}
		var tables int
		if admin.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil || tables != 0 {
			t.Fatal("HTTP changed admin schema")
		}
		t.Log("HTTP settled fixture: baseline=4 owned=0 nonbaseline=0 admin_public=0")
	})
}
