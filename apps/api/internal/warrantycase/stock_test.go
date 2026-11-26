package warrantycase_test

import (
	"errors"
	"strconv"
	"strings"
	"testing"

	"luson/api/internal/warrantycase"
)

// The used battery has a real stock per location and per model, and it is derived from the facts
// already registered (S24): there is no balance row and no stored total anywhere. The read states,
// per location and per model, what was bought, what the factory returned, what came back from a
// loan, what a closed settlement delivered and what was lent, and their signed sum. This file pins
// the read, the identity of the model (S26), the refusal of a loan the origin cannot cover (S25) and
// the warehouse's ownership of a factory return (S27).

// fund states the purchase fund of one branch, so a purchase of the tests below is a document the
// purchase vertical would admit and not a row invented here.
func (f *fixture) fund(t *testing.T, branch int, amount string) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1,'aporte',$2::numeric,'Fondo de compras del fixture',$3)`,
		int16(branch), amount, f.accounts[branch]); err != nil {
		t.Fatalf("the fund of branch %d could not be stated: %v", branch, err)
	}
}

// buyUsed registers one original purchase of the branch with a single used line, exactly as the
// purchases vertical writes it: the counter buys the batteries, that is the first term of S24. The
// header and its line are one transaction, because a document is judged whole at commit (032).
func (f *fixture) buyUsed(t *testing.T, branch int, key, model string, quantity int64, price,
	total string) {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatalf("the purchase transaction could not start: %v", err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	var id int64
	if err := tx.QueryRow(f.ctx, `INSERT INTO purchases(operation_key,location_id,total,
 paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,$2,$3::numeric,$3::numeric,0.00,$4) RETURNING id`, key, int16(branch), total,
		f.accounts[branch]).Scan(&id); err != nil {
		t.Fatalf("the purchase %s must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(f.ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,
 unit_price) VALUES($1,$2,$3,$4::numeric)`, id, model, quantity, price); err != nil {
		t.Fatalf("the used line of %s must be admitted: %v", key, err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatalf("the purchase %s must commit: %v", key, err)
	}
}

// usedStock is the read of S24 through the store, as the warehouse sees it.
func (f *fixture) usedStock(t *testing.T, location int) []warrantycase.StockPosition {
	t.Helper()
	stock, err := f.store.UsedStock(f.ctx, f.actor(location))
	if err != nil {
		t.Fatalf("the used stock must be readable: %v", err)
	}
	return stock
}

// stockText renders one row as one comparable value, so a test states the whole row it expects.
func stockText(row warrantycase.StockPosition) string {
	return strings.Join([]string{
		strconv.Itoa(row.LocationID), row.Model, strconv.FormatInt(row.Purchased, 10),
		strconv.FormatInt(row.FactoryReturns, 10), strconv.FormatInt(row.LoansReturned, 10),
		strconv.FormatInt(row.Delivered, 10), strconv.FormatInt(row.LoansGiven, 10),
		strconv.FormatInt(row.Available, 10)}, ":")
}

// stockAt reads the rows of one location, so a test states that a location has no position at all.
func stockAt(stock []warrantycase.StockPosition, location int) []warrantycase.StockPosition {
	found := make([]warrantycase.StockPosition, 0, len(stock))
	for _, row := range stock {
		if row.LocationID == location {
			found = append(found, row)
		}
	}
	return found
}

// stockRow reads the row of one model at one location, so a test points at one key instead of at
// the whole table.
func stockRow(t *testing.T, stock []warrantycase.StockPosition, location int,
	model string) warrantycase.StockPosition {
	t.Helper()
	for _, row := range stock {
		if row.LocationID == location && row.Model == model {
			return row
		}
	}
	t.Fatalf("the stock of %d:%s must be stated, got %v", location, model, stock)
	return warrantycase.StockPosition{}
}

// TestUsedStockDerivesTheTermsOfEachLocation pins S24, S26 and S27 through the store: a branch that
// bought nothing and got nothing back is zero, every term of the formula lands in its own field, a
// factory return that goes to the pool is the warehouse's and never the case's branch, and the
// model is the same key whatever the case and the spaces the caller typed.
func TestUsedStockDerivesTheTermsOfEachLocation(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	// The branch bought four used batteries of one model; nothing else happened yet.
	f.buyUsed(t, 2, "used-stock-terms-0001", "NS60ZL", 4, "10.00", "40.00")
	if got := stockAt(f.usedStock(t, 1), 1); len(got) != 0 {
		t.Fatalf("the warehouse bought nothing and got nothing back: %v", got)
	}
	if got := stockAt(f.usedStock(t, 1), 3); len(got) != 0 {
		t.Fatalf("a branch with no purchase and no return is zero, got %v", got)
	}
	if got := stockText(stockRow(t, f.usedStock(t, 2), 2, "NS60ZL")); got != "2:NS60ZL:4:0:0:0:0:4" {
		t.Fatalf("a purchase is the first term of the branch, got %s", got)
	}

	// The factory refuses a battery of the branch's shelf and sends it back to the used pool: it
	// enters the Warehouse, which is who shipped it and who receives it (S11, S27).
	claim := f.openClaim(t, "USADAS/1")
	f.atFactory(t, claim)
	if _, err := f.store.Resolve(f.ctx, f.actor(1), claim.ID, warrantycase.ResolutionInput{
		Verdict: warrantycase.VerdictNotCovered, ReportedDestination: warrantycase.DestinationStock,
		LoanDestination: warrantycase.DestinationCustomer, Note: "Fábrica rechazó la garantía"}); err != nil {
		t.Fatalf("the factory refusal must be admitted: %v", err)
	}
	warehouse := stockRow(t, f.usedStock(t, 1), 1, "NP7-12")
	if warehouse.FactoryReturns != 1 || warehouse.Available != 1 {
		t.Fatalf("a factory return is one unit of the warehouse, got %s", stockText(warehouse))
	}
	for _, row := range stockAt(f.usedStock(t, 2), 2) {
		if row.Model == "NP7-12" {
			t.Fatalf("a factory return is never the branch of the case: %v", row)
		}
	}

	// The counter lends two of the four batteries, typing the model the way a person would: the
	// stock adds it to the same key the purchase wrote (S26).
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: " ns60zl ", Quantity: 2, SourceLocationID: 2}); err != nil {
		t.Fatalf("the loan of the branch's own stock must be admitted: %v", err)
	}
	lent := stockRow(t, f.usedStock(t, 2), 2, "NS60ZL")
	if lent.LoansGiven != 2 || lent.Available != 2 {
		t.Fatalf("a loan is subtracted from its origin, got %s", stockText(lent))
	}
	// One of the two comes back: the battery is in the branch that lent it again.
	if _, err := f.store.DecideLoan(f.ctx, f.actor(2), claim.ID, 1,
		warrantycase.LoanReturned); err != nil {
		t.Fatalf("the returned loan must be admitted: %v", err)
	}
	back := stockRow(t, f.usedStock(t, 2), 2, "NS60ZL")
	if back.LoansReturned != 2 || back.Available != 4 {
		t.Fatalf("a returned loan is added back to its origin, got %s", stockText(back))
	}
	// One row per model and location, and the sum of the terms is the only balance there is.
	for _, row := range f.usedStock(t, 2) {
		if row.Available != row.Purchased+row.FactoryReturns+row.LoansReturned-
			row.Delivered-row.LoansGiven {
			t.Fatalf("the signed sum is the balance, got %s", stockText(row))
		}
	}
}

// TestUsedStockRefusesALoanTheOriginCannotCover pins S25: a loan whose origin does not hold the
// model it asks for is refused with its own error and writes nothing, and two loans never consume
// one unit.
func TestUsedStockRefusesALoanTheOriginCannotCover(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "used-stock-loans-0001", "NS60ZL", 1, "10.00", "10.00")
	claim := f.openClaim(t, "USADAS/2")
	loans := f.count(t, "warranty_case_loans")
	// The warehouse holds nothing, and a branch that bought nothing holds nothing at all: two origins
	// without the requested model. A model nobody ever bought is not a shortage but an unknown model
	// (S30), and the test below pins that apart.
	for _, refused := range []struct {
		source int
		model  string
	}{
		{1, "NS60ZL"}, {3, "NS60ZL"},
	} {
		_, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
			Model: refused.model, Quantity: 1, SourceLocationID: refused.source})
		if !errors.Is(err, warrantycase.ErrLoanSourceStock) {
			t.Fatalf("a loan from %d of %s must be refused as a stock shortage, got %v",
				refused.source, refused.model, err)
		}
	}
	// A loan of more units than the origin holds is refused too, and nothing was written.
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60ZL", Quantity: 2, SourceLocationID: 2}); !errors.Is(err, warrantycase.ErrLoanSourceStock) {
		t.Fatalf("a loan of two units on one must be refused, got %v", err)
	}
	if got := f.count(t, "warranty_case_loans"); got != loans {
		t.Fatalf("a refused loan writes nothing: %d loans became %d", loans, got)
	}
	if got := stockText(stockRow(t, f.usedStock(t, 2), 2, "NS60ZL")); got != "2:NS60ZL:1:0:0:0:0:1" {
		t.Fatalf("a refused loan moves no stock, got %s", got)
	}
	// The one unit leaves the branch, and from then on the same unit cannot be lent again.
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60ZL", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the loan of the unit the branch holds must be admitted: %v", err)
	}
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60ZL", Quantity: 1, SourceLocationID: 2}); !errors.Is(err, warrantycase.ErrLoanSourceStock) {
		t.Fatalf("two loans cannot consume one unit, got %v", err)
	}
	// The warehouse's factory return is a stock of its own, and lending it leaves it empty (S6).
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60ZL", Quantity: 1, SourceLocationID: 1}); !errors.Is(err, warrantycase.ErrLoanSourceStock) {
		t.Fatalf("the warehouse holds nothing of that model, got %v", err)
	}
}

// TestUsedStockRefusesAModelThePoolNeverSaw pins S30: the model of a loan is chosen from the closed
// list the pool already knows, so a code nobody ever bought, counted in a closed settlement or had
// refused by the factory is refused for being unknown and not for being out of stock, and the refusal
// writes no row at all.
func TestUsedStockRefusesAModelThePoolNeverSaw(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "used-model-unknown-0001", "NS60ZL", 1, "10.00", "10.00")
	claim := f.openClaim(t, "USADAS/30")
	loans := f.count(t, "warranty_case_loans")
	// `CAR` is the mistake the counter made: a brand of the catalogue written where the model goes.
	for _, model := range []string{"CAR", "NS40ZL"} {
		_, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
			Model: model, Quantity: 1, SourceLocationID: 2})
		if !errors.Is(err, warrantycase.ErrLoanModelUnknown) {
			t.Fatalf("a loan of %s must be refused as an unknown model, got %v", model, err)
		}
	}
	if got := f.count(t, "warranty_case_loans"); got != loans {
		t.Fatalf("a refused loan writes nothing: %d loans became %d", loans, got)
	}
	if got := len(f.usedStock(t, 2)); got != 1 {
		t.Fatalf("an unknown model creates no stock row, got %d rows", got)
	}
	// The model the pool knows is admitted, so the closed list refuses only what it does not know.
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60ZL", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the model the pool knows must be admitted: %v", err)
	}
}

// TestUsedStockDeliversToTheWarehouseWhenTheBranchSettles pins the fourth term of S24 and its
// agreement with the settlement (S29): a closed settlement sums the counted quantity to the
// Warehouse and subtracts the same quantity from the branch, so a branch that delivers everything it
// holds ends at zero and the expectation the sheet seeded was exactly the stock of its cut.
func TestUsedStockDeliversToTheWarehouseWhenTheBranchSettles(t *testing.T) {
	f := newFixture(t)
	f.fund(t, 2, "1000.00")
	f.buyUsed(t, 2, "used-stock-settle-001", "NS60ZL", 3, "10.00", "30.00")
	// The branch lends one of the three, so the pool of the cut is two.
	claim := f.openClaim(t, "USADAS/3")
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "NS60ZL", Quantity: 1, SourceLocationID: 2}); err != nil {
		t.Fatalf("the loan must be admitted: %v", err)
	}
	// The settlement opens and the branch delivers everything the sheet expects of it.
	closing, expected := f.openBranchSettlement(t, 2)
	if expected["NS60ZL"] != 2 {
		t.Fatalf("the sheet of the cut states the pool, got %v", expected)
	}
	// The expectation is the stock of the cut: the two numbers never disagree (S29).
	atCut := stockRow(t, f.usedStock(t, 2), 2, "NS60ZL")
	if atCut.Available != 2 || atCut.Purchased != 3 || atCut.LoansGiven != 1 || atCut.Delivered != 0 {
		t.Fatalf("the expectation is the stock of the cut, got %s", stockText(atCut))
	}
	f.closeBranchSettlement(t, 2, closing)
	// The closing delivers everything: the branch holds none and the warehouse holds it all.
	branch := stockRow(t, f.usedStock(t, 2), 2, "NS60ZL")
	if branch.Delivered != 2 || branch.Available != 0 {
		t.Fatalf("the branch that delivered everything holds zero, got %s", stockText(branch))
	}
	warehouse := stockRow(t, f.usedStock(t, 2), 1, "NS60ZL")
	if warehouse.Delivered != 2 || warehouse.Available != 2 {
		t.Fatalf("the same quantity is the warehouse's, got %s", stockText(warehouse))
	}
}

// openBranchSettlement opens one settlement of the branch and counts every used line with exactly
// what the sheet expects of it, which is what a branch that delivers everything states. It returns the
// settlement and the expected quantities of the used lines of its opening.
func (f *fixture) openBranchSettlement(t *testing.T, branch int) (int64, map[string]int64) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO branch_settings(branch_location_id,
 commission_rate_percent,updated_by_account_id) VALUES($1,12.50,$2)`, int16(branch),
		f.accounts[1]); err != nil {
		t.Fatalf("the commission of branch %d could not be configured: %v", branch, err)
	}
	var closing int64
	if err := f.pool.QueryRow(f.ctx, `INSERT INTO branch_closings(branch_location_id,period_start,
 commission_rate_percent,opened_by_account_id) VALUES($1,now(),0,$2) RETURNING id`,
		int16(branch), f.accounts[1]).Scan(&closing); err != nil {
		t.Fatalf("the settlement of branch %d could not be opened: %v", branch, err)
	}
	expected := map[string]int64{}
	rows, err := f.pool.Query(f.ctx, `SELECT model,expected_quantity FROM closing_material_lines
 WHERE closing_id=$1 AND kind='used'`, closing)
	if err != nil {
		t.Fatalf("the used sheet could not be read: %v", err)
	}
	for rows.Next() {
		var model string
		var quantity int64
		if err := rows.Scan(&model, &quantity); err != nil {
			t.Fatalf("a used line could not be read: %v", err)
		}
		expected[model] = quantity
	}
	if rows.Err() != nil {
		t.Fatalf("the used sheet could not be read: %v", rows.Err())
	}
	rows.Close()
	// The branch delivers everything the sheet expects, and the count sheet of the stock is complete.
	for model, quantity := range expected {
		if _, err := f.pool.Exec(f.ctx, `UPDATE closing_material_lines SET counted_quantity=$3
 WHERE closing_id=$1 AND model=$2`, closing, model, quantity); err != nil {
			t.Fatalf("the used line %s could not be counted: %v", model, err)
		}
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE closing_count_lines SET counted_quantity=expected_quantity
 WHERE closing_id=$1 AND counted_quantity IS NULL`, closing); err != nil {
		t.Fatalf("the count sheet could not be completed: %v", err)
	}
	return closing, expected
}

// closeBranchSettlement walks the closure the guards of 034 admit: the warehouse proposes a round,
// the branch accepts it and the closure applies.
func (f *fixture) closeBranchSettlement(t *testing.T, branch int, closing int64) {
	for _, step := range []struct {
		statement string
		actor     int
	}{
		{`INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,1,'{"fund":"0.00"}'::jsonb,$2)`, f.accounts[1]},
		{`UPDATE branch_closings SET status='proposed',counted_cash=0.00,contributed_cash=0.00,
 closing_cash=0.00 WHERE id=$1`, 0},
		{`UPDATE closing_proposals SET decision='accepted',decision_reason='',
 decided_by_account_id=$2 WHERE closing_id=$1 AND decision IS NULL`, f.accounts[branch]},
		{`UPDATE branch_closings SET status='closed' WHERE id=$1`, 0},
	} {
		args := []any{closing}
		if step.actor != 0 {
			args = append(args, step.actor)
		}
		if _, err := f.pool.Exec(f.ctx, step.statement, args...); err != nil {
			t.Fatalf("the settlement could not be closed: %v", err)
		}
	}
}
