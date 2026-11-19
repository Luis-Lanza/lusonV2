package sales_test

import (
	"errors"
	"testing"

	"luson/api/internal/catalog"
	"luson/api/internal/sales"
)

// variantOfEntry reads the one variant of a catalogue entry, so a test never guesses the
// identity of a product.
func variantOfEntry(t *testing.T, e *env, entryID int64) int64 {
	t.Helper()
	var variant int64
	if e.pool.QueryRow(e.ctx, "SELECT id FROM catalog_variants WHERE catalog_entry_id=$1",
		int32(entryID)).Scan(&variant) != nil {
		t.Fatal("product variant read failed")
	}
	return variant
}

// pricedProduct seeds one other product, prices it in one branch and stocks it, returning
// its catalogue entry and its variant.
func pricedProduct(t *testing.T, e *env, branch int64, minimum, suggested string, stock int64) (entry, variant int64) {
	t.Helper()
	entry = otherProduct(t, e, "Agua acidulada", "volumen en L", "L", "5")
	variant = variantOfEntry(t, e, entry)
	e.price(t, entry, minimum, suggested, branch)
	e.setStock(t, branch, variant, stock, 0)
	return entry, variant
}

// productSale is the canonical shape of a one-line product sale: one cash payment that
// closes against the line, and no unit at all because a product is counted, not serialized.
func productSale(variant, quantity int64, unit string) sales.CreateInput {
	total, err := sales.LineTotal(sales.Money(unit), quantity)
	if err != nil {
		panic("fixture product amount is not canonical: " + err.Error())
	}
	return sales.CreateInput{
		Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: total}},
		Customer: sales.Customer{Name: "Cliente Mostrador"},
		Lines: []sales.LineInput{{VariantID: variant, Quantity: quantity,
			UnitPrice: sales.Money(unit), Units: []sales.Unit{}}},
	}
}

// TestProductSaleIsReadable is the whole point of this vertical: a product sale is written
// and then read back with its own catalogue identity, in its detail, in its history row and
// in its printed document. Before this change the sale answered 201 and every read failed
// closed, because the document demanded the brand, model and polarity of a battery.
func TestProductSaleIsReadable(t *testing.T) {
	e := fixture(t)
	entry, variant := pricedProduct(t, e, 2, "1500", "1900", 10)

	created, err := e.store.Create(e.ctx, clerk(2), productSale(variant, 3, "1900.00"))
	if err != nil {
		t.Fatalf("a product sale must be admitted: %v", err)
	}
	if len(created.Lines) != 1 || created.Lines[0].VariantID != variant ||
		created.Lines[0].Quantity != 3 || len(created.Lines[0].Units) != 0 {
		t.Fatalf("the written product line must carry its quantity and no unit: %+v", created.Lines)
	}
	detail, err := e.store.Read(e.ctx, clerk(2), created.ID)
	if err != nil {
		t.Fatalf("a product sale must be readable: %v", err)
	}
	if len(detail.Lines) != 1 {
		t.Fatalf("the detail must keep the sold line: %+v", detail.Lines)
	}
	line := detail.Lines[0]
	if line.CatalogEntryID != entry || line.Kind != catalog.OtherKind ||
		line.Identity.Kind != catalog.OtherKind {
		t.Fatalf("the product line must carry its own kind and entry: %+v", line)
	}
	// The identity is the shared catalogue one: the free name and the summary of the typed
	// fields, never a battery attribute.
	if line.Identity.Name != "Agua acidulada" || line.Identity.Detail != "volumen en L: 5 L" {
		t.Fatalf("the product line must publish its own identity: %+v", line.Identity)
	}
	if line.Identity.Battery != nil || line.Identity.Fields == nil {
		t.Fatalf("a product line carries no battery attribute: %+v", line.Identity)
	}
	if len(line.Units) != 0 || line.Quantity != 3 || line.Subtotal != "5700.00" {
		t.Fatalf("a product line carries no unit and its whole quantity: %+v", line)
	}
	// The history row names the sale without unfolding it: two lines are not demanded here,
	// but a row whose units do not match its battery pieces is refused, and a product sale
	// sells no battery piece at all.
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil {
		t.Fatalf("a product sale must be a legible history row: %v", err)
	}
	if page.TotalSales != 1 || len(page.Sales) != 1 {
		t.Fatalf("the history must hold the one sale: %+v", page)
	}
	row := page.Sales[0]
	if row.ID != created.ID || row.Lines != 1 || row.UnitsTotal != 0 ||
		row.UnitsWithWarranty != 0 || row.BatteryUnits != 0 || row.Total != "5700.00" {
		t.Fatalf("the history row must describe a product sale: %+v", row)
	}
	// The sale still moved the stock of the branch: a product is stock like a battery.
	if existing, reserved := e.stock(t, 2, variant); existing != 7 || reserved != 0 {
		t.Fatalf("the product sale must deduct its stock: %d/%d", existing, reserved)
	}
}

// TestMixedSaleIsReadable pins S3 on the read side: one sale carries a battery and a product,
// nothing is refused for mixing them, and each line is read and judged by its own identity.
func TestMixedSaleIsReadable(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	entry, product := pricedProduct(t, e, 2, "1500", "1900", 10)
	batteryExisting, _ := e.stock(t, 2, 3)
	if batteryExisting < 1 {
		t.Fatalf("the fixture expects battery stock to sell, got %d", batteryExisting)
	}
	total, err := sales.LineTotal(sales.Money("85000.00"), 1)
	if err != nil {
		t.Fatal("the fixture amount is not canonical")
	}
	productTotal, err := sales.LineTotal(sales.Money("1900.00"), 2)
	if err != nil {
		t.Fatal("the fixture amount is not canonical")
	}
	// A single cash payment settles both lines exactly.
	both, err := sales.LineTotal(sales.Money("88800.00"), 1)
	if err != nil || total != "85000.00" || productTotal != "3800.00" || both != "88800.00" {
		t.Fatal("the mixed fixture does not add up")
	}
	created, err := e.store.Create(e.ctx, clerk(2), sales.CreateInput{
		Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "88800.00"}},
		Customer: sales.Customer{Name: "Cliente Mostrador", Phone: "700-00000", Document: "V-123"},
		Lines: []sales.LineInput{
			// The battery line carries one unit per sold piece...
			{VariantID: 3, Quantity: 1, UnitPrice: "85000.00", Units: units(1, months(6))},
			// ...and the product line carries none: its quantity is the whole line.
			{VariantID: product, Quantity: 2, UnitPrice: "1900.00", Units: nil},
		},
	})
	if err != nil {
		t.Fatalf("a mixed sale must be admitted: %v", err)
	}
	detail, err := e.store.Read(e.ctx, clerk(2), created.ID)
	if err != nil {
		t.Fatalf("a mixed sale must be readable: %v", err)
	}
	if len(detail.Lines) != 2 {
		t.Fatalf("the mixed detail must keep both lines: %+v", detail.Lines)
	}
	// Lines are ordered by variant, so the seeded battery comes first.
	battery, mixed := detail.Lines[0], detail.Lines[1]
	if battery.Kind != catalog.BatteryKind || battery.Identity.Kind != catalog.BatteryKind ||
		battery.Identity.Battery == nil || len(battery.Units) != 1 {
		t.Fatalf("the battery line must stay a battery: %+v", battery)
	}
	if mixed.Kind != catalog.OtherKind || mixed.Identity.Kind != catalog.OtherKind ||
		mixed.Identity.Name != "Agua acidulada" || mixed.CatalogEntryID != entry ||
		len(mixed.Units) != 0 || mixed.Quantity != 2 {
		t.Fatalf("the product line must be its own identity: %+v", mixed)
	}
	// Both lines moved the stock of the branch.
	if existing, _ := e.stock(t, 2, 3); existing != batteryExisting-1 {
		t.Fatalf("the battery stock must fall by one: %d", existing)
	}
	if existing, _ := e.stock(t, 2, product); existing != 8 {
		t.Fatalf("the product stock must fall by two: %d", existing)
	}
	// The history row is legible even though the sale carries fewer units than lines: the
	// units are the battery pieces, not the lines.
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil {
		t.Fatalf("a mixed sale must be a legible history row: %v", err)
	}
	row := page.Sales[0]
	if row.Lines != 2 || row.UnitsTotal != 1 || row.UnitsWithWarranty != 1 ||
		row.BatteryUnits != 1 || row.Total != "88800.00" {
		t.Fatalf("the history row must describe the mixed sale: %+v", row)
	}
}

// TestProductLineCarriesNoUnits pins the refusal of S1: a product is counted, so a line that
// carries a unit is refused before anything is written, with the message of its own rule.
func TestProductLineCarriesNoUnits(t *testing.T) {
	e := fixture(t)
	_, variant := pricedProduct(t, e, 2, "1500", "1900", 10)
	before := e.snapshot(t)
	for name, pieces := range map[string]int64{"one_unit": 1, "two_units": 2} {
		in := productSale(variant, 2, "1900.00")
		in.Lines[0].Units = units(pieces, nil)
		_, err := e.store.Create(e.ctx, clerk(2), in)
		var refused *sales.ProductLineWithUnits
		if !errors.As(err, &refused) || refused.VariantID != variant {
			t.Fatalf("%s: a product line with units must be refused as its own class: %v", name, err)
		}
		if !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s: the refusal must stay the invalid-document class", name)
		}
		if e.snapshot(t) != before {
			t.Fatalf("%s: a refused product line must not write a sale, a line or a unit", name)
		}
	}
	// Nothing was written and no stock moved.
	if n := e.scalar(t, "SELECT count(*) FROM sales"); n != 0 {
		t.Fatalf("a refused product sale must write no sale, got %d", n)
	}
	if existing, _ := e.stock(t, 2, variant); existing != 10 {
		t.Fatalf("a refused product sale must not touch stock, got %d", existing)
	}
}

// TestBatteryLineRequiresUnits pins the other half of S1: a battery is sold by its serial, so
// a line that does not carry exactly one unit per sold piece is refused before anything is
// written, with the message of its own rule.
func TestBatteryLineRequiresUnits(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	before := e.snapshot(t)
	for name, line := range map[string]sales.LineInput{
		"none":  {VariantID: 3, Quantity: 1, UnitPrice: "85000.00"},
		"short": {VariantID: 3, Quantity: 2, UnitPrice: "85000.00", Units: units(1, months(6))},
	} {
		total, err := sales.LineTotal(sales.Money("85000.00"), line.Quantity)
		if err != nil {
			t.Fatal("the fixture amount is not canonical")
		}
		_, err = e.store.Create(e.ctx, clerk(2), sales.CreateInput{
			Payments: cashPayment(string(total)), Customer: sales.Customer{Name: "Cliente"},
			Lines: []sales.LineInput{line},
		})
		var refused *sales.BatteryLineWithoutUnits
		if !errors.As(err, &refused) || refused.VariantID != 3 {
			t.Fatalf("%s: a battery line without its units must be refused as its own class: %v", name, err)
		}
		if !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s: the refusal must stay the invalid-document class", name)
		}
		if e.snapshot(t) != before {
			t.Fatalf("%s: a refused battery line must not write a sale, a line or a unit", name)
		}
	}
	if n := e.scalar(t, "SELECT count(*) FROM sales"); n != 0 {
		t.Fatalf("a refused battery sale must write no sale, got %d", n)
	}
}

// TestSaleSellableListsProducts pins S5 in the store: the counter reads batteries by default,
// exactly as it always did, and a product is listed by its own kind with its price, its
// identity and the stock of the branch.
func TestSaleSellableListsProducts(t *testing.T) {
	e := fixture(t)
	entry, variant := pricedProduct(t, e, 2, "1500", "1900", 6)
	if _, err := e.pool.Exec(e.ctx, `UPDATE inventory_balances SET reserved=1
 WHERE location_id=2 AND variant_id=$1`, int32(variant)); err != nil {
		t.Fatal("product balance fixture failed")
	}
	// The default read is the battery listing every existing caller had: the product never
	// shows up and its presence never turns the page into an error.
	batteries, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatalf("the battery catalogue must be readable: %v", err)
	}
	wantBatteries := e.scalar(t, `SELECT count(*) FROM catalog_variants v
 JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE e.kind='battery'`)
	if batteries.TotalVariants != wantBatteries {
		t.Fatalf("the default catalogue must count the batteries only: %d of %d",
			batteries.TotalVariants, wantBatteries)
	}
	for _, item := range batteries.Items {
		if item.Kind != catalog.BatteryKind {
			t.Fatalf("the default catalogue must list batteries only: %+v", item)
		}
	}
	// A product is listed by its own kind, with its own identity and its own pair.
	products, err := e.store.Sellable(e.ctx, clerk(2),
		sales.SellableQuery{Kind: catalog.OtherOnly, Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("the product catalogue must be readable: %v", err)
	}
	if products.TotalVariants != 1 || len(products.Items) != 1 {
		t.Fatalf("the product catalogue must list the one product: %+v", products)
	}
	product := products.Items[0]
	if int64(product.VariantID) != variant || product.CatalogEntryID != entry ||
		product.Kind != catalog.OtherKind || product.Identity.Valid() != nil {
		t.Fatalf("the product row must carry its own identity: %+v", product)
	}
	if product.Name != "Agua acidulada" || product.Detail != "volumen en L: 5 L" ||
		product.Battery != nil {
		t.Fatalf("the product row must publish its name and detail: %+v", product.Identity)
	}
	if !product.Sellable || product.SuggestedPrice != "1900.00" || product.MinPrice != "1500.00" {
		t.Fatalf("the product row must carry the pair of its branch: %+v", product)
	}
	if product.Existing != 6 || product.Reserved != 1 || product.Available != 5 {
		t.Fatalf("the product row must carry the stock of the branch: %+v", product)
	}
	// A product without a price in the branch is still a row of its own kind, blocked.
	other, err := e.store.Sellable(e.ctx, clerk(3),
		sales.SellableQuery{Kind: catalog.OtherOnly, Page: 1, PageSize: 10})
	if err != nil || other.TotalVariants != 1 || len(other.Items) != 1 {
		t.Fatalf("another branch must still read the product row: %+v %v", other, err)
	}
	if blocked := other.Items[0]; blocked.Sellable || blocked.SuggestedPrice != "" || blocked.MinPrice != "" {
		t.Fatalf("a product without a price in the branch must be blocked: %+v", blocked)
	}
	// Both kinds in one page: each row is still described by its own identity.
	both, err := e.store.Sellable(e.ctx, clerk(2),
		sales.SellableQuery{Kind: catalog.AllKinds, Page: 1, PageSize: 50})
	if err != nil || both.TotalVariants != wantBatteries+1 {
		t.Fatalf("the whole catalogue must count both kinds: %+v %v", both, err)
	}
	for _, item := range both.Items {
		if item.Identity.Valid() != nil {
			t.Fatalf("every listed row must be a valid identity: %+v", item)
		}
	}
}
