package migrations_test

import (
	"strings"
	"testing"

	"luson/api/migrations"
)

// The ingress migration is additive: it owns new tables and triggers only and
// never rewrites a historical version.
func TestStockEntriesSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("021_stock_entries.sql")
	if err != nil {
		t.Fatal("stock entry migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		"CREATE TABLE stock_entries",
		"CREATE TABLE stock_entry_lines",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		"operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,128}$')",
		"location_id smallint NOT NULL REFERENCES locations(id)",
		"note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500)",
		"reverses_entry_id bigint REFERENCES stock_entries(id)",
		"reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500)",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"created_at timestamptz NOT NULL DEFAULT now()",
		"CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)",
		"CHECK ((reverses_entry_id IS NULL AND reason = '')",
		"CREATE UNIQUE INDEX stock_entries_single_reversal ON stock_entries(reverses_entry_id)",
		"quantity bigint NOT NULL CHECK (quantity <> 0)",
		"PRIMARY KEY (entry_id, variant_id)",
		"CREATE TRIGGER admit_stock_entry_header BEFORE INSERT ON stock_entries",
		"CREATE TRIGGER apply_stock_entry_line BEFORE INSERT ON stock_entry_lines",
		"CREATE CONSTRAINT TRIGGER validate_stock_entry_reversal AFTER INSERT ON stock_entry_lines",
		"DEFERRABLE INITIALLY DEFERRED",
		"CREATE TRIGGER protect_stock_entries BEFORE UPDATE OR DELETE ON stock_entries",
		"CREATE TRIGGER protect_stock_entry_lines BEFORE UPDATE OR DELETE ON stock_entry_lines",
		"CREATE TRIGGER protect_stock_entries_truncate BEFORE TRUNCATE ON stock_entries",
		"CREATE TRIGGER protect_stock_entry_lines_truncate BEFORE TRUNCATE ON stock_entry_lines",
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
		t.Fatal("ingress must never modify reserved stock")
	}
	if strings.Contains(sql, "ALTER TABLE") {
		t.Fatal("ingress must not alter historical tables")
	}
	if strings.Contains(sql, "CREATE OR REPLACE FUNCTION") {
		t.Fatal("historical functions must not be redefined")
	}
}

// The database is the authority for every rejection: each guard has one exact
// SQLSTATE that the Go store maps to a public error code.
func TestStockEntriesSchemaGuards(t *testing.T) {
	b, err := migrations.Files.ReadFile("021_stock_entries.sql")
	if err != nil {
		t.Fatal("stock entry migration must be embedded", err)
	}
	sql := string(b)
	for _, code := range []string{"LS001", "LS002", "LS003", "LS004", "LS005", "LS006", "LS007"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	// Only location 1 registers ingress; reversal targets stay in that location
	// and can never be a reversal themselves.
	if !strings.Contains(sql, "IF NEW.location_id <> 1 THEN") {
		t.Error("warehouse-only location guard missing")
	}
	if !strings.Contains(sql, "target.reverses_entry_id IS NOT NULL THEN") {
		t.Error("reversal-of-reversal guard missing")
	}
	if !strings.Contains(sql, "original IS DISTINCT FROM -NEW.quantity") {
		t.Error("exact mirrored quantity guard missing")
	}
	if !strings.Contains(sql, "IF total<balance.reserved THEN") {
		t.Error("covered existing stock guard missing")
	}
	if !strings.Contains(sql, "SET existing=total::bigint") {
		t.Error("existing stock application missing")
	}
	// The mirror check must run at commit, after every line was inserted.
	if !strings.Contains(sql, "NOT EXISTS (\n            SELECT 1 FROM stock_entry_lines reversal") {
		t.Error("reversal completeness guard missing")
	}
}
