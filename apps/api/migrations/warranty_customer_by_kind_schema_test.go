package migrations_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"luson/api/internal/testpg"
)

// beginSaleFor stores a sale header with the client the caller names, and guarantees the
// transaction is closed even when the test fails.
func beginSaleFor(t *testing.T, ctx context.Context, p *pgxpool.Pool, total, name, phone, document string) (pgx.Tx, int64) {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the sale transaction could not start")
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,customer_name,customer_phone,customer_document,total,created_by_account_id)
 VALUES(2,$1::numeric,$2,$3,$4,$1::numeric,2) RETURNING id`, total, name, phone, document).Scan(&id); err != nil {
		t.Fatalf("the sale header could not be stored: %v", err)
	}
	return tx, id
}

// The customer of a sale belongs to the warranty: a document that issues one is refused
// until the three data the printed paper carries are there, and a document of products
// alone names nobody. The address is never required, because the paper never prints it.
func TestWarrantyCustomerFollowsTheCatalogKind(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 57)
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

	// A sale of products alone names nobody: no name, no phone, no document. It is the
	// document that says "Consumidor final", and the database accepts it.
	tx, id := beginSaleFor(t, ctx, p, "1500.00", "", "", "")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,$2,3,500.00)`, id, productVariant); err != nil {
		t.Fatal("the product line must be admitted")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a product-only sale must commit without a customer: %v", err)
	}
	t.Logf("057: a product-only sale committed with no customer at all")

	// A battery sale is a warranty, and a warranty names its recipient in full: the same
	// document is refused until the three data the paper prints are there.
	tx, id = beginSaleFor(t, ctx, p, "2000.00", "Cliente", "", "123456")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00)`, id); err != nil {
		t.Fatal("the battery line must be admitted")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'CUST001')`, id); err != nil {
		t.Fatal("the battery unit must be admitted")
	}
	if code := execRefusalCode(tx.Commit(ctx)); code != "LV015" {
		t.Fatalf("a warranty sale without a phone must be refused with LV015, got %q", code)
	}

	// The address is not one of the three: a complete client never needs one.
	tx, id = beginSaleFor(t, ctx, p, "2000.00", "Cliente", "77712345", "123456")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00)`, id); err != nil {
		t.Fatal("the battery line must be admitted")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'CUST002')`, id); err != nil {
		t.Fatal("the battery unit must be admitted")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("a complete customer without an address must be admitted: %v", err)
	}
	t.Logf("057: a warranty sale with no address committed, because the paper never prints one")

	// A mixed sale issues a warranty, so its client is required just the same: the kind
	// of one line decides for the whole document.
	tx, id = beginSaleFor(t, ctx, p, "3500.00", "", "", "")
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00),($1,$2,3,500.00)`, id, productVariant); err != nil {
		t.Fatal("the mixed lines must be admitted")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,'CUST003')`, id); err != nil {
		t.Fatal("the battery unit must be admitted")
	}
	if code := execRefusalCode(tx.Commit(ctx)); code != "LV015" {
		t.Fatalf("a mixed sale without a customer must be refused with LV015, got %q", code)
	}
}
