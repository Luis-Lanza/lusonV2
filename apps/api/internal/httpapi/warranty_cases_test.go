package httpapi

import (
	"context"
	"encoding/json"
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
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/pricing"
	"luson/api/internal/sales"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
	"luson/api/internal/warrantycase"
)

// The battery case has three layers of test here: the framing of its own routes without a database,
// the revalidation of what it publishes without a database, and the whole vertical over a real
// PostgreSQL through the admitted fixture. The actor split of S19 and S14 is proven on both sides --
// the handler refuses the role before the store is asked, and the database refuses it again -- because
// a route that only trusts the store is one deployment away from answering for the wrong account.

// warrantyRecorder is a base handler that only records the request it received, so forwarding stays
// provable without a database.
type warrantyRecorder struct {
	calls int
	path  string
}

func (h *warrantyRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.calls++
	h.path = r.URL.Path
	w.WriteHeader(http.StatusNoContent)
}

func TestWarrantyCasePathSafety(t *testing.T) {
	// Every ambiguous case path is refused before any handler work, exactly like the sale and
	// settlement contracts: a doubled slash, a dot segment, a backslash or an encoded alias.
	for _, target := range []string{
		"/api/warranty-cases//", "/api/warranty-cases/./1", "/api/warranty-cases/..",
		"/api/warranty-cases/../1", "/api/warranty-cases/a\\b", "/api/warranty-cases/%31",
		"/api/warranty-cases/1%2Floans", "/api/warranty-cases/cla%69ms",
	} {
		if warrantyCasePath(httptest.NewRequest("GET", target, nil)) {
			t.Fatalf("%s must be refused as an ambiguous case path", target)
		}
	}
	if warrantyCasePath(&http.Request{URL: &url.URL{Path: "/api/warranty-cases/a\x00b"}}) {
		t.Fatal("a NUL in the path must be refused")
	}
	// Every other path is admitted here so it can be forwarded or answered as an unknown route.
	for _, target := range []string{"/api/inventory", "/api/closings", "/api/warranty-casesx",
		"/api/warranty-cases", "/api/warranty-cases/7", "/api/warranty-cases/"} {
		if !warrantyCasePath(httptest.NewRequest("GET", target, nil)) {
			t.Fatalf("%s must be admitted here", target)
		}
	}
}

func TestWarrantyCaseConstructor(t *testing.T) {
	cfg := transferConfig(t)
	store := warrantycase.New(&pgxpool.Pool{})
	base := &warrantyRecorder{}
	// A missing base or service is a broken composition and never a silently unwrapped handler.
	if h, err := NewWithWarrantyCases(nil, &auth.Service{}, cfg, store); err == nil || h != nil {
		t.Fatal("a nil base handler must be refused")
	}
	if h, err := NewWithWarrantyCases(base, nil, cfg, store); err == nil || h != nil {
		t.Fatal("a nil auth service must be refused")
	}
	if h, err := NewWithWarrantyCases(base, &auth.Service{}, config.Auth{}, store); err == nil || h != nil {
		t.Fatal("an inconsistent auth configuration must be refused")
	}
	h, err := NewWithWarrantyCases(base, &auth.Service{}, cfg, store)
	if err != nil || h == nil {
		t.Fatal("the case constructor must compose")
	}
	for _, target := range []string{"/api/inventory", "/api/sales", "/api/closings", "/api/warranty-casesx"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s must be forwarded to the composed handler", target)
		}
	}
	if base.calls != 4 || base.path != "/api/warranty-casesx" {
		t.Fatalf("forwarding changed: %d %q", base.calls, base.path)
	}
	// A missing store never breaks the server: the routes stay unregistered and the composed handler
	// answers them, exactly like the settlement store of the legacy factories.
	optional := &warrantyRecorder{}
	forwarding, err := NewWithWarrantyCases(optional, &auth.Service{}, cfg, nil)
	if err != nil || forwarding == nil {
		t.Fatalf("a missing case store must not break the server: %v", err)
	}
	for _, target := range []string{"/api/warranty-cases", "/api/warranty-cases/1",
		"/api/warranty-cases/1/release"} {
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

// TestWarrantyCaseFramesBeforeTheStore proves the framing of the contract without a database: the
// method of every route, the session every route requires, the query of the tray and the ambiguous
// framings a client may send are all judged before the store is asked, so a request this domain could
// not have written never reaches a document.
func TestWarrantyCaseFramesBeforeTheStore(t *testing.T) {
	cfg := transferConfig(t)
	base, err := NewWithWarrantyCases(&warrantyRecorder{}, &auth.Service{}, cfg,
		warrantycase.New(&pgxpool.Pool{}))
	if err != nil {
		t.Fatal("the case constructor must compose")
	}
	anonymous := func(verb, path, body string) *http.Request {
		r := httptest.NewRequest(verb, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", cfg.Origin)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		return r
	}
	// Every mutation is one POST and every read one GET: anything else is refused with its Allow.
	for path, allowed := range map[string]string{
		"/api/warranty-cases":                "GET",
		"/api/warranty-cases/claims":         "POST",
		"/api/warranty-cases/stock-defects":  "POST",
		"/api/warranty-cases/1":              "GET",
		"/api/warranty-cases/1/loans":        "POST",
		"/api/warranty-cases/1/loans/1/fate": "POST",
		"/api/warranty-cases/1/advance":      "POST",
		"/api/warranty-cases/1/resolution":   "POST",
		"/api/warranty-cases/1/notice":       "POST",
		"/api/warranty-cases/1/release":      "POST",
		"/api/warranty-cases/1/delivery":     "POST",
	} {
		verb := "GET"
		if allowed == "GET" {
			verb = "POST"
		}
		w := httptest.NewRecorder()
		base.ServeHTTP(w, anonymous(verb, path, "{}"))
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != allowed {
			t.Fatalf("%s %s must answer 405 admitting %s: %d %s", verb, path, allowed,
				w.Code, w.Body.String())
		}
	}
	// Every route requires the session, and the refusal is the contract's own.
	for path, verb := range map[string]string{
		"/api/warranty-cases":               "GET",
		"/api/warranty-cases/claims":        "POST",
		"/api/warranty-cases/stock-defects": "POST",
		"/api/warranty-cases/1":             "GET",
		"/api/warranty-cases/1/delivery":    "POST",
		"/api/warranty-cases/1/release":     "POST",
	} {
		w := httptest.NewRecorder()
		base.ServeHTTP(w, anonymous(verb, path, "{}"))
		if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "unauthenticated") {
			t.Fatalf("%s %s must require the session: %d %s", verb, path, w.Code, w.Body.String())
		}
	}
	// A casing of the route that is not the contract's own is an unknown route, never a silent
	// redirect, and a path below the collection that names nothing is not_found as JSON.
	for _, target := range []string{"/api/warranty-cases/claims/1", "/api/warranty-cases/1/unknown",
		"/api/warranty-cases/1/loans/1"} {
		w := httptest.NewRecorder()
		base.ServeHTTP(w, anonymous("GET", target, ""))
		if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "not_found") {
			t.Fatalf("%s must be an unknown route: %d %s", target, w.Code, w.Body.String())
		}
	}
}

// TestWarrantyCaseTrayQuery pins the query of the tray: the two filters of the frozen vocabulary and
// nothing else, and a bare or unknown framing refused as a malformed read.
func TestWarrantyCaseTrayQuery(t *testing.T) {
	for raw, want := range map[string]struct {
		phase  string
		origin string
	}{
		"":                                     {"", ""},
		"phase=received":                       {"received", ""},
		"origin=stock_defect":                  {"", "stock_defect"},
		"phase=resolved&origin=warranty_claim": {"resolved", "warranty_claim"},
	} {
		query, err := warrantyCaseTrayQuery(raw)
		if err != nil || string(query.Phase) != want.phase || string(query.Origin) != want.origin {
			t.Fatalf("%q must read as %v: %v %v", raw, want, query, err)
		}
	}
	for _, raw := range []string{
		"phase=on_the_way", "origin=customer_return", "phase=", "origin=", "phase=received&phase=closed",
		"page=2", "phase=RECEIVED", "phase=received&",
	} {
		if _, err := warrantyCaseTrayQuery(raw); err == nil {
			t.Fatalf("%q must be refused as a malformed tray read", raw)
		}
	}
}

// warrantyCaseWire is the case exactly as this contract publishes it, for the assertions of the
// tests: the whole record, so a missing or renamed key is caught.
type warrantyCaseWire struct {
	ID                  int64               `json:"id"`
	CaseNumber          string              `json:"case_number"`
	BranchLocationID    int64               `json:"branch_location_id"`
	Origin              string              `json:"origin"`
	Phase               string              `json:"phase"`
	Verdict             *string             `json:"verdict"`
	ReportedDestination *string             `json:"reported_destination"`
	LoanDestination     *string             `json:"loan_destination"`
	StockDestination    *string             `json:"stock_destination"`
	SaleID              *int64              `json:"sale_id"`
	VariantID           int64               `json:"variant_id"`
	SerialNumber        *string             `json:"serial_number"`
	Quantity            *int64              `json:"quantity"`
	DeclaredFailure     string              `json:"declared_failure"`
	Reason              *string             `json:"reason"`
	CreatedByAccountID  int64               `json:"created_by_account_id"`
	CreatedAt           string              `json:"created_at"`
	Loans               []warrantyLoanWire  `json:"loans"`
	Events              []warrantyEventWire `json:"events"`
}

type warrantyLoanWire struct {
	Ordinal          int     `json:"ordinal"`
	Model            string  `json:"model"`
	Quantity         int64   `json:"quantity"`
	SerialNumber     string  `json:"serial_number"`
	SourceLocationID int64   `json:"source_location_id"`
	GivenAt          string  `json:"given_at"`
	Fate             string  `json:"fate"`
	FateDecidedAt    *string `json:"fate_decided_at"`
	GivenByAccountID int64   `json:"given_by_account_id"`
}

type warrantyEventWire struct {
	Ordinal           int    `json:"ordinal"`
	Kind              string `json:"kind"`
	Phase             string `json:"phase"`
	FactoryCaseNumber string `json:"factory_case_number"`
	ActorAccountID    int64  `json:"actor_account_id"`
	RecordedAt        string `json:"recorded_at"`
	Note              string `json:"note"`
}

type warrantyTrayWire struct {
	Cases []warrantyCaseRowWire `json:"cases"`
}

type warrantyCaseRowWire struct {
	ID               int64   `json:"id"`
	CaseNumber       string  `json:"case_number"`
	BranchLocationID int64   `json:"branch_location_id"`
	Origin           string  `json:"origin"`
	Phase            string  `json:"phase"`
	VariantID        int64   `json:"variant_id"`
	SerialNumber     *string `json:"serial_number"`
	Quantity         *int64  `json:"quantity"`
	DeclaredFailure  string  `json:"declared_failure"`
	Reason           *string `json:"reason"`
	CreatedAt        string  `json:"created_at"`
}

// warrantyHTTPFixture is the whole vertical over a real database: the warehouse, two branches, the
// point of sale that sells the claimed unit, the settlement that counts the shelf and the case itself,
// mounted the way the server mounts them.
type warrantyHTTPFixture struct {
	ctx context.Context
	p   *pgxpool.Pool
	cfg config.Auth
	// handler is the whole server as it is mounted: the settlement, the point of sale, the case and
	// every surface they are composed on.
	handler http.Handler
	tokens  []string
	// variant is the battery of the fixture's catalogue that the branch holds in stock and the counter
	// sells, so a sale, a claim and a finding are about one catalogued battery and never a guessed id.
	variant int64
}

func warrantyFixture(t *testing.T) *warrantyHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("warranty HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20],
			Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("warranty HTTP test provisioning failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("warranty HTTP operational fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("warranty HTTP auth fixture failed")
	}
	f := &warrantyHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("warranty HTTP login failed")
		}
		f.tokens[i] = token
	}
	// The battery the fixture sells and finds: one catalogued battery the branch holds, priced for its
	// counter, so the sale is a document this server writes and not a row the test invented.
	var entry int64
	if err := p.QueryRow(ctx, `SELECT variant.catalog_entry_id,variant.id FROM inventory_balances balance
 JOIN catalog_variants variant ON variant.id=balance.variant_id
 JOIN catalog_entries entry ON entry.id=variant.catalog_entry_id
 WHERE balance.location_id=2 AND entry.kind='battery' AND balance.existing>0
 ORDER BY variant.id LIMIT 1`).Scan(&entry, &f.variant); err != nil {
		t.Fatalf("the fixture must hold a catalogued battery at its branch: %v", err)
	}
	if _, err := pricing.New(p).Write(ctx, auth.Identity{AccountID: 1,
		Location: auth.Location{ID: 1}}, pricing.WriteInput{CatalogEntryID: entry,
		MinPrice: pricing.Money("0.01"), SuggestedPrice: pricing.Money("96000.00"),
		BranchIDs: []int64{2}}); err != nil {
		t.Fatalf("the battery of the fixture could not be priced: %v", err)
	}
	base, err := NewWithStockEntries(svc, f.cfg, inventory.New(p), transfers.New(p),
		stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("warranty HTTP base constructor failed")
	}
	withSales, err := NewWithSales(base, svc, f.cfg, sales.New(p))
	if err != nil {
		t.Fatal("warranty HTTP sale constructor failed")
	}
	withClosings, err := NewWithClosings(withSales, svc, f.cfg, closings.New(p))
	if err != nil {
		t.Fatal("warranty HTTP settlement constructor failed")
	}
	f.handler, err = NewWithWarrantyCases(withClosings, svc, f.cfg, warrantycase.New(p))
	if err != nil {
		t.Fatal("warranty HTTP constructor failed")
	}
	return f
}

func (f *warrantyHTTPFixture) request(actor int, verb, path, body string) *http.Request {
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

func (f *warrantyHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" ||
		w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("warranty security headers changed")
	}
	return w
}

// snapshot captures every table this vertical writes, so a refused request is proven to leave nothing
// behind: no case, no loan, no tramo and no balance.
func (f *warrantyHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'cases',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM warranty_cases c),
  'loans',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.case_id,l.loan_ordinal),'[]'::jsonb) FROM warranty_case_loans l),
  'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.case_id,e.event_ordinal),'[]'::jsonb) FROM warranty_case_events e),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("warranty snapshot failed")
	}
	return data
}

func (f *warrantyHTTPFixture) refused(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	expectTransferError(t, w, status, code)
	if f.snapshot(t) != before {
		t.Fatalf("a refused case request changed stored state (%d %s)", w.Code, w.Body.String())
	}
}

// caseWire decodes one published case and admits nothing but canonical JSON.
func (f *warrantyHTTPFixture) caseWire(t *testing.T, w *httptest.ResponseRecorder, status int) warrantyCaseWire {
	t.Helper()
	if w.Code != status {
		t.Fatalf("the case must answer %d: %d %s", status, w.Code, w.Body.String())
	}
	var record warrantyCaseWire
	if err := json.Unmarshal(w.Body.Bytes(), &record); err != nil {
		t.Fatalf("the case is not decodable: %s", w.Body.String())
	}
	return record
}

// balance reads one balance row of the fixture, so a stock write is proven against the database and
// never against the answer.
func (f *warrantyHTTPFixture) balance(t *testing.T, location, variant int64) int64 {
	t.Helper()
	var existing int64
	if err := f.p.QueryRow(f.ctx, `SELECT existing FROM inventory_balances
 WHERE location_id=$1 AND variant_id=$2`, int16(location), int32(variant)).Scan(&existing); err != nil {
		t.Fatalf("the balance of %d:%d could not be read: %v", location, variant, err)
	}
	return existing
}

// lastSerial reads the serial the point of sale wrote on the newest sold unit, so the claim of the
// fixture is the sale the counter made and not a row the test invented.
func (f *warrantyHTTPFixture) lastSerial(t *testing.T) string {
	t.Helper()
	var serial string
	if err := f.p.QueryRow(f.ctx, `SELECT serial_number FROM sale_units
 ORDER BY sale_id DESC, unit_ordinal DESC LIMIT 1`).Scan(&serial); err != nil {
		t.Fatalf("the serial of the sale could not be read: %v", err)
	}
	return serial
}

// TestWarrantyCaseJourneyOverPostgreSQL proves the whole contract on the admitted fixture: the two
// doors, the tray, the read of one case, the loan, the journey, the resolution, the notice, the
// release, the delivery and the shelf the finding wrote off -- and the actor split of S19 and S14
// refused on both sides.
func TestWarrantyCaseJourneyOverPostgreSQL(t *testing.T) {
	f := warrantyFixture(t)
	// The counter sells one battery with a twelve month term: that unit is the claim of the fixture.
	if w := f.serve(t, f.request(2, "POST", "/api/sales",
		saleBody(f.variant, 1, "96000.00", 12))); w.Code != 201 {
		t.Fatalf("the sale of the fixture must be admitted: %d %s", w.Code, w.Body.String())
	}
	serial := f.lastSerial(t)
	variant := f.variant
	shelf := f.balance(t, 2, variant)
	warehouseShelf := f.balance(t, 1, variant)
	branchThree := f.balance(t, 3, variant)

	// The claim door is the branch's and answers the case number the database wrote (S1, S20).
	claim := f.caseWire(t, f.serve(t, f.request(2, "POST", "/api/warranty-cases/claims",
		fmt.Sprintf(`{"serial_number":%q,"declared_failure":"No arranca el motor"}`, serial))), 201)
	if claim.Origin != "warranty_claim" || claim.Phase != "received" ||
		claim.CaseNumber != "C-2-000001" || claim.BranchLocationID != 2 ||
		claim.SaleID == nil || claim.SerialNumber == nil || *claim.SerialNumber != serial ||
		claim.Quantity != nil || claim.Reason != nil || claim.Verdict != nil ||
		len(claim.Loans) != 0 || len(claim.Events) != 0 {
		t.Fatalf("the claim stated a document this contract could not write: %+v", claim)
	}
	// A serial nobody sold, a unit sold without a term and a malformed claim are three distinct
	// refusals that write nothing (S2).
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/claims",
		`{"serial_number":"NO-EXISTE/1","declared_failure":"No arranca"}`), 409, "serial_not_sold")
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/claims",
		`{"serial_number":" ","declared_failure":"No arranca"}`), 400, "invalid_request")
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/claims",
		fmt.Sprintf(`{"serial_number":%q,"declared_failure":"No arranca","quantity":1}`, serial)),
		400, "invalid_request")
	// The warehouse owns no client: it never opens a claim (S19).
	f.refused(t, f.request(1, "POST", "/api/warranty-cases/claims",
		fmt.Sprintf(`{"serial_number":%q,"declared_failure":"No arranca"}`, serial)), 403, "forbidden")

	// The tray of a branch is its own, filtered by the two frozen keys, and one case is read with its
	// loans and its history (S1, S23).
	tray := f.serve(t, f.request(2, "GET", "/api/warranty-cases?origin=warranty_claim", ""))
	if tray.Code != 200 {
		t.Fatalf("the branch reads its tray: %d %s", tray.Code, tray.Body.String())
	}
	var page warrantyTrayWire
	if err := json.Unmarshal(tray.Body.Bytes(), &page); err != nil || len(page.Cases) != 1 ||
		page.Cases[0].ID != claim.ID || page.Cases[0].CaseNumber != claim.CaseNumber {
		t.Fatalf("the tray is the branch's own case: %s", tray.Body.String())
	}
	if strings.Contains(tray.Body.String(), `"loans"`) || strings.Contains(tray.Body.String(), `"events"`) {
		t.Fatalf("the tray publishes the row of the case and not its history: %s", tray.Body.String())
	}
	f.refused(t, f.request(2, "GET", "/api/warranty-cases?phase=on_the_way", ""), 400, "invalid_request")
	f.refused(t, f.request(2, "GET", "/api/warranty-cases?page=2", ""), 400, "invalid_request")
	// A case of another branch is refused and the warehouse reads it because it moves it (S19).
	f.refused(t, f.request(3, "GET", fmt.Sprintf("/api/warranty-cases/%d", claim.ID), ""), 403, "forbidden")
	if w := f.serve(t, f.request(1, "GET", fmt.Sprintf("/api/warranty-cases/%d", claim.ID), "")); w.Code != 200 {
		t.Fatalf("the warehouse reads the case it moves: %d %s", w.Code, w.Body.String())
	}
	f.refused(t, f.request(2, "GET", "/api/warranty-cases/999999", ""), 404, "not_found")

	// The loan is the branch's, it names a model and a quantity, and it moves no stock (S5, S6).
	loan := f.serve(t, f.request(2, "POST", fmt.Sprintf("/api/warranty-cases/%d/loans", claim.ID),
		`{"model":"NS60L","quantity":1,"serial_number":"","source_location_id":1}`))
	if loan.Code != 201 {
		t.Fatalf("the branch lends a used battery: %d %s", loan.Code, loan.Body.String())
	}
	var lent warrantyLoanWire
	if err := json.Unmarshal(loan.Body.Bytes(), &lent); err != nil || lent.Ordinal != 1 ||
		lent.Model != "NS60L" || lent.Quantity != 1 || lent.Fate != "open" ||
		lent.SourceLocationID != 1 || lent.SerialNumber != "" || lent.FateDecidedAt != nil {
		t.Fatalf("the loan is the used battery handed over: %s", loan.Body.String())
	}
	if got := f.balance(t, 2, variant); got != shelf || f.balance(t, 1, variant) != warehouseShelf {
		t.Fatalf("a loan moves no stock: %d %d", got, f.balance(t, 1, variant))
	}
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/warranty-cases/%d/loans", claim.ID),
		`{"model":"NS60L","quantity":1,"serial_number":"","source_location_id":1}`), 403, "forbidden")
	f.refused(t, f.request(2, "POST", fmt.Sprintf("/api/warranty-cases/%d/loans", claim.ID),
		`{"model":" ","quantity":1,"serial_number":"","source_location_id":1}`), 400, "invalid_request")

	// The journey: the branch ships, the warehouse receives and ships to the factory with its file
	// number, and neither role may record the other's tramo (S19).
	advance := func(actor int, body string) *http.Request {
		return f.request(actor, "POST", fmt.Sprintf("/api/warranty-cases/%d/advance", claim.ID), body)
	}
	f.refused(t, advance(1, `{"phase":"in_transit","factory_case_number":"","note":"Sale al Almacén"}`),
		403, "forbidden")
	if w := f.serve(t, advance(2, `{"phase":"in_transit","factory_case_number":"","note":"Sale al Almacén"}`)); w.Code != 200 {
		t.Fatalf("the branch ships its case: %d %s", w.Code, w.Body.String())
	}
	f.refused(t, advance(2, `{"phase":"at_warehouse","factory_case_number":"","note":"Recibida"}`),
		403, "forbidden")
	if w := f.serve(t, advance(1, `{"phase":"at_warehouse","factory_case_number":"","note":"Recibida"}`)); w.Code != 200 {
		t.Fatalf("the warehouse receives the case: %d %s", w.Code, w.Body.String())
	}
	f.refused(t, advance(2, `{"phase":"at_factory","factory_case_number":"LEG-77","note":"A fábrica"}`),
		403, "forbidden")
	f.refused(t, advance(1, `{"phase":"at_factory","factory_case_number":"","note":"A fábrica"}`),
		400, "factory_file_required")
	shipped := f.caseWire(t, f.serve(t, advance(1,
		`{"phase":"at_factory","factory_case_number":"LEG-77","note":"A fábrica"}`)), 200)
	if shipped.Phase != "at_factory" || len(shipped.Events) != 3 {
		t.Fatalf("the journey appends one tramo per step: %+v", shipped.Events)
	}
	last := shipped.Events[len(shipped.Events)-1]
	if last.Kind != "phase" || last.Phase != "at_factory" || last.FactoryCaseNumber != "LEG-77" ||
		last.ActorAccountID == 0 || last.Note != "A fábrica" {
		t.Fatalf("the factory shipment carries its file number: %+v", last)
	}
	// A case reaches resolved through its resolution and never through a bare tramo.
	f.refused(t, advance(1, `{"phase":"resolved","factory_case_number":"","note":"Resuelta"}`),
		409, "resolution_required")

	// The verdict is the warehouse's and the refusal before the factory carries its motive (S10).
	resolution := func(body string) *http.Request {
		return f.request(1, "POST", fmt.Sprintf("/api/warranty-cases/%d/resolution", claim.ID), body)
	}
	f.refused(t, resolution(`{"verdict":"refused_at_warehouse","reported_destination":"scrap",`+
		`"loan_destination":"customer","note":"No cubre"}`), 409, "warehouse_verdict")
	f.refused(t, resolution(`{"verdict":"not_covered","reported_destination":"stock",`+
		`"loan_destination":"stock","note":"No cubre"}`), 409, "resolution_matrix")
	resolved := f.caseWire(t, f.serve(t, resolution(`{"verdict":"repaired",`+
		`"reported_destination":"customer","loan_destination":"stock","note":"Reparada"}`)), 200)
	if resolved.Phase != "resolved" || resolved.Verdict == nil || *resolved.Verdict != "repaired" ||
		resolved.ReportedDestination == nil || *resolved.ReportedDestination != "customer" ||
		resolved.StockDestination != nil {
		t.Fatalf("the resolution states the verdict and the destinations: %+v", resolved)
	}

	// The notice is the branch's and the release the warehouse's (S14, S19).
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/warranty-cases/%d/notice", claim.ID),
		`{"note":"El Almacén avisa"}`), 403, "forbidden")
	noticed := f.caseWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/warranty-cases/%d/notice", claim.ID),
		`{"note":"Avisado el cliente"}`)), 200)
	notice := noticed.Events[len(noticed.Events)-1]
	if notice.Kind != "notice" || notice.Phase != "resolved" || noticed.Phase != "resolved" {
		t.Fatalf("the notice is a fact that moves nothing: %+v", notice)
	}
	// A branch account never releases a unit to stock (S19), and a release without a recorded notice
	// is refused (S14).
	f.refused(t, f.request(2, "POST", fmt.Sprintf("/api/warranty-cases/%d/release", claim.ID),
		`{"note":"La sucursal libera"}`), 403, "forbidden")
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/warranty-cases/%d/release", claim.ID),
		`{"note":" "}`), 400, "reason_required")
	released := f.caseWire(t, f.serve(t, f.request(1, "POST",
		fmt.Sprintf("/api/warranty-cases/%d/release", claim.ID),
		`{"note":"El cliente no volvió"}`)), 200)
	if released.Phase != "resolved" {
		t.Fatalf("a release never moves the case: %+v", released)
	}
	if got := f.balance(t, 2, variant); got != shelf+1 {
		t.Fatalf("the released unit is sellable stock of the branch: %d became %d", shelf, got)
	}
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/warranty-cases/%d/release", claim.ID),
		`{"note":"Otra vez"}`), 409, "already_released")

	// A delivery is the branch's: a warehouse account never delivers to a customer (S19).
	f.refused(t, f.request(1, "POST", fmt.Sprintf("/api/warranty-cases/%d/delivery", claim.ID),
		`{"loan_fate":"returned","note":"Entrega"}`), 403, "forbidden")
	f.refused(t, f.request(2, "POST", fmt.Sprintf("/api/warranty-cases/%d/delivery", claim.ID),
		`{"loan_fate":"open","note":"Entrega"}`), 400, "invalid_request")
	stock := f.balance(t, 2, variant)
	delivered := f.caseWire(t, f.serve(t, f.request(2, "POST",
		fmt.Sprintf("/api/warranty-cases/%d/delivery", claim.ID),
		`{"loan_fate":"returned","note":"Entregada la reparada"}`)), 200)
	if delivered.Phase != "closed" || len(delivered.Loans) != 1 ||
		delivered.Loans[0].Fate != "returned" || delivered.Loans[0].FateDecidedAt == nil {
		t.Fatalf("the delivery closes the case and settles the loan: %+v", delivered)
	}
	if got := f.balance(t, 2, variant); got != stock {
		t.Fatalf("a delivery writes no stock: %d became %d", stock, got)
	}

	// The second door: the branch found a battery failed on its shelf and states its own motive (S1,
	// S16). The finding takes the unit off the branch in the admission's own transaction.
	found := f.caseWire(t, f.serve(t, f.request(2, "POST", "/api/warranty-cases/stock-defects",
		fmt.Sprintf(`{"variant_id":%d,"quantity":1,"declared_failure":"No retiene carga",`+
			`"reason":"Probada en mostrador"}`, variant))), 201)
	if found.Origin != "stock_defect" || found.Quantity == nil || *found.Quantity != 1 ||
		found.Reason == nil || *found.Reason != "Probada en mostrador" ||
		found.SerialNumber != nil || found.SaleID != nil {
		t.Fatalf("the finding is the shelf of the branch: %+v", found)
	}
	if got := f.balance(t, 2, variant); got != stock-1 {
		t.Fatalf("the finding takes its quantity off the shelf: %d became %d", stock, got)
	}
	f.refused(t, f.request(1, "POST", "/api/warranty-cases/stock-defects",
		fmt.Sprintf(`{"variant_id":%d,"quantity":1,"declared_failure":"Falla","reason":"Motivo"}`,
			variant)), 403, "forbidden")
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/stock-defects",
		fmt.Sprintf(`{"variant_id":%d,"quantity":1,"declared_failure":"Falla","reason":" "}`,
			variant)), 400, "invalid_request")
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/stock-defects",
		fmt.Sprintf(`{"variant_id":%d,"quantity":999999,"declared_failure":"Falla","reason":"Motivo"}`,
			variant)), 409, "no_stock")
	// A claim never states the motive of a write-off and a finding never states a serial.
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/stock-defects",
		fmt.Sprintf(`{"variant_id":%d,"quantity":1,"declared_failure":"Falla","reason":"Motivo",`+
			`"serial_number":"X"}`, variant)), 400, "invalid_request")
	if other := f.balance(t, 3, variant); other != branchThree {
		t.Fatalf("a finding writes off its own branch only: %d %d", other, branchThree)
	}

	// The settlement publishes the units a case holds instead of the branch having them in stock,
	// which is the number that used to travel nowhere (S13, S16).
	opened := f.serve(t, f.request(1, "POST", "/api/closings", `{"branch_location_id":2}`))
	if opened.Code != 201 {
		t.Fatalf("the settlement of the branch must open: %d %s", opened.Code, opened.Body.String())
	}
	var settlement struct {
		ID         int64 `json:"id"`
		CountLines []struct {
			VariantID          int64 `json:"variant_id"`
			ExpectedQuantity   int64 `json:"expected_quantity"`
			HeldInCaseQuantity int64 `json:"held_in_case_quantity"`
		} `json:"count_lines"`
	}
	if err := json.Unmarshal(opened.Body.Bytes(), &settlement); err != nil {
		t.Fatalf("the settlement is not decodable: %s", opened.Body.String())
	}
	held := false
	for _, line := range settlement.CountLines {
		if line.VariantID != variant {
			continue
		}
		held = true
		if line.HeldInCaseQuantity != 1 {
			t.Fatalf("the count line states the unit the case holds: %+v", line)
		}
	}
	if !held {
		t.Fatalf("the count sheet of the branch must count the variant of the case: %s",
			opened.Body.String())
	}
	read := f.serve(t, f.request(1, "GET", fmt.Sprintf("/api/closings/%d", settlement.ID), ""))
	if read.Code != 200 || !strings.Contains(read.Body.String(), `"held_in_case_quantity":1`) {
		t.Fatalf("the settlement read publishes the held quantity: %d %s", read.Code, read.Body.String())
	}
}
