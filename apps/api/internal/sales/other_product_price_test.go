package sales_test

import (
	"testing"

	"luson/api/internal/catalog"
	"luson/api/internal/sales"
)

// otherProduct seeds one other product exactly like the catalog route writes it: a
// free name, one polarity-less variant and one typed field.
func otherProduct(t *testing.T, e *env, name, fieldName, unit, number string) int64 {
	t.Helper()
	var entry int64
	if err := e.pool.QueryRow(e.ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product fixture setup failed")
	}
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, entry); err != nil {
		t.Fatal("product variant fixture setup failed")
	}
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,$2,'number',$3,$4::numeric)`, entry, fieldName, unit, number); err != nil {
		t.Fatal("product field fixture setup failed")
	}
	return entry
}

// TestPricedProductStaysOutOfTheCounter pins the boundary of this vertical: a price is
// administered for a product exactly like a battery, and the counter still does not see
// it. Selling a product is a later vertical, so a catalogue read that suddenly answered
// one would be an unrequested behaviour change.
func TestPricedProductStaysOutOfTheCounter(t *testing.T) {
	e := fixture(t)
	before, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatalf("the counter catalogue was not readable: %v", err)
	}
	entry := otherProduct(t, e, "Agua acidulada", "volumen en L", "L", "5")
	// The price write accepts the product: the pair belongs to the catalogue entry, so no
	// second table and no per-variant price is needed for it.
	e.price(t, entry, "1500", "1900", 2)
	if n := e.scalar(t, "SELECT count(*) FROM branch_prices WHERE branch_location_id=2 AND catalog_entry_id=$1", int32(entry)); n != 1 {
		t.Fatal("the product must hold one price row per branch")
	}
	after, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatalf("the counter catalogue was not readable after pricing a product: %v", err)
	}
	if after.TotalVariants != before.TotalVariants || len(after.Items) != len(before.Items) {
		t.Fatalf("a priced product changed the counter catalogue: %d variants before, %d after",
			before.TotalVariants, after.TotalVariants)
	}
	for _, item := range after.Items {
		if item.CatalogEntryID == entry {
			t.Fatalf("a product reached the point of sale: %+v", item)
		}
	}
	// The product's own name is not a battery search term either: the counter reads the
	// battery catalogue, so a term it cannot find answers nothing.
	searched, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Search: "Agua acidulada", Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("the counter catalogue search failed: %v", err)
	}
	if searched.TotalVariants != 0 || len(searched.Items) != 0 {
		t.Fatalf("a product answered a counter search: %+v", searched.Items)
	}
	// Every item the counter answers still carries the identity its label is composed
	// from, so nothing half-battery is published either.
	for _, item := range after.Items {
		if item.Kind != catalog.BatteryKind || item.Identity.Valid() != nil {
			t.Fatalf("the counter answered a row that is not a battery: %+v", item)
		}
	}
}
