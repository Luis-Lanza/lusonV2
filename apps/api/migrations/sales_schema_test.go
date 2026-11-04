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
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration027 is the mixed payment migration: it adds one amount column per admitted
// method to the sale header, backfills every issued sale, and turns the payment label
// into a generated column the client can never choose. Historical versions keep their
// own checksums, so this constant names the one file this unit owns.
const migration027 = "027_sale_payments.sql"

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

// TestSalePaymentsSchemaStructure pins S16 in the schema: the header carries one amount
// per admitted method, the label is derived from them instead of being an input, and the
// database -- never the caller -- decides whether the amounts close against the total.
func TestSalePaymentsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration027)
	if err != nil {
		t.Fatal("the mixed payment migration must be embedded", err)
	}
	// Comments may name the historical contract; only executable statements prove what
	// this migration does.
	sql := statements(string(b))
	for _, required := range []string{
		// One amount per admitted method.
		"ALTER TABLE sales ADD COLUMN cash_amount numeric(12,2) NOT NULL DEFAULT 0",
		"ALTER TABLE sales ADD COLUMN card_amount numeric(12,2) NOT NULL DEFAULT 0",
		"ALTER TABLE sales ADD COLUMN transfer_amount numeric(12,2) NOT NULL DEFAULT 0",
		// The backfill reads the label each issued sale was paid with.
		"UPDATE sales SET",
		"cash_amount = CASE WHEN payment_method='cash' THEN total ELSE 0 END",
		"card_amount = CASE WHEN payment_method='card' THEN total ELSE 0 END",
		"transfer_amount = CASE WHEN payment_method='transfer' THEN total ELSE 0 END",
		// The immutability guard of 025 is closed again right after the backfill.
		"ALTER TABLE sales DISABLE TRIGGER protect_sales",
		"ALTER TABLE sales ENABLE TRIGGER protect_sales",
		// The chosen label goes away and comes back derived.
		"ALTER TABLE sales DROP COLUMN payment_method",
		"ALTER TABLE sales ADD COLUMN payment_method text GENERATED ALWAYS AS (",
		"WHEN (cash_amount > 0)::int + (card_amount > 0)::int + (transfer_amount > 0)::int > 1 THEN 'mixed'",
		"WHEN cash_amount > 0 THEN 'cash'",
		"WHEN card_amount > 0 THEN 'card'",
		"ELSE 'transfer'",
		") STORED",
		// The sum is the database's, and so is the refusal of a negative, a NaN and an
		// empty settlement.
		"cash_amount >= 0 AND cash_amount <> 'NaN'::numeric",
		"card_amount >= 0 AND card_amount <> 'NaN'::numeric",
		"transfer_amount >= 0 AND transfer_amount <> 'NaN'::numeric",
		"cash_amount > 0 OR card_amount > 0 OR transfer_amount > 0",
		"cash_amount + card_amount + transfer_amount = total",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// The steps happen in the only order that works on a live database: the amounts
	// exist before they are backfilled, the old label is backfilled before it is
	// dropped, and the derived label exists before the sum is constrained.
	for _, step := range [][2]string{
		{"ADD COLUMN cash_amount", "UPDATE sales SET"},
		{"UPDATE sales SET", "DROP COLUMN payment_method"},
		{"DROP COLUMN payment_method", "GENERATED ALWAYS AS"},
		{"GENERATED ALWAYS AS", "cash_amount + card_amount + transfer_amount = total"},
	} {
		if first, second := strings.Index(sql, step[0]), strings.Index(sql, step[1]); first < 0 || second < 0 || first > second {
			t.Errorf("%s must precede %s", step[0], step[1])
		}
	}
	// The guard window exists exactly once and surrounds the only write of the file.
	if n := strings.Count(sql, "DISABLE TRIGGER protect_sales"); n != 1 {
		t.Fatalf("the backfill must open the guard window once, got %d", n)
	}
	if n := strings.Count(sql, "ENABLE TRIGGER protect_sales"); n != 1 {
		t.Fatalf("the backfill must close the guard window once, got %d", n)
	}
	disable := strings.Index(sql, "DISABLE TRIGGER protect_sales")
	backfill := strings.Index(sql, "UPDATE sales SET")
	enable := strings.Index(sql, "ENABLE TRIGGER protect_sales")
	if !(disable < backfill && backfill < enable) {
		t.Error("the backfill must happen inside the guard window")
	}
	// The guard is disarmed, never removed: 025 owns it and it must stay installed.
	if strings.Contains(sql, "DROP TRIGGER") {
		t.Fatal("the mixed payment migration must not drop the immutability guard")
	}
	if strings.Contains(sql, "CREATE OR REPLACE") {
		t.Fatal("historical functions must not be redefined")
	}
	if strings.Contains(sql, "DROP TABLE") {
		t.Fatal("the mixed payment migration must not drop a table")
	}
	// The unit touches the sale header only: the lines, the prices and the catalogue are
	// exactly as 024, 025 and 026 left them.
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "ALTER TABLE ") {
			continue
		}
		if !strings.HasPrefix(trimmed, "ALTER TABLE sales ") {
			t.Errorf("the mixed payment migration must alter the sale header only: %s", trimmed)
		}
	}
	// The backfill and the guard window must be documented where they happen, because an
	// unexplained UPDATE of an immutable document is a data loss waiting to happen.
	comment := string(b)
	for _, documented := range []string{"protect_sales", "backfill"} {
		if !strings.Contains(comment, documented) {
			t.Errorf("the migration must document its rewrite of issued sales: %s", documented)
		}
	}
}

// TestSalePaymentsBackfill proves the backfill on a live database: every sale issued
// before this migration keeps its total, that total lands on the method it was paid with,
// and the derived label is the one the sale already declared.
func TestSalePaymentsBackfill(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	// The pre-backfill schema: the label is still a chosen input of the header.
	applyMigrationRange(t, ctx, p, 26)
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("the pre-backfill dataset could not be seeded")
	}
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the pre-backfill accounts could not be provisioned")
	}
	// One battery priced in branch 2, so a sale of its polarity is admitted by 026.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the pre-backfill price fixture failed")
	}
	// One issued sale per former method, each of them paid with the whole total.
	issued := make(map[string]int64, 3)
	for _, method := range []string{"cash", "card", "transfer"} {
		tx, err := p.Begin(ctx)
		if err != nil {
			t.Fatal("the pre-backfill sale transaction failed")
		}
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,payment_method,customer_name,total,created_by_account_id)
 VALUES(2,$1,'Cliente',2000.00,2) RETURNING id`, method).Scan(&id); err != nil {
			t.Fatalf("the pre-backfill %s sale failed: %v", method, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,1,1,2000.00,6)`, id); err != nil {
			t.Fatalf("the pre-backfill %s line failed: %v", method, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("the pre-backfill %s sale must be issued: %v", method, err)
		}
		issued[method] = id
	}
	// Now the migration runs against a database that already has issued sales.
	migration, err := migrations.Files.ReadFile(migration027)
	if err != nil {
		t.Fatal("the mixed payment migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("the mixed payment migration failed on a live database: %v", err)
	}
	// Every issued sale keeps its total on the method it was paid with, and its derived
	// label is the label it already declared.
	for method, id := range issued {
		var cash, card, transfer, label, total string
		if err := p.QueryRow(ctx, `SELECT cash_amount::text,card_amount::text,transfer_amount::text,
  payment_method,total::text FROM sales WHERE id=$1`, id).Scan(&cash, &card, &transfer, &label, &total); err != nil {
			t.Fatalf("the backfilled %s sale could not be read: %v", method, err)
		}
		want := map[string][3]string{
			"cash":     {"2000.00", "0.00", "0.00"},
			"card":     {"0.00", "2000.00", "0.00"},
			"transfer": {"0.00", "0.00", "2000.00"},
		}[method]
		if cash != want[0] || card != want[1] || transfer != want[2] {
			t.Fatalf("the whole total of a %s sale must land on its own method: %s/%s/%s", method, cash, card, transfer)
		}
		if label != method || total != "2000.00" {
			t.Fatalf("the backfilled %s sale changed its label or total: %s/%s", method, label, total)
		}
	}
	if n := countRows(t, ctx, p, "SELECT count(*) FROM sales"); n != 3 {
		t.Fatalf("the backfill must keep every issued sale, got %d", n)
	}
	// The immutability guard of 025 is enabled again: the backfill window is closed.
	if _, err := p.Exec(ctx, "UPDATE sales SET total=1.00"); err == nil {
		t.Fatal("the backfill must leave the immutability guard enabled")
	}
	// And the label can no longer be an input of a new sale: it is a generated column.
	_, err = p.Exec(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,transfer_amount,payment_method,
  customer_name,total,created_by_account_id) VALUES(2,2000.00,0.00,0.00,'cash','Cliente',2000.00,2)`)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "428C9" {
		t.Fatalf("the payment label must be refused as an input: %v", err)
	}
}

// TestSalePaymentsDatabaseRefusesOpenSum proves the sum is the database's: a settlement
// that falls short, overshoots, is empty, is negative or is NaN is refused at the header,
// and a settlement that closes is admitted with its label derived from its amounts.
func TestSalePaymentsDatabaseRefusesOpenSum(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 27)
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("the dataset could not be seeded")
	}
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the price fixture failed")
	}
	// Each refused settlement names a constraint that proves the amounts themselves -- and
	// not some other guard -- were the reason. A settlement that breaks two amount rules at
	// once may be refused by either, so each case names the admitted refusals.
	for name, tc := range map[string]struct {
		cash, card, transfer string
		constraints          []string
	}{
		"below_total":  {"1000.00", "500.00", "0.00", []string{"sales_payments_total"}},
		"above_total":  {"1500.00", "1000.00", "0.00", []string{"sales_payments_total"}},
		"nothing_paid": {"0.00", "0.00", "0.00", []string{"sales_payments_nonzero", "sales_payments_total"}},
		// The negative amount is the only rule broken here: the three amounts still close
		// against the total, so the non-negative bound is what refuses the header.
		"negative":     {"3000.00", "0.00", "-1000.00", []string{"sales_transfer_amount_bounded"}},
		"not_a_number": {"NaN", "0.00", "0.00", []string{"sales_cash_amount_bounded", "sales_payments_total"}},
	} {
		_, err := p.Exec(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,transfer_amount,
  customer_name,total,created_by_account_id)
 VALUES(2,$1::numeric,$2::numeric,$3::numeric,'Cliente',2000.00,2)`, tc.cash, tc.card, tc.transfer)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) {
			t.Fatalf("%s must be refused by the database: %v", name, err)
		}
		admitted := false
		for _, constraint := range tc.constraints {
			admitted = admitted || pg.ConstraintName == constraint
		}
		if !admitted {
			t.Fatalf("%s must be refused by %v, got %q: %v", name, tc.constraints, pg.ConstraintName, err)
		}
	}
	// A settlement that closes is admitted, and its label is derived by the database: two
	// paying methods are 'mixed', one method is that method.
	for name, tc := range map[string]struct {
		cash, card, transfer, label string
	}{
		"mixed":    {"1200.00", "0.00", "800.00", "mixed"},
		"cash":     {"2000.00", "0.00", "0.00", "cash"},
		"card":     {"0.00", "2000.00", "0.00", "card"},
		"transfer": {"0.00", "0.00", "2000.00", "transfer"},
	} {
		tx, err := p.Begin(ctx)
		if err != nil {
			t.Fatal("the sale transaction failed")
		}
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,transfer_amount,
  customer_name,total,created_by_account_id)
 VALUES(2,$1::numeric,$2::numeric,$3::numeric,'Cliente',2000.00,2) RETURNING id`,
			tc.cash, tc.card, tc.transfer).Scan(&id); err != nil {
			t.Fatalf("the %s settlement must be admitted: %v", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,1,1,2000.00,6)`, id); err != nil {
			t.Fatalf("the %s sale line failed: %v", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("the %s settlement must be committed: %v", name, err)
		}
		var label string
		if err := p.QueryRow(ctx, "SELECT payment_method FROM sales WHERE id=$1", id).Scan(&label); err != nil {
			t.Fatal("the derived label could not be read")
		}
		if label != tc.label {
			t.Fatalf("the %s settlement must be labelled %s, got %s", name, tc.label, label)
		}
	}
}
