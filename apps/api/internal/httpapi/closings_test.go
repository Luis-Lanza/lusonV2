package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/pricing"
	"luson/api/internal/sales"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// The settlement contract has three layers of test here: the framing of its own routes without a
// database, the revalidation of what it publishes without a database, and the whole vertical over
// a real PostgreSQL through the admitted fixture. Nothing is proven by a fake: the freeze, the
// snapshot, the offer and the closure are the database's own decisions.

// closingRecorder is a base handler that only records the request it received, so forwarding
// stays provable without a database.
type closingRecorder struct {
	calls int
	path  string
}

func (h *closingRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.calls++
	h.path = r.URL.Path
	w.WriteHeader(http.StatusNoContent)
}

func TestClosingPathSafety(t *testing.T) {
	// Every ambiguous settlement path is refused before any handler work, exactly like the sale
	// and adjustment contracts: a doubled slash, a dot segment, a backslash or an encoded alias.
	for _, target := range []string{
		"/api/closings//", "/api/closings/./1", "/api/closings/..", "/api/closings/../closings",
		"/api/closings/a\\b", "/api/closings//settings/2", "/api/closings/%31",
		"/api/closings/%73ettings/2", "/api/closings/1%2Fcount",
	} {
		if closingPath(httptest.NewRequest("GET", target, nil)) {
			t.Fatalf("%s must be refused as an ambiguous settlement path", target)
		}
	}
	if closingPath(&http.Request{URL: &url.URL{Path: "/api/closings/a\x00b"}}) {
		t.Fatal("a NUL in the path must be refused")
	}
	// Every other path is admitted here so it can be forwarded or answered as an unknown route.
	for _, target := range []string{"/api/inventory", "/api/sales", "/api/closingsx",
		"/api/closings", "/api/closings/7", "/api/closings/branches/2/commission", "/api/closings/"} {
		if !closingPath(httptest.NewRequest("GET", target, nil)) {
			t.Fatalf("%s must be admitted here", target)
		}
	}
}

func TestClosingConstructor(t *testing.T) {
	cfg := transferConfig(t)
	store := closings.New(&pgxpool.Pool{})
	base := &closingRecorder{}
	// A missing base or service is a broken composition and never a silently unwrapped handler.
	if h, err := NewWithClosings(nil, &auth.Service{}, cfg, store); err == nil || h != nil {
		t.Fatal("a nil base handler must be refused")
	}
	if h, err := NewWithClosings(base, nil, cfg, store); err == nil || h != nil {
		t.Fatal("a nil auth service must be refused")
	}
	if h, err := NewWithClosings(base, &auth.Service{}, config.Auth{}, store); err == nil || h != nil {
		t.Fatal("an inconsistent auth configuration must be refused")
	}
	h, err := NewWithClosings(base, &auth.Service{}, cfg, store)
	if err != nil || h == nil {
		t.Fatal("the settlement constructor must compose")
	}
	// Every path outside the collection is forwarded to the composed handler unchanged.
	for _, target := range []string{"/api/inventory", "/api/sales", "/api/purchases", "/api/closingsx"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s must be forwarded to the composed handler", target)
		}
	}
	if base.calls != 4 || base.path != "/api/closingsx" {
		t.Fatalf("forwarding changed: %d %q", base.calls, base.path)
	}
	// A missing settlement store never breaks the server: the routes stay unregistered and the
	// composed handler answers them, exactly like stock ingress on the legacy factories.
	optional := &closingRecorder{}
	forwarding, err := NewWithClosings(optional, &auth.Service{}, cfg, nil)
	if err != nil || forwarding == nil {
		t.Fatalf("a missing settlement store must not break the server: %v", err)
	}
	for _, target := range []string{"/api/closings", "/api/closings/1", "/api/closings/branches/2/commission"} {
		w := httptest.NewRecorder()
		forwarding.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent {
			t.Fatalf("without the store %s must be answered by the composed handler", target)
		}
	}
	if optional.calls != 3 {
		t.Fatalf("a missing store must forward every request: %d", optional.calls)
	}
}

func TestClosingRoutes(t *testing.T) {
	cfg := transferConfig(t)
	api := &API{&auth.Service{}, cfg}
	base := &closingRecorder{}
	routes := api.closingRoutes(closings.New(&pgxpool.Pool{}))
	h, err := NewWithClosings(base, &auth.Service{}, cfg, closings.New(&pgxpool.Pool{}))
	if err != nil {
		t.Fatal("the settlement constructor must compose")
	}
	_ = routes
	// Method and identity guards, and the Allow header of every admitted route.
	for _, tc := range []struct {
		method, target, allow string
		status                int
		code                  string
	}{
		{"POST", "/api/closings", "", 401, "unauthenticated"},
		{"GET", "/api/closings", "", 401, "unauthenticated"},
		{"PUT", "/api/closings", "GET, POST", 405, "method_not_allowed"},
		{"DELETE", "/api/closings", "GET, POST", 405, "method_not_allowed"},
		{"GET", "/api/closings/branches/2/commission", "", 401, "unauthenticated"},
		{"PUT", "/api/closings/branches/2/commission", "GET, POST", 405, "method_not_allowed"},
		{"GET", "/api/closings/1", "", 401, "unauthenticated"},
		{"POST", "/api/closings/1", "GET", 405, "method_not_allowed"},
		{"POST", "/api/closings/1/count", "", 401, "unauthenticated"},
		{"GET", "/api/closings/1/count", "POST", 405, "method_not_allowed"},
		{"POST", "/api/closings/1/cash", "", 401, "unauthenticated"},
		{"GET", "/api/closings/1/cash", "POST", 405, "method_not_allowed"},
		{"POST", "/api/closings/1/propose", "", 401, "unauthenticated"},
		{"GET", "/api/closings/1/propose", "POST", 405, "method_not_allowed"},
		{"POST", "/api/closings/1/decision", "", 401, "unauthenticated"},
		{"GET", "/api/closings/1/decision", "POST", 405, "method_not_allowed"},
		{"POST", "/api/closings/expenses", "", 401, "unauthenticated"},
		{"GET", "/api/closings/expenses", "POST", 405, "method_not_allowed"},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.target, nil))
		expectTransferError(t, w, tc.status, tc.code)
		if w.Header().Get("Allow") != tc.allow {
			t.Fatalf("%s %s must advertise %q, got %q", tc.method, tc.target, tc.allow, w.Header().Get("Allow"))
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("the settlement wrapper must keep the response headers")
		}
	}
	// An ambiguous, unknown or aliased path below the collection never reaches a handler.
	for _, target := range []string{
		"/api/closings/", "/api/closings//", "/api/closings/./1", "/api/closings/%31",
		"/api/closings/1/2", "/api/closings/1/counts", "/api/closings/1/Count",
		"/api/closings/expenses/", "/api/closings/expenses/2",
		"/api/closings/branches/2", "/api/closings/branches/2/commission/3",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		expectTransferError(t, w, 404, "not_found")
	}
	if base.calls != 0 {
		t.Fatalf("a settlement path must never be forwarded: %d", base.calls)
	}
}

func TestClosingDecoders(t *testing.T) {
	post := func(body string) *http.Request {
		r := httptest.NewRequest("POST", "/api/closings", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return r
	}
	// Opening states one branch and nothing else.
	if branch, err := decodeClosingOpen(post(`{"branch_location_id":2}`)); err != nil || branch != 2 {
		t.Fatalf("a canonical opening must be admitted: %d %v", branch, err)
	}
	for name, body := range map[string]string{
		"open_empty":     `{}`,
		"open_null":      `null`,
		"open_array":     `[]`,
		"open_warehouse": `{"branch_location_id":1}`,
		"open_zero":      `{"branch_location_id":0}`,
		"open_padded":    `{"branch_location_id":02}`,
		"open_string":    `{"branch_location_id":"2"}`,
		"open_float":     `{"branch_location_id":2.0}`,
		"open_bound":     `{"branch_location_id":32768}`,
		"open_extra":     `{"branch_location_id":2,"cut_at":"2026-01-01T00:00:00Z"}`,
		"open_duplicate": `{"branch_location_id":2,"branch_location_id":3}`,
		"open_trailing":  `{"branch_location_id":2}{}`,
	} {
		if _, err := decodeClosingOpen(post(body)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	// The commission configuration is the percentage and nothing else.
	if rate, err := decodeClosingSettings(post(`{"commission_rate_percent":"12.50"}`)); err != nil || rate != "12.50" {
		t.Fatalf("a canonical rate must be admitted: %q %v", rate, err)
	}
	for name, body := range map[string]string{
		"rate_missing":  `{}`,
		"rate_number":   `{"commission_rate_percent":12.5}`,
		"rate_one":      `{"commission_rate_percent":"12.5"}`,
		"rate_above":    `{"commission_rate_percent":"100.01"}`,
		"rate_negative": `{"commission_rate_percent":"-1.00"}`,
		"rate_extra":    `{"commission_rate_percent":"1.00","branch_location_id":2}`,
	} {
		if _, err := decodeClosingSettings(post(body)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	// The count sheet states counted quantities only.
	counted, err := decodeClosingCount(post(`{"lines":[{"variant_id":1,"counted_quantity":0},{"variant_id":2,"counted_quantity":1000000}]}`))
	if err != nil || len(counted) != 2 || counted[0].Quantity != 0 || counted[1].Quantity != 1000000 {
		t.Fatalf("a canonical count must be admitted: %+v %v", counted, err)
	}
	for name, body := range map[string]string{
		"count_empty":      `{"lines":[]}`,
		"count_absent":     `{}`,
		"count_line_root":  `{"lines":[[]]}`,
		"count_expected":   `{"lines":[{"variant_id":1,"counted_quantity":1,"expected_quantity":9}]}`,
		"count_difference": `{"lines":[{"variant_id":1,"counted_quantity":1,"difference":-1}]}`,
		"count_negative":   `{"lines":[{"variant_id":1,"counted_quantity":-1}]}`,
		"count_bound":      `{"lines":[{"variant_id":1,"counted_quantity":1000001}]}`,
		"count_padded":     `{"lines":[{"variant_id":01,"counted_quantity":1}]}`,
		"count_zero_id":    `{"lines":[{"variant_id":0,"counted_quantity":1}]}`,
		"count_string":     `{"lines":[{"variant_id":1,"counted_quantity":"1"}]}`,
		"count_repeated":   `{"lines":[{"variant_id":1,"counted_quantity":1},{"variant_id":1,"counted_quantity":2}]}`,
		"count_duplicate":  `{"lines":[{"variant_id":1,"counted_quantity":1},{"variant_id":1,"counted_quantity":1}]}`,
		"count_extra":      `{"lines":[{"variant_id":1,"counted_quantity":1}],"closing_id":1}`,
	} {
		if _, err := decodeClosingCount(post(body)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	// The drawer states all four keys, and an uncounted amount is the explicit null.
	draft, err := decodeClosingCash(post(`{"counted_cash":null,"contributed_cash":"0.00","closing_cash":null,"observation":""}`))
	if err != nil || draft.CountedCash != nil || draft.ClosingCash != nil || draft.ContributedCash != "0.00" {
		t.Fatalf("an uncounted drawer must be admitted as a draft: %+v %v", draft, err)
	}
	draft, err = decodeClosingCash(post(`{"counted_cash":"150.00","contributed_cash":"50.00","closing_cash":"10.00","observation":"sobró"}`))
	if err != nil || draft.CountedCash == nil || *draft.CountedCash != "150.00" ||
		*draft.ClosingCash != "10.00" || draft.Observation != "sobró" {
		t.Fatalf("a stated drawer must be admitted: %+v %v", draft, err)
	}
	for name, body := range map[string]string{
		"cash_absent":      `{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00"}`,
		"cash_extra":       `{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":"","cash_sales":"1.00"}`,
		"cash_number":      `{"counted_cash":100,"contributed_cash":"0.00","closing_cash":"0.00","observation":""}`,
		"cash_one_dec":     `{"counted_cash":"100.5","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`,
		"cash_padded":      `{"counted_cash":"0100.00","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`,
		"cash_negative":    `{"counted_cash":"-1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`,
		"cash_contributed": `{"counted_cash":"1.00","contributed_cash":null,"closing_cash":"0.00","observation":""}`,
		"cash_observation": `{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":1}`,
		"cash_nul":         `{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":"a\u0000b"}`,
		"cash_long":        `{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":"` + strings.Repeat("ñ", closings.MaxObservation+1) + `"}`,
	} {
		if _, err := decodeClosingCash(post(body)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	// The decision is accept, or reject with its mandatory motive.
	if decision, reason, err := decodeClosingDecision(post(`{"decision":"accepted"}`)); err != nil ||
		decision != closings.DecisionAccepted || reason != "" {
		t.Fatalf("an acceptance must be admitted: %q %q %v", decision, reason, err)
	}
	if decision, reason, err := decodeClosingDecision(post(`{"decision":"rejected","reason":"faltó contar"}`)); err != nil ||
		decision != closings.DecisionRejected || reason != "faltó contar" {
		t.Fatalf("a rejection with its motive must be admitted: %q %q %v", decision, reason, err)
	}
	for name, body := range map[string]string{
		"decide_absent":   `{}`,
		"decide_unknown":  `{"decision":"maybe"}`,
		"decide_reason":   `{"decision":"rejected"}`,
		"decide_blank":    `{"decision":"rejected","reason":"   "}`,
		"decide_padded":   `{"decision":"rejected","reason":" ya "}`,
		"decide_accepted": `{"decision":"accepted","reason":"porque sí"}`,
		"decide_extra":    `{"decision":"accepted","reason":""}`,
		"decide_long":     `{"decision":"rejected","reason":"` + strings.Repeat("ñ", closings.MaxReason+1) + `"}`,
	} {
		if _, _, err := decodeClosingDecision(post(body)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	// The expense of a branch is its amount and its description, and nothing else.
	amount, description, err := decodeClosingExpense(post(`{"amount":"45.50","description":"Flete"}`))
	if err != nil || amount != "45.50" || description != "Flete" {
		t.Fatalf("a canonical expense must be admitted: %q %q %v", amount, description, err)
	}
	for name, body := range map[string]string{
		"expense_amount_absent":      `{"description":"Flete"}`,
		"expense_amount_number":      `{"amount":45.5,"description":"Flete"}`,
		"expense_amount_one":         `{"amount":"45.5","description":"Flete"}`,
		"expense_amount_padded":      `{"amount":"045.50","description":"Flete"}`,
		"expense_amount_negative":    `{"amount":"-45.50","description":"Flete"}`,
		"expense_amount_three":       `{"amount":"45.505","description":"Flete"}`,
		"expense_description_blank":  `{"amount":"45.50","description":"   "}`,
		"expense_description_pad":    `{"amount":"45.50","description":" Flete "}`,
		"expense_description_null":   `{"amount":"45.50","description":null}`,
		"expense_description_absent": `{"amount":"45.50"}`,
		"expense_extra":              `{"amount":"45.50","description":"Flete","kind":"gasto"}`,
		"expense_duplicate":          `{"amount":"45.50","amount":"10.00","description":"Flete"}`,
		"expense_trailing":           `{"amount":"45.50","description":"Flete"}{}`,
		"expense_long": `{"amount":"45.50","description":"` +
			strings.Repeat("ñ", closings.MaxDescription+1) + `"}`,
	} {
		if _, _, err := decodeClosingExpense(post(body)); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	// The framing is exact: one canonical JSON content type and a body inside the limit.
	for name, headers := range map[string][]string{
		"no_type":       nil,
		"text_json":     {"text/json"},
		"latin1":        {"application/json; charset=latin1"},
		"two_types":     {"application/json", "application/json"},
		"unknown_param": {"application/json; profile=x"},
	} {
		r := httptest.NewRequest("POST", "/api/closings", strings.NewReader(`{"branch_location_id":2}`))
		for _, value := range headers {
			r.Header.Add("Content-Type", value)
		}
		if _, err := decodeClosingOpen(r); !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
	if _, err := decodeClosingOpen(post(`{"branch_location_id":2}` + strings.Repeat(" ", closingsBodyLimit))); !errors.Is(err, closings.ErrInvalid) {
		t.Fatal("a body above the limit must be refused")
	}
}

// closingValue is one complete persisted settlement, used to prove that what this layer publishes
// is revalidated and never trusted as is.
func closingValue() closings.Closing {
	rate := closings.Percent("10.00")
	counted := closings.Money("96000.00")
	fund := closings.Money("6000.00")
	difference := closings.Signed("0.00")
	taken := closings.Signed("90000.00")
	closed := time.Date(2026, 3, 23, 18, 30, 0, 0, time.UTC)
	decided := closed.Add(-2 * time.Minute)
	decidedBy := int64(2)
	proposed := closed.Add(-10 * time.Minute)
	return closings.Closing{
		ID: 1, BranchID: 2, BranchName: "Sucursal A", Status: closings.StatusClosed,
		PeriodStart: time.Date(2026, 2, 23, 18, 0, 0, 0, time.UTC), CutAt: closed,
		ClosedAt: &closed, CommissionRatePercent: &rate, OpeningCash: "0.00",
		CashSales: "96000.00", CashExpenses: "0.00", SalesTotal: "96000.00",
		CommissionAmount: "9600.00", CardTotal: "0.00", TransferTotal: "0.00", QRTotal: "0.00",
		CountedCash: &counted, ContributedCash: "0.00", ClosingCash: &fund,
		OpenedByAccountID: 1, ExpectedCash: "96000.00", CashDifference: &difference,
		TakenCash: &taken,
		CountLines: []closings.CountLine{{VariantID: 3, CatalogEntryID: 2, Brand: "TOYO",
			Model: "NS60L", Capacity: catalog.Decimal("45"), Polarity: "L",
			ExpectedQuantity: 12, CountedQuantity: ptrInt64(12)}},
		Rounds: []closings.Round{{ID: 4, Round: 1, ProposedByAccountID: 1, ProposedAt: proposed,
			Decision: closings.DecisionAccepted, DecidedByAccountID: &decidedBy, DecidedAt: &decided,
			Payload: closings.ProposalPayload{
				PeriodStart: time.Date(2026, 2, 23, 18, 0, 0, 0, time.UTC), CutAt: closed,
				SalesTotal: "96000.00", CommissionRatePercent: "10.00",
				CommissionAmount: "9600.00", CashSales: "96000.00", CashExpenses: "0.00",
				CardTotal: "0.00", TransferTotal: "0.00", QRTotal: "0.00",
				CountedCash: &counted, ContributedCash: "0.00", ClosingCash: &fund,
				CountLines: []closings.ProposalCountLine{{VariantID: 3, ExpectedQuantity: 12,
					CountedQuantity: 12}},
			}},
		}}
}

func ptrInt64(value int64) *int64 { return &value }

func TestClosingRecord(t *testing.T) {
	record, err := closingRecord(closingValue())
	if err != nil {
		t.Fatalf("a complete settlement must be described: %v", err)
	}
	if record.ID != 1 || record.BranchLocationID != 2 || record.Status != "closed" ||
		record.ExpectedCash != "96000.00" || record.CashDifference == nil ||
		*record.CashDifference != "0.00" || record.TakenCash == nil || *record.TakenCash != "90000.00" ||
		record.CommissionAmount != "9600.00" || record.CommissionRatePercent == nil ||
		*record.CommissionRatePercent != "10.00" || record.ClosedAt == nil ||
		len(record.CountLines) != 1 || len(record.Rounds) != 1 {
		t.Fatalf("the settlement does not match the published contract: %+v", record)
	}
	// The commission is reported beside the drawer and inside none of its identities: the three
	// derived numbers are exactly the drawer's own arithmetic.
	if record.OpeningCash != "0.00" || record.CashSales != "96000.00" || record.CashExpenses != "0.00" ||
		*record.CountedCash != "96000.00" || record.ContributedCash != "0.00" ||
		*record.ClosingCash != "6000.00" {
		t.Fatalf("the drawer of the settlement changed: %+v", record)
	}
	if offer := record.Rounds[0].Offer; offer.CommissionAmount != "9600.00" ||
		offer.SalesTotal != "96000.00" || offer.QRTotal != "0.00" || len(offer.CountLines) != 1 {
		t.Fatalf("the round must publish the offer it was answered with: %+v", offer)
	}
	// A held settlement is drafted: no rate yet, and the drawer may still be uncounted.
	open := closingValue()
	open.Status = closings.StatusOpen
	open.ClosedAt = nil
	open.CommissionRatePercent = nil
	open.Rounds = nil
	open.CountedCash = nil
	open.ClosingCash = nil
	open.CashDifference = nil
	open.TakenCash = nil
	openRecord, err := closingRecord(open)
	if err != nil {
		t.Fatalf("an open settlement must be described: %v", err)
	}
	if openRecord.CommissionRatePercent != nil || openRecord.CountedCash != nil ||
		openRecord.CashDifference != nil || openRecord.TakenCash != nil || openRecord.ClosedAt != nil {
		t.Fatalf("a drafted settlement must not publish what it has not stated: %+v", openRecord)
	}
	mutate := func(change func(*closings.Closing)) closings.Closing {
		value := closingValue()
		change(&value)
		return value
	}
	for name, value := range map[string]closings.Closing{
		"zero_id":        mutate(func(v *closings.Closing) { v.ID = 0 }),
		"warehouse":      mutate(func(v *closings.Closing) { v.BranchID = 1 }),
		"branch_bound":   mutate(func(v *closings.Closing) { v.BranchID = closings.MaxBranchID + 1 }),
		"empty_name":     mutate(func(v *closings.Closing) { v.BranchName = "" }),
		"nul_name":       mutate(func(v *closings.Closing) { v.BranchName = "a\x00b" }),
		"unknown_status": mutate(func(v *closings.Closing) { v.Status = "settled" }),
		"zero_account":   mutate(func(v *closings.Closing) { v.OpenedByAccountID = 0 }),
		"zero_period":    mutate(func(v *closings.Closing) { v.PeriodStart = time.Time{} }),
		"cut_before":     mutate(func(v *closings.Closing) { v.CutAt = v.PeriodStart.Add(-time.Hour) }),
		"no_closed_at":   mutate(func(v *closings.Closing) { v.ClosedAt = nil }),
		"closed_open":    mutate(func(v *closings.Closing) { v.Status = closings.StatusOpen }),
		"rate_on_open": mutate(func(v *closings.Closing) {
			v.Status = closings.StatusOpen
			v.ClosedAt = nil
		}),
		"no_rate":            mutate(func(v *closings.Closing) { v.CommissionRatePercent = nil }),
		"rate_above":         mutate(func(v *closings.Closing) { rate := closings.Percent("101.00"); v.CommissionRatePercent = &rate }),
		"rate_short":         mutate(func(v *closings.Closing) { rate := closings.Percent("10.0"); v.CommissionRatePercent = &rate }),
		"money_digits":       mutate(func(v *closings.Closing) { v.CashSales = "96000" }),
		"money_float":        mutate(func(v *closings.Closing) { v.CashSales = "96000.5" }),
		"money_empty":        mutate(func(v *closings.Closing) { v.QRTotal = "" }),
		"expected_stale":     mutate(func(v *closings.Closing) { signed := closings.Signed("1.00"); v.ExpectedCash = signed }),
		"difference_stale":   mutate(func(v *closings.Closing) { signed := closings.Signed("1.00"); v.CashDifference = &signed }),
		"taken_stale":        mutate(func(v *closings.Closing) { signed := closings.Signed("1.00"); v.TakenCash = &signed }),
		"difference_lost":    mutate(func(v *closings.Closing) { v.CashDifference = nil }),
		"taken_without_fund": mutate(func(v *closings.Closing) { v.ClosingCash = nil }),
		"counted_without_difference": mutate(func(v *closings.Closing) {
			v.CashDifference = nil
		}),
		"observation_nul": mutate(func(v *closings.Closing) { v.Observation = "a\x00b" }),
		"line_order": mutate(func(v *closings.Closing) {
			v.CountLines = append(v.CountLines, closings.CountLine{VariantID: 1, CatalogEntryID: 1,
				Brand: "TOYO", Model: "NS40ZL", Capacity: catalog.Decimal("45"), Polarity: "L",
				ExpectedQuantity: 1, CountedQuantity: ptrInt64(1)})
		}),
		"line_polarity": mutate(func(v *closings.Closing) { v.CountLines[0].Polarity = "X" }),
		"line_capacity": mutate(func(v *closings.Closing) { v.CountLines[0].Capacity = catalog.Decimal("x") }),
		"line_expected": mutate(func(v *closings.Closing) { v.CountLines[0].ExpectedQuantity = -1 }),
		"line_counted": mutate(func(v *closings.Closing) {
			counted := int64(closings.MaxCounted + 1)
			v.CountLines[0].CountedQuantity = &counted
		}),
		"round_number":     mutate(func(v *closings.Closing) { v.Rounds[0].Round = 2 }),
		"round_decision":   mutate(func(v *closings.Closing) { v.Rounds[0].Decision = "maybe" }),
		"round_no_decider": mutate(func(v *closings.Closing) { v.Rounds[0].DecidedByAccountID = nil }),
		"round_no_moment":  mutate(func(v *closings.Closing) { v.Rounds[0].DecidedAt = nil }),
		"round_reason": mutate(func(v *closings.Closing) {
			v.Rounds[0].Decision = closings.DecisionRejected
		}),
		"round_accepted_reason": mutate(func(v *closings.Closing) { v.Rounds[0].DecisionReason = "porque sí" }),
		"round_pending_decided": mutate(func(v *closings.Closing) { v.Rounds[0].Decision = "" }),
		"offer_stale_commission": mutate(func(v *closings.Closing) {
			v.Rounds[0].Payload.CommissionAmount = "1.00"
		}),
		"offer_no_drawer": mutate(func(v *closings.Closing) { v.Rounds[0].Payload.CountedCash = nil }),
		"offer_line_order": mutate(func(v *closings.Closing) {
			v.Rounds[0].Payload.CountLines = append(v.Rounds[0].Payload.CountLines,
				closings.ProposalCountLine{VariantID: 1, ExpectedQuantity: 1, CountedQuantity: 1})
		}),
	} {
		if _, err := closingRecord(value); !errors.Is(err, closings.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}

	// A settlement publishes the expenses of its own window with their amount and description, and
	// only a canonical list of its own branch is ever described.
	withExpenses := closingValue()
	withExpenses.Expenses = []closings.Expense{
		{ID: 9, BranchID: 2, Amount: "45.50", Description: "Flete",
			OccurredAt: time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC), CreatedByAccountID: 2},
		{ID: 10, BranchID: 2, Amount: "10.00", Description: "Insumos",
			OccurredAt: time.Date(2026, 3, 2, 11, 0, 0, 0, time.UTC), CreatedByAccountID: 2},
	}
	described, err := closingRecord(withExpenses)
	if err != nil || len(described.Expenses) != 2 || described.Expenses[0].ID != 9 ||
		described.Expenses[0].Amount != "45.50" || described.Expenses[0].Description != "Flete" ||
		described.Expenses[1].ID != 10 || described.Expenses[1].BranchLocationID != 2 ||
		described.Expenses[0].OccurredAt != "2026-03-01T10:00:00Z" ||
		described.Expenses[0].CreatedByAccountID != 2 {
		t.Fatalf("the document must publish the expenses of its window: %+v %v", described, err)
	}
	expenseValue := func(change func(*closings.Expense)) closings.Closing {
		value := withExpenses
		value.Expenses = []closings.Expense{withExpenses.Expenses[0], withExpenses.Expenses[1]}
		change(&value.Expenses[0])
		return value
	}
	for name, value := range map[string]closings.Closing{
		"expense_zero_id":      expenseValue(func(e *closings.Expense) { e.ID = 0 }),
		"expense_other_branch": expenseValue(func(e *closings.Expense) { e.BranchID = 3 }),
		"expense_amount_stale": expenseValue(func(e *closings.Expense) { e.Amount = "45.5" }),
		"expense_zero_amount":  expenseValue(func(e *closings.Expense) { e.Amount = "0.00" }),
		"expense_description":  expenseValue(func(e *closings.Expense) { e.Description = "  " }),
		"expense_no_account":   expenseValue(func(e *closings.Expense) { e.CreatedByAccountID = 0 }),
		"expense_no_moment":    expenseValue(func(e *closings.Expense) { e.OccurredAt = time.Time{} }),
		"expense_order": func() closings.Closing {
			value := withExpenses
			value.Expenses = []closings.Expense{withExpenses.Expenses[1], withExpenses.Expenses[0]}
			return value
		}(),
	} {
		if _, err := closingRecord(value); !errors.Is(err, closings.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

// TestClosingFailureMapping pins the one status and one stable code of every refusal the store can
// hand this layer, so a domain refusal never degrades into a generic request error and never
// changes code by accident. The four refusals an operator acts on are tested with the fact they
// name, which is the whole point of publishing them.
func TestClosingFailureMapping(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"count_pending", &closings.CountPending{VariantID: 7}, 409,
			`{"error":"count_pending","variant_id":7}`},
		{"fund_exceeds_drawer", &closings.FundExceedsDrawer{Excess: "50.00"}, 409,
			`{"error":"fund_exceeds_drawer","excess":"50.00"}`},
		{"branch_retired", &closings.RetiredBranch{BranchID: 3}, 409,
			`{"branch_location_id":3,"error":"branch_retired"}`},
		{"cash_not_stated", &closings.CashNotStated{}, 409, `{"error":"cash_not_stated"}`},
		{"no_rate", closings.ErrNoCommissionRate, 409, `{"error":"commission_rate_missing"}`},
		{"count_frozen", closings.ErrCountFrozen, 409, `{"error":"count_frozen"}`},
		{"state", closings.ErrStateConflict, 409, `{"error":"state_conflict"}`},
		{"closure", closings.ErrClosureRefused, 409, `{"error":"closure_refused"}`},
		{"reserved", closings.ErrReservedStock, 409, `{"error":"reserved_stock"}`},
		{"round", closings.ErrRoundNotAccepted, 409, `{"error":"round_not_accepted"}`},
		{"branch_frozen", closings.ErrBranchFrozen, 409, `{"error":"branch_frozen"}`},
		{"not_branch_expense", closings.ErrNotBranchExpense, 403, `{"error":"forbidden"}`},
		{"invalid", closings.ErrInvalid, 400, `{"error":"invalid_request"}`},
		{"wrapped_invalid", fmt.Errorf("reading the body: %w", closings.ErrInvalid), 400,
			`{"error":"invalid_request"}`},
		{"forbidden", closings.ErrForbidden, 403, `{"error":"forbidden"}`},
		{"not_found", closings.ErrNotFound, 404, `{"error":"not_found"}`},
		{"unavailable", closings.ErrUnavailable, 503, `{"error":"service_unavailable"}`},
	} {
		w := httptest.NewRecorder()
		closingFailure(w, tc.err)
		if w.Code != tc.status || w.Body.String() != tc.body+"\n" ||
			w.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s must answer %d %s, got %d %s", tc.name, tc.status, tc.body, w.Code, w.Body.String())
		}
	}
	// A second live settlement names the branch and the settlement that holds it, because the
	// store reports the document the operator has to read or close.
	w := httptest.NewRecorder()
	closingOpenFailure(w, &closings.LiveConflict{BranchID: 2, ClosingID: 7}, 2)
	if w.Code != 409 ||
		w.Body.String() != `{"branch_location_id":2,"closing_id":7,"error":"settlement_live"}`+"\n" {
		t.Fatalf("a live conflict must name its settlement: %d %s", w.Code, w.Body.String())
	}
	// A conflict whose document could not be read still names the branch and never invents an id.
	w = httptest.NewRecorder()
	closingOpenFailure(w, closings.ErrLiveConflict, 2)
	if w.Code != 409 || w.Body.String() != `{"branch_location_id":2,"error":"settlement_live"}`+"\n" {
		t.Fatalf("a live conflict must name the branch: %d %s", w.Code, w.Body.String())
	}
	// Any other opening failure keeps the mapping above.
	w = httptest.NewRecorder()
	closingOpenFailure(w, closings.ErrForbidden, 2)
	if w.Code != 403 || w.Body.String() != `{"error":"forbidden"}`+"\n" {
		t.Fatalf("an opening forbidden must stay forbidden: %d %s", w.Code, w.Body.String())
	}
}

// TestClosingListQuery pins the history query: the branch, the page and the page size, each once
// and each canonical, exactly like the other histories of this installation.
func TestClosingListQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want closingHistoryQuery
		ok   bool
	}{
		"branch":         {"branch_location_id=2", closingHistoryQuery{BranchID: 2, Page: 1, PageSize: 25}, true},
		"all":            {"branch_location_id=3&page=2&page_size=10", closingHistoryQuery{BranchID: 3, Page: 2, PageSize: 10}, true},
		"reordered":      {"page_size=50&page=1&branch_location_id=2", closingHistoryQuery{BranchID: 2, Page: 1, PageSize: 50}, true},
		"bound_page":     {"branch_location_id=2&page=1000000", closingHistoryQuery{BranchID: 2, Page: 1000000, PageSize: 25}, true},
		"bound_branch":   {"branch_location_id=32767", closingHistoryQuery{BranchID: 32767, Page: 1, PageSize: 25}, true},
		"no_branch":      {"", closingHistoryQuery{}, false},
		"warehouse":      {"branch_location_id=1", closingHistoryQuery{}, false},
		"branch_bound":   {"branch_location_id=32768", closingHistoryQuery{}, false},
		"padded_branch":  {"branch_location_id=02", closingHistoryQuery{}, false},
		"encoded_branch": {"branch_location_id=%32", closingHistoryQuery{}, false},
		"page_zero":      {"branch_location_id=2&page=0", closingHistoryQuery{}, false},
		"page_bound":     {"branch_location_id=2&page=1000001", closingHistoryQuery{}, false},
		"padded_page":    {"branch_location_id=2&page=01", closingHistoryQuery{}, false},
		"page_size_15":   {"branch_location_id=2&page_size=15", closingHistoryQuery{}, false},
		"page_size_0":    {"branch_location_id=2&page_size=0", closingHistoryQuery{}, false},
		"page_size_100":  {"branch_location_id=2&page_size=100", closingHistoryQuery{}, false},
		"repeated":       {"branch_location_id=2&branch_location_id=3", closingHistoryQuery{}, false},
		"unknown":        {"branch_location_id=2&status=closed", closingHistoryQuery{}, false},
		"empty_value":    {"branch_location_id=", closingHistoryQuery{}, false},
		"no_value":       {"branch_location_id", closingHistoryQuery{}, false},
		"empty_part":     {"branch_location_id=2&", closingHistoryQuery{}, false},
		"malformed":      {"branch_location_id=%zz", closingHistoryQuery{}, false},
	} {
		got, err := closingHistoryQueryOf(tc.raw)
		if tc.ok && (err != nil || got != tc.want) {
			t.Fatalf("%s must be admitted as %+v, got %+v %v", name, tc.want, got, err)
		}
		if !tc.ok && !errors.Is(err, closings.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
}

// TestClosingPageRecord pins the history projection: every row is the document projection of the
// single read, the page fits inside the reported total and the rows are newest first.
func TestClosingPageRecord(t *testing.T) {
	newer := closingValue()
	newer.ID = 2
	newer.CutAt = newer.CutAt.Add(time.Hour)
	newer.PeriodStart = newer.PeriodStart.Add(time.Hour)
	newer.ClosedAt = nil
	newer.Status = closings.StatusOpen
	newer.CommissionRatePercent = nil
	newer.CountedCash = nil
	newer.CashDifference = nil
	newer.ClosingCash = nil
	newer.TakenCash = nil
	newer.CountLines = nil
	newer.Rounds = nil
	older := closingValue()
	page, err := closingPageRecord(closings.Page{Page: 1, PageSize: 25, TotalClosings: 2,
		Closings: []closings.Closing{newer, older}})
	if err != nil {
		t.Fatalf("a complete history page must be described: %v", err)
	}
	if page.Page != 1 || page.PageSize != 25 || page.TotalClosings != 2 || len(page.Closings) != 2 ||
		page.Closings[0].ID != 2 || page.Closings[1].ID != 1 {
		t.Fatalf("the history page does not match the published contract: %+v", page)
	}
	// A row is the same document projection: the closed one publishes its derived money.
	if row := page.Closings[1]; row.Status != "closed" || row.ClosedAt == nil ||
		row.ExpectedCash != "96000.00" || row.CommissionAmount != "9600.00" ||
		row.CashDifference == nil || row.ClosingCash == nil || row.CountLines == nil ||
		row.Rounds == nil {
		t.Fatalf("a row must publish the money of its document: %+v", row)
	}
	// An empty page beyond the last one is legitimate.
	if beyond, err := closingPageRecord(closings.Page{Page: 9, PageSize: 25, TotalClosings: 2,
		Closings: []closings.Closing{}}); err != nil || beyond.Closings == nil {
		t.Fatalf("a page beyond the last one must be an empty history: %+v %v", beyond, err)
	}
	for name, value := range map[string]closings.Page{
		"zero_page":      {Page: 0, PageSize: 25, TotalClosings: 0},
		"page_bound":     {Page: closingMaxPage + 1, PageSize: 25},
		"bad_size":       {Page: 1, PageSize: 15},
		"negative_total": {Page: 1, PageSize: 25, TotalClosings: -1},
		"too_many_rows": {Page: 1, PageSize: 10, TotalClosings: 11,
			Closings: []closings.Closing{older, older, older, older, older, older, older, older,
				older, older, older}},
		"beyond_total": {Page: 2, PageSize: 10, TotalClosings: 10,
			Closings: []closings.Closing{older}},
		"older_first": {Page: 1, PageSize: 25, TotalClosings: 2,
			Closings: []closings.Closing{older, newer}},
		"repeated_row": {Page: 1, PageSize: 25, TotalClosings: 2,
			Closings: []closings.Closing{older, older}},
	} {
		if _, err := closingPageRecord(value); !errors.Is(err, closings.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

// closingFailureBody proves a refusal is exactly the listed object, in the shape this contract
// publishes for that class: the code plus the fact it names.
func closingFailureBody(t *testing.T, w *httptest.ResponseRecorder, status int, want string) {
	t.Helper()
	if w.Code != status || w.Body.String() != want+"\n" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("refusal mismatch: %d %s", w.Code, w.Body.String())
	}
}

type closingHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
	prices  *pricing.Store
}

// closingFixture needs the isolated test PostgreSQL. Admission fails closed inside testpg.Open,
// exactly like every other database fixture in this repository: without an admitted manifest the
// test fails instead of passing with a skip.
func closingFixture(t *testing.T) *closingHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("settlement HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("settlement HTTP test provisioning failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("settlement HTTP operational fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("settlement HTTP auth fixture failed")
	}
	f := &closingHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3),
		prices: pricing.New(p)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("settlement HTTP login failed")
		}
		f.tokens[i] = token
	}
	base, err := NewWithStockEntries(svc, f.cfg, inventory.New(p), transfers.New(p),
		stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("settlement HTTP base constructor failed")
	}
	// The point of sale is mounted exactly like the server mounts it, so the money of a period is
	// collected through the same contract the branch uses at the counter.
	withSales, err := NewWithSales(base, svc, f.cfg, sales.New(p))
	if err != nil {
		t.Fatal("settlement HTTP sale constructor failed")
	}
	f.handler, err = NewWithClosings(withSales, svc, f.cfg, closings.New(p))
	if err != nil {
		t.Fatal("settlement HTTP constructor failed")
	}
	return f
}

func (f *closingHTTPFixture) request(actor int, verb, path, body string) *http.Request {
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

func (f *closingHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("settlement security headers changed")
	}
	return w
}

// snapshot captures every table this vertical writes, so a refused request is proven to leave
// nothing behind: no settlement, no count line, no round, no cash movement, no setting and no
// stock.
func (f *closingHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'closings',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM branch_closings c),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.closing_id,l.variant_id),'[]'::jsonb) FROM closing_count_lines l),
  'rounds',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM closing_proposals p),
  'cash',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM branch_cash_movements m),
  'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.branch_location_id),'[]'::jsonb) FROM branch_settings s),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("settlement snapshot failed")
	}
	return data
}

// refused proves a refused request wrote nothing anywhere and answered the listed body.
func (f *closingHTTPFixture) refused(t *testing.T, r *http.Request, status int, want string) {
	t.Helper()
	before := f.snapshot(t)
	closingFailureBody(t, f.serve(t, r), status, want)
	if f.snapshot(t) != before {
		t.Fatal("a refused settlement request changed stored state")
	}
}

// sheet reads the count sheet the database seeded at open: the variant and the expected quantity
// it froze, in variant order.
func (f *closingHTTPFixture) sheet(t *testing.T, id int64) []closings.Counted {
	t.Helper()
	rows, err := f.p.Query(f.ctx, `SELECT variant_id, expected_quantity FROM closing_count_lines
 WHERE closing_id=$1 ORDER BY variant_id`, id)
	if err != nil {
		t.Fatal("count sheet read failed")
	}
	defer rows.Close()
	lines := make([]closings.Counted, 0, closings.MaxCountLines)
	for rows.Next() {
		var line closings.Counted
		if rows.Scan(&line.VariantID, &line.Quantity) != nil {
			t.Fatal("count line read failed")
		}
		lines = append(lines, line)
	}
	if rows.Err() != nil || len(lines) == 0 {
		t.Fatal("the settled branch must have stock to count")
	}
	return lines
}

func closingCountBody(lines []closings.Counted) string {
	parts := make([]string, 0, len(lines))
	for _, line := range lines {
		parts = append(parts, fmt.Sprintf(`{"variant_id":%d,"counted_quantity":%d}`,
			line.VariantID, line.Quantity))
	}
	return `{"lines":[` + strings.Join(parts, ",") + `]}`
}

// countAll counts every variant of the sheet exactly as the system expected it, which is the
// complete count the closure requires.
func (f *closingHTTPFixture) countAll(t *testing.T, id int64) {
	t.Helper()
	w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/count", id),
		closingCountBody(f.sheet(t, id))))
	if w.Code != 200 {
		t.Fatalf("the complete count must be recorded: %d %s", w.Code, w.Body.String())
	}
}

func (f *closingHTTPFixture) open(t *testing.T, branch int64) int64 {
	t.Helper()
	w := f.serve(t, f.request(1, "POST", "/api/closings",
		fmt.Sprintf(`{"branch_location_id":%d}`, branch)))
	record := closingWire(t, w, 201)
	if record.BranchLocationID != branch || record.Status != "open" {
		t.Fatalf("an opened settlement must be published as open: %+v", record)
	}
	return record.ID
}

// stock reads the branch balance of one variant, so the applied count is proven against the
// database and not against the response.
func (f *closingHTTPFixture) stock(t *testing.T, branch, variant int64) (existing, reserved int64) {
	t.Helper()
	if f.p.QueryRow(f.ctx, `SELECT existing,reserved FROM inventory_balances
 WHERE location_id=$1 AND variant_id=$2`, int16(branch), int32(variant)).Scan(&existing, &reserved) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

// closingWireRecord is the settlement exactly as this contract publishes it, for the assertions of
// the tests: the whole record, not a projection, so a missing or renamed key is caught.
type closingWireRecord struct {
	ID                    int64   `json:"id"`
	BranchLocationID      int64   `json:"branch_location_id"`
	BranchName            string  `json:"branch_name"`
	Status                string  `json:"status"`
	PeriodStart           string  `json:"period_start"`
	CutAt                 string  `json:"cut_at"`
	ClosedAt              *string `json:"closed_at"`
	CommissionRatePercent *string `json:"commission_rate_percent"`
	OpeningCash           string  `json:"opening_cash"`
	CashSales             string  `json:"cash_sales"`
	CashExpenses          string  `json:"cash_expenses"`
	ExpectedCash          string  `json:"expected_cash"`
	CountedCash           *string `json:"counted_cash"`
	CashDifference        *string `json:"cash_difference"`
	ContributedCash       string  `json:"contributed_cash"`
	ClosingCash           *string `json:"closing_cash"`
	TakenCash             *string `json:"taken_cash"`
	SalesTotal            string  `json:"sales_total"`
	CommissionAmount      string  `json:"commission_amount"`
	CardTotal             string  `json:"card_total"`
	TransferTotal         string  `json:"transfer_total"`
	QRTotal               string  `json:"qr_total"`
	Observation           string  `json:"observation"`
	OpenedByAccountID     int64   `json:"opened_by_account_id"`
	CountLines            []struct {
		VariantID        int64  `json:"variant_id"`
		ExpectedQuantity int64  `json:"expected_quantity"`
		CountedQuantity  *int64 `json:"counted_quantity"`
	} `json:"count_lines"`
	Expenses []closingExpenseWireRecord `json:"expenses"`
	Rounds   []struct {
		ID             int64  `json:"id"`
		Round          int    `json:"round"`
		Decision       string `json:"decision"`
		DecisionReason string `json:"decision_reason"`
		Offer          struct {
			SalesTotal            string  `json:"sales_total"`
			CommissionRatePercent string  `json:"commission_rate_percent"`
			CommissionAmount      string  `json:"commission_amount"`
			CashSales             string  `json:"cash_sales"`
			CashExpenses          string  `json:"cash_expenses"`
			QRTotal               string  `json:"qr_total"`
			CountedCash           *string `json:"counted_cash"`
			ContributedCash       string  `json:"contributed_cash"`
			ClosingCash           *string `json:"closing_cash"`
		} `json:"offer"`
	} `json:"rounds"`
}

var closingWireKeys = []string{"id", "branch_location_id", "branch_name", "status", "period_start",
	"cut_at", "closed_at", "commission_rate_percent", "opening_cash", "cash_sales", "cash_expenses",
	"expected_cash", "counted_cash", "cash_difference", "contributed_cash", "closing_cash",
	"taken_cash", "sales_total", "commission_amount", "card_total", "transfer_total", "qr_total",
	"observation", "opened_by_account_id", "count_lines", "rounds", "expenses"}

// closingWire admits only the frozen settlement shape: one object with exactly the published keys.
func closingWire(t *testing.T, w *httptest.ResponseRecorder, status int) closingWireRecord {
	t.Helper()
	var value map[string]json.RawMessage
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" ||
		json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatalf("settlement response mismatch: status=%d want=%d body=%s", w.Code, status, w.Body.String())
	}
	if len(value) != len(closingWireKeys) {
		t.Fatalf("settlement whitelist changed: %s", w.Body.String())
	}
	for _, key := range closingWireKeys {
		if _, ok := value[key]; !ok {
			t.Fatalf("settlement key %q missing: %s", key, w.Body.String())
		}
	}
	var record closingWireRecord
	if json.Unmarshal(w.Body.Bytes(), &record) != nil {
		t.Fatalf("settlement is not decodable: %s", w.Body.String())
	}
	return record
}

// TestClosingsWarehouseOnlyRoutes pins the authorization of the vertical over HTTP: the warehouse
// holds every warehouse route, a branch account is refused on all of them, and no refusal writes
// anything.
func TestClosingsWarehouseOnlyRoutes(t *testing.T) {
	f := closingFixture(t)
	// The warehouse opens a settlement of branch 3, which is the document the branch account will
	// try to operate. The rate is configured so the propose is a state refusal and not a missing
	// rate.
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/3/commission",
		`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
		t.Fatalf("the warehouse must configure a rate: %d %s", w.Code, w.Body.String())
	}
	id := f.open(t, 3)
	// Every warehouse route refuses the branch account with the same code: the store's own
	// admission, not a handler-side guess.
	for _, attempt := range []struct{ target, body string }{
		{"/api/closings/branches/3/commission", `{"commission_rate_percent":"10.00"}`},
		{fmt.Sprintf("/api/closings/%d/count", id), `{"lines":[{"variant_id":1,"counted_quantity":1}]}`},
		{fmt.Sprintf("/api/closings/%d/cash", id),
			`{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`},
		{fmt.Sprintf("/api/closings/%d/propose", id), ""},
	} {
		f.refused(t, f.request(2, "POST", attempt.target, attempt.body), 403, `{"error":"forbidden"}`)
	}
	f.refused(t, f.request(2, "POST", "/api/closings", `{"branch_location_id":2}`), 403, `{"error":"forbidden"}`)
	// A branch reads its own commission and never another branch's, which is the same scope rule
	// the store enforces on writes.
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"12.50"}`)); w.Code != 200 {
		t.Fatalf("the warehouse must configure branch 2: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(2, "GET", "/api/closings/branches/2/commission", "")); w.Code != 200 ||
		w.Body.String() != "{\"branch_location_id\":2,\"commission_rate_percent\":\"12.50\"}\n" {
		t.Fatalf("a branch must read its own rate: %d %s", w.Code, w.Body.String())
	}
	f.refused(t, f.request(2, "GET", "/api/closings/branches/3/commission", ""), 403, `{"error":"forbidden"}`)
	// The warehouse reads the settlement of the branch it holds; reading a settlement of another
	// branch is not found for that branch, exactly like another branch's documents.
	if w := f.serve(t, f.request(1, "GET", fmt.Sprintf("/api/closings/%d", id), "")); w.Code != 200 {
		t.Fatalf("the warehouse must read the settlement: %d %s", w.Code, w.Body.String())
	}
	f.refused(t, f.request(2, "GET", fmt.Sprintf("/api/closings/%d", id), ""), 404, `{"error":"not_found"}`)
	// The warehouse does not decide a settlement: only the branch answers its own offer.
	f.refused(t, f.request(1, "GET", "/api/closings/999", ""), 404, `{"error":"not_found"}`)
}

// TestClosingsOneLiveSettlement pins S17 over HTTP: a branch holds one live settlement at a time,
// and the refusal names the branch that is already held.
func TestClosingsOneLiveSettlement(t *testing.T) {
	f := closingFixture(t)
	first := f.open(t, 2)
	f.refused(t, f.request(1, "POST", "/api/closings", `{"branch_location_id":2}`), 409,
		fmt.Sprintf(`{"branch_location_id":2,"closing_id":%d,"error":"settlement_live"}`, first))
	var rows int
	if f.p.QueryRow(f.ctx, `SELECT count(*) FROM branch_closings WHERE branch_location_id=2`).Scan(&rows) != nil ||
		rows != 1 {
		t.Fatalf("a refused opening must leave exactly one settlement, got %d", rows)
	}
	if first < 1 {
		t.Fatal("the first settlement must have an id")
	}
}

// TestClosingsRefusalsNameWhatIsMissing pins the two refusals an operator has to act on: the
// variant still to count and the fund that exceeds the drawer, plus the branch without a
// commission rate. None of them is a generic 400.
func TestClosingsRefusalsNameWhatIsMissing(t *testing.T) {
	f := closingFixture(t)
	id := f.open(t, 2)
	// One line counted and the rest pending: the proposal names the first variant still to count.
	sheet := f.sheet(t, id)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/count", id),
		closingCountBody(sheet[:1]))); w.Code != 200 {
		t.Fatalf("a partial count is a legitimate draft: %d %s", w.Code, w.Body.String())
	}
	pending := sheet[1].VariantID
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), ""), 409,
		fmt.Sprintf(`{"error":"count_pending","variant_id":%d}`, pending))
	// The drawer states a fund the counted cash cannot hold: the refusal names the excess, so the
	// admin corrects the exact amount.
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"100.00","contributed_cash":"0.00","closing_cash":"150.00","observation":""}`),
		409, `{"error":"fund_exceeds_drawer","excess":"50.00"}`)
	// A fund the drawer can hold is admitted, and the proposal then refuses for the missing rate:
	// the database freezes the configured percentage when the warehouse proposes (S6).
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"100.00","contributed_cash":"0.00","closing_cash":"40.00","observation":"contado"}`)); w.Code != 200 {
		t.Fatalf("a fund inside the drawer must be saved: %d %s", w.Code, w.Body.String())
	}
	f.countAll(t, id)
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), ""), 409,
		`{"error":"commission_rate_missing"}`)
	// With the rate configured the same proposal is offered, so the refusal above was the rate and
	// not a hidden state.
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
		t.Fatalf("the rate must be configured: %d %s", w.Code, w.Body.String())
	}
	proposed := closingWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/closings/%d/propose", id), "")), 200)
	if proposed.Status != "proposed" || len(proposed.Rounds) != 1 || proposed.Rounds[0].Decision != "" {
		t.Fatalf("the proposal must offer one undecided round: %+v", proposed)
	}
}

// TestClosingsBranchDecidesItsOwnOffer pins S14 over HTTP: only an account of the branch decides,
// only while the settlement is proposed, a rejection states its mandatory reason and applies
// nothing, and only the acceptance closes and applies the counted stock.
func TestClosingsBranchDecidesItsOwnOffer(t *testing.T) {
	f := closingFixture(t)
	rate := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`))
	if rate.Code != 200 {
		t.Fatalf("the rate must be configured: %d %s", rate.Code, rate.Body.String())
	}
	id := f.open(t, 2)
	// A held settlement is not decidable yet: there is no offer to answer.
	f.refused(t, f.request(2, "POST", fmt.Sprintf("/api/closings/%d/decision", id),
		`{"decision":"accepted"}`), 409, `{"error":"state_conflict"}`)
	f.countAll(t, id)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"120.00","contributed_cash":"0.00","closing_cash":"20.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), "")); w.Code != 200 {
		t.Fatalf("the settlement must be proposed: %d %s", w.Code, w.Body.String())
	}
	stockBefore := f.snapshot(t)
	// Another branch and the warehouse are both refused: the settlement is decided by its branch.
	f.refused(t, f.request(3, "POST", fmt.Sprintf("/api/closings/%d/decision", id),
		`{"decision":"accepted"}`), 403, `{"error":"forbidden"}`)
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/decision", id),
		`{"decision":"accepted"}`), 403, `{"error":"forbidden"}`)
	// A rejection names its motive and applies nothing at all: no stock, no cash movement.
	rejected := closingWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", id), `{"decision":"rejected","reason":"faltó contar la bodega"}`)), 200)
	if rejected.Status != "rejected" || len(rejected.Rounds) != 1 ||
		rejected.Rounds[0].Decision != "rejected" ||
		rejected.Rounds[0].DecisionReason != "faltó contar la bodega" {
		t.Fatalf("the rejection must be published with its motive: %+v", rejected)
	}
	if f.snapshot(t) == stockBefore {
		t.Fatal("the rejection round must be recorded")
	}
	for _, variant := range []int64{1, 2, 3} {
		if existing, _ := f.stock(t, 2, variant); existing != f.expectedStock(t, id, variant) {
			t.Fatalf("a rejection must not move stock of variant %d", variant)
		}
	}
	// The warehouse corrects and proposes again: there is no limit of rounds, and the acceptance
	// is the only thing that closes.
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), "")); w.Code != 200 {
		t.Fatalf("a rejected settlement must be proposed again: %d %s", w.Code, w.Body.String())
	}
	closed := closingWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", id), `{"decision":"accepted"}`)), 200)
	if closed.Status != "closed" || closed.ClosedAt == nil || len(closed.Rounds) != 2 ||
		closed.Rounds[1].Decision != "accepted" || closed.Rounds[0].Decision != "rejected" {
		t.Fatalf("the acceptance must close and keep the whole history: %+v", closed)
	}
	for _, line := range closed.CountLines {
		if line.CountedQuantity == nil {
			t.Fatalf("a closed settlement states every counted quantity: %+v", line)
		}
		if existing, reserved := f.stock(t, 2, line.VariantID); existing != *line.CountedQuantity || reserved != 0 {
			t.Fatalf("the closure must leave variant %d at what was counted: %d/%d",
				line.VariantID, existing, reserved)
		}
	}
	// A closed settlement is never reopened: the same document refuses another proposal.
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), ""), 409,
		`{"error":"state_conflict"}`)
}

// expectedStock is the expected quantity the settlement froze for one variant, so a refusal can be
// proven to have left the stock exactly where the count sheet says it is.
func (f *closingHTTPFixture) expectedStock(t *testing.T, id, variant int64) int64 {
	t.Helper()
	var expected int64
	if f.p.QueryRow(f.ctx, `SELECT expected_quantity FROM closing_count_lines
 WHERE closing_id=$1 AND variant_id=$2`, id, int32(variant)).Scan(&expected) != nil {
		t.Fatal("count line read failed")
	}
	return expected
}

// TestClosingsDraftAndDerivedMoney pins S8, S9, S10, S11 and S13 over HTTP over the real flow of
// the vertical: the first settlement of a branch has an empty period and starts the fund, the
// second one inherits that fund and settles the sales collected in between. The count sheet keeps
// the snapshot the database took, the drawer is a draft that can be saved and read again, the
// derived money is published as it is computed with its sign, and the commission of the period is
// reported beside the drawer and inside none of its identities.
func TestClosingsDraftAndDerivedMoney(t *testing.T) {
	f := closingFixture(t)
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
		t.Fatalf("the rate must be configured: %d %s", w.Code, w.Body.String())
	}
	// S11: the first settlement of a branch settles an empty period with no sales, no commission
	// and the fund the warehouse leaves behind. The fund is a contribution it states, because a
	// drawer of zero cannot hold one.
	first := f.open(t, 2)
	f.countAll(t, first)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", first),
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)); w.Code != 200 {
		t.Fatalf("the bootstrap drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	firstProposal := closingWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/closings/%d/propose", first), "")), 200)
	if firstProposal.SalesTotal != "0.00" || firstProposal.CommissionAmount != "0.00" ||
		firstProposal.CashSales != "0.00" || firstProposal.ExpectedCash != "0.00" ||
		firstProposal.TakenCash == nil || *firstProposal.TakenCash != "0.00" {
		t.Fatalf("the first period must be empty and pay no commission: %+v", firstProposal)
	}
	firstClosed := closingWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", first), `{"decision":"accepted"}`)), 200)
	if firstClosed.Status != "closed" || firstClosed.ClosingCash == nil ||
		*firstClosed.ClosingCash != "100.00" || firstClosed.ClosedAt == nil {
		t.Fatalf("the first settlement must close leaving the fund: %+v", firstClosed)
	}
	// The contribution is its own movement of the ledger, which is what starts the drawer.
	var contributions int
	if f.p.QueryRow(f.ctx, `SELECT count(*) FROM branch_cash_movements
 WHERE closing_id=$1 AND kind='aporte' AND amount=100.00`, first).Scan(&contributions) != nil ||
		contributions != 1 {
		t.Fatalf("the declared fund must be recorded as a contribution, got %d", contributions)
	}
	// The branch sells again, now that it operates: one battery at 96000.00, paid in cash.
	if _, err := f.prices.Write(f.ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
		pricing.WriteInput{CatalogEntryID: 1, MinPrice: pricing.Money("85000.00"),
			SuggestedPrice: pricing.Money("96000.00"), BranchIDs: []int64{2}}); err != nil {
		t.Fatalf("price fixture failed: %v", err)
	}
	if w := f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6))); w.Code != 201 {
		t.Fatalf("the branch must sell between settlements: %d %s", w.Code, w.Body.String())
	}
	// The next settlement inherits the fund and starts where the previous one closed.
	id := f.open(t, 2)
	opened := closingWire(t, f.serve(t, f.request(1, "GET", fmt.Sprintf("/api/closings/%d", id), "")), 200)
	if opened.OpeningCash != "100.00" || opened.PeriodStart != *firstClosed.ClosedAt ||
		opened.SalesTotal != "0.00" || opened.CashSales != "0.00" || opened.ExpectedCash != "100.00" ||
		opened.CommissionRatePercent != nil || opened.CountedCash != nil ||
		opened.CashDifference != nil || opened.TakenCash != nil {
		t.Fatalf("a settlement inherits the fund and the period, not the numbers of it: %+v", opened)
	}
	// The sheet is the database's own snapshot of the cut and no line is counted yet.
	for _, line := range opened.CountLines {
		if line.CountedQuantity != nil {
			t.Fatalf("a seeded line is pending until it is counted: %+v", line)
		}
	}
	sheet := f.sheet(t, id)
	if len(sheet) != len(opened.CountLines) || len(sheet) < 2 {
		t.Fatalf("the sheet must be the snapshot of the branch stock: %d/%d", len(sheet), len(opened.CountLines))
	}
	// The counted quantity is recorded against the frozen expected quantity, which is never a
	// client promise: the body states what was counted and nothing else.
	counted := closingCountBody([]closings.Counted{{VariantID: sheet[0].VariantID,
		Quantity: sheet[0].Quantity - 1}})
	record := closingWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/closings/%d/count", id), counted)), 200)
	if record.CountLines[0].CountedQuantity == nil ||
		*record.CountLines[0].CountedQuantity != sheet[0].Quantity-1 ||
		record.CountLines[0].ExpectedQuantity != sheet[0].Quantity {
		t.Fatalf("the count must be recorded against the snapshot: %+v", record.CountLines[0])
	}
	// The drawer is a draft that is read back with what it states. Until the warehouse proposes,
	// the period totals are still zero, because the database records them with the proposal.
	draft := closingWire(t, f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"96000.00","contributed_cash":"0.00","closing_cash":"6000.00","observation":"contado en persona"}`)), 200)
	if draft.CountedCash == nil || *draft.CountedCash != "96000.00" ||
		draft.ClosingCash == nil || *draft.ClosingCash != "6000.00" ||
		draft.TakenCash == nil || *draft.TakenCash != "90000.00" ||
		draft.ExpectedCash != "100.00" || draft.CashDifference == nil ||
		*draft.CashDifference != "95900.00" || draft.Observation != "contado en persona" {
		t.Fatalf("the drawer draft must be published with its derived numbers: %+v", draft)
	}
	f.countAll(t, id)
	proposed := closingWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/closings/%d/propose", id), "")), 200)
	if proposed.Status != "proposed" || proposed.CommissionRatePercent == nil ||
		*proposed.CommissionRatePercent != "10.00" || proposed.SalesTotal != "96000.00" ||
		proposed.CommissionAmount != "9600.00" || proposed.CashSales != "96000.00" ||
		proposed.CardTotal != "0.00" || proposed.TransferTotal != "0.00" || proposed.QRTotal != "0.00" {
		t.Fatalf("the offer must state the period and its commission: %+v", proposed)
	}
	// The commission is reported and enters no cash identity: the expected drawer is the inherited
	// fund plus the cash collected, the difference is the counted cash against it — a shortage, so
	// it is published with its sign — and what the warehouse takes is the drawer minus the fund,
	// never minus the commission (S8, S9).
	if proposed.ExpectedCash != "96100.00" || proposed.CashDifference == nil ||
		*proposed.CashDifference != "-100.00" || proposed.TakenCash == nil ||
		*proposed.TakenCash != "90000.00" {
		t.Fatalf("the commission must not enter any cash identity: %+v", proposed)
	}
	// The count sheet is frozen while the branch decides, and the drawer of a proposed settlement is
	// the offer the branch is deciding.
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/count", id),
		closingCountBody(sheet)), 409, `{"error":"count_frozen"}`)
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"1.00","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`),
		409, `{"error":"state_conflict"}`)
	// The accepted closure applies the count and publishes the offer the branch accepted.
	closed := closingWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", id), `{"decision":"accepted"}`)), 200)
	if closed.Status != "closed" || closed.ClosedAt == nil || len(closed.Rounds) != 1 ||
		closed.Rounds[0].Decision != "accepted" || closed.Rounds[0].Offer.CommissionAmount != "9600.00" ||
		closed.Rounds[0].Offer.CashSales != "96000.00" || closed.Rounds[0].Offer.CashExpenses != "0.00" ||
		closed.Rounds[0].Offer.SalesTotal != "96000.00" {
		t.Fatalf("the closure must publish the accepted offer: %+v", closed)
	}
	// The settlement leaves the system equal to reality in both directions: the counted quantity is
	// the stock of the branch, including the line that was counted one below the system.
	for _, line := range closed.CountLines[:2] {
		if line.CountedQuantity == nil {
			t.Fatalf("a closed settlement states every counted quantity: %+v", line)
		}
		if existing, reserved := f.stock(t, 2, line.VariantID); existing != *line.CountedQuantity || reserved != 0 {
			t.Fatalf("the closure must apply the counted quantity of variant %d: %d/%d",
				line.VariantID, existing, reserved)
		}
	}
	// The cash ledger of the closure is the warehouse's own: one collection of the 90000.00 the
	// drawer held above the fund it left behind.
	var kind, amount string
	if f.p.QueryRow(f.ctx, `SELECT kind, amount::text FROM branch_cash_movements
 WHERE closing_id=$1 ORDER BY id DESC LIMIT 1`, id).Scan(&kind, &amount) != nil ||
		kind != "recaudacion" || amount != "90000.00" {
		t.Fatalf("the closure must record what it took: %q %q", kind, amount)
	}
}

// TestClosingsListScoping pins the history read over HTTP: a branch lists only its own
// settlements, the warehouse lists any branch, the total is the branch's own and every row is the
// settlement document this contract already publishes, newest cut instant first.
func TestClosingsListScoping(t *testing.T) {
	f := closingFixture(t)
	for _, branch := range []int64{2, 3} {
		if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/branches/%d/commission", branch),
			`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
			t.Fatalf("the rate of branch %d must be configured: %d %s", branch, w.Code, w.Body.String())
		}
	}
	// Branch 2 settles its bootstrap period and then holds a live one, so its history has both
	// states; branch 3 holds a single live settlement.
	first := f.open(t, 2)
	f.countAll(t, first)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", first),
		`{"counted_cash":"0.00","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", first), "")); w.Code != 200 {
		t.Fatalf("the settlement must be proposed: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(2, "POST", fmt.Sprintf("/api/closings/%d/decision", first),
		`{"decision":"accepted"}`)); w.Code != 200 {
		t.Fatalf("the branch must accept its bootstrap period: %d %s", w.Code, w.Body.String())
	}
	second := f.open(t, 2)
	other := f.open(t, 3)

	// The warehouse reads the history of any branch. The rows are newest first and the total is
	// the branch's own.
	page := closingPageWire(t, f.serve(t, f.request(1, "GET",
		"/api/closings?branch_location_id=2", "")), 200)
	if page.TotalClosings != 2 || len(page.Closings) != 2 || page.Page != 1 || page.PageSize != 25 {
		t.Fatalf("the history of branch 2 is not the asked page: %+v", page)
	}
	if page.Closings[0].ID != second || page.Closings[1].ID != first {
		t.Fatalf("the history must be newest first: %d %d", page.Closings[0].ID, page.Closings[1].ID)
	}
	if page.Closings[0].Status != "open" || page.Closings[0].ClosedAt != nil ||
		page.Closings[1].Status != "closed" || page.Closings[1].ClosedAt == nil {
		t.Fatalf("a row must publish its state and its closure: %+v %+v",
			page.Closings[0], page.Closings[1])
	}
	// Every row is the same document projection: the closed one carries the drawer and the
	// reported commission of its period.
	closed := page.Closings[1]
	if closed.BranchLocationID != 2 || closed.ExpectedCash != "0.00" ||
		closed.CountedCash == nil || *closed.CountedCash != "0.00" ||
		closed.CashDifference == nil || *closed.CashDifference != "0.00" ||
		closed.ClosingCash == nil || *closed.ClosingCash != "0.00" ||
		closed.TakenCash == nil || *closed.TakenCash != "0.00" ||
		closed.CommissionAmount != "0.00" || closed.CommissionRatePercent == nil ||
		*closed.CommissionRatePercent != "10.00" || closed.PeriodStart == "" ||
		closed.CutAt == "" {
		t.Fatalf("a row must publish the money of its document: %+v", closed)
	}
	// The rows of another branch are its own: the history is never a listing of every branch.
	otherPage := closingPageWire(t, f.serve(t, f.request(1, "GET",
		"/api/closings?branch_location_id=3", "")), 200)
	if otherPage.TotalClosings != 1 || len(otherPage.Closings) != 1 ||
		otherPage.Closings[0].ID != other {
		t.Fatalf("each branch has its own history: %+v", otherPage)
	}

	// A branch lists only its own settlements, and never another branch's.
	if own := closingPageWire(t, f.serve(t, f.request(2, "GET",
		"/api/closings?branch_location_id=2", "")), 200); own.TotalClosings != 2 {
		t.Fatalf("a branch must read its own history: %+v", own)
	}
	f.refused(t, f.request(2, "GET", "/api/closings?branch_location_id=3", ""), 403,
		`{"error":"forbidden"}`)
	f.refused(t, f.request(3, "GET", "/api/closings?branch_location_id=2", ""), 403,
		`{"error":"forbidden"}`)
	// An unknown branch does not exist, and the page contract is the one of every history.
	f.refused(t, f.request(1, "GET", "/api/closings?branch_location_id=99", ""), 404,
		`{"error":"not_found"}`)
	for _, query := range []string{
		"/api/closings", "/api/closings?", "/api/closings?branch_location_id=1",
		"/api/closings?branch_location_id=02", "/api/closings?branch_location_id=2&page=0",
		"/api/closings?branch_location_id=2&page_size=15",
		"/api/closings?branch_location_id=2&branch_location_id=3",
		"/api/closings?branch_location_id=2&status=closed",
	} {
		f.refused(t, f.request(1, "GET", query, ""), 400, `{"error":"invalid_request"}`)
	}
	// A page beyond the last one is an empty page of the branch total, not an error.
	beyond := closingPageWire(t, f.serve(t, f.request(1, "GET",
		"/api/closings?branch_location_id=2&page=9&page_size=10", "")), 200)
	if beyond.TotalClosings != 2 || len(beyond.Closings) != 0 {
		t.Fatalf("a page beyond the last one must be empty: %+v", beyond)
	}
}

// closingPageWire admits only the frozen history shape: three page keys and the rows.
func closingPageWire(t *testing.T, w *httptest.ResponseRecorder, status int) struct {
	Page          int                 `json:"page"`
	PageSize      int                 `json:"page_size"`
	TotalClosings int64               `json:"total_closings"`
	Closings      []closingWireRecord `json:"closings"`
} {
	t.Helper()
	var page struct {
		Page          int                 `json:"page"`
		PageSize      int                 `json:"page_size"`
		TotalClosings int64               `json:"total_closings"`
		Closings      []closingWireRecord `json:"closings"`
	}
	var value map[string]json.RawMessage
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" ||
		json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatalf("history response mismatch: status=%d want=%d body=%s", w.Code, status, w.Body.String())
	}
	if len(value) != 4 {
		t.Fatalf("history whitelist changed: %s", w.Body.String())
	}
	for _, key := range []string{"page", "page_size", "total_closings", "closings"} {
		if _, ok := value[key]; !ok {
			t.Fatalf("history key %q missing: %s", key, w.Body.String())
		}
	}
	if json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("history is not decodable: %s", w.Body.String())
	}
	return page
}

// TestClosingsCommissionConfiguration pins S6 over HTTP: the percentage is per branch, the
// warehouse writes it, and the value it writes is the canonical one it reads back.
func TestClosingsCommissionConfiguration(t *testing.T) {
	f := closingFixture(t)
	for _, step := range []struct{ body, want string }{
		{`{"commission_rate_percent":"12.50"}`, "12.50"},
		{`{"commission_rate_percent":"0.01"}`, "0.01"},
		{`{"commission_rate_percent":"100.00"}`, "100.00"},
	} {
		w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission", step.body))
		record := struct {
			BranchID int64  `json:"branch_location_id"`
			Rate     string `json:"commission_rate_percent"`
		}{}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &record) != nil || record.BranchID != 2 ||
			record.Rate != step.want {
			t.Fatalf("%s must be configured as %s: %d %s", step.body, step.want, w.Code, w.Body.String())
		}
	}
	// A rate the column cannot hold is refused and changes nothing.
	f.refused(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"100.01"}`), 400, `{"error":"invalid_request"}`)
	f.refused(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"12.5"}`), 400, `{"error":"invalid_request"}`)
	// The warehouse never settles a commission to itself, and the branch never configures one.
	f.refused(t, f.request(1, "POST", "/api/closings/branches/1/commission",
		`{"commission_rate_percent":"10.00"}`), 400, `{"error":"invalid_request"}`)
	f.refused(t, f.request(2, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`), 403, `{"error":"forbidden"}`)
	// A branch without a configured rate has no setting at all.
	f.refused(t, f.request(1, "GET", "/api/closings/branches/3/commission", ""), 404, `{"error":"not_found"}`)
}

// TestClosingsPaginationFreeHistory pins that the settlement of a branch is one document with one
// history: the rounds are numbered by the database and a later proposal never rewrites an earlier
// answer.
func TestClosingsRoundsAreNumbered(t *testing.T) {
	f := closingFixture(t)
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
		t.Fatalf("the rate must be configured: %d %s", w.Code, w.Body.String())
	}
	id := f.open(t, 2)
	f.countAll(t, id)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"0.00","contributed_cash":"0.00","closing_cash":"0.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	for round := 1; round <= 3; round++ {
		proposed := closingWire(t, f.serve(t, f.request(1, "POST",
			fmt.Sprintf("/api/closings/%d/propose", id), "")), 200)
		if len(proposed.Rounds) != round || proposed.Rounds[round-1].Round != round ||
			proposed.Rounds[round-1].Decision != "" {
			t.Fatalf("round %d must be numbered by the database: %+v", round, proposed.Rounds)
		}
		rejected := closingWire(t, f.serve(t, f.request(2, "POST",
			fmt.Sprintf("/api/closings/%d/decision", id), fmt.Sprintf(`{"decision":"rejected","reason":"ronda %d"}`, round))), 200)
		if rejected.Status != "rejected" || len(rejected.Rounds) != round ||
			rejected.Rounds[round-1].DecisionReason != fmt.Sprintf("ronda %d", round) {
			t.Fatalf("round %d must keep its own motive: %+v", round, rejected.Rounds)
		}
	}
	// A closed settlement keeps the whole history readable, oldest first.
	closed := closingWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/closings/%d/propose", id), "")), 200)
	if len(closed.Rounds) != 4 || closed.Rounds[3].Decision != "" {
		t.Fatalf("the fourth round must be the pending one: %+v", closed.Rounds)
	}
	var ids []int64
	for _, round := range closed.Rounds {
		ids = append(ids, round.ID)
	}
	for i := 1; i < len(ids); i++ {
		if ids[i] <= ids[i-1] {
			t.Fatalf("the rounds must be published in the order they were written: %v", ids)
		}
	}
}

// closingExpenseWireRecord is one recorded expense exactly as this contract publishes it: the same
// shape inside the settlement document and in the answer of its own route.
type closingExpenseWireRecord struct {
	ID                 int64  `json:"id"`
	BranchLocationID   int64  `json:"branch_location_id"`
	Amount             string `json:"amount"`
	Description        string `json:"description"`
	OccurredAt         string `json:"occurred_at"`
	CreatedByAccountID int64  `json:"created_by_account_id"`
}

// closingExpenseWire admits only the frozen expense shape: one object with exactly the published
// keys, so a missing or renamed key of a recorded expense is caught.
func closingExpenseWire(t *testing.T, w *httptest.ResponseRecorder, status int) closingExpenseWireRecord {
	t.Helper()
	var value map[string]json.RawMessage
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" ||
		json.Unmarshal(w.Body.Bytes(), &value) != nil {
		t.Fatalf("expense response mismatch: status=%d want=%d body=%s", w.Code, status, w.Body.String())
	}
	for _, key := range []string{"id", "branch_location_id", "amount", "description", "occurred_at",
		"created_by_account_id"} {
		if _, ok := value[key]; !ok {
			t.Fatalf("expense key %q missing: %s", key, w.Body.String())
		}
	}
	if len(value) != 6 {
		t.Fatalf("expense whitelist changed: %s", w.Body.String())
	}
	var record closingExpenseWireRecord
	if json.Unmarshal(w.Body.Bytes(), &record) != nil {
		t.Fatalf("expense is not decodable: %s", w.Body.String())
	}
	return record
}

// TestClosingsExpenses pins S12 over HTTP end to end: the branch records a small expense of its own
// period — amount and description, no previous approval and no settlement to name — the warehouse
// cannot record one, a malformed expense writes nothing, the frozen branch is refused by name, and
// the settlement that covers the expenses publishes them and subtracts their total from the
// expected drawer, while a settlement that does not cover them stays exactly as it was.
func TestClosingsExpenses(t *testing.T) {
	f := closingFixture(t)
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
		t.Fatalf("the rate must be configured: %d %s", w.Code, w.Body.String())
	}
	// The first settlement of the branch closes leaving a fund of 100.00, so the branch operates
	// again and its next period has a window of its own.
	first := f.open(t, 2)
	f.countAll(t, first)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", first),
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)); w.Code != 200 {
		t.Fatalf("the bootstrap drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", first), "")); w.Code != 200 {
		t.Fatalf("the bootstrap settlement must be proposed: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(2, "POST", fmt.Sprintf("/api/closings/%d/decision", first),
		`{"decision":"accepted"}`)); w.Code != 200 {
		t.Fatalf("the branch must accept its bootstrap: %d %s", w.Code, w.Body.String())
	}

	// The branch records its own expense: the amount and the description, and nothing else.
	flete := closingExpenseWire(t, f.serve(t, f.request(2, "POST", "/api/closings/expenses",
		`{"amount":"45.50","description":"Flete"}`)), 201)
	if flete.ID < 1 || flete.BranchLocationID != 2 || flete.Amount != "45.50" ||
		flete.Description != "Flete" || flete.CreatedByAccountID != 2 || flete.OccurredAt == "" {
		t.Fatalf("the recorded expense is not the published contract: %+v", flete)
	}
	insumos := closingExpenseWire(t, f.serve(t, f.request(2, "POST", "/api/closings/expenses",
		`{"amount":"10.00","description":"Insumos"}`)), 201)
	if insumos.ID <= flete.ID || insumos.BranchLocationID != 2 {
		t.Fatalf("every expense is its own movement of the branch's ledger: %+v", insumos)
	}
	// The warehouse records no expense: the till the money comes out of is the branch's own.
	f.refused(t, f.request(1, "POST", "/api/closings/expenses",
		`{"amount":"10.00","description":"Flete del almacén"}`), 403, `{"error":"forbidden"}`)
	// The other branch records its own, which never reads as an expense of this branch.
	other := closingExpenseWire(t, f.serve(t, f.request(3, "POST", "/api/closings/expenses",
		`{"amount":"99.00","description":"Flete de la otra sucursal"}`)), 201)
	if other.BranchLocationID != 3 || other.CreatedByAccountID != 3 {
		t.Fatalf("a branch records only its own expenses: %+v", other)
	}
	// A malformed amount or description is refused and writes nothing anywhere.
	for _, body := range []string{
		`{"amount":"0.00","description":"Flete"}`,
		`{"amount":"45.5","description":"Flete"}`,
		`{"amount":"-45.50","description":"Flete"}`,
		`{"amount":"45.50","description":""}`,
		`{"amount":"45.50","description":"   "}`,
		`{"amount":45.50,"description":"Flete"}`,
		`{"amount":"45.50"}`,
		`{"description":"Flete"}`,
		`{"amount":"45.50","description":"Flete","kind":"recaudacion"}`,
		`{"amount":"45.50","description":"` + strings.Repeat("ñ", closings.MaxDescription+1) + `"}`,
	} {
		f.refused(t, f.request(2, "POST", "/api/closings/expenses", body), 400,
			`{"error":"invalid_request"}`)
	}

	// The settlement that covers the two expenses of this branch publishes them, so the warehouse
	// sees what it is subtracting and the branch what it is being charged for. The total is the
	// offer's and is still unfrozen while the warehouse holds the settlement.
	id := f.open(t, 2)
	document := closingWire(t, f.serve(t, f.request(1, "GET",
		fmt.Sprintf("/api/closings/%d", id), "")), 200)
	if len(document.Expenses) != 2 || document.Expenses[0].ID != flete.ID ||
		document.Expenses[0].Amount != "45.50" || document.Expenses[0].Description != "Flete" ||
		document.Expenses[1].ID != insumos.ID || document.Expenses[1].Amount != "10.00" ||
		document.Expenses[0].BranchLocationID != 2 || document.Expenses[0].OccurredAt == "" {
		t.Fatalf("the document must list the expenses of its window: %+v", document.Expenses)
	}
	if document.CashExpenses != "0.00" {
		t.Fatalf("a held settlement states no period total yet: %q", document.CashExpenses)
	}
	// A history row publishes the expenses as an empty list, exactly like the sheet and the rounds.
	page := closingPageWire(t, f.serve(t, f.request(2, "GET",
		"/api/closings?branch_location_id=2", "")), 200)
	if page.Closings[0].ID != id || len(page.Closings[0].Expenses) != 0 {
		t.Fatalf("a history row must not unfold the document: %+v", page.Closings[0].Expenses)
	}

	// The branch is frozen now: the same expense is refused by name and writes nothing.
	f.refused(t, f.request(2, "POST", "/api/closings/expenses",
		`{"amount":"5.00","description":"Agua"}`), 409, `{"error":"branch_frozen"}`)

	// The offer freezes the total of the listed expenses and subtracts it from the expected
	// drawer: 100.00 inherited minus 55.50 paid out is the 44.50 the branch hand counted.
	f.countAll(t, id)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"44.50","contributed_cash":"0.00","closing_cash":"10.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	proposed := closingWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/closings/%d/propose", id), "")), 200)
	if proposed.CashExpenses != "55.50" || proposed.ExpectedCash != "44.50" ||
		proposed.CashDifference == nil || *proposed.CashDifference != "0.00" ||
		proposed.TakenCash == nil || *proposed.TakenCash != "34.50" || len(proposed.Expenses) != 2 {
		t.Fatalf("the offer must freeze and subtract the expense it lists: %+v", proposed)
	}
	// The closure keeps the expenses it settled, and the settlement that does not cover them is
	// exactly as it was: an expense belongs to the window that covers it and to nothing else.
	closed := closingWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", id), `{"decision":"accepted"}`)), 200)
	if closed.Status != "closed" || closed.CashExpenses != "55.50" || len(closed.Expenses) != 2 ||
		closed.ExpectedCash != "44.50" {
		t.Fatalf("the closure must publish the expenses it settled: %+v", closed)
	}
	earlier := closingWire(t, f.serve(t, f.request(1, "GET",
		fmt.Sprintf("/api/closings/%d", first), "")), 200)
	if earlier.CashExpenses != "0.00" || earlier.ExpectedCash != "0.00" ||
		earlier.CashDifference == nil || *earlier.CashDifference != "0.00" ||
		len(earlier.Expenses) != 0 {
		t.Fatalf("an expense must not move a settlement that does not cover it: %+v", earlier)
	}
}

// closingAwaitsTableLock waits until a statement of this database is waiting for a table lock,
// which is how the proposal race below is armed without a sleep: a proposal that still waits for
// the sale ledger of the period has already read the count sheet and has not yet reached the
// database's transition.
func (f *closingHTTPFixture) closingAwaitsTableLock(t *testing.T, table string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int64
		if err := f.p.QueryRow(f.ctx, `SELECT count(*) FROM pg_locks
 WHERE relation=$1::regclass AND NOT granted`, table).Scan(&waiting); err != nil {
			t.Fatalf("the waiting lock could not be read: %v", err)
		}
		if waiting > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no statement ever waited for the %s table", table)
}

// closingReserveStock promises units of one variant of a branch to a transfer and leaves the
// reservation open: the branch sends the units back to the warehouse, the warehouse approves, and
// the reservation is the transfer's own (S3, LC007).
func (f *closingHTTPFixture) closingReserveStock(t *testing.T, branch, variant, quantity int64) {
	t.Helper()
	promises := transfers.New(f.p)
	created, err := promises.Create(f.ctx,
		auth.Identity{AccountID: int(branch), Location: auth.Location{ID: int(branch)}},
		transfers.CreateInput{Kind: transfers.SendToWarehouse, CounterpartyID: 1,
			RetryKey: testpg.Random(t)[:24], Items: []transfers.Line{{VariantID: variant, Quantity: quantity}}})
	if err != nil {
		t.Fatalf("the transfer reservation could not be created: %v", err)
	}
	if _, err := promises.Approve(f.ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
		created.Request.ID); err != nil {
		t.Fatalf("the transfer reservation could not be approved: %v", err)
	}
}

// TestClosingsClosureConflictsNameTheBlockedStock pins S5 over HTTP: a closure refused by a variant
// that moved during the settlement and a closure refused by a reservation the branch still owes are
// both conflicts that name the variant, never an outage, and neither of them applies anything.
func TestClosingsClosureConflictsNameTheBlockedStock(t *testing.T) {
	f := closingFixture(t)
	for _, branch := range []int64{2, 3} {
		if w := f.serve(t, f.request(1, "POST",
			fmt.Sprintf("/api/closings/branches/%d/commission", branch),
			`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
			t.Fatalf("the rate of branch %d must be configured: %d %s", branch, w.Code, w.Body.String())
		}
	}

	// A variant moved during the settlement: the photographed count is stale, so it is refused by
	// naming the variant instead of being applied. The freeze guards refuse every branch operation
	// while the settlement is open, so this is the state a bypassed guard leaves.
	moved := f.open(t, 2)
	f.countAll(t, moved)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", moved),
		`{"counted_cash":"100.00","contributed_cash":"0.00","closing_cash":"20.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", moved), "")); w.Code != 200 {
		t.Fatalf("the settlement must be proposed: %d %s", w.Code, w.Body.String())
	}
	if _, err := f.p.Exec(f.ctx, `UPDATE inventory_balances SET existing=existing+1
 WHERE location_id=2 AND variant_id=2`); err != nil {
		t.Fatal("the branch stock could not be moved behind the settlement")
	}
	before := f.snapshot(t)
	closingFailureBody(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", moved), `{"decision":"accepted"}`)), 409,
		`{"error":"stock_moved","variant_id":2}`)
	if f.snapshot(t) != before {
		t.Fatal("a closure refused by a moved variant changed stored state")
	}
	if existing, _ := f.stock(t, 2, 2); existing != f.expectedStock(t, moved, 2)+1 {
		t.Fatalf("a refused closure must not apply the count: variant 2 is %d", existing)
	}
	// Restoring the photographed quantity closes the same settlement: the refusal was the stale
	// count and not a broken document.
	if _, err := f.p.Exec(f.ctx, `UPDATE inventory_balances SET existing=existing-1
 WHERE location_id=2 AND variant_id=2`); err != nil {
		t.Fatal("the branch stock could not be restored")
	}
	closed := closingWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/closings/%d/decision", moved), `{"decision":"accepted"}`)), 200)
	if closed.Status != "closed" {
		t.Fatalf("a restored branch must close: %+v", closed)
	}

	// A reservation the branch still owes blocks the other closure even when the count covers it:
	// the refusal names the variant, and the unit the branch promised stays reserved.
	f.closingReserveStock(t, 3, 1, 2)
	reserved := f.open(t, 3)
	f.countAll(t, reserved)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", reserved),
		`{"counted_cash":"100.00","contributed_cash":"0.00","closing_cash":"20.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", reserved), "")); w.Code != 200 {
		t.Fatalf("the settlement must be proposed: %d %s", w.Code, w.Body.String())
	}
	before = f.snapshot(t)
	closingFailureBody(t, f.serve(t, f.request(3, "POST",
		fmt.Sprintf("/api/closings/%d/decision", reserved), `{"decision":"accepted"}`)), 409,
		`{"error":"reserved_stock","variant_id":1}`)
	if f.snapshot(t) != before {
		t.Fatal("a closure refused by a reservation changed stored state")
	}
	if existing, held := f.stock(t, 3, 1); existing != f.expectedStock(t, reserved, 1) || held != 2 {
		t.Fatalf("a refused closure must keep the reservation: %d/%d", existing, held)
	}
}

// TestClosingsProposalRaceIsAConflict pins LC019 over HTTP: the count sheet can stop being complete
// between the store's own check of the proposal and the database's transition, and the answer is a
// conflict that names the variant, never a 503 that would hide a readable document.
func TestClosingsProposalRaceIsAConflict(t *testing.T) {
	f := closingFixture(t)
	if w := f.serve(t, f.request(1, "POST", "/api/closings/branches/2/commission",
		`{"commission_rate_percent":"10.00"}`)); w.Code != 200 {
		t.Fatalf("the rate must be configured: %d %s", w.Code, w.Body.String())
	}
	id := f.open(t, 2)
	f.countAll(t, id)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/cash", id),
		`{"counted_cash":"100.00","contributed_cash":"0.00","closing_cash":"20.00","observation":""}`)); w.Code != 200 {
		t.Fatalf("the drawer must be drafted: %d %s", w.Code, w.Body.String())
	}
	// The rounds of the settlement are held, so the proposal stops after its last read of the
	// count sheet and before the database's transition.
	blocker, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatalf("the blocking transaction could not start: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(f.ctx, "LOCK TABLE closing_proposals IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatalf("the proposal rounds could not be held: %v", err)
	}
	request := f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), "")
	recorder := httptest.NewRecorder()
	served := make(chan struct{})
	go func() {
		f.handler.ServeHTTP(recorder, request)
		close(served)
	}()
	f.closingAwaitsTableLock(t, "closing_proposals")
	if _, err := f.p.Exec(f.ctx, `UPDATE closing_count_lines SET counted_quantity=NULL
 WHERE closing_id=$1 AND variant_id=2`, id); err != nil {
		t.Fatalf("the counted line could not be made pending again: %v", err)
	}
	if err := blocker.Commit(f.ctx); err != nil {
		t.Fatalf("the proposal rounds could not be released: %v", err)
	}
	<-served
	if recorder.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("the raced proposal must answer JSON: %v", recorder.Header())
	}
	closingFailureBody(t, recorder, 409, `{"error":"proposal_stale","variant_id":2}`)
	// No round was written and the settlement is still open: the warehouse counts the line again
	// and proposes the very same settlement.
	var rounds int
	var status string
	if err := f.p.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM closing_proposals WHERE closing_id=$1),
 status FROM branch_closings WHERE id=$1`, id).Scan(&rounds, &status); err != nil {
		t.Fatal("the settlement state could not be read")
	}
	if rounds != 0 || status != "open" {
		t.Fatalf("a refused proposal must write nothing: %d rounds in %q", rounds, status)
	}
	f.countAll(t, id)
	if w := f.serve(t, f.request(1, "POST", fmt.Sprintf("/api/closings/%d/propose", id), "")); w.Code != 200 {
		t.Fatalf("the settlement must be proposable again: %d %s", w.Code, w.Body.String())
	}
}
