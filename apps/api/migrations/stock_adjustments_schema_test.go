package migrations_test

import (
	"strings"
	"testing"

	"luson/api/migrations"
)

// The adjustment migration is additive: it owns new tables and triggers only and
// never rewrites a historical version.
func TestStockAdjustmentsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("022_stock_adjustments.sql")
	if err != nil {
		t.Fatal("stock adjustment migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		"CREATE TABLE stock_adjustments",
		"CREATE TABLE stock_adjustment_lines",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		"operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$')",
		"location_id smallint NOT NULL REFERENCES locations(id)",
		"reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500)",
		"detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 500)",
		"reverses_adjustment_id bigint REFERENCES stock_adjustments(id)",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"created_at timestamptz NOT NULL DEFAULT now()",
		"CHECK (reverses_adjustment_id IS NULL OR reverses_adjustment_id <> id)",
		"CREATE UNIQUE INDEX stock_adjustments_single_reversal ON stock_adjustments(reverses_adjustment_id)",
		"expected_quantity bigint NOT NULL CHECK (expected_quantity >= 0)",
		"counted_quantity bigint NOT NULL CHECK (counted_quantity >= 0 AND counted_quantity <= 1000000)",
		"PRIMARY KEY (adjustment_id, variant_id)",
		"CREATE TRIGGER admit_stock_adjustment_header BEFORE INSERT ON stock_adjustments",
		"CREATE TRIGGER apply_stock_adjustment_line BEFORE INSERT ON stock_adjustment_lines",
		"CREATE CONSTRAINT TRIGGER validate_stock_adjustment_reversal AFTER INSERT ON stock_adjustment_lines",
		"DEFERRABLE INITIALLY DEFERRED",
		"CREATE TRIGGER protect_stock_adjustments BEFORE UPDATE OR DELETE ON stock_adjustments",
		"CREATE TRIGGER protect_stock_adjustment_lines BEFORE UPDATE OR DELETE ON stock_adjustment_lines",
		"CREATE TRIGGER protect_stock_adjustments_truncate BEFORE TRUNCATE ON stock_adjustments",
		"CREATE TRIGGER protect_stock_adjustment_lines_truncate BEFORE TRUNCATE ON stock_adjustment_lines",
		"FOR UPDATE",
		"invalidate_balance_change",
		"'inventory'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	if strings.Contains(sql, "CREATE OR REPLACE") {
		t.Fatal("historical schema must remain additive")
	}
	if strings.Contains(sql, "reserved=") || strings.Contains(sql, "reserved =") {
		t.Fatal("an adjustment must never modify reserved stock")
	}
	if strings.Contains(sql, "ALTER TABLE") {
		t.Fatal("an adjustment must not alter historical tables")
	}
	if strings.Contains(sql, "CREATE OR REPLACE FUNCTION") {
		t.Fatal("historical functions must not be redefined")
	}
}

// The blind-count contract lives in the database: the expected snapshot is taken
// from the balance under the row lock and a caller-supplied value is overwritten.
func TestStockAdjustmentsBlindSnapshotIsDatabaseAuthority(t *testing.T) {
	b, err := migrations.Files.ReadFile("022_stock_adjustments.sql")
	if err != nil {
		t.Fatal("stock adjustment migration must be embedded", err)
	}
	sql := string(b)
	if !strings.Contains(sql, "NEW.expected_quantity := balance.existing;") {
		t.Error("expected snapshot must come from the locked balance row")
	}
	if !strings.Contains(sql, "delta := NEW.counted_quantity::numeric - NEW.expected_quantity::numeric;") {
		t.Error("the applied delta must be counted minus expected")
	}
	if !strings.Contains(sql, "SET existing=total::bigint") {
		t.Error("existing stock application missing")
	}
	// A counter-entry swaps scored facts, so its delta is the exact negation.
	if !strings.Contains(sql, "NEW.expected_quantity := original.counted_quantity;") ||
		!strings.Contains(sql, "NEW.counted_quantity := original.expected_quantity;") {
		t.Error("counter-entry must swap counted and expected")
	}
	if !strings.Contains(sql, "counter.expected_quantity=original.counted_quantity") ||
		!strings.Contains(sql, "counter.counted_quantity=original.expected_quantity") {
		t.Error("reversal completeness must compare the swapped pair")
	}
}

// The database is the authority for every rejection: each guard has one exact
// SQLSTATE that the Go store maps to a public error code. 022 is applied and checksummed,
// so what it states is read here as the version 075 replaces, and 075's own text is judged
// by TestStockAdjustmentActorLocationSchema.
func TestStockAdjustmentsSchemaGuards(t *testing.T) {
	b, err := migrations.Files.ReadFile("022_stock_adjustments.sql")
	if err != nil {
		t.Fatal("stock adjustment migration must be embedded", err)
	}
	sql := string(b)
	for _, code := range []string{"LS001", "LS002", "LS003", "LS004", "LS005", "LS006", "LS007"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	// The reversal rules the trigger keeps: a target stays in its own location and can never
	// be a counter-entry itself.
	if !strings.Contains(sql, "target.location_id IS DISTINCT FROM NEW.location_id") {
		t.Error("same-location reversal guard missing")
	}
	if !strings.Contains(sql, "target.reverses_adjustment_id IS NOT NULL THEN") {
		t.Error("reversal-of-reversal guard missing")
	}
	// The warehouse-only admission 022 wrote is the rule 075 restates forward (S36.1): it is
	// named here so the replaced premise is stated by the test that pins it, and it must not
	// be the rule the newest version states.
	if !strings.Contains(sql, "IF NEW.location_id <> 1 THEN") {
		t.Error("022 is the version that fixed the warehouse; the migration history must keep it")
	}
	if !strings.Contains(sql, "IF total < balance.reserved THEN") {
		t.Error("covered existing stock guard missing")
	}
	// The mirror check must run at commit, after every line was inserted.
	if !strings.Contains(sql, "NOT EXISTS (\n            SELECT 1 FROM stock_adjustment_lines counter") {
		t.Error("reversal completeness guard missing")
	}
}

// 075 is the version that generalizes the document (S36, S36.1, S36.2). It restates the one
// admission function whole -- the location stops being the warehouse and becomes integrity,
// the same-location reversal stays -- and it wires the frozen-branch guard 035 deliberately
// omitted, against the comment that said a guard there could never fire.
const actorLocationMigration = "075_stock_adjustment_actor_location.sql"

// TestStockAdjustmentActorLocationSchema reads the embedded version exactly as PostgreSQL
// receives it and judges the statements, never the prose: one function restated forward, one
// guard installed, and the balance application of 022 untouched.
func TestStockAdjustmentActorLocationSchema(t *testing.T) {
	b, err := migrations.Files.ReadFile(actorLocationMigration)
	if err != nil {
		t.Fatal("the actor-location migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		// The admission of 022, restated whole: nothing is edited in place.
		"CREATE OR REPLACE FUNCTION admit_stock_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$",
		// The location stops being the warehouse and becomes integrity: the location must be
		// one this installation has, and LS005 keeps its number with that meaning.
		"IF NOT EXISTS (SELECT 1 FROM locations WHERE id=NEW.location_id) THEN",
		"ERRCODE='LS005'",
		// The reversal stays inside one location.
		"target.location_id IS DISTINCT FROM NEW.location_id",
		"ERRCODE='LS006'",
		// The guard 035 omitted (S36.2): a branch with a live settlement does not move its own
		// stock, wired exactly the way 035 wires a sale or a purchase.
		"CREATE FUNCTION admit_stock_adjustment_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"PERFORM assert_branch_not_frozen(NEW.location_id);",
		"CREATE TRIGGER admit_frozen_branch_stock_adjustment BEFORE INSERT ON stock_adjustments",
		"FOR EACH ROW EXECUTE FUNCTION admit_stock_adjustment_when_branch_operating();",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// The warehouse is no longer the admission rule, and no statement may restore it.
	if strings.Contains(sql, "NEW.location_id <> 1") || strings.Contains(sql, "NEW.location_id <> 1 THEN") {
		t.Error("the generalized admission must not keep the warehouse-only refusal")
	}
	// The blind-count half of 022 is not restated: the balance application keeps exactly one
	// owner, and no table, column or row is rewritten.
	for _, forbidden := range []string{
		"CREATE TABLE", "ALTER TABLE", "DROP ", "TRUNCATE ", "DELETE FROM",
		"UPDATE stock_adjustments", "UPDATE inventory_balances",
		"apply_stock_adjustment_line", "validate_stock_adjustment_reversal",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the migration restates only the admission it must generalize: %s", forbidden)
		}
	}
	// PostgreSQL fires the BEFORE ROW triggers of one table in name order: the freeze must be
	// judged before the admission of the document it refuses.
	if !("admit_frozen_branch_stock_adjustment" < "admit_stock_adjustment_header") {
		t.Error("the freeze trigger must sort before the admission trigger to fire first")
	}
}

// The prose of 075 carries the comment 035 could not keep: 035 is applied and checksummed, so
// the rewrite of its premise -- "a guard here could never fire" -- lives in the version that
// makes it false, and it has to say what it now guards.
func TestStockAdjustmentActorLocationDocumentsTheRewrittenRule(t *testing.T) {
	b, err := migrations.Files.ReadFile(actorLocationMigration)
	if err != nil {
		t.Fatal("the actor-location migration must be embedded", err)
	}
	sql := string(b)
	for _, documented := range []string{
		"035", "stock_entries", "could never fire", "LC001", "assert_branch_not_frozen",
		"S36", "S36.1", "S36.2", "checksummed", "admit_stock_adjustment_header",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
	// It says why the guard belongs there now: a frozen branch would move its own stock
	// outside the cut the settlement already counted.
	for _, sentence := range []string{"rendición", "count"} {
		if !strings.Contains(sql, sentence) {
			t.Errorf("the rewritten premise must name what it protects: %s", sentence)
		}
	}
}

// Migration 022 was already applied to tracked databases, so the header
// completeness guard is its own immutable version. A committed document with no
// lines restores nothing, and as a counter-entry it would take the single-reversal
// slot while the original stays uncorrected; the per-line guards cannot see it.
func TestStockAdjustmentLineCompletenessSchema(t *testing.T) {
	b, err := migrations.Files.ReadFile("023_stock_adjustment_lines_required.sql")
	if err != nil {
		t.Fatal("line completeness migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		"CREATE FUNCTION require_stock_adjustment_lines()",
		"SELECT count(*) INTO line_count FROM stock_adjustment_lines WHERE adjustment_id=NEW.id;",
		"IF line_count < 1 THEN",
		"ERRCODE='LS008'",
		"CREATE CONSTRAINT TRIGGER require_stock_adjustment_lines AFTER INSERT ON stock_adjustments\nDEFERRABLE INITIALLY DEFERRED",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// The guard is additive: it never redefines or rewrites what 022 created.
	if strings.Contains(sql, "CREATE OR REPLACE") || strings.Contains(sql, "ALTER TABLE") ||
		strings.Contains(sql, "DROP ") {
		t.Fatal("a later migration must not rewrite the applied schema")
	}
}
