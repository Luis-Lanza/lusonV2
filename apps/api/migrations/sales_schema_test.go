package migrations_test

import (
	"strings"
	"testing"

	"luson/api/migrations"
)

// The sale migration is additive: it owns two new tables, one index and its own
// triggers, and never rewrites a historical version. statements drops whole-line SQL
// comments, so a comment that names a historical object is never mistaken for a
// statement that touches it.
func TestSalesSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("025_sales.sql")
	if err != nil {
		t.Fatal("sale migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		"CREATE TABLE sales",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		"branch_location_id smallint NOT NULL REFERENCES locations(id)",
		"branch_sequence bigint NOT NULL DEFAULT 0 CHECK (branch_sequence BETWEEN 1 AND 999999999)",
		"warranty_number text NOT NULL DEFAULT '' CHECK (warranty_number ~ '^[1-9][0-9]{0,4}-[0-9]{6,12}$')",
		"payment_method text NOT NULL CHECK (payment_method IN ('cash','card','transfer'))",
		"customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 120)",
		"customer_phone text NOT NULL DEFAULT '' CHECK (char_length(customer_phone) <= 40)",
		"customer_document text NOT NULL DEFAULT '' CHECK (char_length(customer_document) <= 40)",
		"total numeric(12,2) NOT NULL CHECK (total > 0 AND total <> 'NaN'::numeric)",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"created_at timestamptz NOT NULL DEFAULT now()",
		"UNIQUE (branch_location_id, branch_sequence)",
		"UNIQUE (branch_location_id, warranty_number)",
		"CREATE INDEX sales_branch_history ON sales(branch_location_id, id)",
		"CREATE TABLE sale_lines",
		"sale_id bigint NOT NULL REFERENCES sales(id)",
		"variant_id integer NOT NULL REFERENCES catalog_variants(id)",
		"quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 1000000)",
		"unit_price numeric(12,2) NOT NULL CHECK (unit_price > 0 AND unit_price <> 'NaN'::numeric)",
		"min_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_price > 0 AND min_price <> 'NaN'::numeric)",
		"warranty_months smallint NOT NULL CHECK (warranty_months BETWEEN 1 AND 120)",
		"subtotal numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal > 0 AND subtotal <> 'NaN'::numeric)",
		"PRIMARY KEY (sale_id, variant_id)",
		"CHECK (unit_price >= min_price)",
		"CREATE TRIGGER admit_sale BEFORE INSERT ON sales",
		"CREATE TRIGGER apply_sale_line BEFORE INSERT ON sale_lines",
		"CREATE CONSTRAINT TRIGGER require_sale_total AFTER INSERT ON sales",
		"DEFERRABLE INITIALLY DEFERRED",
		"CREATE TRIGGER protect_sales BEFORE UPDATE OR DELETE ON sales",
		"CREATE TRIGGER protect_sale_lines BEFORE UPDATE OR DELETE ON sale_lines",
		"CREATE TRIGGER protect_sales_truncate BEFORE TRUNCATE ON sales",
		"CREATE TRIGGER protect_sale_lines_truncate BEFORE TRUNCATE ON sale_lines",
		"FOR UPDATE",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// The sale is immutable: no update, no delete, no truncate.
	for _, statement := range []string{
		"CREATE TRIGGER protect_sales BEFORE UPDATE OR DELETE ON sales",
		"CREATE TRIGGER protect_sales_truncate BEFORE TRUNCATE ON sales",
		"CREATE TRIGGER protect_sale_lines BEFORE UPDATE OR DELETE ON sale_lines",
		"CREATE TRIGGER protect_sale_lines_truncate BEFORE TRUNCATE ON sale_lines",
	} {
		if !strings.Contains(sql, statement) {
			t.Errorf("immutability guard missing: %s", statement)
		}
	}
	if strings.Contains(sql, "CREATE OR REPLACE") {
		t.Fatal("historical schema must remain additive")
	}
	if strings.Contains(sql, "ALTER TABLE") {
		t.Fatal("the sale migration must not alter historical tables")
	}
	if strings.Contains(sql, "DROP ") {
		t.Fatal("the sale migration must not drop a historical object")
	}
	// A sale only ever decrements existing stock: reserved is never written.
	if strings.Contains(sql, "reserved=") || strings.Contains(sql, "reserved =") {
		t.Fatal("a sale must never modify reserved stock")
	}
	// The warranty term is sale data the seller states, not a product datum: nothing
	// here reads or requires a product warranty table.
	if strings.Contains(sql, "variant_warranties") {
		t.Fatal("the sale migration must not depend on a product warranty table")
	}
	// Migration 004's invalidate_balance_change carries the realtime contract, so
	// this domain adds no statement of its own to it: the invocation is documented in
	// the migration header, not installed here.
	if strings.Contains(sql, "realtime") || strings.Contains(sql, "invalidate_balance_change") {
		t.Fatal("the sale migration must not touch the realtime contract")
	}
	for _, documented := range []string{"invalidate_balance_change", "'inventory'"} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the migration must state which trigger carries the invalidation: %s", documented)
		}
	}
}

// The sale scope and the price floor belong to the database: the warehouse never
// sells, a sale belongs to the account of its own branch, and the frozen minimum and
// term come from the branch's stored pair, never from the caller.
func TestSalesSchemaGuards(t *testing.T) {
	b, err := migrations.Files.ReadFile("025_sales.sql")
	if err != nil {
		t.Fatal("sale migration must be embedded", err)
	}
	sql := statements(string(b))
	// Every refusal in this domain raises its own SQLSTATE, which is the only
	// evidence the store maps to a public error code.
	for _, code := range []string{"LV001", "LV002", "LV003", "LV004", "LV005", "LV006", "LV007", "LV008"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	// The warehouse (location 1) never sells, and only an active branch admits a
	// sale. The branch row is locked, which is also how the per-branch correlative is
	// allocated by a single writer at a time.
	if !strings.Contains(sql, "IF NEW.branch_location_id = 1 THEN") {
		t.Error("warehouse sale scope guard missing")
	}
	if !strings.Contains(sql, "SELECT deleted_at IS NULL INTO active FROM locations WHERE id=NEW.branch_location_id FOR UPDATE;") {
		t.Error("active branch guard must lock the branch row")
	}
	// The selling account is the branch's own provisioned account, never a claim.
	if !strings.Contains(sql, "owner_location IS DISTINCT FROM NEW.branch_location_id") {
		t.Error("own-branch account guard missing")
	}
	// Both document numbers are written by the trigger, never chosen by the caller.
	if !strings.Contains(sql, "NEW.branch_sequence := next_sequence;") {
		t.Error("the branch correlative must be allocated by the database")
	}
	if !strings.Contains(sql, "NEW.warranty_number := NEW.branch_location_id::text || '-' || lpad(next_sequence::text,6,'0');") {
		t.Error("the warranty number must be numbered inside its branch")
	}
	// Not sellable, below the frozen floor, derived subtotal.
	for _, required := range []string{
		"SELECT min_price INTO branch_min FROM branch_prices",
		"IF NEW.unit_price < branch_min THEN",
		"NEW.min_price := branch_min;",
		"NEW.subtotal := NEW.unit_price * NEW.quantity;",
		"DETAIL=NEW.variant_id::text",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// The term is the seller's: it is frozen exactly as the line states it, so the
	// trigger must never overwrite it from anywhere.
	if strings.Contains(sql, "NEW.warranty_months :=") {
		t.Fatal("the warranty term is sale data and must not be overwritten")
	}
	// Stock leaves the selling branch only, under the balance row lock: never below
	// zero and never below reserved, and reserved is untouched.
	if !strings.Contains(sql, "SELECT * INTO balance FROM inventory_balances") ||
		!strings.Contains(sql, "AND variant_id=NEW.variant_id FOR UPDATE;") {
		t.Error("the balance row must be locked before it is judged")
	}
	if !strings.Contains(sql, "total := balance.existing::numeric - NEW.quantity::numeric;") {
		t.Error("the applied decrement must be existing minus the sold quantity")
	}
	if !strings.Contains(sql, "IF total < 0 THEN") || !strings.Contains(sql, "IF total < balance.reserved THEN") {
		t.Error("exhausted stock and reserved coverage guards missing")
	}
	if !strings.Contains(sql, "SET existing=total::bigint") {
		t.Error("existing stock application missing")
	}
	// Completeness and the total are deferred, so they judge the document at commit,
	// after every line was inserted or not: the header is immutable and can never be
	// updated to agree with its lines afterwards.
	if !strings.Contains(sql, "IF line_count < 1 THEN") {
		t.Error("line completeness guard missing")
	}
	if !strings.Contains(sql, "IF lines_total IS DISTINCT FROM NEW.total THEN") {
		t.Error("the total must agree with the persisted lines")
	}
}
