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

// migration039 is the correction of the first period of a branch: 034 started it at the cut
// instant, so every sale made before the first settlement of a branch belonged to no period
// and paid no commission. The period now starts at the earliest activity the database
// records for that branch -- its first sale or its first movement of the till -- and only a
// branch with nothing recorded opens at its cut instant (S2, S6, S11).
const migration039 = "039_branch_closing_first_period.sql"

// TestBranchClosingFirstPeriodMigrationShape reads the embedded migration exactly as
// PostgreSQL receives it. It proves the replacement is the same opening with one boundary
// changed: the two LC002 refusals, LC017, the cut instant, the advisory lock, the fund
// inheritance and the later-period boundary are all still there, the old lost first period
// is gone, and nothing else of the schema is installed a second time.
func TestBranchClosingFirstPeriodMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration039)
	if err != nil {
		t.Fatal("the first period migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The opener of 034, redefined whole because 034 is applied and checksummed.
		"CREATE OR REPLACE FUNCTION admit_branch_closing() RETURNS trigger LANGUAGE plpgsql AS $$",

		// Every property of the opening that this version must not lose.
		"MESSAGE='Only the warehouse settles a branch account'",
		"MESSAGE='Account settlements belong to branches, not to the warehouse'",
		"MESSAGE='A retired branch is not settled'",
		"NEW.cut_at := now();",
		"NEW.commission_rate_percent := NULL;",
		"PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);",
		"SELECT max(closed_at) INTO previous FROM branch_closings",
		"NEW.period_start := previous;",
		"SELECT closing_cash FROM branch_closings",
		"ORDER BY closed_at DESC LIMIT 1), 0);",

		// The boundary this version states: the earliest activity of the branch, and the cut
		// instant only when the branch has none.
		"(SELECT min(sale.created_at) FROM sales sale",
		"WHERE sale.branch_location_id = NEW.branch_location_id",
		"(SELECT min(movement.occurred_at) FROM branch_cash_movements movement",
		"WHERE movement.branch_location_id = NEW.branch_location_id",
		"NEW.period_start := coalesce(first_activity, NEW.cut_at);",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("039 must install %q", required)
		}
	}
	// The lock is taken before the period is read, because a sale committed a moment ago is
	// only visible to that read once the guard of the sale released the same lock.
	if strings.Index(sql, "pg_advisory_xact_lock") > strings.Index(sql, "SELECT min(sale.created_at)") {
		t.Error("the branch lock must be taken before the earliest activity is read")
	}
	// The wrong boundary of 034 is not restated anywhere.
	if strings.Contains(sql, "coalesce(previous") {
		t.Error("the first period must not fall back to the cut instant through the previous closure")
	}
	// Add-only and single-purpose: one function is replaced, no table, no trigger, and no
	// other function of the vertical is redefined. The trigger of 034 keeps calling this
	// function; a second CREATE TRIGGER would run the admission twice.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("039 must redefine exactly one function, got %d", got)
	}
	for _, forbidden := range []string{
		"CREATE FUNCTION", "CREATE TRIGGER", "CREATE TABLE", "ALTER TABLE", "DROP ",
		"TRUNCATE ", "DISABLE TRIGGER", "UPDATE branch_closings",
		"CREATE OR REPLACE FUNCTION seed_closing_count_lines",
		"CREATE OR REPLACE FUNCTION record_branch_closing_offer",
		"CREATE OR REPLACE FUNCTION admit_branch_closing_transition",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("039 must not contain %q", forbidden)
		}
	}
	// The two decisions a reader has to be able to check are stated where they happen: which
	// boundary bounds the period, and why the same one does not bound the stock snapshot.
	for _, documented := range []string{
		"S2", "S4", "S5", "S6", "S8", "S11", "034", "035", "037",
		"earliest activity", "empty period", "seed_closing_count_lines", "stock snapshot",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("039 must document its own decision: %s", documented)
		}
	}
}

// firstPeriodFixture is the settlement block applied through 039: the prefix catalogue, one
// account per location, the stock of both branches, one price per branch and the rate each
// branch needs to be proposed. Branch 2 is the branch that trades before its first
// settlement; branch 3 is the branch that never sold, which is the bootstrap of S11.
func firstPeriodFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 39)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(1,1,20,0),(2,1,10,0),(2,2,4,0),(3,1,5,0)`); err != nil {
		t.Fatal("the stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1),(3,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the branch prices could not be configured")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1),(3,10.00,1)`); err != nil {
		t.Fatal("the branch commissions could not be configured")
	}
	return ctx, p
}

// TestBranchClosingFirstPeriodRecordsTheSalesBeforeIt proves D1 on a live database: a branch
// that sells before its first settlement records those sales in the first period, so they pay
// commission and their cash is a sale of the drawer identity instead of an unexplained
// surplus; and the period after that settlement still starts exactly where it closed.
func TestBranchClosingFirstPeriodRecordsTheSalesBeforeIt(t *testing.T) {
	ctx, p := firstPeriodFixture(t)

	// The branch also paid a small expense out of its till before the visit: that is activity
	// of the branch too, and it happened before the first sale.
	if err := tryExpense(ctx, p, 2, 2, "gasto", "50.00", "Flete"); err != nil {
		t.Fatalf("the branch must be able to record an expense before its first settlement: %v", err)
	}
	// The branch trades before the warehouse's first visit: one sale in cash and one settled
	// in cash and by transfer. No settlement of this branch exists yet, so under 034 both
	// would fall outside every period.
	if err := sell(ctx, p, 2, "FIRST-0001", "2000.00", "2000.00", "0.00", "0.00"); err != nil {
		t.Fatalf("the branch must be able to sell before its first settlement: %v", err)
	}
	if err := sell(ctx, p, 2, "FIRST-0002", "2000.00", "1000.00", "0.00", "1000.00"); err != nil {
		t.Fatalf("the second sale must be admitted: %v", err)
	}
	var firstActivity, firstSale time.Time
	if err := p.QueryRow(ctx, `SELECT min(occurred_at) FROM branch_cash_movements
 WHERE branch_location_id=2`).Scan(&firstActivity); err != nil {
		t.Fatal("the first movement of the till could not be read")
	}
	if err := p.QueryRow(ctx, `SELECT min(created_at) FROM sales
 WHERE branch_location_id=2`).Scan(&firstSale); err != nil {
		t.Fatal("the first sale instant could not be read")
	}

	// The first settlement opens with the period the database states, which is the expense the
	// branch paid first -- the earliest of its two ledgers -- and not the instant of the visit
	// the caller declares.
	closing := openSettlement(t, ctx, p, 2)
	var start, cut time.Time
	if err := p.QueryRow(ctx, `SELECT period_start,cut_at FROM branch_closings WHERE id=$1`,
		closing).Scan(&start, &cut); err != nil {
		t.Fatal("the period of the first settlement could not be read")
	}
	if !start.Equal(firstActivity) || !firstActivity.Before(firstSale) || !start.Before(cut) {
		t.Fatalf("the first period must start at the first activity %s (first sale %s), got %s with the cut at %s",
			firstActivity, firstSale, start, cut)
	}

	// The sale before the visit is the commission base of that period: 4000.00 sold, 3000.00
	// collected in cash and 1000.00 by transfer, at 12.50% = 500.00.
	countAll(t, ctx, p, closing, map[int]int{1: 8, 2: 4})
	proposeRound(t, ctx, p, closing, `{"fund":"500.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=3000.00,
 contributed_cash=0.00,closing_cash=500.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the first settlement could not be proposed: %v", err)
	}
	const offer = "4000.00:3000.00:0.00:1000.00:0.00:500.00:12.50"
	if state := settlementState(t, ctx, p, closing); !strings.HasSuffix(state, offer) {
		t.Fatalf("the first period must record the sales made before it: got %s, want %s", state, offer)
	}

	// It closes like any other settlement, and the period after it starts exactly where it
	// closed: only the first period takes the new boundary.
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	var closedAt time.Time
	if err := p.QueryRow(ctx, `SELECT closed_at FROM branch_closings WHERE id=$1`, closing).
		Scan(&closedAt); err != nil {
		t.Fatal("the closure instant could not be read")
	}
	if err := sell(ctx, p, 2, "FIRST-0003", "2000.00", "2000.00", "0.00", "0.00"); err != nil {
		t.Fatalf("the branch must sell in the new period: %v", err)
	}
	next := openSettlement(t, ctx, p, 2)
	if err := p.QueryRow(ctx, `SELECT period_start FROM branch_closings WHERE id=$1`, next).
		Scan(&start); err != nil {
		t.Fatal("the second period could not be read")
	}
	if !start.Equal(closedAt) {
		t.Fatalf("the second period must start where the first closed (%s), got %s", closedAt, start)
	}
	// And it settles only its own sale: one unit at 2000.00 in cash, 250.00 of commission.
	countAll(t, ctx, p, next, map[int]int{1: 7, 2: 4})
	proposeRound(t, ctx, p, next, `{"fund":"500.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=2500.00,
 contributed_cash=0.00,closing_cash=500.00 WHERE id=$1`, next); err != nil {
		t.Fatalf("the second settlement could not be proposed: %v", err)
	}
	const secondOffer = "2000.00:2000.00:0.00:0.00:0.00:250.00:12.50"
	if state := settlementState(t, ctx, p, next); !strings.HasSuffix(state, secondOffer) {
		t.Fatalf("the second period must settle only its own sales: got %s, want %s", state, secondOffer)
	}
	t.Logf("039: a sale made before the first settlement pays its commission and leaves the drawer")
}

// TestBranchClosingFirstPeriodOpensEmpty proves the other half of the boundary: a branch that
// has never sold and has no movement of its till opens an empty first period at its cut
// instant, pays no commission, and still closes with the contribution the admin declares --
// the bootstrap of S11, whose drawer starts empty and is fed by that contribution.
func TestBranchClosingFirstPeriodOpensEmpty(t *testing.T) {
	ctx, p := firstPeriodFixture(t)

	closing := openSettlement(t, ctx, p, 3)
	var opensEmpty bool
	if err := p.QueryRow(ctx, `SELECT period_start=cut_at AND opening_cash=0.00
         AND sales_total=0.00 AND cash_sales=0.00 AND commission_amount=0.00
         FROM branch_closings WHERE id=$1`, closing).Scan(&opensEmpty); err != nil || !opensEmpty {
		t.Fatalf("a branch with nothing recorded opens an empty period at its cut: %t %v",
			opensEmpty, err)
	}

	// The bootstrap: the stock is aligned with the count and the fund is the money the admin
	// leaves in a drawer that was empty, so the contribution equals the fund.
	countAll(t, ctx, p, closing, map[int]int{1: 5})
	proposeRound(t, ctx, p, closing, `{"fund":"300.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 contributed_cash=300.00,closing_cash=300.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the bootstrap settlement could not be proposed: %v", err)
	}
	const offer = "0.00:0.00:0.00:0.00:0.00:0.00:10.00"
	if state := settlementState(t, ctx, p, closing); !strings.HasSuffix(state, offer) {
		t.Fatalf("an empty first period pays no commission: got %s, want %s", state, offer)
	}

	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the bootstrap: %v", err)
	}
	// The declared fund is one ledger fact of its own, and the shelf is left as counted.
	var ledger string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||description,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, closing).Scan(&ledger); err != nil ||
		ledger != "aporte:300.00:Aporte de fondo de la rendición" {
		t.Fatalf("the bootstrap must record the declared fund as one contribution: %q %v", ledger, err)
	}
	var stock string
	if err := p.QueryRow(ctx, `SELECT string_agg(variant_id||':'||existing,',' ORDER BY variant_id)
 FROM inventory_balances WHERE location_id=3`).Scan(&stock); err != nil || stock != "1:5" {
		t.Fatalf("the bootstrap must leave the stock as counted: %q %v", stock, err)
	}

	// The period that starts inherits that fund and begins at the closure of the bootstrap.
	var closedAt time.Time
	if err := p.QueryRow(ctx, `SELECT closed_at FROM branch_closings WHERE id=$1`, closing).
		Scan(&closedAt); err != nil {
		t.Fatal("the bootstrap closure instant could not be read")
	}
	next := openSettlement(t, ctx, p, 3)
	var inherited bool
	if err := p.QueryRow(ctx, `SELECT opening_cash=300.00 AND period_start=$2
 FROM branch_closings WHERE id=$1`, next, closedAt).Scan(&inherited); err != nil || !inherited {
		t.Fatalf("the next period must inherit the declared fund: %t %v", inherited, err)
	}
	t.Logf("039: a branch that never sold opens an empty first period and closes with a contribution")
}

// TestBranchClosingFirstPeriodKeepsTheOpening proves that replacing the opener changed the
// first boundary and nothing else: a later settlement still starts at the closure of the
// previous one and inherits its fund, one branch still holds one live settlement, only the
// warehouse opens, and a retired branch is still refused -- each refusal writing no row.
func TestBranchClosingFirstPeriodKeepsTheOpening(t *testing.T) {
	ctx, p := firstPeriodFixture(t)

	// The other half of S2, unchanged: the second period starts where the first closed and
	// inherits the fund it left.
	first := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, first, map[int]int{1: 10, 2: 4})
	closeSettlement(t, ctx, p, first, "250.00", "0.00", "250.00")
	var closedAt time.Time
	if err := p.QueryRow(ctx, `SELECT closed_at FROM branch_closings WHERE id=$1`, first).
		Scan(&closedAt); err != nil {
		t.Fatal("the closure instant could not be read")
	}
	next := openSettlement(t, ctx, p, 2)
	var inherited bool
	if err := p.QueryRow(ctx, `SELECT opening_cash=250.00 AND period_start=$2
 FROM branch_closings WHERE id=$1`, next, closedAt).Scan(&inherited); err != nil || !inherited {
		t.Fatalf("a later period must start at the previous closure and inherit its fund: %t %v",
			inherited, err)
	}

	// One live settlement per branch, from the unique index of 034: the branch is frozen, so
	// a second open of the same branch is a conflict and writes nothing.
	_, err := p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,opened_by_account_id)
 VALUES(2,now(),1)`)
	execRefusal(t, err, "23505")
	var settlements int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_closings WHERE branch_location_id=2`).
		Scan(&settlements); err != nil || settlements != 2 {
		t.Fatalf("a refused second settlement must write nothing: %d %v", settlements, err)
	}

	// Only the warehouse opens, and a retired branch is never settled: both refusals of 034
	// are still the opener's, in the same order and with the same codes.
	_, err = p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,opened_by_account_id)
 VALUES(3,now(),3)`)
	execRefusal(t, err, "LC002")
	// A branch is only retired with an empty shelf, so the stock of branch 3 is cleared
	// first: the refusal under test is the settlement's, not the retirement's.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=0 WHERE location_id=3`); err != nil {
		t.Fatal("the branch stock could not be cleared")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET enabled=false,deleted_at=now() WHERE id=3`); err != nil {
		t.Fatal("the branch account could not be retired")
	}
	if _, err := p.Exec(ctx, `UPDATE locations SET deleted_at=now() WHERE id=3`); err != nil {
		t.Fatal("the branch could not be retired")
	}
	_, err = p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,opened_by_account_id)
 VALUES(3,now(),1)`)
	execRefusal(t, err, "LC017")
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_closings WHERE branch_location_id=3`).
		Scan(&settlements); err != nil || settlements != 0 {
		t.Fatalf("a retired branch must not be settled: %d %v", settlements, err)
	}
	t.Logf("039: the lock, the fund, the retired refusal and the one-live rule are unchanged")
}
