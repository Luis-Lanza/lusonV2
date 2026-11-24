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

// The used pool feeds the settlement (S17): 045 seeded the used sheet from the purchases of the
// window and 047 restated that as the pending backlog at the cut, but a used battery also leaves
// the branch when it is lent to the client of a warranty case (065) and comes back to the pool when
// the factory refuses the claim. This version teaches the seed those two flows -- and only them, so
// the scrap sheet is exactly the one 047 wrote -- without creating any balance of used batteries
// (S18) and without touching a single sheet a settlement already stored.
const usedPoolMigration = "066_closing_materials_used_pool.sql"

// scrapSeedBlock is the scrap half of the seed as one comparable string: from its own INSERT to the
// end of its subquery. Comparing the two versions term by term proves 066 leaves the scrap sheet
// exactly as 047 wrote it, and comparing them through strings.Fields means indentation is not the
// contract.
func scrapSeedBlock(t *testing.T, sql string) string {
	t.Helper()
	const start = "INSERT INTO closing_material_lines(closing_id,kind,material_id,expected_quantity)"
	from := strings.Index(sql, start)
	if from < 0 {
		t.Fatal("the seed must state the scrap insert")
	}
	length := strings.Index(sql[from:], "WHERE pending.quantity > 0;")
	if length < 0 {
		t.Fatal("the scrap insert must close with its own pending filter")
	}
	length += len("WHERE pending.quantity > 0;")
	return strings.Join(strings.Fields(sql[from:from+length]), " ")
}

// TestClosingMaterialsUsedPoolShape reads the embedded version exactly as PostgreSQL receives it.
// It proves the file replaces the one function 045's trigger already calls, states the four flows
// of the used pool and keeps the other two thirds of 047 -- the provenance marker and the scrap
// sheet -- untouched, while installing nothing else: no table, no index, no trigger, and no
// statement of its own that writes a row of any existing table.
func TestClosingMaterialsUsedPoolShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(usedPoolMigration)
	if err != nil {
		t.Fatal("the used pool migration must be embedded", err)
	}
	code := withoutSQLComments(string(b))
	for _, required := range []string{
		// The one function 045's trigger already calls, replaced whole.
		"CREATE OR REPLACE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$",
		// The provenance of the expected quantity is untouched (LC020).
		"PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);",
		"PERFORM set_config('luson.closing_material_seed', '', true);",
		// The inflow of 047: what the branch bought before this cut...
		"FROM purchase_used_lines line",
		"AND purchase.created_at < NEW.cut_at",
		// ...minus what its closed settlements already delivered of that model.
		"AND closing.status = 'closed'",
		"sheet.counted_quantity IS NOT NULL",
		// The other inflow of S17: the batteries the factory refused to cover and sent back to the
		// used pool, keyed by the model code of the catalogue and attributed to the branch of the
		// case (065: `verdict`, `reported_destination`).
		"FROM warranty_cases case_row",
		"JOIN catalog_variants variant ON variant.id = case_row.variant_id",
		"JOIN catalog_entries entry ON entry.id = variant.catalog_entry_id",
		"AND case_row.verdict = 'not_covered'",
		"AND case_row.reported_destination = 'stock'",
		"WHERE case_row.branch_location_id = NEW.branch_location_id",
		"upper(btrim(entry.model))",
		// The outflow of S17: the loans the branch gave inside its own window (065: `given_at`).
		"FROM warranty_case_loans loan",
		"WHERE loan.source_location_id = NEW.branch_location_id",
		"AND loan.given_at < NEW.cut_at",
		// The four flows are one signed sum per model, and only a pool that holds something is a
		// line of the sheet, exactly as 045 and 047 seed.
		"HAVING sum(flow.units) > 0;",
	} {
		if !strings.Contains(code, required) {
			t.Errorf("066 must install %q", required)
		}
	}
	// One replacement and nothing else: the trigger of 045 keeps calling this function by name, so
	// a second CREATE FUNCTION or a CREATE TRIGGER would install the seed twice.
	if got := strings.Count(code, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("066 must replace exactly one function, got %d", got)
	}
	trimmed := strings.TrimSpace(code)
	if !strings.HasPrefix(trimmed, "CREATE OR REPLACE FUNCTION seed_closing_material_lines") ||
		strings.Count(trimmed, "$$;") != 1 {
		t.Error("066 must be exactly one function replacement and nothing else")
	}
	for _, forbidden := range []string{
		"CREATE FUNCTION", "CREATE TRIGGER", "CREATE TABLE", "CREATE INDEX",
		"CREATE UNIQUE INDEX", "ALTER TABLE", "DROP ", "ADD COLUMN",
		"UPDATE ", "DELETE FROM", "TRUNCATE",
		// No stock of used batteries, no balance and no count of its own (S18).
		"inventory_balances", "stock_adjustments", "stock_entries",
		// No money and no cash row (S12).
		"branch_cash", "amount", "price", "cash",
	} {
		if strings.Contains(code, forbidden) {
			t.Errorf("066 must not contain %q", forbidden)
		}
	}
	// The scrap half is 047's, term for term: this version adds the outflows and the other inflow of
	// the used pool and leaves the weighed materials exactly as they were (S17).
	previous, err := migrations.Files.ReadFile(migration047)
	if err != nil {
		t.Fatal("the backlog migration must be embedded", err)
	}
	if got, want := scrapSeedBlock(t, string(b)), scrapSeedBlock(t, string(previous)); got != want {
		t.Fatalf("066 must leave the scrap sheet of 047 untouched:\n got %s\nwant %s", got, want)
	}
	// The file documents the two flows it teaches, the one fact this repository does not record and
	// what it keeps, so the next reader does not have to reconstruct any of it.
	for _, documented := range []string{
		"S17", "S18", "S12", "045", "047", "065", "LC020", "checksum",
		"not_covered", "given_at", "scrap", "chatarra", "loan",
	} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("066 must document its own decision: %s", documented)
		}
	}
}

// usedPoolFixture is the settlement block applied through last: the prefix catalogue, one account
// per location, the stock of branch 2 and its commission rate, which is what a settlement and a
// warranty case of this branch need. A test that proves the version applies forward asks for 65 and
// installs this one by hand.
func usedPoolFixture(t *testing.T, last int) (context.Context, *pgxpool.Pool) {
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
 VALUES(2,1,10,0),(2,2,4,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,
 updated_by_account_id) VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	// The purchase fund the purchases below charge, stated by the branch's own account (050).
	if _, err := p.Exec(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES(2,'aporte',1000.00,'Fondo de compras del fixture',2)`); err != nil {
		t.Fatal("the branch fund could not be stated")
	}
	return ctx, p
}

// resolveCase states the verdict the factory reached and where each unit of the case ends, which is
// exactly the pair of facts the used pool reads (S11, S17).
func resolveCase(t *testing.T, ctx context.Context, p *pgxpool.Pool, claim int64, verdict,
	reported, loan string) {
	t.Helper()
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict=$2,reported_destination=$3,
 loan_destination=$4 WHERE id=$1`, claim, verdict, reported, loan); err != nil {
		t.Fatalf("the resolution of the case must be storable: %v", err)
	}
}

// TestClosingMaterialsUsedPoolReducesTheExpectationWithEveryLoan proves the outflow half of S17 on a
// live database: a loan given in the window reduces the expected quantity of its model by the
// quantity lent, a loan taken from another branch reduces the sheet of that other branch and not
// this one, and the scrap sheet of the same settlement is exactly what it was without any of this.
func TestClosingMaterialsUsedPoolReducesTheExpectationWithEveryLoan(t *testing.T) {
	ctx, p := usedPoolFixture(t, 66)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "used-pool-loan-01", "NS60ZL", 4, "10.00", "40.00")
	buyScrap(t, ctx, p, "used-pool-loan-02", 1, "5.000", "2.00", "10.00")
	// One NS40ZL bought and two lent: the pool of that model nets less than nothing, so it is no
	// line of the sheet at all rather than a negative expectation.
	buyUsed(t, ctx, p, "used-pool-loan-03", "NS40ZL", 1, "10.00", "10.00")
	// Two of the four used batteries leave the branch in the hands of a client, and one more is
	// taken from another branch, which is no outflow of this one (S6).
	claim := warrantyDefect(t, ctx, p, 2, 1, 1, 2)
	warrantyLend(t, ctx, p, claim, "NS60ZL", 2, "", 2, 2)
	warrantyLend(t, ctx, p, claim, "NS60ZL", 1, "", 3, 3)
	warrantyLend(t, ctx, p, claim, "NS40ZL", 2, "", 2, 2)
	closing := openSettlement(t, ctx, p, 2)
	// Four bought minus the two this branch lent: the pool holds two, and the weighed materials of
	// the same period are the ones 047 seeds.
	want := []string{"used:NS60ZL:2.000:-", "scrap:1:5.000:-"}
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("a loan must reduce the expected used pool, got %v want %v", got, want)
	}
	t.Logf("066: 4 NS60ZL bought - 2 lent by this branch = 2, the loan of branch 3 is branch 3's")
}

// TestClosingMaterialsUsedPoolCountsTheFactoryReturns proves the other inflow of S17 on a live
// database: a battery the factory sent back as not covered and destined to the used pool adds its
// units to the sheet of the branch that owns the case, keyed by the model code of the catalogue,
// while a repaired unit, a unit destined to scrap and a case of another branch add nothing.
func TestClosingMaterialsUsedPoolCountsTheFactoryReturns(t *testing.T) {
	ctx, p := usedPoolFixture(t, 66)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "used-pool-return-01", "NS60ZL", 3, "10.00", "30.00")
	// The factory refuses two damaged batteries: they come back to the used pool of branch 2 (S11).
	notCovered := warrantyDefect(t, ctx, p, 2, 1, 2, 2)
	resolveCase(t, ctx, p, notCovered, "not_covered", "stock", "customer")
	// A repaired unit went back to its client and a not covered one destined to scrap never enters
	// the used pool, so neither is an inflow of this sheet.
	repaired := warrantyDefect(t, ctx, p, 2, 1, 5, 2)
	resolveCase(t, ctx, p, repaired, "repaired", "customer", "customer")
	scrapped := warrantyDefect(t, ctx, p, 2, 1, 4, 2)
	resolveCase(t, ctx, p, scrapped, "not_covered", "scrap", "customer")
	// The pool of another branch is that branch's sheet, and never this one.
	other := warrantyDefect(t, ctx, p, 3, 1, 6, 3)
	resolveCase(t, ctx, p, other, "not_covered", "stock", "customer")
	closing := openSettlement(t, ctx, p, 2)
	// Two returned NP7-12 -- the catalogue model of variant 1, which the branch never bought -- and
	// the three it bought and did not lend.
	want := []string{"used:NP7-12:2.000:-", "used:NS60ZL:3.000:-"}
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("a refused claim must feed the pool of its branch, got %v want %v", got, want)
	}
	t.Logf("066: 2 NP7-12 returned not covered, and no line for repaired, scrap or branch 3")
}

// TestClosingMaterialsUsedPoolKeepsEveryStoredSheet proves the third check of S17 on a live
// database: the expectation is the snapshot of the opening, so a loan and a refused claim that
// happen after a settlement stored its sheet do not move it, and the guard of 045 still refuses any
// attempt to rewrite one.
func TestClosingMaterialsUsedPoolKeepsEveryStoredSheet(t *testing.T) {
	ctx, p := usedPoolFixture(t, 66)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "used-pool-frozen-01", "NS60ZL", 5, "10.00", "50.00")
	closing := openSettlement(t, ctx, p, 2)
	signed := "used:NS60ZL:5.000:-"
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != signed {
		t.Fatalf("the sheet of the opening is what the period bought: %v", got)
	}
	// The pool moves while the sheet is live: two batteries are lent and one claim is refused.
	claim := warrantyDefect(t, ctx, p, 2, 1, 1, 2)
	warrantyLend(t, ctx, p, claim, "NS60ZL", 2, "", 2, 2)
	refused := warrantyDefect(t, ctx, p, 2, 1, 1, 2)
	resolveCase(t, ctx, p, refused, "not_covered", "stock", "customer")
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != signed {
		t.Fatalf("a stored sheet never moves with the pool: got %v want %v", got, signed)
	}
	// ...and it cannot be rewritten either: the expected quantity of a line is the snapshot of its
	// opening and only the count moves (LC025, unchanged from 045).
	_, err := p.Exec(ctx, `UPDATE closing_material_lines SET expected_quantity=1
 WHERE closing_id=$1`, closing)
	execRefusalMessage(t, err, "LC025", "Only the counted quantity can change on a material line")
	t.Logf("066: the sheet of an existing settlement is the snapshot of its own opening")
}

// TestClosingMaterialsUsedPoolAppliesForwardWithoutBackfill proves the one direction a new version
// of this sheet must have: applying 066 to a database that already stores sheets leaves every one of
// them exactly as it was -- no backfill, no rewrite of a signed settlement -- and the next opening
// seeds by the new rule.
func TestClosingMaterialsUsedPoolAppliesForwardWithoutBackfill(t *testing.T) {
	ctx, p := usedPoolFixture(t, 65)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "used-pool-forward-01", "NS60ZL", 5, "10.00", "50.00")
	buyScrap(t, ctx, p, "used-pool-forward-02", 1, "4.000", "2.00", "8.00")
	first := openSettlement(t, ctx, p, 2)
	closeBacklogSettlement(t, ctx, p, first, map[string]string{"NS60ZL": "5", "1": "4.000"})
	signed := "used:NS60ZL:5.000:5.000,scrap:1:4.000:4.000"
	if got := materialSheet(t, ctx, p, first); strings.Join(got, ",") != signed {
		t.Fatalf("the first settlement signed its own sheet: %v", got)
	}
	sheets := countRows(t, ctx, p, `SELECT count(*) FROM closing_material_lines`)
	// The version is installed on a database that already holds sheets, exactly as the runner does.
	sql, err := migrations.Files.ReadFile(usedPoolMigration)
	if err != nil {
		t.Fatal("the used pool migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(sql)); err != nil {
		t.Fatalf("066 must apply to a database that already has sheets: %v", err)
	}
	// Nothing was backfilled: the closed settlement keeps the sheet it signed, row for row.
	if got := materialSheet(t, ctx, p, first); strings.Join(got, ",") != signed {
		t.Fatalf("no backfill may rewrite a stored sheet: got %v want %v", got, signed)
	}
	if got := countRows(t, ctx, p, `SELECT count(*) FROM closing_material_lines`); got != sheets {
		t.Fatalf("applying 066 writes no line of its own: %d rows became %d", sheets, got)
	}
	// From here on the pool is the four flows: three bought after the closure minus the two lent,
	// and a model the branch bought and lent nothing of is exactly what 047 stated.
	buyUsed(t, ctx, p, "used-pool-forward-03", "NS60ZL", 3, "10.00", "30.00")
	buyUsed(t, ctx, p, "used-pool-forward-04", "NS40ZL", 2, "10.00", "20.00")
	claim := warrantyDefect(t, ctx, p, 2, 1, 1, 2)
	warrantyLend(t, ctx, p, claim, "NS60ZL", 2, "", 2, 2)
	next := openSettlement(t, ctx, p, 2)
	want := []string{"used:NS40ZL:2.000:-", "used:NS60ZL:1.000:-"}
	if got := materialSheet(t, ctx, p, next); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the next opening seeds by the new rule: got %v want %v", got, want)
	}
	t.Logf("066: a signed sheet survives the version, 3 bought - 2 lent = 1, and 2 bought = 2")
}
