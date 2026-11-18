package stockentries_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/catalog"
	"luson/api/internal/stockentries"
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

// An ingress document is of one kind and never mixes. A product-only document is
// the wire line it always was (a variant id and a quantity) and it reads back with
// the product identity, without inventing a battery attribute.
func TestCreateEntryAdmitsOtherProducts(t *testing.T) {
	ctx, p, s := fixture(t)
	variant := otherVariant(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	before, reserved := balances(t, ctx, p, 1, int(variant))
	entry, replayed, err := s.CreateEntry(ctx, warehouse(), input("other-ingress-key-000001",
		stockentries.Line{VariantID: variant, Quantity: 5}))
	if err != nil || replayed {
		t.Fatalf("a product-only ingress must be admitted: %v", err)
	}
	if len(entry.Lines) != 1 || entry.Lines[0].VariantID != variant || entry.Lines[0].Quantity != 5 ||
		entry.TotalUnits != 5 || entry.LocationID != 1 {
		t.Fatalf("the persisted document is not the wire document: %+v", entry)
	}
	if existing, stillReserved := balances(t, ctx, p, 1, int(variant)); existing != before+5 || stillReserved != reserved {
		t.Fatalf("ingress must add to existing and never touch reserved: %d/%d", existing, stillReserved)
	}
	// The document is readable after it is written, and its line is labelled with
	// the product identity instead of a battery attribute.
	detail := readDetail(t, ctx, s, entry.ID)
	if len(detail.Lines) != 1 || detail.TotalUnits != 5 {
		t.Fatalf("the product ingress detail must carry its line: %+v", detail)
	}
	line := detail.Lines[0]
	if line.VariantID != int(variant) || line.Quantity != 5 {
		t.Fatalf("the detail line is not the persisted line: %+v", line)
	}
	if line.Kind != catalog.OtherKind || line.Name != "Agua acidulada" ||
		line.Detail != "volumen en L: 5 L" || line.Battery != nil {
		t.Fatalf("the detail line must carry the product identity: %+v", line)
	}
	if len(line.Fields) != 1 || line.Fields[0].Name != "volumen en L" ||
		line.Fields[0].Kind != catalog.NumberField || line.Fields[0].Unit != "L" ||
		line.Fields[0].Number == nil || *line.Fields[0].Number != "5" {
		t.Fatalf("the detail line must carry the typed fields: %+v", line.Fields)
	}
	// The reversal of a product ingress derives its lines from the persisted
	// document, so it works without a battery attribute too.
	counter, _, err := s.ReverseEntry(ctx, warehouse(), entry.ID, "other-ingress-counter-01", "error de carga")
	if err != nil {
		t.Fatalf("the product ingress must be reversible: %v", err)
	}
	if existing, _ := balances(t, ctx, p, 1, int(variant)); existing != before {
		t.Fatalf("the counter-entry must restore the product balance: %d", existing)
	}
	counterDetail := readDetail(t, ctx, s, counter.ID)
	if len(counterDetail.Lines) != 1 || counterDetail.Lines[0].Quantity != -5 ||
		counterDetail.Lines[0].Kind != catalog.OtherKind || counterDetail.TotalUnits != -5 {
		t.Fatalf("the counter-entry detail must carry the negative product line: %+v", counterDetail)
	}
}

// A request whose lines name both kinds is refused whole: no document, no line
// and no balance change.
func TestCreateEntryRefusesMixedKinds(t *testing.T) {
	ctx, p, s := fixture(t)
	variant := otherVariant(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	batteryBefore, _ := balances(t, ctx, p, 1, 1)
	productBefore, _ := balances(t, ctx, p, 1, int(variant))
	before := snapshot(t, ctx, p)
	for name, lines := range map[string][]stockentries.Line{
		"battery_then_product": {{VariantID: 1, Quantity: 2}, {VariantID: variant, Quantity: 3}},
		"product_then_battery": {{VariantID: variant, Quantity: 3}, {VariantID: 1, Quantity: 2}},
	} {
		if _, _, err := s.CreateEntry(ctx, warehouse(), input("mixed-ingress-key-000001", lines...)); !errors.Is(err, stockentries.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
		if snapshot(t, ctx, p) != before {
			t.Fatalf("%s must not write a document, a line or a balance", name)
		}
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries"); n != 0 {
		t.Fatal("a mixed document must not persist a document")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entry_lines"); n != 0 {
		t.Fatal("a mixed document must not persist a line")
	}
	if battery, _ := balances(t, ctx, p, 1, 1); battery != batteryBefore {
		t.Fatal("a mixed document must not move the battery balance")
	}
	if product, _ := balances(t, ctx, p, 1, int(variant)); product != productBefore {
		t.Fatal("a mixed document must not move the product balance")
	}
	// The same warehouse still admits either kind alone, so the refusal is the
	// mixing and not the product.
	if _, _, err := s.CreateEntry(ctx, warehouse(), input("mixed-ingress-key-000002",
		stockentries.Line{VariantID: variant, Quantity: 1})); err != nil {
		t.Fatalf("a product-only document must still be admitted: %v", err)
	}
}
