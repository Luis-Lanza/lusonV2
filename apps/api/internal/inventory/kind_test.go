package inventory

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
)

// otherProduct seeds one other product exactly like the catalog route writes it:
// a free name, one polarity-less variant that the balance fan-out stocks with
// zero in every active location, and one typed field.
func otherProduct(t *testing.T, ctx context.Context, p *pgxpool.Pool, name, fieldName, unit, number string) (int, int) {
	t.Helper()
	var entry, variant int
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
	return entry, variant
}

// otherTextProduct seeds one other product whose only typed field is free text,
// exactly like the catalog route writes it.
func otherTextProduct(t *testing.T, ctx context.Context, p *pgxpool.Pool, name, fieldName, text string) (int, int) {
	t.Helper()
	entry, variant := otherProductFields(t, ctx, p, name)
	if _, err := p.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,text_value)
 VALUES($1,$2,'text',$3)`, entry, fieldName, text); err != nil {
		t.Fatal("product text field fixture setup failed")
	}
	return entry, variant
}

// otherProductFields seeds the entry and its single polarity-less variant, the
// part both product fixtures share.
func otherProductFields(t *testing.T, ctx context.Context, p *pgxpool.Pool, name string) (int, int) {
	t.Helper()
	var entry, variant int
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product fixture setup failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, entry); err != nil {
		t.Fatal("product variant fixture setup failed")
	}
	if err := p.QueryRow(ctx, `SELECT id FROM catalog_variants WHERE catalog_entry_id=$1`, entry).Scan(&variant); err != nil {
		t.Fatal("product variant read failed")
	}
	return entry, variant
}

// The product search reads the content of the typed fields, not only the name:
// the ingress picker promises "nombre o dato del producto" and the typed fields
// are the point of having them. The battery search keeps its own columns, because
// a typed field only ever belongs to a product.
func TestInventorySearchReadsProductFields(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize fixture failed")
	}
	s := New(p)
	actor := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	_, watery := otherProduct(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	_, gloved := otherTextProduct(t, ctx, p, "Guantes de nitrilo", "presentación", "pack x12")
	// The field's own name and its unit are part of what the row shows, so they are
	// searchable too: neither "Litros" nor "bidón" appears in this product's name
	// or in the value of its field.
	_, litred := otherProduct(t, ctx, p, "Refrigerante listo", "Litros", "bidón", "7")

	product := func(search string, kind catalog.KindFilter) Page {
		t.Helper()
		page, err := s.List(ctx, actor, Query{LocationID: 1, Kind: kind, Search: search, Page: 1, PageSize: 50})
		if err != nil {
			t.Fatalf("the product search %q must be answered: %v", search, err)
		}
		return page
	}

	// The name still selects the product.
	if byName := product("acidulada", catalog.OtherOnly); byName.TotalVariants != 1 || len(byName.Items) != 1 || byName.Items[0].VariantID != watery {
		t.Fatalf("a product name must select its product: %+v", byName)
	}
	// The value of a number field selects it too: "5" is nowhere in its name.
	byNumber := product("5", catalog.OtherOnly)
	if byNumber.TotalVariants != 1 || len(byNumber.Items) != 1 || byNumber.Items[0].VariantID != watery ||
		byNumber.Items[0].Name != "Agua acidulada" || byNumber.Items[0].Detail != "volumen en L: 5 L" {
		t.Fatalf("a number field value must select its product: %+v", byNumber)
	}
	// The text of a text field selects it as well.
	byText := product("x12", catalog.OtherOnly)
	if byText.TotalVariants != 1 || len(byText.Items) != 1 || byText.Items[0].VariantID != gloved ||
		byText.Items[0].Detail != "presentación: pack x12" {
		t.Fatalf("a text field value must select its product: %+v", byText)
	}
	// The name of the field selects it, and so does its unit: the row displays both,
	// and a term a row displays must answer that row.
	for _, term := range []string{"Litros", "bidón"} {
		byFieldPart := product(term, catalog.OtherOnly)
		if byFieldPart.TotalVariants != 1 || len(byFieldPart.Items) != 1 || byFieldPart.Items[0].VariantID != litred ||
			byFieldPart.Items[0].Detail != "Litros: 7 bidón" {
			t.Fatalf("the field term %q must select its product: %+v", term, byFieldPart)
		}
	}
	// Both kinds together answer the same product, and the battery-only listing
	// never gains one: a field term belongs to its product and nowhere else.
	if both := product("x12", catalog.AllKinds); both.TotalVariants != 1 || both.Items[0].VariantID != gloved {
		t.Fatalf("the all-kinds search must answer the product: %+v", both)
	}
	for _, term := range []string{"x12", "volumen", "acidulada", "Litros", "bidón"} {
		if batteries := product(term, ""); batteries.TotalVariants != 0 || len(batteries.Items) != 0 {
			t.Fatalf("the battery listing must not gain a product for %q: %+v", term, batteries)
		}
	}
	// An unknown term still finds nothing.
	if none := product("agua destilada", catalog.OtherOnly); none.TotalVariants != 0 || len(none.Items) != 0 {
		t.Fatalf("an unknown product term must find nothing: %+v", none)
	}

	// The battery search keeps its own columns: the brand and the model of a
	// battery still select it, and no product is answered beside it.
	const brand = "TOYO_MOTO"
	byBrand := product(brand, "")
	if byBrand.TotalVariants == 0 || len(byBrand.Items) == 0 {
		t.Fatalf("the battery brand search must keep working: %+v", byBrand)
	}
	for _, item := range byBrand.Items {
		if item.Kind != catalog.BatteryKind || item.Battery == nil || item.Battery.Brand != brand {
			t.Fatalf("a battery brand search must answer batteries of that brand only: %+v", item)
		}
	}
	if products := product(brand, catalog.OtherOnly); products.TotalVariants != 0 {
		t.Fatalf("a battery brand must never select a product: %+v", products)
	}
	listing, err := s.List(ctx, actor, Query{LocationID: 1, Page: 1, PageSize: 10})
	if err != nil || len(listing.Items) == 0 {
		t.Fatalf("the default listing must answer batteries: %v", err)
	}
	model := listing.Items[0].Battery.Model
	byModel := product(model, "")
	if byModel.TotalVariants == 0 {
		t.Fatalf("the battery model search must keep working: %+v", byModel)
	}
	for _, item := range byModel.Items {
		if item.Kind != catalog.BatteryKind || item.Battery == nil || !strings.Contains(item.Battery.Model, model) {
			t.Fatalf("a battery model search must answer batteries of that model only: %+v", item)
		}
	}
}

// The stock screen reads both kinds. The kind selection is additive: the absent
// value is the battery-only listing every caller already had, `all` reads both and
// `other` reads the products alone, and every row carries the identity of its own
// kind.
func TestInventoryKindListing(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize fixture failed")
	}
	s := New(p)
	actor := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	entry, variant := otherProduct(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")

	// The absent kind is the battery-only listing: 190 battery variants, each with
	// its battery identity and no typed field.
	page, err := s.List(ctx, actor, Query{LocationID: 1, Page: 1, PageSize: 10})
	if err != nil || page.TotalVariants != 190 || len(page.Items) != 10 {
		t.Fatalf("the default listing must stay battery-only: %+v %v", page.TotalVariants, err)
	}
	for _, item := range page.Items {
		if item.Kind != catalog.BatteryKind || item.Name == "" || item.Detail == "" ||
			item.Battery == nil || item.Fields != nil || item.CatalogEntryID < 1 {
			t.Fatalf("a battery row must carry its battery identity: %+v", item)
		}
		if item.Name != item.Battery.Brand+" · "+item.Battery.Model ||
			item.Detail != item.Battery.Capacity+" Ah · "+item.Battery.Polarity {
			t.Fatalf("a battery row must carry the composed name and detail: %+v", item)
		}
	}
	// The explicit battery filter answers exactly the same battery-only listing.
	explicit, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.BatteryOnly, Page: 1, PageSize: 10})
	if err != nil || explicit.TotalVariants != page.TotalVariants || len(explicit.Items) != len(page.Items) {
		t.Fatal("the explicit battery filter must answer the default listing")
	}
	// Both kinds in one list: the product joins the batteries.
	all, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.AllKinds, Page: 1, PageSize: 50})
	if err != nil || all.TotalVariants != 191 {
		t.Fatalf("the all-kinds listing must count both kinds: %+v %v", all.TotalVariants, err)
	}
	last, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.AllKinds, Page: 4, PageSize: 50})
	if err != nil || len(last.Items) != 41 {
		t.Fatalf("the last all-kinds page holds the remaining rows: %d %v", len(last.Items), err)
	}
	if product := last.Items[len(last.Items)-1]; product.VariantID != variant ||
		product.Kind != catalog.OtherKind || product.Name != "Agua acidulada" ||
		product.Detail != "volumen en L: 5 L" || product.Battery != nil ||
		len(product.Fields) != 1 || product.Fields[0].Name != "volumen en L" ||
		product.Fields[0].Kind != catalog.NumberField || product.Fields[0].Unit != "L" ||
		product.Fields[0].Number == nil || *product.Fields[0].Number != "5" ||
		product.CatalogEntryID != entry {
		t.Fatalf("the product row must carry its product identity: %+v", product)
	}
	// Products alone: the product picker of the ingress screen.
	products, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.OtherOnly, Page: 1, PageSize: 10})
	if err != nil || products.TotalVariants != 1 || len(products.Items) != 1 {
		t.Fatalf("the product listing must answer the only product: %+v %v", products.TotalVariants, err)
	}
	product := products.Items[0]
	if product.VariantID != variant || product.Kind != catalog.OtherKind || product.Battery != nil ||
		len(product.Fields) != 1 || product.Existing != 0 || product.Reserved != 0 || product.Available != 0 {
		t.Fatalf("the product row must be the persisted zero-balance variant: %+v", product)
	}
	// A brand is a battery attribute: the brand filter keeps answering the same
	// batteries it always did, even when both kinds are listed together.
	const brand = "TOYO_MOTO"
	batteries, err := s.List(ctx, actor, Query{LocationID: 1, Brand: brand, Page: 1, PageSize: 50})
	if err != nil || batteries.TotalVariants == 0 {
		t.Fatalf("the battery brand filter must keep working: %+v %v", batteries.TotalVariants, err)
	}
	for _, item := range batteries.Items {
		if item.Kind != catalog.BatteryKind || item.Battery == nil || item.Battery.Brand != brand {
			t.Fatalf("a brand filter must answer batteries of that brand only: %+v", item)
		}
	}
	if branded, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.AllKinds, Brand: brand, Page: 1, PageSize: 50}); err != nil || branded.TotalVariants != batteries.TotalVariants {
		t.Fatalf("the brand filter must answer the same batteries in both listings: %+v %v", branded.TotalVariants, err)
	}
	// An unknown brand is still refused before the listing.
	if _, err := s.List(ctx, actor, Query{LocationID: 1, Kind: catalog.AllKinds, Brand: "unknown", Page: 1, PageSize: 10}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown brand must be refused: %v", err)
	}
	// The kind filter is the frozen three-state selection and an unknown one never
	// reaches the database.
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	closed := New(dead)
	for _, kind := range []catalog.KindFilter{"", catalog.AllKinds, catalog.BatteryOnly, catalog.OtherOnly} {
		if _, err := closed.List(ctx, actor, Query{LocationID: 1, Kind: kind, Page: 1, PageSize: 10}); err == nil {
			t.Fatalf("an admitted kind %q must reach the database", kind)
		}
	}
	for _, kind := range []catalog.KindFilter{"gift", "ALL", "batteries", "other "} {
		if _, err := closed.List(ctx, actor, Query{LocationID: 1, Kind: kind, Page: 1, PageSize: 10}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("the kind %q must be refused before the database", kind)
		}
	}
	// The metadata brands list stays battery-only: a product carries no brand.
	metadata, err := s.Metadata(ctx, actor)
	if err != nil || len(metadata.Brands) != 11 {
		t.Fatalf("the brand list must not gain a product: %d %v", len(metadata.Brands), err)
	}
}
