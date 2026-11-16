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

// migration049 is the founding as the only way in: the allocation 014 stated is
// restated inside `create_branch_funded` -- same lock, same next identity, same
// fanout triggers, same grant -- and `create_branch(text)` is dropped, so nothing
// can create a branch without stating its two amounts (S1, S3, S12).
const branchCreationRequiresFundsMigration = "049_branch_creation_requires_funds.sql"

// TestBranchCreationRequiresFundsSchemaStructure reads the embedded migration exactly
// as PostgreSQL receives it: the allocation moved into the founding statement by
// statement, the money of 048 kept as it was, the old seam dropped, and nothing else
// -- no table, no view, no trigger, no ledger row -- touched.
func TestBranchCreationRequiresFundsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(branchCreationRequiresFundsMigration)
	if err != nil {
		t.Fatal("the branch creation migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The founding, restated whole, with the two mandatory amounts first.
		"CREATE OR REPLACE FUNCTION create_branch_funded(branch_name text, opening_cash numeric,",
		"purchase_fund numeric, creator_account_id integer) RETURNS smallint LANGUAGE plpgsql AS $$",
		"IF opening_cash IS NULL OR purchase_fund IS NULL THEN",
		"MESSAGE='The founding of a branch states its opening cash and its purchase fund'",
		"IF opening_cash < 0 OR purchase_fund < 0 THEN",
		"MESSAGE='The opening of a branch is never negative'",
		// The allocation of 014, kept statement by statement and not rewritten.
		"PERFORM pg_advisory_xact_lock(21485914531180593);",
		"IF NOT EXISTS (SELECT 1 FROM initialization_metadata) THEN",
		"RAISE EXCEPTION 'catalog initialization is required';",
		"SELECT (max(id)::integer + 1)::smallint INTO branch_id FROM locations;",
		"INSERT INTO locations(id,name) VALUES(branch_id,branch_name);",
		// The money of 048, unchanged: the marker, the two openings and the zero rule.
		"PERFORM set_config('luson.branch_founding', branch_id::text, true);",
		"VALUES(branch_id,'aporte',opening_cash,'Fondo inicial de caja de la sucursal',",
		"VALUES(branch_id,'aporte',purchase_fund,'Fondo inicial de compras de la sucursal',",
		"PERFORM set_config('luson.branch_founding','',true);",
		"REVOKE ALL ON FUNCTION create_branch_funded(text,numeric,numeric,integer) FROM PUBLIC;",
		// And the door closed: the old seam is dropped, after the restatement.
		"DROP FUNCTION create_branch(text);",
		"COMMENT ON FUNCTION create_branch_funded(text,numeric,numeric,integer) IS",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the branch creation migration must state %q", required)
		}
	}

	// One function restated and one function dropped: no second replacement, so this
	// version cannot have rewritten a guard it does not own.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("049 restates the founding and nothing else, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 0 {
		t.Errorf("049 creates no function from scratch: the restatement replaces one, got %d", got)
	}
	if got := strings.Count(sql, "DROP FUNCTION"); got != 1 {
		t.Errorf("049 drops the old seam exactly once, got %d", got)
	}
	// Nothing is created and no settlement or other book is written: the two openings
	// of the founding are the only rows this version states, and each of them once.
	for _, forbidden := range []string{
		"CREATE TABLE", "CREATE VIEW", "CREATE TRIGGER", "ALTER TABLE",
		"INSERT INTO branch_closings", "UPDATE ", "DELETE FROM", "TRUNCATE",
		"DROP TABLE", "DROP FUNCTION create_branch_funded",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("049 replaces no ledger and writes no row: it must not use %q", forbidden)
		}
	}
	for _, once := range []string{
		"INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,",
		"INSERT INTO branch_fund_movements(branch_location_id,kind,amount,description,",
	} {
		if got := strings.Count(sql, once); got != 1 {
			t.Errorf("the founding states %q exactly once, got %d", once, got)
		}
	}

	// The new seam is installed before the old one is dropped, so no statement of this
	// file runs against a schema where the founding still needs the seam below it.
	restated := strings.Index(sql, "CREATE OR REPLACE FUNCTION create_branch_funded(")
	dropped := strings.Index(sql, "DROP FUNCTION create_branch(text);")
	if restated < 0 || dropped < 0 || restated > dropped {
		t.Errorf("the founding must be restated before the old seam is dropped: %d %d",
			restated, dropped)
	}
	// The decisions a reader has to be able to check without deriving them.
	for _, documented := range []string{"S1", "S3", "S4", "S12", "014", "048", "xmin", "190"} {
		if !strings.Contains(sql, documented) {
			t.Errorf("049 must document its own decision: %s", documented)
		}
	}
}

// branchFoundingFixture is the prefix applied through 049: the catalogue, one account
// per historical location, the administrator of location 1 and the initialization row
// the allocation requires.
func branchFoundingFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 49)
}

// TestBranchCreationDropsTheUnfundedSeam proves S1 on a live database: `create_branch(text)`
// no longer exists, so no caller can create a branch without stating its two amounts,
// and the founding still allocates and still writes them.
func TestBranchCreationDropsTheUnfundedSeam(t *testing.T) {
	ctx, p := branchFoundingFixture(t)

	// The function is gone from the schema, not merely unused: a caller's name no
	// longer resolves to a body without money.
	var functions int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM pg_proc WHERE proname='create_branch'`).
		Scan(&functions); err != nil || functions != 0 {
		t.Fatalf("create_branch(text) must not exist any more, got %d: %v", functions, err)
	}
	_, err := p.Exec(ctx, `SELECT create_branch('Sucursal C')`)
	execRefusalMessage(t, err, "42883", "does not exist")
	var branches int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM locations`).Scan(&branches); err != nil ||
		branches != 3 {
		t.Fatalf("a call to the dropped seam creates no branch, got %d: %v", branches, err)
	}
	// The founding is still not everybody's call.
	var publicGrants int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM pg_proc function,
         aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) grant_right
         WHERE function.proname='create_branch_funded' AND grant_right.grantee=0`).
		Scan(&publicGrants); err != nil || publicGrants != 0 {
		t.Fatalf("the founding stays revoked from PUBLIC, got %d grants: %v", publicGrants, err)
	}
	t.Logf("049: nothing creates a branch without stating its two amounts")
}

// TestBranchCreationKeepsTheFounding proves S2, S3 and S12 on a live database: the one
// way to create a branch still allocates the next identity of the catalogue, still
// writes the two openings of the two ledgers signed by the administrator, still admits
// 0,00 without writing a movement, and still leaves nothing behind when it fails.
func TestBranchCreationKeepsTheFounding(t *testing.T) {
	ctx, p := branchFoundingFixture(t)

	branch := founding(t, ctx, p, "Sucursal C", "500.00", "300.00", 1)
	if branch != 4 {
		t.Fatalf("the founding allocates the next branch identity, got %d", branch)
	}
	var drawer, fund, name string
	if err := p.QueryRow(ctx, `SELECT name FROM locations WHERE id=$1`, branch).Scan(&name); err != nil ||
		name != "Sucursal C" {
		t.Fatalf("the founding creates the branch it names: %q %v", name, err)
	}
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount::text||':'||created_by_account_id,
         ',' ORDER BY id) FROM branch_cash_movements WHERE branch_location_id=$1`, branch).
		Scan(&drawer); err != nil || drawer != "aporte:500.00:1" {
		t.Fatalf("the drawer's opening is an aporte of 500.00 signed by the admin: %q %v",
			drawer, err)
	}
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount::text||':'||created_by_account_id,
         ',' ORDER BY id) FROM branch_fund_movements WHERE branch_location_id=$1`, branch).
		Scan(&fund); err != nil || fund != "aporte:300.00:1" {
		t.Fatalf("the fund's opening is an aporte of 300.00 signed by the admin: %q %v",
			fund, err)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "300.00" {
		t.Fatalf("the branch starts with the fund it was founded with, got %s", balance)
	}
	// The stock fanout of the branch is the one 014 installed and this version keeps:
	// every catalogue variant of the fixture, at zero.
	var balances, variants int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM catalog_variants`).Scan(&variants); err != nil {
		t.Fatal("the catalogue of the fixture could not be counted", err)
	}
	if err := p.QueryRow(ctx, `SELECT count(*) FROM inventory_balances
         WHERE location_id=$1 AND existing=0 AND reserved=0`, branch).Scan(&balances); err != nil ||
		balances != variants || variants == 0 {
		t.Fatalf("the founding fans out the zero-stock matrix, got %d of %d rows: %v",
			balances, variants, err)
	}

	// 0,00 is an explicit answer and it writes no movement (S3).
	zero := founding(t, ctx, p, "Sucursal D", "0.00", "0.00", 1)
	if zero != 5 {
		t.Fatalf("a branch founded with 0,00 is still a branch, got %d", zero)
	}
	if ledger := fundLedger(t, ctx, p); !strings.HasPrefix(ledger, "4:aporte:300.00:") ||
		strings.Contains(ledger, "5:") {
		t.Fatalf("a founding of 0,00 writes no movement of the fund, got %q", ledger)
	}

	// The founding is one transaction (S12): a branch the locations table refuses
	// leaves no identity, no opening and no audience behind. An empty name is the
	// refusal 014's own check states, kept as it was.
	_, err := p.Exec(ctx, `SELECT create_branch_funded('','500.00','300.00',1)`)
	execRefusalMessage(t, err, "23514", "violates check constraint")
	var leftover int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM locations WHERE id > 5`).Scan(&leftover); err != nil ||
		leftover != 0 {
		t.Fatalf("a refused founding creates no branch, got %d: %v", leftover, err)
	}
	t.Logf("049: the founding is the only way in and it still allocates, funds and rolls back")
}

// TestBranchCreationRequiresAnInitializedCatalogue proves the previous behaviour of the
// allocation this version moved into the founding: `create_branch(text)` refused to
// allocate anything before the catalogue was initialized, and the founding states that
// same refusal, before it consumes an identity or writes any money.
func TestBranchCreationRequiresAnInitializedCatalogue(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 49)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash)
 VALUES(1,1,'almacen','x'),(2,2,'sucursal_a','x'),(3,3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	_, err := p.Exec(ctx, `SELECT create_branch_funded('Sucursal C','500.00','300.00',1)`)
	execRefusalMessage(t, err, "P0001", "catalog initialization is required")
	var branches, movements int
	if err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM locations),
         (SELECT count(*) FROM branch_cash_movements)
         + (SELECT count(*) FROM branch_fund_movements)`).Scan(&branches, &movements); err != nil ||
		branches != 3 || movements != 0 {
		t.Fatalf("a refused founding leaves no branch and no money, got %d and %d: %v",
			branches, movements, err)
	}
}
