package migrations_test

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration026 is the reshape that moves a branch price from the variant to the
// battery (brand + model + capacity). Historical versions are applied as they are,
// so this constant names the one file the reshape owns.
const migration026 = "026_branch_prices_by_battery.sql"

// TestBranchPricesByBatterySchemaStructure pins the reshape as additive: it owns one
// historical table it must reshape, one index and one trigger function it must
// replace, and it never drops a table, a guard or a column of the sale document.
func TestBranchPricesByBatterySchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration026)
	if err != nil {
		t.Fatal("the battery price reshape must be embedded", err)
	}
	// Comments may name the untouched contract; only executable statements prove what
	// this migration does.
	sql := statements(string(b))
	for _, required := range []string{
		// The entry column is added before anything is backfilled from it.
		"ALTER TABLE branch_prices ADD COLUMN catalog_entry_id integer REFERENCES catalog_entries(id)",
		// The backfill reads the battery of the variant the old row was keyed by.
		"UPDATE branch_prices p",
		"SET catalog_entry_id = v.catalog_entry_id",
		"FROM catalog_variants v",
		"WHERE v.id = p.variant_id",
		"ALTER TABLE branch_prices ALTER COLUMN catalog_entry_id SET NOT NULL",
		// The old key, its reverse index and its column go away in that order.
		"ALTER TABLE branch_prices DROP CONSTRAINT branch_prices_pkey",
		"DROP INDEX branch_prices_variant",
		"ALTER TABLE branch_prices DROP COLUMN variant_id",
		// The new key is the battery of the branch, so two polarities cannot diverge.
		"ADD CONSTRAINT branch_prices_pkey PRIMARY KEY (branch_location_id, catalog_entry_id)",
		"CREATE INDEX branch_prices_entry ON branch_prices(catalog_entry_id)",
		// The sale line is still one variant: it resolves the pair through its battery.
		"CREATE OR REPLACE FUNCTION apply_sale_line()",
		"SELECT catalog_entry_id INTO entry_id FROM catalog_variants WHERE id=NEW.variant_id",
		"WHERE branch_location_id=header.branch_location_id AND catalog_entry_id=entry_id",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Additive means the reshape touches the price table only: the sale document, the
	// warranty table and every other historical table stay exactly as 024 and 025 left
	// them.
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "ALTER TABLE ") {
			continue
		}
		if !strings.HasPrefix(trimmed, "ALTER TABLE branch_prices ") {
			t.Errorf("the reshape must alter the price table only: %s", trimmed)
		}
	}
	if strings.Contains(sql, "DROP TABLE") {
		t.Fatal("the reshape must not drop a table")
	}
	// The warranty table of 024 stays in the database unused, and no statement of the
	// reshape touches it.
	if strings.Contains(sql, "variant_warranties") {
		t.Fatal("the reshape must leave the unused warranty table untouched")
	}
	// The sale line is still one variant and the document is never rewritten here.
	for _, forbidden := range []string{
		"ALTER TABLE sales", "ALTER TABLE sale_lines", "DROP TABLE sales", "DROP TABLE sale_lines",
		"DROP COLUMN variant_id FROM sale_lines",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("the reshape must leave the sale document untouched: %s", forbidden)
		}
	}
	// Exactly one historical function is replaced, and it is the sale line trigger.
	if n := strings.Count(sql, "CREATE OR REPLACE"); n != 1 {
		t.Fatalf("the reshape must replace exactly one function, got %d", n)
	}
	if strings.Contains(sql, "CREATE OR REPLACE FUNCTION admit_branch_price") ||
		strings.Contains(sql, "CREATE OR REPLACE FUNCTION admit_sale") ||
		strings.Contains(sql, "CREATE OR REPLACE FUNCTION require_sale_total") {
		t.Fatal("the reshape must not redefine another historical function")
	}
	// The row guards of 024 stay installed and are enabled again after the dedupe, so
	// the reshape cannot silently leave the table unprotected.
	for _, required := range []string{
		"ALTER TABLE branch_prices DISABLE TRIGGER protect_branch_prices",
		"ALTER TABLE branch_prices ENABLE TRIGGER protect_branch_prices",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the replace-not-delete guard must be managed explicitly: missing %s", required)
		}
	}
	if strings.Contains(sql, "DROP TRIGGER") {
		t.Fatal("the reshape must not drop a price guard")
	}
	// A silent delete without the documented window would be an unexplained data loss.
	comment := string(b)
	if !strings.Contains(comment, "most recently updated") {
		t.Fatal("the duplicate resolution must be documented in the migration")
	}
}

// applyMigrationRange applies the embedded versions up to and including last, exactly
// like the runner does: one file, one statement batch, in version order.
func applyMigrationRange(t *testing.T, ctx context.Context, p *pgxpool.Pool, last int) {
	t.Helper()
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal("embedded migrations are unreadable")
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		version, err := strconv.Atoi(strings.SplitN(name, "_", 2)[0])
		if err != nil || version > last {
			continue
		}
		sql, err := migrations.Files.ReadFile(name)
		if err != nil {
			t.Fatalf("embedded migration %s is unreadable", name)
		}
		if _, err := p.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("migration %s failed: %v", name, err)
		}
	}
}

// TestBranchPricesByBatteryReshapeBackfill proves the reshape on a real database that
// still has the variant-keyed shape: two rows of the same battery in one branch
// collapse into the single battery row, the most recently updated one wins, another
// battery of the same branch is kept, and the new key refuses a second row for the
// same battery.
func TestBranchPricesByBatteryReshapeBackfill(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 25)
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("the pre-reshape dataset could not be seeded")
	}
	// Three branches with their own account, exactly like the provisioned trial.
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the pre-reshape accounts could not be provisioned")
	}
	// Variant 1 (L) and variant 2 (R) are the two polarities of catalogue entry 1;
	// variant 3 is the other battery. The variant-keyed table admits one price per
	// polarity, so the fixture writes both and makes the R row the newer one.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,variant_id,min_price,suggested_price,updated_by_account_id,updated_at) VALUES
 (2,1,1000.00,1200.00,1,'2026-11-01T10:00:00Z'),
 (2,2,2000.00,2500.00,1,'2026-11-02T10:00:00Z'),
 (2,3,5000.00,6000.00,1,'2026-11-01T10:00:00Z'),
 (3,1,1100.00,1300.00,1,'2026-11-03T10:00:00Z')`); err != nil {
		t.Fatalf("the variant-keyed price fixture failed: %v", err)
	}
	reshape, err := migrations.Files.ReadFile(migration026)
	if err != nil {
		t.Fatal("the battery price reshape must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(reshape)); err != nil {
		t.Fatalf("the battery price reshape failed on a live database: %v", err)
	}
	// One row per (branch, battery): the two polarity rows collapsed into the newer
	// one, and the shape no longer has a polarity column at all.
	var rows, variantColumns int
	if err := p.QueryRow(ctx, "SELECT count(*) FROM branch_prices WHERE branch_location_id=2 AND catalog_entry_id=1").Scan(&rows); err != nil {
		t.Fatal("the reshaped price rows could not be read")
	}
	if rows != 1 {
		t.Fatalf("one battery row per branch must remain, got %d", rows)
	}
	if err := p.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='branch_prices' AND column_name='variant_id'`).Scan(&variantColumns); err != nil {
		t.Fatal("the reshaped price columns could not be read")
	}
	if variantColumns != 0 {
		t.Fatal("the variant key must be gone from the price table")
	}
	var min, suggested string
	if err := p.QueryRow(ctx, `SELECT min_price::text,suggested_price::text FROM branch_prices
 WHERE branch_location_id=2 AND catalog_entry_id=1`).Scan(&min, &suggested); err != nil {
		t.Fatal("the collapsed pair could not be read")
	}
	// The most recently updated row of the pair wins, deterministically.
	if min != "2000.00" || suggested != "2500.00" {
		t.Fatalf("the most recently updated row must survive the collapse: %s/%s", min, suggested)
	}
	// The other battery of the same branch and the other branch are untouched.
	if err := p.QueryRow(ctx, `SELECT min_price::text FROM branch_prices
 WHERE branch_location_id=2 AND catalog_entry_id=2`).Scan(&min); err != nil {
		t.Fatal("a sibling battery of the same branch must be kept")
	}
	if min != "5000.00" {
		t.Fatalf("a sibling battery was rewritten by the collapse: %s", min)
	}
	if err := p.QueryRow(ctx, `SELECT min_price::text FROM branch_prices
 WHERE branch_location_id=3 AND catalog_entry_id=1`).Scan(&min); err != nil {
		t.Fatal("the same battery in another branch must be kept")
	}
	if min != "1100.00" {
		t.Fatalf("another branch's battery row was rewritten: %s", min)
	}
	if n := countRows(t, ctx, p, "SELECT count(*) FROM branch_prices"); n != 3 {
		t.Fatalf("the reshape must keep one row per kept pair, got %d", n)
	}
	// The new primary key is the battery: a second row for the same battery of the
	// same branch is refused, so L and R can never hold different prices.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,9000.00,9900.00,1)`); err == nil {
		t.Fatal("a second price row of the same battery in one branch must be refused")
	}
	// The replace-not-delete guard is enabled again after the dedupe window.
	if _, err := p.Exec(ctx, "DELETE FROM branch_prices WHERE branch_location_id=3 AND catalog_entry_id=1"); err == nil {
		t.Fatal("the reshape must leave the replace-not-delete guard enabled")
	}
	// The reshaped table still refuses the warehouse, exactly like 024 did.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(1,1,9000.00,9900.00,1)`); err == nil {
		t.Fatal("the warehouse must never keep a branch price")
	}
	// A sale resolves the pair through the battery: both polarities of entry 1 are
	// sellable at the branch 2 pair, and the document is one transaction because its
	// total is a deferred constraint of 025.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the sale fixture transaction failed")
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var sale int64
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,payment_method,customer_name,total,created_by_account_id)
 VALUES(2,'cash','Cliente',4400.00,2) RETURNING id`).Scan(&sale); err != nil {
		t.Fatalf("the sale fixture failed: %v", err)
	}
	for _, line := range []struct {
		variant int
		unit    string
		want    string
	}{{1, "2000.00", "2000.00"}, {2, "2400.00", "2000.00"}} {
		if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,$2,1,$3,6)`, sale, line.variant, line.unit); err != nil {
			t.Fatalf("the polarity %d of the battery must be sellable: %v", line.variant, err)
		}
		var frozen string
		if err := tx.QueryRow(ctx, `SELECT min_price::text FROM sale_lines WHERE sale_id=$1 AND variant_id=$2`,
			sale, line.variant).Scan(&frozen); err != nil {
			t.Fatal("the frozen floor could not be read")
		}
		if frozen != line.want {
			t.Fatalf("the frozen floor must be the battery's: %s", frozen)
		}
	}
	// A polarity of the same battery under the battery floor is refused by the trigger
	// the reshape replaced.
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,1,1,1999.99,6)`, sale); err == nil {
		t.Fatal("a line under the battery floor must be refused")
	}
}

// countRows reads one count with its own scratch statement, so the assertions above
// never depend on the store this reshape belongs to.
func countRows(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string) int64 {
	t.Helper()
	var n int64
	if err := p.QueryRow(ctx, query).Scan(&n); err != nil {
		t.Fatal("count query failed")
	}
	return n
}
