package migrations_test

import "testing"

// The rule of 053: the effect of a correction is the negation of the effect of the row it answers, so that
// row's own amount and direction decide and not its kind alone. A row written before 052 may carry a
// direction its kind no longer implies -- the negative `reposicion` of 051 was money out of the fund -- and
// the correction follows the row, so answering it restores what it took.

// TestFundCorrectionFollowsALegacyRow proves R3-001 on a live database, and that the balance the guard
// measures is the balance the view publishes.
func TestFundCorrectionFollowsALegacyRow(t *testing.T) {
	ctx, p := fundPrefixThrough(t, 51)
	load := recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	legacy := recordFundMovement(t, ctx, p, 2, 2, "reposicion", "-400.00", "Carga negativa de 051")
	applyMigrationFrom(t, ctx, p, 52, 53)
	// The guard's balance is the view's published balance in the transaction it measures.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the transaction could not be opened")
	}
	defer tx.Rollback(ctx)
	var published string
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
 FROM purchase_fund_ledger WHERE branch_location_id=2`).Scan(&published); err != nil {
		t.Fatal("the balance of the fund could not be read")
	}
	_, err = tx.Exec(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES(2,'correccion',300.00,'Carga anulada de más',2,$1)`, load)
	execRefusalMessage(t, err, "LF003", published+" in it, ")
	// Answering the legacy row puts back what it took, and the view publishes the negation of its effect.
	if err := tryFundCorrection(ctx, p, 2, 2, legacy, "400.00", "Carga de 051 anulada"); err != nil {
		t.Fatalf("a correction the balance fits must be admitted: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "500.00" {
		t.Fatalf("answering money out must put it back, got %s", balance)
	}
	var effect string
	if err := p.QueryRow(ctx, `SELECT effective::text FROM purchase_fund_ledger
         WHERE corrects_id=$1`, legacy).Scan(&effect); err != nil || effect != "400.00" {
		t.Fatalf("the view must publish the negation of the answered row, got %q: %v", effect, err)
	}
}

// TestFundCorrectionKeepsTheOrdinaryDirections proves the ordinary answers do not change.
func TestFundCorrectionKeepsTheOrdinaryDirections(t *testing.T) {
	ctx, p := fundPrefixThrough(t, 53)
	load := recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	spend := recordFundMovement(t, ctx, p, 2, 2, "compra", "400.00", "Baterías usadas")
	if err := tryFundCorrection(ctx, p, 2, 2, spend, "300.00", "Compra anulada"); err != nil {
		t.Fatalf("a correction of a compra must be admitted: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "400.00" {
		t.Fatalf("answering a compra must return the money, got %s", balance)
	}
	if err := tryFundCorrection(ctx, p, 2, 2, load, "300.00", "Carga anulada"); err != nil {
		t.Fatalf("a correction of an aporte must be admitted: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "100.00" {
		t.Fatalf("answering a load must take the money back, got %s", balance)
	}
}
