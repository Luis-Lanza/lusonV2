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

// migration047 is the pending backlog of the material sheet (S7, S11): 045 seeded the sheet from
// the purchases of [period_start, cut_at), and the first period of a branch starts at its earliest
// sale or movement of the till (039), so a branch that bought before it ever sold kept that
// backlog out of every sheet it will ever have. This version restates the rule the purchases
// screen already publishes -- the sheet is what the branch bought before the cut minus what its
// closed settlements already delivered -- and replaces the seed with CREATE OR REPLACE, because
// 045 is applied and checksummed.
const migration047 = "047_closing_materials_backlog.sql"

// TestClosingMaterialsBacklogMigrationShape reads the embedded migration exactly as PostgreSQL
// receives it. It proves the file replaces one function and states one rule -- the backlog at the
// cut, not the window -- and that it installs nothing else: no table, no column, no index, no
// trigger, and no statement of its own that writes a row.
func TestClosingMaterialsBacklogMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration047)
	if err != nil {
		t.Fatal("the backlog migration must be embedded", err)
	}
	code := withoutSQLComments(string(b))
	for _, required := range []string{
		// The one function 045's trigger already calls, replaced whole.
		"CREATE OR REPLACE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$",
		// The provenance of the expected quantity is untouched (LC020).
		"PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);",
		"PERFORM set_config('luson.closing_material_seed', '', true);",
		// The rule: what the branch bought before the cut...
		"AND purchase.created_at < NEW.cut_at",
		// ...minus what its closed settlements already delivered.
		"AND closing.status = 'closed'",
		"sheet.counted_quantity IS NOT NULL",
		// Both kinds are seeded, exactly as 045 seeds them.
		"INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity)",
		"INSERT INTO closing_material_lines(closing_id,kind,material_id,expected_quantity)",
		"GROUP BY line.model",
		"GROUP BY line.material_id",
	} {
		if !strings.Contains(code, required) {
			t.Errorf("047 must install %q", required)
		}
	}
	// The window is gone: neither the first nor the last bound of the period is read by the seed.
	for _, gone := range []string{"period_start", "NEW.period_start"} {
		if strings.Contains(code, gone) {
			t.Errorf("047 must not read the window of the settlement: %q", gone)
		}
	}
	// One replacement and nothing else: the trigger of 045 keeps calling this function by name, so
	// a second CREATE FUNCTION or CREATE TRIGGER would install the seed twice.
	if got := strings.Count(code, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("047 must replace exactly one function, got %d", got)
	}
	trimmed := strings.TrimSpace(code)
	if !strings.HasPrefix(trimmed, "CREATE OR REPLACE FUNCTION seed_closing_material_lines") ||
		strings.Count(trimmed, "$$;") != 1 {
		t.Error("047 must be exactly one function replacement and nothing else")
	}
	for _, forbidden := range []string{
		"CREATE FUNCTION", "CREATE TRIGGER", "CREATE TABLE", "CREATE INDEX",
		"CREATE UNIQUE INDEX", "ALTER TABLE", "DROP ", "ADD COLUMN",
		"UPDATE closing", "DELETE FROM", "TRUNCATE",
	} {
		if strings.Contains(code, forbidden) {
			t.Errorf("047 must not contain %q", forbidden)
		}
	}
	// The file documents the defect it corrects and what it keeps, so the next reader does not have
	// to reconstruct either: 045's sheet, 039's first period, the freeze of the live settlement and
	// the derivation of the delivered quantity.
	for _, documented := range []string{
		"045", "039", "LC001", "S7", "S8", "S11", "backlog", "counter-document", "checksum",
		"delivered",
	} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("047 must document its own decision: %s", documented)
		}
	}
}

// withoutSQLComments drops the line comments of a migration, so the shape test judges the
// statements PostgreSQL runs and never the prose around them.
func withoutSQLComments(sql string) string {
	lines := strings.Split(sql, "\n")
	code := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		code = append(code, line)
	}
	return strings.Join(code, "\n")
}

// backlogFixture is the settlement block applied through 047: the prefix catalogue, one account per
// location, the stock of branch 2 and its commission rate, which is what a settlement needs to be
// opened and closed.
func backlogFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 47)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(2,2,4,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	return ctx, p
}

// closeBacklogSettlement counts the whole seeded sheet with the quantities the test states and
// closes the settlement the way the state machine allows: the warehouse proposes, the branch
// accepts and the closure applies. A pending line blocks nothing, so a test states only the lines
// it counted.
func closeBacklogSettlement(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64,
	counted map[string]string) {
	t.Helper()
	for key, quantity := range counted {
		if _, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=$3::numeric
 WHERE closing_id=$1 AND coalesce(model,material_id::text)=$2`, closing, key, quantity); err != nil {
			t.Fatalf("the line %s could not be counted: %v", key, err)
		}
	}
	closeSettlement(t, ctx, p, closing, "0.00", "0.00", "0.00")
}

// TestClosingMaterialsBacklogSeedsTheFirstSettlement proves S7 on a live database: a branch that
// buys used batteries and scrap before it ever sells or moves its till opens its first settlement
// at its own cut instant (039), so the window of that period holds no purchase at all -- and the
// sheet still carries them, because the sheet is the pending backlog at the cut and not the window.
func TestClosingMaterialsBacklogSeedsTheFirstSettlement(t *testing.T) {
	ctx, p := backlogFixture(t)
	// Two used batteries and five kilograms of scrap, bought by a branch with no sale and no
	// movement of the till: the first period of this branch starts at its cut by construction.
	buyUsed(t, ctx, p, "backlog-first-used-01", "NS60ZL", 2, "10.00", "20.00")
	buyScrap(t, ctx, p, "backlog-first-scrap-01", 1, "5.000", "2.00", "10.00")
	closing := openSettlement(t, ctx, p, 2)
	// The defect 047 corrects, stated as a fact of this database: the period opens at the cut, so
	// both purchases are before the period it covers.
	var opensAtCut bool
	if err := p.QueryRow(ctx, `SELECT period_start=cut_at
   AND period_start >= (SELECT max(created_at) FROM purchases WHERE location_id=2)
 FROM branch_closings WHERE id=$1`, closing).Scan(&opensAtCut); err != nil || !opensAtCut {
		t.Fatalf("the first period of a branch with nothing recorded must open at its cut: %t %v",
			opensAtCut, err)
	}
	want := []string{"used:NS60ZL:2.000:-", "scrap:1:5.000:-"}
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the first sheet must hold the backlog the window left out, got %v want %v", got, want)
	}
	t.Logf("047: 2 NS60ZL and 5.000 kg bought before period_start are the sheet of the first cut")
}

// TestClosingMaterialsBacklogIsNotDeliveredTwice proves the subtraction half of the rule on a live
// database: what a CLOSED settlement counted of a key is delivered, so the next sheet states only
// what is still pending, and a key the branch already delivered whole has no line at all.
func TestClosingMaterialsBacklogIsNotDeliveredTwice(t *testing.T) {
	ctx, p := backlogFixture(t)
	buyUsed(t, ctx, p, "backlog-twice-used-01", "NS60ZL", 4, "10.00", "40.00")
	buyScrap(t, ctx, p, "backlog-twice-scrap-01", 1, "5.000", "2.00", "10.00")
	first := openSettlement(t, ctx, p, 2)
	if got := materialSheet(t, ctx, p, first); strings.Join(got, ",") !=
		"used:NS60ZL:4.000:-,scrap:1:5.000:-" {
		t.Fatalf("the first sheet must hold the whole backlog: %v", got)
	}
	// The warehouse takes everything to the warehouse: the sheet is delivered whole at the closure.
	closeBacklogSettlement(t, ctx, p, first, map[string]string{"NS60ZL": "4", "1": "5.000"})
	// The branch buys three more batteries in the next period.
	buyUsed(t, ctx, p, "backlog-twice-used-02", "NS60ZL", 3, "10.00", "30.00")
	next := openSettlement(t, ctx, p, 2)
	want := []string{"used:NS60ZL:3.000:-"}
	if got := materialSheet(t, ctx, p, next); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("only the pending backlog is the sheet: got %v want %v", got, want)
	}
	// The copper was delivered whole, so the key is not a position of the branch any more: no row,
	// and the first settlement keeps exactly the sheet it signed.
	if got := materialSheet(t, ctx, p, first); strings.Join(got, ",") !=
		"used:NS60ZL:4.000:4.000,scrap:1:5.000:5.000" {
		t.Fatalf("a closed settlement keeps the sheet it signed: %v", got)
	}
	t.Logf("047: 4 bought - 4 delivered leaves 3 of the 3+4 documents, and the copper has no line")
}

// TestClosingMaterialsBacklogKeepsTheCounterDocumentEffect proves the half of 045 this version does
// not touch: a counter-document is stored with its negated quantity and weight, so it subtracts
// from the backlog by itself, no document is ever filtered out by its sign or by being a reversal,
// and a key the branch bought and returned whole is not a line of the sheet.
func TestClosingMaterialsBacklogKeepsTheCounterDocumentEffect(t *testing.T) {
	ctx, p := backlogFixture(t)
	six := buyUsed(t, ctx, p, "backlog-counter-used-01", "NS60ZL", 6, "10.00", "60.00")
	buyUsed(t, ctx, p, "backlog-counter-used-02", "NS50ZL", 3, "10.00", "30.00")
	reversePurchase(t, ctx, p, "backlog-counter-used-03", six)
	copper := buyScrap(t, ctx, p, "backlog-counter-scrap-01", 1, "8.000", "2.00", "16.00")
	buyScrap(t, ctx, p, "backlog-counter-scrap-02", 3, "12.500", "2.00", "25.00")
	reversePurchase(t, ctx, p, "backlog-counter-scrap-03", copper)
	// The negation is in the stored lines, which is what the backlog subtracts: two documents of
	// NS60ZL net zero and two of copper net zero, and the reversal is one of them.
	var netUsed int
	var documents int
	if err := p.QueryRow(ctx, `SELECT count(*), coalesce(sum(line.quantity),0)
 FROM purchases purchase JOIN purchase_used_lines line ON line.purchase_id=purchase.id
 WHERE purchase.location_id=2 AND line.model='NS60ZL'`).Scan(&documents, &netUsed); err != nil {
		t.Fatalf("the stored used lines could not be read: %v", err)
	}
	var netKg string
	if err := p.QueryRow(ctx, `SELECT coalesce(sum(line.kg),0)::text
 FROM purchases purchase JOIN purchase_scrap_lines line ON line.purchase_id=purchase.id
 WHERE purchase.location_id=2 AND line.material_id=1`).Scan(&netKg); err != nil {
		t.Fatalf("the stored scrap lines could not be read: %v", err)
	}
	if documents != 2 || netUsed != 0 || netKg != "0.000" {
		t.Fatalf("a reversal must be stored negated: %d documents, %d units, %q kg",
			documents, netUsed, netKg)
	}
	closing := openSettlement(t, ctx, p, 2)
	want := []string{"used:NS50ZL:3.000:-", "scrap:3:12.500:-"}
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the reversal must subtract from the backlog, got %v want %v", got, want)
	}
	t.Logf("047: 6-6 NS60ZL and 8.000-8.000 kg are no rows, the untouched keys are")
}

// TestClosingMaterialsBacklogSheetIsEmptyWhenDelivered proves the other end of the rule on a live
// database: a settlement whose whole backlog is already in the warehouse opens an empty sheet,
// never a second delivery of what a closed settlement already counted.
func TestClosingMaterialsBacklogSheetIsEmptyWhenDelivered(t *testing.T) {
	ctx, p := backlogFixture(t)
	buyUsed(t, ctx, p, "backlog-empty-used-01", "NS60ZL", 5, "10.00", "50.00")
	buyScrap(t, ctx, p, "backlog-empty-scrap-01", 2, "3.250", "2.00", "6.50")
	first := openSettlement(t, ctx, p, 2)
	if got := materialSheet(t, ctx, p, first); len(got) != 2 {
		t.Fatalf("the first sheet must hold the whole backlog, got %v", got)
	}
	closeBacklogSettlement(t, ctx, p, first, map[string]string{"NS60ZL": "5", "2": "3.250"})
	// Nothing is bought in the next period, and the branch holds no pending document at its cut.
	next := openSettlement(t, ctx, p, 2)
	if got := materialSheet(t, ctx, p, next); len(got) != 0 {
		t.Fatalf("a delivered backlog seeds no line, got %v", got)
	}
	if got := countRows(t, ctx, p, `SELECT count(*) FROM closing_material_lines`); got != 2 {
		t.Fatalf("the empty sheet must write no row at all, got %d", got)
	}
	t.Logf("047: 5 units and 3.250 kg delivered leave an empty sheet and no second delivery")
}

// TestClosingMaterialsBacklogKeepsTheFreeze proves the rule 047 does not touch: a branch with a
// live settlement cannot buy, so the backlog of the next cut can only grow between settlements.
// The refusal is LC001, it writes no row, and the purchase is admitted again once the settlement
// is closed.
func TestClosingMaterialsBacklogKeepsTheFreeze(t *testing.T) {
	ctx, p := backlogFixture(t)
	buyUsed(t, ctx, p, "backlog-freeze-used-01", "NS60ZL", 2, "10.00", "20.00")
	closing := openSettlement(t, ctx, p, 2)
	sheet := strings.Join(materialSheet(t, ctx, p, closing), ",")
	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('backlog-freeze-used-02',2,30.00,30.00,0.00,2)`)
	execRefusalMessage(t, err, "LC001", "open account settlement")
	// The refusal wrote nothing: neither the document nor a row of the live sheet moved.
	if got := countRows(t, ctx, p, `SELECT count(*) FROM purchases WHERE location_id=2`); got != 1 {
		t.Fatalf("a purchase refused by the freeze must write nothing, got %d documents", got)
	}
	if got := strings.Join(materialSheet(t, ctx, p, closing), ","); got != sheet {
		t.Fatalf("a refused purchase must leave the live sheet as it was, got %v want %v", got, sheet)
	}
	// The freeze is exactly the live settlement: the same document is admitted once it is closed,
	// and the two units the branch already delivered are not part of the next backlog.
	closeBacklogSettlement(t, ctx, p, closing, map[string]string{"NS60ZL": "2"})
	buyUsed(t, ctx, p, "backlog-freeze-used-02", "NS60ZL", 3, "10.00", "30.00")
	next := openSettlement(t, ctx, p, 2)
	if got := materialSheet(t, ctx, p, next); strings.Join(got, ",") != "used:NS60ZL:3.000:-" {
		t.Fatalf("a purchase after the closure is part of the next backlog, got %v", got)
	}
	t.Logf("047: LC001 still refuses a purchase while the settlement is live")
}
