package stockadjustments_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/catalog"
	"luson/api/internal/stockadjustments"
)

// otherVariant seeds one other product exactly like the catalog route writes it:
// a free name, one polarity-less variant that the balance fan-out stocks with
// zero in every active location, and one typed field.
func otherVariant(t *testing.T, ctx context.Context, p *pgxpool.Pool, name, fieldName, unit, number string) int64 {
	t.Helper()
	var entry, variant int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product fixture setup failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, entry); err != nil {
		t.Fatal("product variant fixture setup failed")
	}
	if err := p.QueryRow(ctx, `SELECT id FROM catalog_variants WHERE catalog_entry_id=$1`, entry).Scan(&variant); err != nil {
		t.Fatal("product variant read failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,$2,'number',$3,$4::numeric)`, entry, fieldName, unit, number); err != nil {
		t.Fatal("product field fixture setup failed")
	}
	return variant
}

// A product adjustment is written and then read back: the document must stop
// producing an unreadable detail, and the database keeps owning the expected
// snapshot and the applied difference.
func TestCreateAppliesOtherProduct(t *testing.T) {
	ctx, p, s := fixture(t)
	variant := otherVariant(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	setBalance(t, ctx, p, variant, 4, 0)
	adjustment, replayed, err := s.Create(ctx, warehouse(), input("other-adjustment-key-01",
		stockadjustments.Line{VariantID: variant, Counted: 7}))
	if err != nil || replayed {
		t.Fatalf("a product adjustment must be admitted: %v", err)
	}
	if len(adjustment.Lines) != 1 || adjustment.TotalDifference != 3 {
		t.Fatalf("the document must carry the applied difference: %+v", adjustment)
	}
	if existing, reserved := balances(t, ctx, p, 1, int(variant)); existing != 7 || reserved != 0 {
		t.Fatalf("the count must be applied to the product balance: %d/%d", existing, reserved)
	}
	// The expected snapshot is still the database's own trigger-derived value.
	if expected, counted := persistedLine(t, ctx, p, adjustment.ID, variant); expected != 4 || counted != 7 {
		t.Fatalf("the expected snapshot must stay trigger-owned: %d/%d", expected, counted)
	}
	detail := readDetail(t, ctx, s, adjustment.ID)
	if len(detail.Lines) != 1 || detail.TotalDifference != 3 {
		t.Fatalf("the product adjustment detail must carry its line: %+v", detail)
	}
	line := detail.Lines[0]
	if line.VariantID != int(variant) || line.Expected != 4 || line.Counted != 7 || line.Difference != 3 {
		t.Fatalf("the detail line is not the persisted arithmetic: %+v", line)
	}
	if line.Kind != catalog.OtherKind || line.Name != "Agua acidulada" ||
		line.Detail != "volumen en L: 5 L" || line.Battery != nil || line.CatalogEntryID < 1 {
		t.Fatalf("the detail line must carry the product identity: %+v", line)
	}
	if len(line.Fields) != 1 || line.Fields[0].Name != "volumen en L" ||
		line.Fields[0].Number == nil || *line.Fields[0].Number != "5" {
		t.Fatalf("the detail line must carry the typed fields: %+v", line.Fields)
	}
	// The product adjustment is reversible like any other document.
	counter, _, err := s.Reverse(ctx, warehouse(), adjustment.ID, "other-adjustment-counter1", "conteo mal tomado")
	if err != nil {
		t.Fatalf("the product adjustment must be reversible: %v", err)
	}
	if existing, _ := balances(t, ctx, p, 1, int(variant)); existing != 4 {
		t.Fatalf("the counter-entry must restore the product balance: %d", existing)
	}
	counterDetail := readDetail(t, ctx, s, counter.ID)
	if len(counterDetail.Lines) != 1 || counterDetail.Lines[0].Kind != catalog.OtherKind ||
		counterDetail.TotalDifference != -3 {
		t.Fatalf("the counter-entry detail must carry the product line: %+v", counterDetail)
	}
}

// A count that names both kinds is refused whole: no document, no line and no
// balance change.
func TestCreateRefusesMixedKinds(t *testing.T) {
	ctx, p, s := fixture(t)
	variant := otherVariant(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	setBalance(t, ctx, p, variant, 4, 0)
	setBalance(t, ctx, p, 1, 10, 0)
	before := snapshot(t, ctx, p)
	for name, lines := range map[string][]stockadjustments.Line{
		"battery_then_product": {{VariantID: 1, Counted: 9}, {VariantID: variant, Counted: 5}},
		"product_then_battery": {{VariantID: variant, Counted: 5}, {VariantID: 1, Counted: 9}},
	} {
		if _, _, err := s.Create(ctx, warehouse(), input("mixed-adjustment-key-001", lines...)); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
		if snapshot(t, ctx, p) != before {
			t.Fatalf("%s must not write a document, a line or a balance", name)
		}
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 0 {
		t.Fatal("a mixed document must not persist a document")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustment_lines"); n != 0 {
		t.Fatal("a mixed document must not persist a line")
	}
	if existing, _ := balances(t, ctx, p, 1, 1); existing != 10 {
		t.Fatal("a mixed document must not move the battery balance")
	}
	if existing, _ := balances(t, ctx, p, 1, int(variant)); existing != 4 {
		t.Fatal("a mixed document must not move the product balance")
	}
	// The same warehouse still admits either kind alone.
	if _, _, err := s.Create(ctx, warehouse(), input("mixed-adjustment-key-002",
		stockadjustments.Line{VariantID: variant, Counted: 4})); err != nil {
		t.Fatalf("a product-only count must still be admitted: %v", err)
	}
}

// The blind capture catalogue follows the same kind selection as the stock read:
// the absent value is the battery-only catalogue every caller had, and the product
// picker reads the product alone with its identity.
func TestCatalogKindFilter(t *testing.T) {
	ctx, p, s := fixture(t)
	variant := otherVariant(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	battery := stockadjustments.CatalogQuery{Page: 1, PageSize: 25}
	page, err := s.Catalog(ctx, warehouse(), battery)
	if err != nil || page.TotalVariants != 190 || len(page.Items) != 25 {
		t.Fatalf("the default catalogue must stay battery-only: %+v %v", page.TotalVariants, err)
	}
	for _, item := range page.Items {
		if item.Kind != catalog.BatteryKind || item.Battery == nil || item.Fields != nil ||
			item.Name == "" || item.Detail == "" || item.CatalogEntryID < 1 {
			t.Fatalf("a battery catalogue item must carry its battery identity: %+v", item)
		}
	}
	all := stockadjustments.CatalogQuery{Kind: catalog.AllKinds, Page: 1, PageSize: 50}
	combined, err := s.Catalog(ctx, warehouse(), all)
	if err != nil || combined.TotalVariants != 191 {
		t.Fatalf("the all-kinds catalogue must count both kinds: %+v %v", combined.TotalVariants, err)
	}
	products := stockadjustments.CatalogQuery{Kind: catalog.OtherOnly, Page: 1, PageSize: 25}
	picker, err := s.Catalog(ctx, warehouse(), products)
	if err != nil || picker.TotalVariants != 1 || len(picker.Items) != 1 {
		t.Fatalf("the product picker must answer the only product: %+v %v", picker.TotalVariants, err)
	}
	item := picker.Items[0]
	if item.VariantID != int(variant) || item.Kind != catalog.OtherKind || item.Battery != nil ||
		item.Name != "Agua acidulada" || item.Detail != "volumen en L: 5 L" || len(item.Fields) != 1 {
		t.Fatalf("the product catalogue item must carry its product identity: %+v", item)
	}
	// An unknown kind is refused before the database.
	dead := deadPool(t, ctx, p)
	for _, kind := range []catalog.KindFilter{"gift", "ALL", "other "} {
		if _, err := stockadjustments.New(dead).Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Kind: kind, Page: 1, PageSize: 25}); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("the kind %q must be refused before the database", kind)
		}
	}
}

// deadPool is a closed pool: a rejection proven against it never reached the
// database.
func deadPool(t *testing.T, ctx context.Context, p *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	return dead
}
