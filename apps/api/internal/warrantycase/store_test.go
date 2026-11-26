package warrantycase_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
	"luson/api/internal/warrantycase"
)

// fixture is one isolated database with the schema of every embedded migration and the
// smallest catalogue, branch, account, balance and price a battery sale needs. The sale
// documents are written directly because the claim is judged against the sales ledger, not
// against the point of sale.
type fixture struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	store    *warrantycase.Store
	accounts map[int]int
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatalf("the embedded migrations could not be applied: %v", err)
	}
	f := &fixture{ctx: ctx, pool: p, store: warrantycase.New(p), accounts: map[int]int{}}
	for _, statement := range []string{
		`INSERT INTO locations(id,name) VALUES(1,'Almacén'),(2,'Sucursal A'),(3,'Sucursal B')`,
		`INSERT INTO catalog_entries(id,brand,model,capacity_ah) VALUES(1,'Yuasa','NP7-12',7)`,
		`INSERT INTO catalog_variants(id,catalog_entry_id,polarity) VALUES(1,1,'L')`,
	} {
		if _, err := p.Exec(ctx, statement); err != nil {
			t.Fatalf("the fixture could not be provisioned: %v", err)
		}
	}
	for location := 1; location <= 3; location++ {
		var account int
		if err := p.QueryRow(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES($1,$2,'x') RETURNING id`, location, "cuenta"+string(rune('0'+location))).Scan(&account); err != nil {
			t.Fatalf("the account of location %d could not be provisioned: %v", location, err)
		}
		f.accounts[location] = account
	}
	for _, statement := range []string{
		`INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(1,1,10,0),(2,1,10,0),(3,1,10,0)`,
		`INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,
 updated_by_account_id) VALUES(2,1,0.01,100.00,1)`,
	} {
		if _, err := p.Exec(ctx, statement); err != nil {
			t.Fatalf("the fixture could not be provisioned: %v", err)
		}
	}
	return f
}

func (f *fixture) actor(location int) auth.Identity {
	return auth.Identity{AccountID: f.accounts[location], Location: auth.Location{ID: location}}
}

func (f *fixture) sell(t *testing.T, branch int, serial string, months *int, soldAt time.Time) int64 {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatalf("the sale transaction could not start: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var sale int64
	if err := tx.QueryRow(f.ctx, `INSERT INTO sales(branch_location_id,cash_amount,
 customer_name,customer_phone,customer_document,total,created_by_account_id,created_at)
 VALUES($1,'100.00','Cliente de garantía','700-00000','CI-123456',100.00,$2,$3)
 RETURNING id`, branch, f.accounts[branch], soldAt).Scan(&sale); err != nil {
		t.Fatalf("the sale header could not be stored: %v", err)
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,100.00)`, sale); err != nil {
		t.Fatalf("the sale line could not be stored: %v", err)
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,
 serial_number,warranty_months) VALUES($1,1,1,$2,$3)`, sale, serial, months); err != nil {
		t.Fatalf("the sold unit could not be stored: %v", err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatalf("the sale must commit: %v", err)
	}
	return sale
}

func months(value int) *int { return &value }

func (f *fixture) count(t *testing.T, table string) int {
	t.Helper()
	var rows int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM `+table).Scan(&rows); err != nil {
		t.Fatalf("the rows of %s could not be counted: %v", table, err)
	}
	return rows
}

func (f *fixture) unit(t *testing.T, serial string) (int, *int) {
	t.Helper()
	var rows int
	var term *int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*),min(warranty_months)
 FROM sale_units WHERE serial_number=$1`, serial).Scan(&rows, &term); err != nil {
		t.Fatalf("the sold unit could not be read: %v", err)
	}
	return rows, term
}

func (f *fixture) balances(t *testing.T) string {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT location_id,variant_id,existing,reserved
 FROM inventory_balances ORDER BY location_id,variant_id`)
	if err != nil {
		t.Fatalf("the stock matrix could not be read: %v", err)
	}
	defer rows.Close()
	matrix := ""
	for rows.Next() {
		var location, variant int
		var existing, reserved int64
		if err := rows.Scan(&location, &variant, &existing, &reserved); err != nil {
			t.Fatalf("a balance row could not be read: %v", err)
		}
		matrix += fmt.Sprintf("%d:%d=%d/%d,", location, variant, existing, reserved)
	}
	if rows.Err() != nil {
		t.Fatalf("the stock matrix could not be read: %v", rows.Err())
	}
	return matrix
}

func (f *fixture) read(t *testing.T, id int64) warrantycase.Case {
	t.Helper()
	document, err := f.store.Read(f.ctx, f.actor(2), id)
	if err != nil {
		t.Fatalf("the case %d must be readable: %v", id, err)
	}
	return document
}

// TestOpenClaimJudgesTheSaleAndKeepsItsTerm pins the claim door (S2, S3): a serial nobody
// sold, a unit sold without a term and a term that has run out are three distinct refusals
// that write no case, a covered claim resolves its sale and variant from the serial, and
// neither the claim nor its resolution ever writes a sold unit.
func TestOpenClaimJudgesTheSaleAndKeepsItsTerm(t *testing.T) {
	f := newFixture(t)
	covered := f.sell(t, 2, "CUB-1/1", months(12), time.Now())
	f.sell(t, 2, "SIN-GARANTIA/1", nil, time.Now())
	f.sell(t, 2, "VENCIDA/1", months(12), time.Now().AddDate(-1, -2, 0))

	before := f.count(t, "warranty_cases")
	for _, refused := range []struct {
		serial string
		want   error
	}{
		{"NO-EXISTE/1", warrantycase.ErrSerialNotSold},
		{"SIN-GARANTIA/1", warrantycase.ErrNoWarranty},
		{"VENCIDA/1", warrantycase.ErrWarrantyExpired},
	} {
		_, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
			SerialNumber: refused.serial, DeclaredFailure: "No arranca el motor"})
		if !errors.Is(err, refused.want) {
			t.Fatalf("the claim of %s must be refused as %v, got %v", refused.serial, refused.want, err)
		}
	}
	// The warehouse never opens a case and a malformed claim never reaches the database.
	for _, refused := range []struct {
		actor  auth.Identity
		input  warrantycase.OpenClaimInput
		wanted error
	}{
		{f.actor(1), warrantycase.OpenClaimInput{SerialNumber: "CUB-1/1", DeclaredFailure: "Falla"}, warrantycase.ErrForbidden},
		{f.actor(2), warrantycase.OpenClaimInput{SerialNumber: " ", DeclaredFailure: "Falla"}, warrantycase.ErrInvalid},
		{f.actor(2), warrantycase.OpenClaimInput{SerialNumber: "CUB-1/1", DeclaredFailure: " "}, warrantycase.ErrInvalid},
	} {
		if _, err := f.store.OpenClaim(f.ctx, refused.actor, refused.input); !errors.Is(err, refused.wanted) {
			t.Fatalf("the claim must be refused as %v, got %v", refused.wanted, err)
		}
	}
	if after := f.count(t, "warranty_cases"); after != before {
		t.Fatalf("a refused claim writes no case: %d before, %d after", before, after)
	}

	claim, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: " cub-1/1 ", DeclaredFailure: " No arranca el motor "})
	if err != nil {
		t.Fatalf("the covered claim must be admitted: %v", err)
	}
	if claim.Origin != warrantycase.OriginWarrantyClaim || claim.Phase != warrantycase.PhaseReceived {
		t.Fatalf("a claim is born received under its own origin, got %s:%s", claim.Origin, claim.Phase)
	}
	if claim.SaleID == nil || *claim.SaleID != covered {
		t.Fatalf("the claim is the sale of its serial, got sale=%v", claim.SaleID)
	}
	if claim.VariantID != 1 {
		t.Fatalf("the claim is the variant of its sale, got %d", claim.VariantID)
	}
	if claim.SerialNumber == nil || *claim.SerialNumber != "cub-1/1" {
		t.Fatalf("the serial is stored trimmed exactly as written, got %v", claim.SerialNumber)
	}
	if claim.DeclaredFailure != "No arranca el motor" {
		t.Fatalf("the declaration is stored trimmed, got %q", claim.DeclaredFailure)
	}
	if claim.CaseNumber != "C-2-000001" || claim.BranchSequence != 1 {
		t.Fatalf("the case number is the branch's own, got %d:%s", claim.BranchSequence, claim.CaseNumber)
	}
	if claim.Verdict != nil || claim.ReportedDestination != nil || claim.LoanDestination != nil ||
		claim.StockDestination != nil {
		t.Fatalf("a fresh claim states no resolution: %+v", claim)
	}

	read, err := f.store.Read(f.ctx, f.actor(2), claim.ID)
	if err != nil {
		t.Fatalf("the claim must be readable: %v", err)
	}
	if len(read.Loans) != 0 || len(read.Events) != 0 {
		t.Fatalf("a fresh claim has no loans and no tramo: %+v", read)
	}
	if read.CaseNumber != claim.CaseNumber || read.Phase != claim.Phase {
		t.Fatalf("the read document must be the written one: %+v", read)
	}
	if rows, term := f.unit(t, "CUB-1/1"); rows != 1 || term == nil || *term != 12 {
		t.Fatalf("opening a claim never rewrites the sold unit: %d rows, term %v", rows, term)
	}
}

// openClaim sells a covered battery and opens its claim, so a loan test only states the
// case it lends on.
func (f *fixture) openClaim(t *testing.T, serial string) warrantycase.Case {
	t.Helper()
	f.sell(t, 2, serial, months(12), time.Now())
	claim, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: serial, DeclaredFailure: "No arranca el motor"})
	if err != nil {
		t.Fatalf("the claim of %s must be admitted: %v", serial, err)
	}
	return claim
}

// TestLoansAreModelsAndQuantitiesFromAnywhere pins S5, S6 and S7 on the claim door: two loans
// of the same model and quantity are independent, the optional serial identifies nothing, the
// source may be the case's branch, the warehouse or another branch, no stock or transfer moves,
// and a failed loan is marked and replaced on the same case.
func TestLoansAreModelsAndQuantitiesFromAnywhere(t *testing.T) {
	f := newFixture(t)
	// Every location the counter can lend from holds the battery it hands over (S25): the two
	// branches bought four and two of one model, and the warehouse got one back from the factory.
	f.fund(t, 2, "1000.00")
	f.fund(t, 3, "1000.00")
	f.buyUsed(t, 2, "loans-anywhere-0001", "YUASA NP7-12", 4, "10.00", "40.00")
	f.buyUsed(t, 3, "loans-anywhere-0002", "YUASA NP7-12", 2, "10.00", "20.00")
	returned := f.openClaim(t, "PRESTAMO/0")
	f.atFactory(t, returned)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), returned.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer, Note: "Fábrica rechazó la garantía"}); err != nil {
		t.Fatalf("the factory refusal must be admitted: %v", err)
	}
	claim := f.openClaim(t, "PRESTAMO/1")
	balances := f.balances(t)
	transfers := f.count(t, "transfer_requests")
	claims := f.count(t, "warranty_cases")
	bought := f.count(t, "purchase_used_lines")

	first, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "yuasa np7-12", Quantity: 2, SerialNumber: " USADA-1 ", SourceLocationID: 2})
	if err != nil {
		t.Fatalf("the first loan must be admitted: %v", err)
	}
	if first.Ordinal != 1 || first.Model != "YUASA NP7-12" || first.Quantity != 2 ||
		first.SerialNumber != "USADA-1" || first.SourceLocationID != 2 ||
		first.Fate != warrantycase.LoanOpen || first.FateDecidedAt != nil {
		t.Fatalf("the loan states its model, quantity, source and open fate: %+v", first)
	}
	// The same model from the warehouse and from another branch: a serial is never identity, and the
	// three loans are three independent rows of one case (S5, S6). The warehouse's battery is the one
	// the factory refused and returned to the pool, under the catalogue's model (S27).
	for _, next := range []struct {
		source, ordinal int
		model           string
		quantity        int64
	}{{1, 2, "NP7-12", 1}, {3, 3, "YUASA NP7-12", 2}} {
		loan, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
			Model: next.model, Quantity: next.quantity, SerialNumber: "USADA-1",
			SourceLocationID: next.source})
		if err != nil {
			t.Fatalf("a loan from source %d must be admitted: %v", next.source, err)
		}
		if loan.Ordinal != next.ordinal {
			t.Fatalf("the loans of one case are numbered in order: wanted %d, got %d",
				next.ordinal, loan.Ordinal)
		}
	}
	// A loan without a model, without a quantity or with a source no location can have is
	// refused before it reaches the database.
	for _, refused := range []warrantycase.LoanInput{
		{Model: " ", Quantity: 1, SourceLocationID: 2},
		{Model: "YUASA NP7-12", Quantity: 0, SourceLocationID: 2},
		{Model: "YUASA NP7-12", Quantity: 10001, SourceLocationID: 2},
		{Model: "YUASA NP7-12", Quantity: 1, SerialNumber: strings.Repeat("A", 65), SourceLocationID: 2},
		{Model: "YUASA NP7-12", Quantity: 1, SourceLocationID: 0},
		{Model: "YUASA NP7-12", Quantity: 1, SourceLocationID: 40000},
	} {
		if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, refused); !errors.Is(err, warrantycase.ErrInvalid) {
			t.Fatalf("the malformed loan must be refused as invalid, got %v", err)
		}
	}
	// A loan is a fact of the case's branch: the warehouse does not lend and another branch
	// does not lend into this case.
	if _, err := f.store.AddLoan(f.ctx, f.actor(1), claim.ID, warrantycase.LoanInput{
		Model: "YUASA NP7-12", Quantity: 1, SourceLocationID: 1}); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("the warehouse cannot lend, got %v", err)
	}
	if _, err := f.store.AddLoan(f.ctx, f.actor(3), claim.ID, warrantycase.LoanInput{
		Model: "YUASA NP7-12", Quantity: 1, SourceLocationID: 3}); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("another branch cannot lend into this case, got %v", err)
	}
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), 999999, warrantycase.LoanInput{
		Model: "YUASA NP7-12", Quantity: 1, SourceLocationID: 2}); !errors.Is(err, warrantycase.ErrNotFound) {
		t.Fatalf("a loan requires a persisted case, got %v", err)
	}
	if got := f.balances(t); got != balances {
		t.Fatalf("a loan moves no stock: %s became %s", balances, got)
	}
	if got := f.count(t, "transfer_requests"); got != transfers {
		t.Fatalf("a loan writes no transfer: %d became %d", transfers, got)
	}
	if got := f.count(t, "purchase_used_lines"); got != bought {
		t.Fatalf("a loan buys no used battery: %d lines became %d", bought, got)
	}
	if got := f.count(t, "warranty_cases"); got != claims {
		t.Fatalf("loans never open another case, got %d cases", got)
	}

	// A failed loan is marked and replaced by another loan of the same case, never by a new
	// case; a decided fate is final (S7).
	failed, err := f.store.DecideLoan(f.ctx, f.actor(2), claim.ID, 1, warrantycase.LoanFailed)
	if err != nil {
		t.Fatalf("a failed loan must be markable: %v", err)
	}
	if failed.Fate != warrantycase.LoanFailed || failed.FateDecidedAt == nil {
		t.Fatalf("a decided fate is dated by the database: %+v", failed)
	}
	if _, err := f.store.DecideLoan(f.ctx, f.actor(2), claim.ID, 1, warrantycase.LoanReturned); !errors.Is(err, warrantycase.ErrLoanFateFinal) {
		t.Fatalf("a decided fate is final, got %v", err)
	}
	if _, err := f.store.DecideLoan(f.ctx, f.actor(2), claim.ID, 2, warrantycase.LoanOpen); !errors.Is(err, warrantycase.ErrInvalid) {
		t.Fatalf("a loan is born open and a caller never states it, got %v", err)
	}
	replacement, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "YUASA NP7-12", Quantity: 2, SourceLocationID: 2})
	if err != nil || replacement.Ordinal != 4 {
		t.Fatalf("the replacement is the next loan of the same case: %+v %v", replacement, err)
	}
	if got := f.count(t, "warranty_cases"); got != claims {
		t.Fatalf("a replacement loan never opens another case, got %d cases", got)
	}
	read, err := f.store.Read(f.ctx, f.actor(2), claim.ID)
	if err != nil {
		t.Fatalf("the case must be readable: %v", err)
	}
	if len(read.Loans) != 4 || read.Loans[0].Fate != warrantycase.LoanFailed ||
		read.Loans[1].Fate != warrantycase.LoanOpen || read.Loans[3].Ordinal != 4 {
		t.Fatalf("the case keeps every loan with its own fate: %+v", read.Loans)
	}
}

// TestAdvanceFollowsTheFrozenOrder pins S9 and S10 on the claim door: the journey moves only
// forward through its frozen phases, a tramo outside the order writes nothing, only the
// factory shipment carries the factory file number, the warehouse can receive and ship the
// case, and every admitted tramo is an append-only event with its actor, instant and note.
func TestAdvanceFollowsTheFrozenOrder(t *testing.T) {
	f := newFixture(t)
	claim := f.openClaim(t, "VIAJE/1")

	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtFactory, FactoryCaseNumber: "LEGAJO-1"}); !errors.Is(err, warrantycase.ErrTransition) {
		t.Fatalf("a case cannot skip the journey, got %v", err)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: "shipped"}); !errors.Is(err, warrantycase.ErrInvalid) {
		t.Fatalf("a phase outside the frozen list is invalid, got %v", err)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(3), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseInTransit}); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("another branch cannot move this case, got %v", err)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(2), 999999, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseInTransit}); !errors.Is(err, warrantycase.ErrNotFound) {
		t.Fatalf("an unknown case cannot move, got %v", err)
	}
	if events := len(f.read(t, claim.ID).Events); events != 0 {
		t.Fatalf("a refused transition writes nothing, got %d events", events)
	}

	moved, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseInTransit, Note: " Enviada al Almacén "})
	if err != nil {
		t.Fatalf("the branch must be able to send the case: %v", err)
	}
	if moved.Phase != warrantycase.PhaseInTransit {
		t.Fatalf("the case is in transit, got %s", moved.Phase)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseInTransit}); !errors.Is(err, warrantycase.ErrTransition) {
		t.Fatalf("a phase the case already holds is not a transition, got %v", err)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtWarehouse, Note: "Recibida y revisada"}); err != nil {
		t.Fatalf("the warehouse must receive the case: %v", err)
	}
	// The factory shipment carries its file number; no other tramo does (S9, S10).
	if _, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtFactory}); !errors.Is(err, warrantycase.ErrFactoryFileRequired) {
		t.Fatalf("the factory shipment requires its file number, got %v", err)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtWarehouse, FactoryCaseNumber: "LEGAJO-1"}); !errors.Is(err, warrantycase.ErrFactoryFileOnlyOnShipment) {
		t.Fatalf("only the factory shipment carries the file number, got %v", err)
	}
	if events := len(f.read(t, claim.ID).Events); events != 2 {
		t.Fatalf("the refused shipments write nothing, got %d events", events)
	}
	shipped, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtFactory, FactoryCaseNumber: " LEGAJO-77 ", Note: "Enviada a fábrica"})
	if err != nil {
		t.Fatalf("the warehouse must be able to ship the case: %v", err)
	}
	if shipped.Phase != warrantycase.PhaseAtFactory {
		t.Fatalf("the case is at the factory, got %s", shipped.Phase)
	}
	// Resolution is not a bare transition and the case is not closed from the factory.
	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseResolved}); !errors.Is(err, warrantycase.ErrResolutionRequired) {
		t.Fatalf("resolved arrives through its resolution, got %v", err)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseClosed}); !errors.Is(err, warrantycase.ErrTransition) {
		t.Fatalf("a case is not closed from the factory, got %v", err)
	}

	read := f.read(t, claim.ID)
	if len(read.Events) != 3 {
		t.Fatalf("every admitted tramo is one event, got %+v", read.Events)
	}
	for index, expected := range []struct {
		phase warrantycase.Phase
		note  string
		actor int
	}{
		{warrantycase.PhaseInTransit, "Enviada al Almacén", f.accounts[2]},
		{warrantycase.PhaseAtWarehouse, "Recibida y revisada", f.accounts[1]},
		{warrantycase.PhaseAtFactory, "Enviada a fábrica", f.accounts[1]},
	} {
		event := read.Events[index]
		if event.Ordinal != index+1 || event.Phase != expected.phase ||
			event.Note != expected.note || event.ActorAccountID != int64(expected.actor) ||
			event.RecordedAt.IsZero() {
			t.Fatalf("tramo %d states its phase, actor, instant and note: %+v", index+1, event)
		}
		if want := ""; index == 2 {
			want = "LEGAJO-77"
		} else if event.FactoryCaseNumber != want {
			t.Fatalf("only the factory tramo carries the file number, got %+v", event)
		}
	}
}

// atWarehouse sends a fresh claim to the warehouse, so a resolution test only states the
// phase it resolves from.
func (f *fixture) atWarehouse(t *testing.T, claim warrantycase.Case) {
	t.Helper()
	for _, step := range []struct {
		actor auth.Identity
		phase warrantycase.Phase
	}{
		{f.actor(2), warrantycase.PhaseInTransit},
		{f.actor(1), warrantycase.PhaseAtWarehouse},
	} {
		if _, err := f.store.Advance(f.ctx, step.actor, claim.ID, warrantycase.AdvanceInput{
			Phase: step.phase}); err != nil {
			t.Fatalf("the case must reach %s: %v", step.phase, err)
		}
	}
}

// atFactory sends a fresh claim through the warehouse to the factory with its file number.
func (f *fixture) atFactory(t *testing.T, claim warrantycase.Case) {
	t.Helper()
	f.atWarehouse(t, claim)
	if _, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtFactory, FactoryCaseNumber: "LEGAJO-" + claim.CaseNumber}); err != nil {
		t.Fatalf("the case must reach the factory: %v", err)
	}
}

// TestResolveStatesTheVerdictAndTheDestinationsOfTheClaim pins S11 on the claim door: the
// warehouse refuses before the factory with its own verdict and a mandatory motive, the
// factory verdicts arrive at the factory, `not_covered` leaves the loan with the client and
// the damaged unit in the used pool, a claim never states a stock destination, a resolution
// is final, and no resolution touches inventory_balances or the sold units (S3, S11).
func TestResolveStatesTheVerdictAndTheDestinationsOfTheClaim(t *testing.T) {
	f := newFixture(t)
	// Every case is opened and sent on its way before the stock matrix is read, because a
	// sale decrements the branch's balance and only the resolution is under test here.
	claim := f.openClaim(t, "RESOLUCION/1")
	f.atWarehouse(t, claim)
	second := f.openClaim(t, "RESOLUCION/2")
	f.atWarehouse(t, second)
	third := f.openClaim(t, "RESOLUCION/3")
	f.atFactory(t, third)
	fourth := f.openClaim(t, "RESOLUCION/4")
	f.atFactory(t, fourth)
	fifth := f.openClaim(t, "RESOLUCION/5")
	f.atFactory(t, fifth)
	balances := f.balances(t)
	units := f.count(t, "sale_units")
	for _, refused := range []struct {
		input warrantycase.ResolutionInput
		want  error
	}{
		{warrantycase.ResolutionInput{Verdict: "refunded", ReportedDestination: warrantycase.DestinationCustomer,
			LoanDestination: warrantycase.DestinationStock}, warrantycase.ErrInvalid},
		{warrantycase.ResolutionInput{Verdict: warrantycase.VerdictRepaired,
			ReportedDestination: warrantycase.DestinationCustomer}, warrantycase.ErrInvalid},
		{warrantycase.ResolutionInput{Verdict: warrantycase.VerdictNotCovered,
			ReportedDestination: warrantycase.DestinationStock,
			LoanDestination:     warrantycase.DestinationStock}, warrantycase.ErrMatrix},
		{warrantycase.ResolutionInput{Verdict: warrantycase.VerdictRepaired,
			ReportedDestination: warrantycase.DestinationCustomer,
			LoanDestination:     warrantycase.DestinationStock}, warrantycase.ErrWarehouseVerdict},
		{warrantycase.ResolutionInput{Verdict: warrantycase.VerdictRefusedAtWarehouse,
			ReportedDestination: warrantycase.DestinationCustomer,
			LoanDestination:     warrantycase.DestinationStock}, warrantycase.ErrNoteRequired},
	} {
		if _, err := f.store.Resolve(f.ctx, f.actor(2), claim.ID, refused.input); !errors.Is(err, refused.want) {
			t.Fatalf("the resolution must be refused as %v, got %v", refused.want, err)
		}
	}
	if read := f.read(t, claim.ID); read.Verdict != nil || len(read.Events) != 2 {
		t.Fatalf("a refused resolution writes nothing: %+v", read)
	}

	// The warehouse refuses before the factory: its own verdict, its motive, no shipment and
	// no file number (S10).
	refused, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict:             warrantycase.VerdictRefusedAtWarehouse,
		ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination:     warrantycase.DestinationStock,
		Note:                " No cubre la garantía "})
	if err != nil {
		t.Fatalf("the warehouse must be able to refuse the claim: %v", err)
	}
	if refused.Phase != warrantycase.PhaseResolved || refused.Verdict == nil ||
		*refused.Verdict != warrantycase.VerdictRefusedAtWarehouse ||
		refused.ReportedDestination == nil || *refused.ReportedDestination != warrantycase.DestinationCustomer ||
		refused.LoanDestination == nil || *refused.LoanDestination != warrantycase.DestinationStock ||
		refused.StockDestination != nil {
		t.Fatalf("the warehouse refusal states its verdict and destinations: %+v", refused)
	}
	read := f.read(t, claim.ID)
	if last := read.Events[len(read.Events)-1]; last.Phase != warrantycase.PhaseResolved ||
		last.FactoryCaseNumber != "" {
		t.Fatalf("a warehouse refusal records no factory shipment: %+v", last)
	}
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer}); !errors.Is(err, warrantycase.ErrResolutionFinal) {
		t.Fatalf("a resolution is final, got %v", err)
	}
	closed, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseClosed, Note: "Devuelta al cliente"})
	if err != nil || closed.Phase != warrantycase.PhaseClosed {
		t.Fatalf("a resolved case closes: %+v %v", closed, err)
	}

	// The factory verdicts arrive at the factory and never at the warehouse.
	if _, err := f.store.Resolve(f.ctx, f.actor(1), second.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictRefusedAtWarehouse, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "No cubre"}); err != nil {
		t.Fatalf("the warehouse refusal is admitted at the warehouse: %v", err)
	}
	if _, err := f.store.Resolve(f.ctx, f.actor(1), third.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictRefusedAtWarehouse, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "No cubre"}); !errors.Is(err, warrantycase.ErrWarehouseVerdict) {
		t.Fatalf("the warehouse refuses before the factory, got %v", err)
	}

	// `not_covered` leaves the loan with the client and the damaged unit in the used pool
	// (S11); a claim never states a stock destination.
	notCovered, err := f.store.Resolve(f.ctx, f.actor(1), third.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer, Note: "Fábrica rechazó la garantía"})
	if err != nil {
		t.Fatalf("the factory verdict must be admitted: %v", err)
	}
	if notCovered.Verdict == nil || *notCovered.Verdict != warrantycase.VerdictNotCovered ||
		notCovered.ReportedDestination == nil || *notCovered.ReportedDestination != warrantycase.DestinationStock ||
		notCovered.LoanDestination == nil || *notCovered.LoanDestination != warrantycase.DestinationCustomer ||
		notCovered.StockDestination != nil {
		t.Fatalf("not_covered states the used pool and the client: %+v", notCovered)
	}
	if _, err := f.store.Resolve(f.ctx, f.actor(1), fourth.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationStock}); !errors.Is(err, warrantycase.ErrMatrix) {
		t.Fatalf("not_covered leaves the loan with the client, got %v", err)
	}
	// `replaced` of a claim never touches the stock matrix (S11).
	replaced, err := f.store.Resolve(f.ctx, f.actor(1), fifth.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictReplaced, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "Fábrica repuso la unidad"})
	if err != nil || replaced.Verdict == nil || *replaced.Verdict != warrantycase.VerdictReplaced {
		t.Fatalf("replaced of a claim must be admitted: %+v %v", replaced, err)
	}
	if got := f.balances(t); got != balances {
		t.Fatalf("a claim resolution never touches inventory_balances: %s became %s", balances, got)
	}
	if got := f.count(t, "sale_units"); got != units {
		t.Fatalf("a resolution never writes a sold unit: %d became %d", units, got)
	}
}

// TestReleaseRefusesACaseWithAnUndecidedLoan pins S32 on the store: the release that closes a case
// whose unit is bound for stock returns the sentinel instead of closing while a loan of that case is
// still `open`, and it writes nothing at all; once the branch decides, the same release closes the
// case exactly as 073 states it.
func TestReleaseRefusesACaseWithAnUndecidedLoan(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "undecided-loan-0001", "NS60L", 1, "10.00", "10.00")
	claim := f.openClaim(t, "DECIDIR/1")
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60L", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the branch lends the used battery of the case: %v", err)
	}
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictRepaired, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer, Note: "Reparada: el cliente no la retira"}); err != nil {
		t.Fatalf("the factory returns the usable unit to the branch's shelf: %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch notifies the client of its own case: %v", err)
	}
	events := len(f.read(t, claim.ID).Events)
	shelf := f.existing(t, 2, 1)
	stock := f.balances(t)

	// The release is the act that closes this case, and it states nothing about the fate of the loan:
	// closing with one still open leaves the unit counted in the wrong place for ever (S32).
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID,
		"El cliente no la retira"); !errors.Is(err, warrantycase.ErrCaseHasOpenLoan) {
		t.Fatalf("a case does not close with an undecided loan, got %v", err)
	}
	read := f.read(t, claim.ID)
	if read.Phase != warrantycase.PhaseResolved || len(read.Events) != events {
		t.Fatalf("a refused release writes nothing: %+v", read)
	}
	if len(read.Loans) != 1 || read.Loans[0].Fate != warrantycase.LoanOpen ||
		read.Loans[0].FateDecidedAt != nil {
		t.Fatalf("the release decides no loan fate: %+v", read.Loans)
	}
	if got := f.existing(t, 2, 1); got != shelf {
		t.Fatalf("a refused release writes no stock: %d became %d", shelf, got)
	}
	if got := f.balances(t); got != stock {
		t.Fatalf("a refused release moves no balance: %s became %s", stock, got)
	}

	// The branch decides and the release closes the case and sells its unit exactly as before.
	if _, err := f.store.DecideLoan(f.ctx, f.actor(2), claim.ID, 1,
		warrantycase.LoanKeptByCustomer); err != nil {
		t.Fatalf("the branch decides the fate of the loan: %v", err)
	}
	released, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "El cliente no la retira")
	if err != nil {
		t.Fatalf("a case whose loans are all decided is released: %v", err)
	}
	if released.Phase != warrantycase.PhaseClosed {
		t.Fatalf("the release closes the case bound for stock, got %s", released.Phase)
	}
	if len(released.Loans) != 1 || released.Loans[0].Fate != warrantycase.LoanKeptByCustomer {
		t.Fatalf("the release never rewrites the fate the branch decided: %+v", released.Loans)
	}
	if got := f.existing(t, 2, 1); got != shelf+1 {
		t.Fatalf("the released unit is sellable stock: %d became %d", shelf, got)
	}
}
