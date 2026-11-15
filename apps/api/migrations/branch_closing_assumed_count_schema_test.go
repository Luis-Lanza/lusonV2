package migrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration043 is the assumed count of S1: the sheet of a settlement starts aligned with
// the system, so the warehouse only edits the lines that disagree, and the difference it
// writes is still what the closure applies (S4). The version also seeds the sheets that
// already exist when it is applied (S6). 001-042 are applied and checksummed, so the
// seeding function of 035 is replaced whole instead of edited, and no guard of the
// vertical is rewritten.
const migration043 = "043_closing_assumed_count.sql"

// TestClosingAssumedCountMigrationShape reads the embedded migration exactly as
// PostgreSQL receives it. It proves the file does the two things it exists for -- the
// seeding function carrying a counted quantity and the backfill of the live sheets -- and
// nothing else: no table, no second trigger on the same event, no settlement written, and
// no guard of 034/035 rewritten.
func TestClosingAssumedCountMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration043)
	if err != nil {
		t.Fatal("the assumed count migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The seed of 035, redefined whole because 035 is applied and checksummed: one
		// line per variant with stock, and the counted quantity seeded with it.
		"CREATE OR REPLACE FUNCTION seed_closing_count_lines() RETURNS trigger LANGUAGE plpgsql AS $$",
		"INSERT INTO closing_count_lines(\n        closing_id, variant_id, expected_quantity, counted_quantity)",
		"SELECT NEW.id, balance.variant_id, balance.existing, balance.existing",
		"WHERE balance.location_id = NEW.branch_location_id AND balance.existing > 0;",
		"RETURN NULL;",

		// The sheets that already exist: the open and the rejected ones are seeded, and the
		// update is the only write of this file that reaches stored rows.
		"UPDATE closing_count_lines line",
		"SET counted_quantity = line.expected_quantity",
		"AND header.status IN ('open','rejected')",
		"AND line.counted_quantity IS NULL",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("043 must install %q", required)
		}
	}
	// One function replaced, no table, no second trigger for the same event (the trigger of
	// 035 keeps calling this function), and no settlement written at all: the backfill is
	// the same state of the same settlement, seeded, and nothing of the closure moves.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("043 must redefine exactly one function, got %d", got)
	}
	for _, forbidden := range []string{
		"CREATE FUNCTION", "CREATE TRIGGER", "CREATE TABLE", "ALTER TABLE", "DROP ",
		"TRUNCATE ", "DISABLE TRIGGER", "UPDATE branch_closings", "INSERT INTO branch_closings",
		"DELETE FROM", "inventory_balances existing", "NEW.counted_quantity :=",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("043 must not contain %q", forbidden)
		}
	}
	// The guards that stay as they are, and why, are stated where a reader looks for them:
	// the row guard of the count sheet (034), its admission and its seed (035), and the two
	// refusals that become unreachable instead of being rewritten.
	for _, documented := range []string{
		"S1", "S2", "S4", "S6",
		"034", "035", "LC004", "LC006", "LC019", "count_pending",
		"guard_closing_count_line", "admit_closing_count_line",
		"unreachable", "checksum",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("043 must document its own decision: %s", documented)
		}
	}
	// The function is replaced before the backfill, so a settlement opened while this
	// version runs is already seeded and the update below cannot see it.
	if first, second := strings.Index(sql, "CREATE OR REPLACE FUNCTION"),
		strings.Index(sql, "UPDATE closing_count_lines"); first < 0 || second < 0 || first > second {
		t.Error("the seeding function must be replaced before the live sheets are seeded")
	}
}

// assumedCountFixture is the settlement block applied through 043: the prefix catalogue,
// one account per location, the stock of branches 2 and 3, and the rate each branch needs
// to be proposed. Nothing else is provisioned: no test here reads a table of another
// vertical.
func assumedCountFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return assumedCountDB(t, 43)
}

// assumedCountDB provisions the same block at any version, because the behaviour this
// version replaces is compared against the state that already had it: 042 is the base and
// 043 is the candidate, and both need the stock of branches 2 and 3 with their rates.
func assumedCountDB(t *testing.T, last int) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, last)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(2,2,4,0),(3,1,5,0),(3,2,2,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1),(3,10.00,1)`); err != nil {
		t.Fatal("the branch commissions could not be configured")
	}
	return ctx, p
}

// countSheet is the whole count sheet of a settlement as one value, so "no line was left
// without a quantity" and "the sheet did not move" are one comparison each.
func countSheet(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) string {
	t.Helper()
	var sheet string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(variant_id||':'||expected_quantity||':'
         ||coalesce(counted_quantity::text,'-'),',' ORDER BY variant_id),'') FROM closing_count_lines
 WHERE closing_id=$1`, closing).Scan(&sheet); err != nil {
		t.Fatalf("the count sheet could not be read: %v", err)
	}
	return sheet
}

// stockSheet is the stock of a branch as one value: the only thing a closure moves.
func stockSheet(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) string {
	t.Helper()
	var stock string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(variant_id||':'||existing||':'
         ||reserved,',' ORDER BY variant_id),'') FROM inventory_balances
 WHERE location_id=$1`, branch).Scan(&stock); err != nil {
		t.Fatalf("the branch stock could not be read: %v", err)
	}
	return stock
}

// settlementsState is every settlement as one value, so "this migration wrote no
// settlement" is one comparison instead of a promise about a column.
func settlementsState(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var state string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(id||':'||status||':'
         ||coalesce(counted_cash::text,'-')||':'||coalesce(closing_cash::text,'-')||':'
         ||coalesce(closed_at::text,'-'),',' ORDER BY id),'') FROM branch_closings`).Scan(&state); err != nil {
		t.Fatalf("the settlements could not be read: %v", err)
	}
	return state
}

// closureCapture is the whole effect of one closure as one value: the settlements, the sheet
// it applied, the stock of its branch and the cash ledger it wrote. It is settlementsState with
// the instant of the closure stated as a flag instead of a timestamp, because the two runs that
// compare a closure against itself close at different instants by construction.
func closureCapture(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64, branch int) string {
	t.Helper()
	var settled string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(id||':'||status||':'||
         coalesce(counted_cash::text,'-')||':'||coalesce(closing_cash::text,'-')||':'||
         (closed_at IS NOT NULL)::text,',' ORDER BY id),'') FROM branch_closings`).Scan(&settled); err != nil {
		t.Fatalf("the settlements could not be read: %v", err)
	}
	return settled + "|" + countSheet(t, ctx, p, closing) + "|" + stockSheet(t, ctx, p, branch) +
		"|" + cashLedger(t, ctx, p)
}

// TestClosingAssumedCountSeedsTheSystemQuantity proves S1 on a live database: opening a
// settlement seeds every variant with stock at the quantity the database expects, no
// seeded line is left without a quantity, and the warehouse proposes and closes the
// settlement without writing a single counted quantity.
func TestClosingAssumedCountSeedsTheSystemQuantity(t *testing.T) {
	ctx, p := assumedCountFixture(t)
	closing := openSettlement(t, ctx, p, 2)

	// The sheet starts aligned with the system: variant 1 expects 10 and is seeded 10,
	// variant 2 expects 4 and is seeded 4.
	sheet := countSheet(t, ctx, p, closing)
	if sheet != "1:10:10,2:4:4" {
		t.Fatalf("the opening must seed the counted quantity with the expected one, got %q", sheet)
	}
	if pending := countRows(t, ctx, p, `SELECT count(*) FROM closing_count_lines
 WHERE counted_quantity IS NULL`); pending != 0 {
		t.Fatalf("no seeded line may be left without a quantity, got %d", pending)
	}

	// Proposing and closing need no count at all: the sheet already states that the branch
	// agrees with the system, which is the whole point of S1.
	closeSettlement(t, ctx, p, closing, "100.00", "0.00", "60.00")
	if after := countSheet(t, ctx, p, closing); after != sheet {
		t.Fatalf("the closure must apply the seeded sheet, not rewrite it: %q before %q", sheet, after)
	}
	var state string
	if err := p.QueryRow(ctx, `SELECT status||':'||(closed_at IS NOT NULL)::text
 FROM branch_closings WHERE id=$1`, closing).Scan(&state); err != nil || state != "closed:true" {
		t.Fatalf("a settlement whose sheet is assumed must close: %q %v", state, err)
	}

	// Nothing moved, because the count agreed with the system in every line...
	if stock := stockSheet(t, ctx, p, 2); stock != "1:10:0,2:4:0" {
		t.Fatalf("an assumed count must leave the stock exactly as it was, got %q", stock)
	}
	// ...and the drawer is still stated by the closure: the cash ledger rows it wrote
	// before this version are exactly the ones it writes now.
	var ledger string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||description,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, closing).Scan(&ledger); err != nil ||
		ledger != "recaudacion:40.00:Recaudación de la rendición" {
		t.Fatalf("the closure must keep writing its own settlement transfer: %q %v", ledger, err)
	}
	t.Logf("043: the opening seeds the expected quantity and the settlement closes with zero count edits")
}

// TestClosingAssumedCountAppliesTheDifferences proves S4 on a live database: the seeded
// quantity is a starting point, not a constraint. A line edited to a different quantity
// still moves the stock in both directions, a seeded line edited to 0 ends at 0, and a
// variant the branch holds physically but the system does not still creates its balance
// when the closure applies the count.
func TestClosingAssumedCountAppliesTheDifferences(t *testing.T) {
	ctx, p := assumedCountFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	if sheet := countSheet(t, ctx, p, closing); sheet != "1:10:10,2:4:4" {
		t.Fatalf("the differences are written over a seeded sheet, got %q", sheet)
	}

	// The warehouse only writes what disagrees: variant 1 goes down to 0 and variant 2 goes
	// up to 6, while the seeded 10 and 4 are never restated.
	countAll(t, ctx, p, closing, map[int]int{1: 0, 2: 6})
	// A variant the branch holds and the system does not: expected 0, counted 5. The
	// expected quantity stays the database's own snapshot, never a caller promise.
	var expected int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_count_lines(closing_id,variant_id,expected_quantity,counted_quantity)
 VALUES($1,3,999,5) RETURNING expected_quantity`, closing).Scan(&expected); err != nil || expected != 0 {
		t.Fatalf("a variant without a balance row must be stated with expected 0: %d %v", expected, err)
	}

	closeSettlement(t, ctx, p, closing, "100.00", "0.00", "60.00")
	if stock := stockSheet(t, ctx, p, 2); stock != "1:0:0,2:6:0,3:5:0" {
		t.Fatalf("the differences must be applied in both directions, got %q", stock)
	}
	t.Logf("043: a seeded sheet applies its differences: 10 -> 0, 4 -> 6, and 0 -> 5 created")
}

// TestClosingAssumedCountSeedsLiveSheets proves S6 on a live database at the version that
// introduces the rule: the sheet of a settlement that is still open, and of one the branch
// rejected, is seeded with the expected quantity when 043 is applied, while a settlement
// that is already closed keeps its sheet and its closure byte-identical.
//
// The fixture stops at 042 on purpose: the pending lines a live database holds before this
// version are the ones this migration has to seed, so they are written by the seeding of
// 035 as it was, and read back after 043 is applied over them.
func TestClosingAssumedCountSeedsLiveSheets(t *testing.T) {
	ctx, p := assumedCountDB(t, 42)

	// A settlement the branch already signed: its sheet is the history it accepted, and the
	// count it applied differs from the expected snapshot (5 counted 3), so a backfill that
	// rewrote a closed sheet would be visible.
	closed := openSettlement(t, ctx, p, 3)
	countAll(t, ctx, p, closed, map[int]int{1: 3, 2: 2})
	closeSettlement(t, ctx, p, closed, "100.00", "0.00", "60.00")
	closedSheet := countSheet(t, ctx, p, closed)
	if closedSheet != "1:5:3,2:2:2" {
		t.Fatalf("the pre-043 closure must state the count it applied, got %q", closedSheet)
	}

	// A settlement that is still open with the pending lines of the 035 seed.
	open := openSettlement(t, ctx, p, 2)
	if sheet := countSheet(t, ctx, p, open); sheet != "1:10:-,2:4:-" {
		t.Fatalf("the sheet this version inherits must be the pending one of 035, got %q", sheet)
	}
	// A settlement the branch rejected and the warehouse resumed: a rejection hands the
	// sheet back, so its lines can be pending again exactly like an open one. Its expected
	// snapshot is what the first closure left (3 and 2), not what the shelf held before it.
	rejected := openSettlement(t, ctx, p, 3)
	countAll(t, ctx, p, rejected, map[int]int{1: 3, 2: 2})
	closeSettlementDraft(t, ctx, p, rejected, "100.00", "60.00")
	decideRound(t, ctx, p, rejected, "rejected", "el conteo estaba mal")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, rejected); err != nil {
		t.Fatalf("the rejection must return the settlement to the warehouse: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_count_lines SET counted_quantity=NULL WHERE closing_id=$1`, rejected); err != nil {
		t.Fatalf("a rejected sheet must be able to be pending again: %v", err)
	}

	// What this migration must not move: the settlements, their closures, the stock and the
	// cash ledger of the branches.
	before := settlementsState(t, ctx, p)
	beforeStock := stockSheet(t, ctx, p, 2) + "|" + stockSheet(t, ctx, p, 3)
	beforeLedger := cashLedger(t, ctx, p)

	backfill, err := migrations.Files.ReadFile(migration043)
	if err != nil {
		t.Fatal("the assumed count migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(backfill)); err != nil {
		t.Fatalf("the assumed count migration must apply on a live database: %v", err)
	}

	// The live sheets are seeded with the quantity the database expects...
	if sheet := countSheet(t, ctx, p, open); sheet != "1:10:10,2:4:4" {
		t.Fatalf("an open settlement must be seeded when the version is applied, got %q", sheet)
	}
	if sheet := countSheet(t, ctx, p, rejected); sheet != "1:3:3,2:2:2" {
		t.Fatalf("a rejected settlement must be seeded when the version is applied, got %q", sheet)
	}
	// ...and there is nothing pending left anywhere.
	if pending := countRows(t, ctx, p, `SELECT count(*) FROM closing_count_lines
 WHERE counted_quantity IS NULL`); pending != 0 {
		t.Fatalf("no sheet may be left pending by this version, got %d", pending)
	}
	// The closed settlement is untouched, line by line.
	if sheet := countSheet(t, ctx, p, closed); sheet != closedSheet {
		t.Fatalf("a closed sheet must stay exactly as it was signed: %q before %q", closedSheet, sheet)
	}
	// No settlement row, no stock and no cash entry moved: the backfill seeds a sheet, it
	// does not close, reopen or re-apply anything.
	if after := settlementsState(t, ctx, p); after != before {
		t.Fatalf("this version must write no settlement, got %q before %q", before, after)
	}
	if after := stockSheet(t, ctx, p, 2) + "|" + stockSheet(t, ctx, p, 3); after != beforeStock {
		t.Fatalf("this version must move no stock, got %q before %q", beforeStock, after)
	}
	if after := cashLedger(t, ctx, p); after != beforeLedger {
		t.Fatalf("this version must write no ledger row, got %q before %q", beforeLedger, after)
	}

	// And the seeded sheet is what it promised to be: the open settlement proposes and
	// closes with no count edit at all.
	closeSettlement(t, ctx, p, open, "100.00", "0.00", "60.00")
	if stock := stockSheet(t, ctx, p, 2); stock != "1:10:0,2:4:0" {
		t.Fatalf("the seeded sheet of an open settlement must close without moving stock, got %q", stock)
	}
	t.Logf("043: open and rejected sheets are seeded and the closed one is left byte-identical")
}

// TestClosingAssumedCountClosesTheSameWithRestatedAndAssumedSheets proves S5 against S7 on a
// live database: the closure is identical whether the sheet was restated line by line or left
// exactly as the system seeded it, which is what makes this version a removal of work and not a
// change of behavior.
//
// The base is the same database at 042, the last version before this one: its sheet opens
// pending, so the only way to propose and close there is to state every line with the quantity
// the system already holds. The candidate is 043 with no count edit at all. Both sides close
// through the same walk and both captures carry the settlements, the sheet the closure applied,
// the stock of the branch and the cash ledger it wrote.
func TestClosingAssumedCountClosesTheSameWithRestatedAndAssumedSheets(t *testing.T) {
	walk := func(last int, restateTheSheet bool) (sheet, capture string) {
		ctx, p := assumedCountDB(t, last)
		closing := openSettlement(t, ctx, p, 2)
		if restateTheSheet {
			countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})
		}
		closeSettlement(t, ctx, p, closing, "100.00", "0.00", "60.00")
		return countSheet(t, ctx, p, closing), closureCapture(t, ctx, p, closing, 2)
	}
	baseSheet, baseCapture := walk(42, true)
	assumedSheet, assumedCapture := walk(43, false)

	// Both sheets state the same count: the one the warehouse typed in at 042 and the one the
	// opening seeded at 043 are the same numbers, line by line.
	if baseSheet != "1:10:10,2:4:4" {
		t.Fatalf("the base closure must read the restated sheet, got %q", baseSheet)
	}
	if assumedSheet != "1:10:10,2:4:4" {
		t.Fatalf("an assumed sheet must read exactly the restated one, got %q", assumedSheet)
	}
	// And what the closure did with it is byte-identical: no settlement, no stock and no cash
	// entry moved because the count was written by the database instead of by the warehouse.
	if assumedCapture != baseCapture {
		t.Fatalf("the closure must not change with the restated sheet:\n043: %s\n042: %s",
			assumedCapture, baseCapture)
	}
	t.Logf("043: the restated and the assumed sheet close identically: %s", assumedCapture)
}

// TestClosingAssumedCountRefusesASheetThatAlreadyExceedsTheCountedBound proves the one bound
// this version documents: counted_quantity is checked against 1000000 by 034 while
// inventory_balances.existing is an unbounded bigint, so a branch may legally hold more than a
// million units of a variant and a sheet opened before this version may legally state that
// quantity. Seeding such a line writes a value the check refuses, and this file must abort
// loudly with the check violation instead of clamping a count the closure would then apply as
// stock.
func TestClosingAssumedCountRefusesASheetThatAlreadyExceedsTheCountedBound(t *testing.T) {
	ctx, p := assumedCountDB(t, 42)
	// Above 034's ceiling, and legal: the balance is a bigint and nothing bounds it.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=1000001
 WHERE location_id=3 AND variant_id=1`); err != nil {
		t.Fatalf("the oversized stock could not be provisioned: %v", err)
	}
	closing := openSettlement(t, ctx, p, 3)
	if sheet := countSheet(t, ctx, p, closing); sheet != "1:1000001:-,2:2:-" {
		t.Fatalf("a sheet may state a quantity above the counted bound, got %q", sheet)
	}

	// Everything this migration could write, including the seeding function it replaces first,
	// is captured before it runs: a failure that left the new function installed would be a
	// half-applied version even with every stored row intact.
	seedFunction := func() string {
		t.Helper()
		var definition string
		if err := p.QueryRow(ctx, `SELECT pg_get_functiondef('seed_closing_count_lines()'::regprocedure)`).Scan(&definition); err != nil {
			t.Fatalf("the seeding function could not be read: %v", err)
		}
		return definition
	}
	before := closureCapture(t, ctx, p, closing, 3)
	beforeSeed := seedFunction()

	backfill, err := migrations.Files.ReadFile(migration043)
	if err != nil {
		t.Fatal("the assumed count migration must be embedded", err)
	}
	_, applyErr := p.Exec(ctx, string(backfill))
	var pgErr *pgconn.PgError
	if !errors.As(applyErr, &pgErr) {
		t.Fatalf("seeding a sheet above the counted bound must abort the migration, got %v", applyErr)
	}
	// The counted-quantity check of 034, on the count sheet: the count it would have to invent
	// is refused by the database, not corrected by the migration.
	if pgErr.Code != "23514" || pgErr.TableName != "closing_count_lines" {
		t.Fatalf("the refusal must be the counted-quantity check 23514 on the sheet, got %s on %q",
			pgErr.Code, pgErr.TableName)
	}
	// Aborting means writing nothing: the statements of this file land in one batch, so the
	// replacement of the seeding function rolls back with the update that failed.
	if after := closureCapture(t, ctx, p, closing, 3); after != before {
		t.Fatalf("a refused migration must write nothing:\n before: %s\n after:  %s", before, after)
	}
	if after := seedFunction(); after != beforeSeed {
		t.Fatalf("a refused migration must leave the seeding function of 035 installed")
	}
	t.Logf("043 over a sheet above the bound aborted with %s and wrote nothing", pgErr.Code)
}

// closeSettlementDraft moves an open settlement to 'proposed' with the money it counted,
// without deciding the round: it is the half of the walk a rejection needs, because a
// rejected settlement is one the branch refused an offer of.
func closeSettlementDraft(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64, counted, fund string) {
	t.Helper()
	proposeRound(t, ctx, p, closing, `{"fund":"`+fund+`"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=$2::numeric,
 closing_cash=$3::numeric WHERE id=$1 AND status IN ('open','rejected')`, closing, counted, fund); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
}
