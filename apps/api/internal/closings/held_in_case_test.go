package closings_test

import (
	"testing"

	"luson/api/internal/closings"
)

// stockDefect writes one stock defect of a branch the way the case's own admission writes it: the
// account of that branch opens it, the database numbers it and takes the quantity off the branch's
// shelf in the same transaction (065, 067), so the case is exactly the state the settlement has to
// explain. It returns the case it stored.
func (e *env) stockDefect(t *testing.T, branch int, variant, quantity int64) int64 {
	t.Helper()
	var id int64
	if err := e.pool.QueryRow(e.ctx, `INSERT INTO warranty_cases(
  branch_location_id,origin,variant_id,quantity,declared_failure,reason,created_by_account_id)
 VALUES($1,'stock_defect',$2,$3,'no retiene carga','fallada en góndola',$4) RETURNING id`,
		int16(branch), int32(variant), quantity, int64(branch)).Scan(&id); err != nil {
		t.Fatalf("the stock defect of variant %d could not be written: %v", variant, err)
	}
	if existing, _ := e.balance(t, int64(branch), variant); existing != 4-quantity {
		t.Fatalf("the write-off must leave the branch with %d of variant %d: %d",
			4-quantity, variant, existing)
	}
	return id
}

// shipCase advances one case to `in_transit`, which is the tramo that takes its battery out of the
// branch: the phase of the case is the copy the event's own trigger writes (065).
func (e *env) shipCase(t *testing.T, id int64) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO warranty_case_events(case_id,phase,actor_account_id,note)
 VALUES($1,'in_transit',1,'sale al Almacén')`, id); err != nil {
		t.Fatalf("the case could not be shipped: %v", err)
	}
	if phase := e.text(t, "SELECT phase FROM warranty_cases WHERE id=$1", id); phase != "in_transit" {
		t.Fatalf("the shipped case must read at %q: %q", "in_transit", phase)
	}
}

// countLineOf reads one line of a sheet by the variant it counts, so a test states the line it is
// about instead of an index.
func countLineOf(t *testing.T, closing closings.Closing, variant int64) closings.CountLine {
	t.Helper()
	for _, line := range closing.CountLines {
		if line.VariantID == variant {
			return line
		}
	}
	t.Fatalf("the sheet must publish variant %d: %+v", variant, closing.CountLines)
	return closings.CountLine{}
}

// TestCountLinePublishesTheUnitsHeldInACase pins S13 and S16 on the read side. A battery written off
// by a stock defect leaves the branch's `existing` but stays on its shelf until it ships, and the case
// writes no transfer, so the snapshot the settlement opens with counts one unit fewer than the shelf
// holds. The count sheet publishes that difference per line -- the units of that variant the open
// cases of the branch hold instead of having them in stock -- so the operator who counts what they
// see can explain the number instead of resurrecting the written-off unit. The number is derived on
// read: it follows neither the snapshot nor the count, and neither of those follows it (S16).
func TestCountLinePublishesTheUnitsHeldInACase(t *testing.T) {
	e := fixture(t)
	// The branch holds four of variant 2 and finds one of them failed on the shelf: the write-off
	// leaves three in stock and one held by the case, still physically there.
	e.stockDefect(t, 2, 2, 1)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	if len(opened.CountLines) != 2 {
		t.Fatalf("the sheet must cover the branch stock: %+v", opened.CountLines)
	}
	// The line of the variant the case is about states one unit held; the other line holds none.
	if held := countLineOf(t, opened, 2); held.ExpectedQuantity != 3 || held.CountedQuantity == nil ||
		*held.CountedQuantity != 3 || held.HeldInCaseQuantity != 1 {
		t.Fatalf("the line of the failed variant must publish the unit its case holds: %+v", held)
	}
	if other := countLineOf(t, opened, 1); other.ExpectedQuantity != 10 || other.HeldInCaseQuantity != 0 {
		t.Fatalf("a variant no case is about must publish nothing held: %+v", other)
	}

	// The operator counts what is physically on the shelf: three in stock plus the one the case
	// holds. The sheet records that count against the snapshot it took, and the published number is
	// the fact that explains the difference.
	counted, err := e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{
		{VariantID: 1, Quantity: 10}, {VariantID: 2, Quantity: 4}})
	if err != nil {
		t.Fatalf("the counted sheet could not be recorded: %v", err)
	}
	if line := countLineOf(t, counted, 2); line.ExpectedQuantity != 3 || line.CountedQuantity == nil ||
		*line.CountedQuantity != 4 || line.HeldInCaseQuantity != 1 {
		t.Fatalf("the count must not move the snapshot nor the held number: %+v", line)
	}
	// It is derived on read: a refused settlement keeps it, and a read after the count states the
	// same facts as the count itself.
	read, err := e.store.Read(e.ctx, warehouse(), opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	if line := countLineOf(t, read, 2); line.HeldInCaseQuantity != 1 || line.ExpectedQuantity != 3 {
		t.Fatalf("the held number must be the same fact on every read: %+v", line)
	}
}

// TestCountLineHoldsNothingWhenTheCaseTookTheUnitAway pins the other direction of the same fact
// (S13, S16): a case holds stock only while its battery has not left the branch, so once the case is on
// its way to the warehouse the line publishes nothing held -- the unit is not on the shelf and the
// snapshot already counted what is left.
func TestCountLineHoldsNothingWhenTheCaseTookTheUnitAway(t *testing.T) {
	e := fixture(t)
	// The branch finds one of its four units of variant 2 failed and ships it the same day.
	e.shipCase(t, e.stockDefect(t, 2, 2, 1))
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	if len(opened.CountLines) != 2 {
		t.Fatalf("the sheet must cover the branch stock: %+v", opened.CountLines)
	}
	// The three units left are the whole of what the branch holds: no case holds any of them.
	for _, variant := range []int64{1, 2} {
		if line := countLineOf(t, opened, variant); line.HeldInCaseQuantity != 0 {
			t.Fatalf("a unit that already left the branch is not held: %+v", line)
		}
	}
	if line := countLineOf(t, opened, 2); line.ExpectedQuantity != 3 ||
		line.CountedQuantity == nil || *line.CountedQuantity != 3 {
		t.Fatalf("the shipped unit must not come back into the sheet: %+v", line)
	}
}

// TestClosureAppliesTheCountedSheetWithNoCaseInPlay pins that the count sheet of a settlement with no
// case in play is exactly the sheet it was: the snapshot is read from the live stock, the counted
// quantity is the only quantity the closure applies, and every line publishes that no unit is held
// (S16). Nothing of the published fact enters the arithmetic of the closure.
func TestClosureAppliesTheCountedSheetWithNoCaseInPlay(t *testing.T) {
	e := fixture(t)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	for _, variant := range []int64{1, 2} {
		if line := countLineOf(t, opened, variant); line.HeldInCaseQuantity != 0 {
			t.Fatalf("no case is about this branch: %+v", line)
		}
	}
	// The admin counts one unit of variant 1 less than the snapshot, which is the difference the
	// closure has to apply.
	if _, err := e.store.Count(e.ctx, warehouse(), opened.ID, []closings.Counted{
		{VariantID: 1, Quantity: 9}, {VariantID: 2, Quantity: 4}}); err != nil {
		t.Fatalf("the counted sheet could not be recorded: %v", err)
	}
	zero := closings.Money("0.00")
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: zero, ClosingCash: &zero,
		Observation: "sin caso en juego"}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch must accept the offer: %+v %v", closed, err)
	}
	// The stock ends where the count said, in both directions.
	for variant, want := range map[int64]int64{1: 9, 2: 4} {
		if existing, reserved := e.balance(t, 2, variant); existing != want || reserved != 0 {
			t.Fatalf("variant %d must end at the counted quantity: %d/%d", variant, existing, reserved)
		}
		if line := countLineOf(t, closed, variant); line.HeldInCaseQuantity != 0 {
			t.Fatalf("the closed sheet must publish nothing held: %+v", line)
		}
	}
	if line := countLineOf(t, closed, 1); line.ExpectedQuantity != 10 ||
		line.CountedQuantity == nil || *line.CountedQuantity != 9 {
		t.Fatalf("the closed sheet must keep the snapshot and the count: %+v", line)
	}
}
