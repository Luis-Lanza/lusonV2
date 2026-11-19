package migrations_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"luson/api/internal/testpg"
)

// migration056 is the kind-aware unit migration: it restates the two triggers that
// judge sold units so a product line carries none. No column and no third rule is
// added, and this test asserts exactly that.
const migration056 = "056_sale_units_by_catalog_kind.sql"

// beginSale stores a sale header for a customer the caller does not care about.
func beginSale(t *testing.T, ctx context.Context, p *pgxpool.Pool, total string) (pgx.Tx, int64) {
	t.Helper()
	return beginSaleFor(t, ctx, p, total, "Cliente", "", "")
}

// The rule is the database's, so every case here runs against a live one: a mixed sale
// commits, a product line with a serial is refused when the unit is admitted, and a
// battery line missing a unit is refused at commit, exactly as before.
func TestSaleUnitsFollowTheCatalogKind(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 56)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	seedBranchStock(t, ctx, p, 200, 1)

	var product int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other','Agua acidulada')
 RETURNING id`).Scan(&product); err != nil {
		t.Fatal("the product fixture failed")
	}
	var productVariant int
	if err := p.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`,
		product).Scan(&productVariant); err != nil {
		t.Fatal("the product variant fixture failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1),(2,$1,500.00,600.00,1)`, product); err != nil {
		t.Fatal("the price fixture failed")
	}
	seedBranchStock(t, ctx, p, 200, productVariant)

	// A mixed sale commits: the battery line carries its one serial, the product line
	// carries its three bottles and no serial at all. The header closes over both.
	tx, id := beginSale(t, ctx, p, "3500.00")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00),($1,$2,3,500.00)`, id, productVariant); err != nil {
		t.Fatalf("a mixed sale must be admitted: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number,warranty_months)
 VALUES($1,1,1,'KIND001',12)`, id); err != nil {
		t.Fatalf("the battery unit must be admitted: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a mixed sale must commit: %v", err)
	}
	var productBalance, batteryBalance int64
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=2 AND variant_id=$1`,
		productVariant).Scan(&productBalance); err != nil {
		t.Fatal("the product balance could not be read")
	}
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=2 AND variant_id=1`).
		Scan(&batteryBalance); err != nil {
		t.Fatal("the battery balance could not be read")
	}
	if productBalance != 197 || batteryBalance != 199 {
		t.Fatalf("both lines must deduct their own stock, got product %d and battery %d",
			productBalance, batteryBalance)
	}
	t.Logf("056: a mixed sale committed and deducted both kinds")

	// A product line does not take a serial: the unit is refused the moment it is
	// admitted, before any deferred check could run.
	tx, id = beginSale(t, ctx, p, "1500.00")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,$2,3,500.00)`, id, productVariant); err != nil {
		t.Fatal("the product line itself must be admitted")
	}
	_, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,$2,1,'BOTTLE1')`, id, productVariant)
	if code := execRefusalCode(err); code != "LV014" {
		t.Fatalf("a serial on a product line must be refused with LV014, got %q from %v", code, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("the refused sale must roll back: %v", err)
	}

	// A battery line without its serial is still refused at commit, word for word as
	// before: the new rule did not weaken the old one.
	tx, id = beginSale(t, ctx, p, "2000.00")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00)`, id); err != nil {
		t.Fatal("the battery line itself must be admitted")
	}
	if code := execRefusalCode(tx.Commit(ctx)); code != "LV012" {
		t.Fatalf("a battery line without its unit must be refused with LV012, got %q", code)
	}
}
