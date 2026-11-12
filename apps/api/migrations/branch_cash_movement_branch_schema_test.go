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

// migration038 closes the one hole the branch cash ledger of 035 left open: a branch expense
// belongs to a branch, and the warehouse has no till. 035 admits a 'gasto' by comparing the
// account that records it with the branch the row names, so a hand-written row that names the
// warehouse and is signed by a warehouse account agreed with itself and was accepted -- the
// store refuses it before the insert, the database did not.
//
// It is add-only, like every version of the vertical: 001-037 are applied and checksummed, so
// 035's admission is not rewritten and the missing half of the same fact arrives as a second
// row-level trigger, named to fire after it.
const branchExpenseMigration = "038_branch_cash_movement_branch.sql"

// TestBranchCashMovementBranchSchemaStructure reads the embedded migration exactly as
// PostgreSQL receives it and asserts the contract it installs: one guard, its own code, a
// message that names the location, and no rewrite of any applied version, of any other table
// or of any refusal 035 already produces.
func TestBranchCashMovementBranchSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(branchExpenseMigration)
	if err != nil {
		t.Fatal("the branch expense migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The guard and its wiring: a row-level trigger on the ledger, before the insert can
		// leave a fact behind.
		"CREATE FUNCTION admit_branch_expense() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_branch_expense BEFORE INSERT ON branch_cash_movements",
		"FOR EACH ROW EXECUTE FUNCTION admit_branch_expense();",

		// The fact it states, in the schema's own terms: an expense names a branch, and the
		// warehouse is location 1 -- which is how 034 refuses to settle it and to configure a
		// commission for it, and how 025 and 032 refuse to sell from it and buy at it.
		"IF NEW.kind = 'gasto' AND NEW.branch_location_id = 1 THEN",
		"ERRCODE='LC024'",
		"MESSAGE='Location ' || NEW.branch_location_id",
		"|| ' is the warehouse: an expense belongs to a branch'",
		"RETURN NEW;",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// One guard and nothing else: a second function or trigger would mean the ledger gained a
	// second owner, and a table would make this migration a reshape instead of a refusal.
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 1 {
		t.Errorf("the branch expense migration must install one function, got %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 1 {
		t.Errorf("the branch expense migration must install one trigger, got %d", got)
	}
	if strings.Contains(sql, "CREATE TABLE") {
		t.Error("the branch expense migration must add no table")
	}
	// PostgreSQL fires the BEFORE ROW triggers of one table in name order: this guard has to
	// sort after 035's admission, so every refusal that version already produces -- the
	// branch's own expense, another branch's row, a frozen branch -- keeps its own code and its
	// own message, and only the row no existing rule answered is refused here.
	if !("admit_branch_cash_movement" < "admit_branch_expense") {
		t.Error("the expense guard must fire after the admission of 035")
	}
	// The guard is one more refusal of the ledger and no other: it raises its own code and
	// never restates one that belongs to 034-037.
	for _, code := range []string{
		"LC001", "LC002", "LC003", "LC004", "LC005", "LC006", "LC007", "LC008", "LC009",
		"LC010", "LC011", "LC012", "LC013", "LC014", "LC015", "LC016", "LC017", "LC018",
		"LC019", "LC020", "LC021", "LC022", "LC023",
	} {
		if strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("the refusal %s belongs to 034-037", code)
		}
	}
	// Additive only: no applied version, table or function is rewritten, and the guard reads
	// nothing but the row it is about to admit -- the branch identity is in the row itself, so
	// a query here would only add a way for the fact to disagree with itself.
	for _, forbidden := range []string{
		"CREATE OR REPLACE", "ALTER TABLE", "DROP ", "DISABLE TRIGGER",
		"UPDATE branch_cash_movements", "DELETE FROM", "TRUNCATE ", "INSERT INTO",
		"SELECT ", "FROM ",
		"assert_branch_not_frozen(", "branch_closure_blocker",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the branch expense migration must be one additive refusal: %s", forbidden)
		}
	}
	// The migration states the two decisions a reader has to be able to check without deriving
	// them from the trigger: which location is the warehouse, and whether the settlement's own
	// transfers need the same refusal.
	for _, documented := range []string{
		"S12", "L26", "admit_branch_cash_movement", "LC011", "LC020", "LC002",
		"aporte", "recaudacion", "no till", "034", "035",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
}

// branchExpenseFixture is the settlement block applied through 038: the prefix catalogue, one
// account per location, the two balances the count sheet of branch 2 photographs and its
// commission rate, so the settlement around the ledger can open, be proposed and close.
func branchExpenseFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 38)
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

// tryExpense writes one movement of the cash ledger as a caller would: the branch the row
// names, the amount, the description and the account that records it. It returns the error
// instead of asserting, so the same call is used where the row must be admitted and where it
// must be refused.
func tryExpense(ctx context.Context, p *pgxpool.Pool, branch, account int, kind, amount, description string) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1::smallint,$2,$3::numeric,$4,$5::integer)`,
		branch, kind, amount, description, account)
	return err
}

// cashLedger is the whole ledger as one value, so "writes nothing" is one comparison instead
// of a promise about a row.
func cashLedger(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var ledger string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(branch_location_id||':'
         ||coalesce(closing_id::text,'-')||':'||kind||':'||amount||':'||description||':'
         ||created_by_account_id,',' ORDER BY id),'') FROM branch_cash_movements`).Scan(&ledger); err != nil {
		t.Fatal("the cash ledger could not be read")
	}
	return ledger
}

// TestBranchCashMovementExpenseBelongsToABranch proves S12 on a live database: the branch
// records its own expense, the warehouse is refused with its own code naming the location and
// writes nothing, every refusal 035 already produced keeps its code, and the settlement's own
// transfers are untouched by the new guard.
func TestBranchCashMovementExpenseBelongsToABranch(t *testing.T) {
	ctx, p := branchExpenseFixture(t)

	// A branch records a small expense as it happens: no approval, and no settlement of its own
	// -- the settlement that covers it is the one whose window contains its instant.
	if err := tryExpense(ctx, p, 2, 2, "gasto", "15.00", "Flete"); err != nil {
		t.Fatalf("a branch must record its own expense: %v", err)
	}
	var expense string
	if err := p.QueryRow(ctx, `SELECT kind||':'||amount||':'||description||':'||(closing_id IS NULL)::text
 FROM branch_cash_movements WHERE branch_location_id=2`).Scan(&expense); err != nil ||
		expense != "gasto:15.00:Flete:true" {
		t.Fatalf("a branch expense belongs to no settlement: %q %v", expense, err)
	}
	before := cashLedger(t, ctx, p)

	// The warehouse has no till. The row that names it is signed by a warehouse account, so the
	// comparison of 035 agrees with itself -- and the expense would be money out of a till that
	// does not exist. The refusal names the location and writes nothing at all.
	if err := tryExpense(ctx, p, 1, 1, "gasto", "15.00", "Flete"); err == nil {
		t.Fatal("the warehouse has no till: it must not record an expense")
	} else {
		execRefusalMessage(t, err, "LC024", "Location 1")
	}
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused expense must write nothing, got %s before %s", after, before)
	}

	// Every refusal 035 already produced keeps its own code and its own message: the guard of
	// this version only answers the row no existing rule answered.
	for _, refused := range []struct {
		name            string
		branch, account int
		message         string
	}{
		{"the warehouse recording over a branch", 2, 1, "Only the branch records its own expenses"},
		{"another branch recording over it", 2, 3, "Only the branch records its own expenses"},
		// The ledger's own admission answers first, because this version's trigger sorts after it:
		// a row naming the warehouse is still refused here by the rule that already refused it.
		{"an unknown account", 1, 99, "requires a known account"},
	} {
		err := tryExpense(ctx, p, refused.branch, refused.account, "gasto", "15.00", "Flete")
		if err == nil {
			t.Fatalf("%s must be refused", refused.name)
		}
		execRefusalMessage(t, err, "LC011", refused.message)
	}
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused expense must write nothing, got %s before %s", after, before)
	}

	// The freeze still answers first: while the branch is being settled it records no expense
	// (S3), and the new guard does not shadow that refusal with its own.
	closing := openSettlement(t, ctx, p, 2)
	err := tryExpense(ctx, p, 2, 2, "gasto", "15.00", "Flete")
	execRefusalMessage(t, err, "LC001", "open account settlement")
	// The warehouse's row is refused whatever the state of the branches is, because the fact it
	// states is about the location it names and not about a settlement.
	err = tryExpense(ctx, p, 1, 1, "gasto", "15.00", "Flete")
	execRefusalMessage(t, err, "LC024", "Location 1")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused expense must write nothing, got %s before %s", after, before)
	}

	// The settlement's transfers are unaffected: a contribution and a collection, written by the
	// closure with the descriptions of S10, exactly as they were before this migration.
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})
	closeSettlement(t, ctx, p, closing, "100.00", "20.00", "30.00")
	var transfers string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||description||':'
         ||created_by_account_id,',' ORDER BY id) FROM branch_cash_movements
 WHERE closing_id=$1`, closing).Scan(&transfers); err != nil ||
		transfers != "aporte:20.00:Aporte de fondo de la rendición:1,"+
			"recaudacion:90.00:Recaudación de la rendición:1" {
		t.Fatalf("the closure must write its two transfers as before: %q %v", transfers, err)
	}
	// The branch's expense is untouched by the closure, and the ledger of the whole test is the
	// expense plus the two transfers -- nothing else was written.
	var rows int
	var kept string
	if err := p.QueryRow(ctx, `SELECT count(*), coalesce(string_agg(kind||':'||amount||':'
         ||description,',' ORDER BY id),'') FROM branch_cash_movements WHERE branch_location_id=2`).
		Scan(&rows, &kept); err != nil || rows != 3 ||
		kept != "gasto:15.00:Flete,aporte:20.00:Aporte de fondo de la rendición,"+
			"recaudacion:90.00:Recaudación de la rendición" {
		t.Fatalf("the ledger must hold the expense and the two transfers only: %d %q %v",
			rows, kept, err)
	}
	closed := cashLedger(t, ctx, p)

	// The transfer kinds need no refusal of their own, and this is the evidence rather than an
	// opinion: no settlement of the warehouse can exist, so a transfer that names it has nothing
	// to belong to and 035 refuses it with its own code, before this guard could say anything.
	_, err = p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,
 commission_rate_percent,opened_by_account_id) VALUES(1,now(),0,1)`)
	execRefusal(t, err, "LC002")
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,closing_id,kind,
 amount,description,created_by_account_id) VALUES(1,$1,'aporte',10.00,'Aporte a mano',1)`, closing)
	execRefusalMessage(t, err, "LC011", "belongs to a proposed settlement of its own branch")
	if after := cashLedger(t, ctx, p); after != closed {
		t.Fatalf("a refused transfer must write nothing, got %s before %s", after, closed)
	}
	t.Logf("038: the warehouse records no expense, the branch does, and the settlement transfers are unchanged")
}
