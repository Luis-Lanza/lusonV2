package warrantycase_test

import (
	"errors"
	"testing"

	"luson/api/internal/warrantycase"
)

// The destination of a unit and the condition it came back in are two facts, and only the pair says
// whether the branch may sell the battery (S31). A claim whose factory verdict gave a usable battery
// back and whose destination is the branch's shelf never leaves with the client: it becomes the
// branch's sellable stock through the release the warehouse authorises, and that release is the act
// that closes the case. The delivery of a case like that is refused, because delivering asserts that
// the unit went out with the client and no screen may assert a fact that did not happen.
//
// The refused half is the mirror: a claim resolved `not_covered` with the same destination is the used
// pool's damaged battery (071), not the branch's sellable stock, so its release is still refused and
// writes nothing. The customer path keeps closing through the delivery, unchanged.

// stockBoundClaim opens the claim of a usable unit destined to the branch's shelf: the factory
// repaired it, the client is not collecting it, and the case carries a lent battery so a delivery has
// a loan to settle and a release has a case to close.
func (f *fixture) stockBoundClaim(t *testing.T, serial string) warrantycase.Case {
	t.Helper()
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "stock-bound-0001", "NS60L", 1, "10.00", "10.00")
	claim := f.openClaim(t, serial)
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
	return claim
}

// TestDeliveryOfAUnitBoundForStockIsRefused pins the first half of S31 on the store: the branch never
// delivers the usable unit whose destination is the shelf, and the refusal writes nothing at all --
// no tramo, no loan fate and no balance.
func TestDeliveryOfAUnitBoundForStockIsRefused(t *testing.T) {
	f := newFixture(t)
	claim := f.stockBoundClaim(t, "STOCK-BOUND/1")
	before := f.balances(t)
	events := len(f.read(t, claim.ID).Events)

	// The counter states the loan fate exactly as it would on a delivery, and the delivery is still
	// refused: the fate a refused act carried is never written (S7, S31).
	if _, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanKeptByCustomer,
		Note:     "Entregada al cliente"}); !errors.Is(err, warrantycase.ErrUnitBelongsToStock) {
		t.Fatalf("the unit of a case bound for stock is never delivered, got %v", err)
	}
	read := f.read(t, claim.ID)
	if read.Phase != warrantycase.PhaseResolved {
		t.Fatalf("a refused delivery leaves the case resolved, got %s", read.Phase)
	}
	if len(read.Events) != events {
		t.Fatalf("a refused delivery writes no tramo: %d before, %d after", events, len(read.Events))
	}
	if len(read.Loans) != 1 || read.Loans[0].Fate != warrantycase.LoanOpen ||
		read.Loans[0].FateDecidedAt != nil {
		t.Fatalf("a refused delivery settles no loan: %+v", read.Loans)
	}
	if got := f.balances(t); got != before {
		t.Fatalf("a refused delivery writes no balance: %s became %s", before, got)
	}

	// The phase rule: the case closes with its release and never with a bare tramo, so the branch
	// cannot reach `closed` behind the counter's back either (S31).
	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseClosed, Note: "Cerrado a mano"}); !errors.Is(err, warrantycase.ErrUnitBelongsToStock) {
		t.Fatalf("a case bound for stock does not close through a tramo, got %v", err)
	}
	if read := f.read(t, claim.ID); read.Phase != warrantycase.PhaseResolved || len(read.Events) != events {
		t.Fatalf("the refused close writes nothing: %+v", read)
	}
}

// TestACaseBoundForStockClosesWithItsRelease pins the second half of S31: the notice the branch
// registers and the release the warehouse authorises are the acts that end the case, the release puts
// the unit into sellable stock of the case's own branch once, and nothing closes the case before it.
func TestACaseBoundForStockClosesWithItsRelease(t *testing.T) {
	f := newFixture(t)
	claim := f.stockBoundClaim(t, "STOCK-BOUND/2")
	shelf := f.existing(t, 2, 1)

	// The case is open after its resolution: the verdict is not the close, and the release needs the
	// notice the branch registers first (S14).
	if read := f.read(t, claim.ID); read.Phase != warrantycase.PhaseResolved {
		t.Fatalf("a resolved case bound for stock is not closed yet, got %s", read.Phase)
	}
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID,
		"El cliente no la retira"); !errors.Is(err, warrantycase.ErrNoticeRequired) {
		t.Fatalf("the release of a stock-bound case requires its notice, got %v", err)
	}
	if got := f.existing(t, 2, 1); got != shelf {
		t.Fatalf("a refused release writes no stock: %d became %d", shelf, got)
	}
	noticed, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente")
	if err != nil {
		t.Fatalf("the branch notifies the client of its own case: %v", err)
	}
	if noticed.Phase != warrantycase.PhaseResolved ||
		noticed.Events[len(noticed.Events)-1].Kind != warrantycase.KindNotice {
		t.Fatalf("a notice moves nothing: %+v", noticed)
	}
	if got := f.existing(t, 2, 1); got != shelf {
		t.Fatalf("a notice writes no stock: %d became %d", shelf, got)
	}

	// The warehouse's release is the act that closes the case and the one that sells the unit (S13,
	// S14, S31).
	released, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "El cliente no la retira")
	if err != nil {
		t.Fatalf("the warehouse releases the unit of a notified case: %v", err)
	}
	if released.Phase != warrantycase.PhaseClosed {
		t.Fatalf("the release closes the case bound for stock, got %s", released.Phase)
	}
	last := released.Events[len(released.Events)-1]
	if last.Kind != warrantycase.KindRelease || last.Phase != warrantycase.PhaseClosed ||
		last.Note != "El cliente no la retira" || last.ActorAccountID != int64(f.accounts[1]) {
		t.Fatalf("the release is one tramo that states the close: %+v", last)
	}
	if got := f.existing(t, 2, 1); got != shelf+1 {
		t.Fatalf("the released unit is sellable stock of the case's branch: %d became %d", shelf, got)
	}
	if got := f.existing(t, 1, 1); got != 10 {
		t.Fatalf("the release moves the shelf of the case's branch only: %s", f.balances(t))
	}
	// The loan is the counter's business and the release is not a delivery: the used battery stays
	// exactly where the client left it (S7, S31).
	if len(released.Loans) != 1 || released.Loans[0].Fate != warrantycase.LoanOpen {
		t.Fatalf("a release settles no loan: %+v", released.Loans)
	}
	// The case is released once and it is closed, so nothing else closes or delivers it again.
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID,
		"Otra vez"); !errors.Is(err, warrantycase.ErrAlreadyReleased) {
		t.Fatalf("a case is released once, got %v", err)
	}
	if _, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanReturned}); !errors.Is(err, warrantycase.ErrTransition) {
		t.Fatalf("a closed case is never delivered, got %v", err)
	}
	if got := f.existing(t, 2, 1); got != shelf+1 {
		t.Fatalf("the refused second acts write no stock: %d", got)
	}
}

// TestTheDamagedUnitOfTheUsedPoolIsNeverReleased pins the other side of the pair: `not_covered` with
// the same destination is the damaged battery the factory refused, the used pool reads it exactly as
// before (071) and the branch never sells it, so a release is still refused with its own code and
// writes nothing.
func TestTheDamagedUnitOfTheUsedPoolIsNeverReleased(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "stock-bound-0002", "NS60L", 1, "10.00", "10.00")
	claim := f.openClaim(t, "STOCK-BOUND/3")
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60L", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the branch lends the used battery of the case: %v", err)
	}
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer, Note: "Fábrica rechazó la garantía"}); err != nil {
		t.Fatalf("the factory refusal sends the damaged unit to the used pool: %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch notifies the client of its own case: %v", err)
	}
	before := f.balances(t)
	events := len(f.read(t, claim.ID).Events)
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID,
		"La dañada al pool"); !errors.Is(err, warrantycase.ErrReleaseUnavailable) {
		t.Fatalf("the damaged unit of the used pool is never sellable stock, got %v", err)
	}
	if read := f.read(t, claim.ID); read.Phase != warrantycase.PhaseResolved || len(read.Events) != events {
		t.Fatalf("a refused release writes nothing: %+v", read)
	}
	if got := f.balances(t); got != before {
		t.Fatalf("a refused release writes no balance: %s became %s", before, got)
	}
}

// TestTheCustomerCaseStillClosesWithItsDelivery pins the path this change must not move: a claim whose
// unit is destined to the client is released into custody when the client does not come, and the
// delivery is still the act that hands the battery over and closes the case (S13, S31).
func TestTheCustomerCaseStillClosesWithItsDelivery(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "stock-bound-0003", "NS60L", 1, "10.00", "10.00")
	claim := f.openClaim(t, "STOCK-BOUND/4")
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60L", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the branch lends the used battery of the case: %v", err)
	}
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictRepaired, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "Reparada por fábrica"}); err != nil {
		t.Fatalf("the factory repaired the unit of the client: %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch notifies the client of its own case: %v", err)
	}
	shelf := f.existing(t, 2, 1)
	released, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "El cliente no volvió")
	if err != nil {
		t.Fatalf("the warehouse releases the unit of a notified case: %v", err)
	}
	if released.Phase != warrantycase.PhaseResolved {
		t.Fatalf("the release of a client's unit never moves the case, got %s", released.Phase)
	}
	if got := f.existing(t, 2, 1); got != shelf+1 {
		t.Fatalf("the released unit is sellable stock: %d became %d", shelf, got)
	}
	stock := f.balances(t)
	delivered, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanKeptByCustomer, Note: "Entregada la reparada"})
	if err != nil {
		t.Fatalf("the branch delivers the exchange of its own case: %v", err)
	}
	if delivered.Phase != warrantycase.PhaseClosed {
		t.Fatalf("the delivery closes the client's case, got %s", delivered.Phase)
	}
	if delivered.Loans[0].Fate != warrantycase.LoanKeptByCustomer ||
		delivered.Loans[0].FateDecidedAt == nil {
		t.Fatalf("the delivery settles the loan of the case: %+v", delivered.Loans)
	}
	if got := f.balances(t); got != stock {
		t.Fatalf("the delivery writes no stock: %s became %s", stock, got)
	}
}
