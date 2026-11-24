package migrations_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/migrations"
)

// The used battery has a real stock per location and per model (S24), and it is derived from the
// facts already registered: there is no balance row, no stored total and no second inventory (S18).
// This version states one function with the signed sum of every term, one correction of the
// settlement seed -- the factory returns the battery to the warehouse and never to the branch of
// the case (S27) -- and one refusal the loan needs (S25): an origin that does not hold the model
// cannot hand a unit over, and two loans never consume one battery.
const usedStockMigration = "071_used_battery_stock.sql"

// usedStock reads the derived stock of the whole installation as one comparable row per location
// and model: the five terms and their signed sum, in the order the function states them.
func usedStock(t *testing.T, ctx context.Context, p *pgxpool.Pool) []string {
	t.Helper()
	rows, err := p.Query(ctx, `SELECT location_id::text||':'||model||':'||purchased::text||':'
  ||factory_returns::text||':'||loans_returned::text||':'||delivered::text||':'
  ||loans_given::text||':'||available::text
 FROM used_battery_stock() ORDER BY location_id,model COLLATE "C"`)
	if err != nil {
		t.Fatalf("the used stock could not be read: %v", err)
	}
	defer rows.Close()
	stock := make([]string, 0, 4)
	for rows.Next() {
		var row string
		if err := rows.Scan(&row); err != nil {
			t.Fatalf("a used stock row could not be read: %v", err)
		}
		stock = append(stock, row)
	}
	if rows.Err() != nil {
		t.Fatalf("the used stock could not be read: %v", rows.Err())
	}
	return stock
}

// TestUsedBatteryStockShape reads the embedded version exactly as PostgreSQL receives it. It proves
// the file states the read of S24, corrects the seed of 066 so the factory return is the
// warehouse's (S27), installs the loan refusal of S25 with its own never-used code, and adds no
// table, no column, no balance and no money.
func TestUsedBatteryStockShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(usedStockMigration)
	if err != nil {
		t.Fatalf("the used stock migration must be embedded: %v", err)
	}
	code := withoutSQLComments(string(b))
	for _, required := range []string{
		// The read of S24: one function, the five terms of the two formulas and their signed sum.
		"CREATE FUNCTION used_battery_stock()",
		"RETURNS TABLE",
		"purchased",
		"factory_returns",
		"loans_returned",
		"delivered",
		"loans_given",
		"available",
		// The three facts it reads, and nothing else.
		"FROM purchase_used_lines line",
		"FROM warranty_case_loans loan",
		"FROM closing_material_lines sheet",
		"AND closing.status = 'closed'",
		"AND sheet.counted_quantity IS NOT NULL",
		// The factory return is the warehouse's (S27).
		"case_row.verdict = 'not_covered'",
		"case_row.reported_destination = 'stock'",
		// The loan refuses an origin without stock of the requested model (S25), with its own code
		// and under a lock that keeps two loans from consuming one unit.
		"CREATE FUNCTION admit_warranty_case_loan_stock()",
		"CREATE TRIGGER admit_warranty_case_loan_stock BEFORE INSERT ON warranty_case_loans",
		"ERRCODE='LW033'",
		"pg_advisory_xact_lock",
		// The settlement seed of 066 is corrected in the same version, not left disagreeing (S29).
		"CREATE OR REPLACE FUNCTION seed_closing_material_lines() RETURNS trigger",
		"PERFORM set_config('luson.closing_material_seed', NEW.id::text, true);",
	} {
		if !strings.Contains(code, required) {
			t.Errorf("071 must install %q", required)
		}
	}
	// The seed never attributes a factory return to the branch again: that is S27, and it is what
	// keeps the settlement's expectation and the new stock of the branch in agreement.
	seed := functionBlock(t, code, "seed_closing_material_lines")
	if strings.Contains(seed, "warranty_cases") {
		t.Errorf("the branch seed must not read a case any more (S27):\n%s", seed)
	}
	// The read is one aggregate: a per-row function call or a second query would be the N+1 the
	// vertical refuses.
	if got := strings.Count(code, "FROM used_battery_stock()"); got > 1 {
		t.Errorf("the stock read is one aggregate, got %d calls", got)
	}
	for _, forbidden := range []string{
		"CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX", "ALTER TABLE", "ADD COLUMN",
		"UPDATE ", "DELETE FROM", "TRUNCATE", "DROP ",
		// No balance of used batteries, no second inventory and no stock write (S18).
		"inventory_balances", "stock_adjustments", "stock_entries",
		// No sale document, no fund, no cash, no money for material and no transfer (S6, S28).
		"branch_cash", "branch_fund", "cash", "price", "amount", "sales", "transfer",
	} {
		if strings.Contains(code, forbidden) {
			t.Errorf("071 must not contain %q", forbidden)
		}
	}
	// The scrap half is still 047's, term for term: this version changes the pool of used batteries
	// and the weighed materials are not part of it.
	previous, err := migrations.Files.ReadFile(migration047)
	if err != nil {
		t.Fatal("the backlog migration must be embedded", err)
	}
	if got, want := scrapSeedBlock(t, string(b)), scrapSeedBlock(t, string(previous)); got != want {
		t.Fatalf("071 must leave the scrap sheet of 047 untouched:\n got %s\nwant %s", got, want)
	}
	// The file states its own decision where the next reader will look for it.
	for _, documented := range []string{
		"S24", "S25", "S26", "S27", "S28", "S29", "045", "065", "066", "LW033",
		"warehouse", "loan", "settlement",
	} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("071 must document its own decision: %s", documented)
		}
	}
}

// functionBlock is one function of the file, from its declaration to its own terminator, so a test
// can judge one function without the rest of the version.
func functionBlock(t *testing.T, code, name string) string {
	t.Helper()
	from := strings.Index(code, "FUNCTION "+name+"()")
	if from < 0 {
		t.Fatalf("%s must declare %s", usedStockMigration, name)
	}
	length := strings.Index(code[from:], "$$;")
	if length < 0 {
		t.Fatalf("%s must terminate %s", usedStockMigration, name)
	}
	return code[from : from+length]
}

// TestUsedBatteryStockDerivesEveryTermOfTheFormula proves S24, S26, S27 and S29 on a live database:
// a branch that bought nothing and had nothing returned states zero, a closed settlement sums the
// same quantity to the warehouse and subtracts it from the branch, a returned loan gives the
// battery back to the location that lent it, a factory return enters the warehouse and never the
// branch of the case -- and the expectation the settlement seeded is exactly the stock the new read
// states at that cut.
func TestUsedBatteryStockDerivesEveryTermOfTheFormula(t *testing.T) {
	ctx, p := usedPoolFixture(t, 71)
	earlierSettlement(t, ctx, p)
	// A branch with no purchase and no factory return holds nothing: the read states no row at all
	// for branch 3, which is the zero of S24 and not a promise.
	if got := usedStock(t, ctx, p); len(got) != 0 {
		t.Fatalf("a branch with no purchase and no return holds zero, got %v", got)
	}
	// Branch 2 buys four NS60ZL and lends two of them on a finding of its own (S5, S6).
	buyUsed(t, ctx, p, "used-stock-buy-01", "NS60ZL", 4, "10.00", "40.00")
	claim := usedStockDefect(t, ctx, p, 2, 1, 1, 2)
	warrantyLend(t, ctx, p, claim, "NS60ZL", 1, "", 2, 2)
	warrantyLend(t, ctx, p, claim, "NS60ZL", 1, "", 2, 2)
	// The factory refuses one damaged battery and sends it back to the used pool: it is the
	// warehouse's, which is who shipped it and who receives it (S11, S27).
	refused := usedStockDefect(t, ctx, p, 2, 1, 1, 2)
	resolveCase(t, ctx, p, refused, "not_covered", "stock", "customer")
	// The client brings one of the two lent batteries back: it is in the branch again, and the
	// location that lent it is the one that gets it back.
	settleLoan(t, ctx, p, claim, 1, "returned")
	want := []string{
		"1:NP7-12:0:1:0:0:0:1",
		"2:NS60ZL:4:0:1:0:2:3",
	}
	if got := usedStock(t, ctx, p); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the stock is the signed sum of every term, got %v want %v", got, want)
	}
	// The settlement of the branch states the same pool, and the factory return is not a line of
	// it: the expectation and the stock of the branch never disagree (S27, S29).
	closing := openSettlement(t, ctx, p, 2)
	signed := "used:NS60ZL:3.000:-"
	if got := materialSheet(t, ctx, p, closing); strings.Join(got, ",") != signed {
		t.Fatalf("the sheet states the pool of its own cut: got %v want %v", got, signed)
	}
	if got := usedStock(t, ctx, p); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the expectation is the stock at the cut, got %v want %v", got, want)
	}
	// The branch delivers everything it holds in the closure: the same three units sum to the
	// warehouse and are subtracted from the branch, and the branch holds zero (S24, S29).
	closeBacklogSettlement(t, ctx, p, closing, map[string]string{"NS60ZL": "3"})
	want = []string{
		"1:NP7-12:0:1:0:0:0:1",
		"1:NS60ZL:0:0:0:3:0:3",
		"2:NS60ZL:4:0:1:3:2:0",
	}
	if got := usedStock(t, ctx, p); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("a closed settlement moves the quantity between the two rows: got %v want %v",
			got, want)
	}
	t.Logf("071: 4 bought + 1 returned - 2 lent = 3 delivered by the closing, and the branch holds 0")
}

// usedStockDefect opens a finding of the branch's own shelf with the motive 067 requires, so the
// units leave the branch's balance exactly as the vertical admits them.
func usedStockDefect(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, variant int,
	quantity int64, account int) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,
 quantity,declared_failure,reason,created_by_account_id)
 VALUES($1,'stock_defect',$2,$3,'No retiene carga','Probada en mostrador',$4) RETURNING id`,
		branch, variant, quantity, account).Scan(&id); err != nil {
		t.Fatalf("the finding of branch %d must be admitted: %v", branch, err)
	}
	return id
}

// TestUsedBatteryStockRefusesALoanItsOriginCannotCover proves S25 on a live database: an origin that
// does not hold the requested model refuses the loan with its own code and writes nothing, and two
// loans never consume one unit.
func TestUsedBatteryStockRefusesALoanItsOriginCannotCover(t *testing.T) {
	ctx, p := usedPoolFixture(t, 71)
	buyUsed(t, ctx, p, "used-stock-loan-01", "NS60ZL", 1, "10.00", "10.00")
	claim := usedStockDefect(t, ctx, p, 2, 1, 1, 2)
	// The one unit the branch holds leaves in the hands of the client: the branch holds zero.
	if ordinal := warrantyLend(t, ctx, p, claim, "NS60ZL", 1, "", 2, 2); ordinal != 1 {
		t.Fatalf("the loan of the unit the branch holds must be admitted, got %d", ordinal)
	}
	if got := usedStock(t, ctx, p); strings.Join(got, ",") != "2:NS60ZL:1:0:0:0:1:0" {
		t.Fatalf("the loan of the only unit leaves the branch at zero, got %v", got)
	}
	// A second loan of the same model from the same origin cannot consume the unit twice, and the
	// warehouse holds nothing at all: both are refused with the code of this fact.
	for _, refused := range []struct {
		source int
		model  string
	}{{2, "NS60ZL"}, {1, "NP7-12"}, {2, "NS40ZL"}} {
		_, err := p.Exec(ctx, lendSQL, claim, refused.model, 1, "", refused.source, 2)
		execRefusalMessage(t, err, "LW033",
			"A loan of a used battery requires stock of its model in its origin")
	}
	if got := countRows(t, ctx, p, `SELECT count(*) FROM warranty_case_loans`); got != 1 {
		t.Fatalf("a refused loan writes nothing: %d loans", got)
	}
	// The same unit is still the branch's only one: nothing was consumed by the refusals either.
	if got := usedStock(t, ctx, p); strings.Join(got, ",") != "2:NS60ZL:1:0:0:0:1:0" {
		t.Fatalf("a refused loan moves no stock, got %v", got)
	}
	t.Logf("071: LW033 refuses the second loan of one unit and the loan of a location that holds none")
}

// seedFunctionSQL is the seed function of a version and nothing else, so a differential test can
// install one version's seed over another's without reinstalling the triggers and the read it also
// carries.
func seedFunctionSQL(t *testing.T, sql string) string {
	t.Helper()
	cut := strings.Index(sql, "$$;")
	if cut < 0 {
		t.Fatal("the migration must terminate its first function")
	}
	return sql[:cut+len("$$;")]
}

// TestClosingMaterialsSeedKeepsEveryTermButTheFactoryReturn is the differential check of the one
// shared function this version rewrites: the same facts seed exactly the same sheet under 066 and
// under 071, and the only difference is the factory return, which 066 attributed to the branch of the
// case and 071 attributes to the warehouse that shipped and received the battery (S27, S29).
func TestClosingMaterialsSeedKeepsEveryTermButTheFactoryReturn(t *testing.T) {
	ctx, p := usedPoolFixture(t, 71)
	buyUsed(t, ctx, p, "used-stock-diff-0001", "NS60ZL", 4, "10.00", "40.00")
	// The first settlement is seeded by 071 and the second by 066, installed over it by hand on the
	// same database that already holds both: a branch with no factory return is the same sheet.
	seeded := openSettlement(t, ctx, p, 2)
	byStock := materialSheet(t, ctx, p, seeded)
	closeBacklogSettlement(t, ctx, p, seeded, map[string]string{"NS60ZL": "0"})
	previous, err := migrations.Files.ReadFile(usedPoolMigration)
	if err != nil {
		t.Fatal("the used pool migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(previous)); err != nil {
		t.Fatalf("066 must apply over 071: %v", err)
	}
	under066 := openSettlement(t, ctx, p, 2)
	byPool := materialSheet(t, ctx, p, under066)
	if strings.Join(byStock, ",") != strings.Join(byPool, ",") {
		t.Fatalf("the correction changes no other term: 071 %v 066 %v", byStock, byPool)
	}
	if want := "used:NS60ZL:4.000:-"; strings.Join(byStock, ",") != want {
		t.Fatalf("a branch with no factory return states its purchases, got %v want %s", byStock, want)
	}
	// ...and the one term that does change: the factory refuses a battery and sends it back, and the
	// sheet of the branch of the case states it under 066 and never under 071.
	closeBacklogSettlement(t, ctx, p, under066, nil)
	refused := usedStockDefect(t, ctx, p, 2, 1, 1, 2)
	resolveCase(t, ctx, p, refused, "not_covered", "stock", "customer")
	current, err := migrations.Files.ReadFile(usedStockMigration)
	if err != nil {
		t.Fatal("the used stock migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, seedFunctionSQL(t, string(current))); err != nil {
		t.Fatalf("071 must apply over 066: %v", err)
	}
	under071 := openSettlement(t, ctx, p, 2)
	if got := materialSheet(t, ctx, p, under071); strings.Join(got, ",") != "used:NS60ZL:4.000:-" {
		t.Fatalf("071 states the factory return in the warehouse and not in the branch, got %v", got)
	}
	closeBacklogSettlement(t, ctx, p, under071, nil)
	if _, err := p.Exec(ctx, string(previous)); err != nil {
		t.Fatalf("066 must apply over 071 again: %v", err)
	}
	if got := materialSheet(t, ctx, p, openSettlement(t, ctx, p, 2)); strings.Join(got, ",") !=
		"used:NP7-12:1.000:-,used:NS60ZL:4.000:-" {
		t.Fatalf("066 attributed the factory return to the branch, got %v", got)
	}
	// The stock of the two versions is the same fact in the two places: the warehouse holds it and
	// the branch of the case holds none of it (S27).
	if got := usedStock(t, ctx, p); strings.Join(got, ",") !=
		"1:NP7-12:0:1:0:0:0:1,2:NS60ZL:4:0:0:0:0:4" {
		t.Fatalf("the factory return is the warehouse's, got %v", got)
	}
}
