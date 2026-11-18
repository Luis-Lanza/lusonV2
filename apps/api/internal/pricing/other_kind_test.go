package pricing_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/catalog"
	"luson/api/internal/pricing"
)

// otherProduct seeds one other product exactly like the catalog route writes it: a
// free name, one polarity-less variant and one typed number field with a unit.
func otherProduct(t *testing.T, ctx context.Context, p *pgxpool.Pool, name, fieldName, unit, number string) int64 {
	t.Helper()
	var entry int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product fixture setup failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, entry); err != nil {
		t.Fatal("product variant fixture setup failed")
	}
	if _, err := p.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,$2,'number',$3,$4::numeric)`, entry, fieldName, unit, number); err != nil {
		t.Fatal("product field fixture setup failed")
	}
	return entry
}

// priceMatrix reads one page of the price matrix of one kind.
func priceMatrix(t *testing.T, ctx context.Context, s *pricing.Store, kind catalog.KindFilter, search string) pricing.Matrix {
	t.Helper()
	matrix, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{
		Kind: kind, Search: search, Page: 1, PageSize: pricing.DefaultPageSize,
	})
	if err != nil {
		t.Fatalf("matrix read failed: %v", err)
	}
	return matrix
}

// TestBranchPriceMatrixListsProducts is the whole point of the vertical: a product
// with a price is one row of the product listing, carrying the identity the rest of
// the application publishes and the same price pair a battery carries.
func TestBranchPriceMatrixListsProducts(t *testing.T) {
	ctx, p, s := fixture(t)
	entry := otherProduct(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	// The write path already accepts a product today; this pins it instead of
	// assuming it, because the read is what was missing.
	if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		CatalogEntryID: entry, MinPrice: "1500", SuggestedPrice: "1900", BranchIDs: []int64{2},
	}); err != nil {
		t.Fatalf("a product must accept a branch price: %v", err)
	}
	if min, suggested, account := storedPrice(t, ctx, p, 2, entry); min != "1500.00" ||
		suggested != "1900.00" || account != 1 {
		t.Fatalf("persisted product pair mismatch: %s/%s by %d", min, suggested, account)
	}
	matrix := priceMatrix(t, ctx, s, catalog.OtherOnly, "")
	if matrix.Total != 1 || len(matrix.Rows) != 1 {
		t.Fatalf("the product listing must answer the one priced product, got %d of %d",
			len(matrix.Rows), matrix.Total)
	}
	row := matrix.Rows[0]
	if row.Kind != catalog.OtherKind || row.CatalogEntryID != entry ||
		row.Name != "Agua acidulada" || row.Detail != "volumen en L: 5 L" {
		t.Fatalf("product row identity mismatch: %+v", row)
	}
	// A product carries no battery attribute, and the matrix never invents one.
	if row.Brand != "" || row.Model != "" || row.Capacity != "" ||
		len(row.Polarities) != 0 || len(row.Cells) != 0 {
		t.Fatalf("a product row must not carry battery attributes: %+v", row)
	}
	if len(row.Prices) != 1 || row.Prices[0].BranchLocationID != 2 ||
		row.Prices[0].MinPrice != "1500.00" || row.Prices[0].SuggestedPrice != "1900.00" ||
		row.Prices[0].UpdatedByAccountID != 1 {
		t.Fatalf("product prices mismatch: %+v", row.Prices)
	}
}

// TestBranchPriceMatrixDefaultStaysBattery proves the absent filter is the
// battery-only listing every existing caller already had, and that neither kind
// leaks into the other's page.
func TestBranchPriceMatrixDefaultStaysBattery(t *testing.T) {
	ctx, p, s := fixture(t)
	entry := otherProduct(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		CatalogEntryID: entry, MinPrice: "1500", SuggestedPrice: "1900", BranchIDs: []int64{2},
	}); err != nil {
		t.Fatalf("a product must accept a branch price: %v", err)
	}
	batteries := priceMatrix(t, ctx, s, "", "")
	if len(batteries.Rows) != pricing.DefaultPageSize || batteries.Total < 2 {
		t.Fatalf("the default listing must still be the battery catalogue: %d rows of %d",
			len(batteries.Rows), batteries.Total)
	}
	for _, row := range batteries.Rows {
		if row.Kind != catalog.BatteryKind || row.Brand == "" || row.Name != "" {
			t.Fatalf("the default listing must answer batteries only: %+v", row)
		}
	}
	// The product's own name must not make it appear in the battery listing, even
	// though the search reads the free name.
	if searched := priceMatrix(t, ctx, s, catalog.BatteryOnly, "Agua acidulada"); searched.Total != 0 ||
		len(searched.Rows) != 0 {
		t.Fatalf("a product must never answer the battery listing: %+v", searched.Rows)
	}
}

// TestBranchPriceMatrixSearchesProductFields pins that a term the row displays finds
// the row: the product name, the name of a typed field, its unit and its value.
func TestBranchPriceMatrixSearchesProductFields(t *testing.T) {
	ctx, p, s := fixture(t)
	otherProduct(t, ctx, p, "Agua acidulada", "volumen en L", "L", "5")
	for _, search := range []string{"Agua", "volumen", "5 L", "Litros"} {
		search := search
		matrix, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{
			Kind: catalog.OtherOnly, Search: search, Page: 1, PageSize: pricing.DefaultPageSize,
		})
		if err != nil {
			t.Fatalf("search %q failed: %v", search, err)
		}
		want := 0
		if search != "Litros" {
			want = 1
		}
		if matrix.Total != int64(want) {
			t.Fatalf("search %q must find %d product rows, found %d", search, want, matrix.Total)
		}
	}
}

// TestBranchPriceQueryAdmitsOnlyOneKind pins the read filter of this vertical: one
// page is one kind, so `all` is refused, and a battery-only filter named together
// with the product kind is refused instead of silently ignored.
func TestBranchPriceQueryAdmitsOnlyOneKind(t *testing.T) {
	base := pricing.BranchQuery{Page: 1, PageSize: pricing.DefaultPageSize}
	admit := func(mutate func(q *pricing.BranchQuery)) bool {
		q := base
		mutate(&q)
		return pricing.ValidQuery(q)
	}
	if !admit(func(q *pricing.BranchQuery) {}) ||
		!admit(func(q *pricing.BranchQuery) { q.Kind = catalog.BatteryOnly }) ||
		!admit(func(q *pricing.BranchQuery) { q.Kind = catalog.OtherOnly }) {
		t.Fatal("the battery default and both single kinds must be admitted")
	}
	for name, tc := range map[string]struct {
		mutate func(q *pricing.BranchQuery)
		want   bool
	}{
		"all":                {func(q *pricing.BranchQuery) { q.Kind = catalog.AllKinds }, false},
		"unknown_kind":       {func(q *pricing.BranchQuery) { q.Kind = "product" }, false},
		"product_with_brand": {func(q *pricing.BranchQuery) { q.Kind = catalog.OtherOnly; q.Brand = "CAR" }, false},
		"product_with_cap":   {func(q *pricing.BranchQuery) { q.Kind = catalog.OtherOnly; q.Capacity = "40" }, false},
		"battery_with_cap":   {func(q *pricing.BranchQuery) { q.Kind = catalog.BatteryOnly; q.Capacity = "40" }, true},
	} {
		want := tc.want
		if got := admit(tc.mutate); got != want {
			t.Fatalf("%s: ValidQuery admitted=%v, want %v", name, got, want)
		}
	}
	// The store refuses before the first statement, so nothing is read.
	ctx, _, s := fixture(t)
	for name, query := range map[string]pricing.BranchQuery{
		"all":                {Kind: catalog.AllKinds, Page: 1, PageSize: pricing.DefaultPageSize},
		"product_with_brand": {Kind: catalog.OtherOnly, Brand: "CAR", Page: 1, PageSize: pricing.DefaultPageSize},
	} {
		if _, err := s.Matrix(ctx, warehouse(), query); !errors.Is(err, pricing.ErrInvalid) {
			t.Fatalf("%s must be refused as an invalid request", name)
		}
	}
}

// TestBranchPriceProductRefusesBatteryFilters proves the refusal is the public one:
// a product listing asked with a battery filter is a client error, never an answer.
func TestBranchPriceProductRefusesBatteryFilters(t *testing.T) {
	ctx, _, s := fixture(t)
	if _, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{
		Kind: catalog.OtherOnly, Capacity: "40", Page: 1, PageSize: pricing.DefaultPageSize,
	}); !errors.Is(err, pricing.ErrInvalid) {
		t.Fatalf("a capacity filter on the product listing must be refused, got %v", err)
	}
	if strings.TrimSpace(string(pricing.ErrInvalid.Error())) == "" {
		t.Fatal("the invalid refusal must keep its own error")
	}
}
