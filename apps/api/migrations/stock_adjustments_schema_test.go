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
// SQLSTATE that the Go store maps to a public error code.
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
	// Only location 1 adjusts; reversal targets stay in that location and can
	// never be a counter-entry themselves.
	if !strings.Contains(sql, "IF NEW.location_id <> 1 THEN") {
		t.Error("warehouse-only location guard missing")
	}
	if !strings.Contains(sql, "target.reverses_adjustment_id IS NOT NULL THEN") {
		t.Error("reversal-of-reversal guard missing")
	}
	if !strings.Contains(sql, "IF total < balance.reserved THEN") {
		t.Error("covered existing stock guard missing")
	}
	// The mirror check must run at commit, after every line was inserted.
	if !strings.Contains(sql, "NOT EXISTS (\n            SELECT 1 FROM stock_adjustment_lines counter") {
		t.Error("reversal completeness guard missing")
	}
}
