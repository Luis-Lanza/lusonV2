package migrations_test

import (
	"context"
	"sort"
	"strings"
	"testing"
	"time"

	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// initializationLock is the lock the branch creator already holds. Naming the
// literal once keeps the assertion and the migrations reading the same value.
const initializationLock = "pg_advisory_xact_lock(21485914531180593)"

// balanceFanouts returns the body of every function in a migration that writes the
// branch x variant matrix. The set is derived from the bodies rather than from a
// hardcoded count, so a third fan-out joins the invariant instead of turning the
// assertion red for the wrong reason.
func balanceFanouts(sql string) map[string]string {
	bodies := map[string]string{}
	for _, part := range strings.Split(statements(sql), "CREATE OR REPLACE FUNCTION ")[1:] {
		name, rest, ok := strings.Cut(part, "(")
		if !ok {
			continue
		}
		open := strings.Index(rest, "$$")
		if open < 0 {
			continue
		}
		body := rest[open+2:]
		end := strings.Index(body, "$$")
		if end < 0 {
			continue
		}
		if body = body[:end]; strings.Contains(body, "INSERT INTO inventory_balances") {
			bodies[strings.TrimSpace(name)] = body
		}
	}
	return bodies
}

// unlockedFanouts names every balance fan-out that does not take the initialization
// lock. Empty means each one serializes with the branch creator.
func unlockedFanouts(sql string) []string {
	missing := []string{}
	for name, body := range balanceFanouts(sql) {
		if !strings.Contains(body, initializationLock) {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	return missing
}

// A per-function assertion is the invariant itself. Counting total occurrences would
// turn red when a third fan-out appears and green when one of the two loses its lock
// while an unrelated call keeps the count up, so each dangerous shape is pinned here.
func TestFanoutLockAssertionIsPerFunction(t *testing.T) {
	fanout := func(name string, locked bool) string {
		body := "INSERT INTO inventory_balances(location_id,variant_id) SELECT l.id,NEW.id;"
		if locked {
			body = "PERFORM " + initializationLock + ";\n        " + body
		}
		return "CREATE OR REPLACE FUNCTION " + name + "() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n        " + body + "\n    RETURN NEW;\nEND;\n$$;\n"
	}
	unrelated := "CREATE OR REPLACE FUNCTION guard_elsewhere() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n    PERFORM " + initializationLock + ";\n    RETURN NEW;\nEND;\n$$;\n"
	branch, variant := "initialize_branch_inventory", "initialize_variant_inventory"
	for name, tc := range map[string]struct {
		sql  string
		want string
	}{
		"both fan-outs locked":                {fanout(branch, true) + fanout(variant, true), ""},
		"branch fan-out lost its lock":        {fanout(branch, false) + fanout(variant, true), branch},
		"variant fan-out lost its lock":       {fanout(branch, true) + fanout(variant, false), variant},
		"a third fan-out is added":            {fanout(branch, true) + fanout(variant, true) + fanout("initialize_price_inventory", true), ""},
		"an unrelated lock call appears":      {fanout(branch, true) + fanout(variant, true) + unrelated, ""},
		"an unrelated lock hides nothing":     {fanout(branch, true) + fanout(variant, false) + unrelated, variant},
		"a third fan-out without the lock":    {fanout(branch, true) + fanout(variant, true) + fanout("initialize_price_inventory", false), "initialize_price_inventory"},
		"two fan-outs without any lock":       {fanout(branch, false) + fanout(variant, false), branch + "," + variant},
		"a migration with no balance fan-out": {"CREATE OR REPLACE FUNCTION guard_elsewhere() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n    RETURN NEW;\nEND;\n$$;\n", ""},
	} {
		t.Run(name, func(t *testing.T) {
			if got := strings.Join(unlockedFanouts(tc.sql), ","); got != tc.want {
				t.Fatalf("unlocked fan-outs: want %q, got %q", tc.want, got)
			}
		})
	}
}

// The serialization migration only replaces function bodies: it adds no table, no
// constraint and no new write path, and it must not silently touch anything else.
func TestCatalogFanoutSerializationStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("029_catalog_fanout_serialization.sql")
	if err != nil {
		t.Fatal("serialization migration must be embedded", err)
	}
	sql := statements(string(b))
	// Recognize the fan-outs by what they write, then prove the recognized set still
	// holds both of them, so the per-function assertion can never go vacuous.
	bodies := balanceFanouts(sql)
	for _, name := range []string{"initialize_branch_inventory", "initialize_variant_inventory"} {
		if _, ok := bodies[name]; !ok {
			t.Fatalf("serialization migration is incomplete: %s is missing", name)
		}
	}
	// Both fan-outs must take the same initialization lock the branch creator holds,
	// or a branch and a variant created concurrently can each miss the other and the
	// missing balance row is permanent. One assertion per function: an occurrence
	// count is satisfied by any unrelated lock call and broken by a third fan-out.
	if missing := unlockedFanouts(sql); len(missing) != 0 {
		t.Fatalf("every balance fan-out must serialize on the initialization lock: %v do not", missing)
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

// 029 is applied and checksummed, so the balance-matrix rule for retired batteries
// lands in a new, forward-only migration that may only narrow the branch fan-out.
func TestBranchFanoutSkipsRetiredBatteriesStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("030_branch_fanout_skips_retired_batteries.sql")
	if err != nil {
		t.Fatal("branch fan-out migration must be embedded", err)
	}
	sql := statements(string(b))
	bodies := balanceFanouts(sql)
	branch, ok := bodies["initialize_branch_inventory"]
	if !ok {
		t.Fatalf("the migration must replace the branch balance fan-out: found %d", len(bodies))
	}
	// Only the branch fan-out changes: the variant fan-out is untouched by 030.
	if len(bodies) != 1 {
		t.Fatalf("the migration must replace exactly the branch fan-out, found %d", len(bodies))
	}
	// The narrowing must not drop the serialization the concurrent-branch defect required.
	if !strings.Contains(branch, initializationLock) {
		t.Error("the narrowed branch fan-out must keep the initialization lock")
	}
	// A retired battery's variants are not part of the operating matrix.
	for _, required := range []string{"JOIN catalog_entries", "e.deleted_at IS NULL"} {
		if !strings.Contains(branch, required) {
			t.Errorf("the branch fan-out must skip retired batteries: missing %s", required)
		}
	}
	// 015 owns this branch's realtime audience row, and 029 replaced the function
	// without it, so every branch created since had no transfers scope. Replacing a
	// whole function body must not silently drop an obligation another migration owns.
	if !strings.Contains(branch, "INSERT INTO realtime_revisions(scope) VALUES ('transfers:' || NEW.id)") {
		t.Error("the branch fan-out must keep the realtime audience row that 015 created")
	}
	// A trigger fires only for future rows, so branches created while the scope was
	// missing need one explicit backfill; without it their transfers stay invisible.
	for _, required := range []string{
		"INSERT INTO realtime_revisions(scope)",
		"SELECT 'transfers:' || l.id FROM locations l",
		"ON CONFLICT (scope) DO NOTHING",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("existing branches need their scope backfilled: missing %s", required)
		}
	}
	for _, forbidden := range []string{"CREATE TABLE", "ALTER TABLE", "DROP TRIGGER", "DROP FUNCTION", "DROP COLUMN"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the migration must only replace one function body: found %s", forbidden)
		}
	}
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Fatalf("the migration must replace exactly one function, found %d", got)
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

// TestNewBranchSkipsRetiredBattery runs on the admitted parent-owned PostgreSQL
// fixture; no skip path. A branch created after a battery was retired must keep the
// operating matrix complete for active batteries and must not inherit identity rows
// for the retired one.
func TestNewBranchSkipsRetiredBattery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	p := testpg.Open(t)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	var entry, variant int64
	if err := p.QueryRow(ctx,
		"INSERT INTO catalog_entries(brand,model,capacity_ah) VALUES('RETIRED','70Ah',70) RETURNING id").Scan(&entry); err != nil {
		t.Fatal(err)
	}
	if err := p.QueryRow(ctx,
		"INSERT INTO catalog_variants(catalog_entry_id,polarity) VALUES($1,'L') RETURNING id", entry).Scan(&variant); err != nil {
		t.Fatal(err)
	}
	// Zero stock and no transfers: retirement is admitted.
	if _, err := p.Exec(ctx, "UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", entry); err != nil {
		t.Fatal(err)
	}
	var branch int
	if err := p.QueryRow(ctx, "SELECT create_branch('RETIRED-FANOUT')").Scan(&branch); err != nil {
		t.Fatal(err)
	}
	var retired int
	if err := p.QueryRow(ctx, "SELECT count(*) FROM inventory_balances WHERE location_id=$1 AND variant_id=$2", branch, variant).Scan(&retired); err != nil {
		t.Fatal(err)
	}
	if retired != 0 {
		t.Fatalf("a new branch must not inherit %d balance rows for a retired battery", retired)
	}
	var missing int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM catalog_variants v
JOIN catalog_entries e ON e.id=v.catalog_entry_id
WHERE e.deleted_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_balances b WHERE b.location_id=$1 AND b.variant_id=v.id)`, branch).Scan(&missing); err != nil {
		t.Fatal(err)
	}
	if missing != 0 {
		t.Fatalf("a new branch is missing %d balance rows for active batteries", missing)
	}
}
