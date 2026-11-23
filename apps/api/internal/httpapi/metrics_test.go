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
	"luson/api/internal/catalog"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
	"luson/api/internal/purchases"
)

// The metrics contract publishes one period of the actor's own branch. The tests below prove the
// frozen shape of that answer, the selector it offers, and that every refusal is the contract's own
// token: a request this domain never wrote is a request error, and a value the encoder could not
// have produced fails closed instead of reaching the screen.

// metricsWireKeys is the frozen key set of the answer, and the key sets of the objects it carries.
var (
	metricsWireKeys          = []string{"periods", "period", "source", "sales", "cash", "fund", "materials", "top_models", "stock", "today", "fund_today"}
	metricsSalesWireKeys     = []string{"total", "cash", "card", "transfer", "qr", "commission", "sales", "units"}
	metricsCashWireKeys      = []string{"opening", "sales", "expenses", "expected", "counted", "difference"}
	metricsFundWireKeys      = []string{"opening", "purchases", "expected", "counted", "difference", "replacement"}
	metricsMaterialsWireKeys = []string{"used_units", "used_delivered_units", "scrap_milli", "scrap_delivered_milli", "materials"}
	metricsMaterialWireKeys  = []string{"material_id", "material", "bought_milli", "delivered_milli"}
	// The ranking publishes one row per catalogue kind, and the row's shape is its own discriminant: a
	// battery keeps the six keys it always published and an other product publishes its free name where
	// the battery publishes its identity, with no battery key and no tag at all (S6).
	metricsModelWireKeys        = []string{"catalog_entry_id", "brand", "model", "capacity_ah", "units", "money"}
	metricsProductModelWireKeys = []string{"catalog_entry_id", "name", "units", "money"}
	metricsStockWireKeys        = []string{"units"}
	metricsTodayWireKeys        = []string{"since", "opening", "sales", "expenses", "effective", "expected", "rate", "sold", "commission", "movements"}
	metricsFundTodayWireKeys    = []string{"since", "opening", "purchases", "effective", "balance", "documents", "used_units", "scrap_milli"}
	metricsMovementWireKeys     = []string{"kind", "amount", "effective", "occurred_at"}
	metricsPeriodWireKeys       = []string{"kind", "closing_id", "from", "to", "label"}
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

// metricsModelRow admits one row of the ranking by the shape it carries, which is its own
// discriminant: a row with a battery field publishes exactly the six keys a battery always published, a
// row with a name publishes the four keys of a product, and a row with both shapes or neither is a row
// this contract could not have written (S6).
func metricsModelRow(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var row map[string]json.RawMessage
	if json.Unmarshal(raw, &row) != nil {
		t.Fatalf("the ranking row is not decodable: %s", raw)
	}
	_, battery := row["brand"]
	_, product := row["name"]
	if battery == product {
		t.Fatalf("the ranking publishes a row of both kinds or of neither: %s", raw)
	}
	if battery {
		metricsObject(t, raw, metricsModelWireKeys)
		return
	}
	metricsObject(t, raw, metricsProductModelWireKeys)
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
		CatalogEntryID int64   `json:"catalog_entry_id"`
		Brand          *string `json:"brand"`
		Model          *string `json:"model"`
		Capacity       *string `json:"capacity_ah"`
		Name           *string `json:"name"`
		Units          int64   `json:"units"`
		Money          string  `json:"money"`
	} `json:"top_models"`
	Stock struct {
		Units int64 `json:"units"`
	} `json:"stock"`
	Today struct {
		Since    *string `json:"since"`
		Opening  string  `json:"opening"`
		Sales    string  `json:"sales"`
		Expenses string  `json:"expenses"`
		// Effective is the signed effect of every movement of the window that belongs to no settlement:
		// the third term of the drawer's own identity, opening + sales + effective = expected (S4).
		Effective string `json:"effective"`
		Expected  string `json:"expected"`
		// The rate is null for a branch the warehouse never configured, so the absence of a rate is
		// a state of its own and never a zero percentage (S20).
		Rate       *string `json:"rate"`
		Sold       string  `json:"sold"`
		Commission string  `json:"commission"`
		Movements  []struct {
			Kind   string `json:"kind"`
			Amount string `json:"amount"`
			// Effective is the signed effect of the row, positive into the drawer and negative out of
			// it: a correction carries the opposite direction of the movement it answers (S13).
			Effective  string `json:"effective"`
			OccurredAt string `json:"occurred_at"`
		} `json:"movements"`
	} `json:"today"`
	FundToday struct {
		Since      *string `json:"since"`
		Opening    string  `json:"opening"`
		Purchases  string  `json:"purchases"`
		Effective  string  `json:"effective"`
		Balance    string  `json:"balance"`
		Documents  int64   `json:"documents"`
		UsedUnits  int64   `json:"used_units"`
		ScrapMilli int64   `json:"scrap_milli"`
	} `json:"fund_today"`
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
		metricsModelRow(t, row)
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
		answer.Today.Effective, answer.Today.Expected} {
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
		for _, money := range []string{movement.Amount, movement.Effective} {
			if !metricsMoneyWire.MatchString(money) {
				t.Fatalf("movement money %q is not canonical: %s", money, w.Body.String())
			}
		}
		if _, err := time.Parse(time.RFC3339, movement.OccurredAt); err != nil {
			t.Fatalf("a movement states its moment as an RFC3339 instant: %q", movement.OccurredAt)
		}
	}
	if answer.Stock.Units < 0 || answer.Sales.Sales < 0 || answer.Sales.Units < 0 {
		t.Fatalf("the answer publishes a negative count: %s", w.Body.String())
	}
	// The purchase envelope of today is published by every source too, and never as a null block: its cut
	// is the only field that may be null, its three money figures plus the window's effect are canonical,
	// and its breakdown -- opening + effective = balance -- is the book's own identity (S15-S17).
	metricsObject(t, root["fund_today"], metricsFundTodayWireKeys)
	for _, money := range []string{answer.FundToday.Opening, answer.FundToday.Purchases,
		answer.FundToday.Effective, answer.FundToday.Balance} {
		if !metricsMoneyWire.MatchString(money) {
			t.Fatalf("fund today money %q is not canonical: %s", money, w.Body.String())
		}
	}
	if answer.FundToday.Since != nil {
		if _, err := time.Parse(time.RFC3339, *answer.FundToday.Since); err != nil {
			t.Fatalf("the cut of the fund of today must be an RFC3339 instant: %q", *answer.FundToday.Since)
		}
	}
	if answer.FundToday.Documents < 0 || answer.FundToday.UsedUnits < 0 ||
		answer.FundToday.ScrapMilli < 0 {
		t.Fatalf("the fund of today publishes a negative count: %s", w.Body.String())
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

// metricsProduct seeds one other product exactly like the catalogue screen writes it -- a free name,
// one polarity-less variant and one typed field -- and prices it in the branch, returning the entry and
// the variant the counter points at.
func (f *metricsHTTPFixture) metricsProduct(t *testing.T, branch int64, name string) (entry, variant int64) {
	t.Helper()
	if err := f.p.QueryRow(f.ctx,
		`INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatalf("product fixture setup failed: %v", err)
	}
	if err := f.p.QueryRow(f.ctx,
		`INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`, entry).Scan(&variant); err != nil {
		t.Fatalf("product variant fixture setup failed: %v", err)
	}
	if _, err := f.p.Exec(f.ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,'volumen en L','number','L',5)`, entry); err != nil {
		t.Fatalf("product field fixture setup failed: %v", err)
	}
	if _, err := f.prices.Write(f.ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
		pricing.WriteInput{CatalogEntryID: entry, MinPrice: "1500.00", SuggestedPrice: "1900.00",
			BranchIDs: []int64{branch}}); err != nil {
		t.Fatalf("the price of the product could not be written: %v", err)
	}
	return entry, variant
}

// TestMetricsHTTPPublishesAProductPeriod pins S6 over the route: a period that sold an other product
// answers 200 with its row published by name and no capacity, and the volume of the period keeps
// summing both kinds (S7).
func TestMetricsHTTPPublishesAProductPeriod(t *testing.T) {
	f := metricsFixture(t)
	// The product sells out before the period opens, so the count sheet of the period keeps its
	// batteries: a sheet that carries a product line is the other vertical's read (S2).
	entry, product := f.metricsProduct(t, 2, "Agua acidulada")
	if _, err := f.p.Exec(f.ctx, `UPDATE inventory_balances SET existing=3,reserved=0
 WHERE location_id=2 AND variant_id=$1`, product); err != nil {
		t.Fatalf("the stock of the product could not be stated: %v", err)
	}
	if w := f.serve(t, f.request(2, "POST", "/api/sales",
		saleProductBody(product, 3, "1900.00"))); w.Code != 201 {
		t.Fatalf("the product must be sellable: %d %s", w.Code, w.Body.String())
	}
	live := f.open(t, 2)

	answer := metricsAnswer(t, f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/metrics?period=%d", live), "")), 200)
	if len(answer.Top) != 1 {
		t.Fatalf("the period sold one product: %+v", answer.Top)
	}
	row := answer.Top[0]
	if row.CatalogEntryID != entry || row.Name == nil || *row.Name != "Agua acidulada" ||
		row.Units != 3 || row.Money != "5700.00" {
		t.Fatalf("the product must be published by its name: %+v", row)
	}
	// A product publishes no battery column at all: the read never invents a capacity for it.
	if row.Brand != nil || row.Model != nil || row.Capacity != nil {
		t.Fatalf("a product row must not publish a battery column: %+v", row)
	}
	// S7: the volume of the period is the sum of every kind it sold.
	if answer.Sales.Units != 3 || answer.Sales.Sales != 1 || answer.Sales.Total != "5700.00" {
		t.Fatalf("the volume of the period must sum both kinds: %+v", answer.Sales)
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
	// The envelope of today starts at the cut of the last closed settlement, which every branch that
	// closed one states: the null cut of a branch without a previous closure is broken where it belongs.
	fundCut := metricsTodayMoment()
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
		Top: []closings.MetricsModel{{CatalogEntryID: 1, Kind: catalog.BatteryKind, Brand: "CAR",
			Model: "NS40ZL", Capacity: "35", Units: 2, Money: "10.00"}},
		Stock: closings.MetricsStock{Units: 5},
		// The drawer of today: what the last cut left, the cash collected after it and the signed effect
		// of the movements of that window -- 5.00 + 10.00 + (−2.00) = 13.00 -- with one ledger row of the
		// window beside them, which is the term the expectation read (S4). A branch without a closed
		// settlement states no cut, which is the null this pins.
		// A branch with no configured rate earns nothing: the base it sold is a fact, the commission it
		// did not earn is the zero of a rate that does not exist, and the rate itself is the null (S18-S20).
		Today: closings.MetricsToday{Opening: "5.00", Sales: "10.00", Expenses: "2.00",
			Effective: "-2.00", Expected: "13.00", Sold: "10.00", Commission: "0.00",
			Movements: []closings.MetricsMovement{
				{Kind: "gasto", Amount: "2.00", Effective: "-2.00",
					OccurredAt: metricsTodayMoment()}}},
		// The purchase envelope of today: what the last cut left in it, the signed effect of the movements
		// of its window and the balance of the book -- 20.00 + (−5.00) = 15.00 -- with the volume of those
		// documents.
		FundToday: closings.MetricsFundToday{Since: &fundCut, Opening: "20.00", Purchases: "5.00",
			Effective: "-5.00", Balance: "15.00", Documents: 1, UsedUnits: 2, ScrapMilli: 500},
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
	// The volume of the fund of today is the net of its window, so a negative reading is an answer and not
	// a shape the server never wrote: it is published with its sign.
	signed := validMetrics()
	signed.FundToday.ScrapMilli = -1
	signed.FundToday.UsedUnits = -2
	if admitted, err := metricsRecord(periods, chosen, signed); err != nil ||
		admitted.FundToday.ScrapMilli != -1 || admitted.FundToday.UsedUnits != -2 {
		t.Fatalf("the signed volume of the fund must be admitted: %+v %v", admitted, err)
	}
	if record.Today.Since != nil || record.Today.Opening != "5.00" ||
		record.Today.Effective != "-2.00" || record.Today.Expected != "13.00" ||
		len(record.Today.Movements) != 1 || record.Today.Movements[0].Effective != "-2.00" {
		t.Fatalf("the drawer of today must be admitted as it is: %+v %v", record.Today, err)
	}
	// The purchase envelope of today is admitted with its own numbers, and its balance is the book's sum
	// of its terms.
	if record.FundToday.Opening != "20.00" || record.FundToday.Purchases != "5.00" ||
		record.FundToday.Effective != "-5.00" || record.FundToday.Balance != "15.00" ||
		record.FundToday.Documents != 1 || record.FundToday.UsedUnits != 2 ||
		record.FundToday.ScrapMilli != 500 {
		t.Fatalf("the envelope of today must be admitted as it is: %+v %v", record.FundToday, err)
	}
	// The envelope of today states the cut of the last closure as the instant the client reads back.
	fundCut := metricsTodayMoment()
	withFundCut := validMetrics()
	withFundCut.FundToday.Since = &fundCut
	record, err = metricsRecord(periods, chosen, withFundCut)
	if err != nil || record.FundToday.Since == nil || *record.FundToday.Since != "2024-11-12T12:00:00Z" {
		t.Fatalf("the cut of the envelope must be an RFC3339 instant: %+v %v", record.FundToday, err)
	}
	// A window whose movements took more than the opening left is a signed balance, and its purchases are
	// published as the signed net they are (S16).
	short := validMetrics()
	short.FundToday.Opening, short.FundToday.Effective, short.FundToday.Purchases =
		"20.00", "-10.00", "-10.00"
	short.FundToday.Balance = "10.00"
	short.FundToday.Since = &fundCut
	record, err = metricsRecord(periods, chosen, short)
	if err != nil || record.FundToday.Balance != "10.00" || record.FundToday.Purchases != "-10.00" {
		t.Fatalf("a negative purchase net must be published with its sign: %+v %v",
			record.FundToday, err)
	}
	// A balance its terms do not produce is a number this read never wrote: the breakdown the card states
	// is the opening plus the effect of the window.
	broken := validMetrics()
	broken.FundToday.Balance = "16.00"
	if _, err := metricsRecord(periods, chosen, broken); !errors.Is(err, closings.ErrUnavailable) {
		t.Fatalf("a balance its terms do not produce must fail closed: %v", err)
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
	// A collection, a contribution and a correction are the ledger of the window and its terms: a today
	// whose expectation sums their signed effect is admitted, and the movements are listed with the
	// direction each one carries (S4, S13).
	ledger := validMetrics()
	ledger.Today.Movements = []closings.MetricsMovement{
		{Kind: "aporte", Amount: "100.00", Effective: "100.00", OccurredAt: cut},
		{Kind: "recaudacion", Amount: "50.00", Effective: "-50.00", OccurredAt: cut.Add(time.Hour)},
		{Kind: "gasto", Amount: "2.00", Effective: "-2.00", OccurredAt: cut.Add(2 * time.Hour)},
		{Kind: "correccion", Amount: "1.00", Effective: "1.00", OccurredAt: cut.Add(3 * time.Hour)},
	}
	// 5.00 inherited + 10.00 collected + 100.00 − 50.00 − 2.00 + 1.00 = 64.00: the same effect the
	// rows state, read as one aggregate (S13).
	ledger.Today.Effective, ledger.Today.Expected = "49.00", "64.00"
	record, err = metricsRecord(periods, chosen, ledger)
	if err != nil || len(record.Today.Movements) != 4 || record.Today.Expected != "64.00" ||
		record.Today.Effective != "49.00" || record.Today.Movements[0].Kind != "aporte" ||
		record.Today.Movements[0].Effective != "100.00" ||
		record.Today.Movements[3].Effective != "1.00" {
		t.Fatalf("the movements are the terms of today: %+v %v", record.Today, err)
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
	// The computed window is the first entry of the selector and it is published only beside a closed
	// settlement with no live one covering it (S4): a branch with a closed settlement and no live one
	// publishes it first, and every other arrangement of it is a selector this server never wrote.
	windowFrom := metricsTodayMoment()
	current := purchases.Period{Kind: purchases.PeriodKind("current"), From: &windowFrom,
		Label: "Desde el último corte"}
	closedOnly := []purchases.Period{periods[0], periods[1], periods[3]}
	windowed := append([]purchases.Period{current}, closedOnly...)
	if published, err := metricsPeriodsRecord(windowed); err != nil || len(published) != 3 ||
		published[0].Kind != "current" || published[0].ClosingID != nil || published[0].To != nil ||
		published[0].From == nil || *published[0].From != "2024-11-12T12:00:00Z" ||
		published[0].Label != "Desde el último corte" || published[1].Kind != "settlement" ||
		published[2].Kind != "all" {
		t.Fatalf("the window must be published first: %+v %v", published, err)
	}
	for name, list := range map[string][]purchases.Period{
		"window after a settlement":   {periods[0], periods[1], current, periods[3]},
		"window beside a live period": append([]purchases.Period{current}, periods...),
		"window without a settlement": {current, periods[0], periods[3]},
		"repeated window":             {current, current, periods[0], periods[1], periods[3]},
		"window naming a settlement": {current, periods[0], {Kind: purchases.PeriodKind("current"),
			ClosingID: periods[1].ClosingID, From: &windowFrom, Label: "Desde el último corte"},
			periods[1], periods[3]},
		"window with an end": {current, periods[0], {Kind: purchases.PeriodKind("current"),
			From: &windowFrom, To: &windowFrom, Label: "Desde el último corte"}, periods[1], periods[3]},
		"window without a cut": {current, periods[0],
			{Kind: purchases.PeriodKind("current"), Label: "Desde el último corte"}, periods[1], periods[3]},
		"window with words nobody wrote": {current, periods[0], {Kind: purchases.PeriodKind("current"),
			From: &windowFrom, Label: "Desde el corte"}, periods[1], periods[3]},
	} {
		_, err := metricsPeriodsRecord(list)
		metricsRefused(t, name, err)
	}
	// The answer of the window is the live read without an acta and with the total the same answer says
	// the branch sold, so a window that publishes a drawer, an envelope, a sheet, a frozen origin or a
	// total that contradicts today is a number this server never wrote (S5, S6).
	windowMetrics := validMetrics()
	windowMetrics.Source = "live"
	windowMetrics.Cash, windowMetrics.Fund, windowMetrics.Materials = nil, nil, nil
	if record, err := metricsRecord(windowed, current, windowMetrics); err != nil ||
		record.Period.Kind != "current" || record.Cash != nil || record.Source != "live" {
		t.Fatalf("the window must be admitted as it is: %+v %v", record, err)
	}
	shifted := windowFrom.Add(time.Hour)
	unoffered := current
	unoffered.From = &shifted
	if _, err := metricsRecord(windowed, unoffered, windowMetrics); err == nil {
		t.Fatalf("a window the selector does not offer must be refused")
	}
	for name, breakIt := range map[string]func(*closings.Metrics){
		"window with a drawer":      func(m *closings.Metrics) { m.Cash = validMetrics().Cash },
		"window with an envelope":   func(m *closings.Metrics) { m.Fund = validMetrics().Fund },
		"window with a sheet":       func(m *closings.Metrics) { m.Materials = validMetrics().Materials },
		"window of a frozen origin": func(m *closings.Metrics) { m.Source = "settlement" },
		"window that contradicts today": func(m *closings.Metrics) {
			m.Sales.Total = "9.00"
		},
	} {
		metrics := windowMetrics
		breakIt(&metrics)
		_, err := metricsRecord(windowed, current, metrics)
		metricsRefused(t, name, err)
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
		"model without an entry":      func(m *closings.Metrics) { m.Top[0].CatalogEntryID = 0 },
		"model of an unknown kind":    func(m *closings.Metrics) { m.Top[0].Kind = "gift" },
		"battery with a product name": func(m *closings.Metrics) { m.Top[0].Name = "Agua acidulada" },
		"battery without a capacity":  func(m *closings.Metrics) { m.Top[0].Capacity = "" },
		"product without a name": func(m *closings.Metrics) {
			m.Top = []closings.MetricsModel{metricsProductModel()}
			m.Top[0].Name = ""
		},
		"product with a battery capacity": func(m *closings.Metrics) {
			m.Top = []closings.MetricsModel{metricsProductModel()}
			m.Top[0].Capacity = "35"
		},
		"product with a brand": func(m *closings.Metrics) {
			m.Top = []closings.MetricsModel{metricsProductModel()}
			m.Top[0].Brand = "CAR"
		},
		"today opening not money":      func(m *closings.Metrics) { m.Today.Opening = "5" },
		"today sales not money":        func(m *closings.Metrics) { m.Today.Sales = "-10.00" },
		"today effect not signed":      func(m *closings.Metrics) { m.Today.Effective = "menos" },
		"today expectation not signed": func(m *closings.Metrics) { m.Today.Expected = "trece" },
		"today does not close":         func(m *closings.Metrics) { m.Today.Expected = "12.00" },
		"today leaves its effect out": func(m *closings.Metrics) {
			m.Today.Expected = "15.00"
		},
		"today with a zero cut": func(m *closings.Metrics) { m.Today.Since = &time.Time{} },
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
				Amount: "1.00", Effective: "-1.00", OccurredAt: metricsTodayMoment().Add(-time.Hour)})
		},
		"today with an effect that is not signed money": func(m *closings.Metrics) {
			m.Today.Movements[0].Effective = "-2"
		},
		"today with an effect larger than its amount": func(m *closings.Metrics) {
			m.Today.Movements[0].Effective = "-20.00"
		},
		"today with an effect that contradicts its kind": func(m *closings.Metrics) {
			m.Today.Movements[0].Effective = "2.00"
		},
		"today with a correction that names no direction": func(m *closings.Metrics) {
			m.Today.Movements = append(m.Today.Movements, closings.MetricsMovement{Kind: "correccion",
				Amount: "1.00", Effective: "0.00",
				OccurredAt: metricsTodayMoment().Add(time.Minute)})
		},
		"today beyond the bound of the ledger list": func(m *closings.Metrics) {
			m.Today.Movements = make([]closings.MetricsMovement, 51)
			for i := range m.Today.Movements {
				m.Today.Movements[i] = closings.MetricsMovement{Kind: "gasto", Amount: "1.00",
					Effective:  "-1.00",
					OccurredAt: metricsTodayMoment().Add(time.Duration(i) * time.Minute)}
			}
		},
		"fund today opening not money":    func(m *closings.Metrics) { m.FundToday.Opening = "20" },
		"fund today opening negative":     func(m *closings.Metrics) { m.FundToday.Opening = "-20.00" },
		"fund today purchases not signed": func(m *closings.Metrics) { m.FundToday.Purchases = "5" },
		"fund today effect not signed":    func(m *closings.Metrics) { m.FundToday.Effective = "5" },
		"fund today balance not signed":   func(m *closings.Metrics) { m.FundToday.Balance = "quince" },
		"fund today does not close": func(m *closings.Metrics) {
			m.FundToday.Balance = "16.00"
		},
		"fund today with a zero cut": func(m *closings.Metrics) {
			m.FundToday.Since = &time.Time{}
		},
		"fund today with an opening nobody left": func(m *closings.Metrics) {
			m.FundToday.Since = nil
		},
		"fund today with a negative document count": func(m *closings.Metrics) {
			m.FundToday.Documents = -1
		},
		// The units of the window are the net of its documents too, so their sign is a reading.
		// A negative weight is not a shape the server never wrote: it is the net of a window whose
		// counter-document returned a purchase made before the cut, and it is published with its sign.
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

// metricsProductModel is one row of the ranking of the second catalogue kind: the free name it
// publishes, its units and its money, and no battery identity at all.
func metricsProductModel() closings.MetricsModel {
	return closings.MetricsModel{CatalogEntryID: 7, Kind: catalog.OtherKind, Name: "Agua acidulada",
		Units: 3, Money: "15.00"}
}

// metricsModelJSON publishes one row of the ranking as the exact bytes of its wire shape, so a test
// pins the keys and their order instead of a set that would hide an added one.
func metricsModelJSON(t *testing.T, model closings.MetricsModel) string {
	t.Helper()
	record, err := metricsModelRecord(model)
	if err != nil {
		t.Fatalf("the row %+v must be published: %v", model, err)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("the row is not encodable: %v", err)
	}
	return string(encoded)
}

// metricsModelKeys reads one row of the ranking back as its own key set, so a test asserts the wire
// shape of each kind by the keys it carries instead of a struct that would hide an extra one.
func metricsModelKeys(t *testing.T, model closings.MetricsModel) map[string]json.RawMessage {
	t.Helper()
	encoded := metricsModelJSON(t, model)
	var wire map[string]json.RawMessage
	if json.Unmarshal([]byte(encoded), &wire) != nil {
		t.Fatalf("the row is not decodable: %s", encoded)
	}
	return wire
}

// TestMetricsModelRecordPublishesBothCatalogueKinds pins S6 on the wire shape of one row: a battery
// keeps the keys and the values it always published, an other product publishes its name with no
// capacity at all, and a malformed battery is still refused instead of being relaxed with it.
func TestMetricsModelRecordPublishesBothCatalogueKinds(t *testing.T) {
	// A battery row is the six keys this contract published before the second kind existed, in that
	// order and with nothing added: the kind of a row is its own shape, never a tag beside it (S6).
	if got, want := metricsModelJSON(t, validMetrics().Top[0]),
		`{"catalog_entry_id":1,"brand":"CAR","model":"NS40ZL","capacity_ah":"35","units":2,"money":"10.00"}`; got != want {
		t.Fatalf("the battery row must be the bytes it always published:\n got %s\nwant %s", got, want)
	}
	// A product row is its name and nothing of the battery shape: no capacity and no battery key.
	if got, want := metricsModelJSON(t, metricsProductModel()),
		`{"catalog_entry_id":7,"name":"Agua acidulada","units":3,"money":"15.00"}`; got != want {
		t.Fatalf("a product row is its name and no battery key:\n got %s\nwant %s", got, want)
	}
	battery := metricsModelKeys(t, validMetrics().Top[0])
	if len(battery) != len(metricsModelWireKeys) ||
		string(battery["catalog_entry_id"]) != `1` || string(battery["brand"]) != `"CAR"` ||
		string(battery["model"]) != `"NS40ZL"` || string(battery["capacity_ah"]) != `"35"` ||
		string(battery["units"]) != `2` || string(battery["money"]) != `"10.00"` {
		t.Fatalf("the battery row must keep the identity it always published: %v", battery)
	}
	// A product is its name, its units and its money: no capacity is invented for it, because it has
	// none and a number nobody stored would read as if the catalogue had one, and no tag tells the two
	// apart -- the shape does.
	product := metricsModelKeys(t, metricsProductModel())
	if len(product) != len(metricsProductModelWireKeys) ||
		string(product["catalog_entry_id"]) != `7` || string(product["name"]) != `"Agua acidulada"` ||
		string(product["units"]) != `3` || string(product["money"]) != `"15.00"` {
		t.Fatalf("a product row is its name, its units and its money: %v", product)
	}
	for _, key := range []string{"brand", "model", "capacity_ah"} {
		if _, ok := product[key]; ok {
			t.Fatalf("a product row must not publish %q: %v", key, product)
		}
	}
	// The gates that refuse a battery this domain never wrote are relaxed for the product kind only: an
	// empty brand or a capacity that is not the canonical one still fails closed for a battery, and a
	// product carrying a battery attribute is refused as the other kind's shape it is.
	batteryRow := validMetrics().Top[0]
	for name, broken := range map[string]struct {
		base    closings.MetricsModel
		breakIt func(*closings.MetricsModel)
	}{
		"battery without a brand":     {batteryRow, func(m *closings.MetricsModel) { m.Brand = "" }},
		"battery without a model":     {batteryRow, func(m *closings.MetricsModel) { m.Model = "" }},
		"battery without a capacity":  {batteryRow, func(m *closings.MetricsModel) { m.Capacity = "" }},
		"battery capacity is text":    {batteryRow, func(m *closings.MetricsModel) { m.Capacity = "35Ah" }},
		"battery with a product name": {batteryRow, func(m *closings.MetricsModel) { m.Name = "Agua acidulada" }},
		"battery of an unknown kind":  {batteryRow, func(m *closings.MetricsModel) { m.Kind = "gift" }},
		"battery without units":       {batteryRow, func(m *closings.MetricsModel) { m.Units = 0 }},
		"product without a name":      {metricsProductModel(), func(m *closings.MetricsModel) { m.Name = "" }},
		"product with a capacity":     {metricsProductModel(), func(m *closings.MetricsModel) { m.Capacity = "35" }},
		"product with a brand":        {metricsProductModel(), func(m *closings.MetricsModel) { m.Brand = "CAR" }},
		"product without units":       {metricsProductModel(), func(m *closings.MetricsModel) { m.Units = 0 }},
		"product money is not canonical": {metricsProductModel(), func(m *closings.MetricsModel) {
			m.Money = "15"
		}},
	} {
		model := broken.base
		broken.breakIt(&model)
		if _, err := metricsModelRecord(model); !errors.Is(err, closings.ErrUnavailable) {
			t.Fatalf("%s must fail closed, got %v", name, err)
		}
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
		answer.Today.Effective != "0.00" || answer.Today.Expected != "0.00" ||
		len(answer.Today.Movements) != 0 {
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
	// nothing was sold or paid out of it after the cut. Its contribution is a transfer of the acta, so
	// it is listed with its effect and excluded from the effect of the window (S5).
	if answer.Today.Opening != "100.00" || answer.Today.Sales != "0.00" ||
		answer.Today.Expenses != "0.00" || answer.Today.Effective != "0.00" ||
		answer.Today.Expected != "100.00" {
		t.Fatalf("today must follow the drawer's own identity: %+v", answer.Today)
	}
	if len(answer.Today.Movements) != 1 || answer.Today.Movements[0].Kind != "aporte" ||
		answer.Today.Movements[0].Amount != "100.00" ||
		answer.Today.Movements[0].Effective != "100.00" {
		t.Fatalf("the contribution of the closing must be listed with its effect: %+v",
			answer.Today.Movements)
	}
	// The whole history of the same branch publishes the same drawer of today: it is a state of the
	// branch, not a total of the period on screen.
	history := metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period=all", "")), 200)
	if history.Today.Since == nil || *history.Today.Since != *answer.Today.Since ||
		history.Today.Opening != answer.Today.Opening ||
		history.Today.Effective != answer.Today.Effective ||
		history.Today.Expected != answer.Today.Expected ||
		len(history.Today.Movements) != len(answer.Today.Movements) {
		t.Fatalf("today is the same whatever period is shown: %+v want %+v", history.Today,
			answer.Today)
	}
}

// TestMetricsHTTPTodayCommission proves the reading the screen shows in the window of today (S18-S20):
// the rate the warehouse configured for the branch, the total it sold since the last cut and the
// commission those two produce -- rounded once, exactly like the settlement computes it -- published
// by every source, because the branch is inside one window of its own whatever the screen shows.
func TestMetricsHTTPTodayCommission(t *testing.T) {
	f := metricsFixture(t)
	// The other branch sells after closing a settlement: it is inside a window, so the answer states
	// the cut the commission runs from and the total the rate applies to.
	closed := f.closeSettlement(t, 3, `{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","purchase_fund_counted":"50.00","purchase_fund_cash":"50.00","observation":"arranque"}`)
	read := func(period string) metricsAnswerWire {
		t.Helper()
		return metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period="+period, "")), 200)
	}
	answer := read(fmt.Sprintf("%d", closed.ID))
	if answer.Today.Rate != nil && *answer.Today.Rate != "10.00" {
		t.Fatalf("today must state the rate the warehouse configured: %+v", answer.Today.Rate)
	}
	// A branch with no sale since its cut sold nothing; whatever rate it holds, it earned nothing.
	if answer.Today.Sold != "0.00" || answer.Today.Commission != "0.00" {
		t.Fatalf("a window without sales states no commission: %+v", answer.Today)
	}
	history := read("all")
	if history.Today.Sold != answer.Today.Sold ||
		history.Today.Commission != answer.Today.Commission ||
		(history.Today.Rate == nil) != (answer.Today.Rate == nil) {
		t.Fatalf("the commission of today is the same whatever period is shown: %+v want %+v",
			history.Today, answer.Today)
	}
}

// TestMetricsHTTPTodayCommissionRefusesAnIdentityItCouldNotHaveWritten proves the contract fails closed
// on the one reading a client must be able to trust: a commission that is not its rate times the total
// sold is a number this server never wrote, so it is refused instead of reaching the screen.
func TestMetricsHTTPTodayCommissionRefusesAnIdentityItCouldNotHaveWritten(t *testing.T) {
	rate := closings.Percent("12.50")
	sold := closings.Money("140.00")
	impossible := closings.Percent("101.00")
	shapes := map[string]closings.MetricsToday{
		"a commission that is not its rate times the total": {
			Opening: "0.00", Sales: "0.00", Expenses: "0.00", Effective: "0.00", Expected: "0.00",
			Rate: &rate, Sold: sold, Commission: closings.Money("99.00")},
		"a commission without a rate": {
			Opening: "0.00", Sales: "0.00", Expenses: "0.00", Effective: "0.00", Expected: "0.00",
			Rate: nil, Sold: sold, Commission: closings.Money("17.50")},
		"a zero commission with a rate that produces one": {
			Opening: "0.00", Sales: "0.00", Expenses: "0.00", Effective: "0.00", Expected: "0.00",
			Rate: &rate, Sold: sold, Commission: closings.Money("0.00")},
		"a rate that is not a percentage": {
			Opening: "0.00", Sales: "0.00", Expenses: "0.00", Effective: "0.00", Expected: "0.00",
			Rate: &impossible, Sold: sold, Commission: closings.Money("17.50")},
		"a total sold that is not money": {
			Opening: "0.00", Sales: "0.00", Expenses: "0.00", Effective: "0.00", Expected: "0.00",
			Rate: &rate, Sold: closings.Money("-0.001"), Commission: closings.Money("17.50")},
	}
	for name, today := range shapes {
		if _, err := metricsTodayRecord(today); !errors.Is(err, closings.ErrUnavailable) {
			t.Fatalf("%s must be refused as unavailable, got %v", name, err)
		}
	}
	// The reading the store does write is admitted, and it is the settled rule beside it.
	admitted, err := metricsTodayRecord(closings.MetricsToday{
		Opening: "0.00", Sales: "0.00", Expenses: "0.00", Effective: "0.00", Expected: "0.00",
		Rate: &rate, Sold: sold, Commission: closings.Money("17.50")})
	if err != nil || admitted.Commission != "17.50" || admitted.Rate == nil ||
		*admitted.Rate != "12.50" || admitted.Sold != "140.00" {
		t.Fatalf("a consistent commission must be published: %+v %v", admitted, err)
	}
}

// TestMetricsHTTPFundToday proves the block the screen shows beside the drawer of today (S15-S17): the
// purchase envelope of the branch is published by the three sources, states its cut as an RFC3339
// instant or null, and carries the balance of the branch's book -- sum(effective) of
// purchase_fund_ledger, the same arithmetic the acta and the purchases' tope read -- with the signed
// effect of its window beside it and the volume those documents bought.
func TestMetricsHTTPFundToday(t *testing.T) {
	f := metricsFixture(t)
	// The branch buys 35.00 in cash before it ever closed a settlement: there is no cut, so the window is
	// everything it did and it inherited nothing. The book of the fixture holds the 5,000,000.00 it was
	// loaded with, so the card publishes that load minus the purchase, and never a shortage of 35.00 that
	// the book does not hold. The document is written through the purchases store, because the chain this
	// fixture mounts serves the read of one period and not the counter that writes a purchase.
	buy(t, f, 2, purchases.CreateInput{OperationKey: "http-fund-today-01",
		UsedLines:  []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"}},
		ScrapLines: []purchases.ScrapLineInput{{MaterialID: 1, Kg: "1.500", PricePerKg: "10.00"}},
		PaidCash:   "35.00", PaidTransfer: "0.00"})
	answer := metricsAnswer(t, f.serve(t, f.request(2, "GET", "/api/metrics?period=all", "")), 200)
	if answer.FundToday.Since != nil {
		t.Fatalf("a branch without a closed settlement states no cut: %+v", answer.FundToday)
	}
	if answer.FundToday.Opening != "0.00" || answer.FundToday.Purchases != "35.00" ||
		answer.FundToday.Effective != "4999965.00" || answer.FundToday.Balance != "4999965.00" ||
		answer.FundToday.Documents != 1 || answer.FundToday.UsedUnits != 2 ||
		answer.FundToday.ScrapMilli != 1500 {
		t.Fatalf("the envelope without a cut is the whole book of the branch: %+v", answer.FundToday)
	}

	// Another branch closes a settlement with 50.00 left in the envelope, and buys 20.00 out of it after
	// that cut: the card names the cut, states the opening the acta published and the effect of the
	// movements of the window, and the balance the two produce.
	closed := f.closeSettlement(t, 3, `{"counted_cash":"0.00","contributed_cash":"0.00","closing_cash":"0.00","purchase_fund_counted":"50.00","purchase_fund_cash":"50.00","observation":"arranque"}`)
	buy(t, f, 3, purchases.CreateInput{OperationKey: "http-fund-today-02",
		UsedLines: []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 1, UnitPrice: "20.00"}},
		PaidCash:  "20.00", PaidTransfer: "0.00"})
	answer = metricsAnswer(t, f.serve(t, f.request(3, "GET",
		fmt.Sprintf("/api/metrics?period=%d", closed.ID), "")), 200)
	if answer.FundToday.Since == nil {
		t.Fatalf("a branch that closed a settlement states its cut: %+v", answer.FundToday)
	}
	if answer.FundToday.Opening != "50.00" || answer.FundToday.Purchases != "20.00" ||
		answer.FundToday.Effective != "-20.00" || answer.FundToday.Balance != "30.00" ||
		answer.FundToday.Documents != 1 || answer.FundToday.UsedUnits != 1 ||
		answer.FundToday.ScrapMilli != 0 {
		t.Fatalf("the envelope must be the opening plus the effect of the window: %+v",
			answer.FundToday)
	}
	// The whole history of the same branch publishes the same envelope: it is a state of the branch and
	// not a total of the period on screen.
	history := metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period=all", "")), 200)
	if history.FundToday.Since == nil || *history.FundToday.Since != *answer.FundToday.Since ||
		history.FundToday.Opening != answer.FundToday.Opening ||
		history.FundToday.Balance != answer.FundToday.Balance ||
		history.FundToday.Effective != answer.FundToday.Effective ||
		history.FundToday.Documents != answer.FundToday.Documents {
		t.Fatalf("the envelope is the same whatever period is shown: %+v want %+v",
			history.FundToday, answer.FundToday)
	}
}

// buy registers one purchase of the branch the test names through the purchases store, so the envelope of
// today reads a document the branch really wrote: the fixture of the metrics chain mounts the read and not
// the counter, and the document is the same one either way.
func buy(t *testing.T, f *metricsHTTPFixture, branch int, input purchases.CreateInput) {
	t.Helper()
	if _, err := purchases.New(f.p).Create(f.ctx,
		auth.Identity{AccountID: branch, Location: auth.Location{ID: branch}}, input); err != nil {
		t.Fatalf("the purchase of branch %d could not be registered: %v", branch, err)
	}
}

// TestMetricsPeriodSelectorPublishesTheColumnInstants pins the precision of the selector's window (S4,
// S13): the `from` and `to` of a period are the instants the database holds, microseconds included,
// because a screen asks the book for that window and a bound truncated to the whole second would count
// the rows recorded in the last fraction of a second on the wrong side of it.
func TestMetricsPeriodSelectorPublishesTheColumnInstants(t *testing.T) {
	f := metricsFixture(t)
	// A contribution of the branch's own book is the earliest activity of the branch, so the first period
	// starts at that row's instant: the selector must publish it as the column holds it.
	aporte := closingCashMovementReply(t, f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"aporte","amount":"30.00","description":"Cambio para el cajón"}`)), 201,
		closingCashMovementKeys)
	closed := f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo"}`)
	var storedStart, storedCut, occurred time.Time
	if err := f.p.QueryRow(f.ctx, `SELECT period_start,cut_at FROM branch_closings WHERE id=$1`,
		closed.ID).Scan(&storedStart, &storedCut); err != nil {
		t.Fatalf("the window of the closure is not readable: %v", err)
	}
	if err := f.p.QueryRow(f.ctx, `SELECT occurred_at FROM branch_cash_movements WHERE id=$1`,
		aporte.ID).Scan(&occurred); err != nil {
		t.Fatalf("the movement of the fixture is not readable: %v", err)
	}
	if !occurred.Equal(storedStart) {
		t.Fatalf("this probe is about the first activity: the period starts at %s and the contribution "+
			"is stamped %s", storedStart, occurred)
	}
	answer := metricsAnswer(t, f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/metrics?period=%d", closed.ID), "")), 200)
	chosen := answer.Period
	if chosen.From == nil || chosen.To == nil {
		t.Fatalf("a settlement period states its window: %+v", chosen)
	}
	if want := storedStart.UTC().Format(time.RFC3339Nano); *chosen.From != want {
		t.Fatalf("the selector starts at %s and published %s", want, *chosen.From)
	}
	if want := storedCut.UTC().Format(time.RFC3339Nano); *chosen.To != want {
		t.Fatalf("the selector ends at %s and published %s", want, *chosen.To)
	}
	// The window the selector published is the one the book answers for: the same bounds, the same
	// expectation and the movement the acta counted.
	book := closingCashLedgerOf(t, f.closingHTTPFixture, *chosen.From, *chosen.To)
	if book.Since == nil || *book.Since != *chosen.From || book.Until == nil || *book.Until != *chosen.To {
		t.Fatalf("the book must echo the window the selector published: %+v", book)
	}
	if len(book.Movements) != 1 || book.Movements[0].ID != aporte.ID {
		t.Fatalf("the window of the selector must hold the movement of the period: %+v", book.Movements)
	}
	// Every period of the selector states the same precision, the live one included.
	for _, period := range answer.Periods {
		for name, bound := range map[string]*string{"from": period.From, "to": period.To} {
			if bound == nil {
				continue
			}
			parsed, err := time.Parse(time.RFC3339Nano, *bound)
			if err != nil || parsed.UTC().Format(time.RFC3339Nano) != *bound {
				t.Fatalf("%s of %s is not the instant the column holds: %q", name, period.Kind, *bound)
			}
		}
	}
}

// TestMetricsHTTPCurrentWindow proves the computed period over the route (S3-S7): a branch with two
// closed settlements and no live one publishes the window first, answers it with the live origin, the
// three accounts a settlement states as null and the money, the ranking and the total of its own sales;
// a live settlement takes that entry away, because it already covers the same window as «En curso».
func TestMetricsHTTPCurrentWindow(t *testing.T) {
	f := metricsFixture(t)
	first := f.closeSettlement(t, 3,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"arranque del período"}`)
	// The branch sells one battery between the two closures, which the second acta states.
	if _, err := f.prices.Write(f.ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
		pricing.WriteInput{CatalogEntryID: 1, MinPrice: "85000.00", SuggestedPrice: "96000.00",
			BranchIDs: []int64{3}}); err != nil {
		t.Fatalf("the price of the battery could not be written: %v", err)
	}
	if w := f.serve(t, f.request(3, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6))); w.Code != 201 {
		t.Fatalf("the branch must sell between settlements: %d %s", w.Code, w.Body.String())
	}
	second := f.closeSettlement(t, 3,
		`{"counted_cash":"96100.00","contributed_cash":"0.00","closing_cash":"96100.00","observation":"segundo corte"}`)
	if first.ID >= second.ID {
		t.Fatalf("the fixture must close two settlements in order: %d then %d", first.ID, second.ID)
	}
	// The window's own sale, after the last cut: two units and 192000.00 in cash.
	if w := f.serve(t, f.request(3, "POST", "/api/sales", saleBody(1, 2, "96000.00", 6))); w.Code != 201 {
		t.Fatalf("the branch must sell after the last cut: %d %s", w.Code, w.Body.String())
	}
	var cut time.Time
	if err := f.p.QueryRow(f.ctx, `SELECT cut_at FROM branch_closings WHERE id=$1`,
		second.ID).Scan(&cut); err != nil {
		t.Fatalf("the cut of the last closed settlement could not be read: %v", err)
	}

	answer := metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period=current", "")), 200)
	if answer.Source != "live" {
		t.Fatalf("a computed window states the live origin, got %q", answer.Source)
	}
	// S4: the chosen period is the window the selector publishes: its kind, no settlement, no end and
	// the exact words, starting at the cut of the last closed settlement.
	window := answer.Period
	if window.Kind != "current" || window.ClosingID != nil || window.To != nil ||
		window.From == nil || window.Label != "Desde el último corte" {
		t.Fatalf("the chosen period must be the computed window: %+v", window)
	}
	if want := cut.UTC().Format(time.RFC3339Nano); *window.From != want {
		t.Fatalf("the window must start at %s and published %s", want, *window.From)
	}
	// S5: a window has no acta, so the three accounts a settlement states are null.
	if answer.Cash != nil || answer.Fund != nil || answer.Materials != nil {
		t.Fatalf("a window states no drawer, no envelope and no material: %+v %+v %+v",
			answer.Cash, answer.Fund, answer.Materials)
	}
	// The money, the volume and the commission of the window: the sale after the last cut only.
	if answer.Sales.Total != "192000.00" || answer.Sales.Cash != "192000.00" ||
		answer.Sales.Card != "0.00" || answer.Sales.Sales != 1 || answer.Sales.Units != 2 {
		t.Fatalf("the window counts only the sales after its cut: %+v", answer.Sales)
	}
	// S6: the total of the window is the total the same answer says the branch sold since that cut,
	// and the commission is the one the drawer of today is earning over the same window.
	if answer.Today.Sold != answer.Sales.Total || answer.Today.Sold != "192000.00" ||
		answer.Today.Commission != answer.Sales.Commission {
		t.Fatalf("the window and today must state one money: %+v %+v", answer.Sales, answer.Today)
	}
	// The ranking is the one of the same window.
	if len(answer.Top) != 1 || answer.Top[0].Units != 2 || answer.Top[0].Money != "192000.00" ||
		answer.Top[0].Brand == nil || *answer.Top[0].Brand != "CAR" {
		t.Fatalf("the ranking of the window must be its own sales: %+v", answer.Top)
	}
	// S4: the window is published first, then the settlements newest first, then the whole history.
	if len(answer.Periods) != 4 || answer.Periods[0].Kind != "current" ||
		answer.Periods[1].Kind != "settlement" || answer.Periods[2].Kind != "settlement" ||
		answer.Periods[3].Kind != "all" {
		t.Fatalf("the selector must publish the window and then the settlements: %+v", answer.Periods)
	}
	if answer.Periods[0].ClosingID != nil || answer.Periods[0].To != nil ||
		answer.Periods[0].From == nil || *answer.Periods[0].From != *window.From ||
		answer.Periods[0].Label != "Desde el último corte" {
		t.Fatalf("the window must be published as the chosen period publishes it: %+v",
			answer.Periods[0])
	}
	if answer.Periods[1].ClosingID == nil || *answer.Periods[1].ClosingID != second.ID ||
		answer.Periods[1].From == nil || answer.Periods[1].To == nil ||
		answer.Periods[2].ClosingID == nil || *answer.Periods[2].ClosingID != first.ID {
		t.Fatalf("the settlements must descend newest first: %+v", answer.Periods)
	}
	// S3: reading the window creates, opens and proposes nothing.
	stored := int64(0)
	if err := f.p.QueryRow(f.ctx, `SELECT count(*) FROM branch_closings
 WHERE branch_location_id=3`).Scan(&stored); err != nil || stored != 2 {
		t.Fatalf("reading the window must not settle anything: %d %v", stored, err)
	}

	// S4: a live settlement covers that same window as «En curso», so the entry is not published and
	// asking for it is a period the branch does not have (S7).
	f.open(t, 3)
	withLive := metricsAnswer(t, f.serve(t, f.request(3, "GET", "/api/metrics?period=all", "")), 200)
	if len(withLive.Periods) != 4 || withLive.Periods[2].Kind != "open" ||
		withLive.Periods[3].Kind != "all" {
		t.Fatalf("the selector must publish the live period: %+v", withLive.Periods)
	}
	for _, entry := range withLive.Periods {
		if entry.Kind == "current" {
			t.Fatalf("a live settlement takes the window away: %+v", withLive.Periods)
		}
	}
	if w := f.serve(t, f.request(3, "GET", "/api/metrics?period=current", "")); w.Code != 404 ||
		w.Body.String() != "{\"error\":\"not_found\"}\n" {
		t.Fatalf("the window of a branch inside a settlement is not found: %d %s", w.Code,
			w.Body.String())
	}
}

// TestMetricsHTTPCurrentWindowRefusals proves the token obeys the selector's own rules (S4, S7): a
// branch with no closed settlement has no window to offer, the token is judged exactly like the other
// periods when the query is not the one this contract writes, and a refused read leaves the branch as
// it was.
func TestMetricsHTTPCurrentWindowRefusals(t *testing.T) {
	f := metricsFixture(t)
	// The branch never closed a settlement: its selector is the whole history and it has no window.
	answer := metricsAnswer(t, f.serve(t, f.request(2, "GET", "/api/metrics?period=all", "")), 200)
	if len(answer.Periods) != 1 || answer.Periods[0].Kind != "all" {
		t.Fatalf("a branch without settlements offers its history only: %+v", answer.Periods)
	}
	if w := f.serve(t, f.request(2, "GET", "/api/metrics?period=current", "")); w.Code != 404 ||
		w.Body.String() != "{\"error\":\"not_found\"}\n" {
		t.Fatalf("the window of a branch without a closed settlement is not found: %d %s", w.Code,
			w.Body.String())
	}
	// Inside a live settlement there is still no cut to start from, and the live period is the one the
	// selector offers.
	f.open(t, 2)
	answer = metricsAnswer(t, f.serve(t, f.request(2, "GET", "/api/metrics?period=all", "")), 200)
	if len(answer.Periods) != 2 || answer.Periods[0].Kind != "open" ||
		answer.Periods[1].Kind != "all" {
		t.Fatalf("a branch inside a settlement offers it and the history: %+v", answer.Periods)
	}
	if w := f.serve(t, f.request(2, "GET", "/api/metrics?period=current", "")); w.Code != 404 ||
		w.Body.String() != "{\"error\":\"not_found\"}\n" {
		t.Fatalf("a branch inside a settlement has no window: %d %s", w.Code, w.Body.String())
	}
	// The token is a token of this selector and not a licence: the query is judged exactly like the
	// other periods, so a repeated, foreign or bare key is a rejected request.
	before := f.serve(t, f.request(2, "GET", "/api/metrics?period=all", "")).Body.String()
	for name, query := range map[string]string{
		"repeated token":  "period=current&period=current",
		"foreign key":     "period=current&page=1",
		"bare separator":  "period=current&",
		"token and an id": "period=current&period=1",
	} {
		w := f.serve(t, f.request(2, "GET", "/api/metrics?"+query, ""))
		if w.Code != 400 || w.Body.String() != "{\"error\":\"invalid_request\"}\n" {
			t.Fatalf("%s must be an invalid request, got %d %s", name, w.Code, w.Body.String())
		}
	}
	// Nothing the refused reads asked for changed the answer of the branch.
	if after := f.serve(t, f.request(2, "GET", "/api/metrics?period=all", "")).Body.String(); after != before {
		t.Fatalf("a refused read changed the answer: %s want %s", after, before)
	}
}
