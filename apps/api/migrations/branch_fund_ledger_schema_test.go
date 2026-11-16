package migrations_test

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration048 is the fund's own ledger: the table that mirrors the drawer's, the one signed
// reading of it, its admission with the rule that the balance never goes negative, the founding of
// a branch with its two amounts, and the backfill of the branches that already exist. It also
// restates the drawer's admission of 046 -- whole, statement by statement -- to add the one path a
// founding needs, because the administrator that creates a branch belongs to no branch and the
// branch has no account of its own until it exists.
const branchFundLedgerMigration = "048_branch_fund_ledger.sql"

// TestBranchFundLedgerSchemaStructure reads the embedded migration exactly as PostgreSQL receives
// it and asserts the contract it installs: the four kinds, the shape around `corrects_id`, the
// append-only guards, the one signed view, the guard that keeps the fund non-negative under the
// lock of the closure, the founding function and the backfill. It also asserts what the migration
// must not do -- add a ledger of the settlement, rewrite a row, or replace `create_branch(text)`.
func TestBranchFundLedgerSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(branchFundLedgerMigration)
	if err != nil {
		t.Fatal("the fund ledger migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The table, mirroring the drawer's ledger of 034 and 046 column by column.
		"CREATE TABLE branch_fund_movements (",
		"branch_location_id smallint NOT NULL REFERENCES locations(id)",
		"CHECK (kind IN ('aporte','compra','reposicion','correccion'))",
		"amount numeric(12,2) NOT NULL CHECK (amount > 0)",
		"CHECK (char_length(btrim(description)) BETWEEN 1 AND 500)",
		"occurred_at timestamptz NOT NULL DEFAULT now()",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"corrects_id bigint REFERENCES branch_fund_movements(id)",
		// The shape, stated once, exactly as the drawer's ledger states it.
		"CONSTRAINT branch_fund_movements_correction_shape",
		"CHECK ((kind = 'correccion') = (corrects_id IS NOT NULL))",
		// The append-only half: no update, no delete, no truncate, the way 034 protects the till.
		"CREATE TRIGGER protect_branch_fund_movements BEFORE UPDATE OR DELETE ON branch_fund_movements",
		"CREATE TRIGGER protect_branch_fund_movements_truncate BEFORE TRUNCATE ON branch_fund_movements",
		"EXECUTE FUNCTION protect_pending_request()",
		// One signed reading of every row (S5): the direction is the target's for a correction and
		// the row's own for every other kind, and the money is that direction applied.
		"CREATE VIEW purchase_fund_ledger AS",
		"CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END",
		"AS effect_kind",
		"IN ('aporte','reposicion'))",
		"THEN movement.amount ELSE -movement.amount END AS effective",
		"LEFT JOIN branch_fund_movements corrected ON corrected.id = movement.corrects_id",
		// The admission of the ledger (S5, S6).
		"CREATE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"MESSAGE='A fund movement requires a known account'",
		"MESSAGE='Only the branch records its own fund movements'",
		"PERFORM assert_branch_not_frozen(NEW.branch_location_id);",
		"SELECT * INTO corrected FROM branch_fund_movements WHERE id=NEW.corrects_id FOR UPDATE;",
		"MESSAGE='A correction names a movement of the fund ledger'",
		"MESSAGE='A correction names a movement of its own branch'",
		"MESSAGE='A correction is not corrected'",
		"IF used + NEW.amount > corrected.amount THEN",
		"ERRCODE='LF002'",
		"MESSAGE='A correction never exceeds the movement it corrects'",
		// The rule of S6 in one place, under the lock of 044 and of the closure, reading the
		// balance from the view so there is no second arithmetic.
		"PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);",
		"SELECT coalesce(sum(effective),0) INTO balance FROM purchase_fund_ledger",
		"IF balance + effect < 0 THEN",
		"ERRCODE='LF003'",
		"MESSAGE='The purchase fund never goes negative: '",
		"|| ' in it, ' || NEW.amount || ' requested'",
		// The founding of a branch (S1-S4, S12), and the proof of its provenance.
		"CREATE FUNCTION create_branch_funded(branch_name text, opening_cash numeric,",
		"purchase_fund numeric, creator_account_id integer) RETURNS smallint LANGUAGE plpgsql AS $$",
		"branch_id := create_branch(branch_name);",
		"PERFORM set_config('luson.branch_founding', branch_id::text, true);",
		"VALUES(branch_id,'aporte',opening_cash,'Fondo inicial de caja de la sucursal',",
		"VALUES(branch_id,'aporte',purchase_fund,'Fondo inicial de compras de la sucursal',",
		"REVOKE ALL ON FUNCTION create_branch_funded(text,numeric,numeric,integer) FROM PUBLIC;",
		"MESSAGE='The founding of a branch writes no movement of another branch'",
		"xmin = pg_current_xact_id()::xid",
		// The backfill of S12 and the marker that lets exactly those rows keep their instant.
		"SELECT set_config('luson.fund_backfill','on',true);",
		"SELECT DISTINCT ON (settlement.branch_location_id)",
		"settlement.purchase_fund_cash,",
		"settlement.closed_at,",
		"AND settlement.purchase_fund_cash > 0",
		"AND branch.deleted_at IS NULL",
		"CREATE FUNCTION stamp_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF current_setting('luson.fund_backfill', true) IS DISTINCT FROM 'on' THEN",
		"NEW.occurred_at := now();",
		// The drawer's admission, restated whole from 046 and not rewritten: every rule and every
		// code of it is here, plus the founding path the branch's first cash needs.
		"CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.closing_id IS NOT NULL THEN",
		"MESSAGE='Only the warehouse moves the money of a settlement'",
		"MESSAGE='A cash movement belongs to a proposed settlement of its own branch'",
		"MESSAGE='A cash movement of a settlement is written by its closure'",
		"MESSAGE='Only the branch records its own cash movements'",
		"MESSAGE='The opening contribution of a branch is written by the transaction that creates it'",
		"MESSAGE='A correction names a movement of the ledger'",
		"MESSAGE='The transfer of a settlement is corrected in the settlement'",
		"MESSAGE='A movement of a settled period is corrected in the settlement'",
		"ERRCODE='LC030'",
		"ERRCODE='LC031'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the fund ledger migration must state %q", required)
		}
	}

	// One table, one view and four functions: two of the new ledger (its admission and its stamp),
	// the founding, and the drawer's admission restated. A second replacement would mean this
	// version rewrote a guard it does not own.
	if got := strings.Count(sql, "CREATE TABLE"); got != 1 {
		t.Errorf("048 adds one table, got %d", got)
	}
	if got := strings.Count(sql, "CREATE VIEW"); got != 1 {
		t.Errorf("048 adds one view, got %d", got)
	}
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("048 restates the drawer's admission and nothing else, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 3 {
		t.Errorf("048 installs the fund's admission, its stamp and the founding, got %d", got)
	}
	// Two immutability guards, the fund's admission and its stamp. No trigger is created on the
	// drawer's ledger, whose guards already exist and keep calling the function 046 named.
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 4 {
		t.Errorf("048 creates four triggers, got %d", got)
	}
	// The branches' existing money is not recalculated and no row is edited: this file writes the
	// backfill and nothing else.
	for _, forbidden := range []string{
		"DROP FUNCTION", "CREATE OR REPLACE FUNCTION create_branch(",
		"ALTER TABLE branch_closings", "INSERT INTO branch_closings",
		"UPDATE branch_closings", "DELETE FROM branch_closings",
		"UPDATE branch_fund_movements", "DELETE FROM branch_fund_movements",
		"TRUNCATE branch_fund_movements", "UPDATE branch_cash_movements",
		"DELETE FROM branch_cash_movements", "TRUNCATE branch_cash_movements",
		"DROP TABLE",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("048 rewrites no ledger and no settlement: it must not use %q", forbidden)
		}
	}

	// The table comes before the view that reads it, the view before the guards that read the
	// balance from it, and the founding before the backfill that reuses its admission.
	table := strings.Index(sql, "CREATE TABLE branch_fund_movements")
	view := strings.Index(sql, "CREATE VIEW purchase_fund_ledger AS")
	fundGuard := strings.Index(sql, "FUNCTION admit_branch_fund_movement()")
	drawerGuard := strings.Index(sql, "FUNCTION admit_branch_cash_movement()")
	founding := strings.Index(sql, "FUNCTION create_branch_funded(")
	backfill := strings.Index(sql, "SELECT set_config('luson.fund_backfill','on',true);")
	if table < 0 || view < 0 || fundGuard < 0 || drawerGuard < 0 || founding < 0 || backfill < 0 ||
		table > view || view > fundGuard || fundGuard > founding || founding > backfill ||
		drawerGuard > founding {
		t.Errorf("the order of 048 is the order of its readers: %d %d %d %d %d %d",
			table, view, fundGuard, drawerGuard, founding, backfill)
	}

	// The codes this version adds are its own: the identity and the provenance of a fund movement
	// are LF001, the tope of a correction is LF002 and the balance that never goes negative is
	// LF003. The codes of the drawer's ledger are restated, not reissued.
	for _, owned := range []string{"LF001", "LF002", "LF003"} {
		if !strings.Contains(sql, "ERRCODE='"+owned+"'") {
			t.Errorf("048 must raise %s", owned)
		}
	}
	// The decisions a reader has to be able to check without deriving them from the triggers.
	for _, documented := range []string{
		"S1", "S4", "S5", "S6", "S7", "S12", "Why",
		"nunca queda negativo", "purchase_fund_ledger", "340251", "044", "046",
		"pg_trigger_depth", "xmin",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("048 must document its own decision: %s", documented)
		}
	}
}

// fundFixture is the prefix applied through 048: the catalogue, one account per historical
// location, the administrator of location 1, the initialization row `create_branch` reads and the
// commission rate branch 2 needs to be settled. No stock and no balance is seeded: no rule here
// reads them, and a branch without stock has an empty count sheet.
func fundFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 48)
}

// fundPrefixThrough applies the embedded versions up to and including last through the same
// runner the tests of this package use, and seeds the fixture above.
func fundPrefixThrough(t *testing.T, last int) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, last)
	fundSeeds(t, ctx, p)
	return ctx, p
}

// fundSeeds provisions the accounts, the initialized catalogue and the commission the rules below
// read. Account 1 is the warehouse administrator -- 014 leaves no other -- and it is the account
// that creates a branch; accounts 2 and 3 are the branches that already exist.
func fundSeeds(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash)
 VALUES(1,1,'almacen','x'),(2,2,'sucursal_a','x'),(3,3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO initialization_metadata(id,source_sha256,fixture_sha256,
 stock_origin) VALUES(1,'fund-source','fund-fixture','fictional-local-trial-v1')`); err != nil {
		t.Fatal("the catalog initialization could not be recorded")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,
 commission_rate_percent,updated_by_account_id) VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
}

// applyMigrationFrom applies the embedded versions from first to last, both inclusive. The runner
// of the product applies only the versions a database has not seen yet, and the backfill of S12
// only exists for a database that already closed a settlement: the test builds that past with the
// prefix and then applies this version alone.
func applyMigrationFrom(t *testing.T, ctx context.Context, p *pgxpool.Pool, first, last int) {
	t.Helper()
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal("embedded migrations are unreadable")
	}
	for version := first; version <= last; version++ {
		applied := false
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".sql") || !strings.HasPrefix(name, fmt.Sprintf("%03d_", version)) {
				continue
			}
			sql, err := migrations.Files.ReadFile(name)
			if err != nil {
				t.Fatalf("embedded migration %s is unreadable", name)
			}
			if _, err := p.Exec(ctx, string(sql)); err != nil {
				t.Fatalf("migration %s failed: %v", name, err)
			}
			applied = true
		}
		if !applied {
			t.Fatalf("migration version %d is not embedded", version)
		}
	}
}

// founding creates a branch with its two amounts through the function the caller uses and returns
// the branch it created.
func founding(t *testing.T, ctx context.Context, p *pgxpool.Pool, name, cash, fund string, creator int) int {
	t.Helper()
	var branch int
	if err := p.QueryRow(ctx, `SELECT create_branch_funded($1,$2::numeric,$3::numeric,$4::integer)`,
		name, cash, fund, creator).Scan(&branch); err != nil {
		t.Fatalf("the branch %q must be founded: %v", name, err)
	}
	return branch
}

// branchActor gives a branch an account of its own -- the administration of accounts creates it
// after the branch exists -- and returns it: it is what a movement of that branch is signed with.
func branchActor(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) int {
	t.Helper()
	var account int
	if err := p.QueryRow(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES($1::smallint,'sucursal_'||$1::text,'x') RETURNING id`, branch).Scan(&account); err != nil {
		t.Fatalf("the account of branch %d could not be provisioned: %v", branch, err)
	}
	return account
}

// tryFundMovement writes one movement of the fund as a caller would and returns the error instead
// of asserting, so the same call is used where the row must be admitted and where it must not.
func tryFundMovement(ctx context.Context, p *pgxpool.Pool, branch, account int, kind, amount,
	description string) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1::smallint,$2,$3::numeric,$4,$5::integer)`,
		branch, kind, amount, description, account)
	return err
}

// recordFundMovement writes one movement of the fund and returns the id a correction names. It
// fails instead of returning the error: every call of it is a row the domain must admit.
func recordFundMovement(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, account int,
	kind, amount, description string) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1::smallint,$2,$3::numeric,$4,$5::integer)
 RETURNING id`, branch, kind, amount, description, account).Scan(&id); err != nil {
		t.Fatalf("the %s of branch %d must be admitted: %v", kind, branch, err)
	}
	return id
}

// tryFundCorrection writes one correction of the fund ledger and returns the error instead of
// asserting.
func tryFundCorrection(ctx context.Context, p *pgxpool.Pool, branch, account int, target int64,
	amount, description string) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES($1::smallint,'correccion',$2::numeric,$3,$4::integer,$5)`,
		branch, amount, description, account, target)
	return err
}

// fundLedger is the whole fund ledger as one value, so "writes nothing" is one comparison instead
// of a promise about a row.
func fundLedger(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var ledger string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(branch_location_id||':'||kind||':'
         ||amount||':'||description||':'||created_by_account_id||':'
         ||coalesce(corrects_id::text,'-'),',' ORDER BY id),'') FROM branch_fund_movements`).
		Scan(&ledger); err != nil {
		t.Fatal("the fund ledger could not be read")
	}
	return ledger
}

// fundBalance is the balance of one branch read from the view that owns the arithmetic, so a test
// never computes the fund a second way.
func fundBalance(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) string {
	t.Helper()
	var balance string
	if err := p.QueryRow(ctx, `SELECT coalesce(sum(effective),0)::numeric(12,2)::text
 FROM purchase_fund_ledger WHERE branch_location_id=$1`, branch).Scan(&balance); err != nil {
		t.Fatalf("the fund of branch %d could not be read: %v", branch, err)
	}
	return balance
}

// TestBranchFundLedgerFoundingWritesBothOpenings proves S1, S2, S4 and S12 on a live database: one
// call creates the branch and writes the two openings of its two books -- the drawer's and the
// fund's -- with the stated amounts and with the administrator that creates the branch as their
// actor.
func TestBranchFundLedgerFoundingWritesBothOpenings(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	if branch != 4 {
		t.Fatalf("the founding allocates the next branch identity, got %d", branch)
	}
	var name string
	if err := p.QueryRow(ctx, `SELECT name FROM locations
         WHERE id=$1 AND deleted_at IS NULL`, branch).Scan(&name); err != nil || name != "Sucursal C" {
		t.Fatalf("the founding creates the branch it names: %q %v", name, err)
	}

	// The drawer's opening is a movement of the drawer's ledger, like any other (S4): an `aporte`
	// signed by the administrator, stating that it is the branch's initial cash.
	var drawerKind, drawerAmount, drawerDescription string
	var drawerActor int
	var drawerAt time.Time
	if err := p.QueryRow(ctx, `SELECT kind,amount::text,description,created_by_account_id,occurred_at
         FROM branch_cash_movements WHERE branch_location_id=$1`, branch).
		Scan(&drawerKind, &drawerAmount, &drawerDescription, &drawerActor, &drawerAt); err != nil {
		t.Fatalf("the founding must write the drawer's opening: %v", err)
	}
	if drawerKind != "aporte" || drawerAmount != "500.00" || drawerActor != 1 ||
		!strings.Contains(drawerDescription, "inicial de caja") {
		t.Fatalf("the drawer's opening is an aporte of 500.00 signed by the creator, got %s %s %s %d",
			drawerKind, drawerAmount, drawerDescription, drawerActor)
	}
	// The fund's opening is the same fact in its own book (S2, S5).
	var fundKind, fundAmount, fundDescription string
	var fundActor int
	var fundAt time.Time
	if err := p.QueryRow(ctx, `SELECT kind,amount::text,description,created_by_account_id,occurred_at
         FROM branch_fund_movements WHERE branch_location_id=$1`, branch).
		Scan(&fundKind, &fundAmount, &fundDescription, &fundActor, &fundAt); err != nil {
		t.Fatalf("the founding must write the fund's opening: %v", err)
	}
	if fundKind != "aporte" || fundAmount != "300.00" || fundActor != 1 ||
		!strings.Contains(fundDescription, "inicial de compras") {
		t.Fatalf("the fund's opening is an aporte of 300.00 signed by the creator, got %s %s %s %d",
			fundKind, fundAmount, fundDescription, fundActor)
	}
	// Both instants are the database's, not the caller's.
	for _, written := range []time.Time{drawerAt, fundAt} {
		if age := time.Since(written); age < 0 || age > time.Minute {
			t.Fatalf("an opening is stamped with the instant it is written, got %s", written)
		}
	}
	// And the two balances are the sums of those two books, each read where it lives.
	var drawer string
	if err := p.QueryRow(ctx, `SELECT coalesce(sum(effective),0)::text FROM branch_cash_ledger
         WHERE branch_location_id=$1 AND closing_id IS NULL`, branch).Scan(&drawer); err != nil ||
		drawer != "500.00" {
		t.Fatalf("the branch starts with the cash it was founded with: %q %v", drawer, err)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "300.00" {
		t.Fatalf("the branch starts with the fund it was founded with, got %s", balance)
	}
	t.Logf("048: one call creates the branch and its two openings")
}

// TestBranchFundLedgerFoundingWritesNoMovementForZero proves S3: 0,00 is a valid and explicit
// answer, the branch is created, and the books stay empty because a zero is the empty sum of a
// book and not a movement to explain. It also proves the previous behaviour of `create_branch(text)`
// is untouched: it still allocates the next identity on its own.
func TestBranchFundLedgerFoundingWritesNoMovementForZero(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal D", "0.00", "0.00", 1)
	if branch != 4 {
		t.Fatalf("a branch founded with 0 and 0 is still a branch, got %d", branch)
	}
	var name string
	if err := p.QueryRow(ctx, `SELECT name FROM locations WHERE id=$1`, branch).Scan(&name); err != nil ||
		name != "Sucursal D" {
		t.Fatalf("the branch exists after a founding of zero: %q %v", name, err)
	}
	if ledger := fundLedger(t, ctx, p); ledger != "" {
		t.Fatalf("a founding of 0 and 0 writes no movement, got %s", ledger)
	}
	if drawer := cashLedger(t, ctx, p); drawer != "" {
		t.Fatalf("a founding of 0 and 0 writes no movement of the drawer, got %s", drawer)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "0.00" {
		t.Fatalf("a branch founded with 0 starts at zero, got %s", balance)
	}
	var next int
	if err := p.QueryRow(ctx, `SELECT create_branch('Sucursal E')`).Scan(&next); err != nil ||
		next != 5 {
		t.Fatalf("create_branch(text) keeps its own allocation: %d %v", next, err)
	}
	t.Logf("048: 0,00 is an explicit answer and writes no movement")
}

// TestBranchFundLedgerRefusesAPurchaseBeyondTheBalance proves S6 and S7 on a live database: a
// `compra` that would leave the fund below zero is refused with the current balance and the
// requested amount in the message, and one that fits is admitted and leaves the difference.
func TestBranchFundLedgerRefusesAPurchaseBeyondTheBalance(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	actor := branchActor(t, ctx, p, branch)
	before := fundLedger(t, ctx, p)

	// The refusal names both numbers, so the branch knows what it can still buy (S6).
	err := tryFundMovement(ctx, p, branch, actor, "compra", "500.00", "Baterías usadas")
	execRefusalMessage(t, err, "LF003", "300.00 in it, 500.00 requested")
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("a refused purchase must write nothing, got %s before %s", after, before)
	}
	// A purchase that fits is admitted, and the fund is exactly the difference.
	recordFundMovement(t, ctx, p, branch, actor, "compra", "120.00", "Baterías usadas")
	if balance := fundBalance(t, ctx, p, branch); balance != "180.00" {
		t.Fatalf("the fund after a purchase of 120.00 of 300.00 is 180.00, got %s", balance)
	}
	// And the bound is the balance, not the opening: the second purchase the first left no room
	// for is refused with the balance the first one left.
	err = tryFundMovement(ctx, p, branch, actor, "compra", "200.00", "Baterías usadas")
	execRefusalMessage(t, err, "LF003", "180.00 in it, 200.00 requested")
	// The bound is also the actor's: the warehouse and another branch state no fact about this
	// fund, so they cannot spend it either.
	err = tryFundMovement(ctx, p, branch, 1, "compra", "10.00", "Ajena")
	execRefusalMessage(t, err, "LF001", "Only the branch records its own fund movements")
	err = tryFundMovement(ctx, p, branch, 3, "compra", "10.00", "Ajena")
	execRefusalMessage(t, err, "LF001", "Only the branch records its own fund movements")
	if balance := fundBalance(t, ctx, p, branch); balance != "180.00" {
		t.Fatalf("a refused movement never moves the fund, got %s", balance)
	}
	t.Logf("048: the fund is the balance and the balance is never negative")
}

// TestBranchFundLedgerSerializesTwoConcurrentPurchases proves S8 on a live database: two purchases
// that each fit alone and cannot both fit are serialized by the per-branch lock 340251, so exactly
// one is admitted. The second waits for the first, reads the balance the first left -- a fresh
// snapshot after the wait -- and is refused with it. That is the lock, not the luck.
//
// The brief says "half the balance each"; two halves of a fund fit exactly (300 - 150 - 150 = 0 is
// not negative), so the two purchases are stated as two thirds, which is the case the lock exists
// for: each fits alone, the pair does not.
func TestBranchFundLedgerSerializesTwoConcurrentPurchases(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	actor := branchActor(t, ctx, p, branch)
	spend := `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,
 created_by_account_id) VALUES($1::smallint,'compra',200.00,'Baterías usadas',$2::integer)`

	first, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal("the first connection could not be taken")
	}
	defer first.Release()
	second, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal("the second connection could not be taken")
	}
	defer second.Release()
	held, err := first.Begin(ctx)
	if err != nil {
		t.Fatal("the first purchase could not be opened")
	}
	defer held.Rollback(context.WithoutCancel(ctx))
	if _, err := held.Exec(ctx, spend, branch, actor); err != nil {
		t.Fatalf("the first purchase of 200.00 of 300.00 must be admitted: %v", err)
	}

	outcome := make(chan error, 1)
	go func() {
		waiter, err := second.Begin(ctx)
		if err != nil {
			outcome <- err
			return
		}
		defer waiter.Rollback(context.WithoutCancel(ctx))
		if _, err := waiter.Exec(ctx, spend, branch, actor); err != nil {
			outcome <- err
			return
		}
		outcome <- waiter.Commit(ctx)
	}()
	waitForFundLockWait(t, ctx, p)
	if err := held.Commit(ctx); err != nil {
		t.Fatalf("the first purchase could not be committed: %v", err)
	}

	// The one that waited is the one that loses: it reads the balance the first left.
	execRefusalMessage(t, <-outcome, "LF003", "100.00 in it, 200.00 requested")
	var purchases int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_fund_movements
         WHERE branch_location_id=$1 AND kind='compra'`, branch).Scan(&purchases); err != nil ||
		purchases != 1 {
		t.Fatalf("exactly one of two purchases that cannot both fit is admitted, got %d %v",
			purchases, err)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "100.00" {
		t.Fatalf("the one purchase admitted leaves the difference, got %s", balance)
	}
	t.Logf("048: two purchases that cannot both fit are serialized by the lock of the branch")
}

// waitForFundLockWait waits until a session of this database is waiting for an advisory lock, which
// is what proves the second purchase reached the lock instead of racing past it.
func waitForFundLockWait(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		if err := p.QueryRow(ctx, `SELECT count(*) FROM pg_locks
             WHERE locktype='advisory' AND NOT granted
               AND database = (SELECT oid FROM pg_database WHERE datname=current_database())`).
			Scan(&waiting); err != nil {
			t.Fatalf("the wait for the branch lock could not be observed: %v", err)
		}
		if waiting > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the second purchase must wait for the lock of the branch")
}

// TestBranchFundLedgerCorrectionReturnsMoneyAndIsCapped proves the signed reading of S5 and the
// tope of a correction on a live database: a correction of a `compra` gives the money back to the
// fund, it carries the direction of what it answers, and it never exceeds the amount it corrects.
func TestBranchFundLedgerCorrectionReturnsMoneyAndIsCapped(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	actor := branchActor(t, ctx, p, branch)
	purchase := recordFundMovement(t, ctx, p, branch, actor, "compra", "120.00", "Baterías usadas")
	if balance := fundBalance(t, ctx, p, branch); balance != "180.00" {
		t.Fatalf("the purchase must leave the difference, got %s", balance)
	}

	// A correction of a `compra` is money back into the fund, and the row says so: its direction
	// is the one of the movement it answers, inverted.
	var correction int64
	var signed string
	if err := p.QueryRow(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES($1::smallint,'correccion',120.00,'Compra anulada',$2::integer,$3) RETURNING id`,
		branch, actor, purchase).Scan(&correction); err != nil {
		t.Fatalf("the correction of a purchase must be admitted: %v", err)
	}
	if err := p.QueryRow(ctx, `SELECT effect_kind||':'||effective::text FROM purchase_fund_ledger
         WHERE id=$1`, correction).Scan(&signed); err != nil || signed != "compra:120.00" {
		t.Fatalf("a correction of a compra returns its money: %q %v", signed, err)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "300.00" {
		t.Fatalf("the corrected purchase gives the fund back, got %s", balance)
	}
	before := fundLedger(t, ctx, p)

	// One cent more than the purchase stated does not fit under it.
	err := tryFundCorrection(ctx, p, branch, actor, purchase, "0.01", "De más")
	execRefusalMessage(t, err, "LF002", "A correction never exceeds the movement it corrects")
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("a refused correction must write nothing, got %s before %s", after, before)
	}
	// A correction names a movement of the fund, of its own branch, and not a correction.
	err = tryFundCorrection(ctx, p, branch, actor, 999999, "1.00", "Inexistente")
	execRefusalMessage(t, err, "LF001", "A correction names a movement of the fund ledger")
	other := recordFundMovement(t, ctx, p, 2, 2, "reposicion", "10.00", "Queda en la otra sucursal")
	err = tryFundCorrection(ctx, p, branch, actor, other, "1.00", "Ajena")
	execRefusalMessage(t, err, "LF001", "A correction names a movement of its own branch")
	err = tryFundCorrection(ctx, p, branch, actor, correction, "1.00", "Sobre corrección")
	execRefusalMessage(t, err, "LF001", "A correction is not corrected")
	// A correction that would take the fund below zero is refused by the same rule as a purchase:
	// an `aporte` is money in, and answering it takes money out.
	aporte := recordFundMovement(t, ctx, p, branch, actor, "aporte", "300.00", "Carga del almacén")
	recordFundMovement(t, ctx, p, branch, actor, "compra", "500.00", "Baterías usadas")
	err = tryFundCorrection(ctx, p, branch, actor, aporte, "300.00", "Carga mal cargada")
	execRefusalMessage(t, err, "LF003", "100.00 in it, 300.00 requested")
	t.Logf("048: a correction returns money of a purchase and never exceeds its target")
}

// TestBranchFundLedgerIsAppendOnly proves the immutability of the fund's ledger the way 034 states
// it for the drawer's: a movement is never updated, deleted or truncated, so an error is answered
// by its opposite and the row keeps what it stated.
func TestBranchFundLedgerIsAppendOnly(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	actor := branchActor(t, ctx, p, branch)
	purchase := recordFundMovement(t, ctx, p, branch, actor, "compra", "40.00", "Baterías usadas")
	before := fundLedger(t, ctx, p)

	_, err := p.Exec(ctx, `UPDATE branch_fund_movements SET amount=1.00 WHERE id=$1`, purchase)
	refusal(t, err)
	_, err = p.Exec(ctx, `DELETE FROM branch_fund_movements WHERE id=$1`, purchase)
	refusal(t, err)
	_, err = p.Exec(ctx, `TRUNCATE branch_fund_movements`)
	refusal(t, err)
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("the ledger is append only, got %s before %s", after, before)
	}
	t.Logf("048: the fund ledger is append only")
}

// TestBranchFundLedgerFoundingProvenanceCannotBeBorrowed proves the provenance of S12 on a live
// database: the marker that admits an opening signed by an account outside the branch cannot be
// used as a client, because it only admits a branch this very transaction created, and it can
// never be lent to another branch. The backfill's marker is refused the same way, with rows a
// settlement does not state.
func TestBranchFundLedgerFoundingProvenanceCannotBeBorrowed(t *testing.T) {
	ctx, p := fundFixture(t)
	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	drawer, fund := cashLedger(t, ctx, p), fundLedger(t, ctx, p)

	// The marker names another branch: the provenance of a founding belongs to the branch it
	// created and to no other.
	for _, refused := range []struct {
		name, ledger, sql, code, message string
	}{
		{"the fund of another branch", "fund", `INSERT INTO branch_fund_movements(
 branch_location_id,kind,amount,description,created_by_account_id)
 VALUES(4,'aporte',10.00,'Prestado',1)`, "LF001",
			"The founding of a branch writes no movement of another branch"},
		{"the drawer of another branch", "drawer", `INSERT INTO branch_cash_movements(
 branch_location_id,kind,amount,description,created_by_account_id)
 VALUES(4,'aporte',10.00,'Prestado',1)`, "LC011",
			"The founding of a branch writes no movement of another branch"},
	} {
		marker := "3"
		err := tryFounding(ctx, p, marker, refused.sql)
		execRefusalMessage(t, err, refused.code, refused.message)
		if after := fundLedger(t, ctx, p); after != fund {
			t.Fatalf("%s must write nothing, got %s before %s", refused.name, after, fund)
		}
		if after := cashLedger(t, ctx, p); after != drawer {
			t.Fatalf("%s must write nothing, got %s before %s", refused.name, after, drawer)
		}
	}
	// The marker names this branch, but the branch was not created by this transaction: a client
	// that sets the setting by hand states no founding.
	for _, refused := range []struct {
		name, sql, code, message string
	}{
		{"the fund", `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,
 created_by_account_id) VALUES(4,'aporte',10.00,'Inventado',1)`, "LF001",
			"The opening of a fund is written by the transaction that creates its branch"},
		{"the drawer", `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
 created_by_account_id) VALUES(4,'aporte',10.00,'Inventado',1)`, "LC011",
			"The opening contribution of a branch is written by the transaction that creates it"},
	} {
		err := tryFounding(ctx, p, strconv.Itoa(branch), refused.sql)
		execRefusalMessage(t, err, refused.code, refused.message)
	}
	// The backfill's marker is not a way in either: it only admits the numbers of the branch's last
	// closed settlement, and this branch never closed one.
	err := tryBackfill(ctx, p, branch)
	execRefusalMessage(t, err, "LF001", "The opening of a fund states its last closed settlement")
	if after := fundLedger(t, ctx, p); after != fund {
		t.Fatalf("a borrowed backfill must write nothing, got %s before %s", after, fund)
	}
	t.Logf("048: the founding and the backfill cannot be borrowed with a setting")
}

// tryFounding runs one insert inside a transaction that sets the founding marker first and returns
// the error. A client can set any transaction-local setting, so the guard has to refuse the rows
// the setting does not entitle it to write.
func tryFounding(ctx context.Context, p *pgxpool.Pool, value, sql string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, `SELECT set_config('luson.branch_founding',$1,true)`, value); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// tryBackfill writes one opening of the fund as a client that sets the backfill marker by hand.
func tryBackfill(ctx context.Context, p *pgxpool.Pool, branch int) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, `SELECT set_config('luson.fund_backfill','on',true)`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1::smallint,'aporte',10.00,'Inventado',1)`,
		branch); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TestBranchFundLedgerBackfillFromTheLastSettlement proves S12 on a live database: a branch that
// already exists starts with the fund its last closed settlement left behind, in a row that
// carries the instant that settlement closed -- not the instant the migration ran -- and a branch
// that never closed starts at zero, without a movement.
func TestBranchFundLedgerBackfillFromTheLastSettlement(t *testing.T) {
	ctx, p := fundPrefixThrough(t, 47)

	// The branch closes a settlement that leaves 2.000,00 in its purchase fund. 034 owns the
	// closure instant and 044 the fund, so the numbers are stated the only way the guards allow.
	closing := openSettlement(t, ctx, p, 2)
	proposeRound(t, ctx, p, closing, `{"fund":"2000.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=10000.00,
 contributed_cash=0.00,closing_cash=5000.00,purchase_fund_counted=2000.00,purchase_fund_cash=2000.00
 WHERE id=$1 AND status IN ('open','rejected')`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	var closedAt time.Time
	if err := p.QueryRow(ctx, `SELECT closed_at FROM branch_closings WHERE id=$1`, closing).
		Scan(&closedAt); err != nil {
		t.Fatal("the closure instant could not be read")
	}

	// The migration runs later: a stamp of its own would carry an instant after this one.
	time.Sleep(20 * time.Millisecond)
	migrated := time.Now().UTC()
	applyMigrationFrom(t, ctx, p, 48, 48)

	var kind, amount, description, actor string
	var occurred time.Time
	if err := p.QueryRow(ctx, `SELECT kind,amount::text,description,created_by_account_id::text,
 occurred_at FROM branch_fund_movements WHERE branch_location_id=2`).
		Scan(&kind, &amount, &description, &actor, &occurred); err != nil {
		t.Fatalf("the branch's fund must be backfilled: %v", err)
	}
	if kind != "aporte" || amount != "2000.00" || actor != "1" ||
		!strings.Contains(description, "inicial de compras") {
		t.Fatalf("the backfill states the fund the settlement left, got %s %s %s %s",
			kind, amount, description, actor)
	}
	// The historical instant matters: the opening belongs to the closing that left it, so the book
	// reads in the order the branch lived it. A stamped row would say the fund appeared with the
	// deployment.
	if !occurred.Equal(closedAt) {
		t.Fatalf("the opening carries the instant its settlement closed (%s), got %s",
			closedAt, occurred)
	}
	if !occurred.Before(migrated) {
		t.Fatalf("the opening is not dated by the migration's own instant: %s", occurred)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "2000.00" {
		t.Fatalf("the branch starts with the fund its last settlement left, got %s", balance)
	}
	// A branch that never closed starts at zero, and its book states it by staying empty: an
	// unstated fund is zero (S7), not a movement somebody would have to read.
	if balance := fundBalance(t, ctx, p, 3); balance != "0.00" {
		t.Fatalf("a branch that never closed starts at zero, got %s", balance)
	}
	var rows int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_fund_movements
         WHERE branch_location_id=3`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("a branch with no settlement gets no fund row, got %d %v", rows, err)
	}
	t.Logf("048: the existing branches start with the fund their last settlement left")
}

// TestBranchFundLedgerKeepsTheDrawersAdmissionRules proves the previous behaviour of the code this
// version touches: the drawer's ledger -- whose admission 048 restates whole from 046 to add the
// founding path -- still states every fact it stated, with the same codes and the same messages,
// and the closure of a settlement still writes its transfers through it.
func TestBranchFundLedgerKeepsTheDrawersAdmissionRules(t *testing.T) {
	ctx, p := fundFixture(t)

	// The branch records its own contribution of the period, as 046 admitted it.
	if err := tryExpense(ctx, p, 2, 2, "aporte", "50.00", "Aporte del dueño"); err != nil {
		t.Fatalf("a branch must record its own contribution: %v", err)
	}
	// Another branch's account and the warehouse state no fact about this till.
	err := tryExpense(ctx, p, 2, 3, "aporte", "10.00", "Ajeno")
	execRefusalMessage(t, err, "LC011", "Only the branch records its own cash movements")
	err = tryExpense(ctx, p, 2, 1, "aporte", "10.00", "Almacén")
	execRefusalMessage(t, err, "LC011", "Only the branch records its own cash movements")

	// The shape of a correction and its tope are unchanged.
	expense := recordMovement(t, ctx, p, 2, 2, "gasto", "100.00", "Detergente")
	foreign := recordMovement(t, ctx, p, 3, 3, "gasto", "20.00", "Flete ajeno")
	err = tryCorrection(ctx, p, 2, 2, foreign, "1.00", "Ajena")
	execRefusalMessage(t, err, "LC030", "A correction names a movement of its own branch")
	correction := recordCorrection(t, ctx, p, 2, 2, expense, "60.00", "Detergente mal cargado")
	err = tryCorrection(ctx, p, 2, 2, correction, "1.00", "Otra")
	execRefusalMessage(t, err, "LC030", "A correction is not corrected")
	err = tryCorrection(ctx, p, 2, 2, expense, "40.01", "De más")
	execRefusalMessage(t, err, "LC031", "A correction never exceeds the movement it corrects")

	// The settlement's transfers are written by the closure and by nobody else.
	closing := openSettlement(t, ctx, p, 2)
	proposeRound(t, ctx, p, closing, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=1000.00,
 contributed_cash=100.00,closing_cash=500.00 WHERE id=$1 AND status IN ('open','rejected')`,
		closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,closing_id,kind,
 amount,description,created_by_account_id) VALUES(2,$1,'aporte',100.00,'Transferencia',1)`, closing)
	execRefusalMessage(t, err, "LC020", "A cash movement of a settlement is written by its closure")

	// The closure that does write them still does: its two transfers go through the restated
	// admission at the depth only a trigger reaches, which is what proves the restatement kept the
	// provenance of 046 as well as its refusals.
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	var transfers string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||created_by_account_id,','
         ORDER BY kind) FROM branch_cash_movements WHERE closing_id=$1`, closing).Scan(&transfers); err != nil ||
		transfers != "aporte:100.00:1,recaudacion:600.00:1" {
		t.Fatalf("the closure writes its two transfers, got %q %v", transfers, err)
	}
	// A movement of the settled window is still corrected in the settlement, never with a new row.
	err = tryCorrection(ctx, p, 2, 2, expense, "5.00", "Flete mal cargado")
	execRefusalMessage(t, err, "LC030", "A movement of a settled period is corrected in the settlement")
	t.Logf("048: the drawer's ledger keeps every rule of 046 and its closure keeps writing it")
}
