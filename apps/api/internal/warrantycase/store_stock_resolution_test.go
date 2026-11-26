package warrantycase_test

import (
	"errors"
	"testing"

	"luson/api/internal/warrantycase"
)

// TestStockDefectResolvesTheShelfOfItsBranch pins the stock door's resolution matrix (S11): a finding
// resolved `repaired` or `replaced` brings a sellable unit back to its own branch's shelf -- the same
// movement the claim's release writes, in the opposite direction of the write-off of 067 -- a finding
// resolved `not_covered` leaves the write-off standing because the damaged units stay in the used pool,
// the warehouse still refuses before the factory, and the branch closes the case it owns.
func TestStockDefectResolvesTheShelfOfItsBranch(t *testing.T) {
	f := newFixture(t)
	// A repair and a replacement both return the units to the branch's own sellable stock (S11).
	for _, restored := range []struct {
		verdict warrantycase.Verdict
		note    string
	}{
		{warrantycase.VerdictRepaired, "Reparadas por fábrica"},
		{warrantycase.VerdictReplaced, "Fábrica repuso las unidades"},
	} {
		finding := f.find(t, 2, 2)
		if got := f.existing(t, 2, 1); got != 8 {
			t.Fatalf("the admission writes the units off the shelf: %d", got)
		}
		f.atFactory(t, finding)
		shelf := f.existing(t, 2, 1)
		moved, err := f.store.Resolve(f.ctx, f.actor(1), finding.ID, warrantycase.ResolutionInput{
			Verdict:             restored.verdict,
			ReportedDestination: warrantycase.DestinationStock,
			Note:                restored.note})
		if err != nil {
			t.Fatalf("the finding resolved %s must be admitted: %v", restored.verdict, err)
		}
		if moved.Phase != warrantycase.PhaseResolved || moved.Verdict == nil ||
			*moved.Verdict != restored.verdict || moved.ReportedDestination == nil ||
			*moved.ReportedDestination != warrantycase.DestinationStock {
			t.Fatalf("the finding states its verdict and its units: %+v", moved)
		}
		// A finding lends no battery, and the shelf it returns is the store's own reading of the verdict.
		if moved.LoanDestination != nil {
			t.Fatalf("a finding lends no battery and states no loan destination: %+v", moved)
		}
		if moved.StockDestination == nil || *moved.StockDestination != warrantycase.DestinationStock {
			t.Fatalf("the units of the finding end in the branch's own stock: %+v", moved)
		}
		if got := f.existing(t, 2, 1); got != shelf+2 {
			t.Fatalf("a %s returns the units to the shelf: %d became %d", restored.verdict, shelf, got)
		}
		if f.existing(t, 1, 1) != 10 || f.existing(t, 3, 1) != 10 {
			t.Fatalf("a resolution returns the shelf of its own branch only: %s", f.balances(t))
		}
		// A resolution is stated once and is final (S11).
		if _, err := f.store.Resolve(f.ctx, f.actor(1), finding.ID, warrantycase.ResolutionInput{
			Verdict:             warrantycase.VerdictReplaced,
			ReportedDestination: warrantycase.DestinationStock}); !errors.Is(err, warrantycase.ErrResolutionFinal) {
			t.Fatalf("the resolution of a finding is final, got %v", err)
		}
		// No notice and no release for a stock defect: there is no client to call and the unit is the
		// branch's own (S14, S19).
		if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), finding.ID,
			"Avisado el cliente"); !errors.Is(err, warrantycase.ErrClaimOnly) {
			t.Fatalf("a finding has no client to notify, got %v", err)
		}
		if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), finding.ID,
			"Vuelven a la góndola"); !errors.Is(err, warrantycase.ErrClaimOnly) {
			t.Fatalf("a finding has no unit in custody to release, got %v", err)
		}
		if got := f.existing(t, 2, 1); got != shelf+2 {
			t.Fatalf("a refused notice or release writes no stock: %s", f.balances(t))
		}
		// The branch closes the case it owns; the warehouse only moves the battery (S19).
		if _, err := f.store.Advance(f.ctx, f.actor(1), finding.ID, warrantycase.AdvanceInput{
			Phase: warrantycase.PhaseClosed, Note: "Cerrado por el Almacén"}); !errors.Is(err, warrantycase.ErrForbidden) {
			t.Fatalf("the warehouse never closes the case that answers to the branch, got %v", err)
		}
		closed, err := f.store.Advance(f.ctx, f.actor(2), finding.ID, warrantycase.AdvanceInput{
			Phase: warrantycase.PhaseClosed, Note: "Vuelven a la góndola"})
		if err != nil || closed.Phase != warrantycase.PhaseClosed {
			t.Fatalf("the branch closes its own finding: %+v %v", closed, err)
		}
	}

	// `not_covered` leaves the loan with the client and the damaged unit in the used pool: the write-off
	// of 067 stands, so the shelf of the branch does not move (S11).
	refusedUnits := f.find(t, 2, 3)
	f.atFactory(t, refusedUnits)
	shelf := f.existing(t, 2, 1)
	kept, err := f.store.Resolve(f.ctx, f.actor(1), refusedUnits.ID, warrantycase.ResolutionInput{
		Verdict:             warrantycase.VerdictNotCovered,
		ReportedDestination: warrantycase.DestinationStock, Note: "Fábrica rechazó la garantía"})
	if err != nil {
		t.Fatalf("the factory refusal of a finding must be admitted: %v", err)
	}
	if kept.Verdict == nil || *kept.Verdict != warrantycase.VerdictNotCovered ||
		kept.ReportedDestination == nil ||
		*kept.ReportedDestination != warrantycase.DestinationStock ||
		kept.LoanDestination != nil || kept.StockDestination != nil {
		t.Fatalf("not_covered keeps the damaged units in the used pool: %+v", kept)
	}
	if got := f.existing(t, 2, 1); got != shelf {
		t.Fatalf("not_covered writes no stock: %d became %d", shelf, got)
	}
	if _, err := f.store.Advance(f.ctx, f.actor(2), refusedUnits.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseClosed, Note: "Las dañadas al pool"}); err != nil {
		t.Fatalf("a finding refused by the factory also closes: %v", err)
	}

	// The matrix of the stock door refuses every pair the verdict does not state, and the refusals write
	// no stock and no tramo.
	gated := f.find(t, 2, 1)
	f.atFactory(t, gated)
	shelf = f.existing(t, 2, 1)
	tramos := len(f.read(t, gated.ID).Events)
	for name, refused := range map[string]struct {
		input warrantycase.ResolutionInput
		want  error
	}{
		"a finding has no client to deliver to": {
			warrantycase.ResolutionInput{Verdict: warrantycase.VerdictRepaired,
				ReportedDestination: warrantycase.DestinationCustomer},
			warrantycase.ErrMatrix},
		"a replacement is the branch's own stock": {
			warrantycase.ResolutionInput{Verdict: warrantycase.VerdictReplaced,
				ReportedDestination: warrantycase.DestinationCustomer},
			warrantycase.ErrMatrix},
		"a finding lends no battery": {
			warrantycase.ResolutionInput{Verdict: warrantycase.VerdictRepaired,
				ReportedDestination: warrantycase.DestinationStock,
				LoanDestination:     warrantycase.DestinationStock},
			warrantycase.ErrInvalid},
		"not_covered keeps the damaged units in the used pool": {
			warrantycase.ResolutionInput{Verdict: warrantycase.VerdictNotCovered,
				ReportedDestination: warrantycase.DestinationCustomer},
			warrantycase.ErrMatrix},
		"the factory holds no unit of this branch": {
			warrantycase.ResolutionInput{Verdict: warrantycase.VerdictNotCovered,
				ReportedDestination: warrantycase.DestinationRetainedByFactory},
			warrantycase.ErrMatrix},
		"a verdict outside the frozen list": {
			warrantycase.ResolutionInput{Verdict: warrantycase.Verdict("refunded"),
				ReportedDestination: warrantycase.DestinationStock},
			warrantycase.ErrInvalid},
		"the warehouse verdict belongs before the factory": {
			warrantycase.ResolutionInput{Verdict: warrantycase.VerdictRefusedAtWarehouse,
				ReportedDestination: warrantycase.DestinationStock, Note: "No cubre"},
			warrantycase.ErrWarehouseVerdict},
	} {
		if _, err := f.store.Resolve(f.ctx, f.actor(1), gated.ID, refused.input); !errors.Is(err, refused.want) {
			t.Fatalf("%s must be refused as %v, got %v", name, refused.want, err)
		}
	}
	if got := f.existing(t, 2, 1); got != shelf {
		t.Fatalf("a refused resolution writes no stock: %d became %d", shelf, got)
	}
	if got := len(f.read(t, gated.ID).Events); got != tramos {
		t.Fatalf("a refused resolution writes no tramo: %d became %d", tramos, got)
	}

	// The warehouse's gate before the factory is the same for both doors (S10): it refuses with its own
	// verdict and its motive, writes no stock, and leaves the case to its branch to close.
	gate := f.find(t, 2, 1)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), gate.ID, warrantycase.ResolutionInput{
		Verdict:             warrantycase.VerdictRepaired,
		ReportedDestination: warrantycase.DestinationStock}); !errors.Is(err, warrantycase.ErrTransition) {
		t.Fatalf("a case that has not left the branch is not resolved, got %v", err)
	}
	f.atWarehouse(t, gate)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), gate.ID, warrantycase.ResolutionInput{
		Verdict:             warrantycase.VerdictNotCovered,
		ReportedDestination: warrantycase.DestinationStock}); !errors.Is(err, warrantycase.ErrWarehouseVerdict) {
		t.Fatalf("the warehouse refuses before the factory, got %v", err)
	}
	shelf = f.existing(t, 2, 1)
	warehouseRefusal, err := f.store.Resolve(f.ctx, f.actor(1), gate.ID, warrantycase.ResolutionInput{
		Verdict:             warrantycase.VerdictRefusedAtWarehouse,
		ReportedDestination: warrantycase.DestinationStock, Note: " No pasa la revisión "})
	if err != nil {
		t.Fatalf("the warehouse must refuse a finding at its gate: %v", err)
	}
	if warehouseRefusal.Phase != warrantycase.PhaseResolved ||
		warehouseRefusal.StockDestination != nil {
		t.Fatalf("a warehouse refusal returns no unit to stock: %+v", warehouseRefusal)
	}
	if got := f.existing(t, 2, 1); got != shelf {
		t.Fatalf("a warehouse refusal writes no stock: %d became %d", shelf, got)
	}
	if _, err := f.store.Resolve(f.ctx, f.actor(1), 999999, warrantycase.ResolutionInput{
		Verdict:             warrantycase.VerdictRepaired,
		ReportedDestination: warrantycase.DestinationStock}); !errors.Is(err, warrantycase.ErrNotFound) {
		t.Fatalf("an unknown case is not resolved, got %v", err)
	}
}

// find opens a finding on the shelf of one branch, so a resolution test only states the case it
// resolves.
func (f *fixture) find(t *testing.T, branch int, quantity int64) warrantycase.Case {
	t.Helper()
	document, err := f.store.OpenStockDefect(f.ctx, f.actor(branch), warrantycase.StockDefectInput{
		VariantID: 1, Quantity: quantity, DeclaredFailure: "No retiene carga",
		Reason: "Probada en mostrador: no arranca"})
	if err != nil {
		t.Fatalf("the finding of branch %d must be admitted: %v", branch, err)
	}
	return document
}
