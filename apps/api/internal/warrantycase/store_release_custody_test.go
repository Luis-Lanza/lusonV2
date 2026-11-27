package warrantycase_test

import (
	"errors"
	"testing"

	"luson/api/internal/warrantycase"
)

// A release returns the single unit a claim got back from the factory as a sellable battery, and the
// verdict is the fact that states whether there is one (S11, S13, S14): the factory returned it
// `repaired` or `replaced`, or it never came back as something the branch may sell. The destination
// says where a unit went and never in what condition it came back, so it cannot answer this question
// alone — 073's own header says so and the guard of the release still read the destination first.
//
// The defect this pins: a claim whose `reported_destination` is `customer` skipped the guard whatever
// its verdict was, so a unit the factory kept (`lost`) or could not repair (`unrepairable`) was
// "released" into the branch's sellable stock — one unit of stock that never existed.

// customerDestinedClaimThatNeverCameBack opens a claim resolved with a verdict that did not return a
// usable unit, declared to the client, notified, and ready for the warehouse to release.
func (f *fixture) customerDestinedClaimThatNeverCameBack(t *testing.T, serial string,
	verdict warrantycase.Verdict) warrantycase.Case {
	t.Helper()
	claim := f.openClaim(t, serial)
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: verdict, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationCustomer, Note: "La fábrica no devolvió la unidad"}); err != nil {
		t.Fatalf("the factory verdict %s must be recorded: %v", verdict, err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch notifies the client of its own case: %v", err)
	}
	return claim
}

// TestAClaimWhoseUnitNeverCameBackIsNeverReleased pins the guard of the release on the fact that
// answers it: the verdict. A `lost` unit is one the factory kept and an `unrepairable` one is a battery
// nobody can sell, and neither is in custody, so the release is refused with its own code and writes no
// balance and no event, whatever destination the claim declared for it.
func TestAClaimWhoseUnitNeverCameBackIsNeverReleased(t *testing.T) {
	for _, verdict := range []warrantycase.Verdict{
		warrantycase.VerdictLost, warrantycase.VerdictUnrepairable,
	} {
		t.Run(string(verdict), func(t *testing.T) {
			f := newFixture(t)
			claim := f.customerDestinedClaimThatNeverCameBack(t, "NO-CUSTODY/"+string(verdict), verdict)
			shelf := f.existing(t, 2, 1)
			events := len(f.read(t, claim.ID).Events)

			_, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "La unidad no está")
			// The shelf is read before the refusal is judged, so a release that wrote stock names the
			// number it invented instead of hiding it behind the error assertion.
			after := f.existing(t, 2, 1)
			if !errors.Is(err, warrantycase.ErrReleaseUnavailable) {
				t.Fatalf("a unit that never came back as a sellable battery is not released, got %v (shelf %d became %d)",
					err, shelf, after)
			}
			if after != shelf {
				t.Fatalf("a refused release writes no stock: %d became %d", shelf, after)
			}
			if got := f.existing(t, 1, 1); got != 10 {
				t.Fatalf("the shelf of the warehouse is not the case's: %s", f.balances(t))
			}
			if read := f.read(t, claim.ID); read.Phase != warrantycase.PhaseResolved ||
				len(read.Events) != events {
				t.Fatalf("a refused release writes nothing: %+v", read)
			}
		})
	}
}

// TestAReplacedUnitDestinedToTheClientIsStillReleased pins the path this change must not move: the
// factory returned a usable unit to the branch and the client declared he would collect it, so the
// warehouse's release still enters it into sellable stock once, and the case keeps closing with its
// delivery (S13, S14).
func TestAReplacedUnitDestinedToTheClientIsStillReleased(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "release-custody-0001", "NS60L", 1, "10.00", "10.00")
	claim := f.openClaim(t, "NO-CUSTODY/REPLACED")
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60L", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the branch lends the used battery of the case: %v", err)
	}
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictReplaced, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "Reemplazada por fábrica"}); err != nil {
		t.Fatalf("the factory replacement of the client's unit must be recorded: %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch notifies the client of its own case: %v", err)
	}
	shelf := f.existing(t, 2, 1)
	released, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "El cliente no volvió")
	if err != nil {
		t.Fatalf("the warehouse releases the replacement of a notified case: %v", err)
	}
	if released.Phase != warrantycase.PhaseResolved {
		t.Fatalf("the release of a client's unit never closes the case, got %s", released.Phase)
	}
	if got := f.existing(t, 2, 1); got != shelf+1 {
		t.Fatalf("the released replacement is sellable stock: %d became %d", shelf, got)
	}
}
