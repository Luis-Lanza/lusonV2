package otherproducts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/otherproducts"
	"luson/api/internal/testpg"
)

// fixture provisions the isolated database the way every database-backed suite
// here does. Without an admitted LUSON_TEST_PG_MANIFEST the test fails closed at
// testpg.Open, which is the expected local outcome.
func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *otherproducts.Store, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("test initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("test account provisioning failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("operational fixture setup")
	}
	svc, err := auth.New(p, func() time.Time { return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal("service initialization failed")
	}
	session, token, err := svc.Login(ctx, credentials[0].Username, credentials[0].Password, "127.0.0.1", "")
	if err != nil || session.Identity.Location.ID != 1 {
		t.Fatal("warehouse login failed")
	}
	return ctx, p, otherproducts.New(p, svc), token
}

func number(t *testing.T, value string) *catalog.Decimal {
	t.Helper()
	parsed, err := otherproducts.CanonicalNumber(value)
	if err != nil {
		t.Fatalf("canonical number %q: %v", value, err)
	}
	return &parsed
}

func text(value string) *string { return &value }

func scalar(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if p.QueryRow(ctx, query, args...).Scan(&n) != nil {
		t.Fatal("scalar query failed")
	}
	return n
}

func input(name string, fields ...otherproducts.Field) otherproducts.CreateInput {
	return otherproducts.CreateInput{Name: name, Fields: fields}
}

// The example of the request: one product with a numeric volume in litres.
func volumeFields(t *testing.T) []otherproducts.Field {
	t.Helper()
	return []otherproducts.Field{
		{Name: "volumen en L", Kind: otherproducts.KindNumber, Unit: "L", Number: number(t, "5")},
		{Name: "origen", Kind: otherproducts.KindText, Text: text("importado")},
	}
}

func TestCreateWritesTheProductItsVariantAndItsFields(t *testing.T) {
	ctx, p, store, token := fixture(t)
	product, err := store.Create(ctx, token, input("Agua acidulada", volumeFields(t)...))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if product.ID < 1 || product.Name != "Agua acidulada" || len(product.Fields) != 2 {
		t.Fatalf("created record: %+v", product)
	}
	if product.Fields[0].Number == nil || string(*product.Fields[0].Number) != "5" || product.Fields[0].Unit != "L" {
		t.Fatalf("numeric field: %+v", product.Fields[0])
	}
	if product.Fields[1].Text == nil || *product.Fields[1].Text != "importado" || product.Fields[1].Unit != "" {
		t.Fatalf("text field: %+v", product.Fields[1])
	}
	// Persisted shape, read straight from the database.
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries
		WHERE id=$1 AND kind='other' AND name='Agua acidulada'
		AND brand IS NULL AND model IS NULL AND capacity_ah IS NULL`, product.ID); got != 1 {
		t.Fatal("the entry must be an other product with no battery shape")
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_variants
		WHERE catalog_entry_id=$1 AND polarity IS NULL`, product.ID); got != 1 {
		t.Fatal("the product must own exactly one polarity-less variant")
	}
	// The existing fan-out stocks it: one zero balance row per active location.
	active := scalar(t, ctx, p, "SELECT count(*) FROM locations WHERE deleted_at IS NULL")
	got := scalar(t, ctx, p, `SELECT count(*) FROM inventory_balances b
		JOIN catalog_variants v ON v.id=b.variant_id
		WHERE v.catalog_entry_id=$1 AND b.existing=0 AND b.reserved=0`, product.ID)
	if got != active {
		t.Fatalf("zero balances: got %d want %d", got, active)
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entry_fields WHERE catalog_entry_id=$1`, product.ID); got != 2 {
		t.Fatalf("persisted fields: got %d want 2", got)
	}
}

func TestCreateRefusesADuplicateActiveName(t *testing.T) {
	ctx, p, store, token := fixture(t)
	if _, err := store.Create(ctx, token, input("Agua acidulada")); err != nil {
		t.Fatal(err)
	}
	before := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries WHERE kind='other'`)
	if _, err := store.Create(ctx, token, input("AGUA ACIDULADA")); !errors.Is(err, otherproducts.ErrConflict) {
		t.Fatalf("a duplicate name must be a conflict, got %v", err)
	}
	if after := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries WHERE kind='other'`); after != before {
		t.Fatalf("a refused creation must write nothing: %d then %d", before, after)
	}
}

func TestCreateRefusesARepeatedFieldNameAndWritesNothing(t *testing.T) {
	ctx, p, store, token := fixture(t)
	before := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries`)
	_, err := store.Create(ctx, token, input("Destilada",
		otherproducts.Field{Name: "origen", Kind: otherproducts.KindText, Text: text("a")},
		otherproducts.Field{Name: "ORIGEN", Kind: otherproducts.KindText, Text: text("b")}))
	if !errors.Is(err, otherproducts.ErrInvalid) {
		t.Fatalf("a repeated field name must be an invalid request, got %v", err)
	}
	if after := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries`); after != before {
		t.Fatalf("a refused field set must write nothing: %d then %d", before, after)
	}
}

func TestEditReplacesTheWholeFieldSet(t *testing.T) {
	ctx, p, store, token := fixture(t)
	product, err := store.Create(ctx, token, input("Agua acidulada", volumeFields(t)...))
	if err != nil {
		t.Fatal(err)
	}
	edited, err := store.Edit(ctx, token, product.ID, otherproducts.EditInput{
		Name: "Agua destilada",
		Fields: []otherproducts.Field{
			{Name: "volumen en L", Kind: otherproducts.KindNumber, Unit: "L", Number: number(t, "12.5")},
		},
	})
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	if edited.Name != "Agua destilada" || len(edited.Fields) != 1 ||
		string(*edited.Fields[0].Number) != "12.5" {
		t.Fatalf("edited record: %+v", edited)
	}
	// The replaced field is gone, not merged: the old text field no longer exists.
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entry_fields
		WHERE catalog_entry_id=$1 AND name='origen'`, product.ID); got != 0 {
		t.Fatal("an edit must replace the field set instead of merging it")
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries
		WHERE id=$1 AND name='Agua destilada'`, product.ID); got != 1 {
		t.Fatal("the rename must persist")
	}
}

func TestEditRefusesAnUnknownOrBatteryIdentity(t *testing.T) {
	ctx, p, store, token := fixture(t)
	// A battery already lives in the seeded catalogue, so its identity is the real
	// evidence: it is not an other product and it never becomes one.
	var battery int64
	if err := p.QueryRow(ctx, `SELECT id FROM catalog_entries
		WHERE kind='battery' AND deleted_at IS NULL AND brand='TOYO' AND model='NS40ZL'`).
		Scan(&battery); err != nil {
		t.Fatal("the seeded battery is missing from the fixture")
	}
	edit := otherproducts.EditInput{Name: "No existe"}
	if _, err := store.Edit(ctx, token, battery, edit); !errors.Is(err, otherproducts.ErrNotFound) {
		t.Fatalf("a battery is not an other product, got %v", err)
	}
	if _, err := store.Edit(ctx, token, 999999, edit); !errors.Is(err, otherproducts.ErrNotFound) {
		t.Fatalf("an unknown identity is not found, got %v", err)
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries
		WHERE id=$1 AND brand='TOYO' AND kind='battery'`, battery); got != 1 {
		t.Fatal("a refused edit must leave the battery untouched")
	}
}

func TestRetireIsBlockedByStockAndFreesTheName(t *testing.T) {
	ctx, p, store, token := fixture(t)
	product, err := store.Create(ctx, token, input("Agua acidulada", volumeFields(t)...))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=3
		WHERE variant_id IN (SELECT id FROM catalog_variants WHERE catalog_entry_id=$1)`, product.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Retire(ctx, token, product.ID); !errors.Is(err, otherproducts.ErrHasStock) {
		t.Fatalf("stock must block the retirement, got %v", err)
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries
		WHERE id=$1 AND deleted_at IS NULL`, product.ID); got != 1 {
		t.Fatal("a refused retirement must leave the product active")
	}
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=0
		WHERE variant_id IN (SELECT id FROM catalog_variants WHERE catalog_entry_id=$1)`, product.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Retire(ctx, token, product.ID); err != nil {
		t.Fatalf("a clean retirement must succeed: %v", err)
	}
	// A repeat is the same successful answer, matching the battery catalog.
	if err := store.Retire(ctx, token, product.ID); err != nil {
		t.Fatalf("a repeated retirement must be a no-op: %v", err)
	}
	if _, err := store.Edit(ctx, token, product.ID, otherproducts.EditInput{Name: "Otra cosa"}); !errors.Is(err, otherproducts.ErrNotFound) {
		t.Fatalf("a retired product has left the editable catalog, got %v", err)
	}
	// Its fields are frozen, not deleted; its name is free again.
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entry_fields
		WHERE catalog_entry_id=$1 AND name IN ('volumen en L','origen')`, product.ID); got != 2 {
		t.Fatalf("retirement must freeze the field set instead of deleting it: got %d", got)
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entry_fields f
		WHERE f.catalog_entry_id=$1 AND f.kind='number' AND f.unit='L' AND f.number_value=5
		AND f.text_value IS NULL`, product.ID); got != 1 {
		t.Fatalf("the retired numeric field must keep its value and unit: got %d", got)
	}
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entry_fields f
		WHERE f.catalog_entry_id=$1 AND f.kind='text' AND f.text_value='importado'
		AND f.unit IS NULL AND f.number_value IS NULL`, product.ID); got != 1 {
		t.Fatalf("the retired text field must keep its value: got %d", got)
	}
	if _, err := store.Create(ctx, token, input("agua acidulada")); err != nil {
		t.Fatalf("a retired product frees its name: %v", err)
	}
}

func TestListReturnsOnlyActiveProductsWithTheirFields(t *testing.T) {
	ctx, p, store, token := fixture(t)
	first, err := store.Create(ctx, token, input("Agua acidulada", volumeFields(t)...))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(ctx, token, input("Aguarrás")); err != nil {
		t.Fatal(err)
	}
	page, err := store.List(ctx, token, otherproducts.Query{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if page.Total != 2 || len(page.Products) != 2 || page.Page != 1 || page.PageSize != 10 {
		t.Fatalf("page: total %d len %d", page.Total, len(page.Products))
	}
	if page.Products[0].ID != first.ID || len(page.Products[0].Fields) != 2 || len(page.Products[1].Fields) != 0 {
		t.Fatalf("products and fields: %+v", page.Products)
	}
	// The batteries of the seeded catalogue are never listed here.
	if got := scalar(t, ctx, p, `SELECT count(*) FROM catalog_entries WHERE kind='battery'`); got != 95 {
		t.Fatalf("the fixture batteries are untouched: got %d", got)
	}
	found, err := store.List(ctx, token, otherproducts.Query{Page: 1, PageSize: 10, Search: "AGUARR"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if found.Total != 1 || len(found.Products) != 1 || found.Products[0].Name != "Aguarrás" {
		t.Fatalf("search page: %+v", found.Products)
	}
	// A retired product leaves the listing.
	if err := store.Retire(ctx, token, first.ID); err != nil {
		t.Fatal(err)
	}
	after, err := store.List(ctx, token, otherproducts.Query{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatal(err)
	}
	if after.Total != 1 || after.Products[0].Name != "Aguarrás" {
		t.Fatalf("retired product still listed: %+v", after.Products)
	}
}

func TestTheGateStillAppliesInsideTheStore(t *testing.T) {
	ctx, _, store, _ := fixture(t)
	if _, err := store.Create(ctx, "", input("Agua acidulada")); err == nil {
		t.Fatal("an empty token must not write")
	}
	if _, err := store.List(ctx, "", otherproducts.Query{Page: 1, PageSize: 10}); err == nil {
		t.Fatal("an empty token must not read")
	}
}
