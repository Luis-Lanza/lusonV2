package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/catalog"
	"luson/api/internal/transfers"
)

// productVariant inserts one other product with its typed volume field and its
// single polarity-less variant, which the catalogue fan-out already stocks in
// every active location, then gives it stock in one location.
func productVariant(t *testing.T, ctx context.Context, p *pgxpool.Pool, name string, location int, stock int64) int64 {
	t.Helper()
	var entry, variant int64
	if p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry) != nil {
		t.Fatal("product catalogue entry setup failed")
	}
	if p.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`, entry).Scan(&variant) != nil {
		t.Fatal("product variant setup failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,'volumen en L','number','L',5)`, entry); err != nil {
		t.Fatal("product typed field setup failed")
	}
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=$3 WHERE location_id=$1 AND variant_id=$2`, location, variant, stock); err != nil {
		t.Fatal("product stock setup failed")
	}
	return variant
}

// variantStock snapshots the balance rows of the named variants, so a refused
// write can be proven to have changed nothing.
func variantStock(t *testing.T, ctx context.Context, p *pgxpool.Pool, variants ...int64) []stockRow {
	t.Helper()
	ids := make([]int32, len(variants))
	for i, variant := range variants {
		ids[i] = int32(variant)
	}
	rows, err := p.Query(ctx, `SELECT location_id,variant_id,existing,reserved,available FROM inventory_balances
 WHERE variant_id=ANY($1::integer[]) ORDER BY location_id,variant_id`, ids)
	if err != nil {
		t.Fatal("variant stock snapshot failed")
	}
	defer rows.Close()
	result := []stockRow{}
	for rows.Next() {
		var row stockRow
		if rows.Scan(&row.Location, &row.Variant, &row.Existing, &row.Reserved, &row.Available) != nil {
			t.Fatal("variant stock snapshot scan failed")
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		t.Fatal("variant stock snapshot incomplete")
	}
	return result
}

// S1: a transfer document carries one kind. The kind is derived from the
// document's own lines and never stored, so a body naming variants of both kinds
// is refused whole as invalid and writes nothing.
func TestS1MixedCatalogueKindsRefused(t *testing.T) {
	ctx, p, s := fixture(t)
	product := productVariant(t, ctx, p, "Agua acidulada", 1, 5)
	before := variantStock(t, ctx, p, 1, 2, product)
	in := input() // battery variants 2 and 1, both stocked at the origin
	in.Items = append(in.Items, transfers.Line{VariantID: product, Quantity: 1})
	result, err := s.Create(ctx, actor(2), in)
	if !errors.Is(err, transfers.ErrInvalid) || !reflect.DeepEqual(result, transfers.CreateResult{}) {
		t.Fatalf("a document naming both catalogue kinds was not refused whole: %v", err)
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 0 ||
		scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 0 {
		t.Fatal("a refused mixed document wrote transfer rows")
	}
	unchanged(t, before, variantStock(t, ctx, p, 1, 2, product))
}

// S3/S4: the line the server publishes is the shared catalogue identity of its
// own variant, and the document names the kind its own lines hold, derived on
// read and never stored.
func TestS3S4ProductDocumentReadsItsIdentity(t *testing.T) {
	ctx, p, s := fixture(t)
	product := productVariant(t, ctx, p, "Agua acidulada", 1, 5)
	in := transfers.CreateInput{Kind: transfers.RequestStock, CounterpartyID: 1,
		RetryKey: "product-identity-key-0001", Items: []transfers.Line{{VariantID: product, Quantity: 2}}}
	created := create(t, ctx, s, 2, in)
	item := created.Request.Items[0]
	if item.Kind != catalog.OtherKind || item.Name != "Agua acidulada" ||
		item.Detail != "volumen en L: 5 L" || item.Battery != nil || len(item.Fields) != 1 ||
		item.Fields[0].Name != "volumen en L" || item.Fields[0].Unit != "L" ||
		item.Quantity != 2 || int64(item.VariantID) != product {
		t.Fatalf("published product line is not its catalogue identity: %+v", item)
	}
	if created.Request.CatalogueKind() != catalog.OtherKind {
		t.Fatal("a one-kind product document did not name its kind")
	}
	// A replay answers the persisted document instead of re-judging it.
	replay := create(t, ctx, s, 2, in)
	if !replay.Replayed || replay.Request.ID != created.Request.ID ||
		!reflect.DeepEqual(replay.Request.Items, created.Request.Items) {
		t.Fatal("a product document replay did not answer the persisted document")
	}
	// Detail and list read the same identity.
	got, err := s.Get(ctx, actor(2), created.Request.ID)
	if err != nil || !reflect.DeepEqual(got.Items, created.Request.Items) || got.CatalogueKind() != catalog.OtherKind {
		t.Fatalf("detail lost the product identity: %v", err)
	}
	page, err := s.List(ctx, actor(2), transfers.Query{})
	if err != nil || page.Total != 1 || len(page.Records) != 1 ||
		!reflect.DeepEqual(page.Records[0].Items, created.Request.Items) {
		t.Fatalf("list lost the product identity: %v", err)
	}
	// A battery document keeps its battery identity and its own kind.
	battery := create(t, ctx, s, 2, input())
	line := battery.Request.Items[0]
	if line.Kind != catalog.BatteryKind || line.Battery == nil || line.Battery.Brand == "" ||
		line.Name != catalog.BatteryName(line.Battery.Brand, line.Battery.Model) ||
		line.Detail != catalog.BatteryDetail(line.Battery.Capacity, line.Battery.Polarity) || line.Fields != nil {
		t.Fatalf("battery line lost its identity: %+v", line)
	}
	if battery.Request.CatalogueKind() != catalog.BatteryKind {
		t.Fatal("a battery document did not name its kind")
	}
}

// S4: a document whose lines disagree names no kind, yet every line keeps its own
// shape: no reader picks one shape from the first line.
func TestS4DisagreeingLinesRenderEachIdentity(t *testing.T) {
	volume := "5"
	product := catalog.ProductIdentity(211, "Agua acidulada", []catalog.Field{
		{Name: "volumen en L", Kind: catalog.NumberField, Unit: "L", Number: &volume}})
	battery := catalog.BatteryIdentity(1, "CAR", "NS40ZL", "35", "L")
	mixed := transfers.Request{Items: []transfers.Item{transfers.NewItem(product, 1), transfers.NewItem(battery, 1)}}
	if mixed.CatalogueKind() != "" {
		t.Fatal("disagreeing lines named one kind")
	}
	if mixed.Items[0].Battery != nil || mixed.Items[1].Fields != nil || mixed.Items[0].Detail == mixed.Items[1].Detail {
		t.Fatal("one line's shape leaked into the other line")
	}
	for _, tc := range []struct {
		identity catalog.Identity
		want     catalog.Kind
	}{{battery, catalog.BatteryKind}, {product, catalog.OtherKind}} {
		if got := (transfers.Request{Items: []transfers.Item{transfers.NewItem(tc.identity, 1)}}).CatalogueKind(); got != tc.want {
			t.Fatalf("one-kind document named %q, want %q", got, tc.want)
		}
	}
	if got := (transfers.Request{}).CatalogueKind(); got != "" {
		t.Fatalf("a document with no line named the kind %q", got)
	}
}
