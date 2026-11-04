package migrations_test

import (
	"strings"
	"testing"

	"luson/api/migrations"
)

// The price migration is additive: it owns new tables, one index and triggers only
// and never rewrites a historical version.
// statements drops whole-line SQL comments, so a comment that names a historical
// object is never mistaken for a statement that touches it.
func statements(sql string) string {
	kept := make([]string, 0, 128)
	for _, line := range strings.Split(sql, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func TestBranchPricesSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("024_branch_prices.sql")
	if err != nil {
		t.Fatal("branch price migration must be embedded", err)
	}
	// Comments may name the untouched contract; only executable statements prove
	// what this migration does.
	sql := statements(string(b))
	for _, required := range []string{
		"CREATE TABLE variant_warranties",
		"variant_id integer PRIMARY KEY REFERENCES catalog_variants(id)",
		"warranty_months smallint NOT NULL CHECK (warranty_months BETWEEN 1 AND 120)",
		"updated_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"updated_at timestamptz NOT NULL DEFAULT now()",
		"CREATE TABLE branch_prices",
		"branch_location_id smallint NOT NULL REFERENCES locations(id)",
		"min_price numeric(12,2) NOT NULL CHECK (min_price > 0 AND min_price <> 'NaN'::numeric)",
		"suggested_price numeric(12,2) NOT NULL CHECK (suggested_price >= min_price AND suggested_price <> 'NaN'::numeric)",
		"PRIMARY KEY (branch_location_id, variant_id)",
		"CREATE INDEX branch_prices_variant ON branch_prices(variant_id)",
		"CREATE TRIGGER admit_branch_price BEFORE INSERT OR UPDATE ON branch_prices",
		"CREATE TRIGGER protect_branch_prices BEFORE DELETE ON branch_prices",
		"CREATE TRIGGER protect_branch_prices_truncate BEFORE TRUNCATE ON branch_prices",
		"CREATE TRIGGER protect_variant_warranties BEFORE DELETE ON variant_warranties",
		"CREATE TRIGGER protect_variant_warranties_truncate BEFORE TRUNCATE ON variant_warranties",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	if strings.Contains(sql, "ALTER TABLE") {
		t.Fatal("the price migration must not alter historical tables")
	}
	if strings.Contains(sql, "CREATE OR REPLACE") {
		t.Fatal("historical functions must not be redefined")
	}
	if strings.Contains(sql, "DROP ") {
		t.Fatal("the price migration must not drop a historical object")
	}
	// Catalog prices are re-read on navigation, so this domain adds no realtime
	// scope: the historical revision constraint stays untouched.
	if strings.Contains(sql, "realtime") {
		t.Fatal("the price migration must not touch the realtime contract")
	}
}

// The sale scope belongs to the database: the warehouse never keeps sale prices and
// a retired branch never receives one, both under one exact SQLSTATE.
func TestBranchPricesSchemaGuards(t *testing.T) {
	b, err := migrations.Files.ReadFile("024_branch_prices.sql")
	if err != nil {
		t.Fatal("branch price migration must be embedded", err)
	}
	sql := statements(string(b))
	if !strings.Contains(sql, "IF NEW.branch_location_id = 1 THEN") {
		t.Error("warehouse location guard missing")
	}
	if !strings.Contains(sql, "SELECT deleted_at IS NULL INTO active FROM locations WHERE id=NEW.branch_location_id;") ||
		!strings.Contains(sql, "IF NOT FOUND OR NOT active THEN") {
		t.Error("retired branch guard missing")
	}
	// Both the sale-scope guard and the replace-not-delete guards raise the one
	// SQLSTATE this domain's store maps to a public error code.
	// Two rejection guards in the sale-scope trigger, one per replace-not-delete
	// guard: every refusal in this migration raises the same SQLSTATE.
	if strings.Count(sql, "ERRCODE='LP00N'") != 4 {
		t.Error("every price guard must raise LP00N")
	}
	for _, message := range []string{
		"'The warehouse never keeps branch sale prices'",
		"'Branch sale prices require an active branch'",
		"'Branch prices are replaced, never deleted'",
		"'Warranty terms are replaced, never deleted'",
	} {
		if !strings.Contains(sql, message) {
			t.Errorf("missing guard message %s", message)
		}
	}
	// A guard that only ran on insert would let a retired branch keep receiving
	// prices through the replace path.
	if !strings.Contains(sql, "BEFORE INSERT OR UPDATE ON branch_prices") {
		t.Error("the sale-scope guard must run on insert and on replace")
	}
}
