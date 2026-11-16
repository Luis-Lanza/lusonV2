package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
)

// The metrics contract publishes one period of the actor's own branch. The tests below prove the
// frozen shape of that answer, the selector it offers, and that every refusal is the contract's own
// token: a request this domain never wrote is a request error, and a value the encoder could not
// have produced fails closed instead of reaching the screen.

// metricsWireKeys is the frozen key set of the answer, and the key sets of the objects it carries.
var (
	metricsWireKeys          = []string{"periods", "period", "source", "sales", "cash", "fund", "materials", "top_models", "stock", "today"}
	metricsSalesWireKeys     = []string{"total", "cash", "card", "transfer", "qr", "commission", "sales", "units"}
	metricsCashWireKeys      = []string{"opening", "sales", "expenses", "expected", "counted", "difference"}
	metricsFundWireKeys      = []string{"opening", "purchases", "expected", "counted", "difference", "replacement"}
	metricsMaterialsWireKeys = []string{"used_units", "used_delivered_units", "scrap_milli", "scrap_delivered_milli", "materials"}
	metricsMaterialWireKeys  = []string{"material_id", "material", "bought_milli", "delivered_milli"}
	metricsModelWireKeys     = []string{"catalog_entry_id", "brand", "model", "capacity_ah", "units", "money"}
	metricsStockWireKeys     = []string{"units"}
	metricsTodayWireKeys     = []string{"since", "opening", "sales", "expenses", "expected", "movements"}
	metricsMovementWireKeys  = []string{"kind", "amount", "occurred_at"}
	metricsPeriodWireKeys    = []string{"kind", "closing_id", "from", "to", "label"}
	// metricsMoneyWire is the strict money parser a client applies to this answer (S8): canonical
	// two-decimal text, signed only where the contract states a difference.
	metricsMoneyWire = regexp.MustCompile(`^-?\d{1,10}\.[0-9]{2}$`)
)

// metricsHTTPFixture mounts the metrics contract on the settlement chain the server composes, so a
// test drives the handler the branch actually reaches instead of a route of its own.
type metricsHTTPFixture struct {
	*closingHTTPFixture
	metrics http.Handler
}

// metricsFixture needs the isolated test PostgreSQL, admitted by testpg.Open inside closingFixture.
func metricsFixture(t *testing.T) *metricsHTTPFixture {
	t.Helper()
	f := &metricsHTTPFixture{closingHTTPFixture: closingFixture(t)}
	service, err := auth.New(f.p, nil)
	if err != nil {
		t.Fatal("metrics HTTP auth fixture failed")
	}
	f.metrics, err = NewWithMetrics(f.handler, service, f.cfg, purchases.New(f.p), closings.New(f.p))
	if err != nil {
		t.Fatalf("the metrics constructor is unavailable: %v", err)
	}
	return f
}

// serve drives one request through the metrics wrapper, so the response headers of the composed
// chain are proven on every answer.
func (f *metricsHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.metrics.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" ||
		w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("the metrics wrapper must keep the response headers")
	}
	return w
}

// metricsObject admits one JSON object of the answer with exactly the published keys.
func metricsObject(t *testing.T, raw json.RawMessage, keys []string) map[string]json.RawMessage {
	t.Helper()
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		t.Fatalf("the object is not decodable: %s", raw)
	}
	if len(object) != len(keys) {
		t.Fatalf("the published key set changed: %s", raw)
	}
	for _, key := range keys {
		if _, ok := object[key]; !ok {
			t.Fatalf("key %q is missing from the answer: %s", key, raw)
		}
	}
	return object
}

type metricsPeriodWire struct {
	Kind      string  `json:"kind"`
	ClosingID *int64  `json:"closing_id"`
	From      *string `json:"from"`
	To        *string `json:"to"`
	Label     string  `json:"label"`
}

type metricsAnswerWire struct {
	Periods []metricsPeriodWire `json:"periods"`
	Period  metricsPeriodWire   `json:"period"`
	Source  string              `json:"source"`
	Sales   struct {
		Total      string `json:"total"`
		Cash       string `json:"cash"`
		Card       string `json:"card"`
		Transfer   string `json:"transfer"`
		QR         string `json:"qr"`
		Commission string `json:"commission"`
		Sales      int64  `json:"sales"`
		Units      int64  `json:"units"`
	} `json:"sales"`
	Cash *struct {
		Opening    string  `json:"opening"`
		Sales      string  `json:"sales"`
		Expenses   string  `json:"expenses"`
		Expected   string  `json:"expected"`
		Counted    *string `json:"counted"`
		Difference *string `json:"difference"`
	} `json:"cash"`
	Fund *struct {
		Opening     string  `json:"opening"`
		Purchases   string  `json:"purchases"`
		Expected    string  `json:"expected"`
		Counted     *string `json:"counted"`
		Difference  *string `json:"difference"`
		Replacement *string `json:"replacement"`
	} `json:"fund"`
	Materials *struct {
		Used           int64  `json:"used_units"`
		UsedDelivered  *int64 `json:"used_delivered_units"`
		Scrap          int64  `json:"scrap_milli"`
		ScrapDelivered *int64 `json:"scrap_delivered_milli"`
		Materials      []struct {
			MaterialID int64  `json:"material_id"`
			Material   string `json:"material"`
			Bought     int64  `json:"bought_milli"`
			Delivered  *int64 `json:"delivered_milli"`
		} `json:"materials"`
	} `json:"materials"`
	Top []struct {
		CatalogEntryID int64  `json:"catalog_entry_id"`
		Brand          string `json:"brand"`
		Model          string `json:"model"`
		Capacity       string `json:"capacity_ah"`
		Units          int64  `json:"units"`
		Money          string `json:"money"`
	} `json:"top_models"`
	Stock struct {
		Units int64 `json:"units"`
	} `json:"stock"`
	Today struct {
		Since     *string `json:"since"`
		Opening   string  `json:"opening"`
		Sales     string  `json:"sales"`
		Expenses  string  `json:"expenses"`
		Expected  string  `json:"expected"`
		Movements []struct {
			Kind       string `json:"kind"`
			Amount     string `json:"amount"`
			OccurredAt string `json:"occurred_at"`
		} `json:"movements"`
	} `json:"today"`
}

// metricsAnswer admits only the frozen metrics shape: exactly the published keys at every level, and
// every money as the canonical text a client parses strictly. A missing or renamed key is caught here
// instead of in the screen.
func metricsAnswer(t *testing.T, w *httptest.ResponseRecorder, status int) metricsAnswerWire {
	t.Helper()
	if w.Code != status || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("metrics response mismatch: status=%d want=%d body=%s", w.Code, status, w.Body.String())
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &root) != nil {
		t.Fatalf("metrics answer is not decodable: %s", w.Body.String())
	}
	metricsObject(t, w.Body.Bytes(), metricsWireKeys)
	metricsObject(t, root["sales"], metricsSalesWireKeys)
	if string(root["cash"]) != "null" {
		metricsObject(t, root["cash"], metricsCashWireKeys)
	}
	if string(root["fund"]) != "null" {
		metricsObject(t, root["fund"], metricsFundWireKeys)
	}
	if string(root["materials"]) != "null" {
		materials := metricsObject(t, root["materials"], metricsMaterialsWireKeys)
		var lines []json.RawMessage
		if json.Unmarshal(materials["materials"], &lines) != nil || lines == nil {
			t.Fatalf("the material sheet must be a list and never null: %s", w.Body.String())
		}
		for _, line := range lines {
			metricsObject(t, line, metricsMaterialWireKeys)
		}
	}
	metricsObject(t, root["stock"], metricsStockWireKeys)
	var top []json.RawMessage
	if json.Unmarshal(root["top_models"], &top) != nil || top == nil {
		t.Fatalf("the ranking must be a list and never null: %s", w.Body.String())
	}
	for _, row := range top {
		metricsObject(t, row, metricsModelWireKeys)
	}
	var periods []json.RawMessage
	if json.Unmarshal(root["periods"], &periods) != nil || len(periods) == 0 {
		t.Fatalf("the selector must be a non-empty list: %s", w.Body.String())
	}
	for _, entry := range periods {
		metricsObject(t, entry, metricsPeriodWireKeys)
	}
	metricsObject(t, root["period"], metricsPeriodWireKeys)

	var answer metricsAnswerWire
	if json.Unmarshal(w.Body.Bytes(), &answer) != nil {
		t.Fatalf("metrics answer is not decodable: %s", w.Body.String())
	}
	for _, money := range []string{answer.Sales.Total, answer.Sales.Cash, answer.Sales.Card,
		answer.Sales.Transfer, answer.Sales.QR, answer.Sales.Commission} {
		if !metricsMoneyWire.MatchString(money) {
			t.Fatalf("sales money %q is not canonical: %s", money, w.Body.String())
		}
	}
	if answer.Cash != nil {
		for _, money := range []string{answer.Cash.Opening, answer.Cash.Sales, answer.Cash.Expenses,
			answer.Cash.Expected} {
			if !metricsMoneyWire.MatchString(money) {
				t.Fatalf("cash money %q is not canonical: %s", money, w.Body.String())
			}
		}
		for _, money := range []*string{answer.Cash.Counted, answer.Cash.Difference} {
			if money != nil && !metricsMoneyWire.MatchString(*money) {
				t.Fatalf("cash money %q is not canonical: %s", *money, w.Body.String())
			}
		}
	}
	if answer.Fund != nil {
		for _, money := range []string{answer.Fund.Opening, answer.Fund.Purchases,
			answer.Fund.Expected} {
			if !metricsMoneyWire.MatchString(money) {
				t.Fatalf("fund money %q is not canonical: %s", money, w.Body.String())
			}
		}
		for _, money := range []*string{answer.Fund.Counted, answer.Fund.Difference,
			answer.Fund.Replacement} {
			if money != nil && !metricsMoneyWire.MatchString(*money) {
				t.Fatalf("fund money %q is not canonical: %s", *money, w.Body.String())
			}
		}
	}
	for _, row := range answer.Top {
		if !metricsMoneyWire.MatchString(row.Money) {
			t.Fatalf("ranking money %q is not canonical: %s", row.Money, w.Body.String())
		}
	}
	// The drawer of today is published by every source and carries no null block: its cut is the one
	// field that may be null, and every movement states a kind, an amount and a moment.
	today := metricsObject(t, root["today"], metricsTodayWireKeys)
	var movements []json.RawMessage
	if json.Unmarshal(today["movements"], &movements) != nil || movements == nil {
		t.Fatalf("the movements of today must be a list and never null: %s", w.Body.String())
	}
	for _, movement := range movements {
		metricsObject(t, movement, metricsMovementWireKeys)
	}
	for _, money := range []string{answer.Today.Opening, answer.Today.Sales, answer.Today.Expenses,
		answer.Today.Expected} {
		if !metricsMoneyWire.MatchString(money) {
			t.Fatalf("today money %q is not canonical: %s", money, w.Body.String())
		}
	}
	if answer.Today.Since != nil {
		if _, err := time.Parse(time.RFC3339, *answer.Today.Since); err != nil {
			t.Fatalf("the cut of today must be an RFC3339 instant: %q", *answer.Today.Since)
		}
	}
	for _, movement := range answer.Today.Movements {
		if !metricsMoneyWire.MatchString(movement.Amount) {
			t.Fatalf("movement money %q is not canonical: %s", movement.Amount, w.Body.String())
		}
		if _, err := time.Parse(time.RFC3339, movement.OccurredAt); err != nil {
			t.Fatalf("a movement states its moment as an RFC3339 instant: %q", movement.OccurredAt)
		}
	}
	if answer.Stock.Units < 0 || answer.Sales.Sales < 0 || answer.Sales.Units < 0 {
		t.Fatalf("the answer publishes a negative count: %s", w.Body.String())
	}
	return answer
}

// TestMetricsHTTPAnswer proves the answer of one closed period, of the period in progress and of the
// whole history: the selector excludes the pending balance, the nulls are the ones the contract
// explains, and every money is canonical text.
func TestMetricsHTTPAnswer(t *testing.T) {
	f := metricsFixture(t)
	closed := f.closeSettlement(t, 3, `{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","purchase_fund_counted":"50.00","purchase_fund_cash":"50.00","observation":"arranque"}`)

	answer := metricsAnswer(t, f.serve(t, f.request(3, "GET",
		fmt.Sprintf("/api/metrics?period=%d", closed.ID), "")), 200)
	if answer.Source != "settlement" {
		t.Fatalf("a closed settlement states its own origin, got %q", answer.Source)
	}
	// The selector offers the closed settlement and the whole history: the pending balance is not a
	// period, so it is not offered here at all.
	if len(answer.Periods) != 2 || answer.Periods[0].Kind != "settlement" ||
		answer.Periods[0].ClosingID == nil || *answer.Periods[0].ClosingID != closed.ID ||
		answer.Periods[0].From == nil || answer.Periods[0].To == nil ||
		answer.Periods[1].Kind != "all" || answer.Periods[1].ClosingID != nil ||
		answer.Periods[1].From != nil || answer.Periods[1].To != nil {
		t.Fatalf("the selector must publish the settlement and the history: %+v", answer.Periods)
	}
	if answer.Period.Kind != "settlement" || answer.Period.ClosingID == nil ||
		*answer.Period.ClosingID != closed.ID || answer.Period.Label == "" {
		t.Fatalf("the chosen period must be one the selector offers: %+v answer=%+v",
			answer.Period, answer.Periods)
	}
	// The period of the settlement sold nothing and bought nothing: zero is a fact, and the ranking
	// and the material sheet are empty lists instead of nulls.
	if answer.Sales.Total != "0.00" || answer.Sales.Sales != 0 || answer.Sales.Units != 0 ||
		len(answer.Top) != 0 {
		t.Fatalf("the closed period states its own volume: %+v", answer.Sales)
	}
	if answer.Cash == nil || answer.Cash.Counted == nil || *answer.Cash.Counted != "0.00" ||
		answer.Cash.Difference == nil || *answer.Cash.Difference != "0.00" ||
		answer.Cash.Sales != "0.00" || answer.Cash.Sales != answer.Sales.Cash {
		t.Fatalf("the closed drawer is the counted one: %+v", answer.Cash)
	}
	if answer.Fund == nil || answer.Fund.Counted == nil || *answer.Fund.Counted != "50.00" ||
		answer.Fund.Replacement == nil || *answer.Fund.Replacement != "50.00" {
		t.Fatalf("the closed envelope states the replacement of its closure: %+v", answer.Fund)
	}
	if answer.Materials == nil || answer.Materials.Used != 0 || answer.Materials.Scrap != 0 ||
		answer.Materials.Materials == nil || len(answer.Materials.Materials) != 0 {
		t.Fatalf("a period without material states an empty sheet: %+v", answer.Materials)
	}
	if answer.Stock.Units < 0 {
		t.Fatalf("the shelf of the branch is a count: %+v", answer.Stock)
	}

	// The whole history publishes the sales, the ranking and the shelf, and states no drawer, no
	// envelope and no material: a drawer is closed in each settlement and does not accumulate (S9).
	history := metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period=all", "")), 200)
	if history.Source != "history" {
		t.Fatalf("the whole history states its own origin, got %q", history.Source)
	}
	if history.Cash != nil || history.Fund != nil || history.Materials != nil {
		t.Fatalf("the history states no drawer, no envelope and no material: %+v", history)
	}
	if history.Period.Kind != "all" || history.Period.ClosingID != nil ||
		len(history.Periods) != 2 || history.Periods[1].Kind != "all" {
		t.Fatalf("the history is the last entry of the selector: %+v", history.Periods)
	}

	// The period in progress is offered by its own closing id, and states no count of anything.
	live := f.open(t, 2)
	answer = metricsAnswer(t, f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/metrics?period=%d", live), "")), 200)
	if answer.Source != "live" {
		t.Fatalf("the period in progress states its own origin, got %q", answer.Source)
	}
	if answer.Period.Kind != "open" || answer.Period.ClosingID == nil ||
		*answer.Period.ClosingID != live {
		t.Fatalf("the live period must be the chosen one: %+v", answer.Period)
	}
	if answer.Cash == nil || answer.Cash.Counted != nil || answer.Cash.Difference != nil {
		t.Fatalf("an uncounted drawer states no count and no difference: %+v", answer.Cash)
	}
	if answer.Fund == nil || answer.Fund.Counted != nil || answer.Fund.Difference != nil ||
		answer.Fund.Replacement != nil {
		t.Fatalf("an uncounted envelope states no count and no replacement: %+v", answer.Fund)
	}
	// The selector of this branch offers the live period it is inside and then the whole history:
	// the pending balance is never an entry, and the history always closes the list.
	if len(answer.Periods) != 2 || answer.Periods[0].Kind != "open" ||
		answer.Periods[1].Kind != "all" {
		t.Fatalf("the selector must publish the live period and the history: %+v", answer.Periods)
	}
}

// TestMetricsHTTPRefusals proves every refusal of the read is the contract's own token and that a
// refused read leaves the answer of the branch exactly as it was: the selector is not a period, an
// unknown token is not a default, and a repeated or foreign key is not the first one that fits.
func TestMetricsHTTPRefusals(t *testing.T) {
	f := metricsFixture(t)
	closed := f.closeSettlement(t, 3, `{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"arranque"}`)
	target := fmt.Sprintf("/api/metrics?period=%d", closed.ID)
	before := f.serve(t, f.request(3, "GET", target, "")).Body.String()
	for name, query := range map[string]string{
		"pending":         "period=pending",
		"unknown token":   "period=month",
		"padded id":       "period=0" + fmt.Sprint(closed.ID),
		"zero id":         "period=0",
		"empty value":     "period=",
		"bare separator":  "period=all&",
		"foreign key":     "period=all&page=1",
		"foreign alone":   "page=1",
		"duplicate key":   "period=all&period=all",
		"duplicate id":    fmt.Sprintf("period=%d&period=%d", closed.ID, closed.ID),
		"unknown closing": "period=9999",
	} {
		w := f.serve(t, f.request(3, "GET", "/api/metrics?"+query, ""))
		if w.Code != 400 || w.Body.String() != "{\"error\":\"invalid_request\"}\n" {
			t.Fatalf("%s must be an invalid request, got %d %s", name, w.Code, w.Body.String())
		}
	}
	// Only one method is admitted, and the refusal advertises it.
	for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		w := f.serve(t, f.request(3, verb, "/api/metrics", `{}`))
		if w.Code != 405 || w.Header().Get("Allow") != "GET" ||
			w.Body.String() != "{\"error\":\"method_not_allowed\"}\n" {
			t.Fatalf("%s must be refused with the allowed method, got %d %s", verb, w.Code,
				w.Body.String())
		}
	}
	// The route is a session's own read: no cookie is unauthenticated, never an anonymous answer.
	w := f.serve(t, f.request(0, "GET", target, ""))
	if w.Code != 401 || w.Body.String() != "{\"error\":\"unauthenticated\"}\n" {
		t.Fatalf("the read must require a session, got %d %s", w.Code, w.Body.String())
	}
	// A session of one branch never reads another branch's period: the closing of branch 3 is not
	// found for branch 2, exactly like its settlements.
	w = f.serve(t, f.request(2, "GET", target, ""))
	if w.Code != 400 || w.Body.String() != "{\"error\":\"invalid_request\"}\n" {
		t.Fatalf("a settlement of another branch is not a period, got %d %s", w.Code, w.Body.String())
	}
	// The warehouse settles branches and owns no drawer, so it has no metrics of its own.
	w = f.serve(t, f.request(1, "GET", target, ""))
	if w.Code != 403 || w.Body.String() != "{\"error\":\"forbidden\"}\n" {
		t.Fatalf("the warehouse has no metrics, got %d %s", w.Code, w.Body.String())
	}
	// Nothing the refused reads asked for changed the answer of the branch.
	if after := f.serve(t, f.request(3, "GET", target, "")).Body.String(); after != before {
		t.Fatalf("a refused read changed the answer: %s want %s", after, before)
	}
}

// TestMetricsConstructor proves the wrapper keeps the shape of every other factory: a missing
// dependency is refused, an invalid configuration is refused, the route is added without touching
// the composed handler, and every other request is forwarded unchanged.
func TestMetricsConstructor(t *testing.T) {
	cfg := transferConfig(t)
	purchaseStore, closingStore := purchases.New(&pgxpool.Pool{}), closings.New(&pgxpool.Pool{})
	base := &saleRecorder{}
	for name, build := range map[string]func() (http.Handler, error){
		"nil base": func() (http.Handler, error) {
			return NewWithMetrics(nil, &auth.Service{}, cfg, purchaseStore, closingStore)
		},
		"nil service": func() (http.Handler, error) {
			return NewWithMetrics(base, nil, cfg, purchaseStore, closingStore)
		},
		"nil purchase store": func() (http.Handler, error) {
			return NewWithMetrics(base, &auth.Service{}, cfg, nil, closingStore)
		},
		"nil closing store": func() (http.Handler, error) {
			return NewWithMetrics(base, &auth.Service{}, cfg, purchaseStore, nil)
		},
		"invalid configuration": func() (http.Handler, error) {
			return NewWithMetrics(base, &auth.Service{}, config.Auth{}, purchaseStore, closingStore)
		},
	} {
		if handler, err := build(); err == nil || handler != nil {
			t.Fatalf("%s must be refused, got %v", name, err)
		}
	}
	handler, err := NewWithMetrics(base, &auth.Service{}, cfg, purchaseStore, closingStore)
	if err != nil || handler == nil {
		t.Fatalf("the metrics constructor is unavailable: %v", err)
	}
	// Every other request is forwarded to the composed handler unchanged.
	for _, target := range []string{"/api/sales", "/api/inventory", "/api/auth/session",
		"/api/metrics/1", "/api/metrics/"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent || base.path != target {
			t.Fatalf("%s must be forwarded to the composed handler", target)
		}
	}
	// The route is the session's own read even before a store can answer one.
	for _, tc := range []struct {
		method, target string
		status         int
		code           string
	}{
		{"GET", "/api/metrics", 401, "unauthenticated"},
		{"POST", "/api/metrics", 405, "method_not_allowed"},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.target, nil))
		expectTransferError(t, w, tc.status, tc.code)
	}
}

// metricsPeriodList is one selector exactly as the branch's own history produces it: the pending
// balance, the closed settlement newest first, the live period and the whole history.
func metricsPeriodList() ([]purchases.Period, purchases.Period) {
	from := time.Date(2024, 11, 1, 12, 0, 0, 0, time.UTC)
	cut := time.Date(2024, 11, 12, 12, 0, 0, 0, time.UTC)
	liveFrom := cut
	liveCut := time.Date(2024, 11, 20, 12, 0, 0, 0, time.UTC)
	closedID, liveID := int64(3), int64(4)
	period := purchases.Period{Kind: purchases.PeriodSettlement, ClosingID: &closedID,
		From: &from, To: &cut, Label: "Rendición #3"}
	return []purchases.Period{
		{Kind: purchases.PeriodPending, Label: "Pendiente"},
		period,
		{Kind: purchases.PeriodOpen, ClosingID: &liveID, From: &liveFrom, To: &liveCut,
			Label: "En curso"},
		{Kind: purchases.PeriodAll, Label: "Todo el historial"},
	}, period
}

// validMetrics is one answer the read can produce, so a test can break exactly one thing of it.
func validMetrics() closings.Metrics {
	expected, counted := closings.Signed("10.00"), closings.Money("10.00")
	replacement := closings.Money("5.00")
	usedDelivered, scrapDelivered, delivered := int64(2), int64(1000), int64(1000)
	return closings.Metrics{
		Source: "settlement",
		Sales: closings.MetricsSales{Total: "10.00", Cash: "10.00", Card: "0.00",
			Transfer: "0.00", QR: "0.00", Commission: "1.00", Sales: 1, Units: 2},
		Cash: &closings.MetricsCash{Opening: "0.00", Sales: "10.00", Expenses: "0.00",
			Expected: expected, Counted: &counted, Difference: &expected},
		Fund: &closings.MetricsFund{Opening: "0.00", Purchases: "0.00", Expected: expected,
			Replacement: &replacement},
		Materials: &closings.MetricsMaterials{Used: 2, UsedDelivered: &usedDelivered, Scrap: 1000,
			ScrapDelivered: &scrapDelivered, Materials: []closings.MetricsMaterial{{MaterialID: 1,
				Material: "Cobre", Bought: 1000, Delivered: &delivered}}},
		Top: []closings.MetricsModel{{CatalogEntryID: 1, Brand: "CAR", Model: "NS40ZL",
			Capacity: "35", Units: 2, Money: "10.00"}},
		Stock: closings.MetricsStock{Units: 5},
		// The drawer of today: what the last cut left, the cash collected after it and the expense
		// paid out of it -- 5.00 + 10.00 − 2.00 = 13.00 -- with one ledger row of the window beside
		// them. A branch without a closed settlement states no cut, which is the null this pins.
		Today: closings.MetricsToday{Opening: "5.00", Sales: "10.00", Expenses: "2.00",
			Expected: "13.00", Movements: []closings.MetricsMovement{
				{Kind: "gasto", Amount: "2.00", OccurredAt: metricsTodayMoment()}}},
	}
}

// metricsTodayMoment is the instant the drawer of today of the fixture answers starts at.
func metricsTodayMoment() time.Time { return time.Date(2024, 11, 12, 12, 0, 0, 0, time.UTC) }

// TestMetricsRecordsRefuseAShapeTheServerNeverWrote proves the contract fails closed on the values
// only a bug could produce: the read is admitted by its own guards, and the failure is published as
// the contract's own 503 instead of an encoder error or a shape the screen cannot parse (S8).
func TestMetricsRecordsRefuseAShapeTheServerNeverWrote(t *testing.T) {
	periods, chosen := metricsPeriodList()
	published, err := metricsPeriodsRecord(periods)
	if err != nil || len(published) != 3 || published[0].Kind != "settlement" ||
		published[1].Kind != "open" || published[2].Kind != "all" {
		t.Fatalf("the selector of the branch must be published: %+v %v", published, err)
	}
	record, err := metricsRecord(periods, chosen, validMetrics())
	if err != nil || record.Source != "settlement" || record.Cash == nil || record.Fund == nil ||
		record.Materials == nil || len(record.Top) != 1 {
		t.Fatalf("a complete answer must be admitted: %+v %v", record, err)
	}
	if record.Today.Since != nil || record.Today.Opening != "5.00" ||
		record.Today.Expected != "13.00" || len(record.Today.Movements) != 1 {
		t.Fatalf("the drawer of today must be admitted as it is: %+v %v", record.Today, err)
	}
	// A branch that did close a settlement states the cut of its last one, as the instant the client
	// reads back: it is the window the card names in words.
	cut := metricsTodayMoment()
	withCut := validMetrics()
	withCut.Today.Since = &cut
	record, err = metricsRecord(periods, chosen, withCut)
	if err != nil || record.Today.Since == nil || *record.Today.Since != "2024-11-12T12:00:00Z" {
		t.Fatalf("the cut of today must be published as an RFC3339 instant: %+v %v", record.Today, err)
	}
	// A collection and a contribution are information of the ledger: a today whose expectation leaves
	// them out is admitted, with the movements listed and the sum untouched (S14).
	ledger := validMetrics()
	ledger.Today.Movements = []closings.MetricsMovement{
		{Kind: "aporte", Amount: "100.00", OccurredAt: cut},
		{Kind: "recaudacion", Amount: "150.00", OccurredAt: cut.Add(time.Hour)},
		{Kind: "gasto", Amount: "2.00", OccurredAt: cut.Add(2 * time.Hour)},
	}
	record, err = metricsRecord(periods, chosen, ledger)
	if err != nil || len(record.Today.Movements) != 3 || record.Today.Expected != "13.00" ||
		record.Today.Movements[0].Kind != "aporte" ||
		record.Today.Movements[2].Amount != "2.00" {
		t.Fatalf("the movements are information of today: %+v %v", record.Today, err)
	}
	// A settlement may count more material than the period bought: the delivered figure is the
	// counted one, so an excess is published with its own value and never refused (S3, L7).
	over := validMetrics()
	over.Materials.UsedDelivered = ptrInt64(3)
	over.Materials.ScrapDelivered = ptrInt64(1500)
	over.Materials.Materials[0].Delivered = ptrInt64(1500)
	record, err = metricsRecord(periods, chosen, over)
	if err != nil || record.Materials == nil || record.Materials.UsedDelivered == nil ||
		*record.Materials.UsedDelivered != 3 || record.Materials.ScrapDelivered == nil ||
		*record.Materials.ScrapDelivered != 1500 || record.Materials.Materials[0].Delivered == nil ||
		*record.Materials.Materials[0].Delivered != 1500 {
		t.Fatalf("a count larger than the bought one must keep its own value: %+v %v",
			record.Materials, err)
	}
	// The purchase net of a window is a difference, not a collection: a counter-document that
	// reversed a purchase of an earlier period leaves it negative, and the envelope still closes
	// on its own sign -- 0.00 − (−10.00) = 10.00 (L7).
	reversed := validMetrics()
	reversed.Fund.Purchases = "-10.00"
	record, err = metricsRecord(periods, chosen, reversed)
	if err != nil || record.Fund == nil || record.Fund.Purchases != "-10.00" ||
		record.Fund.Expected != "10.00" {
		t.Fatalf("a negative purchase net must be published with its sign: %+v %v", record.Fund, err)
	}
	// A selector that is not the frozen order of a branch's history is not a selector this server
	// wrote: an ascending or repeated settlement, a second live one, a closed one after it, and a
	// history that is not last.
	newer := int64(9)
	ascending := purchases.Period{Kind: purchases.PeriodSettlement, ClosingID: &newer,
		From: periods[1].From, To: periods[1].To, Label: "Rendición #9"}
	// A branch the warehouse never settled offers its whole history and nothing else: that is a
	// selector this domain wrote, and the read of it works.
	onlyHistory := []purchases.Period{{Kind: purchases.PeriodAll, Label: "Todo el historial"}}
	if published, err := metricsPeriodsRecord(onlyHistory); err != nil || len(published) != 1 ||
		published[0].Kind != "all" {
		t.Fatalf("a branch without settlements offers its history: %+v %v", published, err)
	}
	for name, list := range map[string][]purchases.Period{
		"empty":                         {},
		"repeated settlement":           {periods[0], periods[1], periods[1], periods[3]},
		"ascending settlement":          {periods[0], periods[1], ascending, periods[3]},
		"two live periods":              {periods[0], periods[1], periods[2], periods[2], periods[3]},
		"settlement after the live one": {periods[0], periods[2], periods[1], periods[3]},
		"history in the middle":         {periods[0], periods[1], periods[3], periods[2]},
		"repeated history":              {periods[0], periods[1], periods[3], periods[3]},
		"label missing": {periods[0], {Kind: purchases.PeriodSettlement,
			ClosingID: periods[1].ClosingID, From: periods[1].From, To: periods[1].To}, periods[3]},
		"window missing": {periods[0], {Kind: purchases.PeriodSettlement,
			ClosingID: periods[1].ClosingID, Label: "Rendición #3"}, periods[3]},
	} {
		_, err := metricsPeriodsRecord(list)
		metricsRefused(t, name, err)
	}
	// A chosen period the selector does not offer, or an origin the read cannot state, is not an
	// answer: the screen would be showing a period nobody can open.
	absent := int64(77)
	_, err = metricsRecord(periods, purchases.Period{Kind: purchases.PeriodSettlement,
		ClosingID: &absent, From: periods[1].From, To: periods[1].To,
		Label: "Rendición #77"}, validMetrics())
	metricsRefused(t, "a period the selector does not offer", err)
	for name, source := range map[string]string{"": "", "recomputed": "recomputed", "LIVE": "LIVE"} {
		metrics := validMetrics()
		metrics.Source = source
		_, err := metricsRecord(periods, chosen, metrics)
		metricsRefused(t, "the origin "+name, err)
	}
	// Every account of the answer is admitted by its own guards.
	for name, breakIt := range map[string]func(*closings.Metrics){
		"sales total is not canonical":  func(m *closings.Metrics) { m.Sales.Total = "10" },
		"sales cash has three decimals": func(m *closings.Metrics) { m.Sales.Cash = "10.000" },
		"negative commission":           func(m *closings.Metrics) { m.Sales.Commission = "-1.00" },
		"negative sales count":          func(m *closings.Metrics) { m.Sales.Sales = -1 },
		"negative units":                func(m *closings.Metrics) { m.Sales.Units = -1 },
		"drawer expectation is text": func(m *closings.Metrics) {
			m.Cash.Expected = "expected"
		},
		"drawer count is integer":  func(m *closings.Metrics) { m.Cash.Counted = ptrMoney("10") },
		"drawer difference signed": func(m *closings.Metrics) { m.Cash.Difference = ptrSigned("10.0") },
		"drawer opening not money": func(m *closings.Metrics) { m.Cash.Opening = "" },
		"fund expectation not money": func(m *closings.Metrics) {
			m.Fund.Expected = "-"
		},
		"fund replacement not money": func(m *closings.Metrics) {
			m.Fund.Replacement = ptrMoney("5")
		},
		"fund purchases not money": func(m *closings.Metrics) { m.Fund.Purchases = "10" },
		"negative shelf":           func(m *closings.Metrics) { m.Stock.Units = -1 },
		"negative used units":      func(m *closings.Metrics) { m.Materials.Used = -1 },
		"sheet does not add up": func(m *closings.Metrics) {
			m.Materials.Materials[0].Bought = 999
		},
		"material without a name": func(m *closings.Metrics) {
			m.Materials.Materials[0].Material = ""
		},
		"material without an id": func(m *closings.Metrics) {
			m.Materials.Materials[0].MaterialID = 0
		},
		"material without a purchase": func(m *closings.Metrics) {
			m.Materials.Materials[0].Bought = 0
			m.Materials.Scrap = 0
		},
		"negative delivery": func(m *closings.Metrics) {
			m.Materials.Materials[0].Delivered = ptrInt64(-1)
		},
		"model without units": func(m *closings.Metrics) { m.Top[0].Units = 0 },
		"model without a brand": func(m *closings.Metrics) {
			m.Top[0].Brand = ""
		},
		"model capacity over-precise": func(m *closings.Metrics) { m.Top[0].Capacity = "35.0000001" },
		"model money not canonical": func(m *closings.Metrics) {
			m.Top[0].Money = "10"
		},
		"model without an entry":       func(m *closings.Metrics) { m.Top[0].CatalogEntryID = 0 },
		"today opening not money":      func(m *closings.Metrics) { m.Today.Opening = "5" },
		"today sales not money":        func(m *closings.Metrics) { m.Today.Sales = "-10.00" },
		"today expectation not signed": func(m *closings.Metrics) { m.Today.Expected = "trece" },
		"today does not close":         func(m *closings.Metrics) { m.Today.Expected = "12.00" },
		"today with a zero cut":        func(m *closings.Metrics) { m.Today.Since = &time.Time{} },
		"today with an unknown kind": func(m *closings.Metrics) {
			m.Today.Movements[0].Kind = "transferencia"
		},
		"today with a negative movement": func(m *closings.Metrics) {
			m.Today.Movements[0].Amount = "-2.00"
		},
		"today with a zero movement": func(m *closings.Metrics) { m.Today.Movements[0].Amount = "0.00" },
		"today with a moment that never happened": func(m *closings.Metrics) {
			m.Today.Movements[0].OccurredAt = time.Time{}
		},
		"today with a movement out of order": func(m *closings.Metrics) {
			m.Today.Movements = append(m.Today.Movements, closings.MetricsMovement{Kind: "gasto",
				Amount: "1.00", OccurredAt: metricsTodayMoment().Add(-time.Hour)})
		},
		"today beyond the bound of the ledger list": func(m *closings.Metrics) {
			m.Today.Movements = make([]closings.MetricsMovement, 51)
			for i := range m.Today.Movements {
				m.Today.Movements[i] = closings.MetricsMovement{Kind: "gasto", Amount: "1.00",
					OccurredAt: metricsTodayMoment().Add(time.Duration(i) * time.Minute)}
			}
		},
	} {
		metrics := validMetrics()
		breakIt(&metrics)
		_, err := metricsRecord(periods, chosen, metrics)
		metricsRefused(t, name, err)
	}
	// The refusal of the read itself keeps its own status per class.
	for err, want := range map[error]int{
		purchases.ErrInvalid:          400,
		purchases.ErrForbidden:        403,
		closings.ErrForbidden:         403,
		purchases.ErrNotFound:         404,
		closings.ErrNotFound:          404,
		closings.ErrUnavailable:       503,
		errors.New("driver SQLSTATE"): 503,
	} {
		w := httptest.NewRecorder()
		metricsFailure(w, err)
		if w.Code != want || strings.Contains(w.Body.String(), "SQLSTATE") {
			t.Fatalf("%v must answer %d without leaking the driver, got %d %s", err, want, w.Code,
				w.Body.String())
		}
	}
}

// metricsRefused proves an answer this server could not have written is refused and published as the
// contract's own unavailable service, whichever package named the refusal, so a shape the screen
// cannot parse never reaches it.
func metricsRefused(t *testing.T, name string, err error) {
	t.Helper()
	if !errors.Is(err, closings.ErrUnavailable) && !errors.Is(err, purchases.ErrUnavailable) {
		t.Fatalf("%s must fail closed, got %v", name, err)
	}
	w := httptest.NewRecorder()
	metricsFailure(w, err)
	if w.Code != 503 || w.Body.String() != "{\"error\":\"service_unavailable\"}\n" {
		t.Fatalf("%s must be published as an unavailable service, got %d %s", name, w.Code,
			w.Body.String())
	}
}

// ptrSigned is the nullable signed amount of the derived accounts, so a table of broken answers
// stays legible.
func ptrSigned(text string) *closings.Signed {
	value := closings.Signed(text)
	return &value
}

// TestMetricsHTTPToday proves the block the screen always shows (S12-S14): the drawer of today is
// published by the three sources, states its cut as an RFC3339 instant or null, carries the three
// terms of the settlement's own identity and lists the ledger rows of the window.
func TestMetricsHTTPToday(t *testing.T) {
	f := metricsFixture(t)
	// A branch that never closed a settlement has no cut at all: its window is everything it did and
	// it opens at zero, so the card can say that in words instead of inventing an instant.
	live := f.open(t, 2)
	answer := metricsAnswer(t, f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/metrics?period=%d", live), "")), 200)
	if answer.Source != "live" {
		t.Fatalf("the period in progress is the live one, got %q", answer.Source)
	}
	if answer.Today.Since != nil || answer.Today.Opening != "0.00" ||
		answer.Today.Sales != "0.00" || answer.Today.Expenses != "0.00" ||
		answer.Today.Expected != "0.00" || len(answer.Today.Movements) != 0 {
		t.Fatalf("a branch without a closed settlement states no cut: %+v", answer.Today)
	}

	// The other branch closes a settlement over a contribution of 100.00: its last cut exists and its
	// ledger holds the contribution of that closing.
	closed := f.closeSettlement(t, 3, `{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","purchase_fund_counted":"50.00","purchase_fund_cash":"50.00","observation":"arranque"}`)
	answer = metricsAnswer(t, f.serve(t, f.request(3, "GET",
		fmt.Sprintf("/api/metrics?period=%d", closed.ID), "")), 200)
	if answer.Today.Since == nil {
		t.Fatalf("a branch that closed a settlement states its cut: %+v", answer.Today)
	}
	// The same identity the drawer of a live period uses: the closing left 100.00 in the till and
	// nothing was sold or paid out of it after the cut.
	if answer.Today.Opening != "100.00" || answer.Today.Sales != "0.00" ||
		answer.Today.Expenses != "0.00" || answer.Today.Expected != "100.00" {
		t.Fatalf("today must follow the settlement's own formula: %+v", answer.Today)
	}
	if len(answer.Today.Movements) != 1 || answer.Today.Movements[0].Kind != "aporte" ||
		answer.Today.Movements[0].Amount != "100.00" {
		t.Fatalf("the contribution of the closing must be listed as information: %+v",
			answer.Today.Movements)
	}
	// The whole history of the same branch publishes the same drawer of today: it is a state of the
	// branch, not a total of the period on screen.
	history := metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period=all", "")), 200)
	if history.Today.Since == nil || *history.Today.Since != *answer.Today.Since ||
		history.Today.Opening != answer.Today.Opening ||
		history.Today.Expected != answer.Today.Expected ||
		len(history.Today.Movements) != len(answer.Today.Movements) {
		t.Fatalf("today is the same whatever period is shown: %+v want %+v", history.Today,
			answer.Today)
	}
}
