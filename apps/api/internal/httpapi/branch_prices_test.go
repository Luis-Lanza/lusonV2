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

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/pricing"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

const validBranchPriceJSON = `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2,3]}`

func branchPriceCart(n int) string {
	ids := make([]string, n)
	for i := range ids {
		ids[i] = strconv.Itoa(i + 2)
	}
	return `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[` + strings.Join(ids, ",") + `]}`
}

func TestBranchPriceDecoder(t *testing.T) {
	replace := func(old, value string) string { return strings.Replace(validBranchPriceJSON, old, value, 1) }
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{
			validBranchPriceJSON,
			" \n" + validBranchPriceJSON + " \n",
			`{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2]}`,
			`{"branch_ids":[2],"suggested_price":"96000.50","min_price":"85000.00","catalog_entry_id":1}`,
			`{"catalog_entry_id":1,"min_price":"85000","suggested_price":"85000","branch_ids":[2,3,4]}`,
			`{"catalog_entry_id":2147483647,"min_price":"0.01","suggested_price":"0.01","branch_ids":[32767]}`,
			`{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[3,2]}`,
			branchPriceCart(pricing.MaxBranches),
		} {
			r := httptest.NewRequest("PUT", "/api/catalog/prices", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			got, err := decodeBranchPrices(r)
			if err != nil || got.CatalogEntryID < 1 || len(got.BranchIDs) == 0 || got.MinPrice == "" {
				t.Fatalf("valid framing rejected: %v", err)
			}
		}
	})
	// The decoded amounts are the canonical text this domain persists, never a float.
	r := httptest.NewRequest("PUT", "/api/catalog/prices", strings.NewReader(validBranchPriceJSON))
	r.Header.Set("Content-Type", "application/json")
	if got, err := decodeBranchPrices(r); err != nil || got.MinPrice != "85000.00" || got.SuggestedPrice != "96000.00" {
		t.Fatal("the decoded amounts must be canonical")
	}
	invalid := map[string]string{
		"empty_object":        `{}`,
		"array_root":          `[]`,
		"null_root":           `null`,
		"truncated":           validBranchPriceJSON[:len(validBranchPriceJSON)-1],
		"trailing":            validBranchPriceJSON + `{}`,
		"trailing_scalar":     validBranchPriceJSON + `true`,
		"oversized":           validBranchPriceJSON + strings.Repeat(" ", branchPriceBodyLimit),
		"unknown_key":         replace(`"catalog_entry_id":1`, `"actor_id":1,"catalog_entry_id":1`),
		"warranty_key":        replace(`"branch_ids"`, `"warranty_months":6,"branch_ids"`),
		"location_key":        replace(`"catalog_entry_id":1`, `"location_id":1,"catalog_entry_id":1`),
		"casefold":            replace(`"min_price":`, `"Min_price":`),
		"duplicate":           replace(`"min_price":`, `"min_price":"1","min_price":`),
		"escaped_duplicate":   replace(`"min_price":`, `"\u006din_price":"1","min_price":`),
		"duplicate_branch_id": replace(`"branch_ids":[2,3]`, `"branch_ids":[2,2]`),
		"missing_battery":     replace(`"catalog_entry_id":1,`, ``),
		"missing_min":         replace(`"min_price":"85000",`, ``),
		"missing_suggested":   replace(`"suggested_price":"96000",`, ``),
		"missing_branches":    replace(`,"branch_ids":[2,3]`, ``),
		"null_battery":        replace(`"catalog_entry_id":1`, `"catalog_entry_id":null`),
		"string_battery":      replace(`"catalog_entry_id":1`, `"catalog_entry_id":"1"`),
		"float_battery":       replace(`"catalog_entry_id":1`, `"catalog_entry_id":1.0`),
		"zero_battery":        replace(`"catalog_entry_id":1`, `"catalog_entry_id":0`),
		"padded_battery":      replace(`"catalog_entry_id":1`, `"catalog_entry_id":01`),
		"negative_battery":    replace(`"catalog_entry_id":1`, `"catalog_entry_id":-1`),
		"battery_bound":       replace(`"catalog_entry_id":1`, `"catalog_entry_id":2147483648`),
		// A removed field is an unknown field: the variant is no longer the price key.
		"variant_key":         replace(`"catalog_entry_id":1`, `"variant_id":1,"catalog_entry_id":1`),
		"variant_only_body":   `{"variant_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2,3]}`,
		"numeric_min":         replace(`"85000"`, `85000`),
		"null_min":            replace(`"min_price":"85000"`, `"min_price":null`),
		"empty_min":           replace(`"85000"`, `""`),
		"zero_min":            replace(`"85000"`, `"0"`),
		"negative_min":        replace(`"85000"`, `"-85000"`),
		"precision_min":       replace(`"85000"`, `"85000.001"`),
		"exponent_min":        replace(`"85000"`, `"8.5e4"`),
		"precision_suggested": replace(`"96000"`, `"96000.999"`),
		"null_branches":       replace(`[2,3]`, `null`),
		"empty_branches":      replace(`[2,3]`, `[]`),
		"string_branch":       replace(`[2,3]`, `["2",3]`),
		"zero_branch":         replace(`[2,3]`, `[0,3]`),
		"negative_branch":     replace(`[2,3]`, `[-2,3]`),
		"branch_bound":        replace(`[2,3]`, `[2,32768]`),
		"too_many_branches":   `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[` + strings.Repeat("2,", pricing.MaxBranches) + `2]}`,
		"invalid_utf8":        replace("85000", "85000-\xff"),
	}
	for name, body := range invalid {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("PUT", "/api/catalog/prices", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			if _, err := decodeBranchPrices(r); !errors.Is(err, pricing.ErrInvalid) {
				t.Fatal("invalid framing accepted or unsanitized")
			}
		})
	}
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json", "application/json"}, {"application/json; charset=utf-8; charset=utf-8"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("PUT", "/api/catalog/prices", strings.NewReader(validBranchPriceJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, err := decodeBranchPrices(r); !errors.Is(err, pricing.ErrInvalid) {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r = httptest.NewRequest("PUT", "/api/catalog/prices", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, err := decodeBranchPrices(r); !errors.Is(err, pricing.ErrInvalid) {
		t.Fatal("body read error exposed")
	}
	if _, err := decodeBranchPrices(nil); !errors.Is(err, pricing.ErrInvalid) {
		t.Fatal("nil request accepted")
	}
}

func TestBranchPriceQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want pricing.BranchQuery
		ok   bool
	}{
		"defaults":     {"", pricing.BranchQuery{Page: 1, PageSize: 10}, true},
		"all":          {"search=ns60&brand=TOYO&capacity=45&page=2&page_size=25", pricing.BranchQuery{Search: "ns60", Brand: "TOYO", Capacity: "45", Page: 2, PageSize: 25}, true},
		"capacity_dec": {"capacity=6.5", pricing.BranchQuery{Capacity: "6.5", Page: 1, PageSize: 10}, true},
		"decoded_text": {"search=TOYO%20MOTO", pricing.BranchQuery{Search: "TOYO MOTO", Page: 1, PageSize: 10}, true},
		"plus_text":    {"search=TOYO+MOTO", pricing.BranchQuery{Search: "TOYO MOTO", Page: 1, PageSize: 10}, true},
		"fifty":        {"page_size=50&page=3", pricing.BranchQuery{Page: 3, PageSize: 50}, true},
		"blank_search": {"search=", pricing.BranchQuery{}, false},
		"blank_brand":  {"brand=", pricing.BranchQuery{}, false},
		// The price belongs to the battery, so a polarity filter is not part of this
		// contract any more.
		"polarity_gone":  {"polarity=L", pricing.BranchQuery{}, false},
		"battery_filter": {"catalog_entry_id=1", pricing.BranchQuery{}, false},
		"capacity":       {"capacity=6,5", pricing.BranchQuery{}, false},
		"unknown":        {"status=all", pricing.BranchQuery{}, false},
		"duplicate":      {"search=a&search=a", pricing.BranchQuery{}, false},
		"encoded_page":   {"page=%31", pricing.BranchQuery{}, false},
		"padded_page":    {"page=01", pricing.BranchQuery{}, false},
		"page_size":      {"page_size=20", pricing.BranchQuery{}, false},
		"page_zero":      {"page=0", pricing.BranchQuery{}, false},
		"page_bound":     {"page=1000001", pricing.BranchQuery{}, false},
		"long_search":    {"search=" + strings.Repeat("a", 129), pricing.BranchQuery{}, false},
		"long_brand":     {"brand=" + strings.Repeat("a", 129), pricing.BranchQuery{}, false},
		"bad_escape":     {"search=%ZZ", pricing.BranchQuery{}, false},
		"nul":            {"search=a%00b", pricing.BranchQuery{}, false},
		"no_equals":      {"search", pricing.BranchQuery{}, false},
		"trailing":       {"search=a&", pricing.BranchQuery{}, false},
		"empty_section":  {"&&", pricing.BranchQuery{}, false},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := branchPriceQuery(tc.raw)
			if tc.ok {
				if err != nil || got != tc.want {
					t.Fatalf("an admitted price query was refused: %v", err)
				}
				return
			}
			if !errors.Is(err, pricing.ErrInvalid) {
				t.Fatal("an inadmissible price query was accepted")
			}
		})
	}
}

func TestBranchPriceFailureMapping(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{pricing.ErrInvalid, 400, "invalid_request"},
		{pricing.ErrForbidden, 403, "forbidden"},
		{pricing.ErrUnavailable, 503, "service_unavailable"},
		{fmt.Errorf("opaque failure"), 503, "service_unavailable"},
		{&pricing.RetiredBranch{BranchID: 7}, 400, "invalid_request"},
	} {
		w := httptest.NewRecorder()
		branchPriceFailure(w, fmt.Errorf("wrapped: %w", tc.err))
		var retired *pricing.RetiredBranch
		if errors.As(tc.err, &retired) {
			// A retired branch names the id the client must drop, so it is never just
			// a bare code.
			var body map[string]json.RawMessage
			if w.Code != 400 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 2 ||
				string(body["error"]) != `"retired_branch"` || string(body["branch_id"]) != "7" {
				t.Fatalf("retired branch response mismatch: %d %s", w.Code, w.Body.String())
			}
			continue
		}
		expectTransferError(t, w, tc.status, tc.code)
	}
	// A retired branch is still an invalid request for every existing caller.
	if !errors.Is(&pricing.RetiredBranch{BranchID: 2}, pricing.ErrInvalid) {
		t.Fatal("a retired branch must be an invalid request")
	}
}

func branchPriceWriteResult() pricing.WriteResult {
	return pricing.WriteResult{
		CatalogEntryID: 1,
		BranchIDs:      []int64{2, 3},
		MinPrice:       "85000.00",
		SuggestedPrice: "96000.00",
	}
}

func branchPriceMatrixValue() pricing.Matrix {
	written := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	return pricing.Matrix{
		Branches: []pricing.Branch{{ID: 2, Name: "Sucursal A"}, {ID: 3, Name: "Sucursal B"}},
		Batteries: []pricing.Battery{
			{
				CatalogEntryID: 1, Brand: "CAR", Model: "NS40ZL", Capacity: "35",
				Polarities: []string{"L", "R"}, Cells: []string{"B5", "C5", "D5"},
				Prices: []pricing.Price{{
					BranchLocationID: 2, MinPrice: "85000.00", SuggestedPrice: "96000.00", UpdatedAt: written,
					UpdatedByAccountID: 1, UpdatedByDisplayName: "Almacén",
				}},
			},
			{
				CatalogEntryID: 2, Brand: "CAR", Model: "NS40ZR", Capacity: "35",
				Polarities: []string{"L", "R"}, Cells: []string{"B5", "C5", "D5"}, Prices: []pricing.Price{},
			},
		},
		Page: 1, PageSize: 10, TotalBatteries: 95,
	}
}

func TestBranchPriceWriteRecord(t *testing.T) {
	record, err := branchPriceRecord(branchPriceWriteResult())
	if err != nil {
		t.Fatalf("a complete applied assignment must be described: %v", err)
	}
	if record.CatalogEntryID != 1 || record.Written != 2 || len(record.BranchIDs) != 2 ||
		record.MinPrice != "85000.00" || record.SuggestedPrice != "96000.00" {
		t.Fatalf("write record does not match the frozen contract: %+v", record)
	}
	mutate := func(change func(*pricing.WriteResult)) pricing.WriteResult {
		value := branchPriceWriteResult()
		change(&value)
		return value
	}
	for name, result := range map[string]pricing.WriteResult{
		"zero_battery":     mutate(func(v *pricing.WriteResult) { v.CatalogEntryID = 0 }),
		"no_branches":      mutate(func(v *pricing.WriteResult) { v.BranchIDs = []int64{} }),
		"warehouse_branch": mutate(func(v *pricing.WriteResult) { v.BranchIDs = []int64{1, 2} }),
		"unordered_branch": mutate(func(v *pricing.WriteResult) { v.BranchIDs = []int64{3, 2} }),
		"repeated_branch":  mutate(func(v *pricing.WriteResult) { v.BranchIDs = []int64{2, 2} }),
		"too_many_branches": mutate(func(v *pricing.WriteResult) {
			ids := make([]int64, 0, pricing.MaxBranches+1)
			for i := 0; i <= pricing.MaxBranches; i++ {
				ids = append(ids, int64(i+2))
			}
			v.BranchIDs = ids
		}),
		"money_digits":  mutate(func(v *pricing.WriteResult) { v.MinPrice = "85000" }),
		"money_float":   mutate(func(v *pricing.WriteResult) { v.MinPrice = "85000.5" }),
		"below_minimum": mutate(func(v *pricing.WriteResult) { v.SuggestedPrice = "84000.00" }),
	} {
		if _, err := branchPriceRecord(result); !errors.Is(err, pricing.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

func TestBranchPriceMatrixRecord(t *testing.T) {
	record, err := branchPriceMatrixRecord(branchPriceMatrixValue())
	if err != nil {
		t.Fatalf("a complete matrix page must be described: %v", err)
	}
	if len(record.Branches) != 2 || len(record.Batteries) != 2 || record.TotalBatteries != 95 {
		t.Fatalf("matrix record does not match the frozen contract: %+v", record)
	}
	first, second := record.Batteries[0], record.Batteries[1]
	if first.Cells == nil || len(first.Cells) != 3 || first.Capacity != "35" ||
		len(first.Polarities) != 2 || first.Polarities[0] != "L" || first.Polarities[1] != "R" {
		t.Fatalf("battery row does not match the frozen contract: %+v", first)
	}
	if len(first.Prices) != 1 || first.Prices[0].MinPrice != "85000.00" ||
		first.Prices[0].SuggestedPrice != "96000.00" || first.Prices[0].UpdatedAt != "2026-11-04T10:00:00Z" ||
		first.Prices[0].UpdatedByDisplayName != "Almacén" {
		t.Fatalf("price row does not match the frozen contract: %+v", first.Prices)
	}
	if second.Prices == nil || len(second.Prices) != 0 {
		t.Fatalf("a battery without prices must report an empty list: %+v", second)
	}
	mutate := func(change func(*pricing.Matrix)) pricing.Matrix {
		value := branchPriceMatrixValue()
		change(&value)
		return value
	}
	for name, matrix := range map[string]pricing.Matrix{
		"bad_page":         mutate(func(m *pricing.Matrix) { m.Page = 0 }),
		"bad_size":         mutate(func(m *pricing.Matrix) { m.PageSize = 15 }),
		"negative_total":   mutate(func(m *pricing.Matrix) { m.TotalBatteries = -1 }),
		"page_overflow":    mutate(func(m *pricing.Matrix) { m.TotalBatteries = 1 }),
		"warehouse_branch": mutate(func(m *pricing.Matrix) { m.Branches[0].ID = 1 }),
		"unordered_branch": mutate(func(m *pricing.Matrix) { m.Branches[1].ID = 2 }),
		"empty_branch":     mutate(func(m *pricing.Matrix) { m.Branches[0].Name = "" }),
		"battery_zero":     mutate(func(m *pricing.Matrix) { m.Batteries[0].CatalogEntryID = 0 }),
		"battery_order":    mutate(func(m *pricing.Matrix) { m.Batteries[1].CatalogEntryID = 1 }),
		"polarity":         mutate(func(m *pricing.Matrix) { m.Batteries[0].Polarities = []string{"X"} }),
		"polarity_order":   mutate(func(m *pricing.Matrix) { m.Batteries[0].Polarities = []string{"R", "L"} }),
		"polarity_repeat":  mutate(func(m *pricing.Matrix) { m.Batteries[0].Polarities = []string{"L", "L"} }),
		"polarity_empty":   mutate(func(m *pricing.Matrix) { m.Batteries[0].Polarities = []string{} }),
		"polarity_triple":  mutate(func(m *pricing.Matrix) { m.Batteries[0].Polarities = []string{"L", "L", "R"} }),
		"cells":            mutate(func(m *pricing.Matrix) { m.Batteries[0].Cells = []string{"B5", "C5"} }),
		"cells_empty":      mutate(func(m *pricing.Matrix) { m.Batteries[0].Cells = []string{"", "C5", "D5"} }),
		"capacity":         mutate(func(m *pricing.Matrix) { m.Batteries[0].Capacity = "0" }),
		"price_digits":     mutate(func(m *pricing.Matrix) { m.Batteries[0].Prices[0].MinPrice = "85000" }),
		"price_minimum":    mutate(func(m *pricing.Matrix) { m.Batteries[0].Prices[0].SuggestedPrice = "84000.00" }),
		"price_branch":     mutate(func(m *pricing.Matrix) { m.Batteries[0].Prices[0].BranchLocationID = 4 }),
		"price_retired":    mutate(func(m *pricing.Matrix) { m.Batteries[0].Prices[0].BranchLocationID = 1 }),
		"price_updated":    mutate(func(m *pricing.Matrix) { m.Batteries[0].Prices[0].UpdatedAt = time.Time{} }),
		"price_account":    mutate(func(m *pricing.Matrix) { m.Batteries[0].Prices[0].UpdatedByAccountID = 0 }),
	} {
		if _, err := branchPriceMatrixRecord(matrix); !errors.Is(err, pricing.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

// branchPriceRecorder is a base handler that only records the request it received,
// so forwarding stays provable without a database.
type branchPriceRecorder struct {
	calls int
	path  string
}

func (h *branchPriceRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.calls++
	h.path = r.URL.Path
	w.WriteHeader(http.StatusNoContent)
}

func TestBranchPriceConstructor(t *testing.T) {
	cfg := transferConfig(t)
	store := pricing.New(&pgxpool.Pool{})
	base := &branchPriceRecorder{}
	if h, err := NewWithBranchPrices(nil, &auth.Service{}, cfg, store); err == nil || h != nil {
		t.Fatal("a nil base handler was accepted")
	}
	if h, err := NewWithBranchPrices(base, nil, cfg, store); err == nil || h != nil {
		t.Fatal("a nil service was accepted")
	}
	if h, err := NewWithBranchPrices(base, &auth.Service{}, cfg, nil); err == nil || h != nil {
		t.Fatal("a nil price store was accepted")
	}
	if h, err := NewWithBranchPrices(base, &auth.Service{}, config.Auth{}, store); err == nil || h != nil {
		t.Fatal("an invalid auth configuration was accepted")
	}
	h, err := NewWithBranchPrices(base, &auth.Service{}, cfg, store)
	if err != nil || h == nil {
		t.Fatal("the price constructor is unavailable")
	}
	// The read requires a session, and the mutation refuses an unsupported method
	// before any identity work.
	for _, tc := range []struct {
		method string
		status int
		code   string
	}{
		{"GET", 401, "unauthenticated"},
		{"PUT", 401, "unauthenticated"},
		{"POST", 405, "method_not_allowed"},
		{"DELETE", 405, "method_not_allowed"},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(tc.method, "/api/catalog/prices", nil)
		h.ServeHTTP(w, r)
		expectTransferError(t, w, tc.status, tc.code)
		if tc.status == 405 && w.Header().Get("Allow") != "GET, PUT" {
			t.Fatal("the price collection must advertise GET and PUT")
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("the price wrapper must keep the response headers")
		}
	}
	// An ambiguous or unknown path below the collection never reaches a handler.
	for _, target := range []string{
		"/api/catalog/prices/", "/api/catalog/prices/1", "/api/catalog/prices//", "/api/catalog/prices/./",
		"/api/catalog/prices/%31", "/api/catalog/%70rices",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		expectTransferError(t, w, 404, "not_found")
	}
	// Every other request is forwarded to the composed handler unchanged.
	for _, target := range []string{"/api/inventory", "/api/stock-adjustments", "/api/auth/session", "/api/catalog"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s must be forwarded to the composed handler", target)
		}
	}
	if base.calls != 4 || base.path != "/api/catalog" {
		t.Fatalf("forwarding changed: %d %q", base.calls, base.path)
	}
	// Without the price wrapper the routes stay unregistered, exactly like ingress on
	// the legacy factories.
	legacy, err := NewWithStockEntries(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil, stockadjustments.New(&pgxpool.Pool{}))
	if err != nil || legacy == nil {
		t.Fatal("stock entry constructor unavailable")
	}
	w := httptest.NewRecorder()
	legacy.ServeHTTP(w, httptest.NewRequest("GET", "/api/catalog/prices", nil))
	if w.Code != 404 {
		t.Fatal("a factory without the price store must not serve the price list")
	}
}

type branchPriceHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
}

// branchPriceFixture needs the isolated test PostgreSQL; without an admitted
// manifest every database test here fails closed, which is expected locally.
func branchPriceFixture(t *testing.T) *branchPriceHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("branch price HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("branch price HTTP test provisioning failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("branch price HTTP operational fixture setup failed")
	}
	// The administrator carries a display name so the matrix can prove it reads the
	// actor directory instead of leaving the field empty.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET display_name='Almacén' WHERE id=1`); err != nil {
		t.Fatal("branch price HTTP administrator fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("branch price HTTP auth fixture failed")
	}
	f := &branchPriceHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("branch price HTTP login failed")
		}
		f.tokens[i] = token
	}
	base, err := NewWithStockEntries(svc, f.cfg, inventory.New(p), transfers.New(p), stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("branch price HTTP base constructor failed")
	}
	f.handler, err = NewWithBranchPrices(base, svc, f.cfg, pricing.New(p))
	if err != nil {
		t.Fatal("branch price HTTP constructor failed")
	}
	return f
}

// snapshot captures every table this domain writes, so a rejected request is proven
// to leave nothing behind. The warranty table of migration 024 is snapshotted as
// well: this domain no longer writes it, and a write that reappeared would fail
// every rejection below.
func (f *branchPriceHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'prices',(SELECT coalesce(jsonb_agg(to_jsonb(bp) ORDER BY bp.branch_location_id,bp.catalog_entry_id),'[]'::jsonb) FROM branch_prices bp),
  'warranties',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.variant_id),'[]'::jsonb) FROM variant_warranties w))::text`).Scan(&data)
	if err != nil {
		t.Fatal("branch price snapshot failed")
	}
	return data
}

// storedPrice reads the durable pair of one (branch, battery): there is exactly one
// row per pair, because the battery and not the polarity is the key.
func (f *branchPriceHTTPFixture) storedPrice(t *testing.T, branchID, entryID int64) (min, suggested string) {
	t.Helper()
	if f.p.QueryRow(f.ctx, `SELECT min_price::text,suggested_price::text FROM branch_prices
 WHERE branch_location_id=$1 AND catalog_entry_id=$2`, int16(branchID), int32(entryID)).Scan(&min, &suggested) != nil {
		t.Fatal("persisted price read failed")
	}
	return min, suggested
}

func (f *branchPriceHTTPFixture) createBranch(t *testing.T, name string) int64 {
	t.Helper()
	var id int64
	if err := f.p.QueryRow(f.ctx, "SELECT create_branch($1)", name).Scan(&id); err != nil {
		t.Fatal("branch fixture creation failed")
	}
	return id
}

func (f *branchPriceHTTPFixture) retireBranch(t *testing.T, id int64) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, "UPDATE locations SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", int16(id)); err != nil {
		t.Fatal("branch fixture retirement failed")
	}
}

func (f *branchPriceHTTPFixture) request(actor int, verb, path, body string) *http.Request {
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

func (f *branchPriceHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("branch price security headers changed")
	}
	return w
}

// rejected proves a refused request wrote nothing anywhere.
func (f *branchPriceHTTPFixture) rejected(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	expectTransferError(t, w, status, code)
	if f.snapshot(t) != before {
		t.Fatal("a rejected price request changed stored state")
	}
}

// branchPriceMatrixWire admits only the frozen matrix shape: five page keys, seven
// battery keys, six price keys and two branch keys, with canonical amounts.
func branchPriceMatrixWire(t *testing.T, w *httptest.ResponseRecorder) branchPriceMatrixDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("matrix response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 5 {
		t.Fatal("matrix whitelist changed")
	}
	for _, key := range []string{"branches", "batteries", "page", "page_size", "total_batteries"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("matrix whitelist incomplete: %s", key)
		}
	}
	var branches []map[string]json.RawMessage
	if json.Unmarshal(top["branches"], &branches) != nil {
		t.Fatal("matrix branches are not an array")
	}
	for _, item := range branches {
		if len(item) != 2 {
			t.Fatal("branch whitelist changed")
		}
		for _, key := range []string{"id", "name"} {
			if _, ok := item[key]; !ok {
				t.Fatalf("branch whitelist incomplete: %s", key)
			}
		}
	}
	var batteries []map[string]json.RawMessage
	if json.Unmarshal(top["batteries"], &batteries) != nil {
		t.Fatal("matrix batteries are not an array")
	}
	money := regexp.MustCompile(`^"[0-9]+\.[0-9]{2}"$`)
	for _, item := range batteries {
		if len(item) != 7 {
			t.Fatal("battery whitelist changed")
		}
		for _, key := range []string{"catalog_entry_id", "brand", "model", "capacity_ah",
			"polarities", "cells", "prices"} {
			if _, ok := item[key]; !ok {
				t.Fatalf("battery whitelist incomplete: %s", key)
			}
		}
		// One row per battery carries both polarities, ascending: the two polarities
		// never appear as separate rows with prices of their own.
		var polarities []string
		if json.Unmarshal(item["polarities"], &polarities) != nil || len(polarities) != 2 ||
			polarities[0] != "L" || polarities[1] != "R" {
			t.Fatalf("polarities must be the battery's, ascending: %s", item["polarities"])
		}
		var cells []string
		if json.Unmarshal(item["cells"], &cells) != nil || len(cells) != 3 {
			t.Fatal("matrix cells must be the three source cells")
		}
		if !regexp.MustCompile(`^"[1-9][0-9]*(\.[0-9]*[1-9])?"$`).MatchString(string(item["capacity_ah"])) {
			t.Fatal("capacity_ah must be the canonical decimal as a string")
		}
		var prices []map[string]json.RawMessage
		if json.Unmarshal(item["prices"], &prices) != nil || prices == nil {
			t.Fatal("matrix prices are not an array")
		}
		for _, price := range prices {
			if len(price) != 6 {
				t.Fatal("price whitelist changed")
			}
			for _, key := range []string{"branch_location_id", "min_price", "suggested_price", "updated_at",
				"updated_by_account_id", "updated_by_display_name"} {
				if _, ok := price[key]; !ok {
					t.Fatalf("price whitelist incomplete: %s", key)
				}
			}
			// Amounts are canonical two-decimal text, never a binary float.
			for _, key := range []string{"min_price", "suggested_price"} {
				if !money.MatchString(string(price[key])) {
					t.Fatalf("%s must be canonical money text", key)
				}
			}
		}
	}
	var matrix branchPriceMatrixDTO
	if json.Unmarshal(w.Body.Bytes(), &matrix) != nil || len(matrix.Batteries) != len(batteries) {
		t.Fatal("matrix response is not decodable")
	}
	return matrix
}

// branchPriceWriteWire admits only the frozen write shape: exactly five keys with
// canonical amounts and the branches in ascending order.
func branchPriceWriteWire(t *testing.T, w *httptest.ResponseRecorder) branchPriceWriteDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("write response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 5 {
		t.Fatal("write whitelist changed")
	}
	for _, key := range []string{"catalog_entry_id", "written", "branch_ids", "min_price", "suggested_price"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("write whitelist incomplete: %s", key)
		}
	}
	for _, key := range []string{"min_price", "suggested_price"} {
		if !regexp.MustCompile(`^"[0-9]+\.[0-9]{2}"$`).MatchString(string(top[key])) {
			t.Fatalf("%s must be canonical money text", key)
		}
	}
	var record branchPriceWriteDTO
	if json.Unmarshal(w.Body.Bytes(), &record) != nil || record.Written != len(record.BranchIDs) || record.Written < 1 {
		t.Fatal("write response is not decodable")
	}
	for i := 1; i < len(record.BranchIDs); i++ {
		if record.BranchIDs[i] <= record.BranchIDs[i-1] || record.BranchIDs[i-1] < 2 {
			t.Fatal("branch_ids must be the ascending applied branches")
		}
	}
	return record
}

func TestBranchPriceHTTPMatrix(t *testing.T) {
	f := branchPriceFixture(t)
	w := f.serve(t, f.request(1, "GET", "/api/catalog/prices?page=1&page_size=10", ""))
	empty := branchPriceMatrixWire(t, w)
	if empty.Page != 1 || empty.PageSize != 10 || empty.TotalBatteries != 95 || len(empty.Batteries) != 10 {
		t.Fatalf("an empty price list must still describe the whole catalogue: %+v", empty)
	}
	if len(empty.Branches) != 2 || empty.Branches[0].ID != 2 || empty.Branches[1].ID != 3 {
		t.Fatalf("branches must be the active branches in id order: %+v", empty.Branches)
	}
	for _, battery := range empty.Batteries {
		if len(battery.Prices) != 0 {
			t.Fatalf("a battery without prices must report an empty list: %+v", battery)
		}
	}
	// One written pair per chosen branch is read back canonically.
	if w := f.serve(t, f.request(1, "PUT", "/api/catalog/prices",
		`{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000.5","branch_ids":[3,2]}`)); w.Code != 200 {
		t.Fatalf("matrix fixture write failed: %d %s", w.Code, w.Body.String())
	}
	matrix := branchPriceMatrixWire(t, f.serve(t, f.request(1, "GET", "/api/catalog/prices?page=1&page_size=10", "")))
	first := matrix.Batteries[0]
	if first.CatalogEntryID != 1 {
		t.Fatalf("the written battery is not read back: %+v", first)
	}
	if len(first.Prices) != 2 || first.Prices[0].BranchLocationID != 2 || first.Prices[1].BranchLocationID != 3 ||
		first.Prices[0].MinPrice != "85000.00" || first.Prices[0].SuggestedPrice != "96000.50" ||
		first.Prices[0].UpdatedByAccountID != 1 || first.Prices[0].UpdatedByDisplayName != "Almacén" {
		t.Fatalf("the written pair is not read back: %+v", first.Prices)
	}
	// A branch session never reads the administration matrix.
	f.rejected(t, f.request(2, "GET", "/api/catalog/prices", ""), 403, "forbidden")
	// A retired branch leaves the list and its persisted pair is not advertised.
	retired := f.createBranch(t, "Sucursal C")
	if w := f.serve(t, f.request(1, "PUT", "/api/catalog/prices",
		fmt.Sprintf(`{"catalog_entry_id":2,"min_price":"1000","suggested_price":"1200","branch_ids":[%d]}`, retired))); w.Code != 200 {
		t.Fatalf("retirement fixture write failed: %d %s", w.Code, w.Body.String())
	}
	f.retireBranch(t, retired)
	after := branchPriceMatrixWire(t, f.serve(t, f.request(1, "GET", "/api/catalog/prices?page=1&page_size=10", "")))
	for _, item := range after.Branches {
		if item.ID == retired {
			t.Fatal("a retired branch must not be listed")
		}
	}
	second := after.Batteries[1]
	if len(second.Prices) != 0 {
		t.Fatalf("a price of a retired branch is not a sale price: %+v", second.Prices)
	}
}

func TestBranchPriceHTTPWrite(t *testing.T) {
	f := branchPriceFixture(t)
	// A block assignment writes every chosen branch in one operation.
	w := f.serve(t, f.request(1, "PUT", "/api/catalog/prices", validBranchPriceJSON))
	written := branchPriceWriteWire(t, w)
	if written.CatalogEntryID != 1 || written.Written != 2 || len(written.BranchIDs) != 2 ||
		written.BranchIDs[0] != 2 || written.BranchIDs[1] != 3 ||
		written.MinPrice != "85000.00" || written.SuggestedPrice != "96000.00" {
		t.Fatalf("applied write does not match the frozen contract: %+v", written)
	}
	for _, branchID := range []int64{2, 3} {
		if min, suggested := f.storedPrice(t, branchID, 1); min != "85000.00" || suggested != "96000.00" {
			t.Fatalf("branch %d did not receive the pair: %s/%s", branchID, min, suggested)
		}
	}
	// An individual assignment touches only its own branch.
	if w := f.serve(t, f.request(1, "PUT", "/api/catalog/prices",
		`{"catalog_entry_id":1,"min_price":"90000","suggested_price":"99000","branch_ids":[3]}`)); w.Code != 200 {
		t.Fatalf("individual write failed: %d %s", w.Code, w.Body.String())
	}
	if min, _ := f.storedPrice(t, 2, 1); min != "85000.00" {
		t.Fatalf("an individual write must not touch another branch: %s", min)
	}
	if min, suggested := f.storedPrice(t, 3, 1); min != "90000.00" || suggested != "99000.00" {
		t.Fatalf("the individual branch was not written: %s/%s", min, suggested)
	}
	// A branch session never writes, and nothing is written by the attempt.
	f.rejected(t, f.request(2, "PUT", "/api/catalog/prices",
		`{"catalog_entry_id":1,"min_price":"1","suggested_price":"1","branch_ids":[2]}`), 403, "forbidden")
	if min, _ := f.storedPrice(t, 2, 1); min != "85000.00" {
		t.Fatalf("a forbidden write changed a stored pair: %s", min)
	}
}

func TestBranchPriceHTTPRejections(t *testing.T) {
	f := branchPriceFixture(t)
	if w := f.serve(t, f.request(1, "PUT", "/api/catalog/prices",
		`{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2]}`)); w.Code != 200 {
		t.Fatalf("baseline write failed: %d %s", w.Code, w.Body.String())
	}
	for name, body := range map[string]string{
		"suggested_below_min": `{"catalog_entry_id":1,"min_price":"96000","suggested_price":"85000","branch_ids":[2]}`,
		"over_precision_min":  `{"catalog_entry_id":1,"min_price":"85000.001","suggested_price":"96000","branch_ids":[2]}`,
		"over_precision_sug":  `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000.999","branch_ids":[2]}`,
		"negative_money":      `{"catalog_entry_id":1,"min_price":"-85000","suggested_price":"96000","branch_ids":[2]}`,
		"empty_money":         `{"catalog_entry_id":1,"min_price":"","suggested_price":"96000","branch_ids":[2]}`,
		"empty_branches":      `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[]}`,
		"duplicate_branches":  `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2,2]}`,
		"warehouse_branch":    `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[1]}`,
		"warehouse_and_valid": `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[1,2]}`,
		"unknown_battery":     `{"catalog_entry_id":300,"min_price":"85000","suggested_price":"96000","branch_ids":[2]}`,
		"removed_variant":     `{"variant_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2]}`,
		"removed_warranty":    `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","warranty_months":6,"branch_ids":[2]}`,
		"unknown_branch":      `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2,99]}`,
		"warranty_months":     `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","warranty_months":6,"branch_ids":[2]}`,
		"unknown_key":         `{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2],"actor_id":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "PUT", "/api/catalog/prices", body), 400, "invalid_request")
		})
	}
	// A retired branch names the id the client must drop, and nothing is written.
	retired := f.createBranch(t, "Sucursal C")
	f.retireBranch(t, retired)
	before := f.snapshot(t)
	w := f.serve(t, f.request(1, "PUT", "/api/catalog/prices",
		fmt.Sprintf(`{"catalog_entry_id":1,"min_price":"2000","suggested_price":"2500","branch_ids":[2,%d]}`, retired)))
	var body map[string]json.RawMessage
	if w.Code != 400 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 2 ||
		string(body["error"]) != `"retired_branch"` || string(body["branch_id"]) != strconv.FormatInt(retired, 10) {
		t.Fatalf("a retired branch must be named: %d %s", w.Code, w.Body.String())
	}
	if f.snapshot(t) != before {
		t.Fatal("a retired branch must refuse the whole block without writing anything")
	}
	if min, _ := f.storedPrice(t, 2, 1); min != "85000.00" {
		t.Fatalf("a refused block changed the valid branch: %s", min)
	}
	// Framing and authority rejections never reach the store.
	f.rejected(t, f.request(1, "GET", "/api/catalog/prices?", ""), 400, "invalid_request")
	f.rejected(t, f.request(1, "GET", "/api/catalog/prices?page_size=15", ""), 400, "invalid_request")
	f.rejected(t, f.request(1, "GET", "/api/catalog/prices?search=a&search=b", ""), 400, "invalid_request")
	f.rejected(t, f.request(1, "GET", "/api/catalog/prices?polarity=X", ""), 400, "invalid_request")
	f.rejected(t, f.request(0, "GET", "/api/catalog/prices", ""), 401, "unauthenticated")
	f.rejected(t, f.request(0, "PUT", "/api/catalog/prices", validBranchPriceJSON), 401, "unauthenticated")
	for name, mutate := range map[string]func(*http.Request){
		"no_csrf": func(r *http.Request) {
			r.Header.Del("X-CSRF-Token")
		},
		"wrong_origin": func(r *http.Request) {
			r.Header.Set("Origin", "https://elsewhere.example")
		},
		"cross_site": func(r *http.Request) {
			r.Header.Set("Sec-Fetch-Site", "cross-site")
		},
	} {
		r := f.request(1, "PUT", "/api/catalog/prices", validBranchPriceJSON)
		mutate(r)
		f.rejected(t, r, 403, "forbidden")
		if name == "" {
			t.Fatal("unnamed rejection")
		}
	}
	// A query string on the write is a framing error, never a silently ignored
	// parameter.
	f.rejected(t, f.request(1, "PUT", "/api/catalog/prices?page=1", validBranchPriceJSON), 400, "invalid_request")
}
