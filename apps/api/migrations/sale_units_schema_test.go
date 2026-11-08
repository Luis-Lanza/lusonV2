package migrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration031 is the sold-unit migration: it adds the client's address to the sale
// header, moves the warranty term from the line to the physical unit and makes it
// optional, and gives every unit the serial number the seller reads at the counter.
// Historical versions keep their own checksums, so this constant names the one file
// this unit owns.
const migration031 = "031_sale_unit_serial_warranty.sql"

// The unit migration is the only one allowed to alter a historical sale table, and it
// does it in one direction: a new table, a new optional header column, and the removal
// of the line-level term that the unit now owns. statements drops whole-line SQL
// comments, so a comment that names a historical object is never mistaken for a
// statement that touches it.
func TestSaleUnitSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration031)
	if err != nil {
		t.Fatal("the unit migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		// The client's address is optional free text beside phone and document.
		"ALTER TABLE sales ADD COLUMN customer_address text NOT NULL DEFAULT ''",
		"CHECK (char_length(customer_address) <= 200)",
		// One row per physical battery, keyed by its own line.
		"CREATE TABLE sale_units",
		"sale_id bigint NOT NULL",
		"variant_id integer NOT NULL",
		"unit_ordinal integer NOT NULL CHECK (unit_ordinal BETWEEN 1 AND 1000000)",
		"serial_number text NOT NULL",
		"CHECK (char_length(btrim(serial_number)) BETWEEN 1 AND 64)",
		// The term is optional here, and its absence is NULL, never zero.
		"warranty_months smallint CHECK (warranty_months BETWEEN 1 AND 120)",
		"PRIMARY KEY (sale_id, variant_id, unit_ordinal)",
		"FOREIGN KEY (sale_id, variant_id) REFERENCES sale_lines(sale_id, variant_id)",
		// One physical battery cannot be sold twice, compared the way the counter types.
		"CREATE UNIQUE INDEX sale_units_serial_number ON sale_units (upper(btrim(serial_number)))",
		// The term leaves the line: two authorities for one promise is how they drift.
		"ALTER TABLE sale_lines DROP COLUMN warranty_months",
		// A unit belongs to a persisted line and never exceeds its quantity.
		"CREATE TRIGGER admit_sale_unit BEFORE INSERT ON sale_units",
		// The duplicate refusal must not be a bare read: the guard takes the battery's own
		// lock, so two sellers of one serial serialize on it and the second is refused with
		// LV009 instead of colliding on the unique index with a 23505 the contract never
		// promised. The index stays the last authority, and the rule no longer depends on
		// the unrelated balance lock happening to serialize every sale.
		"PERFORM pg_advisory_xact_lock(hashtext('sale_units:' || upper(btrim(NEW.serial_number))));",
		// Completeness is judged at commit and hangs on the sale, so a sale that inserts
		// no unit at all is refused as well.
		"CREATE CONSTRAINT TRIGGER require_sale_units AFTER INSERT ON sales",
		"DEFERRABLE INITIALLY DEFERRED",
		// Sold units are immutable, truncate included.
		"CREATE TRIGGER protect_sale_units BEFORE UPDATE OR DELETE ON sale_units",
		"CREATE TRIGGER protect_sale_units_truncate BEFORE TRUNCATE ON sale_units",
		"FOR UPDATE",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Every refusal raises its own SQLSTATE: the store maps that code and nothing else.
	for _, code := range []string{"LV009", "LV010", "LV011", "LV012", "LV013"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	// The absence of a warranty is data, never a zero: the unit column must stay
	// nullable and the bound must keep out both zero and one hundred twenty-one.
	if strings.Contains(sql, "warranty_months smallint NOT NULL") {
		t.Fatal("the unit warranty term must be optional")
	}
	if strings.Contains(sql, "warranty_months BETWEEN 0 AND") {
		t.Fatal("zero months is not the absence of a warranty")
	}
	// The serial is written down, never resolved against stock: this migration adds no
	// dependency on a balance, and it never touches the realtime contract.
	for _, forbidden := range []string{"inventory_balances", "realtime", "invalidate_balance_change"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("a sold unit must never depend on %s", forbidden)
		}
	}
	// The valuable window is closed in the only order that keeps the promise stored:
	// the unit table exists before the line loses its term.
	if first, second := strings.Index(sql, "CREATE TABLE sale_units"), strings.Index(sql, "DROP COLUMN warranty_months"); first < 0 || second < 0 || first > second {
		t.Error("the unit table must exist before the line loses its term")
	}
	// Historical objects are never redefined here; 025 and 027 keep their own versions.
	if strings.Contains(sql, "CREATE OR REPLACE") {
		t.Fatal("historical functions must not be redefined")
	}
	if strings.Contains(sql, "DROP TABLE") || strings.Contains(sql, "DROP TRIGGER") {
		t.Fatal("the unit migration must not drop a historical object")
	}
	// The two altered tables are the sale header and its lines, nothing else.
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "ALTER TABLE ") && !strings.HasPrefix(trimmed, "ALTER TABLE sales ") &&
			!strings.HasPrefix(trimmed, "ALTER TABLE sale_lines ") {
			t.Errorf("the unit migration alters an unexpected table: %s", trimmed)
		}
	}
	// The removal is a one-way door on a document the counter depends on, so the
	// migration documents why the term moves and why the serial is unique.
	for _, documented := range []string{"sale_units", "NULL means", "one physical battery cannot be sold twice"} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
}

// TestSaleUnitGuards proves the unit rules on a live database: a complete document is
// admitted with a NULL term, and every incomplete or contradictory one is refused with
// its own SQLSTATE. Nothing here asserts a Go rule: these are the database's.
func TestSaleUnitGuards(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 31)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the price fixture failed")
	}
	seedBranchStock(t, ctx, p, 200, 1)

	// A complete document is admitted: one line of three batteries, three units, one of
	// them without warranty. The absence is stored as NULL, never as zero.
	tx, id := openSale(t, ctx, p, 3)
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number,warranty_months)
 VALUES($1,1,1,'ABC001',12),($1,1,2,'ABC002',6),($1,1,3,'ABC003',NULL)`, id); err != nil {
		t.Fatalf("a complete document must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a complete sale must commit: %v", err)
	}
	rows, err := p.Query(ctx, `SELECT serial_number,warranty_months FROM sale_units WHERE sale_id=$1 ORDER BY unit_ordinal`, id)
	if err != nil {
		t.Fatal("the units of the admitted sale could not be read")
	}
	got := make(map[string]*int16, 3)
	for rows.Next() {
		var serial string
		var term *int16
		if err := rows.Scan(&serial, &term); err != nil {
			t.Fatal("the unit row could not be read")
		}
		got[serial] = term
	}
	rows.Close()
	if len(got) != 3 || got["ABC001"] == nil || *got["ABC001"] != 12 || got["ABC002"] == nil || *got["ABC002"] != 6 {
		t.Fatalf("the stated terms must be frozen with their unit: %v", got)
	}
	if term, ok := got["ABC003"]; !ok || term != nil {
		t.Fatalf("the unit sold without warranty must stay NULL, got %v", got["ABC003"])
	}
	t.Logf("031: three units admitted, one of them with a NULL term")

	// The line lost its term: the promise has one authority now.
	if _, err := p.Exec(ctx, `SELECT warranty_months FROM sale_lines LIMIT 1`); execRefusalCode(err) != "42703" {
		t.Fatal("the sale line must no longer carry a warranty term")
	}

	// The client's address is bounded at two hundred characters and empty by default.
	var address string
	if err := p.QueryRow(ctx, `SELECT customer_address FROM sales WHERE id=$1`, id).Scan(&address); err != nil || address != "" {
		t.Fatalf("the address must default to empty: %q %v", address, err)
	}
	tx, addressed := openSaleAt(t, ctx, p, 1, "Av. Colón 1234, Barrio Norte")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'ADDR001')`, addressed); err != nil {
		t.Fatalf("the unit of the addressed sale must be insertable: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a sale with an address must be admitted: %v", err)
	}
	if err := p.QueryRow(ctx, `SELECT customer_address FROM sales WHERE id=$1`, addressed).Scan(&address); err != nil || address != "Av. Colón 1234, Barrio Norte" {
		t.Fatalf("the address must be stored as written: %q %v", address, err)
	}
	// The header refuses an address of two hundred one characters before a line is
	// ever written, so the bound is the database's and not the screen's.
	wide, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the refused-sale transaction could not start")
	}
	_, err = wide.Exec(ctx, `INSERT INTO sales(branch_location_id,cash_amount,customer_name,customer_address,total,created_by_account_id)
 VALUES(2,2000.00,'Cliente',$1,2000.00,2)`, strings.Repeat("a", 201))
	execRefusal(t, err, "23514")
	_ = wide.Rollback(ctx)
	// The header stays immutable, so the address is written once, with the sale.
	if _, err := p.Exec(ctx, `UPDATE sales SET customer_address='otra' WHERE id=$1`, addressed); err == nil {
		t.Fatal("the address must never be corrected after the sale")
	}

	// A line of three with two units is refused as a whole, at commit.
	tx, short := openSale(t, ctx, p, 3)
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'SHORT001'),($1,1,2,'SHORT002')`, short); err != nil {
		t.Fatalf("the two units of a short document must be insertable: %v", err)
	}
	commitRefusal(t, ctx, tx, "LV012")

	// A sale that forgot its units cannot be stored either: the check hangs on the sale.
	tx, _ = openSale(t, ctx, p, 1)
	commitRefusal(t, ctx, tx, "LV012")

	// An ordinal beyond the quantity of its line is refused before the row exists.
	tx, over := openSale(t, ctx, p, 2)
	_, err = tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,3,'OVER001')`, over)
	execRefusal(t, err, "LV011")
	_ = tx.Rollback(ctx)

	// The same battery cannot be sold twice, and the comparison folds case and trims.
	tx, dup := openSale(t, ctx, p, 2)
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'DUP001')`, dup); err != nil {
		t.Fatalf("the first unit of the duplicate document must be insertable: %v", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,2,'  dup001 ')`, dup)
	execRefusal(t, err, "LV009")
	_ = tx.Rollback(ctx)

	// A unit without a persisted line is a claim about stock that was not sold.
	tx, orphan := openSale(t, ctx, p, 1)
	_, err = tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,2,1,'ORPH001')`, orphan)
	execRefusal(t, err, "LV010")
	_ = tx.Rollback(ctx)

	// The term is one to one hundred twenty months or nothing at all.
	for _, months := range []string{"0", "121", "-1"} {
		tx, bad := openSale(t, ctx, p, 1)
		_, err = tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number,warranty_months)
 VALUES($1,1,1,'TERM'||$2,$2::smallint)`, bad, months)
		execRefusal(t, err, "23514")
		_ = tx.Rollback(ctx)
	}

	// A serial is between one and sixty-four characters after trimming.
	for name, serial := range map[string]string{
		"blank":    "   ",
		"too_long": strings.Repeat("S", 65),
	} {
		tx, bad := openSale(t, ctx, p, 1)
		_, err = tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,$2)`, bad, serial)
		if code := execRefusalCode(err); code != "23514" {
			t.Errorf("a %s serial must be refused by the column bound: %s", name, code)
		}
		_ = tx.Rollback(ctx)
	}

	// Sold units are immutable: no update, no delete, no truncate.
	if _, err := p.Exec(ctx, `UPDATE sale_units SET warranty_months=99`); err == nil {
		t.Fatal("a sold unit must never be updated")
	}
	if _, err := p.Exec(ctx, `DELETE FROM sale_units`); err == nil {
		t.Fatal("a sold unit must never be deleted")
	}
}

// openSale starts one document with a single line of the asked quantity and leaves the
// transaction to the caller, so every refusal is observed where it happens: at the
// statement for an immediate guard, at commit for the deferred one.
func openSale(t *testing.T, ctx context.Context, p *pgxpool.Pool, quantity int64) (pgx.Tx, int64) {
	t.Helper()
	return openSaleAt(t, ctx, p, quantity, "")
}

// openSaleAt is openSale with the address the counter wrote down.
func openSaleAt(t *testing.T, ctx context.Context, p *pgxpool.Pool, quantity int64, address string) (pgx.Tx, int64) {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the sale transaction could not start")
	}
	var id int64
	// The line total is the branch minimum times the quantity, so the header closes.
	amount := 2000 * quantity
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,customer_name,customer_address,total,created_by_account_id)
 VALUES(2,$1::numeric,'Cliente',$2,$1::numeric,2) RETURNING id`, amount, address).Scan(&id); err != nil {
		t.Fatalf("the sale header could not be stored: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,$2,2000.00)`, id, quantity); err != nil {
		t.Fatalf("the sale line could not be stored: %v", err)
	}
	return tx, id
}

// commitRefusal asserts the deferred guard fired with its own SQLSTATE.
func commitRefusal(t *testing.T, ctx context.Context, tx pgx.Tx, code string) {
	t.Helper()
	err := tx.Commit(ctx)
	if got := execRefusalCode(err); got != code {
		t.Fatalf("expected SQLSTATE %s at commit, got %s: %v", code, got, err)
	}
}

// execRefusal asserts an immediate guard fired with its own SQLSTATE.
func execRefusal(t *testing.T, err error, code string) {
	t.Helper()
	if got := execRefusalCode(err); got != code {
		t.Fatalf("expected SQLSTATE %s, got %s: %v", code, got, err)
	}
}

func execRefusalCode(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}
