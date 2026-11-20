package migrations_test

import (
	"strings"
	"testing"

	"luson/api/migrations"
)

// The supplier migration is additive: new tables, one new column and new
// triggers. The ingress authority installed by 021 is never replaced, because a
// redefinition silently drops the rules that live in the old body.
func TestSuppliersSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("059_suppliers.sql")
	if err != nil {
		t.Fatal("supplier migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		"CREATE TABLE suppliers",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		"char_length(name) BETWEEN 3 AND 64",
		"name !~ '[[:cntrl:]]'",
		"char_length(contact) <= 200",
		"deleted_at timestamptz",
		"CREATE UNIQUE INDEX suppliers_active_name ON suppliers (lower(name))",
		"WHERE deleted_at IS NULL",
		"CREATE TABLE supplier_offers",
		"supplier_id bigint NOT NULL REFERENCES suppliers(id)",
		"catalog_entry_id bigint NOT NULL REFERENCES catalog_entries(id)",
		"PRIMARY KEY (supplier_id, catalog_entry_id)",
		"CREATE TRIGGER admit_supplier_offer BEFORE INSERT ON supplier_offers",
		"CREATE TRIGGER protect_supplier BEFORE DELETE ON suppliers",
		"CREATE TRIGGER protect_supplier_truncate BEFORE TRUNCATE ON suppliers",
		"ALTER TABLE stock_entries ADD COLUMN supplier_id bigint REFERENCES suppliers(id)",
		"CREATE TRIGGER require_stock_entry_supplier BEFORE INSERT ON stock_entries",
		"CREATE TRIGGER require_offered_stock_entry_line BEFORE INSERT ON stock_entry_lines",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// The historical ingress guard is structural evidence of this repo: replacing
	// it would drop the warehouse-only rule it carries.
	for _, forbidden := range []string{
		"CREATE OR REPLACE FUNCTION admit_stock_entry",
		"CREATE OR REPLACE FUNCTION apply_stock_entry_line",
		"CREATE OR REPLACE FUNCTION validate_stock_entry_reversal",
		"DROP TRIGGER",
		"ALTER TABLE stock_entries ALTER COLUMN supplier_id SET NOT NULL",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("must not contain %s", forbidden)
		}
	}
	// The supplier column stays nullable so historical documents remain readable.
	if strings.Contains(sql, "ADD COLUMN supplier_id bigint NOT NULL") {
		t.Fatal("historical ingress documents must keep a nullable supplier")
	}
}

// Every supplier rejection has exactly one SQLSTATE, and the ingress rules of the
// new vertical have their own codes next to the historical LS001-LS007.
func TestSuppliersSchemaGuards(t *testing.T) {
	b, err := migrations.Files.ReadFile("059_suppliers.sql")
	if err != nil {
		t.Fatal("supplier migration must be embedded", err)
	}
	sql := string(b)
	for _, code := range []string{"LS009", "LS010", "LS011", "LS012", "LV001", "LV002", "LV003"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	if !strings.Contains(sql, "IF NEW.supplier_id IS NULL THEN") {
		t.Error("ingress-without-supplier guard missing")
	}
	if !strings.Contains(sql, "target.supplier_id IS DISTINCT FROM NEW.supplier_id") {
		t.Error("counter-entry supplier mirror guard missing")
	}
	if !strings.Contains(sql, "header.reverses_entry_id IS NOT NULL OR header.supplier_id IS NULL THEN") {
		t.Error("reversal exemption from the offer list missing")
	}
	if !strings.Contains(sql, "JOIN supplier_offers offer") {
		t.Error("offer membership guard missing")
	}
	// A retired supplier never returns to the picker and never gains offers.
	if !strings.Contains(sql, "A retired supplier cannot offer products") {
		t.Error("retired supplier offer guard missing")
	}
}
