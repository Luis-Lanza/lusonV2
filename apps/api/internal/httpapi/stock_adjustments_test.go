package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

const validStockAdjustmentJSON = `{"operation_key":"http-stock-adjustment-01","reason":"conteo físico","detail":"pasillo 2","lines":[{"variant_id":2,"counted_quantity":7},{"variant_id":1,"counted_quantity":3}]}`

const validStockAdjustmentReversalJSON = `{"operation_key":"http-adjustment-reverse-01","reason":"conteo mal tomado"}`

func stockAdjustmentCart(n, counted int) string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf(`{"variant_id":%d,"counted_quantity":%d}`, n-i, counted)
	}
	return `{"operation_key":"http-stock-adjustment-02","reason":"conteo físico","lines":[` + strings.Join(lines, ",") + `]}`
}

func TestStockAdjustmentDecoder(t *testing.T) {
	replace := func(old, value string) string { return strings.Replace(validStockAdjustmentJSON, old, value, 1) }
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{
			validStockAdjustmentJSON,
			" \n" + validStockAdjustmentJSON + " \n",
			`{"operation_key":"http-stock-adjustment-01","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":0}]}`,
			`{"lines":[{"variant_id":1,"counted_quantity":1}],"reason":"conteo físico","operation_key":"http-stock-adjustment-01"}`,
			`{"operation_key":"http-stock-adjustment-01","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":1000000}]}`,
			replace(`"http-stock-adjustment-01"`, strconv.Quote(strings.Repeat("a", 128))),
			replace(`"conteo físico"`, strconv.Quote(strings.Repeat("ñ", 500))),
			replace(`"pasillo 2"`, strconv.Quote(strings.Repeat("ñ", 500))),
		} {
			r := httptest.NewRequest("POST", "/api/stock-adjustments", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			got, err := decodeStockAdjustment(r)
			if err != nil || len(got.Lines) == 0 || got.OperationKey == "" {
				t.Fatalf("valid framing rejected: %v", err)
			}
		}
	})
	invalid := map[string]string{
		"empty_object":             `{}`,
		"array_root":               `[]`,
		"null_root":                `null`,
		"truncated":                validStockAdjustmentJSON[:len(validStockAdjustmentJSON)-1],
		"trailing":                 validStockAdjustmentJSON + `{}`,
		"trailing_scalar":          validStockAdjustmentJSON + `true`,
		"oversized":                validStockAdjustmentJSON + strings.Repeat(" ", stockAdjustmentBodyLimit),
		"expected_quantity":        replace(`"counted_quantity":3`, `"expected_quantity":3,"counted_quantity":3`),
		"difference":               replace(`"counted_quantity":3`, `"difference":3,"counted_quantity":3`),
		"unknown":                  replace(`"detail":`, `"location_id":1,"detail":`),
		"casefold":                 replace(`"lines":`, `"Lines":`),
		"duplicate":                replace(`"detail":`, `"detail":"a","detail":`),
		"escaped_duplicate":        replace(`"detail":`, `"\u0064etail":"a","detail":`),
		"duplicate_escaped_key":    replace(`"reason":`, `"reason":"x","\u0072eason":`),
		"nested_duplicate":         replace(`"variant_id":1`, `"variant_id":1,"variant_id":2`),
		"nested_escaped_duplicate": replace(`"counted_quantity":3`, `"counted_quantity":3,"\u0063ounted_quantity":3`),
		"nested_casefold":          replace(`"counted_quantity":`, `"Counted_quantity":`),
		"nested_unknown":           replace(`"counted_quantity":`, `"quantity":1,"counted_quantity":`),
		"nested_expected":          replace(`"counted_quantity":3`, `"expected_quantity":18,"counted_quantity":3`),
		"nested_difference":        replace(`"counted_quantity":3`, `"difference":-15,"counted_quantity":3`),
		"missing_key":              replace(`"operation_key":"http-stock-adjustment-01",`, ``),
		"missing_reason":           replace(`"reason":"conteo físico",`, ``),
		"missing_lines":            replace(`,"lines":[{"variant_id":2,"counted_quantity":7},{"variant_id":1,"counted_quantity":3}]`, ``),
		"null_key":                 replace(`"http-stock-adjustment-01"`, `null`),
		"null_reason":              replace(`"conteo físico"`, `null`),
		"null_detail":              replace(`"pasillo 2"`, `null`),
		"null_lines":               replace(`[{"variant_id":2,"counted_quantity":7},{"variant_id":1,"counted_quantity":3}]`, `null`),
		"empty_lines":              replace(`[{"variant_id":2,"counted_quantity":7},{"variant_id":1,"counted_quantity":3}]`, `[]`),
		"null_line":                replace(`{"variant_id":2,"counted_quantity":7}`, `null`),
		"duplicate_variant":        replace(`{"variant_id":1,"counted_quantity":3}`, `{"variant_id":2,"counted_quantity":3}`),
		"string_counted":           replace(`"counted_quantity":7`, `"counted_quantity":"7"`),
		"float_counted":            replace(`"counted_quantity":7`, `"counted_quantity":7.0`),
		"exponent_counted":         replace(`"counted_quantity":7`, `"counted_quantity":7e0`),
		"negative_counted":         replace(`"counted_quantity":7`, `"counted_quantity":-7`),
		"padded_counted":           replace(`"counted_quantity":7`, `"counted_quantity":07`),
		"counted_bound":            replace(`"counted_quantity":7`, `"counted_quantity":1000001`),
		"counted_overflow":         replace(`"counted_quantity":7`, `"counted_quantity":9223372036854775808`),
		"string_variant":           replace(`"variant_id":2`, `"variant_id":"2"`),
		"zero_variant":             replace(`"variant_id":2`, `"variant_id":0`),
		"negative_variant":         replace(`"variant_id":2`, `"variant_id":-2`),
		"variant_bound":            replace(`"variant_id":2`, `"variant_id":2147483648`),
		"short_key":                replace(`"http-stock-adjustment-01"`, `"short"`),
		"long_key":                 replace(`"http-stock-adjustment-01"`, strconv.Quote(strings.Repeat("a", 129))),
		"unsafe_key":               replace(`"http-stock-adjustment-01"`, `"http stock adjustment 01"`),
		"nul_key":                  replace(`"http-stock-adjustment-01"`, `"http-stock-adjustment-01\u0000"`),
		"invalid_utf8":             replace("conteo", "conteo-\xff"),
	}
	for name, body := range invalid {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-adjustments", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			if _, err := decodeStockAdjustment(r); !errors.Is(err, stockadjustments.ErrInvalid) {
				t.Fatal("invalid framing accepted or unsanitized")
			}
		})
	}
	t.Run("too_many_lines", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/api/stock-adjustments", strings.NewReader(stockAdjustmentCart(191, 1)))
		r.Header.Set("Content-Type", "application/json")
		if _, err := decodeStockAdjustment(r); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatal("more than 190 lines accepted")
		}
	})
	t.Run("max_lines", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/api/stock-adjustments", strings.NewReader(stockAdjustmentCart(190, 1)))
		r.Header.Set("Content-Type", "application/json")
		if got, err := decodeStockAdjustment(r); err != nil || len(got.Lines) != 190 {
			t.Fatal("190 lines rejected")
		}
	})
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json", "application/json"}, {"application/json; charset=utf-8; x=y"}, {"application/json; charset=utf-8; charset=utf-8"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-adjustments", strings.NewReader(validStockAdjustmentJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, err := decodeStockAdjustment(r); !errors.Is(err, stockadjustments.ErrInvalid) {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/stock-adjustments", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, err := decodeStockAdjustment(r); !errors.Is(err, stockadjustments.ErrInvalid) {
		t.Fatal("body read error exposed")
	}
	if _, err := decodeStockAdjustment(nil); !errors.Is(err, stockadjustments.ErrInvalid) {
		t.Fatal("nil request accepted")
	}
}

func TestStockAdjustmentReversalDecoder(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		for _, raw := range []string{
			validStockAdjustmentReversalJSON,
			" \n" + validStockAdjustmentReversalJSON + " \n",
			`{"reason":"conteo mal tomado","operation_key":"http-adjustment-reverse-01"}`,
			`{"operation_key":"http-adjustment-reverse-01","reason":"  conteo mal tomado  "}`,
			`{"operation_key":"http-adjustment-reverse-01","reason":"` + strings.Repeat("ñ", 500) + `"}`,
		} {
			r := httptest.NewRequest("POST", "/api/stock-adjustments/1/reverse", strings.NewReader(raw))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			key, reason, err := decodeStockAdjustmentReversal(r)
			if err != nil || key == "" || reason == "" {
				t.Fatalf("valid reversal framing rejected: %v", err)
			}
		}
	})
	t.Run("canonical_reason", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/api/stock-adjustments/1/reverse", strings.NewReader(`{"operation_key":"http-adjustment-reverse-01","reason":"  conteo mal tomado  "}`))
		r.Header.Set("Content-Type", "application/json")
		if _, reason, err := decodeStockAdjustmentReversal(r); err != nil || reason != "conteo mal tomado" {
			t.Fatal("the admitted reason must be canonicalized once")
		}
	})
	for name, raw := range map[string]string{
		"empty_object":      `{}`,
		"array_root":        `[]`,
		"null_root":         `null`,
		"truncated":         validStockAdjustmentReversalJSON[:len(validStockAdjustmentReversalJSON)-1],
		"trailing":          validStockAdjustmentReversalJSON + `{}`,
		"unknown_key":       `{"operation_key":"http-adjustment-reverse-01","reason":"m","lines":[]}`,
		"bare_reversal":     `{"operation_key":"http-adjustment-reverse-01","reason":"m","target_id":1}`,
		"missing_key":       `{"reason":"m"}`,
		"missing_reason":    `{"operation_key":"http-adjustment-reverse-01"}`,
		"duplicate_key":     `{"operation_key":"http-adjustment-reverse-01","operation_key":"http-adjustment-reverse-02","reason":"m"}`,
		"escaped_duplicate": `{"operation_key":"http-adjustment-reverse-01","\u0072eason":"m","reason":"m"}`,
		"null_key":          `{"operation_key":null,"reason":"m"}`,
		"null_reason":       `{"operation_key":"http-adjustment-reverse-01","reason":null}`,
		"numeric_reason":    `{"operation_key":"http-adjustment-reverse-01","reason":7}`,
		"short_key":         `{"operation_key":"short","reason":"m"}`,
		"long_key":          `{"operation_key":"` + strings.Repeat("a", 129) + `","reason":"m"}`,
		"unsafe_key":        `{"operation_key":"http adjustment reverse 01","reason":"m"}`,
		"empty_reason":      `{"operation_key":"http-adjustment-reverse-01","reason":""}`,
		"blank_reason":      `{"operation_key":"http-adjustment-reverse-01","reason":"  \t\n"}`,
		"long_reason":       `{"operation_key":"http-adjustment-reverse-01","reason":"` + strings.Repeat("ñ", 501) + `"}`,
		"nul_reason":        `{"operation_key":"http-adjustment-reverse-01","reason":"conteo\u0000mal"}`,
		"invalid_utf8":      strings.NewReplacer("conteo mal tomado", "conteo-\xff").Replace(validStockAdjustmentReversalJSON),
		"oversized":         validStockAdjustmentReversalJSON + strings.Repeat(" ", stockAdjustmentBodyLimit),
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-adjustments/1/reverse", strings.NewReader(raw))
			r.Header.Set("Content-Type", "application/json")
			if _, _, err := decodeStockAdjustmentReversal(r); !errors.Is(err, stockadjustments.ErrInvalid) {
				t.Fatal("invalid reversal framing accepted or unsanitized")
			}
		})
	}
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json", "application/json"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/stock-adjustments/1/reverse", strings.NewReader(validStockAdjustmentReversalJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, _, err := decodeStockAdjustmentReversal(r); !errors.Is(err, stockadjustments.ErrInvalid) {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/stock-adjustments/1/reverse", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, _, err := decodeStockAdjustmentReversal(r); !errors.Is(err, stockadjustments.ErrInvalid) {
		t.Fatal("body read error exposed")
	}
	if _, _, err := decodeStockAdjustmentReversal(nil); !errors.Is(err, stockadjustments.ErrInvalid) {
		t.Fatal("nil request accepted")
	}
}

func TestStockAdjustmentFailureMapping(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{stockadjustments.ErrInvalid, 400, "invalid_request"},
		{stockadjustments.ErrForbidden, 403, "forbidden"},
		{stockadjustments.ErrNotFound, 404, "not_found"},
		{stockadjustments.ErrDecisionConflict, 409, "decision_conflict"},
		{stockadjustments.ErrRetryConflict, 409, "retry_conflict"},
		{stockadjustments.ErrInsufficientStock, 409, "insufficient_stock"},
		{stockadjustments.ErrUnavailable, 503, "service_unavailable"},
		{fmt.Errorf("opaque failure"), 503, "service_unavailable"},
	} {
		w := httptest.NewRecorder()
		stockAdjustmentFailure(w, fmt.Errorf("wrapped: %w", tc.err))
		expectTransferError(t, w, tc.status, tc.code)
	}
}

func TestStockAdjustmentQuery(t *testing.T) {
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
		"encoded_page":   {"page=%31", 0, 0, false},
		"encoded_key":    {"%70age=1", 0, 0, false},
		"signed":         {"page=+1", 0, 0, false},
		"fraction":       {"page=1.0", 0, 0, false},
		"empty":          {"page=", 0, 0, false},
		"duplicate":      {"page=1&page=1", 0, 0, false},
		"unknown":        {"page=1&status=all", 0, 0, false},
		"search":         {"search=toyo", 0, 0, false},
		"size":           {"page_size=20", 0, 0, false},
		"no_equals":      {"page", 0, 0, false},
		"trailing":       {"page=1&", 0, 0, false},
		"bad_escape":     {"page=%ZZ", 0, 0, false},
		"oversized":      {"?" + strings.Repeat("a", 5000) + "=1", 0, 0, false},
	} {
		t.Run(name, func(t *testing.T) {
			page, size, err := stockAdjustmentQuery(tc.raw)
			if tc.ok {
				if err != nil || page != tc.page || size != tc.size {
					t.Fatal("an admitted query was refused")
				}
				return
			}
			if !errors.Is(err, stockadjustments.ErrInvalid) {
				t.Fatal("an inadmissible query was accepted")
			}
		})
	}
}

func TestStockAdjustmentCatalogQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want stockadjustments.CatalogQuery
		ok   bool
	}{
		"defaults":      {"", stockadjustments.CatalogQuery{Page: 1, PageSize: 25}, true},
		"all":           {"search=ns60&brand=TOYO&polarity=L&page=2&page_size=10", stockadjustments.CatalogQuery{Search: "ns60", Brand: "TOYO", Polarity: "L", Page: 2, PageSize: 10}, true},
		"decoded_text":  {"search=TOYO%20MOTO", stockadjustments.CatalogQuery{Search: "TOYO MOTO", Page: 1, PageSize: 25}, true},
		"plus_text":     {"search=TOYO+MOTO", stockadjustments.CatalogQuery{Search: "TOYO MOTO", Page: 1, PageSize: 25}, true},
		"blank_search":  {"search=", stockadjustments.CatalogQuery{}, false},
		"blank_brand":   {"brand=", stockadjustments.CatalogQuery{}, false},
		"polarity":      {"polarity=X", stockadjustments.CatalogQuery{}, false},
		"lowercase":     {"polarity=l", stockadjustments.CatalogQuery{}, false},
		"unknown":       {"status=all", stockadjustments.CatalogQuery{}, false},
		"duplicate":     {"search=a&search=a", stockadjustments.CatalogQuery{}, false},
		"encoded_page":  {"page=%31", stockadjustments.CatalogQuery{}, false},
		"page_size":     {"page_size=20", stockadjustments.CatalogQuery{}, false},
		"long_search":   {"search=" + strings.Repeat("a", 129), stockadjustments.CatalogQuery{}, false},
		"long_brand":    {"brand=" + strings.Repeat("a", 129), stockadjustments.CatalogQuery{}, false},
		"bad_escape":    {"search=%ZZ", stockadjustments.CatalogQuery{}, false},
		"nul":           {"search=a%00b", stockadjustments.CatalogQuery{}, false},
		"no_equals":     {"search", stockadjustments.CatalogQuery{}, false},
		"trailing":      {"search=a&", stockadjustments.CatalogQuery{}, false},
		"empty_section": {"&&", stockadjustments.CatalogQuery{}, false},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := stockAdjustmentCatalogQuery(tc.raw)
			if tc.ok {
				if err != nil || got != tc.want {
					t.Fatalf("an admitted catalogue query was refused: %v", err)
				}
				return
			}
			if !errors.Is(err, stockadjustments.ErrInvalid) {
				t.Fatal("an inadmissible catalogue query was accepted")
			}
		})
	}
}

func TestStockAdjustmentRecord(t *testing.T) {
	valid := stockadjustments.Adjustment{
		ID: 7, LocationID: 1, Reason: "conteo físico", Detail: "pasillo 2", CreatedByAccountID: 1,
		CreatedAt: time.Date(2026, 2, 3, 4, 5, 6, 789, time.UTC),
		Lines: []stockadjustments.AdjustmentLine{
			{VariantID: 1, Expected: 18, Counted: 12, Difference: -6},
			{VariantID: 3, Expected: 2, Counted: 5, Difference: 3},
		},
		TotalDifference: -3,
	}
	record, err := stockAdjustmentRecord(valid)
	if err != nil {
		t.Fatal("a persisted document was rejected")
	}
	if record.ID != 7 || record.CreatedAt != "2026-02-03T04:05:06Z" || record.LocationID != 1 ||
		record.CreatedByAccountID != 1 || record.TotalDifference != -3 || len(record.Lines) != 2 ||
		record.Lines[0].Expected != 18 || record.Lines[0].Difference != -6 || record.ReversesAdjustmentID != nil {
		t.Fatal("record does not match the frozen contract")
	}
	for name, change := range map[string]func(*stockadjustments.Adjustment){
		"zero_id":          func(a *stockadjustments.Adjustment) { a.ID = 0 },
		"foreign_location": func(a *stockadjustments.Adjustment) { a.LocationID = 2 },
		"unknown_actor":    func(a *stockadjustments.Adjustment) { a.CreatedByAccountID = 0 },
		"zero_time":        func(a *stockadjustments.Adjustment) { a.CreatedAt = time.Time{} },
		"no_lines":         func(a *stockadjustments.Adjustment) { a.Lines = nil },
		"blank_reason":     func(a *stockadjustments.Adjustment) { a.Reason = " " },
		"padded_reason":    func(a *stockadjustments.Adjustment) { a.Reason = " conteo" },
		"nul_reason":       func(a *stockadjustments.Adjustment) { a.Reason = "a\x00b" },
		"long_reason":      func(a *stockadjustments.Adjustment) { a.Reason = strings.Repeat("ñ", 501) },
		"long_detail":      func(a *stockadjustments.Adjustment) { a.Detail = strings.Repeat("ñ", 501) },
		"nul_detail":       func(a *stockadjustments.Adjustment) { a.Detail = "a\x00b" },
		"unsorted":         func(a *stockadjustments.Adjustment) { a.Lines[0], a.Lines[1] = a.Lines[1], a.Lines[0] },
		"repeated_variant": func(a *stockadjustments.Adjustment) { a.Lines[1].VariantID = 1 },
		"zero_variant":     func(a *stockadjustments.Adjustment) { a.Lines[0].VariantID = 0 },
		"variant_bound":    func(a *stockadjustments.Adjustment) { a.Lines[0].VariantID = 2147483648 },
		"negative_expected": func(a *stockadjustments.Adjustment) {
			a.Lines[0].Expected = -1
		},
		"negative_counted": func(a *stockadjustments.Adjustment) { a.Lines[0].Counted = -1 },
		"counted_bound":    func(a *stockadjustments.Adjustment) { a.Lines[0].Counted = 1000001 },
		"wrong_difference": func(a *stockadjustments.Adjustment) { a.Lines[0].Difference = -5 },
		"wrong_total":      func(a *stockadjustments.Adjustment) { a.TotalDifference = 0 },
		"self_reversal":    func(a *stockadjustments.Adjustment) { a.ReversesAdjustmentID = &a.ID },
		"later_reversal":   func(a *stockadjustments.Adjustment) { later := a.ID + 1; a.ReversesAdjustmentID = &later },
		"zero_reversal": func(a *stockadjustments.Adjustment) {
			zero := int64(0)
			a.ReversesAdjustmentID = &zero
		},
	} {
		adjustment := valid
		adjustment.Lines = append([]stockadjustments.AdjustmentLine(nil), valid.Lines...)
		change(&adjustment)
		if _, err := stockAdjustmentRecord(adjustment); !errors.Is(err, stockadjustments.ErrUnavailable) {
			t.Fatalf("%s must not reach the wire", name)
		}
	}
}

func TestStockAdjustmentDetailRecord(t *testing.T) {
	counter := int64(9)
	stamp := time.Date(2026, 11, 4, 14, 20, 0, 0, time.UTC)
	valid := stockadjustments.Detail{
		ID: 7, LocationID: 1, Reason: "conteo físico", Detail: "pasillo 2", CreatedAt: stamp, CreatedByAccountID: 1,
		ReversedBy: &counter,
		Lines: []stockadjustments.DetailLine{
			{VariantID: 1, CatalogEntryID: 1, Brand: "TOYO", Model: "NS60L", Capacity: "45", Polarity: "L",
				Expected: 18, Counted: 12, Difference: -6},
			{VariantID: 3, CatalogEntryID: 2, Brand: "TOYO", Model: "NS60R", Capacity: "6.5", Polarity: "R",
				Expected: 2, Counted: 5, Difference: 3},
		},
		TotalDifference: -3,
	}
	record, err := stockAdjustmentDetailRecord(valid)
	if err != nil {
		t.Fatal("a persisted detail was rejected")
	}
	if record.ID != 7 || record.CreatedAt != "2026-11-04T14:20:00Z" || record.ReversedBy == nil || *record.ReversedBy != 9 ||
		record.ReversesAdjustmentID != nil || len(record.Lines) != 2 || record.Lines[1].Capacity != "6.5" ||
		record.Lines[0].CatalogEntryID != 1 || record.TotalDifference != -3 {
		t.Fatal("detail does not match the frozen contract")
	}
	for name, change := range map[string]func(*stockadjustments.Detail){
		"zero_id":          func(d *stockadjustments.Detail) { d.ID = 0 },
		"foreign_location": func(d *stockadjustments.Detail) { d.LocationID = 2 },
		"zero_time":        func(d *stockadjustments.Detail) { d.CreatedAt = time.Time{} },
		"blank_reason":     func(d *stockadjustments.Detail) { d.Reason = "" },
		"long_detail":      func(d *stockadjustments.Detail) { d.Detail = strings.Repeat("a", 501) },
		"no_lines":         func(d *stockadjustments.Detail) { d.Lines = nil },
		"unsorted":         func(d *stockadjustments.Detail) { d.Lines[0], d.Lines[1] = d.Lines[1], d.Lines[0] },
		"zero_entry":       func(d *stockadjustments.Detail) { d.Lines[0].CatalogEntryID = 0 },
		"empty_brand":      func(d *stockadjustments.Detail) { d.Lines[0].Brand = "" },
		"nul_model":        func(d *stockadjustments.Detail) { d.Lines[0].Model = "a\x00b" },
		"polarity":         func(d *stockadjustments.Detail) { d.Lines[0].Polarity = "X" },
		"capacity":         func(d *stockadjustments.Detail) { d.Lines[0].Capacity = "0" },
		"blank_capacity":   func(d *stockadjustments.Detail) { d.Lines[0].Capacity = "" },
		"negative_expected": func(d *stockadjustments.Detail) {
			d.Lines[0].Expected = -1
		},
		"counted_bound":    func(d *stockadjustments.Detail) { d.Lines[0].Counted = 1000001 },
		"wrong_difference": func(d *stockadjustments.Detail) { d.Lines[0].Difference = -5 },
		"wrong_total":      func(d *stockadjustments.Detail) { d.TotalDifference = 0 },
		"self_reversal":    func(d *stockadjustments.Detail) { d.ReversesAdjustmentID = &d.ID },
		"stale_reversedBy": func(d *stockadjustments.Detail) { stale := int64(3); d.ReversedBy = &stale },
		"self_reversedBy":  func(d *stockadjustments.Detail) { d.ReversedBy = &d.ID },
	} {
		detail := valid
		detail.Lines = append([]stockadjustments.DetailLine(nil), valid.Lines...)
		change(&detail)
		if _, err := stockAdjustmentDetailRecord(detail); !errors.Is(err, stockadjustments.ErrUnavailable) {
			t.Fatalf("%s must not reach the wire", name)
		}
	}
}

func TestStockAdjustmentPage(t *testing.T) {
	nine, three := int64(9), int64(3)
	stamp := time.Date(2026, 11, 4, 14, 20, 0, 0, time.UTC)
	valid := stockadjustments.Page{Page: 1, PageSize: 25, TotalAdjustments: 2, Adjustments: []stockadjustments.Summary{
		{ID: 9, Reason: "conteo físico", Detail: "", CreatedAt: stamp, Lines: 1, TotalDifference: 6, ReversesAdjustmentID: &three},
		{ID: 7, Reason: "conteo físico", Detail: "pasillo 2", CreatedAt: stamp, Lines: 2, TotalDifference: -4, ReversedBy: &nine},
	}}
	dto, err := stockAdjustmentPage(valid)
	if err != nil {
		t.Fatal("a persisted page was rejected")
	}
	if dto.Page != 1 || dto.PageSize != 25 || dto.TotalAdjustments != 2 || len(dto.Adjustments) != 2 {
		t.Fatal("page does not match the frozen contract")
	}
	if dto.Adjustments[0].ID != 9 || dto.Adjustments[0].ReversesAdjustmentID == nil || *dto.Adjustments[0].ReversesAdjustmentID != 3 ||
		dto.Adjustments[0].CreatedAt != "2026-11-04T14:20:00Z" || dto.Adjustments[0].ReversedBy != nil {
		t.Fatal("a counter-entry row changed shape")
	}
	if dto.Adjustments[1].ReversedBy == nil || *dto.Adjustments[1].ReversedBy != 9 || dto.Adjustments[1].Lines != 2 {
		t.Fatal("a reversed row changed shape")
	}
	clone := func() stockadjustments.Page {
		page := valid
		page.Adjustments = append([]stockadjustments.Summary(nil), valid.Adjustments...)
		return page
	}
	for name, change := range map[string]func(*stockadjustments.Page){
		"zero_page":         func(p *stockadjustments.Page) { p.Page = 0 },
		"page_above_bound":  func(p *stockadjustments.Page) { p.Page = 1000001 },
		"size_not_admitted": func(p *stockadjustments.Page) { p.PageSize = 20 },
		"negative_total":    func(p *stockadjustments.Page) { p.TotalAdjustments = -1 },
		"total_below_page":  func(p *stockadjustments.Page) { p.Page = 2; p.TotalAdjustments = 5; p.Adjustments = p.Adjustments[:1] },
		"zero_id":           func(p *stockadjustments.Page) { p.Adjustments[0].ID = 0 },
		"zero_time":         func(p *stockadjustments.Page) { p.Adjustments[0].CreatedAt = time.Time{} },
		"no_lines":          func(p *stockadjustments.Page) { p.Adjustments[0].Lines = 0 },
		"too_many_lines":    func(p *stockadjustments.Page) { p.Adjustments[0].Lines = 191 },
		"total_above_bound": func(p *stockadjustments.Page) { p.Adjustments[0].TotalDifference = 190_000_001 },
		"total_below_bound": func(p *stockadjustments.Page) { p.Adjustments[0].TotalDifference = -190_000_001 },
		"blank_reason":      func(p *stockadjustments.Page) { p.Adjustments[0].Reason = " " },
		"nul_reason":        func(p *stockadjustments.Page) { p.Adjustments[0].Reason = "a\x00b" },
		"long_detail":       func(p *stockadjustments.Page) { p.Adjustments[0].Detail = strings.Repeat("a", 501) },
		"unsorted": func(p *stockadjustments.Page) {
			p.Adjustments[0], p.Adjustments[1] = p.Adjustments[1], p.Adjustments[0]
		},
		"self_reversal":    func(p *stockadjustments.Page) { p.Adjustments[0].ReversesAdjustmentID = &p.Adjustments[0].ID },
		"self_reversedBy":  func(p *stockadjustments.Page) { p.Adjustments[0].ReversedBy = &p.Adjustments[0].ID },
		"stale_reversedBy": func(p *stockadjustments.Page) { stale := int64(3); p.Adjustments[0].ReversedBy = &stale },
	} {
		page := clone()
		change(&page)
		if _, err := stockAdjustmentPage(page); !errors.Is(err, stockadjustments.ErrUnavailable) {
			t.Fatalf("%s must not reach the wire", name)
		}
	}
	overflowing := stockadjustments.Page{Page: 1, PageSize: 10, TotalAdjustments: 11}
	for i := 11; i >= 1; i-- {
		overflowing.Adjustments = append(overflowing.Adjustments,
			stockadjustments.Summary{ID: int64(i), Reason: "conteo", CreatedAt: stamp, Lines: 1})
	}
	if _, err := stockAdjustmentPage(overflowing); !errors.Is(err, stockadjustments.ErrUnavailable) {
		t.Fatal("a page with more rows than its size must not reach the wire")
	}
}

func TestStockAdjustmentCatalogRecord(t *testing.T) {
	valid := stockadjustments.CatalogPage{Page: 1, PageSize: 10, TotalVariants: 2, Items: []stockadjustments.CatalogItem{
		{VariantID: 1, CatalogEntryID: 1, Brand: "TOYO", Model: "NS60L", Capacity: "45", Polarity: "L"},
		{VariantID: 2, CatalogEntryID: 1, Brand: "TOYO", Model: "NS60L", Capacity: "45", Polarity: "R"},
	}}
	dto, err := stockAdjustmentCatalogPage(valid)
	if err != nil {
		t.Fatal("a persisted catalogue page was rejected")
	}
	if dto.Page != 1 || dto.PageSize != 10 || dto.TotalVariants != 2 || len(dto.Items) != 2 ||
		dto.Items[0].VariantID != 1 || dto.Items[1].Polarity != "R" || dto.Items[0].Capacity != "45" {
		t.Fatal("catalogue page does not match the frozen contract")
	}
	clone := func() stockadjustments.CatalogPage {
		page := valid
		page.Items = append([]stockadjustments.CatalogItem(nil), valid.Items...)
		return page
	}
	for name, change := range map[string]func(*stockadjustments.CatalogPage){
		"zero_page": func(p *stockadjustments.CatalogPage) { p.Page = 0 },
		"size_not_admitted": func(p *stockadjustments.CatalogPage) {
			p.PageSize = 20
		},
		"negative_total": func(p *stockadjustments.CatalogPage) { p.TotalVariants = -1 },
		"page_beyond": func(p *stockadjustments.CatalogPage) {
			p.Page = 3
			p.TotalVariants = 2
		},
		"zero_variant": func(p *stockadjustments.CatalogPage) { p.Items[0].VariantID = 0 },
		"zero_entry":   func(p *stockadjustments.CatalogPage) { p.Items[0].CatalogEntryID = 0 },
		"empty_brand":  func(p *stockadjustments.CatalogPage) { p.Items[0].Brand = "" },
		"nul_model":    func(p *stockadjustments.CatalogPage) { p.Items[0].Model = "a\x00b" },
		"polarity":     func(p *stockadjustments.CatalogPage) { p.Items[0].Polarity = "X" },
		"capacity":     func(p *stockadjustments.CatalogPage) { p.Items[0].Capacity = "0" },
		"unsorted": func(p *stockadjustments.CatalogPage) {
			p.Items[0], p.Items[1] = p.Items[1], p.Items[0]
		},
	} {
		page := clone()
		change(&page)
		if _, err := stockAdjustmentCatalogPage(page); !errors.Is(err, stockadjustments.ErrUnavailable) {
			t.Fatalf("%s must not reach the wire", name)
		}
	}
}

func TestStockAdjustmentConstructor(t *testing.T) {
	cfg := transferConfig(t)
	adjustments := stockadjustments.New(&pgxpool.Pool{})
	// The stock ingress constructor keeps its existing contract: its four required
	// dependencies are still required, with or without the adjustment store.
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
			h, err := NewWithStockEntries(svc, cfg, stock, requests, entries, nil, adjustments)
			if err == nil || h != nil {
				t.Fatal("required nil dependency accepted")
			}
		})
	}
	if h, err := NewWithStockEntries(&auth.Service{}, config.Auth{}, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil, adjustments); err == nil || h != nil {
		t.Fatal("invalid auth configuration accepted")
	}
	if h, err := NewWithStockEntries(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil, adjustments, stockadjustments.New(&pgxpool.Pool{})); err == nil || h != nil {
		t.Fatal("a second adjustment store was accepted")
	}
	h, err := NewWithStockEntries(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil, adjustments)
	if err != nil || h == nil {
		t.Fatal("explicit constructor unavailable")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/stock-adjustments/catalog", nil))
	expectTransferError(t, w, 401, "unauthenticated")
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("the adjustment path safety wrapper must keep the response headers")
	}
	// Without the adjustment store the routes stay unregistered, exactly like the
	// stock ingress does on its legacy factories.
	for _, legacy := range []http.Handler{New(nil, cfg), New(nil, cfg, inventory.New(nil)), transferOnlyHandler(t, cfg),
		stockEntryHandlerWithoutAdjustments(t, cfg)} {
		for _, target := range []string{"/api/stock-adjustments", "/api/stock-adjustments/catalog", "/api/stock-adjustments/1", "/api/stock-adjustments/1/reverse"} {
			w := httptest.NewRecorder()
			legacy.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
			if w.Code != 404 {
				t.Fatalf("%s unexpectedly served %s", target, "a factory without the adjustment store")
			}
		}
	}
}

func stockEntryHandlerWithoutAdjustments(t *testing.T, cfg config.Auth) http.Handler {
	t.Helper()
	h, err := NewWithStockEntries(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil)
	if err != nil || h == nil {
		t.Fatal("stock entry constructor unavailable without adjustments")
	}
	return h
}

type stockAdjustmentHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
}

// stockAdjustmentFixture needs the isolated test PostgreSQL; without an admitted
// manifest every database test here fails closed, which is expected locally.
func stockAdjustmentFixture(t *testing.T) *stockAdjustmentHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("stock adjustment HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("stock adjustment HTTP test provisioning failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("stock adjustment HTTP operational fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("stock adjustment HTTP auth fixture failed")
	}
	f := &stockAdjustmentHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("stock adjustment HTTP login failed")
		}
		f.tokens[i] = token
	}
	f.handler, err = NewWithStockEntries(svc, f.cfg, inventory.New(p), transfers.New(p), stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("stock adjustment HTTP constructor failed")
	}
	return f
}

// snapshot captures every table this domain owns, so a rejected or replayed
// request is proven to leave nothing behind.
func (f *stockAdjustmentHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'adjustments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM stock_adjustments a),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.adjustment_id,l.variant_id),'[]'::jsonb) FROM stock_adjustment_lines l),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("stock adjustment snapshot failed")
	}
	return data
}

func (f *stockAdjustmentHTTPFixture) balance(t *testing.T, variant int64) (existing, reserved int64) {
	t.Helper()
	if f.p.QueryRow(f.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=1 AND variant_id=$1", variant).Scan(&existing, &reserved) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

func (f *stockAdjustmentHTTPFixture) setBalance(t *testing.T, variant, existing, reserved int64) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET existing=$2,reserved=$3 WHERE location_id=1 AND variant_id=$1", variant, existing, reserved); err != nil {
		t.Fatal("balance fixture setup failed")
	}
}

func (f *stockAdjustmentHTTPFixture) count(t *testing.T, table string) int {
	t.Helper()
	var n int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM "+table).Scan(&n) != nil {
		t.Fatal("count query failed")
	}
	return n
}

func (f *stockAdjustmentHTTPFixture) request(actor int, verb, path, body string) *http.Request {
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

func (f *stockAdjustmentHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("stock adjustment security headers changed")
	}
	return w
}

// rejected proves a refused request wrote nothing anywhere.
func (f *stockAdjustmentHTTPFixture) rejected(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	expectTransferError(t, w, status, code)
	if f.snapshot(t) != before {
		t.Fatal("a rejected stock adjustment changed stored state")
	}
}

func stockAdjustmentObject(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]json.RawMessage {
	t.Helper()
	var value map[string]json.RawMessage
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" || json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatalf("stock adjustment JSON response mismatch: status=%d want=%d", w.Code, status)
	}
	if len(value) != 9 {
		t.Fatal("document whitelist changed")
	}
	for _, key := range []string{"id", "location_id", "reason", "detail", "created_by_account_id", "created_at",
		"reverses_adjustment_id", "lines", "total_difference"} {
		if value[key] == nil {
			t.Fatalf("document whitelist incomplete: %s", key)
		}
	}
	var lines []map[string]json.RawMessage
	if json.Unmarshal(value["lines"], &lines) != nil || len(lines) == 0 {
		t.Fatal("document lines are not an array")
	}
	for _, line := range lines {
		if len(line) != 4 {
			t.Fatal("document line whitelist changed")
		}
		for _, key := range []string{"variant_id", "expected_quantity", "counted_quantity", "difference"} {
			if _, ok := line[key]; !ok {
				t.Fatalf("document line whitelist incomplete: %s", key)
			}
		}
	}
	return value
}

type stockAdjustmentHistoryWireDTO struct {
	Page             int                                `json:"page"`
	PageSize         int                                `json:"page_size"`
	TotalAdjustments int64                              `json:"total_adjustments"`
	Adjustments      []stockAdjustmentHistoryRowWireDTO `json:"adjustments"`
}

type stockAdjustmentHistoryRowWireDTO struct {
	ID                   int64  `json:"id"`
	Reason               string `json:"reason"`
	Detail               string `json:"detail"`
	CreatedAt            string `json:"created_at"`
	Lines                int    `json:"lines"`
	TotalDifference      int64  `json:"total_difference"`
	ReversesAdjustmentID *int64 `json:"reverses_adjustment_id"`
	ReversedBy           *int64 `json:"reversed_by"`
}

// stockAdjustmentHistoryWire admits only the frozen history shape: four page keys
// and eight summary keys per row, with no per-line detail anywhere.
func stockAdjustmentHistoryWire(t *testing.T, w *httptest.ResponseRecorder) stockAdjustmentHistoryWireDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("history response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 4 {
		t.Fatal("history whitelist changed")
	}
	for _, key := range []string{"page", "page_size", "total_adjustments", "adjustments"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("history whitelist incomplete: %s", key)
		}
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(top["adjustments"], &rows) != nil {
		t.Fatal("history rows are not an array")
	}
	canonical := regexp.MustCompile(`^[1-9][0-9]*$`)
	for _, row := range rows {
		if len(row) != 8 {
			t.Fatal("history row whitelist changed")
		}
		for _, key := range []string{"id", "reason", "detail", "created_at", "lines", "total_difference",
			"reverses_adjustment_id", "reversed_by"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("history row whitelist incomplete: %s", key)
			}
		}
		for _, pointer := range []string{"reverses_adjustment_id", "reversed_by"} {
			if value := string(row[pointer]); value != "null" && !canonical.MatchString(value) {
				t.Fatalf("%s must be null or a canonical id", pointer)
			}
		}
	}
	var page stockAdjustmentHistoryWireDTO
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Adjustments) != len(rows) {
		t.Fatal("history response is not decodable")
	}
	return page
}

// stockAdjustmentDetailWire admits only the frozen detail shape: ten header keys
// and nine line keys, with no operation key and no stock column outside it.
func stockAdjustmentDetailWire(t *testing.T, w *httptest.ResponseRecorder) stockAdjustmentDetailDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("detail response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 10 {
		t.Fatal("detail whitelist changed")
	}
	for _, key := range []string{"id", "location_id", "reason", "detail", "created_at", "created_by_account_id",
		"reverses_adjustment_id", "reversed_by", "lines", "total_difference"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("detail whitelist incomplete: %s", key)
		}
	}
	var lines []map[string]json.RawMessage
	if json.Unmarshal(top["lines"], &lines) != nil || len(lines) == 0 {
		t.Fatal("detail lines are not an array")
	}
	for _, line := range lines {
		if len(line) != 9 {
			t.Fatal("detail line whitelist changed")
		}
		for _, key := range []string{"variant_id", "catalog_entry_id", "brand", "model", "capacity_ah", "polarity",
			"expected_quantity", "counted_quantity", "difference"} {
			if _, ok := line[key]; !ok {
				t.Fatalf("detail line whitelist incomplete: %s", key)
			}
		}
		if !regexp.MustCompile(`^"[1-9][0-9]*(\.[0-9]*[1-9])?"$`).MatchString(string(line["capacity_ah"])) {
			t.Fatal("capacity_ah must be the canonical decimal as a string")
		}
		for _, key := range []string{"expected_quantity", "counted_quantity", "difference"} {
			if !regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`).MatchString(string(line[key])) {
				t.Fatalf("%s must be a canonical integer", key)
			}
		}
	}
	var detail stockAdjustmentDetailDTO
	if json.Unmarshal(w.Body.Bytes(), &detail) != nil || len(detail.Lines) != len(lines) {
		t.Fatal("detail response is not decodable")
	}
	return detail
}

type stockAdjustmentCatalogWireDTO struct {
	Page          int                                 `json:"page"`
	PageSize      int                                 `json:"page_size"`
	TotalVariants int64                               `json:"total_variants"`
	Items         []stockAdjustmentCatalogItemWireDTO `json:"items"`
}

type stockAdjustmentCatalogItemWireDTO struct {
	VariantID      int64  `json:"variant_id"`
	CatalogEntryID int64  `json:"catalog_entry_id"`
	Brand          string `json:"brand"`
	Model          string `json:"model"`
	Capacity       string `json:"capacity_ah"`
	Polarity       string `json:"polarity"`
}

// stockAdjustmentCatalogWire admits only the blind capture shape: four page keys
// and six identity keys per item, and structurally no stock quantity at all.
func stockAdjustmentCatalogWire(t *testing.T, w *httptest.ResponseRecorder) stockAdjustmentCatalogWireDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("catalogue response mismatch: status=%d want=200", w.Code)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 4 {
		t.Fatal("catalogue whitelist changed")
	}
	for _, key := range []string{"page", "page_size", "total_variants", "items"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("catalogue whitelist incomplete: %s", key)
		}
	}
	var items []map[string]json.RawMessage
	if json.Unmarshal(top["items"], &items) != nil {
		t.Fatal("catalogue items are not an array")
	}
	for _, item := range items {
		if len(item) != 6 {
			t.Fatal("catalogue item whitelist changed")
		}
		for _, key := range []string{"variant_id", "catalog_entry_id", "brand", "model", "capacity_ah", "polarity"} {
			if _, ok := item[key]; !ok {
				t.Fatalf("catalogue item whitelist incomplete: %s", key)
			}
		}
		// The blind count never reveals a stock number: no quantity of any kind
		// may appear, under any alias, in a catalogue item.
		for _, forbidden := range []string{"existing", "reserved", "available", "quantity", "expected", "difference"} {
			for key := range item {
				if strings.Contains(key, forbidden) {
					t.Fatalf("catalogue leaked a stock quantity field: %s", key)
				}
			}
		}
	}
	body := w.Body.String()
	for _, leaked := range []string{"existing", "reserved", "available", "expected_quantity", "counted_quantity", "difference"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("catalogue body leaked a stock quantity: %s", leaked)
		}
	}
	var page stockAdjustmentCatalogWireDTO
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Items) != len(items) {
		t.Fatal("catalogue response is not decodable")
	}
	return page
}

// catalogueIdentity is the catalogue identity of one variant exactly as the
// inventory and adjustment reads render it.
type catalogueIdentity struct {
	variant, entry int64
	brand, model   string
	capacity       string
	polarity       string
}

func (f *stockAdjustmentHTTPFixture) catalogue(t *testing.T) []catalogueIdentity {
	t.Helper()
	rows, err := f.p.Query(f.ctx, `SELECT v.id,e.id,e.brand,e.model,e.capacity_ah::text,v.polarity
 FROM catalog_variants v JOIN catalog_entries e ON e.id=v.catalog_entry_id ORDER BY v.id`)
	if err != nil {
		t.Fatal("catalogue read failed")
	}
	defer rows.Close()
	items := make([]catalogueIdentity, 0, 190)
	for rows.Next() {
		var item catalogueIdentity
		var raw string
		if rows.Scan(&item.variant, &item.entry, &item.brand, &item.model, &raw, &item.polarity) != nil {
			t.Fatal("catalogue row read failed")
		}
		capacity, err := catalog.ParseDecimal(raw)
		if err != nil {
			t.Fatal("catalogue capacity is not a canonical decimal")
		}
		item.capacity = string(capacity)
		items = append(items, item)
	}
	if rows.Err() != nil {
		t.Fatal("catalogue read failed")
	}
	return items
}

func adjustmentDetailPath(id any) string { return fmt.Sprintf("/api/stock-adjustments/%v", id) }
func adjustmentReversalPath(id any) string {
	return fmt.Sprintf("/api/stock-adjustments/%v/reverse", id)
}

// create posts one adjustment document and returns it.
func (f *stockAdjustmentHTTPFixture) create(t *testing.T, body string) stockAdjustmentDTO {
	t.Helper()
	w := f.serve(t, f.request(1, "POST", "/api/stock-adjustments", body))
	stockAdjustmentObject(t, w, 201)
	var document stockAdjustmentDTO
	if json.Unmarshal(w.Body.Bytes(), &document) != nil || document.ID < 1 {
		t.Fatal("created document is not decodable")
	}
	return document
}

func TestStockAdjustmentHTTPSuccess(t *testing.T) {
	f := stockAdjustmentFixture(t)
	one, _ := f.balance(t, 1)
	two, _ := f.balance(t, 2)
	before := f.snapshot(t)
	body := fmt.Sprintf(`{"operation_key":"http-stock-adjustment-01","reason":"conteo físico","detail":"pasillo 2","lines":[{"variant_id":2,"counted_quantity":%d},{"variant_id":1,"counted_quantity":%d}]}`, two-4, one+2)
	w := f.serve(t, f.request(1, "POST", "/api/stock-adjustments", body))
	value := stockAdjustmentObject(t, w, 201)
	var document stockAdjustmentDTO
	if json.Unmarshal(w.Body.Bytes(), &document) != nil || document.ID < 1 || document.LocationID != 1 ||
		document.Reason != "conteo físico" || document.Detail != "pasillo 2" || document.CreatedByAccountID != 1 ||
		document.ReversesAdjustmentID != nil || document.TotalDifference != -2 || len(document.Lines) != 2 {
		t.Fatal("created document does not match the frozen contract")
	}
	// Lines are ordered by variant id, the database owns the expected snapshot and
	// the difference is exactly counted minus expected.
	if document.Lines[0].VariantID != 1 || document.Lines[0].Expected != one || document.Lines[0].Counted != one+2 ||
		document.Lines[0].Difference != 2 {
		t.Fatal("the first line does not carry the database-owned snapshot")
	}
	if document.Lines[1].VariantID != 2 || document.Lines[1].Expected != two || document.Lines[1].Counted != two-4 ||
		document.Lines[1].Difference != -4 {
		t.Fatal("the second line does not carry the database-owned snapshot")
	}
	if stamp, err := time.Parse(time.RFC3339, document.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != document.CreatedAt {
		t.Fatal("created_at is not RFC3339")
	}
	if string(value["location_id"]) != "1" || string(value["created_by_account_id"]) != "1" || string(value["total_difference"]) != "-2" {
		t.Fatal("exact scalar framing changed")
	}
	// Balances moved by exactly the applied difference, and the persisted lines
	// carry what the client counted plus the expected the database took.
	if existing, _ := f.balance(t, 1); existing != one+2 {
		t.Fatal("the first balance did not move by the counted difference")
	}
	if existing, _ := f.balance(t, 2); existing != two-4 {
		t.Fatal("the second balance did not move by the counted difference")
	}
	var expected, counted int64
	if f.p.QueryRow(f.ctx, `SELECT expected_quantity,counted_quantity FROM stock_adjustment_lines
 WHERE adjustment_id=$1 AND variant_id=1`, document.ID).Scan(&expected, &counted) != nil || expected != one || counted != one+2 {
		t.Fatal("the persisted line did not keep the expected snapshot")
	}
	if f.snapshot(t) == before {
		t.Fatal("a created adjustment must change stored state")
	}
	// An identical replay, even with reordered keys and lines, is 200 with the
	// same document and no new writes.
	replayed := f.snapshot(t)
	replayBody := fmt.Sprintf(`{"lines":[{"counted_quantity":%d,"variant_id":1},{"counted_quantity":%d,"variant_id":2}],"detail":"pasillo 2","reason":"conteo físico","operation_key":"http-stock-adjustment-01"}`, one+2, two-4)
	w = f.serve(t, f.request(1, "POST", "/api/stock-adjustments", replayBody))
	stockAdjustmentObject(t, w, 200)
	var replay stockAdjustmentDTO
	if json.Unmarshal(w.Body.Bytes(), &replay) != nil || replay.ID != document.ID ||
		replay.CreatedAt != document.CreatedAt || replay.TotalDifference != document.TotalDifference ||
		len(replay.Lines) != len(document.Lines) {
		t.Fatal("a replay must return the persisted document")
	}
	if f.snapshot(t) != replayed {
		t.Fatal("a replay must not change stored state")
	}
	if n := f.count(t, "stock_adjustments"); n != 1 {
		t.Fatal("a replay must not create a second document")
	}
	// A different payload under the same key is a retry conflict and writes nothing.
	conflict := fmt.Sprintf(`{"operation_key":"http-stock-adjustment-01","reason":"conteo físico","detail":"pasillo 2","lines":[{"variant_id":1,"counted_quantity":%d},{"variant_id":2,"counted_quantity":%d}]}`, one+2, two-3)
	f.rejected(t, f.request(1, "POST", "/api/stock-adjustments", conflict), 409, "retry_conflict")
	if n := f.count(t, "stock_adjustments"); n != 1 {
		t.Fatal("a conflict must not create a second document")
	}
	// A count of zero is a legitimate physical count and applies the full negative
	// difference of the current balance.
	third, _ := f.balance(t, 3)
	if third == 0 {
		f.setBalance(t, 3, 4, 0)
		third = 4
	}
	zero := f.create(t, `{"operation_key":"http-stock-adjustment-zero","reason":"no queda stock","lines":[{"variant_id":3,"counted_quantity":0}]}`)
	if len(zero.Lines) != 1 || zero.Lines[0].Expected != third || zero.Lines[0].Counted != 0 ||
		zero.Lines[0].Difference != -third || zero.TotalDifference != -third {
		t.Fatal("a zero count must be applied as the full negative difference")
	}
	if existing, _ := f.balance(t, 3); existing != 0 {
		t.Fatal("a zero count must leave no existing stock")
	}
}

func TestStockAdjustmentHTTPRejections(t *testing.T) {
	f := stockAdjustmentFixture(t)
	f.rejected(t, f.request(0, "POST", "/api/stock-adjustments", validStockAdjustmentJSON), 401, "unauthenticated")
	f.rejected(t, f.request(2, "POST", "/api/stock-adjustments", validStockAdjustmentJSON), 403, "forbidden")
	f.rejected(t, f.request(3, "POST", "/api/stock-adjustments", validStockAdjustmentJSON), 403, "forbidden")
	for _, verb := range []string{"PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, "/api/stock-adjustments", ""))
		if w.Code != 405 || w.Header().Get("Allow") != "GET, POST" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
	foreign := f.request(1, "POST", "/api/stock-adjustments", validStockAdjustmentJSON)
	foreign.Header.Set("Origin", "http://example.test")
	f.rejected(t, foreign, 403, "forbidden")
	noSite := f.request(1, "POST", "/api/stock-adjustments", validStockAdjustmentJSON)
	noSite.Header.Set("Sec-Fetch-Site", "cross-site")
	f.rejected(t, noSite, 403, "forbidden")
	noCSRF := f.request(1, "POST", "/api/stock-adjustments", validStockAdjustmentJSON)
	noCSRF.Header.Del("X-CSRF-Token")
	f.rejected(t, noCSRF, 403, "forbidden")
	one, _ := f.balance(t, 1)
	for name, body := range map[string]string{
		"expected_quantity": strings.Replace(validStockAdjustmentJSON, `"counted_quantity":3`, `"expected_quantity":18,"counted_quantity":3`, 1),
		"difference":        strings.Replace(validStockAdjustmentJSON, `"counted_quantity":3`, `"difference":-15,"counted_quantity":3`, 1),
		"unknown_field":     strings.Replace(validStockAdjustmentJSON, `"detail":`, `"location_id":1,"detail":`, 1),
		"duplicate_key":     strings.Replace(validStockAdjustmentJSON, `"detail":`, `"detail":"a","detail":`, 1),
		"missing_key":       strings.Replace(validStockAdjustmentJSON, `"operation_key":"http-stock-adjustment-01",`, ``, 1),
		"missing_reason":    strings.Replace(validStockAdjustmentJSON, `"reason":"conteo físico",`, ``, 1),
		"blank_reason":      strings.Replace(validStockAdjustmentJSON, `"conteo físico"`, `"   "`, 1),
		"long_reason":       strings.Replace(validStockAdjustmentJSON, `"conteo físico"`, strconv.Quote(strings.Repeat("ñ", 501)), 1),
		"long_detail":       strings.Replace(validStockAdjustmentJSON, `"pasillo 2"`, strconv.Quote(strings.Repeat("ñ", 501)), 1),
		"short_key":         strings.Replace(validStockAdjustmentJSON, `"http-stock-adjustment-01"`, `"short"`, 1),
		"empty_lines":       strings.Replace(validStockAdjustmentJSON, `[{"variant_id":2,"counted_quantity":7},{"variant_id":1,"counted_quantity":3}]`, `[]`, 1),
		"duplicate_variant": strings.Replace(validStockAdjustmentJSON, `{"variant_id":1,"counted_quantity":3}`, `{"variant_id":2,"counted_quantity":3}`, 1),
		"negative_counted":  strings.Replace(validStockAdjustmentJSON, `"counted_quantity":3`, `"counted_quantity":-3`, 1),
		"huge_counted":      strings.Replace(validStockAdjustmentJSON, `"counted_quantity":3`, `"counted_quantity":1000001`, 1),
		"trailing_input":    validStockAdjustmentJSON + `{}`,
		"unknown_variant":   strings.Replace(validStockAdjustmentJSON, `"variant_id":2`, `"variant_id":999999`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", "/api/stock-adjustments", body), 400, "invalid_request")
		})
	}
	t.Run("query_string", func(t *testing.T) {
		f.rejected(t, f.request(1, "POST", "/api/stock-adjustments?operation_key=x", validStockAdjustmentJSON), 400, "invalid_request")
	})
	// A document that would leave existing below reserved is refused whole.
	f.setBalance(t, 7, 10, 6)
	f.rejected(t, f.request(1, "POST", "/api/stock-adjustments", `{"operation_key":"http-stock-adjustment-uncovered","reason":"conteo físico","lines":[{"variant_id":7,"counted_quantity":3}]}`), 409, "insufficient_stock")
	if existing, reserved := f.balance(t, 7); existing != 10 || reserved != 6 {
		t.Fatal("a refused adjustment must not move a balance")
	}
	if n := f.count(t, "stock_adjustments"); n != 0 {
		t.Fatal("a refused adjustment must not create a document")
	}
	// A truncated reason is admitted and persisted canonically.
	document := f.create(t, `{"operation_key":"http-stock-adjustment-trim","reason":"  conteo físico  ","lines":[{"variant_id":1,"counted_quantity":`+strconv.FormatInt(one, 10)+`}]}`)
	if document.Reason != "conteo físico" || document.Detail != "" {
		t.Fatal("the admitted reason must be persisted canonically and detail is optional")
	}
}

func TestStockAdjustmentHTTPHistory(t *testing.T) {
	f := stockAdjustmentFixture(t)
	empty := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments", "")))
	if empty.Page != 1 || empty.PageSize != 25 || empty.TotalAdjustments != 0 || len(empty.Adjustments) != 0 {
		t.Fatal("an empty history must report one empty page")
	}
	if explicit := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments?page=1&page_size=25", ""))); explicit.TotalAdjustments != 0 {
		t.Fatal("the explicit defaults must answer exactly like the bare route")
	}
	ids := make([]int64, 0, 3)
	for _, body := range []string{
		`{"operation_key":"http-adjustment-history-01","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":3}]}`,
		`{"operation_key":"http-adjustment-history-02","reason":"conteo físico","detail":"pasillo 2","lines":[{"variant_id":2,"counted_quantity":14},{"variant_id":1,"counted_quantity":4}]}`,
		`{"operation_key":"http-adjustment-history-03","reason":"no queda stock","lines":[{"variant_id":2,"counted_quantity":0}]}`,
	} {
		document := f.create(t, body)
		ids = append(ids, document.ID)
	}
	page := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments", "")))
	if page.TotalAdjustments != 3 || len(page.Adjustments) != 3 {
		t.Fatal("every persisted document must be listed once")
	}
	if page.Adjustments[0].ID != ids[2] || page.Adjustments[1].ID != ids[1] || page.Adjustments[2].ID != ids[0] {
		t.Fatal("history must be ordered newest first")
	}
	second := page.Adjustments[1]
	if second.Reason != "conteo físico" || second.Detail != "pasillo 2" || second.Lines != 2 ||
		second.ReversesAdjustmentID != nil || second.ReversedBy != nil {
		t.Fatal("summary does not match the frozen contract")
	}
	if stamp, err := time.Parse(time.RFC3339, second.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != second.CreatedAt {
		t.Fatal("created_at is not RFC3339")
	}
	if page.Adjustments[2].Detail != "" || page.Adjustments[2].Lines != 1 {
		t.Fatal("the oldest document must be summarized exactly")
	}
	// The list is a summary: a document's lines never appear here.
	body := f.serve(t, f.request(1, "GET", "/api/stock-adjustments", "")).Body.String()
	for _, leaked := range []string{"variant_id", "location_id", "counted_quantity", "expected_quantity"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("the history must never expose per-line detail: %s", leaked)
		}
	}
	ten := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments?page=1&page_size=10", "")))
	if ten.Page != 1 || ten.PageSize != 10 || len(ten.Adjustments) != 3 {
		t.Fatal("a ten-row page must report its own size and the total")
	}
	firstPage := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments?page=1&page_size=10", "")))
	if len(firstPage.Adjustments) != 3 || firstPage.Adjustments[0].ID != ids[2] {
		t.Fatal("the first page must start with the newest document")
	}
	beyond := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments?page=1000000&page_size=50", "")))
	if len(beyond.Adjustments) != 0 || beyond.TotalAdjustments != 3 || beyond.PageSize != 50 {
		t.Fatal("a page beyond the last one must be empty and keep the total")
	}
}

func TestStockAdjustmentHTTPHistoryRejections(t *testing.T) {
	f := stockAdjustmentFixture(t)
	f.rejected(t, f.request(0, "GET", "/api/stock-adjustments", ""), 401, "unauthenticated")
	f.rejected(t, f.request(2, "GET", "/api/stock-adjustments", ""), 403, "forbidden")
	f.rejected(t, f.request(3, "GET", "/api/stock-adjustments", ""), 403, "forbidden")
	for name, query := range map[string]string{
		"zero_page":          "?page=0",
		"padded_page":        "?page=01",
		"page_above_bound":   "?page=1000001",
		"word_page":          "?page=abc",
		"empty_page":         "?page=",
		"negative_page":      "?page=-1",
		"encoded_page":       "?page=%31",
		"duplicate_page":     "?page=1&page=1",
		"duplicate_size":     "?page_size=25&page_size=25",
		"unknown_key":        "?operation_key=x",
		"catalogue_key":      "?search=toyo",
		"size_not_admitted":  "?page_size=15",
		"zero_size":          "?page_size=0",
		"empty_size":         "?page_size=",
		"trailing_separator": "?page=1&",
		"empty_query":        "?",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", "/api/stock-adjustments"+query, ""), 400, "invalid_request")
		})
	}
}

func TestStockAdjustmentHTTPDetail(t *testing.T) {
	f := stockAdjustmentFixture(t)
	one, _ := f.balance(t, 1)
	four, _ := f.balance(t, 4)
	original := f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-detail-01","reason":"conteo físico","detail":"pasillo 2","lines":[{"variant_id":4,"counted_quantity":%d},{"variant_id":1,"counted_quantity":%d}]}`, four+3, one-2))
	w := f.serve(t, f.request(1, "GET", adjustmentDetailPath(original.ID), ""))
	detail := stockAdjustmentDetailWire(t, w)
	if detail.ID != original.ID || detail.LocationID != 1 || detail.CreatedByAccountID != 1 ||
		detail.Reason != "conteo físico" || detail.Detail != "pasillo 2" || detail.ReversesAdjustmentID != nil ||
		detail.ReversedBy != nil || detail.TotalDifference != 1 || len(detail.Lines) != 2 {
		t.Fatal("detail does not match the frozen contract")
	}
	if stamp, err := time.Parse(time.RFC3339, detail.CreatedAt); err != nil || stamp.UTC().Format(time.RFC3339) != detail.CreatedAt {
		t.Fatal("detail created_at is not RFC3339")
	}
	// Lines are ordered by variant id and carry the catalogue identity of each
	// variant plus the expected, counted and derived difference.
	want := map[int64]struct{ expected, counted, difference int64 }{
		1: {one, one - 2, -2},
		4: {four, four + 3, 3},
	}
	catalogue := f.catalogue(t)
	for i, line := range detail.Lines {
		expected, ok := want[line.VariantID]
		if !ok {
			t.Fatalf("unexpected detail line for variant %d", line.VariantID)
		}
		if line.Expected != expected.expected || line.Counted != expected.counted || line.Difference != expected.difference {
			t.Fatalf("line %d does not carry expected, counted and difference", line.VariantID)
		}
		identity := catalogue[line.VariantID-1]
		if identity.variant != line.VariantID || identity.entry != line.CatalogEntryID ||
			identity.brand != line.Brand || identity.model != line.Model ||
			identity.capacity != line.Capacity || identity.polarity != line.Polarity {
			t.Fatalf("line %d does not carry its catalogue identity", line.VariantID)
		}
		if i > 0 && detail.Lines[i-1].VariantID >= line.VariantID {
			t.Fatal("detail lines must be ordered by variant id")
		}
	}
	// Nothing stored outside the contract reaches the wire.
	body := w.Body.String()
	for _, leaked := range []string{"operation_key", "available", "reserved", "existing", "username", "updated_at"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("detail leaked a stored field: %s", leaked)
		}
	}
	// The original reports its counter-entry once it exists, and the counter-entry
	// reports the original it reverses, its motive and its mirrored lines.
	counter := f.reverse(t, original.ID)
	counterDetail := stockAdjustmentDetailWire(t, f.serve(t, f.request(1, "GET", adjustmentDetailPath(counter.ID), "")))
	if counterDetail.ID != counter.ID || counterDetail.ReversesAdjustmentID == nil ||
		*counterDetail.ReversesAdjustmentID != original.ID || counterDetail.ReversedBy != nil ||
		counterDetail.Reason != "conteo mal tomado" || counterDetail.TotalDifference != -1 ||
		counterDetail.Detail != "" {
		t.Fatal("counter-entry detail does not match the frozen contract")
	}
	if len(counterDetail.Lines) != 2 || counterDetail.Lines[0].VariantID != 1 ||
		counterDetail.Lines[0].Expected != one-2 || counterDetail.Lines[0].Counted != one ||
		counterDetail.Lines[0].Difference != 2 ||
		counterDetail.Lines[1].Expected != four+3 || counterDetail.Lines[1].Counted != four ||
		counterDetail.Lines[1].Difference != -3 {
		t.Fatal("counter-entry detail does not carry the mirrored expected and counted")
	}
	reversed := stockAdjustmentDetailWire(t, f.serve(t, f.request(1, "GET", adjustmentDetailPath(original.ID), "")))
	if reversed.ReversedBy == nil || *reversed.ReversedBy != counter.ID || reversed.ReversesAdjustmentID != nil ||
		reversed.TotalDifference != 1 {
		t.Fatal("a reversed document must expose its counter-entry and keep its own header")
	}
	// The document stays readable after the stock moved again.
	f.setBalance(t, 1, 1, 0)
	after := stockAdjustmentDetailWire(t, f.serve(t, f.request(1, "GET", adjustmentDetailPath(original.ID), "")))
	if after.Lines[0].Expected != one || after.Lines[0].Counted != one-2 {
		t.Fatal("a persisted document must keep its own arithmetic after the stock changed")
	}
	// The history keeps both documents.
	history := stockAdjustmentHistoryWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments", "")))
	if history.TotalAdjustments != 2 || len(history.Adjustments) != 2 || history.Adjustments[0].ID != counter.ID {
		t.Fatal("the original and its counter-entry must both be listed")
	}
}

// reverse posts the counter-entry of one original document and returns it.
func (f *stockAdjustmentHTTPFixture) reverse(t *testing.T, original int64) stockAdjustmentDTO {
	t.Helper()
	w := f.serve(t, f.request(1, "POST", adjustmentReversalPath(original), validStockAdjustmentReversalJSON))
	stockAdjustmentObject(t, w, 201)
	var counter stockAdjustmentDTO
	if json.Unmarshal(w.Body.Bytes(), &counter) != nil || counter.ID < 1 {
		t.Fatal("counter-entry is not decodable")
	}
	return counter
}

func TestStockAdjustmentHTTPDetailRejections(t *testing.T) {
	f := stockAdjustmentFixture(t)
	one, _ := f.balance(t, 1)
	original := f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-detail-refusal","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":%d}]}`, one))
	path := adjustmentDetailPath(original.ID)
	foreign := f.foreignAdjustment(t)
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
	f.rejected(t, f.request(1, "GET", adjustmentDetailPath(999999999), ""), 404, "not_found")
	f.rejected(t, f.request(1, "GET", adjustmentDetailPath(foreign), ""), 404, "not_found")
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
			f.rejected(t, f.request(1, "GET", adjustmentDetailPath(segment), ""), 400, "invalid_request")
		})
	}
	t.Run("query_string", func(t *testing.T) {
		f.rejected(t, f.request(1, "GET", path+"?page=1", ""), 400, "invalid_request")
	})
	t.Run("bare_query", func(t *testing.T) {
		f.rejected(t, f.request(1, "GET", path+"?", ""), 400, "invalid_request")
	})
	// Path aliases are refused before ServeMux can clean or redirect them.
	for name, alias := range map[string]string{
		"doubled_slash":     "/api/stock-adjustments//" + strconv.FormatInt(original.ID, 10),
		"dot_segment":       "/api/stock-adjustments/./" + strconv.FormatInt(original.ID, 10),
		"dot_dot_segment":   "/api/stock-adjustments/../" + strconv.FormatInt(original.ID, 10),
		"trailing_slash":    path + "/",
		"encoded_slash":     path + "%2F",
		"encoded_id":        "/api/stock-adjustments/%3" + "1",
		"encoded_dot":       "/api/stock-adjustments/%2E/" + strconv.FormatInt(original.ID, 10),
		"encoded_backslash": path + "%5C",
		"unknown_action":    path + "/detalle",
		"reverse_trailing":  path + "/reverse/",
		"empty_segment":     "/api/stock-adjustments/",
		"nul":               "/api/stock-adjustments/" + strconv.FormatInt(original.ID, 10) + "%00",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", alias, ""), 404, "not_found")
		})
	}
	if n := f.count(t, "stock_adjustments"); n != 2 {
		t.Fatal("a rejected detail read must not create a document")
	}
}

// foreignAdjustment persists a document of another location with the admission and
// balance triggers disabled for the shortest possible window: only the database
// may refuse such a document in normal operation, and this fixture needs one to
// prove the adjustment routes never cross the warehouse boundary.
func (f *stockAdjustmentHTTPFixture) foreignAdjustment(t *testing.T) int64 {
	t.Helper()
	enable := func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		for _, statement := range []string{
			"ALTER TABLE stock_adjustment_lines ENABLE TRIGGER USER",
			"ALTER TABLE stock_adjustments ENABLE TRIGGER USER",
		} {
			_, _ = f.p.Exec(cleanup, statement)
		}
	}
	t.Cleanup(enable)
	for _, statement := range []string{
		"ALTER TABLE stock_adjustment_lines DISABLE TRIGGER USER",
		"ALTER TABLE stock_adjustments DISABLE TRIGGER USER",
	} {
		if _, err := f.p.Exec(f.ctx, statement); err != nil {
			t.Fatal("foreign adjustment fixture setup failed")
		}
	}
	var id int64
	if err := f.p.QueryRow(f.ctx, `INSERT INTO stock_adjustments(operation_key,location_id,reason,created_by_account_id)
 VALUES('http-foreign-adjust-01',2,'sucursal',2) RETURNING id`).Scan(&id); err != nil {
		enable()
		t.Fatal("foreign adjustment insert failed")
	}
	if _, err := f.p.Exec(f.ctx, "INSERT INTO stock_adjustment_lines(adjustment_id,variant_id,expected_quantity,counted_quantity) VALUES($1,$2,$3,$4)", id, int32(1), int64(1), int64(2)); err != nil {
		enable()
		t.Fatal("foreign adjustment line insert failed")
	}
	enable()
	return id
}

func TestStockAdjustmentHTTPReversal(t *testing.T) {
	f := stockAdjustmentFixture(t)
	one, _ := f.balance(t, 1)
	two, _ := f.balance(t, 2)
	original := f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-reversal-original","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":%d},{"variant_id":2,"counted_quantity":%d}]}`, one+2, two-4))
	w := f.serve(t, f.request(1, "POST", adjustmentReversalPath(original.ID), validStockAdjustmentReversalJSON))
	value := stockAdjustmentObject(t, w, 201)
	var counter stockAdjustmentDTO
	if json.Unmarshal(w.Body.Bytes(), &counter) != nil {
		t.Fatal("counter-entry is not decodable")
	}
	// The derived lines swap counted and expected, so the applied difference is the
	// exact negation of the original one.
	if counter.ID <= original.ID || counter.LocationID != 1 || counter.CreatedByAccountID != 1 ||
		counter.Reason != "conteo mal tomado" || counter.Detail != "" || counter.ReversesAdjustmentID == nil ||
		*counter.ReversesAdjustmentID != original.ID || counter.TotalDifference != 2 {
		t.Fatal("counter-entry header does not match the frozen contract")
	}
	if len(counter.Lines) != 2 || counter.Lines[0].VariantID != 1 || counter.Lines[0].Expected != one+2 ||
		counter.Lines[0].Counted != one || counter.Lines[0].Difference != -2 ||
		counter.Lines[1].Expected != two-4 || counter.Lines[1].Counted != two || counter.Lines[1].Difference != 4 {
		t.Fatal("counter-entry does not carry the derived mirrored lines")
	}
	if string(value["total_difference"]) != "2" || string(value["reverses_adjustment_id"]) != strconv.FormatInt(original.ID, 10) {
		t.Fatal("exact counter-entry framing changed")
	}
	// The reversal restored every balance exactly.
	if existing, _ := f.balance(t, 1); existing != one {
		t.Fatal("the counter-entry must restore the first balance")
	}
	if existing, _ := f.balance(t, 2); existing != two {
		t.Fatal("the counter-entry must restore the second balance")
	}
	var reason string
	if f.p.QueryRow(f.ctx, "SELECT reason FROM stock_adjustments WHERE id=$1", counter.ID).Scan(&reason) != nil || reason != "conteo mal tomado" {
		t.Fatal("the reversal reason was not persisted")
	}
	// An exact replay of the same key, target and canonical reason is 200.
	replayed := f.snapshot(t)
	w = f.serve(t, f.request(1, "POST", adjustmentReversalPath(original.ID), `{"operation_key":"http-adjustment-reverse-01","reason":"  conteo mal tomado  "}`))
	stockAdjustmentObject(t, w, 200)
	var replay stockAdjustmentDTO
	if json.Unmarshal(w.Body.Bytes(), &replay) != nil || replay.ID != counter.ID ||
		replay.TotalDifference != counter.TotalDifference || len(replay.Lines) != len(counter.Lines) {
		t.Fatal("a reversal replay must return the persisted counter-entry")
	}
	if f.snapshot(t) != replayed {
		t.Fatal("a reversal replay must not change stored state")
	}
	if n := f.count(t, "stock_adjustments"); n != 2 {
		t.Fatal("a reversal replay must not create a second document")
	}
}

func TestStockAdjustmentHTTPReversalRejections(t *testing.T) {
	f := stockAdjustmentFixture(t)
	one, _ := f.balance(t, 1)
	original := f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-reversal-refusal","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":%d}]}`, one))
	path := adjustmentReversalPath(original.ID)
	f.rejected(t, f.request(0, "POST", path, validStockAdjustmentReversalJSON), 401, "unauthenticated")
	f.rejected(t, f.request(2, "POST", path, validStockAdjustmentReversalJSON), 403, "forbidden")
	f.rejected(t, f.request(3, "POST", path, validStockAdjustmentReversalJSON), 403, "forbidden")
	foreign := f.request(1, "POST", path, validStockAdjustmentReversalJSON)
	foreign.Header.Set("Origin", "http://example.test")
	f.rejected(t, foreign, 403, "forbidden")
	noCSRF := f.request(1, "POST", path, validStockAdjustmentReversalJSON)
	noCSRF.Header.Del("X-CSRF-Token")
	f.rejected(t, noCSRF, 403, "forbidden")
	for _, verb := range []string{"GET", "PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, path, ""))
		if w.Code != 405 || w.Header().Get("Allow") != "POST" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
	t.Run("query_string", func(t *testing.T) {
		f.rejected(t, f.request(1, "POST", path+"?reason=x", validStockAdjustmentReversalJSON), 400, "invalid_request")
	})
	for name, body := range map[string]string{
		"unknown_field":  `{"operation_key":"http-adjustment-reverse-01","reason":"conteo mal tomado","detail":"x"}`,
		"lines":          `{"operation_key":"http-adjustment-reverse-01","reason":"conteo mal tomado","lines":[]}`,
		"duplicate_key":  `{"operation_key":"http-adjustment-reverse-01","operation_key":"http-adjustment-reverse-02","reason":"conteo mal tomado"}`,
		"missing_reason": `{"operation_key":"http-adjustment-reverse-01"}`,
		"empty_reason":   `{"operation_key":"http-adjustment-reverse-01","reason":""}`,
		"blank_reason":   `{"operation_key":"http-adjustment-reverse-01","reason":"   "}`,
		"long_reason":    `{"operation_key":"http-adjustment-reverse-01","reason":"` + strings.Repeat("ñ", 501) + `"}`,
		"short_key":      `{"operation_key":"short","reason":"conteo mal tomado"}`,
		"trailing":       validStockAdjustmentReversalJSON + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", path, body), 400, "invalid_request")
		})
	}
	// Only a canonical positive id segment is admitted.
	for name, segment := range map[string]string{
		"padded": "0" + strconv.FormatInt(original.ID, 10),
		"word":   "abc",
		"sign":   "+" + strconv.FormatInt(original.ID, 10),
		"zero":   "0",
		"huge":   "9223372036854775808",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", adjustmentReversalPath(segment), validStockAdjustmentReversalJSON), 400, "invalid_request")
		})
	}
	// Path aliases and unknown routes are refused before ServeMux can clean them.
	for name, alias := range map[string]string{
		"missing":           adjustmentReversalPath(999999999),
		"doubled_slash":     "/api/stock-adjustments//" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"dot_segment":       "/api/stock-adjustments/./" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"dot_dot_segment":   "/api/stock-adjustments/../" + strconv.FormatInt(original.ID, 10) + "/reverse",
		"trailing_slash":    path + "/",
		"encoded_id":        "/api/stock-adjustments/%3" + "1/reverse",
		"encoded_slash":     "/api/stock-adjustments/" + strconv.FormatInt(original.ID, 10) + "%2Freverse",
		"encoded_backslash": "/api/stock-adjustments/" + strconv.FormatInt(original.ID, 10) + "/reverse%5C",
		"unknown_action":    "/api/stock-adjustments/" + strconv.FormatInt(original.ID, 10) + "/borrar",
		"unknown_route":     "/api/stock-adjustments/" + strconv.FormatInt(original.ID, 10) + "/reverse/detalle",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "POST", alias, validStockAdjustmentReversalJSON), 404, "not_found")
		})
	}
	if n := f.count(t, "stock_adjustments"); n != 1 {
		t.Fatal("a rejected reversal must not create a document")
	}
}

func TestStockAdjustmentHTTPReversalConflicts(t *testing.T) {
	f := stockAdjustmentFixture(t)
	one, _ := f.balance(t, 1)
	two, _ := f.balance(t, 2)
	first := f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-conflict-01","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":%d}]}`, one))
	second := f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-conflict-02","reason":"conteo físico","lines":[{"variant_id":2,"counted_quantity":%d}]}`, two))
	counter := f.reverse(t, first.ID)
	// A key bound to another reason or another target is a retry conflict.
	f.rejected(t, f.request(1, "POST", adjustmentReversalPath(first.ID), `{"operation_key":"http-adjustment-reverse-01","reason":"otro motivo"}`), 409, "retry_conflict")
	f.rejected(t, f.request(1, "POST", adjustmentReversalPath(second.ID), validStockAdjustmentReversalJSON), 409, "retry_conflict")
	// The original already has one counter-entry, and the counter-entry is itself a
	// reversal: neither may be reversed again.
	f.rejected(t, f.request(1, "POST", adjustmentReversalPath(first.ID), `{"operation_key":"http-adjustment-reverse-02","reason":"conteo mal tomado"}`), 409, "decision_conflict")
	f.rejected(t, f.request(1, "POST", adjustmentReversalPath(counter.ID), `{"operation_key":"http-adjustment-reverse-03","reason":"conteo mal tomado"}`), 409, "decision_conflict")
	if n := f.count(t, "stock_adjustments"); n != 3 {
		t.Fatal("a refused reversal must not create a document")
	}
}

func TestStockAdjustmentHTTPCatalog(t *testing.T) {
	f := stockAdjustmentFixture(t)
	// The literal catalogue route is never captured by the {id} pattern.
	page := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog", "")))
	if page.Page != 1 || page.PageSize != 25 || page.TotalVariants != 190 || len(page.Items) != 25 {
		t.Fatal("the catalogue must report the blind capture page")
	}
	catalogue := f.catalogue(t)
	for i, item := range page.Items {
		identity := catalogue[i]
		if item.VariantID != identity.variant || item.CatalogEntryID != identity.entry ||
			item.Brand != identity.brand || item.Model != identity.model ||
			item.Capacity != identity.capacity || item.Polarity != identity.polarity {
			t.Fatalf("catalogue item %d does not match the persisted identity", i)
		}
	}
	// No search quantity is queryable through the catalogue filters.
	brandItems := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog?brand="+url.QueryEscape(catalogue[0].brand)+"&page_size=50", "")))
	var wantBrand int64
	for _, identity := range catalogue {
		if identity.brand == catalogue[0].brand {
			wantBrand++
		}
	}
	if brandItems.TotalVariants != wantBrand || int64(len(brandItems.Items)) != min(wantBrand, 50) {
		t.Fatal("the brand filter must answer the matching variants only")
	}
	for _, item := range brandItems.Items {
		if item.Brand != catalogue[0].brand {
			t.Fatal("the brand filter returned another brand")
		}
	}
	right := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog?polarity=R&page_size=50", "")))
	if right.TotalVariants != 95 || len(right.Items) != 50 {
		t.Fatal("the polarity filter must answer the matching variants only")
	}
	for _, item := range right.Items {
		if item.Polarity != "R" {
			t.Fatal("the polarity filter returned another polarity")
		}
	}
	// The search is a literal substring, never a SQL wildcard.
	model := catalogue[8].model
	searched := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog?search="+url.QueryEscape(model)+"&page_size=50", "")))
	var wantSearch int64
	for _, identity := range catalogue {
		if strings.Contains(strings.ToLower(identity.model), strings.ToLower(model)) ||
			strings.Contains(strings.ToLower(identity.brand), strings.ToLower(model)) {
			wantSearch++
		}
	}
	if searched.TotalVariants != wantSearch || len(searched.Items) == 0 {
		t.Fatal("the search filter must answer the matching variants only")
	}
	if wildcard := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog?search=%25", ""))); wildcard.TotalVariants != 0 || len(wildcard.Items) != 0 {
		t.Fatal("a percent in the search must stay a literal, not a wildcard")
	}
	// Pagination is canonical and stable.
	second := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog?page=2&page_size=50", "")))
	if second.Page != 2 || second.PageSize != 50 || second.TotalVariants != 190 || len(second.Items) != 50 ||
		second.Items[0].VariantID != catalogue[50].variant {
		t.Fatal("a second catalogue page must start at the next variant")
	}
	beyond := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog?page=1000000", "")))
	if len(beyond.Items) != 0 || beyond.TotalVariants != 190 {
		t.Fatal("a page beyond the last one must be empty and keep the total")
	}
	// The catalogue keeps serving the capture after a document is applied: it never
	// reads the stock the document moved.
	one, _ := f.balance(t, 1)
	f.create(t, fmt.Sprintf(`{"operation_key":"http-adjustment-catalogue-01","reason":"conteo físico","lines":[{"variant_id":1,"counted_quantity":%d}]}`, one+5))
	after := stockAdjustmentCatalogWire(t, f.serve(t, f.request(1, "GET", "/api/stock-adjustments/catalog", "")))
	if after.TotalVariants != 190 || len(after.Items) != 25 {
		t.Fatal("the catalogue must keep answering the same variants")
	}
}

func TestStockAdjustmentHTTPCatalogRejections(t *testing.T) {
	f := stockAdjustmentFixture(t)
	f.rejected(t, f.request(0, "GET", "/api/stock-adjustments/catalog", ""), 401, "unauthenticated")
	f.rejected(t, f.request(2, "GET", "/api/stock-adjustments/catalog", ""), 403, "forbidden")
	f.rejected(t, f.request(3, "GET", "/api/stock-adjustments/catalog", ""), 403, "forbidden")
	for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(1, verb, "/api/stock-adjustments/catalog", ""))
		if w.Code != 405 || w.Header().Get("Allow") != "GET" || w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be method_not_allowed", verb)
		}
	}
	for name, query := range map[string]string{
		"zero_page":    "?page=0",
		"padded_page":  "?page=01",
		"encoded_page": "?page=%31",
		"page_size":    "?page_size=15",
		"empty_query":  "?",
		"unknown_key":  "?location_id=1",
		"stock_key":    "?existing=10",
		"duplicate":    "?search=a&search=b",
		"polarity":     "?polarity=X",
		"blank_brand":  "?brand=",
		"long_search":  "?search=" + strings.Repeat("a", 129),
		"trailing":     "?search=toyo&",
		"bad_escape":   "?search=%ZZ",
		"nul":          "?search=a%00b",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", "/api/stock-adjustments/catalog"+query, ""), 400, "invalid_request")
		})
	}
	// Aliased catalogue paths are refused before ServeMux can clean them.
	for name, alias := range map[string]string{
		"trailing_slash": "/api/stock-adjustments/catalog/",
		"encoded":        "/api/stock-adjustments/%63atalog",
		"doubled_slash":  "/api/stock-adjustments//catalog",
		"dot_segment":    "/api/stock-adjustments/./catalog",
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(1, "GET", alias, ""), 404, "not_found")
		})
	}
}
