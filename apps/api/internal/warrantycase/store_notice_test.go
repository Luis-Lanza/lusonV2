package warrantycase_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/warrantycase"
)

// The second door, the tray of a branch, and the three facts S14 and S19 add to the history: the
// notice the branch registers, the release the warehouse authorises and the delivery that closes the
// case. Nothing here is judged by the store alone -- the database refuses every one of them too -- but
// the refusals below are the ones this package answers before touching a document.

// TestOpenStockDefectTakesTheShelfOfItsBranch pins the second entry door (S1, S16): the branch states
// the variant, the quantity and its motive, the database writes the stock off in the admission's own
// transaction, and a quantity, a variant or a motive the branch cannot state writes no case at all.
func TestOpenStockDefectTakesTheShelfOfItsBranch(t *testing.T) {
	f := newFixture(t)
	before := f.balances(t)
	claim, err := f.store.OpenStockDefect(f.ctx, f.actor(2), warrantycase.StockDefectInput{
		VariantID: 1, Quantity: 2, DeclaredFailure: "No retiene carga",
		Reason: "Probada en mostrador: no arranca"})
	if err != nil {
		t.Fatalf("the finding on the shelf must be admitted: %v", err)
	}
	if claim.Origin != warrantycase.OriginStockDefect || claim.Phase != warrantycase.PhaseReceived ||
		claim.Quantity == nil || *claim.Quantity != 2 || claim.SerialNumber != nil ||
		claim.SaleID != nil {
		t.Fatalf("a stock defect is the shelf, not a sold unit: %+v", claim)
	}
	if claim.Reason == nil || *claim.Reason != "Probada en mostrador: no arranca" ||
		claim.DeclaredFailure != "No retiene carga" {
		t.Fatalf("the motive of the write-off is its own fact: %+v", claim)
	}
	if claim.CaseNumber != caseNumberOf(2, claim.BranchSequence) {
		t.Fatalf("the case number is the branch's own: %q", claim.CaseNumber)
	}
	// The write-off is the admission's, and it takes the units off the case's own branch only (S16).
	if got := f.balances(t); got == before || got != "1:1=10/0,2:1=8/0,3:1=10/0," {
		t.Fatalf("the finding must take its quantity off its own branch: %s", got)
	}

	// Every refusal of this door writes nothing: no case and no balance movement.
	cases := f.count(t, "warranty_cases")
	for name, refused := range map[string]struct {
		actor auth.Identity
		input warrantycase.StockDefectInput
		want  error
	}{
		"the warehouse owns no shelf": {f.actor(1), warrantycase.StockDefectInput{
			VariantID: 1, Quantity: 1, DeclaredFailure: "Falla", Reason: "Motivo"},
			warrantycase.ErrForbidden},
		"a finding is at least one battery": {f.actor(2), warrantycase.StockDefectInput{
			VariantID: 1, Quantity: 0, DeclaredFailure: "Falla", Reason: "Motivo"},
			warrantycase.ErrInvalid},
		"a finding states what failed": {f.actor(2), warrantycase.StockDefectInput{
			VariantID: 1, Quantity: 1, DeclaredFailure: " ", Reason: "Motivo"},
			warrantycase.ErrInvalid},
		"the motive of a write-off is required": {f.actor(2), warrantycase.StockDefectInput{
			VariantID: 1, Quantity: 1, DeclaredFailure: "Falla", Reason: "  "},
			warrantycase.ErrInvalid},
		"a variant nobody catalogued": {f.actor(2), warrantycase.StockDefectInput{
			VariantID: 0, Quantity: 1, DeclaredFailure: "Falla", Reason: "Motivo"},
			warrantycase.ErrInvalid},
		"stock the branch does not have": {f.actor(2), warrantycase.StockDefectInput{
			VariantID: 1, Quantity: 9, DeclaredFailure: "Falla", Reason: "Motivo"},
			warrantycase.ErrNoStock},
	} {
		if _, err := f.store.OpenStockDefect(f.ctx, refused.actor, refused.input); !errors.Is(err, refused.want) {
			t.Fatalf("%s must be refused as %v, got %v", name, refused.want, err)
		}
	}
	if got := f.count(t, "warranty_cases"); got != cases {
		t.Fatalf("a refused door writes no case: %d before, %d after", cases, got)
	}
	if got := f.balances(t); got != "1:1=10/0,2:1=8/0,3:1=10/0," {
		t.Fatalf("a refused door writes no stock: %s", got)
	}
	// A claim never states the motive of a write-off: it writes nothing off (S16).
	covered := f.sell(t, 2, "CUB-LIST/1", months(12), time.Now())
	if _, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: "CUB-LIST/1", DeclaredFailure: "No arranca"}); err != nil {
		t.Fatalf("the covered claim must be admitted: %v", err)
	}
	if covered < 1 {
		t.Fatal("the fixture must sell the claimed unit")
	}
}

// TestListReadsTheTrayOfTheBranch pins the read of the tray: a branch lists its own cases newest
// first, the warehouse lists the cases it moves, and the two filters name exactly the phase and the
// origin of the frozen vocabulary (S23).
func TestListReadsTheTrayOfTheBranch(t *testing.T) {
	f := newFixture(t)
	f.sell(t, 2, "CUB-L/1", months(12), time.Now())
	first, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: "CUB-L/1", DeclaredFailure: "No arranca"})
	if err != nil {
		t.Fatalf("the claim of branch 2 must be admitted: %v", err)
	}
	second, err := f.store.OpenStockDefect(f.ctx, f.actor(2), warrantycase.StockDefectInput{
		VariantID: 1, Quantity: 1, DeclaredFailure: "No retiene carga", Reason: "Góndola"})
	if err != nil {
		t.Fatalf("the finding of branch 2 must be admitted: %v", err)
	}
	other, err := f.store.OpenStockDefect(f.ctx, f.actor(3), warrantycase.StockDefectInput{
		VariantID: 1, Quantity: 1, DeclaredFailure: "No retiene carga", Reason: "Góndola"})
	if err != nil {
		t.Fatalf("the finding of branch 3 must be admitted: %v", err)
	}

	tray, err := f.store.List(f.ctx, f.actor(2), warrantycase.ListFilter{})
	if err != nil {
		t.Fatalf("a branch reads its own tray: %v", err)
	}
	if len(tray) != 2 || tray[0].ID != second.ID || tray[1].ID != first.ID {
		t.Fatalf("the tray is the branch's own cases, newest first: %+v", tray)
	}
	for _, item := range tray {
		if item.BranchLocationID != 2 {
			t.Fatalf("another branch's case is never in this tray: %+v", item)
		}
	}
	// The warehouse moves every case, so it lists every case; the branch of the case is stated.
	whole, err := f.store.List(f.ctx, f.actor(1), warrantycase.ListFilter{})
	if err != nil || len(whole) != 3 {
		t.Fatalf("the warehouse lists the cases it moves: %d %v", len(whole), err)
	}
	if whole[0].ID != other.ID || whole[0].BranchLocationID != 3 {
		t.Fatalf("the warehouse tray states the branch of each case: %+v", whole[0])
	}
	// The filters are the frozen vocabulary of S23 and nothing else.
	onlyStock, err := f.store.List(f.ctx, f.actor(1), warrantycase.ListFilter{
		Origin: warrantycase.OriginStockDefect})
	if err != nil || len(onlyStock) != 2 {
		t.Fatalf("the origin filter names one door: %d %v", len(onlyStock), err)
	}
	for _, item := range onlyStock {
		if item.Origin != warrantycase.OriginStockDefect {
			t.Fatalf("the origin filter admitted another door: %+v", item)
		}
	}
	received, err := f.store.List(f.ctx, f.actor(1), warrantycase.ListFilter{
		Phase: warrantycase.PhaseReceived})
	if err != nil || len(received) != 3 {
		t.Fatalf("every case of the fixture is received: %d %v", len(received), err)
	}
	if none, err := f.store.List(f.ctx, f.actor(1), warrantycase.ListFilter{
		Phase: warrantycase.PhaseClosed}); err != nil || len(none) != 0 {
		t.Fatalf("a phase nobody reached lists nothing: %d %v", len(none), err)
	}
	// A value outside the frozen vocabulary is a malformed read, never an empty answer.
	for name, filter := range map[string]warrantycase.ListFilter{
		"unknown phase":  {Phase: warrantycase.Phase("on_the_way")},
		"unknown origin": {Origin: warrantycase.Origin("customer_return")},
	} {
		if _, err := f.store.List(f.ctx, f.actor(2), filter); !errors.Is(err, warrantycase.ErrInvalid) {
			t.Fatalf("%s must be refused as invalid, got %v", name, err)
		}
	}
}

// TestNoticeReleaseAndDeliverySplitTheActors pins S14 and S19 on the store: the branch of the case
// registers the notice and never authorises a release, the warehouse authorises the release and never
// registers a notice nor delivers the exchange, the release requires a recorded notice, and the
// delivery closes the case, settles the loan and writes no stock.
func TestNoticeReleaseAndDeliverySplitTheActors(t *testing.T) {
	f := newFixture(t)
	// The used battery the counter hands over is one the branch holds (S25).
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "notice-loan-0001", "NS60L", 1, "10.00", "10.00")
	f.sell(t, 2, "CUB-N/1", months(12), time.Now())
	claim, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: "CUB-N/1", DeclaredFailure: "No arranca"})
	if err != nil {
		t.Fatalf("the covered claim must be admitted: %v", err)
	}
	loan, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60L", Quantity: 1, SourceLocationID: 2})
	if err != nil {
		t.Fatalf("the branch lends the used battery: %v", err)
	}
	// Neither the notice nor the release exists before the factory answered (S14).
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado"); !errors.Is(err, warrantycase.ErrResolutionPending) {
		t.Fatalf("a case on its way has nothing to notify, got %v", err)
	}
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "Liberada"); !errors.Is(err, warrantycase.ErrResolutionPending) {
		t.Fatalf("a case on its way holds no unit to release, got %v", err)
	}
	// The journey: the branch ships, the warehouse receives and ships to the factory with its file
	// number, and the factory answers.
	for _, tramo := range []struct {
		actor int
		input warrantycase.AdvanceInput
	}{
		{2, warrantycase.AdvanceInput{Phase: warrantycase.PhaseInTransit, Note: "Sale al Almacén"}},
		{1, warrantycase.AdvanceInput{Phase: warrantycase.PhaseAtWarehouse, Note: "Recibida"}},
		{1, warrantycase.AdvanceInput{Phase: warrantycase.PhaseAtFactory, FactoryCaseNumber: "LEG-1",
			Note: "Enviada a fábrica"}},
	} {
		if _, err := f.store.Advance(f.ctx, f.actor(tramo.actor), claim.ID, tramo.input); err != nil {
			t.Fatalf("the tramo %s must be recorded: %v", tramo.input.Phase, err)
		}
	}
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictRepaired, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "Reparada por fábrica"}); err != nil {
		t.Fatalf("the factory verdict must be recorded: %v", err)
	}
	// The notice is the branch's and the warehouse never registers one (S19).
	noticed, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente")
	if err != nil {
		t.Fatalf("the branch registers the notice of its own case: %v", err)
	}
	last := noticed.Events[len(noticed.Events)-1]
	if last.Kind != warrantycase.KindNotice || last.Phase != warrantycase.PhaseResolved ||
		last.Note != "Avisado el cliente" || last.ActorAccountID != int64(f.accounts[2]) {
		t.Fatalf("the notice is a fact of the history that moves nothing: %+v", last)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(1), claim.ID, "El Almacén avisa"); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("the warehouse never notifies a client, got %v", err)
	}
	// The release is the warehouse's and the branch never authorises one (S19).
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(2), claim.ID, "La sucursal libera"); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("the branch never releases a unit to stock, got %v", err)
	}
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, " "); !errors.Is(err, warrantycase.ErrInvalid) {
		t.Fatalf("a release states its motive, got %v", err)
	}
	shelf := f.existing(t, 2, 1)
	released, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "El cliente no volvió")
	if err != nil {
		t.Fatalf("the warehouse authorises the release of a notified case: %v", err)
	}
	if released.Phase != warrantycase.PhaseResolved {
		t.Fatalf("a release never moves the case, got %s", released.Phase)
	}
	// The repaired unit crosses from custody to sellable stock, once (S13, S14): the mirror of the
	// write-off of the finding.
	if got := f.existing(t, 2, 1); got != shelf+1 {
		t.Fatalf("the release returns the unit to sellable stock: %d became %d", shelf, got)
	}
	if f.existing(t, 1, 1) != 10 || f.existing(t, 3, 1) != 10 {
		t.Fatalf("a release moves the shelf of its own branch only: %s", f.balances(t))
	}
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "Otra vez"); !errors.Is(err, warrantycase.ErrAlreadyReleased) {
		t.Fatalf("a case is released once, got %v", err)
	}
	// A release without a recorded notice is refused, not silently ignored (S14). The case is a second
	// claim of a battery of its own, because one serial carries one open claim (S7) and the case above
	// has not closed yet.
	literal := f.openClaim(t, "CUB-N/2")
	// The second claim owes its own loan as well, because the gate is the case's and never the branch's
	// (S4): its client also leaves with a used battery.
	f.lend(t, literal)
	for _, phase := range []warrantycase.Phase{warrantycase.PhaseInTransit,
		warrantycase.PhaseAtWarehouse} {
		if _, err := f.store.Advance(f.ctx, f.actor(1), literal.ID, warrantycase.AdvanceInput{
			Phase: phase}); err != nil {
			t.Fatalf("the second claim moves to %s: %v", phase, err)
		}
	}
	if _, err := f.store.Advance(f.ctx, f.actor(1), literal.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtFactory, FactoryCaseNumber: "LEG-2"}); err != nil {
		t.Fatalf("the second claim is shipped to the factory: %v", err)
	}
	if _, err := f.store.Resolve(f.ctx, f.actor(1), literal.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationScrap,
		LoanDestination: warrantycase.DestinationCustomer, Note: "No cubre"}); err != nil {
		t.Fatalf("the factory refusal of the second claim must be recorded: %v", err)
	}
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), literal.ID, "Sin aviso"); !errors.Is(err, warrantycase.ErrNoticeRequired) {
		t.Fatalf("a release requires a recorded notice, got %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), literal.ID, "Avisado"); err != nil {
		t.Fatalf("the second claim registers its notice: %v", err)
	}
	// A case whose reported battery never came back to the branch holds nothing to release (S13).
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), literal.ID, "La unidad no está"); !errors.Is(err, warrantycase.ErrReleaseUnavailable) {
		t.Fatalf("a unit that never came back is not released, got %v", err)
	}

	// The delivery is the branch's: the warehouse never delivers to a client (S19).
	if _, err := f.store.DeliverExchange(f.ctx, f.actor(1), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanReturned, Note: "Entrega al cliente"}); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("the warehouse never delivers the exchange, got %v", err)
	}
	// The delivery settles the loan as the counter states and never as an open one (S7).
	for _, fate := range []warrantycase.LoanFate{warrantycase.LoanOpen, warrantycase.LoanFailed} {
		if _, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
			LoanFate: fate}); !errors.Is(err, warrantycase.ErrInvalid) {
			t.Fatalf("a delivery states %s as the fate of the loan, got %v", fate, err)
		}
	}
	stock := f.balances(t)
	delivered, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanReturned, Note: "Entregada la reparada"})
	if err != nil {
		t.Fatalf("the branch delivers the exchange of its own case: %v", err)
	}
	if delivered.Phase != warrantycase.PhaseClosed {
		t.Fatalf("the delivery closes the case, got %s", delivered.Phase)
	}
	if last := delivered.Events[len(delivered.Events)-1]; last.Kind != warrantycase.KindPhase ||
		last.Phase != warrantycase.PhaseClosed || last.Note != "Entregada la reparada" {
		t.Fatalf("the delivery is a tramo of the journey: %+v", last)
	}
	if len(delivered.Loans) != 1 || delivered.Loans[0].Fate != warrantycase.LoanReturned ||
		delivered.Loans[0].FateDecidedAt == nil || delivered.Loans[0].Ordinal != loan.Ordinal {
		t.Fatalf("the delivery settles the loan of the case: %+v", delivered.Loans)
	}
	// A delivery writes no stock: the unit of a delivered case leaves the branch with the client.
	if got := f.balances(t); got != stock {
		t.Fatalf("a delivery writes no balance: %s became %s", stock, got)
	}
	// A case already closed does not deliver twice.
	if _, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanKeptByCustomer}); !errors.Is(err, warrantycase.ErrTransition) {
		t.Fatalf("a closed case does not deliver again, got %v", err)
	}
}

// caseNumberOf is the printed form the database writes for the correlative of one branch: the number
// a case is read by and the one the receipt prints (S8, S20).
func caseNumberOf(branch int, sequence int64) string {
	return fmt.Sprintf("C-%d-%06d", branch, sequence)
}

// existing reads one balance row of the fixture, so a stock write is asserted as a number and never
// as a guessed matrix.
func (f *fixture) existing(t *testing.T, location, variant int) int64 {
	t.Helper()
	var existing int64
	if err := f.pool.QueryRow(f.ctx, `SELECT existing FROM inventory_balances
 WHERE location_id=$1 AND variant_id=$2`, location, variant).Scan(&existing); err != nil {
		t.Fatalf("the balance of %d:%d could not be read: %v", location, variant, err)
	}
	return existing
}
