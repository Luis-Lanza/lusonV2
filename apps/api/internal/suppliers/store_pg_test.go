package suppliers_test

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
	"luson/api/internal/suppliers"
	"luson/api/internal/testpg"
)

// storeFixture provisions the isolated database the way every database-backed
// suite here does, and returns the two identities this domain distinguishes: the
// warehouse administrator and a branch administrator with the same password state.
// Without an admitted LUSON_TEST_PG_MANIFEST the test fails closed at testpg.Open.
func storeFixture(t *testing.T) (context.Context, *pgxpool.Pool, *suppliers.Store, auth.Identity, auth.Identity) {
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
	service, err := auth.New(p, func() time.Time { return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal("service initialization failed")
	}
	identities := make([]auth.Identity, 2)
	for i := range identities {
		session, _, err := service.Login(ctx, credentials[i].Username, credentials[i].Password, "127.0.0.1", "")
		if err != nil {
			t.Fatal("warehouse login failed")
		}
		identities[i] = session.Identity
	}
	if identities[0].AccountID != 1 || identities[0].Location.ID != 1 || identities[1].AccountID != 2 {
		t.Fatal("fixture authority assignment changed")
	}
	return ctx, p, suppliers.New(p), identities[0], identities[1]
}

// batteryEntry writes one battery catalogue entry with its two polarities, exactly
// the shape a supplier offers: the assignment is entry level and the ingress keeps
// naming variants.
func batteryEntry(t *testing.T, ctx context.Context, p *pgxpool.Pool, model string) (int64, []int64) {
	t.Helper()
	var entry int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,brand,model,capacity_ah)
 VALUES('battery','CAR',$1,35) RETURNING id`, model).Scan(&entry); err != nil {
		t.Fatal("battery entry fixture failed")
	}
	variants := make([]int64, 0, 2)
	for _, polarity := range []string{"L", "R"} {
		var variant int64
		if err := p.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id,polarity)
 VALUES($1,$2) RETURNING id`, entry, polarity).Scan(&variant); err != nil {
			t.Fatal("battery variant fixture failed")
		}
		variants = append(variants, variant)
	}
	return entry, variants
}

// productEntry writes one other-product catalogue entry with its single
// polarity-less variant.
func productEntry(t *testing.T, ctx context.Context, p *pgxpool.Pool, name string) (int64, int64) {
	t.Helper()
	var entry int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id`, name).Scan(&entry); err != nil {
		t.Fatal("product entry fixture failed")
	}
	var variant int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`, entry).Scan(&variant); err != nil {
		t.Fatal("product variant fixture failed")
	}
	return entry, variant
}

// retireEntry retires one catalogue entry the way the catalog administrator does,
// without deleting it.
func retireEntry(t *testing.T, ctx context.Context, p *pgxpool.Pool, entry int64) {
	t.Helper()
	tag, err := p.Exec(ctx, `UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1 AND deleted_at IS NULL`, entry)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatal("catalogue entry retirement fixture failed")
	}
}

func scalar(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if p.QueryRow(ctx, query, args...).Scan(&n) != nil {
		t.Fatal("scalar query failed")
	}
	return n
}

// The whole authority of this domain is the warehouse administrator: a branch
// account, an unassigned warehouse account and a pending password change are all
// refused before any statement.
func TestStoreRefusesEveryOtherIdentity(t *testing.T) {
	ctx, p, store, warehouse, branch := storeFixture(t)
	entry, _ := batteryEntry(t, ctx, p, "NS40ZL-AUTH")
	pending := warehouse
	pending.MustChangePassword = true
	for _, actor := range []auth.Identity{branch, pending, {}} {
		if _, err := store.List(ctx, actor, 1, 10); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v listed suppliers", actor)
		}
		if _, err := store.Create(ctx, actor, suppliers.CreateInput{Name: "Distribuidora"}); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v created a supplier", actor)
		}
		if _, err := store.Edit(ctx, actor, 1, suppliers.EditInput{Name: "Distribuidora"}); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v edited a supplier", actor)
		}
		if err := store.Retire(ctx, actor, 1); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v retired a supplier", actor)
		}
		if _, err := store.Read(ctx, actor, 1); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v read a supplier", actor)
		}
		if _, err := store.ReplaceOffers(ctx, actor, 1, []int64{entry}); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v assigned offers", actor)
		}
		if _, err := store.Catalog(ctx, actor, suppliers.EntryQuery{PageSize: 10}); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v read the assignable catalogue", actor)
		}
		if _, err := store.OfferedVariants(ctx, actor, 1, suppliers.VariantQuery{}); !errors.Is(err, suppliers.ErrForbidden) {
			t.Fatalf("identity %+v read the offered variants", actor)
		}
	}
	if err := store.Authorize(ctx, pending); !errors.Is(err, suppliers.ErrForbidden) {
		t.Fatal("a pending password change was authorized")
	}
	if err := store.Authorize(ctx, warehouse); err != nil {
		t.Fatalf("the warehouse administrator was refused: %v", err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM suppliers"); got != 0 {
		t.Fatalf("a refused identity wrote %d suppliers", got)
	}
}

// A supplier is created, edited, retired and read back. The name is trimmed and
// bounded, the contact is free text, and the retirement is one way: the retired row
// stays readable and can never be edited or retired twice.
func TestStoreSupplierLifecycle(t *testing.T) {
	ctx, p, store, warehouse, _ := storeFixture(t)
	created, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "  Distribuidora Norte  ", Contact: "555-1234"})
	if err != nil || created.ID < 1 || created.Name != "Distribuidora Norte" || created.Contact != "555-1234" {
		t.Fatalf("create = %+v, %v", created, err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM suppliers WHERE id=$1 AND name='Distribuidora Norte' AND contact='555-1234' AND deleted_at IS NULL", created.ID); got != 1 {
		t.Fatal("the trimmed name and the contact were not persisted")
	}
	if _, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "distribuidora norte"}); !errors.Is(err, suppliers.ErrConflict) {
		t.Fatalf("a duplicate active name was admitted: %v", err)
	}
	if _, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "ab"}); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("a short name was admitted: %v", err)
	}
	if _, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "Distribuidora Sur", Contact: "555\t1234"}); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("a control-bearing contact was admitted: %v", err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM suppliers"); got != 1 {
		t.Fatalf("a refused creation wrote %d suppliers", got)
	}

	edited, err := store.Edit(ctx, warehouse, created.ID, suppliers.EditInput{Name: "Distribuidora Norte SA", Contact: ""})
	if err != nil || edited.Name != "Distribuidora Norte SA" || edited.Contact != "" {
		t.Fatalf("edit = %+v, %v", edited, err)
	}
	other, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "Distribuidora Sur"})
	if err != nil {
		t.Fatalf("second create: %v", err)
	}
	if _, err := store.Edit(ctx, warehouse, created.ID, suppliers.EditInput{Name: "DISTRIBUIDORA SUR"}); !errors.Is(err, suppliers.ErrConflict) {
		t.Fatalf("a rename onto an active name was admitted: %v", err)
	}
	if _, err := store.Edit(ctx, warehouse, other.ID+1000, suppliers.EditInput{Name: "Distribuidora Este"}); !errors.Is(err, suppliers.ErrNotFound) {
		t.Fatalf("an unknown supplier was edited: %v", err)
	}

	detail, err := store.Read(ctx, warehouse, created.ID)
	if err != nil || detail.ID != created.ID || detail.Retired || detail.Name != "Distribuidora Norte SA" ||
		detail.Offers == nil || len(detail.Offers) != 0 || detail.Kinds == nil || len(detail.Kinds) != 0 {
		t.Fatalf("read = %+v, %v", detail, err)
	}
	if _, err := store.Read(ctx, warehouse, other.ID+1000); !errors.Is(err, suppliers.ErrNotFound) {
		t.Fatalf("an unknown supplier was read: %v", err)
	}

	if err := store.Retire(ctx, warehouse, created.ID); err != nil {
		t.Fatalf("retire: %v", err)
	}
	assertRetired := func(want bool) {
		t.Helper()
		detail, err := store.Read(ctx, warehouse, created.ID)
		if err != nil || detail.Retired != want {
			t.Fatalf("retired read = %+v, %v", detail, err)
		}
	}
	assertRetired(true)
	if err := store.Retire(ctx, warehouse, created.ID); !errors.Is(err, suppliers.ErrConflict) {
		t.Fatalf("a second retirement was admitted: %v", err)
	}
	if err := store.Retire(ctx, warehouse, other.ID+1000); !errors.Is(err, suppliers.ErrNotFound) {
		t.Fatalf("an unknown supplier was retired: %v", err)
	}
	if _, err := store.Edit(ctx, warehouse, created.ID, suppliers.EditInput{Name: "Distribuidora Norte SRL"}); !errors.Is(err, suppliers.ErrNotFound) {
		t.Fatalf("a retired supplier was edited: %v", err)
	}
	assertRetired(true)
	// The retired name is free again, and the retired row keeps its own history.
	reused, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "Distribuidora Norte SA"})
	if err != nil || reused.ID == created.ID {
		t.Fatalf("a retired name must be reusable: %+v, %v", reused, err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM suppliers"); got != 3 {
		t.Fatalf("suppliers after reuse: %d", got)
	}
}

// The list is paged with the active suppliers first by name and the retired ones
// last, each row carrying its derived kinds and its exact offer count.
func TestStoreListOrderingAndDerivedKinds(t *testing.T) {
	ctx, p, store, warehouse, _ := storeFixture(t)
	battery, _ := batteryEntry(t, ctx, p, "NS40ZL-LIST")
	product, _ := productEntry(t, ctx, p, "Agua acidulada")

	bravo, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "Bravo"})
	if err != nil {
		t.Fatalf("create bravo: %v", err)
	}
	alfa, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "alfa"})
	if err != nil {
		t.Fatalf("create alfa: %v", err)
	}
	if _, err := store.ReplaceOffers(ctx, warehouse, bravo.ID, []int64{battery, product}); err != nil {
		t.Fatalf("assign offers: %v", err)
	}
	if err := store.Retire(ctx, warehouse, alfa.ID); err != nil {
		t.Fatalf("retire alfa: %v", err)
	}
	page, err := store.List(ctx, warehouse, 1, 10)
	if err != nil || page.Page != 1 || page.PageSize != 10 || page.Total != 2 || len(page.Suppliers) != 2 {
		t.Fatalf("list = %+v, %v", page, err)
	}
	first, second := page.Suppliers[0], page.Suppliers[1]
	if first.ID != bravo.ID || first.Retired || first.Name != "Bravo" || first.Offers != 2 ||
		len(first.Kinds) != 2 || first.Kinds[0] != catalog.BatteryKind || first.Kinds[1] != catalog.OtherKind {
		t.Fatalf("first row = %+v", first)
	}
	if second.ID != alfa.ID || !second.Retired || second.Name != "alfa" || second.Offers != 0 ||
		second.Kinds == nil || len(second.Kinds) != 0 {
		t.Fatalf("second row = %+v", second)
	}
	empty, err := store.List(ctx, warehouse, 2, 10)
	if err != nil || empty.Suppliers == nil || len(empty.Suppliers) != 0 || empty.Total != 2 {
		t.Fatalf("a page beyond the last one must be empty: %+v, %v", empty, err)
	}
	if _, err := store.List(ctx, warehouse, 0, 10); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("a zero page was admitted: %v", err)
	}
	if _, err := store.List(ctx, warehouse, 1, 15); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("an inadmissible page size was admitted: %v", err)
	}
}

// The offer list is state, not history: an assignment replaces the whole set in one
// transaction, and the database's own trigger is the authority for the two
// retirement rules.
func TestStoreReplaceOffers(t *testing.T) {
	ctx, p, store, warehouse, _ := storeFixture(t)
	battery, _ := batteryEntry(t, ctx, p, "NS40ZL-OFFERS")
	product, _ := productEntry(t, ctx, p, "Agua acidulada")
	retiredEntry, _ := productEntry(t, ctx, p, "Agua retirada")
	retireEntry(t, ctx, p, retiredEntry)

	supplier, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "Distribuidora"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	detail, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, []int64{product, battery, product})
	if err != nil || len(detail.Offers) != 2 || detail.Offers[0].CatalogEntryID != battery ||
		detail.Offers[1].CatalogEntryID != product {
		t.Fatalf("assign = %+v, %v", detail, err)
	}
	if detail.Offers[0].Kind != catalog.BatteryKind || detail.Offers[0].Brand != "CAR" ||
		detail.Offers[0].Model != "NS40ZL-OFFERS" || detail.Offers[0].Capacity != "35" ||
		detail.Offers[0].Name != "" {
		t.Fatalf("battery offer = %+v", detail.Offers[0])
	}
	if detail.Offers[1].Kind != catalog.OtherKind || detail.Offers[1].Name != "Agua acidulada" ||
		detail.Offers[1].Brand != "" || detail.Offers[1].Capacity != "" {
		t.Fatalf("product offer = %+v", detail.Offers[1])
	}
	if len(detail.Kinds) != 2 || detail.Kinds[0] != catalog.BatteryKind || detail.Kinds[1] != catalog.OtherKind {
		t.Fatalf("kinds = %v", detail.Kinds)
	}

	// The replacement is the whole set: the previous rows are gone, not merged.
	replaced, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, []int64{product})
	if err != nil || len(replaced.Offers) != 1 || replaced.Offers[0].CatalogEntryID != product ||
		len(replaced.Kinds) != 1 || replaced.Kinds[0] != catalog.OtherKind {
		t.Fatalf("replace = %+v, %v", replaced, err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM supplier_offers WHERE supplier_id=$1", supplier.ID); got != 1 {
		t.Fatalf("offer rows after replacement: %d", got)
	}

	// A refused assignment leaves the persisted set exactly as it was.
	for _, c := range []struct {
		name string
		ids  []int64
		want error
	}{
		{"unknown_entry", []int64{1 << 30}, suppliers.ErrInvalid},
		{"retired_entry", []int64{retiredEntry}, suppliers.ErrInvalid},
		{"zero_entry", []int64{0}, suppliers.ErrInvalid},
	} {
		if _, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, c.ids); !errors.Is(err, c.want) {
			t.Fatalf("%s answered %v, want %v", c.name, err, c.want)
		}
		if got := scalar(t, ctx, p, "SELECT count(*) FROM supplier_offers WHERE supplier_id=$1 AND catalog_entry_id=$2", supplier.ID, product); got != 1 {
			t.Fatalf("%s changed the persisted offer set", c.name)
		}
	}
	if _, err := store.ReplaceOffers(ctx, warehouse, supplier.ID+1000, []int64{battery}); !errors.Is(err, suppliers.ErrNotFound) {
		t.Fatalf("an unknown supplier gained offers: %v", err)
	}

	// An empty list is the final state of a supplier that offers nothing.
	cleared, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, nil)
	if err != nil || cleared.Offers == nil || len(cleared.Offers) != 0 || len(cleared.Kinds) != 0 {
		t.Fatalf("clear = %+v, %v", cleared, err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM supplier_offers WHERE supplier_id=$1", supplier.ID); got != 0 {
		t.Fatalf("offer rows after clearing: %d", got)
	}

	// A retired supplier can never gain offers again; its frozen set stays readable.
	if _, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, []int64{battery}); err != nil {
		t.Fatalf("assign before retirement: %v", err)
	}
	if err := store.Retire(ctx, warehouse, supplier.ID); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, []int64{product}); !errors.Is(err, suppliers.ErrConflict) {
		t.Fatalf("a retired supplier gained offers: %v", err)
	}
	if got := scalar(t, ctx, p, "SELECT count(*) FROM supplier_offers WHERE supplier_id=$1 AND catalog_entry_id=$2", supplier.ID, battery); got != 1 {
		t.Fatal("a refused assignment changed the frozen set of a retired supplier")
	}
	// Nothing is ever deleted, and the database refuses a physical deletion.
	if got := scalar(t, ctx, p, "SELECT count(*) FROM suppliers WHERE id=$1", supplier.ID); got != 1 {
		t.Fatal("the supplier row disappeared")
	}
}

// The assignable catalogue read is entry level: both kinds, only active entries,
// an optional kind and an optional literal search over brand, model and name.
func TestStoreCatalogEntries(t *testing.T) {
	ctx, p, store, warehouse, _ := storeFixture(t)
	battery, _ := batteryEntry(t, ctx, p, "NS40ZL-CATALOG")
	product, _ := productEntry(t, ctx, p, "Agua acidulada")
	retired, _ := productEntry(t, ctx, p, "Agua retirada")
	retireEntry(t, ctx, p, retired)

	page, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{PageSize: 50})
	if err != nil || page.PageSize != 50 || len(page.Entries) != 50 {
		t.Fatalf("catalog page = %d rows, %v", len(page.Entries), err)
	}
	// The seeded catalogue is part of the total and the retired entry is not: the
	// count and the page answer the same question.
	if page.Total != 97 {
		t.Fatalf("total = %d", page.Total)
	}
	for i := 1; i < len(page.Entries); i++ {
		if page.Entries[i].CatalogEntryID <= page.Entries[i-1].CatalogEntryID {
			t.Fatalf("catalog rows are not in ascending entry order: %+v", page.Entries)
		}
	}
	batteries, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{Kind: catalog.BatteryKind, PageSize: 10})
	if err != nil || len(batteries.Entries) != 10 {
		t.Fatalf("battery page = %+v, %v", batteries, err)
	}
	for _, entry := range batteries.Entries {
		if entry.Kind != catalog.BatteryKind || entry.Brand == "" || entry.Model == "" || entry.Capacity == "" || entry.Name != "" {
			t.Fatalf("battery entry = %+v", entry)
		}
	}
	products, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{Kind: catalog.OtherKind, PageSize: 10})
	if err != nil || len(products.Entries) != 1 || products.Total != 1 || products.Entries[0].CatalogEntryID != product {
		t.Fatalf("product page = %+v, %v", products, err)
	}
	searched, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{Search: "acidulada", PageSize: 10})
	if err != nil || len(searched.Entries) != 1 || searched.Entries[0].CatalogEntryID != product {
		t.Fatalf("name search = %+v, %v", searched, err)
	}
	if searched, err = store.Catalog(ctx, warehouse, suppliers.EntryQuery{Search: "NS40ZL-CATALOG", PageSize: 10}); err != nil ||
		len(searched.Entries) != 1 || searched.Entries[0].CatalogEntryID != battery {
		t.Fatalf("model search = %+v, %v", searched, err)
	}
	// A literal search never widens into a pattern.
	if wild, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{Search: "%", PageSize: 10}); err != nil || len(wild.Entries) != 0 {
		t.Fatalf("a percent search widened the catalogue: %+v, %v", wild, err)
	}
	if _, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{Kind: "all", PageSize: 10}); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("an unknown kind was admitted: %v", err)
	}
	if _, err := store.Catalog(ctx, warehouse, suppliers.EntryQuery{PageSize: 15}); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("an inadmissible page size was admitted: %v", err)
	}
}

// The ingress picker read publishes the VARIANTS of the entries a supplier offers,
// with the typed identity every warehouse screen already uses: a battery expands to
// all its polarities and a product keeps its typed fields. No stock number appears.
func TestStoreOfferedVariants(t *testing.T) {
	ctx, p, store, warehouse, _ := storeFixture(t)
	battery, batteryVariants := batteryEntry(t, ctx, p, "NS40ZL-VARIANTS")
	product, productVariant := productEntry(t, ctx, p, "Agua acidulada")
	unoffered, _ := batteryEntry(t, ctx, p, "NS40ZL-UNOFFERED")

	supplier, err := store.Create(ctx, warehouse, suppliers.CreateInput{Name: "Distribuidora"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := store.ReplaceOffers(ctx, warehouse, supplier.ID, []int64{battery, product}); err != nil {
		t.Fatalf("assign: %v", err)
	}
	page, err := store.OfferedVariants(ctx, warehouse, supplier.ID, suppliers.VariantQuery{})
	if err != nil || page.PageSize != suppliers.OfferedVariantsPageSize || len(page.Items) != 3 {
		t.Fatalf("variants = %+v, %v", page, err)
	}
	for i, want := range batteryVariants {
		item := page.Items[i]
		polarity := []string{"L", "R"}[i]
		if int64(item.VariantID) != want || item.CatalogEntryID != battery || item.Kind != catalog.BatteryKind || item.Battery == nil {
			t.Fatalf("battery variant %d = %+v", i, item)
		}
		if item.Identity.Valid() != nil || item.Name != catalog.BatteryName("CAR", "NS40ZL-VARIANTS") ||
			item.Detail != catalog.BatteryDetail("35", polarity) || item.Battery.Polarity != polarity ||
			item.Battery.Capacity != "35" {
			t.Fatalf("battery identity %d = %+v", i, item)
		}
		if item.Fields != nil {
			t.Fatalf("a battery identity carries no typed field: %+v", item)
		}
	}
	last := page.Items[2]
	if int64(last.VariantID) != productVariant || last.CatalogEntryID != product || last.Kind != catalog.OtherKind ||
		last.Battery != nil || last.Identity.Valid() != nil || last.Name != "Agua acidulada" {
		t.Fatalf("product variant = %+v", last)
	}
	if last.Fields == nil || len(last.Fields) != 0 {
		t.Fatalf("a product identity carries its typed field list: %+v", last.Fields)
	}
	for _, item := range page.Items {
		if item.CatalogEntryID == unoffered {
			t.Fatal("a variant of an unoffered entry was published")
		}
	}

	batteries, err := store.OfferedVariants(ctx, warehouse, supplier.ID, suppliers.VariantQuery{Kind: catalog.BatteryKind})
	if err != nil || len(batteries.Items) != 2 {
		t.Fatalf("battery filter = %+v, %v", batteries, err)
	}
	products, err := store.OfferedVariants(ctx, warehouse, supplier.ID, suppliers.VariantQuery{Kind: catalog.OtherKind})
	if err != nil || len(products.Items) != 1 || int64(products.Items[0].VariantID) != productVariant {
		t.Fatalf("product filter = %+v, %v", products, err)
	}
	searched, err := store.OfferedVariants(ctx, warehouse, supplier.ID, suppliers.VariantQuery{Search: "acidulada"})
	if err != nil || len(searched.Items) != 1 || searched.Items[0].CatalogEntryID != product {
		t.Fatalf("search = %+v, %v", searched, err)
	}

	if _, err := store.OfferedVariants(ctx, warehouse, supplier.ID+1000, suppliers.VariantQuery{}); !errors.Is(err, suppliers.ErrNotFound) {
		t.Fatalf("an unknown supplier published variants: %v", err)
	}
	if _, err := store.OfferedVariants(ctx, warehouse, supplier.ID, suppliers.VariantQuery{Kind: "all"}); !errors.Is(err, suppliers.ErrInvalid) {
		t.Fatalf("an unknown kind was admitted: %v", err)
	}
	if err := store.Retire(ctx, warehouse, supplier.ID); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, err := store.OfferedVariants(ctx, warehouse, supplier.ID, suppliers.VariantQuery{}); !errors.Is(err, suppliers.ErrConflict) {
		t.Fatalf("a retired supplier filled the ingress picker: %v", err)
	}
}
