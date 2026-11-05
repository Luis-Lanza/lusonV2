package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// The serialization migration only replaces function bodies: it adds no table, no
// constraint and no new write path, and it must not silently touch anything else.
func TestCatalogFanoutSerializationStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("029_catalog_fanout_serialization.sql")
	if err != nil {
		t.Fatal("serialization migration must be embedded", err)
	}
	sql := statements(string(b))
	// Both fan-outs must take the same initialization lock the branch creator holds,
	// or a branch and a variant created concurrently can each miss the other and the
	// missing balance row is permanent.
	if got := strings.Count(sql, "pg_advisory_xact_lock(21485914531180593)"); got != 2 {
		t.Fatalf("both fan-outs must serialize on the initialization lock: found %d lock calls", got)
	}
	for _, required := range []string{
		"CREATE OR REPLACE FUNCTION initialize_branch_inventory()",
		"CREATE OR REPLACE FUNCTION initialize_variant_inventory()",
		"CREATE OR REPLACE FUNCTION guard_catalog_variant_identity()",
		"CONSTRAINT='catalog_variant_retired_battery'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("serialization migration is incomplete: missing %s", required)
		}
	}
	for _, forbidden := range []string{"CREATE TABLE", "ALTER TABLE", "DROP TRIGGER", "DROP FUNCTION"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the serialization migration must only replace function bodies: found %s", forbidden)
		}
	}
}

// TestCatalogVariantRetiredBattery runs on the admitted parent-owned PostgreSQL
// fixture; no skip path. The concurrency half of this migration cannot be asserted
// here: it was reproduced with two interleaved sessions and is described in the
// feature log.
func TestCatalogVariantRetiredBattery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	p := testpg.Open(t)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	var entry int64
	if err := p.QueryRow(ctx,
		"INSERT INTO catalog_entries(brand,model,capacity_ah) VALUES('RETIRED','55Ah',55) RETURNING id").Scan(&entry); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, "INSERT INTO catalog_variants(catalog_entry_id,polarity) VALUES($1,'L')", entry); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, "UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", entry); err != nil {
		t.Fatalf("a battery with no stock must be retirable: %v", err)
	}
	_, err := p.Exec(ctx, "INSERT INTO catalog_variants(catalog_entry_id,polarity) VALUES($1,'R')", entry)
	requirePgFailure(t, err, "23514", "catalog_variant_retired_battery")
}
