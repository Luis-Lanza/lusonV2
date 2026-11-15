package migrations_test

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration045 is the material sheet (S7, S8, S9, S11): the register of what the purchase fund
// of a period bought -- used batteries in units per model and scrap in kilograms per material --
// counted at the cut against the purchases of the window, with the difference informed and the
// delivery derived. 001-044 are applied and checksummed, so this version adds its own table and
// its own guards instead of editing any of them.
const migration045 = "045_closing_materials.sql"

// TestClosingMaterialsMigrationShape reads the embedded migration exactly as PostgreSQL receives
// it. It proves the file does the three things it exists for -- the sheet as one table with two
// partial keys, the seed from the purchases of the window, and the guards of the count sheet's
// family -- and nothing else: no historical table rewritten, no row written.
func TestClosingMaterialsMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration045)
	if err != nil {
		t.Fatal("the material sheet migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The sheet: one row per key and settlement, with the unit as the kind.
		"CREATE TABLE closing_material_lines",
		"closing_id bigint NOT NULL REFERENCES branch_closings(id)",
		"kind text NOT NULL CHECK (kind IN ('used','scrap'))",
		"material_id smallint REFERENCES materials(id)",
		"expected_quantity numeric(12,3) NOT NULL CHECK (expected_quantity >= 0)",
		"counted_quantity numeric(12,3) CHECK (counted_quantity >= 0)",
		// Exactly one key per kind, whole units for a used line and three decimals for scrap.
		"CHECK ((kind = 'used' AND model IS NOT NULL AND material_id IS NULL)",
		"OR (kind = 'scrap' AND model IS NULL AND material_id IS NOT NULL))",
		"CHECK (kind <> 'used' OR expected_quantity = trunc(expected_quantity))",
		"CHECK (kind <> 'used' OR counted_quantity IS NULL",
		// The two partial unique indexes: one row per key and settlement.
		"CREATE UNIQUE INDEX closing_material_lines_used ON closing_material_lines(closing_id, model)",
		"WHERE kind = 'used';",
		"CREATE UNIQUE INDEX closing_material_lines_scrap",
		"ON closing_material_lines(closing_id, material_id) WHERE kind = 'scrap';",

		// The seed of the opening, from the purchases of its own window, counter-documents
		// included as they are stored and only a positive sum seeded (S7, S11).
		"CREATE FUNCTION seed_closing_material_lines() RETURNS trigger LANGUAGE plpgsql AS $$",
		"PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);",
		"JOIN purchase_used_lines used ON used.purchase_id = purchase.id",
		"JOIN purchase_scrap_lines scrap ON scrap.purchase_id = purchase.id",
		"WHERE purchase.location_id = NEW.branch_location_id",
		"AND purchase.created_at >= NEW.period_start AND purchase.created_at < NEW.cut_at",
		"GROUP BY used.model",
		"GROUP BY scrap.material_id",
		"HAVING sum(used.quantity) > 0;",
		"HAVING sum(scrap.kg) > 0;",
		"CREATE TRIGGER seed_closing_material_lines AFTER INSERT ON branch_closings",

		// The guards of the count sheet's family: writable only while the warehouse holds the
		// settlement, only the counted quantity moves, the expected is the database's, and a
		// line is never removed.
		"CREATE FUNCTION admit_closing_material_line() RETURNS trigger LANGUAGE plpgsql AS $$",
		"MESSAGE='Material lines are written while the warehouse holds the settlement'",
		"IF current_setting('luson.closing_material_seed', true) IS DISTINCT FROM NEW.closing_id::text",
		"OR pg_trigger_depth() < 2 THEN\n        NEW.expected_quantity := 0;",
		"CREATE FUNCTION guard_closing_material_line() RETURNS trigger LANGUAGE plpgsql AS $$",
		"MESSAGE='Only the counted quantity can change on a material line'",
		"CREATE FUNCTION guard_closing_material_line_removal() RETURNS trigger LANGUAGE plpgsql AS $$",
		"MESSAGE='A material line is counted, never removed'",
		"CREATE TRIGGER admit_closing_material_line BEFORE INSERT ON closing_material_lines",
		"CREATE TRIGGER guard_closing_material_line BEFORE UPDATE ON closing_material_lines",
		"CREATE TRIGGER protect_closing_material_lines BEFORE DELETE ON closing_material_lines",
		"CREATE TRIGGER protect_closing_material_lines_truncate BEFORE TRUNCATE ON closing_material_lines",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("045 must install %q", required)
		}
	}
	// One SQLSTATE, this version's own: the sheet of the materials is not the sheet of the stock,
	// and folding it into LC004 would let a client read the wrong document's refusal.
	if n := strings.Count(sql, "ERRCODE='LC025'"); n != 4 {
		t.Errorf("045 must raise its own LC025 for every refusal of the sheet, got %d", n)
	}
	for _, foreign := range []string{"LC004", "LC019", "LP006"} {
		if strings.Contains(sql, "ERRCODE='"+foreign+"'") {
			t.Errorf("045 must not mint or reuse %s", foreign)
		}
	}
	// Additive only: three functions and four triggers of its own, and no statement of an applied
	// migration is replaced or recreated.
	for _, count := range []struct {
		what string
		got  int
	}{{"CREATE FUNCTION", 4}, {"CREATE TRIGGER", 5}, {"CREATE TABLE", 1},
		{"CREATE OR REPLACE FUNCTION", 0}} {
		if got := strings.Count(sql, count.what); got != count.got {
			t.Errorf("045 must contain %d %q, got %d", count.got, count.what, got)
		}
	}
	for _, forbidden := range []string{
		"DROP ", "UPDATE closing", "DELETE FROM", "TRUNCATE closing", "ALTER TABLE",
		"CREATE TRIGGER seed_closing_count_lines",
		"ADD COLUMN",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("045 must not contain %q", forbidden)
		}
	}
	// The sheet is seeded after the stock sheet: PostgreSQL fires the AFTER row triggers of a
	// table in name order, so the count sheet of the branch is still seeded first.
	if "seed_closing_count_lines" >= "seed_closing_material_lines" {
		t.Error("the material sheet must be seeded after the count sheet")
	}
	// The file documents its own decisions, so the next reader does not have to derive them.
	for _, documented := range []string{
		"S7", "S8", "S9", "S11", "034", "043", "032", "LC004", "LC019", "LC020", "LC025",
		"checksum", "counter-document", "nullable", "delivered quantity",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("045 must document its own decision: %s", documented)
		}
	}
	// The table exists before the seed that writes it and before the guards that read it.
	table, seed, admit := strings.Index(sql, "CREATE TABLE closing_material_lines"),
		strings.Index(sql, "CREATE FUNCTION seed_closing_material_lines"),
		strings.Index(sql, "CREATE FUNCTION admit_closing_material_line")
	if table < 0 || seed < 0 || admit < 0 || !(table < seed && seed < admit) {
		t.Error("the sheet must exist before its seed, and the seed before its guard")
	}
}

// materialsFixture is the settlement block applied through 045: the prefix catalogue, one account
// per location, the stock of branch 2 and its commission rate, which is what a proposal needs.
func materialsFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 45)
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

// buyUsed registers one original purchase of branch 2 with a single used line of one model, paid
// in cash, exactly as the purchases vertical writes it.
func buyUsed(t *testing.T, ctx context.Context, p *pgxpool.Pool, key, model string, quantity int, price, total string) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the purchase transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,2,$2::numeric,$2::numeric,0.00,2) RETURNING id`, key, total).Scan(&id); err != nil {
		t.Fatalf("the purchase %s must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,$2,$3,$4::numeric)`, id, model, quantity, price); err != nil {
		t.Fatalf("the used line of %s must be admitted: %v", key, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the purchase %s must commit: %v", key, err)
	}
	return id
}

// buyScrap registers one original purchase of branch 2 with a single scrap line of one material,
// paid in cash.
func buyScrap(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, material int, kg, price, total string) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the purchase transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,2,$2::numeric,$2::numeric,0.00,2) RETURNING id`, key, total).Scan(&id); err != nil {
		t.Fatalf("the purchase %s must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,$2,$3::numeric,$4::numeric)`, id, material, kg, price); err != nil {
		t.Fatalf("the scrap line of %s must be admitted: %v", key, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the purchase %s must commit: %v", key, err)
	}
	return id
}

// reversePurchase registers the counter-document of one persisted purchase of branch 2 the way the
// purchases vertical writes it: the same lines with negated quantity and kg, the same prices, the
// negated amounts and a stated reason. It reads the original instead of restating it, so a test
// never mirrors a document by hand.
func reversePurchase(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, original int64) int64 {
	t.Helper()
	var total string
	if err := p.QueryRow(ctx, `SELECT total::text FROM purchases WHERE id=$1`, original).Scan(&total); err != nil {
		t.Fatalf("the original purchase %d could not be read: %v", original, err)
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the counter-document transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,
 reverses_purchase_id,reason,created_by_account_id)
 VALUES($1,2,-($2::numeric),-($2::numeric),0.00,$3,'pesaje mal tipeado',2) RETURNING id`,
		key, total, original).Scan(&id); err != nil {
		t.Fatalf("the counter-document %s must be admitted: %v", key, err)
	}
	rows, err := tx.Query(ctx, `SELECT model,quantity,unit_price::text FROM purchase_used_lines
 WHERE purchase_id=$1 ORDER BY model`, original)
	if err != nil {
		t.Fatal("the lines of the original could not be read")
	}
	type mirror struct {
		model    string
		quantity int64
		price    string
	}
	mirrors := make([]mirror, 0, 2)
	for rows.Next() {
		var line mirror
		if err := rows.Scan(&line.model, &line.quantity, &line.price); err != nil {
			t.Fatal("a line of the original could not be read")
		}
		mirrors = append(mirrors, line)
	}
	rows.Close()
	for _, line := range mirrors {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,$2,$3,$4::numeric)`, id, line.model, -line.quantity, line.price); err != nil {
			t.Fatalf("the mirrored line of %s must be admitted: %v", key, err)
		}
	}
	type weight struct {
		material int
		kg       string
		price    string
	}
	scraps := make([]weight, 0, 2)
	rows, err = tx.Query(ctx, `SELECT material_id,kg::text,price_per_kg::text FROM purchase_scrap_lines
 WHERE purchase_id=$1 ORDER BY material_id`, original)
	if err != nil {
		t.Fatal("the scrap lines of the original could not be read")
	}
	for rows.Next() {
		var line weight
		if err := rows.Scan(&line.material, &line.kg, &line.price); err != nil {
			t.Fatal("a scrap line of the original could not be read")
		}
		scraps = append(scraps, line)
	}
	rows.Close()
	for _, line := range scraps {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,$2,-($3::numeric),$4::numeric)`, id, line.material, line.kg, line.price); err != nil {
			t.Fatalf("the mirrored scrap line of %s must be admitted: %v", key, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the counter-document %s must commit: %v", key, err)
	}
	return id
}

// materialSheet reads the whole sheet of one settlement as "kind:key:expected:counted" rows in the
// order the database stores them, so one comparison proves the seed and its absence.
func materialSheet(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) []string {
	t.Helper()
	rows, err := p.Query(ctx, `SELECT kind||':'||coalesce(model,material_id::text)||':'
  ||expected_quantity::text||':'||coalesce(counted_quantity::text,'-')
 FROM closing_material_lines WHERE closing_id=$1
 ORDER BY (kind <> 'used'),model,material_id`, closing)
	if err != nil {
		t.Fatalf("the material sheet could not be read: %v", err)
	}
	defer rows.Close()
	sheet := make([]string, 0, 4)
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("a material line could not be read: %v", err)
		}
		sheet = append(sheet, line)
	}
	if rows.Err() != nil {
		t.Fatalf("the material sheet could not be read: %v", rows.Err())
	}
	return sheet
}

// earlierSettlement closes one settlement of branch 2 so that the purchases a test registers
// afterwards fall inside the window of the next one: the first settlement of a branch settles an
// empty period by construction (period_start equals cut_at), and a period is
// [previous closure, cut). It is the shape the store tests walk with closeFirstSettlement.
func earlierSettlement(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	closing := openSettlement(t, ctx, p, 2)
	closeSettlement(t, ctx, p, closing, "0.00", "0.00", "0.00")
	return closing
}

// TestClosingMaterialsSeedsThePurchasesOfThePeriod proves the seed on a live database (S7, S11):
// the expected quantity of a used line is the sum of the document's quantity per model and the
// expected weight of a scrap line is the sum of its kilos per material, over the purchases of the
// settlement's own window. Two documents of one model are one row, a counter-document subtracts
// from both sums, and a key the period did not buy at all -- the scrap it only returned -- gets no
// row. The counted quantity of every seeded line is pending, which blocks nothing.
func TestClosingMaterialsSeedsThePurchasesOfThePeriod(t *testing.T) {
	ctx, p := materialsFixture(t)
	earlierSettlement(t, ctx, p)
	first := buyUsed(t, ctx, p, "closing-materials-used-01", "NS60ZL", 4, "10.00", "40.00")
	buyUsed(t, ctx, p, "closing-materials-used-02", "NS60ZL", 3, "10.00", "30.00")
	buyUsed(t, ctx, p, "closing-materials-used-03", "12N6,5_3B", 2, "5.00", "10.00")
	// The counter-document of the first one returns its four units: NS60ZL nets 3.
	reversePurchase(t, ctx, p, "closing-materials-used-04", first)
	copper := buyScrap(t, ctx, p, "closing-materials-scrap-01", 1, "12.500", "2.00", "25.00")
	buyScrap(t, ctx, p, "closing-materials-scrap-02", 3, "4.250", "2.00", "8.50")
	// The copper is returned whole, so the period bought none of it.
	reversePurchase(t, ctx, p, "closing-materials-scrap-03", copper)

	closing := openSettlement(t, ctx, p, 2)
	// Two documents of one model are one line with their sum, the comma of the catalogue is a
	// model like any other, and the material the period only returned has no line at all.
	want := []string{"used:12N6,5_3B:2.000:-", "used:NS60ZL:3.000:-", "scrap:3:4.250:-"}
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the sheet must seed what the period bought, got %v want %v", got, want)
	}
	// The sheet of a settlement is its own: a second one seeds its own window, and the first one
	// keeps exactly the rows it was opened with.
	if got := countRows(t, ctx, p, `SELECT count(*) FROM closing_material_lines`); got != 3 {
		t.Fatalf("the seed must write one row per key, got %d", got)
	}
	t.Logf("045: NS60ZL 4+3-4 = 3, 12N6,5_3B = 2, Plomo 4.250 and Cobre 12.500-12.500 = no row")
}

// TestClosingMaterialsSheetIsFrozenWithTheSettlement proves the lifecycle half on a live database:
// the counted quantity is writable while the settlement is open and again after a rejection, and
// the sheet of a proposed or closed settlement never moves, with the same window the stock count
// sheet has (LC004, LC025).
func TestClosingMaterialsSheetIsFrozenWithTheSettlement(t *testing.T) {
	ctx, p := materialsFixture(t)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "closing-materials-freeze-01", "NS60ZL", 6, "10.00", "60.00")
	buyScrap(t, ctx, p, "closing-materials-freeze-02", 2, "8.000", "1.50", "12.00")
	closing := openSettlement(t, ctx, p, 2)

	// The warehouse counts what it found while the settlement is open: units and kilograms, and a
	// model the period did not buy, which the database admits with an expected of zero.
	if _, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=6
 WHERE closing_id=$1 AND kind='used'`, closing); err != nil {
		t.Fatalf("a used line must be countable while the settlement is open: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=7.250
 WHERE closing_id=$1 AND kind='scrap'`, closing); err != nil {
		t.Fatalf("a scrap line must be countable in kilograms: %v", err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity,counted_quantity)
 VALUES($1,'used','NS40ZL',99,2)`, closing); err != nil {
		t.Fatalf("a model the period did not buy must be countable: %v", err)
	}
	// The expected quantity is the database's and never the caller's promise: the line the caller
	// added states zero, because the period bought none of that model.
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") !=
		"used:NS40ZL:0.000:2.000,used:NS60ZL:6.000:6.000,scrap:2:8.000:7.250" {
		t.Fatalf("the counted sheet is not the one the warehouse stated: %v", got)
	}

	// Once proposed, the branch is deciding an offer that already carries this sheet: the counts
	// are frozen with it.
	proposeRound(t, ctx, p, closing, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 contributed_cash=0.00,closing_cash=0.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	_, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=1 WHERE closing_id=$1`, closing)
	execRefusalMessage(t, err, "LC025", "while the warehouse holds the settlement")
	// A rejection hands the settlement back, and with it the sheet.
	decideRound(t, ctx, p, closing, "rejected", "mal contada la chatarra")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not return to the warehouse: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=6
 WHERE closing_id=$1 AND model='NS60ZL'`, closing); err != nil {
		t.Fatalf("a rejected settlement must be countable again: %v", err)
	}
	// ...and the closure freezes it forever: exactly the offered sheet is the history the branch
	// signs, and the delivery is read from it.
	proposeRound(t, ctx, p, closing, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the second round could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	_, err = p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=0 WHERE closing_id=$1`, closing)
	execRefusalMessage(t, err, "LC025", "while the warehouse holds the settlement")
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") !=
		"used:NS40ZL:0.000:2.000,used:NS60ZL:6.000:6.000,scrap:2:8.000:7.250" {
		t.Fatalf("a closed settlement keeps exactly the sheet it signed: %v", got)
	}
	t.Logf("045: the sheet counts while the settlement is live and freezes once proposed")
}

// TestClosingMaterialsRefusesALossOrARewrite proves the other three guards on a live database: a
// material line is never removed -- not by DELETE and not by TRUNCATE -- its expected quantity and
// its key never move, and a count is never negative and never a fraction of a battery (S8).
func TestClosingMaterialsRefusesALossOrARewrite(t *testing.T) {
	ctx, p := materialsFixture(t)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "closing-materials-guard-01", "NS60ZL", 6, "10.00", "60.00")
	buyScrap(t, ctx, p, "closing-materials-guard-02", 4, "1.250", "8.00", "10.00")
	closing := openSettlement(t, ctx, p, 2)
	before := strings.Join(materialSheet(t, ctx, p, closing), ",")
	// A negative count is not a count, a fractional battery is not a battery, and scrap keeps its
	// three decimals: the row constraints refuse the first two and admit the third.
	if _, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=-1 WHERE closing_id=$1`, closing); err == nil {
		t.Fatal("a negative count must be refused")
	}
	var negative *pgconn.PgError
	_, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=-1 WHERE closing_id=$1`, closing)
	if !errors.As(err, &negative) || negative.Code != "23514" {
		t.Fatalf("a negative count is a row violation, got %v", err)
	}
	_, err = p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=1.5
 WHERE closing_id=$1 AND kind='used'`, closing)
	if !errors.As(err, &negative) || negative.Code != "23514" {
		t.Fatalf("a fractional unit count must be refused by the row, got %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_material_lines SET counted_quantity=0.125
 WHERE closing_id=$1 AND kind='scrap'`, closing); err != nil {
		t.Fatalf("scrap is counted in thousandths of a kilogram: %v", err)
	}
	counted := "used:NS60ZL:6.000:-,scrap:4:1.250:0.125"
	// The key and the expected quantity of a line are its identity: only the count moves.
	for _, statement := range []string{
		`UPDATE closing_material_lines SET expected_quantity=expected_quantity+1 WHERE closing_id=$1`,
		`UPDATE closing_material_lines SET model='OTRO' WHERE closing_id=$1 AND kind='used'`,
		`UPDATE closing_material_lines SET material_id=2 WHERE closing_id=$1 AND kind='scrap'`,
	} {
		_, err := p.Exec(ctx, statement, closing)
		execRefusalMessage(t, err, "LC025", "Only the counted quantity can change on a material line")
	}
	// A line is never removed: dropping it would hide the difference the warehouse has to inform.
	_, err = p.Exec(ctx, `DELETE FROM closing_material_lines WHERE closing_id=$1 AND kind='used'`, closing)
	execRefusalMessage(t, err, "LC025", "never removed")
	_, err = p.Exec(ctx, `TRUNCATE closing_material_lines`)
	execRefusalMessage(t, err, "LC025", "never removed")
	// Every refusal wrote nothing: the rows are still the seeded ones, with the one count above.
	if got := strings.Join(materialSheet(t, ctx, p, closing), ","); got != counted {
		t.Fatalf("a refused write must leave the sheet as it was, got %v want %v", got, counted)
	}
	if before == counted {
		t.Fatal("the counts above must have moved the sheet, or this test proves nothing")
	}
	t.Logf("045: a material line is counted, never negative, never fractional, never removed")
}

// TestClosingMaterialsSeedIsTheOnlyWriterOfTheExpected proves the provenance half of the guard on a
// live database: a caller that inserts a material line states no expected quantity -- the database
// writes its own zero, whatever the caller promised -- while the seed of the opening writes the sum
// of the purchases of its window. It is the same rule the closure's ledger rows prove in 035.
func TestClosingMaterialsSeedIsTheOnlyWriterOfTheExpected(t *testing.T) {
	ctx, p := materialsFixture(t)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "closing-materials-promise-01", "NS60ZL", 3, "10.00", "30.00")
	closing := openSettlement(t, ctx, p, 2)
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != "used:NS60ZL:3.000:-" {
		t.Fatalf("the seed must state what the period bought: %v", got)
	}
	// A caller that states an expected quantity gets the database's own zero: the expected is a
	// fact of the opening, not a promise a client can make (S7).
	if _, err := p.Exec(ctx, `INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity,counted_quantity)
 VALUES($1,'used','NS40ZL',999,1)`, closing); err != nil {
		t.Fatalf("the line could not be added: %v", err)
	}
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") !=
		"used:NS40ZL:0.000:1.000,used:NS60ZL:3.000:-" {
		t.Fatalf("a caller must never promise an expected quantity: %v", got)
	}
	// The marker of the seed is transaction local, so a caller cannot reach it: the same insert in a
	// transaction that names it writes the database's zero all the same, because the marker only
	// counts from inside the trigger of the opener.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('luson.closing_material_seed',$1,true)`,
		strconv.FormatInt(closing, 10)); err != nil {
		t.Fatalf("the marker could not be set for the test: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity,counted_quantity)
 VALUES($1,'used','NS50ZL',42,1)`, closing); err != nil {
		t.Fatalf("the line must be admitted: %v", err)
	}
	var promised string
	if err := tx.QueryRow(ctx, `SELECT expected_quantity::text FROM closing_material_lines
 WHERE closing_id=$1 AND model='NS50ZL'`, closing).Scan(&promised); err != nil || promised != "0.000" {
		t.Fatalf("a caller must never promise an expected quantity, got %q %v", promised, err)
	}
}

// TestClosingMaterialsAreOrderedAndKeyedOnce proves the two partial indexes on a live database: one
// row per model and settlement for the used lines, one row per material and settlement for the
// scrap ones, and no second row of either kind.
func TestClosingMaterialsAreOrderedAndKeyedOnce(t *testing.T) {
	ctx, p := materialsFixture(t)
	earlierSettlement(t, ctx, p)
	buyUsed(t, ctx, p, "closing-materials-key-01", "NS60ZL", 6, "10.00", "60.00")
	buyScrap(t, ctx, p, "closing-materials-key-02", 1, "2.000", "5.00", "10.00")
	closing := openSettlement(t, ctx, p, 2)
	for _, statement := range []string{
		`INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity) VALUES($1,'used','NS60ZL',1)`,
		`INSERT INTO closing_material_lines(closing_id,kind,material_id,expected_quantity) VALUES($1,'scrap',1,1)`,
	} {
		_, err := p.Exec(ctx, statement, closing)
		var unique *pgconn.PgError
		if !errors.As(err, &unique) || unique.Code != "23505" {
			t.Fatalf("a second row of the same key must be refused, got %v", err)
		}
	}
	// One key per kind: a used line names a model and a scrap line a material, and neither states
	// the other's key nor both.
	for _, statement := range []string{
		`INSERT INTO closing_material_lines(closing_id,kind,model,material_id,expected_quantity) VALUES($1,'used','NS60ZL',1,1)`,
		`INSERT INTO closing_material_lines(closing_id,kind,model,material_id,expected_quantity) VALUES($1,'scrap','NS60ZL',1,1)`,
		`INSERT INTO closing_material_lines(closing_id,kind,expected_quantity) VALUES($1,'used',1)`,
		`INSERT INTO closing_material_lines(closing_id,kind,expected_quantity) VALUES($1,'scrap',1)`,
		`INSERT INTO closing_material_lines(closing_id,kind,model,expected_quantity) VALUES($1,'battery','NS60ZL',1)`,
	} {
		_, err := p.Exec(ctx, statement, closing)
		var violation *pgconn.PgError
		if !errors.As(err, &violation) || violation.Code != "23514" {
			t.Fatalf("an impossible key must be refused by the row, got %v", err)
		}
	}
	var keys int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM closing_material_lines WHERE closing_id=$1`,
		closing).Scan(&keys); err != nil || keys != 2 {
		t.Fatalf("the refusals must leave exactly the seeded sheet, got %d %v", keys, err)
	}
}
