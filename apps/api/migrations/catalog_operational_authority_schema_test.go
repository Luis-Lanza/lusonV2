package migrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// The catalog migration is additive over the frozen schema: it converts the
// preloaded fixture into an initial seed and never rewrites a historical version.
func TestCatalogOperationalAuthorityStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("028_catalog_operational_authority.sql")
	if err != nil {
		t.Fatal("catalog authority migration must be embedded", err)
	}
	// Comments may name the untouched contract; only executable statements prove
	// what this migration does.
	sql := statements(string(b))
	for _, required := range []string{
		"ALTER TABLE catalog_entries ADD COLUMN deleted_at timestamptz",
		"ALTER TABLE catalog_entries DROP CONSTRAINT catalog_entries_brand_model_key",
		"CREATE UNIQUE INDEX catalog_entries_active_brand_model",
		"WHERE deleted_at IS NULL",
		"ALTER TABLE catalog_entries DROP CONSTRAINT catalog_entries_id_check",
		"ALTER TABLE catalog_variants DROP CONSTRAINT catalog_variants_id_check",
		"CREATE SEQUENCE catalog_entries_id_seq AS integer START WITH 96 OWNED BY catalog_entries.id",
		"CREATE SEQUENCE catalog_variants_id_seq AS integer START WITH 191 OWNED BY catalog_variants.id",
		"ALTER TABLE catalog_entries ALTER COLUMN id SET DEFAULT nextval('catalog_entries_id_seq')",
		"ALTER TABLE catalog_variants ALTER COLUMN id SET DEFAULT nextval('catalog_variants_id_seq')",
		"CREATE FUNCTION catalog_entry_retirement_blocker(entry_id integer) RETURNS text",
		"RETURN 'stock'",
		"RETURN 'operations'",
		"CREATE TRIGGER lock_catalog_retirement BEFORE UPDATE ON catalog_entries",
		"DROP TRIGGER protect_entries ON catalog_entries",
		"DROP TRIGGER protect_variants ON catalog_variants",
		"CONSTRAINT='catalog_entry_deletion_forbidden'",
		"CONSTRAINT='catalog_retirement_blocked'",
		"CONSTRAINT='catalog_entry_retired_immutable'",
		"CONSTRAINT='catalog_entry_identity_immutable'",
		"CONSTRAINT='catalog_variant_immutable'",
		"CREATE FUNCTION initialize_variant_inventory() RETURNS trigger",
		"CREATE TRIGGER initialize_variant_stock AFTER INSERT ON catalog_variants",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("catalog authority migration is incomplete: missing %s", required)
		}
	}
	// Truncate guards and initialization metadata stay immutable: this migration
	// grants operational writes, not a data reset path.
	for _, forbidden := range []string{
		"DROP TRIGGER protect_entries_truncate",
		"DROP TRIGGER protect_variants_truncate",
		"DROP TRIGGER protect_metadata_truncate",
		"DROP TRIGGER protect_initialization_metadata",
		"DELETE FROM catalog_entries",
		"DELETE FROM catalog_variants",
		"TRUNCATE",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the catalog migration must not weaken the reset guard: found %s", forbidden)
		}
	}
}

// requirePgFailure asserts the exact database-level refusal, so a spec violation
// cannot pass as a generic error.
func requirePgFailure(t *testing.T, err error, code, constraint string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected database refusal %s", constraint)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("expected a PostgreSQL refusal %s, got %v", constraint, err)
	}
	if pgErr.Code != code || pgErr.ConstraintName != constraint {
		t.Fatalf("expected %s/%s, got %s/%s", code, constraint, pgErr.Code, pgErr.ConstraintName)
	}
}

// TestCatalogOperationalAuthority runs on the admitted parent-owned PostgreSQL
// fixture; no skip path.
func TestCatalogOperationalAuthority(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	p := testpg.Open(t)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	exec := func(t *testing.T, sql string, args ...any) {
		t.Helper()
		if _, err := p.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	create := func(t *testing.T, brand, model string) (entry int64, variant int64) {
		t.Helper()
		if err := p.QueryRow(ctx,
			"INSERT INTO catalog_entries(brand,model,capacity_ah) VALUES($1,$2,75) RETURNING id",
			brand, model).Scan(&entry); err != nil {
			t.Fatalf("a new battery must be insertable: %v", err)
		}
		if err := p.QueryRow(ctx,
			"INSERT INTO catalog_variants(catalog_entry_id,polarity) VALUES($1,'L') RETURNING id",
			entry).Scan(&variant); err != nil {
			t.Fatalf("a new variant must be insertable: %v", err)
		}
		return entry, variant
	}
	scalar := func(t *testing.T, query string, args ...any) int {
		t.Helper()
		var n int
		if err := p.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	t.Run("new_battery_is_allocated_and_stocked", func(t *testing.T) {
		entry, variant := create(t, "NUEVA", "75Ah")
		if entry <= 95 || variant <= 190 {
			t.Fatalf("identities past the fixture must be allocated, got %d/%d", entry, variant)
		}
		// Every active branch carries a balance row, zero stock, no reservation.
		active := scalar(t, "SELECT count(*) FROM locations WHERE deleted_at IS NULL")
		if got := scalar(t, `SELECT count(*) FROM inventory_balances WHERE variant_id=$1 AND existing=0 AND reserved=0`, variant); got != active {
			t.Fatalf("a new variant needs one zero balance per active branch: got %d want %d", got, active)
		}
	})

	t.Run("editing_an_active_battery_is_allowed", func(t *testing.T) {
		entry, _ := create(t, "EDITABLE", "60Ah")
		exec(t, "UPDATE catalog_entries SET brand='EDITADA', capacity_ah=62.5 WHERE id=$1", entry)
		if got := scalar(t, "SELECT count(*) FROM catalog_entries WHERE id=$1 AND brand='EDITADA' AND capacity_ah=62.5", entry); got != 1 {
			t.Fatal("an active battery must be editable")
		}
	})

	t.Run("deletion_is_refused", func(t *testing.T) {
		entry, variant := create(t, "BORRABLE", "55Ah")
		_, err := p.Exec(ctx, "DELETE FROM catalog_variants WHERE id=$1", variant)
		requirePgFailure(t, err, "23514", "catalog_variant_immutable")
		_, err = p.Exec(ctx, "DELETE FROM catalog_entries WHERE id=$1", entry)
		requirePgFailure(t, err, "23514", "catalog_entry_deletion_forbidden")
	})

	t.Run("retirement_requires_no_stock_and_is_one_way", func(t *testing.T) {
		entry, variant := create(t, "ARCHIVABLE", "70Ah")
		exec(t, "UPDATE inventory_balances SET existing=4 WHERE variant_id=$1 AND location_id=1", variant)
		_, err := p.Exec(ctx, "UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", entry)
		requirePgFailure(t, err, "23514", "catalog_retirement_blocked")
		exec(t, "UPDATE inventory_balances SET existing=0 WHERE variant_id=$1", variant)
		exec(t, "UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", entry)
		_, err = p.Exec(ctx, "UPDATE catalog_entries SET brand='OTRA' WHERE id=$1", entry)
		requirePgFailure(t, err, "23514", "catalog_entry_retired_immutable")
		_, err = p.Exec(ctx, "UPDATE catalog_entries SET deleted_at=NULL WHERE id=$1", entry)
		requirePgFailure(t, err, "23514", "catalog_entry_identity_immutable")
		// The archived identity frees its (brand, model) pair for a new battery.
		if _, err := p.Exec(ctx, "INSERT INTO catalog_entries(brand,model,capacity_ah) VALUES('ARCHIVABLE','70Ah',70)"); err != nil {
			t.Fatalf("an archived identity must free its brand and model: %v", err)
		}
	})

	t.Run("a_pending_operation_blocks_retirement", func(t *testing.T) {
		entry, variant := create(t, "CON_PENDIENTE", "90Ah")
		// A pending header alone is not a legal request: completeness is a deferred
		// constraint and an item may only be inserted by the transaction that created
		// its header. One statement is one transaction, so the header and its item are
		// written together, exactly like the sibling schema test builds a request.
		var request int64
		if err := p.QueryRow(ctx, `WITH request AS (
INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256)
VALUES(2,'request_stock',1,2,1,'028pendingoperation1',sha256('028'::bytea)) RETURNING id)
INSERT INTO transfer_request_items(request_id,variant_id,quantity)
SELECT id,$1,1 FROM request RETURNING request_id`, variant).Scan(&request); err != nil {
			t.Fatalf("a pending transfer with its item must be insertable: %v", err)
		}
		if got := scalar(t, "SELECT count(*) FROM transfer_request_items WHERE request_id=$1 AND variant_id=$2", request, variant); got != 1 {
			t.Fatalf("the pending transfer must own its item, got %d", got)
		}
		// The blocker has to be the operation, not stock: the battery was just created
		// and every active branch carries a zero balance for it.
		if got := scalar(t, "SELECT count(*) FROM inventory_balances b JOIN catalog_variants v ON v.id=b.variant_id WHERE v.catalog_entry_id=$1 AND (b.existing<>0 OR b.reserved<>0)", entry); got != 0 {
			t.Fatalf("the retirement must not be blocked by stock, got %d stocked balances", got)
		}
		_, err := p.Exec(ctx, "UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", entry)
		requirePgFailure(t, err, "23514", "catalog_retirement_blocked")
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Message != "Battery retirement blocked: operations" {
			t.Fatalf("the pending operation must be the blocker, got %v", err)
		}
		if got := scalar(t, "SELECT count(*) FROM catalog_entries WHERE id=$1 AND deleted_at IS NULL", entry); got != 1 {
			t.Fatal("a refused retirement must leave the battery active")
		}
	})
}
