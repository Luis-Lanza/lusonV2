package migrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/migrations"
)

// migration054 is the missing door of the vertical: a branch that already exists receives its two
// funds -- the drawer's operating cash and the purchase fund -- from the warehouse, as the two
// aportes of the two books. The act has the shape of a view whose trigger writes them, so the
// provenance is the marker plus the depth only a trigger reaches (035, 052): the founding's marker
// proves a branch that is being born (048, 049), and this act happens on a branch that already
// exists.
const loadBranchFundsMigration = "054_load_branch_funds.sql"

// TestLoadBranchFundsSchemaStructure reads the embedded migration exactly as PostgreSQL receives it
// and asserts the contract it installs and the ones it must not break: the act, its one guard, the
// two admissions restated whole with the load's path in them, and the name the administration calls.
func TestLoadBranchFundsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(loadBranchFundsMigration)
	if err != nil {
		t.Fatal("the load migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The act: one row of a view, no table and no column of its own.
		"CREATE VIEW branch_fund_load AS",
		"CREATE TRIGGER write_branch_fund_load INSTEAD OF INSERT ON branch_fund_load",
		"CREATE FUNCTION write_branch_fund_load() RETURNS trigger LANGUAGE plpgsql AS $$",
		// Its rules, in one place for the act and the two books.
		"CREATE FUNCTION assert_load_of_branch_funds(branch smallint, account integer) RETURNS void",
		"MESSAGE='The load of the funds of a branch states its opening cash and its purchase fund'",
		"MESSAGE='The load of the funds of a branch is never negative'",
		"MESSAGE='Only the warehouse loads the funds of a branch'",
		"MESSAGE='The load of funds states a live branch'",
		"PERFORM assert_branch_not_frozen(branch);",
		"IF NEW.opening_cash = 0 AND NEW.purchase_fund = 0 THEN",
		"PERFORM set_config('luson.branch_funds', NEW.branch_location_id::text, true);",
		"PERFORM set_config('luson.branch_funds', '', true);",
		// The name the administration calls, revoked from PUBLIC like the founding.
		"CREATE FUNCTION load_branch_funds(branch_location_id smallint, opening_cash numeric,",
		"purchase_fund numeric, actor_account_id integer) RETURNS void LANGUAGE plpgsql AS $$",
		"REVOKE ALL ON FUNCTION load_branch_funds(smallint,numeric,numeric,integer) FROM PUBLIC;",
		// The two admissions, restated whole with the load's path added and every other rule kept.
		"CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE OR REPLACE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"load_funds text := nullif(current_setting('luson.branch_funds', true), '');",
		"MESSAGE='The load of funds writes no movement of another branch'",
		"MESSAGE='A load of funds is written by the act that states it'",
		"IF pg_trigger_depth() < 2 THEN",
		"PERFORM assert_load_of_branch_funds(NEW.branch_location_id, NEW.created_by_account_id);",
		// ... and the rules of the drawer's admission (046, 048) that must survive the restatement ...
		"MESSAGE='Only the warehouse moves the money of a settlement'",
		"MESSAGE='A settlement states its transfer once'",
		"MESSAGE='The opening contribution of a branch is written by the transaction that creates it'",
		"MESSAGE='Only the branch records its own cash movements'",
		"MESSAGE='A movement of a settled period is corrected in the settlement'",
		"MESSAGE='A correction never exceeds the movement it corrects'",
		// ... and of the fund's (048, 051, 052, 053).
		"MESSAGE='Only the closing of a settlement takes money out of the fund'",
		"MESSAGE='A movement of the period belongs to no settlement'",
		"MESSAGE='The opening of a fund is written by the transaction that creates its branch'",
		"MESSAGE='The opening of a fund states its last closed settlement'",
		"MESSAGE='Only the branch records its own fund movements'",
		"MESSAGE='The purchase fund never goes negative: '",
		"effect := branch_fund_effective(NEW.kind, NEW.amount, CASE WHEN NEW.kind = 'correccion' THEN corrected.kind END,",
		"PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);",
		"COMMENT ON FUNCTION load_branch_funds(smallint,numeric,numeric,integer) IS",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("054 must state %q", required)
		}
	}
	// Two admissions are replaced and three functions are created -- the shared guard, the act and the
	// name of the administration -- and nothing else.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 2 {
		t.Errorf("054 restates the two admissions and nothing else, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 3 {
		t.Errorf("054 creates the guard, the act and its name, got %d", got)
	}
	// It writes no row of another book, adds no table and rewrites no applied version.
	for _, forbidden := range []string{
		"CREATE TABLE", "ALTER TABLE", "DROP FUNCTION", "DROP TABLE", "DROP VIEW",
		"UPDATE branch_", "DELETE FROM", "TRUNCATE",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("054 adds no table and writes no row of another book: it must not use %q", forbidden)
		}
	}
	for _, once := range []string{
		"INSERT INTO branch_cash_movements(branch_location_id, kind, amount, description,",
		"INSERT INTO branch_fund_movements(branch_location_id, kind, amount, description,",
	} {
		if got := strings.Count(sql, once); got != 1 {
			t.Errorf("the load states %q exactly once, got %d", once, got)
		}
	}
	// The decisions a reader has to be able to check without deriving them.
	for _, documented := range []string{
		"S1", "S3", "S4", "S5", "S6", "S9", "035", "048", "052", "053",
		"luson.branch_funds", "luson.closing_fund", "pg_trigger_depth", "340251",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("054 must document its own decision: %s", documented)
		}
	}
}

// loadFundsFixture is the prefix applied through 054: the catalogue, one account per historical
// location -- account 1 is the warehouse, accounts 2 and 3 the two branches -- the initialization row
// the founding reads and the commission rate branch 2 needs to be settled.
func loadFundsFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 54)
}

// tryLoadFunds states a load through the function the administration calls and returns the error
// instead of asserting, so the same call is used where the act must be admitted and where it must not.
func tryLoadFunds(ctx context.Context, p *pgxpool.Pool, branch int, cash, fund string, actor int) error {
	_, err := p.Exec(ctx, `SELECT load_branch_funds($1::smallint,$2::numeric,$3::numeric,$4::integer)`,
		branch, cash, fund, actor)
	return err
}

// loadFunds states a load every call of which must be admitted.
func loadFunds(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int, cash, fund string, actor int) {
	t.Helper()
	if err := tryLoadFunds(ctx, p, branch, cash, fund, actor); err != nil {
		t.Fatalf("the load of branch %d must be admitted: %v", branch, err)
	}
}

// tryCashMovement writes one movement of a branch's own drawer as a caller would.
func tryCashMovement(ctx context.Context, p *pgxpool.Pool, branch, account int, kind, amount, description string) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1::smallint,$2,$3::numeric,$4,$5::integer)`,
		branch, kind, amount, description, account)
	return err
}

// bookOf reads one book of one branch as one value, so "writes nothing" and "writes these two rows"
// are one comparison each.
func bookOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, branch int) string {
	t.Helper()
	var book string
	if err := p.QueryRow(ctx, query, branch).Scan(&book); err != nil {
		t.Fatalf("the book of branch %d could not be read: %v", branch, err)
	}
	return book
}

const branchDrawerQuery = `SELECT coalesce(string_agg(kind||':'||amount::text||':'
 ||created_by_account_id,',' ORDER BY id),'')
 FROM branch_cash_movements WHERE branch_location_id=$1`

const branchFundQuery = `SELECT coalesce(string_agg(kind||':'||amount::text||':'
 ||created_by_account_id,',' ORDER BY id),'')
 FROM branch_fund_movements WHERE branch_location_id=$1`

const branchDrawerEffectQuery = `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
 FROM branch_cash_ledger WHERE branch_location_id=$1 AND closing_id IS NULL`

// allRows counts every row of the two books: a refused or empty act leaves nothing at all behind.
func allRows(t *testing.T, ctx context.Context, p *pgxpool.Pool) (drawer, fund int) {
	t.Helper()
	if err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM branch_cash_movements),
       (SELECT count(*) FROM branch_fund_movements)`).Scan(&drawer, &fund); err != nil {
		t.Fatal("the rows of the two books could not be counted")
	}
	return drawer, fund
}

// TestLoadBranchFundsWritesBothAportesOfTheWarehouse proves S1, S3, S4 and S6 on a live database: the
// warehouse states the two amounts of a branch that already exists and the two books receive one
// `aporte` each, signed by the warehouse, with the amount it stated; the branch keeps operating
// afterwards, because a load is not a settlement.
func TestLoadBranchFundsWritesBothAportesOfTheWarehouse(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	loadFunds(t, ctx, p, 2, "5000.00", "3000.00", 1)

	if drawer := bookOf(t, ctx, p, branchDrawerQuery, 2); drawer != "aporte:5000.00:1" {
		t.Fatalf("the drawer receives an aporte of 5000.00 signed by the warehouse, got %q", drawer)
	}
	if fund := bookOf(t, ctx, p, branchFundQuery, 2); fund != "aporte:3000.00:1" {
		t.Fatalf("the fund receives an aporte of 3000.00 signed by the warehouse, got %q", fund)
	}
	// The two balances are the two amounts (S7): the fund is the signed sum of its view, and the
	// drawer's expected cash is its book's effect on top of what it inherited.
	if balance := fundBalance(t, ctx, p, 2); balance != "3000.00" {
		t.Fatalf("the fund of the branch is the amount it was loaded with, got %s", balance)
	}
	if effect := bookOf(t, ctx, p, branchDrawerEffectQuery, 2); effect != "5000.00" {
		t.Fatalf("the drawer of the branch is the amount it was loaded with, got %s", effect)
	}
	// S6: the load freezes nothing and the branch keeps operating. Its own account still records its
	// own movement, and the drawer keeps the money it was given.
	if blocker := bookOf(t, ctx, p, `SELECT branch_closure_blocker($1::smallint)::text`, 2); blocker != "false" {
		t.Fatalf("a load must not freeze the branch, got %q", blocker)
	}
	if err := tryCashMovement(ctx, p, 2, 2, "gasto", "100.00", "Gasto despues de la carga"); err != nil {
		t.Fatalf("the branch must keep operating after a load: %v", err)
	}
	if effect := bookOf(t, ctx, p, branchDrawerEffectQuery, 2); effect != "4900.00" {
		t.Fatalf("the drawer is the load minus what the branch spent, got %s", effect)
	}
}

// TestLoadBranchFundsWritesNothingForZero proves S9 and S2 on a live database: 0,00 on both sides is
// a stated answer and not a missing one, so it is admitted and it writes no movement. One side of 0,00
// is also a stated answer: the other book receives its own amount.
func TestLoadBranchFundsWritesNothingForZero(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	loadFunds(t, ctx, p, 2, "0.00", "0.00", 1)
	if drawer, fund := allRows(t, ctx, p); drawer != 0 || fund != 0 {
		t.Fatalf("a load of 0,00 writes nothing, got %d/%d rows", drawer, fund)
	}
	loadFunds(t, ctx, p, 2, "0.00", "300.00", 1)
	if drawer := bookOf(t, ctx, p, branchDrawerQuery, 2); drawer != "" {
		t.Fatalf("a load of 0,00 of the drawer writes no movement of it, got %q", drawer)
	}
	if fund := bookOf(t, ctx, p, branchFundQuery, 2); fund != "aporte:300.00:1" {
		t.Fatalf("the fund receives the amount that was stated, got %q", fund)
	}
}

// TestLoadBranchFundsRefusesAnAccountOfABranch proves S4 on a live database: a branch account is not
// the warehouse, so it loads neither into its own branch nor into another one, and the refusal writes
// nothing at all. The warehouse itself is not a branch either.
func TestLoadBranchFundsRefusesAnAccountOfABranch(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	for _, target := range []int{2, 3} {
		for _, actor := range []int{2, 3} {
			err := tryLoadFunds(ctx, p, target, "500.00", "300.00", actor)
			execRefusalMessage(t, err, "LG001", "Only the warehouse loads the funds of a branch")
		}
	}
	execRefusalMessage(t, tryLoadFunds(ctx, p, 1, "500.00", "300.00", 1), "LG002",
		"The load of funds states a live branch")
	if drawer, fund := allRows(t, ctx, p); drawer != 0 || fund != 0 {
		t.Fatalf("a refused load writes nothing, got %d/%d rows", drawer, fund)
	}
}

// TestLoadBranchFundsRefusesARetiredBranch proves S4 on a live database: a branch that was given up
// is not a place to put money in, and the refusal writes nothing.
func TestLoadBranchFundsRefusesARetiredBranch(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	// A branch is only retired with no users and no stock, so its account goes first: the refusal
	// under test is the load's and not the retirement's.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET enabled=false,deleted_at=now() WHERE id=3`); err != nil {
		t.Fatal("the branch account could not be retired")
	}
	if _, err := p.Exec(ctx, `UPDATE locations SET deleted_at=now() WHERE id=3`); err != nil {
		t.Fatal("the branch could not be retired")
	}
	execRefusalMessage(t, tryLoadFunds(ctx, p, 3, "500.00", "300.00", 1), "LG002",
		"The load of funds states a live branch")
	if drawer, fund := allRows(t, ctx, p); drawer != 0 || fund != 0 {
		t.Fatalf("a load of a retired branch writes nothing, got %d/%d rows", drawer, fund)
	}
}

// TestLoadBranchFundsRefusesAFrozenBranch proves S5 on a live database: while the branch has a live
// settlement its till is being counted, so the load is refused with the settlement's own code and
// message -- the guard of 035, not a second rule -- and nothing is written. The other branch is not
// frozen and is loaded.
func TestLoadBranchFundsRefusesAFrozenBranch(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	openSettlement(t, ctx, p, 2)
	execRefusalMessage(t, tryLoadFunds(ctx, p, 2, "500.00", "300.00", 1), "LC001",
		"The branch has an open account settlement and cannot operate")
	if drawer, fund := allRows(t, ctx, p); drawer != 0 || fund != 0 {
		t.Fatalf("a load of a frozen branch writes nothing, got %d/%d rows", drawer, fund)
	}
	loadFunds(t, ctx, p, 3, "500.00", "300.00", 1)
}

// TestLoadBranchFundsMarkCannotBeForged proves the provenance of S3 and S4 on a live database: the
// mark of a load is honoured only inside the act that states it, so a bare INSERT of either book with
// the mark set by hand -- at depth 1, where a client statement runs -- is refused, for the same branch
// and for another one.
func TestLoadBranchFundsMarkCannotBeForged(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	for _, forgery := range []struct {
		name, statement, code, message string
	}{
		{"a movement of the drawer that no act states", `INSERT INTO branch_cash_movements(
   branch_location_id,kind,amount,description,created_by_account_id)
   VALUES(2,'aporte',500.00,'Carga inventada',1)`, "LC011",
			"A load of funds is written by the act that states it"},
		{"a movement of the fund that no act states", `INSERT INTO branch_fund_movements(
   branch_location_id,kind,amount,description,created_by_account_id)
   VALUES(2,'aporte',500.00,'Carga inventada',1)`, "LF001",
			"A load of funds is written by the act that states it"},
		{"a movement of another branch", `INSERT INTO branch_cash_movements(branch_location_id,
   kind,amount,description,created_by_account_id)
   VALUES(3,'aporte',500.00,'Carga de otra sucursal',1)`, "LC011",
			"The load of funds writes no movement of another branch"},
	} {
		t.Run(forgery.name, func(t *testing.T) {
			tx, err := p.Begin(ctx)
			if err != nil {
				t.Fatal("the transaction of the forgery could not be opened")
			}
			defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
			if _, err = tx.Exec(ctx, `SELECT set_config('luson.branch_funds','2',true)`); err != nil {
				t.Fatal("the marker could not be set by hand", err)
			}
			_, err = tx.Exec(ctx, forgery.statement)
			execRefusalMessage(t, err, forgery.code, forgery.message)
		})
	}
	// The same mark without a client is the act itself, and it writes the two aportes: the mark is
	// not the proof, the trigger is.
	if _, err := p.Exec(ctx, `INSERT INTO branch_fund_load(branch_location_id,opening_cash,
         purchase_fund,actor_account_id) VALUES(2,700.00,800.00,1)`); err != nil {
		t.Fatalf("the act states its own movements: %v", err)
	}
	if drawer, fund := bookOf(t, ctx, p, branchDrawerQuery, 2), bookOf(t, ctx, p, branchFundQuery, 2); drawer != "aporte:700.00:1" ||
		fund != "aporte:800.00:1" {
		t.Fatalf("the act writes the two aportes of the warehouse, got %q and %q", drawer, fund)
	}
	// And the act's own door states every rule of the load: the actor, the branch and the amounts.
	if _, err := p.Exec(ctx, `INSERT INTO branch_fund_load(branch_location_id,opening_cash,
         purchase_fund,actor_account_id) VALUES(2,100.00,100.00,2)`); err == nil {
		t.Fatal("a branch account must not state a load")
	} else {
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "LG001" {
			t.Fatalf("a branch account must be refused as LG001, got %v", err)
		}
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_fund_load(branch_location_id,opening_cash,
         purchase_fund,actor_account_id) VALUES(2,-1.00,0.00,1)`); err == nil {
		t.Fatal("a negative amount must not be stated")
	}
	if drawer, fund := allRows(t, ctx, p); drawer != 1 || fund != 1 {
		t.Fatalf("the refused acts write nothing, got %d/%d rows", drawer, fund)
	}
}

// TestLoadBranchFundsKeepsTheDrawersAdmissionRules proves, after this version restated the drawer's
// admission, that every rule of it is still the one the branch and the warehouse already read: only
// the branch signs its own movements, a cross-branch movement is refused, a correction never exceeds
// what it answers and a correction returns what the movement put in.
func TestLoadBranchFundsKeepsTheDrawersAdmissionRules(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	if err := tryCashMovement(ctx, p, 2, 2, "aporte", "500.00", "Aporte de la sucursal"); err != nil {
		t.Fatalf("the branch records its own movement: %v", err)
	}
	execRefusalMessage(t, tryCashMovement(ctx, p, 2, 3, "gasto", "100.00", "Gasto ajeno"), "LC011",
		"Only the branch records its own cash movements")
	var id int64
	if err := p.QueryRow(ctx, `SELECT max(id) FROM branch_cash_movements`).Scan(&id); err != nil {
		t.Fatal("the movement could not be read")
	}
	// A correction never exceeds the movement it answers, and the tope is still the ledger's.
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES(2,'correccion',600.00,'Corrige de mas',2,$1)`, id)
	execRefusalMessage(t, err, "LC031", "A correction never exceeds the movement it corrects")
	if _, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES(2,'correccion',500.00,'Anula el aporte',2,$1)`, id); err != nil {
		t.Fatalf("the branch corrects its own movement: %v", err)
	}
	if effect := bookOf(t, ctx, p, branchDrawerEffectQuery, 2); effect != "0.00" {
		t.Fatalf("the correction returns what the aporte put in, got %s", effect)
	}
}

// TestLoadBranchFundsKeepsTheFundsAdmissionRules proves the same for the fund's admission: the branch
// signs its own movements, a purchase beyond the balance is refused by the rule that owns it, money
// never leaves the fund without a settlement, a correction returns what it answers and the closure
// keeps stating the fund it leaves through the book.
func TestLoadBranchFundsKeepsTheFundsAdmissionRules(t *testing.T) {
	ctx, p := loadFundsFixture(t)
	loadFunds(t, ctx, p, 2, "0.00", "1000.00", 1)
	execRefusalMessage(t, tryFundMovement(ctx, p, 2, 3, "aporte", "100.00", "Aporte ajeno"), "LF001",
		"Only the branch records its own fund movements")
	err := tryFundMovement(ctx, p, 2, 2, "compra", "1500.00", "Compra sin fondo")
	execRefusalMessage(t, err, "LF003", "The purchase fund never goes negative")
	execRefusalMessage(t, tryFundMovement(ctx, p, 2, 2, "devolucion", "100.00", "Salida sin rendicion"),
		"LF001", "Only the closing of a settlement takes money out of the fund")
	if err := tryFundMovement(ctx, p, 2, 2, "compra", "400.00", "Compra con fondo"); err != nil {
		t.Fatalf("the branch spends its own fund: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "600.00" {
		t.Fatalf("the fund is the sum of its book, got %s", balance)
	}
	var purchase int64
	if err := p.QueryRow(ctx, `SELECT max(id) FROM branch_fund_movements WHERE kind='compra'`).Scan(&purchase); err != nil {
		t.Fatal("the purchase could not be read")
	}
	if err := tryFundCorrection(ctx, p, 2, 2, purchase, "400.00", "Se anula la compra"); err != nil {
		t.Fatalf("the branch corrects the purchase: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "1000.00" {
		t.Fatalf("a correction returns what the purchase took, got %s", balance)
	}
	// The closure keeps stating the fund through the book, which is the other path this version
	// restated: the settlement leaves the amount the warehouse states, as a `reposicion`.
	closeFund(t, ctx, p, 2, "1200.00")
	if balance := fundBalance(t, ctx, p, 2); balance != "1200.00" {
		t.Fatalf("the closure leaves the fund it states, got %s", balance)
	}
	var kind string
	if err := p.QueryRow(ctx, `SELECT kind FROM branch_fund_movements
 WHERE branch_location_id=2 AND closing_id IS NOT NULL`).Scan(&kind); err != nil || kind != "reposicion" {
		t.Fatalf("the closure states its fund as a reposicion, got %q %v", kind, err)
	}
}
