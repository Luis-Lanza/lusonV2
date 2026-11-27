package warrantycase_test

import (
	"errors"
	"testing"
	"time"

	"luson/api/internal/warrantycase"
)

// revisions is the whole realtime counter table, so a test proves both what a case write
// publishes and what it leaves alone.
func (f *fixture) revisions(t *testing.T) map[string]int64 {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT scope,revision FROM realtime_revisions ORDER BY scope`)
	if err != nil {
		t.Fatalf("the realtime counters could not be read: %v", err)
	}
	defer rows.Close()
	counters := map[string]int64{}
	for rows.Next() {
		var scope string
		var revision int64
		if err := rows.Scan(&scope, &revision); err != nil {
			t.Fatalf("the realtime counters could not be read: %v", err)
		}
		counters[scope] = revision
	}
	if rows.Err() != nil {
		t.Fatalf("the realtime counters could not be read: %v", rows.Err())
	}
	return counters
}

func (f *fixture) bumped(t *testing.T, before, after map[string]int64, scope string) {
	t.Helper()
	previous, exists := before[scope]
	if !exists {
		t.Fatalf("the realtime audience %s must exist", scope)
	}
	if after[scope] != previous+1 {
		t.Fatalf("%s must bump exactly once: %d before, %d after", scope, previous, after[scope])
	}
}

func (f *fixture) unchanged(t *testing.T, before, after map[string]int64, scopes ...string) {
	t.Helper()
	for _, scope := range scopes {
		if after[scope] != before[scope] {
			t.Fatalf("%s must not change: %d before, %d after", scope, before[scope], after[scope])
		}
	}
}

// TestACaseWritePublishesAWarrantyRevision proves that every persisted write of a case reaches
// the two participants of the case -- its branch and the warehouse -- and nobody else: the
// counters of the other branches, of transfers and of the catalogue are untouched, a read
// publishes nothing, and a refused write publishes nothing because its transaction rolled back.
func TestACaseWritePublishesAWarrantyRevision(t *testing.T) {
	f := newFixture(t)
	// The branch holds the battery the counter lends, because a loan never invents one (S25).
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "realtime-loan-0001", "NS60L", 1, "10.00", "10.00")
	f.sell(t, 2, "AVISO/1", months(12), time.Now())
	before := f.revisions(t)
	for _, scope := range []string{"warranty:1", "warranty:2", "warranty:3"} {
		if _, exists := before[scope]; !exists {
			t.Fatalf("every location must own a warranty audience, %s is missing", scope)
		}
	}

	claim, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: "AVISO/1", DeclaredFailure: "No arranca el motor"})
	if err != nil {
		t.Fatalf("the claim must be admitted: %v", err)
	}
	opened := f.revisions(t)
	f.bumped(t, before, opened, "warranty:1")
	f.bumped(t, before, opened, "warranty:2")
	f.unchanged(t, before, opened, "warranty:3", "transfers:1", "transfers:2", "transfers:3",
		"inventory", "catalogue")

	// A read is not a write and publishes nothing.
	if _, err := f.store.Read(f.ctx, f.actor(2), claim.ID); err != nil {
		t.Fatalf("the case must be readable: %v", err)
	}
	f.unchanged(t, opened, f.revisions(t), "warranty:1", "warranty:2")

	// A refused claim writes nothing, so it publishes nothing either.
	if _, err := f.store.OpenClaim(f.ctx, f.actor(2), warrantycase.OpenClaimInput{
		SerialNumber: "NO-EXISTE/1", DeclaredFailure: "No arranca"}); err == nil {
		t.Fatal("a serial nobody sold must be refused")
	}
	f.unchanged(t, opened, f.revisions(t), "warranty:1", "warranty:2", "warranty:3")

	// The client is given the used battery before the case leaves the branch, and the loan publishes its
	// write to the same two sides (S4); the purchase that puts the battery in the branch publishes
	// nothing, which is why the counters of the stock and of the catalogue stay where they were.
	f.lend(t, claim)
	handed := f.revisions(t)
	f.bumped(t, opened, handed, "warranty:1")
	f.bumped(t, opened, handed, "warranty:2")
	f.unchanged(t, opened, handed, "warranty:3", "transfers:1", "transfers:2", "transfers:3",
		"inventory", "catalogue")

	// A movement of the journey is a write of the same case and reaches the same two sides.
	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseInTransit, Note: "Sale al Almacén"}); err != nil {
		t.Fatalf("the branch must be able to ship the case: %v", err)
	}
	moved := f.revisions(t)
	f.bumped(t, handed, moved, "warranty:1")
	f.bumped(t, handed, moved, "warranty:2")
	f.unchanged(t, handed, moved, "warranty:3", "transfers:1", "transfers:2", "transfers:3",
		"inventory", "catalogue")

	// The loan is a write of the case as well, even though it moves no stock and no phase (S5).
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60L", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the branch must be able to lend: %v", err)
	}
	lent := f.revisions(t)
	f.bumped(t, moved, lent, "warranty:1")
	f.bumped(t, moved, lent, "warranty:2")
	f.unchanged(t, moved, lent, "warranty:3", "transfers:2", "inventory")
}

// pending reads the count of one actor, so a case never has to be trusted to say what it counts.
func (f *fixture) pending(t *testing.T, location int) int64 {
	t.Helper()
	count, err := f.store.Pending(f.ctx, f.actor(location))
	if err != nil {
		t.Fatalf("the pending count of location %d could not be read: %v", location, err)
	}
	return count
}

func (f *fixture) wantPending(t *testing.T, when string, branch, warehouse, other int64) {
	t.Helper()
	if got := f.pending(t, 2); got != branch {
		t.Fatalf("%s: the branch must count %d, got %d", when, branch, got)
	}
	if got := f.pending(t, 1); got != warehouse {
		t.Fatalf("%s: the warehouse must count %d, got %d", when, warehouse, got)
	}
	if got := f.pending(t, 3); got != other {
		t.Fatalf("%s: another branch must count %d, got %d", when, other, got)
	}
}

// TestPendingCountsOnlyTheActsOfTheSide proves the notification of S19: a case waits for
// exactly one side at a time, the count follows the phase and the two gated facts of S14, a
// closed case waits for nobody, and a case of another branch is never counted.
func TestPendingCountsOnlyTheActsOfTheSide(t *testing.T) {
	f := newFixture(t)
	f.wantPending(t, "no case yet", 0, 0, 0)

	claim := f.openClaim(t, "PENDIENTE/1")
	f.wantPending(t, "the branch must ship it", 1, 0, 0)

	// The client walks out with a used battery before the case can leave the branch (S4), and the loan
	// itself neither moves the phase nor the side that is counted (S19).
	f.lend(t, claim)
	f.wantPending(t, "the branch must still ship it", 1, 0, 0)

	if _, err := f.store.Advance(f.ctx, f.actor(2), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseInTransit}); err != nil {
		t.Fatalf("the branch must ship the case: %v", err)
	}
	f.wantPending(t, "it travelled to the warehouse", 0, 1, 0)

	if _, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtWarehouse}); err != nil {
		t.Fatalf("the warehouse must receive the case: %v", err)
	}
	f.wantPending(t, "the warehouse must verify it", 0, 1, 0)

	if _, err := f.store.Advance(f.ctx, f.actor(1), claim.ID, warrantycase.AdvanceInput{
		Phase: warrantycase.PhaseAtFactory, FactoryCaseNumber: "LEGAJO-1"}); err != nil {
		t.Fatalf("the warehouse must ship it to the factory: %v", err)
	}
	f.wantPending(t, "the factory has to answer", 0, 1, 0)

	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictRepaired, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationStock, Note: "Reparada"}); err != nil {
		t.Fatalf("the warehouse must state the verdict: %v", err)
	}
	// The unit came back for the client: the branch owes the notice and the delivery, and the
	// warehouse can release nothing until the notice is recorded (S14).
	f.wantPending(t, "the branch must answer the client", 1, 0, 0)

	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch must register the notice: %v", err)
	}
	f.wantPending(t, "the warehouse may release the unit", 1, 1, 0)

	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), claim.ID, "El cliente no vino"); err != nil {
		t.Fatalf("the warehouse must authorise the release: %v", err)
	}
	f.wantPending(t, "the unit is released, the client still waits", 1, 0, 0)

	if _, err := f.store.DeliverExchange(f.ctx, f.actor(2), claim.ID, warrantycase.DeliveryInput{
		LoanFate: warrantycase.LoanReturned, Note: "Entregada"}); err != nil {
		t.Fatalf("the branch must deliver the exchange: %v", err)
	}
	f.wantPending(t, "the case is closed", 0, 0, 0)
}

// TestPendingNeverCountsAnActTheActorCannotTake is the other half of the same rule: a finding on
// the shelf holds no unit in custody, so it never waits for a release; a claim whose battery the
// factory kept never comes back to stock, so it waits for no release either; and the branch of
// another case never counts it.
func TestPendingNeverCountsAnActTheActorCannotTake(t *testing.T) {
	f := newFixture(t)
	claim := f.openClaim(t, "SIN-CUSTODIA/1")
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer, Note: "No cubierta"}); err != nil {
		t.Fatalf("the factory verdict must be admitted: %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), claim.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch must register the notice: %v", err)
	}
	// The damaged unit stayed in the used pool and the lent one stayed with the client: there is
	// nothing the warehouse could release, so it is not counted for the warehouse (S11, S14).
	f.wantPending(t, "the uncovered claim waits only for its delivery", 1, 0, 0)

	// The finding on the shelf wrote its own units off and they came back with the resolution: no
	// notice and no release exist for it (069), so only its closure waits for the branch.
	finding, err := f.store.OpenStockDefect(f.ctx, f.actor(2), warrantycase.StockDefectInput{
		VariantID: 1, Quantity: 2, DeclaredFailure: "No retiene carga",
		Reason: "Probada en mostrador"})
	if err != nil {
		t.Fatalf("the finding must be admitted: %v", err)
	}
	f.atFactory(t, finding)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), finding.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictReplaced, ReportedDestination: warrantycase.DestinationStock,
		Note: "Reemplazada por fábrica"}); err != nil {
		t.Fatalf("the finding must resolve: %v", err)
	}
	// The finding waits for nobody: its units already returned to the branch with its verdict.
	f.wantPending(t, "the finding returns its own units", 1, 0, 0)

	// A claim whose battery the factory kept and that declared the client as its destination is the
	// same lie on the read side: the warehouse has no unit to release, so it counts no act, and the
	// branch still owes its client the answer (S11, S13, 077).
	kept := f.openClaim(t, "SIN-CUSTODIA/2")
	f.atFactory(t, kept)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), kept.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictLost, ReportedDestination: warrantycase.DestinationCustomer,
		LoanDestination: warrantycase.DestinationCustomer, Note: "La fábrica retuvo la unidad"}); err != nil {
		t.Fatalf("the factory verdict must be admitted: %v", err)
	}
	if _, err := f.store.RegisterNotice(f.ctx, f.actor(2), kept.ID, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch must register the notice: %v", err)
	}
	if _, err := f.store.AuthorizeRelease(f.ctx, f.actor(1), kept.ID,
		"La unidad no está"); !errors.Is(err, warrantycase.ErrReleaseUnavailable) {
		t.Fatalf("the unit the factory kept is never released, got %v", err)
	}
	f.wantPending(t, "the kept claim waits only for its branch, notified or not", 2, 0, 0)
}
