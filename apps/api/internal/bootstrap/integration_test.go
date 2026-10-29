package bootstrap_test

import (
	"context"
	"io/fs"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// These tests require the admitted parent-owned PostgreSQL fixture; no skip path.
func TestPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	fresh := testpg.Open
	initialize := func(t *testing.T, p *pgxpool.Pool) {
		t.Helper()
		if err := db.Apply(ctx, p); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
			t.Fatal(err)
		}
	}
	scalar := func(t *testing.T, p *pgxpool.Pool, query string) int {
		t.Helper()
		var n int
		if err := p.QueryRow(ctx, query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	t.Run("schema_seed_and_preservation", func(t *testing.T) {
		p := fresh(t)
		initialize(t, p)
		migrationFiles, err := fs.Glob(migrations.Files, "*.sql")
		if err != nil {
			t.Fatal(err)
		}
		for table, want := range map[string]int{"schema_migrations": len(migrationFiles), "locations": 3, "catalog_entries": 95, "catalog_variants": 190, "inventory_balances": 570, "initialization_metadata": 1} {
			if n := scalar(t, p, "SELECT count(*) FROM "+table); n != want {
				t.Fatalf("%s count %d, want %d", table, n, want)
			}
		}
		if n := scalar(t, p, "SELECT count(DISTINCT brand) FROM catalog_entries"); n != 11 {
			t.Fatal(n)
		}
		if n := scalar(t, p, "SELECT count(*) FROM catalog_entries WHERE capacity_ah=6.5 AND ((brand='TOYO_MOTO' AND model='12N6,5_3B') OR (brand='ULTRON_MOTO' AND model='YB6,5_BS'))"); n != 2 {
			t.Fatal("fractional source capacities lost")
		}
		if n := scalar(t, p, "SELECT count(*) FROM catalog_entries e WHERE (SELECT count(*) FROM catalog_variants v WHERE v.catalog_entry_id=e.id AND v.polarity IN ('L','R'))=2"); n != 95 {
			t.Fatal("polarity inference replaced explicit variants")
		}
		if n := scalar(t, p, "SELECT count(*) FROM locations WHERE (id=1 AND name='Almacén') OR (id=2 AND name='Sucursal A') OR (id=3 AND name='Sucursal B')"); n != 3 {
			t.Fatal("wrong location names")
		}
		if n := scalar(t, p, "SELECT count(*) FROM inventory_balances WHERE reserved<>0 OR available<>existing-reserved"); n != 0 {
			t.Fatal("phantom holds or availability mismatch")
		}
		if n := scalar(t, p, "SELECT count(*) FROM inventory_balances WHERE existing <> (variant_id*7+location_id*11)%31"); n != 0 {
			t.Fatal("trial seed is not deterministic")
		}
		if n := scalar(t, p, "SELECT count(DISTINCT location_id) FROM inventory_balances WHERE existing=0"); n != 3 {
			t.Fatal("missing zero stocks")
		}
		if n := scalar(t, p, "SELECT count(*) FROM inventory_balances a JOIN inventory_balances b USING(variant_id) WHERE a.location_id=1 AND b.location_id=2 AND a.existing<>b.existing"); n != 190 {
			t.Fatal("locations lack different stock")
		}
		if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=21,reserved=7 WHERE location_id=1 AND variant_id=1"); err != nil {
			t.Fatal(err)
		}
		initialize(t, p)
		initialize(t, p)
		if n := scalar(t, p, "SELECT count(*) FROM inventory_balances WHERE location_id=1 AND variant_id=1 AND existing=21 AND reserved=7 AND available=14"); n != 1 {
			t.Fatal("replay overwrote existing or reserved stock")
		}
		if err := db.Check(ctx, p); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Check(ctx, p); err != nil {
			t.Fatal(err)
		}
		if n := scalar(t, p, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name NOT IN ('schema_migrations','locations','catalog_entries','catalog_variants','inventory_balances','initialization_metadata','auth_accounts','auth_sessions','auth_throttle','transfer_requests','transfer_request_items','transfer_request_allocations','transfer_receipt_lines','transfer_receipt_exceptions','transfer_count_operations','transfer_count_proposals','transfer_count_decisions','transfer_count_applications','transfer_restitution_operations','transfer_restitution_proposals','transfer_restitution_decisions','transfer_restitution_applications','transfer_dispatch_operations','transfer_dispatch_proposals','transfer_dispatch_decisions','transfer_dispatch_applications','transfer_count_reconciliation_pins','transfer_restitution_reconciliation_pins','transfer_personal_activity','realtime_revisions')"); n != 0 {
			t.Fatal("unexpected domain tables")
		}
	})
	t.Run("constraints_and_immutability", func(t *testing.T) {
		p := fresh(t)
		initialize(t, p)
		for _, query := range []string{
			"UPDATE inventory_balances SET existing=-1 WHERE location_id=1 AND variant_id=1",
			"UPDATE inventory_balances SET reserved=-1 WHERE location_id=1 AND variant_id=1",
			"UPDATE inventory_balances SET reserved=existing+1 WHERE location_id=1 AND variant_id=1",
			"UPDATE inventory_balances SET existing=1.5::text::bigint WHERE location_id=1 AND variant_id=1",
			"UPDATE catalog_entries SET capacity_ah=0 WHERE id=1",
			"UPDATE catalog_entries SET model='changed' WHERE id=1",
			"DELETE FROM catalog_variants WHERE id=1",
			"INSERT INTO locations VALUES (0,'Other')",
		} {
			if _, err := p.Exec(ctx, query); err == nil {
				t.Fatalf("accepted invalid mutation: %s", query)
			}
		}
		// Constraints protect even initial inserts, before immutable sealing.
		q := fresh(t)
		if err := db.Apply(ctx, q); err != nil {
			t.Fatal(err)
		}
		for _, capacity := range []string{"0", "-1", "'NaN'", "'Infinity'"} {
			if _, err := q.Exec(ctx, "INSERT INTO catalog_entries VALUES (1,'X','Y',"+capacity+")"); err == nil {
				t.Fatal("accepted nonpositive/nonfinite capacity")
			}
		}
	})
	t.Run("production_and_partial_data", func(t *testing.T) {
		p := fresh(t)
		if err := bootstrap.Initialize(ctx, p, config.Production); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Check(ctx, p); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Initialize(ctx, p, config.Profile("unsupported")); err == nil {
			t.Fatal("unsupported profile accepted")
		}
		if err := bootstrap.Seed(ctx, p, config.Production); err == nil {
			t.Fatal("production accepted fictional seed")
		}
		if n := scalar(t, p, "SELECT count(*) FROM inventory_balances"); n != 0 {
			t.Fatal("production received fake stock")
		}
		if _, err := p.Exec(ctx, "INSERT INTO locations VALUES(1,'Almacén')"); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Seed(ctx, p, config.LocalTrial); err == nil {
			t.Fatal("partial dataset accepted")
		}
		if n := scalar(t, p, "SELECT count(*) FROM locations WHERE id=1 AND name='Almacén'"); n != 1 {
			t.Fatal("partial data overwritten")
		}
		q := fresh(t)
		initialize(t, q)
		if _, err := q.Exec(ctx, "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=1"); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Seed(ctx, q, config.LocalTrial); err == nil {
			t.Fatal("incomplete initialized balances reseeded")
		}
		if n := scalar(t, q, "SELECT count(*) FROM inventory_balances"); n != 569 {
			t.Fatal("replay repaired operational data")
		}
	})
	t.Run("seed_rollback", func(t *testing.T) {
		p := fresh(t)
		if err := db.Apply(ctx, p); err != nil {
			t.Fatal(err)
		}
		if _, err := p.Exec(ctx, `CREATE FUNCTION fail_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_seed BEFORE INSERT ON inventory_balances FOR EACH ROW EXECUTE FUNCTION fail_seed()`); err != nil {
			t.Fatal(err)
		}
		if err := bootstrap.Seed(ctx, p, config.LocalTrial); err == nil {
			t.Fatal("injected seed failure ignored")
		}
		for _, table := range []string{"catalog_entries", "catalog_variants", "locations", "inventory_balances", "initialization_metadata"} {
			if n := scalar(t, p, "SELECT count(*) FROM "+table); n != 0 {
				t.Fatalf("partial seed committed to %s", table)
			}
		}
	})
	t.Run("migration_rollback_and_drift", func(t *testing.T) {
		p := fresh(t)
		if _, err := p.Exec(ctx, "CREATE TABLE inventory_balances(blocker integer)"); err != nil {
			t.Fatal(err)
		}
		if err := db.Apply(ctx, p); err == nil {
			t.Fatal("migration collision ignored")
		}
		var exists bool
		if err := p.QueryRow(ctx, "SELECT to_regclass('schema_migrations') IS NOT NULL").Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatal("failed migration committed tracking table")
		}
		q := fresh(t)
		if err := db.Apply(ctx, q); err != nil {
			t.Fatal(err)
		}
		if _, err := q.Exec(ctx, "UPDATE schema_migrations SET checksum='tampered'"); err != nil {
			t.Fatal(err)
		}
		if err := db.Apply(ctx, q); err == nil {
			t.Fatal("migration drift accepted")
		}
	})
	t.Run("concurrent_initialization", func(t *testing.T) {
		p := fresh(t)
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := db.Apply(ctx, p); err != nil {
					errs <- err
					return
				}
				errs <- bootstrap.Seed(ctx, p, config.LocalTrial)
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		if n := scalar(t, p, "SELECT count(*) FROM inventory_balances"); n != 570 {
			t.Fatal(n)
		}
	})
}
