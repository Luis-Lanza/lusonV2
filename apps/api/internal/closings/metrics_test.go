package closings_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"luson/api/internal/closings"
	"luson/api/internal/purchases"
	"luson/api/internal/sales"
)

// The metrics read is a projection of one period, never a second calculation of it: every test
// below reads the numbers of a period the database itself produced and compares them with the
// facts that produce them, so the screen and the acta can never speak of different periods.

// metricsOf reads the metrics of one settlement of branch 2, the branch the fixture settles.
func metricsOf(t *testing.T, e *env, id int64) closings.Metrics {
	t.Helper()
	metrics, err := e.store.Metrics(e.ctx, identity(2), closings.MetricsPeriod{ClosingID: &id})
	if err != nil {
		t.Fatalf("the metrics of settlement %d could not be read: %v", id, err)
	}
	return metrics
}

// historyOf reads the metrics of the whole history of branch 2.
func historyOf(t *testing.T, e *env) closings.Metrics {
	t.Helper()
	metrics, err := e.store.Metrics(e.ctx, identity(2), closings.MetricsPeriod{History: true})
	if err != nil {
		t.Fatalf("the metrics of the whole history could not be read: %v", err)
	}
	return metrics
}

// variantOfEntry reads the first catalogue variant of one entry, so a test never guesses which
// polarity a price pair was written for.
func variantOfEntry(t *testing.T, e *env, entry int64) int64 {
	t.Helper()
	var variant int64
	if err := e.pool.QueryRow(e.ctx, `SELECT id FROM catalog_variants
 WHERE catalog_entry_id=$1 ORDER BY id LIMIT 1`, entry).Scan(&variant); err != nil {
		t.Fatalf("the variant of battery %d could not be read: %v", entry, err)
	}
	return variant
}

// closeWindow closes the live settlement of branch 2 over the drawer the test states: the
// warehouse counts the stock as the system expects it, drafts the cash and proposes, and the
// branch accepts the offer. A period exists only through the database's own state machine.
func (e *env) closeWindow(t *testing.T, drawer closings.CashDraft) int64 {
	t.Helper()
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, drawer); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch could not accept the settlement: %v", err)
	}
	return opened.ID
}

// drawerOf is one closed window whose cash states the amount the test expects to read back: the
// counted drawer is what it counts, the contribution is zero, and the envelope keeps 250.00.
func drawerOf(counted string) closings.CashDraft {
	envelope := money("250.00")
	cash := money(counted)
	return closings.CashDraft{CountedCash: &cash, ContributedCash: money("0.00"),
		ClosingCash: &cash, PurchaseFundCounted: &envelope, PurchaseFundCash: &envelope,
		Observation: "acta del período"}
}

// closeSettlementOf closes one settlement of another branch, so a test can prove the metrics of a
// branch never state the periods of another one.
func (e *env) closeSettlementOf(t *testing.T, branch int64) int64 {
	t.Helper()
	if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), branch, "10.00"); err != nil {
		t.Fatalf("the commission of branch %d could not be configured: %v", branch, err)
	}
	opened, err := e.store.Open(e.ctx, warehouse(), branch)
	if err != nil {
		t.Fatalf("the settlement of branch %d could not be opened: %v", branch, err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID,
		draft("0.00", "0.00", "0.00")); err != nil {
		t.Fatalf("the cash draft of branch %d could not be saved: %v", branch, err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement of branch %d could not be proposed: %v", branch, err)
	}
	if _, err := e.store.Decide(e.ctx, identity(int(branch)), opened.ID,
		closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("branch %d could not accept its settlement: %v", branch, err)
	}
	return opened.ID
}

// TestMetricsPublishesTheClosedPeriodOfItsWindow pins S3 and S6 on the read: a closed settlement
// publishes the money its acta froze -- not a recalculation of the ledgers -- with the volume of
// its own window, the count of the drawer and the replacement the warehouse left in the envelope.
func TestMetricsPublishesTheClosedPeriodOfItsWindow(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	// One sale of two units inside the second window: 200.00 collected in cash, 25.00 of commission
	// at the 12.50% the fixture configures.
	e.sell(t, 1, 2, "100.00", sales.PaymentCash)
	id := e.closeWindow(t, drawerOf("700.00"))

	metrics := metricsOf(t, e, id)
	if metrics.Source != "settlement" {
		t.Fatalf("a closed settlement states its own origin, got %q", metrics.Source)
	}
	if metrics.Sales.Total != "200.00" || metrics.Sales.Cash != "200.00" ||
		metrics.Sales.Card != "0.00" || metrics.Sales.Transfer != "0.00" ||
		metrics.Sales.QR != "0.00" || metrics.Sales.Commission != "25.00" {
		t.Fatalf("the period must publish the money its closure froze: %+v", metrics.Sales)
	}
	// The volume is the one thing the closing does not state, so it is read from the sales of the
	// same half-open window.
	if metrics.Sales.Sales != 1 || metrics.Sales.Units != 2 {
		t.Fatalf("the period must count the sales and the units of its window: %+v", metrics.Sales)
	}
	if metrics.Cash == nil || metrics.Cash.Counted == nil || *metrics.Cash.Counted != "700.00" ||
		metrics.Cash.Difference == nil || *metrics.Cash.Difference != "0.00" ||
		metrics.Cash.Expected != "700.00" || metrics.Cash.Opening != "500.00" ||
		metrics.Cash.Sales != "200.00" {
		t.Fatalf("the drawer of the period must be the counted one: %+v", metrics.Cash)
	}
	// The envelope states what it inherited, what it spent and the replacement the warehouse left,
	// which is the opening of the next period and a fact of this closure.
	if metrics.Fund == nil || metrics.Fund.Opening != "0.00" ||
		metrics.Fund.Purchases != "0.00" || metrics.Fund.Expected != "0.00" ||
		metrics.Fund.Counted == nil || *metrics.Fund.Counted != "250.00" ||
		metrics.Fund.Replacement == nil || *metrics.Fund.Replacement != "250.00" {
		t.Fatalf("the envelope must publish the replacement of its closure: %+v", metrics.Fund)
	}
	if len(metrics.Top) != 1 {
		t.Fatalf("the period sold one model: %+v", metrics.Top)
	}
	if model := metrics.Top[0]; model.Brand != "CAR" || model.Model != "NS40ZL" ||
		model.Capacity != "35" || model.Units != 2 || model.Money != "200.00" {
		t.Fatalf("the ranking must publish the model, its units and its money: %+v", model)
	}
	// The period bought no material, so the sheet is an empty one and never a missing one.
	if metrics.Materials == nil || metrics.Materials.Used != 0 || metrics.Materials.Scrap != 0 ||
		metrics.Materials.Materials == nil || len(metrics.Materials.Materials) != 0 {
		t.Fatalf("a period without material states an empty sheet: %+v", metrics.Materials)
	}
}

// TestMetricsWindowIsHalfOpenAtTheCut pins S2 and S6: a period is the half-open window
// [period_start, cut_at) of its closure, so a sale made after the cut belongs to no closed period.
// The frozen money does not move either: the closure is read, never recomputed.
func TestMetricsWindowIsHalfOpenAtTheCut(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	id := e.closeWindow(t, drawerOf("600.00"))
	// The branch keeps selling after the cut of the closed period: the sale is the next period's,
	// never this one's second one.
	e.sell(t, 2, 1, "100.00", sales.PaymentCash)

	closed := metricsOf(t, e, id)
	if closed.Sales.Sales != 1 || closed.Sales.Units != 1 || closed.Sales.Total != "100.00" ||
		closed.Sales.Cash != "100.00" {
		t.Fatalf("a sale after the cut belongs to no closed period: %+v", closed.Sales)
	}
	// The whole history is where the two sales are, and the closed period is the one the acta signed.
	history := historyOf(t, e)
	if history.Sales.Sales != 2 || history.Sales.Units != 2 || history.Sales.Total != "200.00" ||
		history.Sales.Cash != "200.00" {
		t.Fatalf("the history must publish every sale of the branch: %+v", history.Sales)
	}
}

// TestMetricsRankingIsByUnits pins S4: the ranking is ordered by the units sold and not by the
// money they made, the money is the secondary reading of the same rows, and equal units are broken
// by the catalogue's own order so the same period always publishes the same ranking.
func TestMetricsRankingIsByUnits(t *testing.T) {
	e := fixture(t)
	first, second, third := int64(1), int64(2), int64(3)
	// The fixture prices batteries 1 and 2; the third one is priced here through the store the
	// Catálogo writes.
	e.price(t, third, "0.01", "100.00", 2)
	one, two, three := variantOfEntry(t, e, first), variantOfEntry(t, e, second),
		variantOfEntry(t, e, third)
	e.seedStock(t, 2, map[int64]int64{one: 100, two: 100, three: 100})
	e.closeFirstSettlement(t, "500.00")
	// HYBRID sold five units and is the largest volume although its brand sorts last among the
	// three; CAR and TOYO sold three each and are broken by brand in byte order.
	e.sell(t, three, 5, "20.00", sales.PaymentCash)
	e.sell(t, one, 3, "100.00", sales.PaymentCash)
	e.sell(t, two, 3, "50.00", sales.PaymentCash)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}

	metrics := metricsOf(t, e, opened.ID)
	if metrics.Source != "live" {
		t.Fatalf("the period in progress states its own origin, got %q", metrics.Source)
	}
	want := []struct {
		brand, model, capacity string
		money                  closings.Money
		units                  int64
	}{
		{"HYBRID", "NS40ZL", "35", "100.00", 5},
		{"CAR", "NS40ZL", "35", "300.00", 3},
		{"TOYO", "NS40ZL", "35", "150.00", 3},
	}
	if len(metrics.Top) != len(want) {
		t.Fatalf("the ranking must publish the three models of the period: %+v", metrics.Top)
	}
	for i, expected := range want {
		model := metrics.Top[i]
		if model.Brand != expected.brand || model.Model != expected.model ||
			model.Capacity != expected.capacity || model.Units != expected.units ||
			model.Money != expected.money {
			t.Fatalf("row %d of the ranking is %+v, want %+v", i, model, expected)
		}
	}
	// The money of the period is the secondary reading of the very same sales.
	if metrics.Sales.Total != "550.00" || metrics.Sales.Units != 11 || metrics.Sales.Sales != 3 {
		t.Fatalf("the period must publish the volume of its sales: %+v", metrics.Sales)
	}
}

// TestMetricsPeriodWithoutSalesPublishesAnEmptyRanking pins the honest empty answer: a period that
// sold nothing states zero sales and an empty ranking instead of failing, so a branch that has not
// sold yet can open its metrics.
func TestMetricsPeriodWithoutSalesPublishesAnEmptyRanking(t *testing.T) {
	e := fixture(t)
	// The bootstrap settlement of the branch covers an empty period: nothing was sold before it.
	id := e.closeFirstSettlement(t, "500.00")

	metrics := metricsOf(t, e, id)
	if metrics.Sales.Sales != 0 || metrics.Sales.Units != 0 || metrics.Sales.Total != "0.00" ||
		metrics.Sales.Cash != "0.00" || metrics.Sales.Commission != "0.00" {
		t.Fatalf("a period without sales states zero, never an error: %+v", metrics.Sales)
	}
	if metrics.Top == nil || len(metrics.Top) != 0 {
		t.Fatalf("a period without sales publishes an empty ranking: %+v", metrics.Top)
	}
	// The shelf is today's, whatever the period sold.
	if want := e.scalar(t, `SELECT coalesce(sum(existing),0) FROM inventory_balances
 WHERE location_id=2`); metrics.Stock.Units != want {
		t.Fatalf("the period must publish the shelf of the branch: %d, want %d",
			metrics.Stock.Units, want)
	}
}

// TestMetricsOfTheLiveSettlementPublishesNoCount pins S6 on the period in progress: it publishes
// the money it is collecting and the material its window bought, and states no counted cash, no
// difference and no delivery, because nobody counted them yet.
func TestMetricsOfTheLiveSettlementPublishesNoCount(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	// Two used batteries bought inside the window: the sheet is seeded by the opener and stays
	// uncounted, which is the state a live period publishes.
	e.purchaseLines(t, "metrics-live-material-01", "10.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "5.00"}}, nil)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)

	metrics := metricsOf(t, e, opened.ID)
	if metrics.Source != "live" {
		t.Fatalf("the period in progress states its own origin, got %q", metrics.Source)
	}
	if metrics.Sales.Total != "100.00" || metrics.Sales.Cash != "100.00" ||
		metrics.Sales.Sales != 1 || metrics.Sales.Units != 1 {
		t.Fatalf("the live period must publish the money and volume it has: %+v", metrics.Sales)
	}
	if metrics.Cash == nil || metrics.Cash.Counted != nil || metrics.Cash.Difference != nil ||
		metrics.Cash.Expected != "600.00" {
		t.Fatalf("an uncounted drawer states no count and no difference: %+v", metrics.Cash)
	}
	if metrics.Fund == nil || metrics.Fund.Counted != nil || metrics.Fund.Difference != nil ||
		metrics.Fund.Replacement != nil {
		t.Fatalf("an uncounted envelope states no count, no difference and no replacement: %+v",
			metrics.Fund)
	}
	if metrics.Materials == nil || metrics.Materials.Used != 2 ||
		metrics.Materials.UsedDelivered != nil || metrics.Materials.ScrapDelivered != nil {
		t.Fatalf("an uncounted sheet states no delivery: %+v", metrics.Materials)
	}
}

// TestMetricsOfTheWholeHistoryStatesNoEnvelope pins S9: the whole history publishes the sales, the
// ranking and the shelf, and leaves the drawer, the envelope and the material null. A drawer is
// closed in each settlement and does not accumulate, so a history states no drawer at all.
func TestMetricsOfTheWholeHistoryStatesNoEnvelope(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 2, "100.00", sales.PaymentCash)
	e.sell(t, 2, 1, "50.00", sales.PaymentCard)
	e.purchaseLines(t, "metrics-history-material-01", "10.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "5.00"}}, nil)

	metrics := historyOf(t, e)
	if metrics.Source != "history" {
		t.Fatalf("the whole history states its own origin, got %q", metrics.Source)
	}
	if metrics.Sales.Sales != 2 || metrics.Sales.Units != 3 || metrics.Sales.Total != "250.00" ||
		metrics.Sales.Cash != "200.00" || metrics.Sales.Card != "50.00" {
		t.Fatalf("the history must publish every sale of the branch: %+v", metrics.Sales)
	}
	// The commission of the history is what the closed settlements earned: the live period has not
	// been signed yet, so it pays nothing into the history.
	if metrics.Sales.Commission != "0.00" {
		t.Fatalf("the history counts the commission of the closed settlements: %+v", metrics.Sales)
	}
	if metrics.Cash != nil || metrics.Fund != nil || metrics.Materials != nil {
		t.Fatalf("the history states no drawer, no envelope and no material: %+v", metrics)
	}
	if len(metrics.Top) != 1 || metrics.Top[0].Units != 3 || metrics.Top[0].Money != "250.00" {
		t.Fatalf("the history publishes the ranking of what it sold: %+v", metrics.Top)
	}
	if want := e.scalar(t, `SELECT coalesce(sum(existing),0) FROM inventory_balances
 WHERE location_id=2`); metrics.Stock.Units != want {
		t.Fatalf("the history publishes the shelf of the branch: %d, want %d", metrics.Stock.Units, want)
	}
}

// TestMetricsHistoryIsOneSnapshot pins the invariant the history read owes its reader: the ranking,
// the money and the count are one act, so the units the ranking publishes can never exceed the units
// the history says it sold. The branch keeps selling while the history is read, which is exactly the
// state five separate reads contradict -- the ranking would count a sale the money never saw.
func TestMetricsHistoryIsOneSnapshot(t *testing.T) {
	e := fixture(t)
	// Enough shelf for the writer below: the settlement counts what the branch holds when it opens.
	e.seedStock(t, 2, map[int64]int64{1: 40, 2: 40})
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	// The writer is the point of sale's own path: every sale it issues is a committed document,
	// so a read that took five snapshots would see it in some readings and not in others.
	done := make(chan error, 1)
	go func() {
		for range 20 {
			units := []sales.Unit{{SerialNumber: sales.SerialNumber(fmt.Sprintf("BAT-%d", serials.Add(1)))}}
			_, err := e.sales.Create(e.ctx, identity(2), sales.CreateInput{
				Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "100.00"}},
				Customer: sales.Customer{Name: "Cliente concurrente"},
				Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "100.00",
					Units: units}},
			})
			if err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < 20; i++ {
		history := historyOf(t, e)
		var units int64
		for _, model := range history.Top {
			units += model.Units
		}
		if units > history.Sales.Units {
			t.Fatalf("read %d: the ranking counts %d units and the history sold %d: %+v %+v",
				i, units, history.Sales.Units, history.Top, history.Sales)
		}
	}
	if err := <-done; err != nil {
		t.Fatalf("the concurrent sale could not be issued: %v", err)
	}
}

// TestMetricsRefusesAFractionalUnitOfAUsedLine pins S8 at the seam the read depends on: a battery
// is a whole thing, so half a used battery is refused before it can be stored, the sheet it would
// have been written into is left exactly as the opener seeded it, and the read keeps publishing a
// whole number of units.
//
// The fold of the read checks the same rule again -- a fractional unit never reaches it, because
// the column refuses the fraction and storedQuantity refuses the text before the projection runs --
// so the reachable refusal is the warehouse's own count, which is what this test drives.
func TestMetricsRefusesAFractionalUnitOfAUsedLine(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.purchaseLines(t, "metrics-fraction-material-01", "10.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "5.00"}}, nil)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	seeded := materialSheet(t, mustRead(t, e, opened.ID))
	for _, quantity := range []closings.Quantity{"2.5", "2.500", "0.5"} {
		half := []closings.MaterialCounted{{Kind: closings.MaterialKindUsed, Model: "NS60ZL",
			Quantity: quantity}}
		_, err := e.store.CountMaterials(e.ctx, warehouse(), opened.ID, half)
		refused(t, err, closings.ErrInvalid)
	}
	if got := materialSheet(t, mustRead(t, e, opened.ID)); strings.Join(got, ",") !=
		strings.Join(seeded, ",") {
		t.Fatalf("a refused fraction must write nothing, got %v want %v", got, seeded)
	}
	metrics := metricsOf(t, e, opened.ID)
	if metrics.Materials == nil || metrics.Materials.Used != 2 ||
		metrics.Materials.UsedDelivered != nil {
		t.Fatalf("the read publishes the whole units of the period: %+v", metrics.Materials)
	}
}

// TestMetricsPublishesACountedQuantityAboveTheSheet pins the other side of the same seam (S3, S8):
// the warehouse counts more material than the period bought, the store admits it because an informed
// difference blocks nothing, and the read publishes the counted quantity instead of the bought one,
// so the excess keeps its own value all the way to the screen.
func TestMetricsPublishesACountedQuantityAboveTheSheet(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	// Two used batteries of NS60ZL are bought inside the window: the sheet expects two.
	e.purchaseLines(t, "metrics-over-material-01", "10.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "5.00"}}, nil)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	// The warehouse counts three: more than the period bought, and admitted like any count.
	if _, err := e.store.CountMaterials(e.ctx, warehouse(), opened.ID, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "3"}}); err != nil {
		t.Fatalf("a count above the sheet must be admitted: %v", err)
	}
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, drawerOf("500.00")); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("a count above the sheet must not block the proposal: %v", err)
	}
	closed, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch must accept the settlement: %+v %v", closed.Status, err)
	}

	metrics := metricsOf(t, e, opened.ID)
	if metrics.Materials == nil || metrics.Materials.Used != 2 {
		t.Fatalf("the sheet publishes what the period bought: %+v", metrics.Materials)
	}
	if metrics.Materials.UsedDelivered == nil || *metrics.Materials.UsedDelivered != 3 {
		t.Fatalf("the delivery publishes what the warehouse counted, excess included: %+v",
			metrics.Materials)
	}
}

// TestMetricsIsTheBranchOwnRead pins S5 and S10 at the store: a branch reads its own periods and no
// other's, the warehouse owns no drawer to read here, and a period the branch does not have is a
// request error instead of an empty answer.
func TestMetricsIsTheBranchOwnRead(t *testing.T) {
	e := fixture(t)
	id := e.closeFirstSettlement(t, "500.00")
	// A closing of another branch is not found, exactly like its settlements.
	other := e.closeSettlementOf(t, 3)
	_, err := e.store.Metrics(e.ctx, identity(2), closings.MetricsPeriod{ClosingID: &other})
	refused(t, err, closings.ErrNotFound)
	// The warehouse settles branches and owns no drawer: it has no metrics of its own.
	_, err = e.store.Metrics(e.ctx, warehouse(), closings.MetricsPeriod{ClosingID: &id})
	refused(t, err, closings.ErrForbidden)
	// The two shapes of a period are exclusive, and one of them is always stated.
	_, err = e.store.Metrics(e.ctx, identity(2), closings.MetricsPeriod{})
	refused(t, err, closings.ErrInvalid)
	_, err = e.store.Metrics(e.ctx, identity(2), closings.MetricsPeriod{History: true, ClosingID: &id})
	refused(t, err, closings.ErrInvalid)
	// A settlement that does not exist is not a period the branch has.
	absent := int64(9999)
	_, err = e.store.Metrics(e.ctx, identity(2), closings.MetricsPeriod{ClosingID: &absent})
	refused(t, err, closings.ErrNotFound)
}

// closeContributionOf closes the settlement of another branch over a contribution the test states,
// so that branch's ledger holds a movement of its own and never one of branch 2.
func (e *env) closeContributionOf(t *testing.T, branch int64, contribution string) int64 {
	t.Helper()
	if _, err := e.store.ConfigureCommission(e.ctx, warehouse(), branch, "10.00"); err != nil {
		t.Fatalf("the commission of branch %d could not be configured: %v", branch, err)
	}
	opened, err := e.store.Open(e.ctx, warehouse(), branch)
	if err != nil {
		t.Fatalf("the settlement of branch %d could not be opened: %v", branch, err)
	}
	e.countAll(t, opened.ID)
	zero, left := money("0.00"), money(contribution)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: left, ClosingCash: &left,
		Observation: "arranque de la otra sucursal",
	}); err != nil {
		t.Fatalf("the cash draft of branch %d could not be saved: %v", branch, err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement of branch %d could not be proposed: %v", branch, err)
	}
	if _, err := e.store.Decide(e.ctx, identity(int(branch)), opened.ID,
		closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("branch %d could not accept its settlement: %v", branch, err)
	}
	return opened.ID
}

// TestMetricsTodayFollowsTheSettlementFormula pins S12 on the read: the drawer of today is what the
// last closed settlement left in it plus the cash the sales collected after that cut minus the
// expenses paid out of it after the same cut -- the settlement's own identity -- and the three
// sources publish the same reading, whether or not a period is on screen.
func TestMetricsTodayFollowsTheSettlementFormula(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	// Two cash sales after the cut, one by card that never entered the drawer, and one expense the
	// branch paid out of it. The card sale is the term the formula must not read.
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.sell(t, 2, 1, "50.00", sales.PaymentCard)
	e.sell(t, 1, 1, "40.00", sales.PaymentCash)
	e.expense(t, 2, "30.00", "Flete de la tarde")
	var cut time.Time
	if err := e.pool.QueryRow(e.ctx, `SELECT cut_at FROM branch_closings WHERE id=$1`,
		first).Scan(&cut); err != nil {
		t.Fatalf("the cut of the first settlement could not be read: %v", err)
	}
	read := func(source string) closings.MetricsToday {
		t.Helper()
		switch source {
		case "settlement":
			return metricsOf(t, e, first).Today
		case "history":
			return historyOf(t, e).Today
		default:
			opened, err := e.store.Open(e.ctx, warehouse(), 2)
			if err != nil {
				t.Fatalf("the period could not be opened: %v", err)
			}
			return metricsOf(t, e, opened.ID).Today
		}
	}
	for _, source := range []string{"settlement", "history", "live"} {
		today := read(source)
		if today.Since == nil || !today.Since.Equal(cut) {
			t.Fatalf("%s: today must start at the cut of the last closed settlement: %+v",
				source, today.Since)
		}
		// 500.00 left by the first closing + 140.00 of cash sales − 30.00 of expenses.
		if today.Opening != "500.00" || today.Sales != "140.00" || today.Expenses != "30.00" ||
			today.Expected != "610.00" {
			t.Fatalf("%s: today must follow the settlement's own formula: %+v", source, today)
		}
	}
}

// TestMetricsTodayPublishesTheCommissionTheBranchIsEarning pins S18 on the read: the drawer of today
// states what the branch is earning so far -- the rate the warehouse froze for it, the total it sold
// since the last cut and the commission those two produce, rounded once -- and it states it whatever
// period the screen is showing, because the branch is inside exactly one window of its own.
func TestMetricsTodayPublishesTheCommissionTheBranchIsEarning(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	// One cash sale and one by card: the commission is on the total sold, not on what reached the
	// drawer, so the second one is a term of this reading even though the drawer never sees it.
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.sell(t, 1, 1, "40.00", sales.PaymentCard)
	read := func(source string) closings.MetricsToday {
		t.Helper()
		switch source {
		case "settlement":
			return metricsOf(t, e, first).Today
		case "history":
			return historyOf(t, e).Today
		default:
			opened, err := e.store.Open(e.ctx, warehouse(), 2)
			if err != nil {
				t.Fatalf("the period could not be opened: %v", err)
			}
			return metricsOf(t, e, opened.ID).Today
		}
	}
	for _, source := range []string{"settlement", "history", "live"} {
		today := read(source)
		// 140.00 sold since the cut, at the 12.50% the fixture configures: 17.50 of commission.
		if today.Rate == nil || *today.Rate != "12.50" {
			t.Fatalf("%s: today must state the rate the warehouse configured: %+v", source, today.Rate)
		}
		if today.Sold != "140.00" || today.Commission != "17.50" {
			t.Fatalf("%s: today must state the base and the commission it produces: %+v", source, today)
		}
	}
}

// TestMetricsTodayStatesNoCommissionWithoutAConfiguredRate pins S20 on the read: a branch the
// warehouse never gave a rate to is still earning nothing, and the answer says so instead of
// inventing a rate or publishing a commission it could not have computed.
func TestMetricsTodayStatesNoCommissionWithoutAConfiguredRate(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	if _, err := e.pool.Exec(e.ctx, `DELETE FROM branch_settings WHERE branch_location_id=2`); err != nil {
		t.Fatalf("the configured rate could not be removed: %v", err)
	}
	today := historyOf(t, e).Today
	if today.Rate != nil {
		t.Fatalf("a branch without a configured rate states no rate: %+v", *today.Rate)
	}
	// The base is a fact of the window whether or not a rate exists; the commission is not.
	if today.Sold != "100.00" || today.Commission != "0.00" {
		t.Fatalf("today must state the base and a commission of zero: %+v", today)
	}
}

// TestMetricsTodayWindowStartsAtTheCutOfTheLastClosure pins where the window of S12 begins: at the
// cut of the last closed settlement, which is the instant its period ended and is earlier than its
// closure. A sale and an expense recorded after that cut are in the drawer of today because no
// settlement states them -- the period of the settlement ended at the cut -- so a window that
// began at the closure would leave those transactions in nobody's account.
func TestMetricsTodayWindowStartsAtTheCutOfTheLastClosure(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	var cut, closedAt time.Time
	if err := e.pool.QueryRow(e.ctx, `SELECT cut_at,closed_at FROM branch_closings WHERE id=$1`,
		first).Scan(&cut, &closedAt); err != nil {
		t.Fatalf("the cut and the closure of the first settlement could not be read: %v", err)
	}
	if !closedAt.After(cut) {
		t.Fatalf("the fixture must close after its cut: cut %v, closed %v", cut, closedAt)
	}
	// The branch operates after the cut of the closed settlement and before any new one exists.
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.expense(t, 2, "30.00", "Flete después del corte")

	today := historyOf(t, e).Today
	if today.Since == nil || !today.Since.Equal(cut) {
		t.Fatalf("today must start at the cut %v of the last closed settlement: %v", cut, today.Since)
	}
	if today.Since.Equal(closedAt) {
		t.Fatalf("today must not start at the closure %v: the gap between cut and closure belongs "+
			"to no settlement", closedAt)
	}
	// 500.00 left by the closing + 100.00 collected after its cut − 30.00 spent after the same cut.
	if today.Opening != "500.00" || today.Sales != "100.00" || today.Expenses != "30.00" ||
		today.Expected != "570.00" {
		t.Fatalf("the drawer must count what happened after the cut: %+v", today)
	}
	// The closed settlement is the other side of the same boundary: its window ended at the cut, so
	// neither transaction is a term of what its acta signed.
	closed := metricsOf(t, e, first)
	if closed.Sales.Cash != "0.00" || closed.Cash == nil || closed.Cash.Expenses != "0.00" {
		t.Fatalf("a closed settlement states no money after its cut: %+v %+v", closed.Sales, closed.Cash)
	}
}

// TestMetricsTodayStartsAtZeroWithoutAClosedSettlement pins the other half of S12: a branch that
// never closed a settlement states no cut, opens at zero and covers everything it ever did, so the
// card can say with words where its window begins instead of inventing an instant.
func TestMetricsTodayStartsAtZeroWithoutAClosedSettlement(t *testing.T) {
	e := fixture(t)
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.expense(t, 2, "20.00", "Flete del arranque")

	today := historyOf(t, e).Today
	if today.Since != nil {
		t.Fatalf("a branch without a closed settlement states no cut: %v", *today.Since)
	}
	if today.Opening != "0.00" || today.Sales != "100.00" || today.Expenses != "20.00" ||
		today.Expected != "80.00" {
		t.Fatalf("today must start at zero and follow the same formula: %+v", today)
	}
	if len(today.Movements) != 1 || today.Movements[0].Kind != "gasto" ||
		today.Movements[0].Amount != "20.00" {
		t.Fatalf("the window without a cut is everything the branch did: %+v", today.Movements)
	}
}

// TestMetricsTodayListsMovementsOldestFirstWithoutMovingTheExpectation pins S13 and S14 together: the
// ledger rows of the window are listed from the oldest to the newest with their kind, amount and
// moment, and they are never terms of the expectation -- the identity is the settlement's, so a
// contribution and a collection stay information beside it.
func TestMetricsTodayListsMovementsOldestFirstWithoutMovingTheExpectation(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	e.expense(t, 2, "10.00", "Flete uno")
	e.expense(t, 2, "30.00", "Flete dos")
	e.expense(t, 2, "45.50", "Flete tres")

	today := historyOf(t, e).Today
	// The contribution of the first closing happened at the cut itself, so it is inside the window:
	// the same instant is not before it.
	want := []struct{ kind, amount string }{
		{"aporte", "500.00"}, {"gasto", "10.00"}, {"gasto", "30.00"}, {"gasto", "45.50"},
	}
	if len(today.Movements) != len(want) {
		t.Fatalf("the card must list every movement of the window: %+v", today.Movements)
	}
	for i, expected := range want {
		movement := today.Movements[i]
		if movement.Kind != expected.kind || movement.Amount != closings.Money(expected.amount) {
			t.Fatalf("movement %d is %+v, want %s %s", i, movement, expected.kind, expected.amount)
		}
		if movement.OccurredAt.IsZero() {
			t.Fatalf("movement %d states no moment: %+v", i, movement)
		}
		if i > 0 && movement.OccurredAt.Before(today.Movements[i-1].OccurredAt) {
			t.Fatalf("the list must read oldest first: %+v", today.Movements)
		}
	}
	// The movements are information: the expectation reads the ledgers and never the list, so the
	// contribution neither adds to it nor the expenses subtract twice.
	if today.Opening != "500.00" || today.Sales != "100.00" || today.Expenses != "85.50" ||
		today.Expected != "514.50" {
		t.Fatalf("the expectation must not read the movements: %+v", today)
	}
}

// TestMetricsTodayDoesNotSubtractACollectionAfterTheCut pins S5 at the seam it protects: the
// warehouse takes 100.00 out of the drawer at the second closing, so the ledger holds a recaudación
// of that amount at the instant of the cut. That row belongs to the acta, which already stated it in
// its own columns, so it is listed and never subtracted a second time.
func TestMetricsTodayDoesNotSubtractACollectionAfterTheCut(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	// The branch collected 100.00 in cash after the first cut, and the warehouse takes the drawer.
	e.sell(t, 1, 1, "100.00", sales.PaymentCash)
	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	e.countAll(t, opened.ID)
	if _, err := e.store.SaveCash(e.ctx, warehouse(), opened.ID, closings.CashDraft{
		CountedCash: moneyPtr("600.00"), ContributedCash: money("0.00"),
		ClosingCash: moneyPtr("500.00"), PurchaseFundCounted: moneyPtr("250.00"),
		PurchaseFundCash: moneyPtr("250.00"), Observation: "acta con recaudación",
	}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	if _, err := e.store.Propose(e.ctx, warehouse(), opened.ID); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if _, err := e.store.Decide(e.ctx, identity(2), opened.ID, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch could not accept the settlement: %v", err)
	}

	today := historyOf(t, e).Today
	// 500.00 left by the second closing, no sales and no expenses after it: the collection of 100.00
	// the ledger holds does not reduce the drawer a second time.
	if today.Opening != "500.00" || today.Sales != "0.00" || today.Expenses != "0.00" ||
		today.Expected != "500.00" {
		t.Fatalf("a collection after the cut must not reduce the expectation: %+v", today)
	}
	if len(today.Movements) != 1 || today.Movements[0].Kind != "recaudacion" ||
		today.Movements[0].Amount != "100.00" || today.Movements[0].Effective != "-100.00" {
		t.Fatalf("the collection of the cut must be listed with its effect: %+v", today.Movements)
	}
}

// TestMetricsTodayNetsTheCorrectionsOfItsWindow pins S4 on the drawer of today: the expense the card
// states is the NET expense of its window, and the expectation is the drawer's own identity over every
// movement of that window -- opening + cash sales + the signed effect of the rows -- so a correction of
// a gasto lowers the expense and raises the expectation by the same amount, an aporte raises it and a
// recaudación lowers it, exactly as the book of the same drawer states them (S13).
func TestMetricsTodayNetsTheCorrectionsOfItsWindow(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	e.sell(t, 1, 1, "200.00", sales.PaymentCash)
	flete := e.expense(t, 2, "100.00", "Flete mal cargado")
	e.correction(t, 2, flete.ID, "40.00", "Flete corregido")
	e.book(t, 2, "aporte", "25.00", "Vuelto para cambio", nil)
	e.book(t, 2, "recaudacion", "15.00", "Recaudación de la sucursal", nil)

	today := historyOf(t, e).Today
	// 100.00 paid out of the drawer and 40.00 of it returned: 60.00 of expense and never 100.00.
	if today.Opening != "500.00" || today.Sales != "200.00" || today.Expenses != "60.00" {
		t.Fatalf("the expense of the card must be the net of its corrections: %+v", today)
	}
	// S4: 500.00 inherited + 200.00 collected − 60.00 of net expenses + 25.00 of aportes
	// − 15.00 of recaudaciones = 650.00, the one arithmetic the book of the drawer states.
	if today.Effective != "-50.00" || today.Expected != "650.00" {
		t.Fatalf("the expectation must sum every signed effect of the window: %+v", today)
	}
}

// TestMetricsTodayPublishesACorrectionAsMoneyComingBack pins S13 on the list beside the card: a
// correction row is published with its own kind and the signed effect the ledger states -- the opposite
// direction of the movement it answers -- and it never makes the read fail closed the way a kind the
// ledger writes and the read does not know would.
func TestMetricsTodayPublishesACorrectionAsMoneyComingBack(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	flete := e.expense(t, 2, "10.00", "Flete")
	e.correction(t, 2, flete.ID, "6.00", "Flete corregido")

	today := historyOf(t, e).Today
	// The contribution the first closing left in the drawer is listed beside the two rows of the
	// window: the list is the ledger of the window, oldest first, whatever the expectation sums.
	want := []struct{ kind, amount, effective string }{
		{"aporte", "500.00", "500.00"},
		{"gasto", "10.00", "-10.00"},
		{"correccion", "6.00", "6.00"},
	}
	if len(today.Movements) != len(want) {
		t.Fatalf("the card must list every movement of the window: %+v", today.Movements)
	}
	for i, expected := range want {
		movement := today.Movements[i]
		if movement.Kind != expected.kind || movement.Amount != closings.Money(expected.amount) ||
			movement.Effective != closings.Signed(expected.effective) {
			t.Fatalf("movement %d is %+v, want %s %s %s", i, movement, expected.kind,
				expected.amount, expected.effective)
		}
	}
	// The window states the net of those two rows: 10.00 paid out and 6.00 returned is 4.00 of
	// expense, and the drawer of the branch holds the 500.00 its only settlement left in it minus it.
	if today.Expenses != "4.00" || today.Effective != "-4.00" || today.Expected != "496.00" {
		t.Fatalf("the correction must reach the card as money coming back: %+v", today)
	}
}

// TestMetricsTodayReadsOnlyItsOwnBranch pins S5 on the new block: the drawer of today is the ledger of
// the actor's branch and no other's, so a movement of another branch never appears in it.
func TestMetricsTodayReadsOnlyItsOwnBranch(t *testing.T) {
	e := fixture(t)
	// Branch 3 closes a settlement over a contribution of 300.00: its ledger holds an aporte that
	// belongs to it and never to branch 2.
	e.closeContributionOf(t, 3, "300.00")

	today := historyOf(t, e).Today
	if today.Since != nil || today.Opening != "0.00" || today.Expected != "0.00" ||
		len(today.Movements) != 0 {
		t.Fatalf("today must read the actor's own branch: %+v", today)
	}
	// The branch that closed it reads its own drawer.
	other, err := e.store.Metrics(e.ctx, identity(3), closings.MetricsPeriod{History: true})
	if err != nil {
		t.Fatalf("the metrics of branch 3 could not be read: %v", err)
	}
	if other.Today.Since == nil || other.Today.Opening != "300.00" ||
		other.Today.Expected != "300.00" || len(other.Today.Movements) != 1 ||
		other.Today.Movements[0].Kind != "aporte" ||
		other.Today.Movements[0].Amount != "300.00" {
		t.Fatalf("the branch that closed the settlement reads its own drawer: %+v", other.Today)
	}
}

// cutOf reads the cut of one closed settlement, so a test states where the window of the envelope of
// today begins without guessing it.
func (e *env) cutOf(t *testing.T, id int64) time.Time {
	t.Helper()
	var cut time.Time
	if err := e.pool.QueryRow(e.ctx, `SELECT cut_at FROM branch_closings WHERE id=$1`, id).Scan(&cut); err != nil {
		t.Fatalf("the cut of settlement %d could not be read: %v", id, err)
	}
	return cut
}

// TestMetricsFundTodayIsTheOpeningMinusThePurchasesAfterTheCut pins S15 and S16 on the read: the
// purchase fund of today is what the last closed settlement left in the envelope minus the cash the
// branch spent on purchases after that cut, with the volume those same documents bought -- and the
// three sources publish the same envelope, whether or not a period is on screen.
func TestMetricsFundTodayIsTheOpeningMinusThePurchasesAfterTheCut(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	// One purchase of 60.00 belongs to the previous window: the envelope of today must not count it.
	e.purchase(t, "metrics-fund-today-before-01", "60.00")
	// The second settlement closes with 250.00 in the envelope, which is what the next period
	// inherits as its opening.
	second := e.closeWindow(t, drawerOf("700.00"))
	cut := e.cutOf(t, second)
	// The branch buys after that cut: two used batteries at 10.00 and a kilogram and a half of copper
	// at 10.00, paid out of the envelope in cash. 20.00 + 15.00 = 35.00.
	e.purchaseLines(t, "metrics-fund-today-after-01", "35.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"}},
		[]purchases.ScrapLineInput{{MaterialID: 1, Kg: "1.500", PricePerKg: "10.00"}})

	read := func(source string) closings.MetricsFundToday {
		t.Helper()
		switch source {
		case "settlement":
			return metricsOf(t, e, second).FundToday
		case "history":
			return historyOf(t, e).FundToday
		default:
			opened, err := e.store.Open(e.ctx, warehouse(), 2)
			if err != nil {
				t.Fatalf("the period could not be opened: %v", err)
			}
			return metricsOf(t, e, opened.ID).FundToday
		}
	}
	for _, source := range []string{"settlement", "history", "live"} {
		fund := read(source)
		if fund.Since == nil || !fund.Since.Equal(cut) {
			t.Fatalf("%s: the fund of today must start at the cut of the last closure: %+v",
				source, fund.Since)
		}
		// 250.00 left in the envelope − 35.00 spent after the cut = 215.00, and the volume of those
		// same documents: one purchase, two batteries and 1.500 kg of scrap.
		if fund.Opening != "250.00" || fund.Purchases != "35.00" || fund.Balance != "215.00" ||
			fund.Documents != 1 || fund.UsedUnits != 2 || fund.ScrapMilli != 1500 {
			t.Fatalf("%s: the fund of today must be the opening minus the purchases after the cut: %+v",
				source, fund)
		}
	}
}

// TestMetricsFundTodayAddsBackACounterDocumentAfterTheCut pins the sign rule of S16 on the envelope of
// today: a counter-document is stored with negative amounts, so it subtracts from the purchases of the
// window by construction -- netting the batteries and the kilograms back with it -- and the balance
// follows the same identity, as it does in the settlement's own fund.
func TestMetricsFundTodayAddsBackACounterDocumentAfterTheCut(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	second := e.closeWindow(t, drawerOf("700.00"))
	_ = second
	// One purchase the branch later returns, and one it keeps: 35.00 and 30.00 of cash after the cut.
	returned := e.purchaseLines(t, "metrics-fund-today-returned-01", "35.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"}},
		[]purchases.ScrapLineInput{{MaterialID: 1, Kg: "1.500", PricePerKg: "10.00"}})
	e.purchaseLines(t, "metrics-fund-today-kept-01", "30.00",
		[]purchases.UsedLineInput{{Model: "48-13", Quantity: 3, UnitPrice: "10.00"}}, nil)
	if _, err := e.purchases.Reverse(e.ctx, identity(2), returned.ID,
		"metrics-fund-today-returned-02", "la chatarra no era cobre"); err != nil {
		t.Fatalf("the counter-document could not be registered: %v", err)
	}

	fund := historyOf(t, e).FundToday
	// 35.00 − 35.00 + 30.00 of cash, and the batteries and kilos net back with it: 2 + 3 − 2 used
	// units and 1.500 − 1.500 kilograms of scrap. The counter-document is a document of the window.
	if fund.Opening != "250.00" || fund.Purchases != "30.00" || fund.Balance != "220.00" ||
		fund.Documents != 3 || fund.UsedUnits != 3 || fund.ScrapMilli != 0 {
		t.Fatalf("the envelope must net its counter-documents: %+v", fund)
	}
}

// TestMetricsFundTodayPublishesANegativeNetWhenTheReturnOutweighsTheWindow pins the sign of the volume:
// a counter-document that returned a purchase made BEFORE the cut leaves the window with fewer units and
// kilograms than none. The net is published with its sign, never refused, because a 503 would hide a
// balance the branch can still spend.
func TestMetricsFundTodayPublishesANegativeNetWhenTheReturnOutweighsTheWindow(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "500.00")
	// The earlier purchase is inside the closed settlement, so it is not part of the window.
	earlier := e.purchaseLines(t, "metrics-fund-today-earlier-01", "45.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"}},
		[]purchases.ScrapLineInput{{MaterialID: 1, Kg: "2.500", PricePerKg: "10.00"}})
	second := e.closeWindow(t, drawerOf("700.00"))
	_ = second
	if _, err := e.purchases.Reverse(e.ctx, identity(2), earlier.ID,
		"metrics-fund-today-earlier-02", "volvieron las baterias"); err != nil {
		t.Fatalf("the counter-document could not be registered: %v", err)
	}

	fund := historyOf(t, e).FundToday
	if fund.UsedUnits != -2 || fund.ScrapMilli != -2500 {
		t.Fatalf("the volume of the window must publish its sign: %+v", fund)
	}
	if fund.Purchases != "-45.00" || fund.Balance != "295.00" {
		t.Fatalf("the money of the same window must net back with it: %+v", fund)
	}
}

// TestMetricsFundTodayStartsAtZeroWithoutAClosedSettlement pins the other half of S16: a branch that
// never closed a settlement states no cut and inherits nothing, so its window is everything it ever
// bought and the card can say where it begins with words instead of an instant.
func TestMetricsFundTodayStartsAtZeroWithoutAClosedSettlement(t *testing.T) {
	e := fixture(t)
	empty := historyOf(t, e).FundToday
	if empty.Since != nil || empty.Opening != "0.00" || empty.Purchases != "0.00" ||
		empty.Balance != "0.00" || empty.Documents != 0 || empty.UsedUnits != 0 ||
		empty.ScrapMilli != 0 {
		t.Fatalf("a branch without a closed settlement inherits nothing: %+v", empty)
	}
	// Nothing was closed, so the window is the whole life of the branch: the document is counted even
	// though no cut exists to start from.
	e.purchase(t, "metrics-fund-today-nocut-01", "120.50")
	fund := historyOf(t, e).FundToday
	if fund.Since != nil || fund.Documents != 1 || fund.UsedUnits != 1 ||
		fund.Purchases != "120.50" || fund.Balance != "-120.50" {
		t.Fatalf("the window without a cut is everything the branch bought: %+v", fund)
	}
}

// TestMetricsFundTodayCountsOnlyItsOwnPurchasesAfterTheCut pins S5 and the window of S16 on the new
// block: the documents, the batteries and the kilograms of the card are the actor's own branch after the
// cut, so a purchase of another branch and a purchase of the previous period are counted by neither the
// money nor the volume of this envelope.
func TestMetricsFundTodayCountsOnlyItsOwnPurchasesAfterTheCut(t *testing.T) {
	e := fixture(t)
	// A purchase of 60.00 before the first closure belongs to the window the closure itself settled.
	e.purchase(t, "metrics-fund-today-previous-01", "60.00")
	first := e.closeFirstSettlement(t, "500.00")
	// The purchase of the window: two used batteries and 1.500 kg of copper.
	e.purchaseLines(t, "metrics-fund-today-own-01", "35.00",
		[]purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10.00"}},
		[]purchases.ScrapLineInput{{MaterialID: 1, Kg: "1.500", PricePerKg: "10.00"}})
	// Another branch buys four batteries of its own after its own cut: none of it is branch 2's.
	e.closeSettlementOf(t, 3)
	if _, err := e.purchases.Create(e.ctx, identity(3), purchases.CreateInput{
		OperationKey: "metrics-fund-today-other-01",
		UsedLines:    []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 4, UnitPrice: "25.00"}},
		PaidCash:     "100.00", PaidTransfer: "0.00",
	}); err != nil {
		t.Fatalf("the purchase of branch 3 could not be registered: %v", err)
	}

	fund := historyOf(t, e).FundToday
	if fund.Since == nil || !fund.Since.Equal(e.cutOf(t, first)) {
		t.Fatalf("the envelope of today must start at the cut of the last closure: %+v", fund.Since)
	}
	if fund.Purchases != "35.00" || fund.Documents != 1 || fund.UsedUnits != 2 ||
		fund.ScrapMilli != 1500 {
		t.Fatalf("the envelope must count only its own purchases after the cut: %+v", fund)
	}
	// The branch that bought reads its own document and nobody else's.
	other, err := e.store.Metrics(e.ctx, identity(3), closings.MetricsPeriod{History: true})
	if err != nil {
		t.Fatalf("the metrics of branch 3 could not be read: %v", err)
	}
	if other.FundToday.Purchases != "100.00" || other.FundToday.Documents != 1 ||
		other.FundToday.UsedUnits != 4 || other.FundToday.ScrapMilli != 0 {
		t.Fatalf("the branch that bought reads its own envelope: %+v", other.FundToday)
	}
}

// TestMetricsFundTodayPublishesANegativeBalanceWithItsSign pins the signed reading of S16: an envelope
// that spent more than it inherited is a shortage and not an unreadable number, so the balance is
// published with its sign -- here a closure that stated no envelope at all, against which the branch
// still bought 120.50 in cash.
func TestMetricsFundTodayPublishesANegativeBalanceWithItsSign(t *testing.T) {
	e := fixture(t)
	first := e.closeFirstSettlement(t, "500.00")
	// The closure left no envelope behind, so nothing was inherited and the purchase below is charged
	// against nothing: a shortage of exactly what it spent.
	e.purchase(t, "metrics-fund-today-short-01", "120.50")

	fund := metricsOf(t, e, first).FundToday
	if fund.Since == nil || fund.Opening != "0.00" || fund.Purchases != "120.50" ||
		fund.Balance != "-120.50" || fund.Documents != 1 {
		t.Fatalf("a shortage must be published with its sign: %+v", fund)
	}
	// The card and the settlement read the same envelope: the history publishes the same shortage.
	if history := historyOf(t, e).FundToday; history.Balance != fund.Balance ||
		history.Purchases != fund.Purchases || history.Documents != fund.Documents {
		t.Fatalf("the three sources must publish the same envelope: %+v want %+v", history, fund)
	}
}
