package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration060 is the drawer that never goes negative (S1-S6): the one statement of what the
// branch's till holds -- what the last closed settlement left, plus the cash its sales
// collected, plus the signed effect of the movements of the window -- and the admission that
// refuses a movement which would spend more than that. 001-059 are applied and checksummed, so
// the drawer's admission of 054 is replaced whole instead of edited.
const migration060 = "060_drawer_never_negative.sql"

// TestDrawerNeverNegativeMigrationShape reads the embedded migration exactly as PostgreSQL
// receives it. It proves the file does the two things it exists for -- the one expression of the
// drawer's expectation and the admission that reads it -- and nothing else: no table, no drop, no
// data written, and the admission of 054 redefined rather than edited.
func TestDrawerNeverNegativeMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration060)
	if err != nil {
		t.Fatal("the drawer migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The one expression of the drawer's expectation: the same three terms of
		// DrawerExpected, stated once in SQL so the trigger and every reader agree.
		"CREATE OR REPLACE FUNCTION branch_drawer_expected(",

		// The admission of 054, redefined whole: the only thing added to it is the balance read
		// under the lock of the branch before a movement of the period is admitted.
		"CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.kind <> 'correccion' THEN",
		"pg_advisory_xact_lock(340251, p_branch::integer)",

		// The refusal names itself, and it states both numbers so the caller can show them.
		"ERRCODE='LC032'",
		"'The drawer does not hold the cash of this movement'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the drawer migration must state %q", required)
		}
	}
	// The migration only replaces functions and adds the index the read needs: it writes no data,
	// drops no object and creates no table, so replaying it on a live branch changes no balance.
	for _, forbidden := range []string{
		"DROP TABLE",
		"DROP COLUMN",
		"TRUNCATE",
		"DELETE FROM",
		"UPDATE branch_cash_movements",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the drawer migration must not %q: it admits differently, it rewrites nothing", forbidden)
		}
	}
	// A guard that sums the sales of a window needs the window's index or every movement of the
	// period scans the branch's whole history.
	if !strings.Contains(sql, "ON sales(branch_location_id, created_at)") {
		t.Error("the drawer migration must index sales by its window")
	}
	// The open side of that window is stated as one bound and never as an OR: the read runs inside a
	// trigger, so its plan goes generic after five executions and only `>= coalesce(since, ...)` keeps
	// the cut as an index qual of the branch's window.
	for _, indexed := range []string{
		"sale.created_at >= coalesce(since, '-infinity'::timestamptz)",
		"ledger.occurred_at >= coalesce(since, '-infinity'::timestamptz)",
	} {
		if !strings.Contains(sql, indexed) {
			t.Errorf("the window of the drawer read must stay an index qual, missing %q", indexed)
		}
	}
	for _, wide := range []string{"IS NULL OR sale.created_at", "IS NULL OR ledger.occurred_at"} {
		if strings.Contains(sql, wide) {
			t.Errorf("the drawer read must not state its open side as %q: the plan cache reads every sale", wide)
		}
	}
	// Marked S1 and S6 like every migration of this vertical, so the rule states which spec it
	// answers and which envelope it leaves alone.
	for _, documented := range []string{"S1", "S6"} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the drawer migration must document %s", documented)
		}
	}
}

// drawerDB applies the settlement block through 060 and seeds one account per location. No
// settlement is closed, so the drawer of branch 2 inherits nothing and its expectation is exactly
// the cash its sales collect plus the movements it records -- which is what isolates the rule
// under test from the closing chain.
func drawerDB(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 60)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	return ctx, p
}

// TestDrawerRefusesSpendingMoreThanItHolds proves S1: a movement whose signed effect would make
// the drawer's expected cash negative is refused, and one that spends exactly what the drawer
// holds is admitted -- the boundary is zero, not a coefficient.
func TestDrawerRefusesSpendingMoreThanItHolds(t *testing.T) {
	ctx, p := drawerDB(t)

	// The branch contributes first so the drawer has something to spend (S3).
	if err := tryExpense(ctx, p, 2, 2, "aporte", "50.00", "Aporte del dueño"); err != nil {
		t.Fatalf("a contribution is never refused by the balance rule (S3): %v", err)
	}
	// Spending exactly what it holds leaves the drawer at zero and is admitted.
	if err := tryExpense(ctx, p, 2, 2, "gasto", "50.00", "Gasto de la tienda"); err != nil {
		t.Fatalf("the drawer holds 50.00, so spending 50.00 must be admitted (S1): %v", err)
	}
	before := cashLedger(t, ctx, p)

	// One cent more is money the drawer does not hold, and the refusal is its own outcome (S4).
	err := tryExpense(ctx, p, 2, 2, "gasto", "0.01", "Gasto sin respaldo")
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused movement writes nothing (S1): got %s before %s", after, before)
	}
}

// TestDrawerAdmitsAContributionOnAnEmptyDrawer proves S3: money coming in is never refused by this
// rule, which is what lets a branch reconcile a physical till the system has not recorded yet.
func TestDrawerAdmitsAContributionOnAnEmptyDrawer(t *testing.T) {
	ctx, p := drawerDB(t)

	if err := tryExpense(ctx, p, 2, 2, "aporte", "0.01", "Caja vacía"); err != nil {
		t.Fatalf("an aporte on an empty drawer must be admitted (S3): %v", err)
	}
	// And a collection of a drawer that holds nothing is still a movement out of it.
	err := tryExpense(ctx, p, 2, 2, "recaudacion", "0.02", "Recaudación sin respaldo")
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
}

// TestDrawerCountsItsCashSales proves S2: the amount available is the one the screen states, so
// the cash a sale collected is spendable and the drawer that holds only it cannot give more.
func TestDrawerCountsItsCashSales(t *testing.T) {
	ctx, p := drawerDB(t)

	// A sale of 1200.00 collected in cash: no other method is stated, so the drawer's expectation
	// is that amount and nothing else. The document is judged at commit (025), so the header and
	// its one line are written in one transaction, and the branch owns the stock the line takes.
	seedBranchStock(t, ctx, p, 1, 1)
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,
 min_price,suggested_price,updated_by_account_id) VALUES(2,1,1000.00,1200.00,1)`); err != nil {
		t.Fatalf("the branch price of the battery could not be provisioned: %v", err)
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the sale transaction could not start", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var sale int64
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,
 transfer_amount,customer_name,customer_phone,customer_document,total,created_by_account_id)
 VALUES(2,1200.00,0.00,0.00,'Cliente','70000000','1234567',1200.00,2) RETURNING id`).Scan(&sale); err != nil {
		t.Fatalf("the sale fixture failed: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,1200.00)`, sale); err != nil {
		t.Fatalf("the sale line fixture failed: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'SER-1')`, sale); err != nil {
		t.Fatalf("the sale unit fixture failed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the sale must be admitted: %v", err)
	}

	// Spending the cash the sale collected is admitted: it is money the drawer holds (S2).
	if err := tryExpense(ctx, p, 2, 2, "gasto", "1200.00", "Alquiler pagado del cajón"); err != nil {
		t.Fatalf("the drawer collected 1200.00 in cash, so spending it must be admitted (S2): %v", err)
	}
	// The drawer is at zero again, and the next cent has no backing.
	err = tryExpense(ctx, p, 2, 2, "gasto", "0.01", "Un centavo de más")
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
}

// TestDrawerRefusesACorrectionThatWouldSpendWhatItDoesNotHold proves S1 on the correction path: a
// correction answers the direction it corrects, so correcting a contribution takes money out of
// the drawer and obeys the same boundary. The existing topes answer first (S5).
func TestDrawerRefusesACorrectionThatWouldSpendWhatItDoesNotHold(t *testing.T) {
	ctx, p := drawerDB(t)

	// A contribution of 50.00 that the drawer then spends entirely.
	target := recordMovement(t, ctx, p, 2, 2, "aporte", "50.00", "Aporte del dueño")
	if err := tryExpense(ctx, p, 2, 2, "gasto", "50.00", "Gasto de la tienda"); err != nil {
		t.Fatalf("the drawer holds 50.00, so spending it must be admitted: %v", err)
	}

	// Correcting the contribution would return to the drawer the 50.00 it no longer holds: the
	// correction is inside its own tope and still breaks the boundary (S1, S5).
	err := tryCorrection(ctx, p, 2, 2, target, "50.00", "El aporte no existió")
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")

	// A correction that the drawer can answer is admitted: the rule bounds the drawer, not the
	// correction path. The contribution puts 50.00 back, so answering it returns the drawer to
	// exactly zero instead of below it.
	if err := tryExpense(ctx, p, 2, 2, "aporte", "50.00", "Aporte repuesto"); err != nil {
		t.Fatalf("a contribution restores the drawer: %v", err)
	}
	if err := tryCorrection(ctx, p, 2, 2, target, "50.00", "El aporte no existió"); err != nil {
		t.Fatalf("the drawer holds 50.00, so answering the aporte must be admitted: %v", err)
	}
}

// TestDrawerAdmitsAnAporteAtTheNumericBound proves S1 and S3 at the whole range of numeric(12,2): the
// bound is the balance itself, never a coefficient, so the largest contribution the column holds is
// admitted, the spending that leaves one cent is admitted, and the cent above it is refused.
func TestDrawerAdmitsAnAporteAtTheNumericBound(t *testing.T) {
	ctx, p := drawerDB(t)

	// An aporte of the whole range is money in, which this rule never refuses (S3).
	if err := tryExpense(ctx, p, 2, 2, "aporte", "9999999999.99", "Aporte del rango completo"); err != nil {
		t.Fatalf("the largest contribution numeric(12,2) holds must be admitted (S3): %v", err)
	}
	// Spending all of it but one cent leaves the drawer at 0.01 and is admitted.
	if err := tryExpense(ctx, p, 2, 2, "gasto", "9999999999.98", "Gasto del rango completo"); err != nil {
		t.Fatalf("the drawer holds the amount, so spending it must be admitted (S1): %v", err)
	}
	// The two cents above what is left are money the drawer does not hold.
	err := tryExpense(ctx, p, 2, 2, "gasto", "0.02", "Dos centavos sin respaldo")
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
}

// TestDrawerGuardSerializesConcurrentOutgoings proves S1 across two connections: the guard takes the lock
// of the branch before it reads the balance, so a second pay-out of the same till waits instead of reading
// the balance the first one is about to spend. Both state 60.00 out of a 100.00 drawer, and only one of
// them can hold.
func TestDrawerGuardSerializesConcurrentOutgoings(t *testing.T) {
	ctx, p := drawerDB(t)
	if err := tryExpense(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja operativa"); err != nil {
		t.Fatalf("the contribution must be admitted (S3): %v", err)
	}

	// The first pay-out takes the lock of the branch and holds it while its transaction is open.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatalf("the first transaction could not start: %v", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES(2,'gasto',60.00,'Primer gasto',2)`); err != nil {
		t.Fatalf("the first pay-out of a funded drawer must be admitted: %v", err)
	}
	// The second pay-out states the same 60.00 out of the same 100.00: it must wait for the lock and then
	// be refused, instead of reading the whole 100.00 the first one is spending.
	answered := make(chan error, 1)
	go func() { answered <- tryExpense(ctx, p, 2, 2, "gasto", "60.00", "Segundo gasto") }()
	select {
	case err := <-answered:
		t.Fatalf("the second pay-out answered while the first transaction was open: %v", err)
	case <-time.After(1500 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the first pay-out must be admitted: %v", err)
	}
	select {
	case err := <-answered:
		execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
	case <-time.After(30 * time.Second):
		t.Fatal("the second pay-out was never answered")
	}
	// The drawer holds what the admitted pay-out left: the refused one wrote nothing.
	var balance string
	if err := p.QueryRow(ctx, `SELECT branch_drawer_expected(2::smallint)::text`).Scan(&balance); err != nil {
		t.Fatalf("the drawer could not be read: %v", err)
	}
	if balance != "40.00" {
		t.Fatalf("100.00 spent by one pay-out of 60.00 is 40.00, got %q", balance)
	}
}
