package purchases_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
	"luson/api/internal/testpg"
)

// purchaseFixture is one isolated installation: the seeded catalogue, the three
// provisioned accounts and the store of this domain. The three identities are the ones
// bootstrap.Provision creates: the warehouse (account 1, location 1) and one account
// per branch.
type purchaseFixture struct {
	ctx       context.Context
	p         *pgxpool.Pool
	store     *purchases.Store
	branch    auth.Identity
	other     auth.Identity
	warehouse auth.Identity
}

func newPurchaseFixture(t *testing.T) *purchaseFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("the purchase fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20],
			Password: testpg.Random(t)}
	}
	if err := bootstrap.Provision(ctx, p, credentials); err != nil {
		t.Fatal("the purchase fixture provisioning failed")
	}
	return &purchaseFixture{
		ctx:   ctx,
		p:     p,
		store: purchases.New(p),
		// Provision assigns account i+1 to location i+1.
		branch:    auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}},
		other:     auth.Identity{AccountID: 3, Location: auth.Location{ID: 3}},
		warehouse: auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
	}
}

// document is one admitted purchase: a used battery at a typed price and a weight of
// copper at a typed price per kilogram, paid in cash. Its total is the contract's own
// example, 25000.00 + 12.400 * 8000.00 = 124200.00.
func document(key string) purchases.CreateInput {
	return purchases.CreateInput{
		OperationKey: key,
		UsedLines:    []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 1, UnitPrice: "25000.00"}},
		ScrapLines:   []purchases.ScrapLineInput{{MaterialID: 1, Kg: "12.4", PricePerKg: "8000.00"}},
		PaidCash:     "124200.00",
		PaidTransfer: "0.00",
	}
}

// countDocuments reads the persisted documents of one branch, so a replay is proven not
// to write a second one.
func (f *purchaseFixture) countDocuments(t *testing.T, location int) int64 {
	t.Helper()
	var count int64
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchases WHERE location_id=$1", int16(location)).Scan(&count); err != nil {
		t.Fatalf("the document count could not be read: %v", err)
	}
	return count
}

// TestStoreCreateDocument proves one persisted document: the branch and the account come
// from the session, the amounts are derived, and the lines are ordered by model code and
// by material id.
func TestStoreCreateDocument(t *testing.T) {
	f := newPurchaseFixture(t)
	input := document("store-document-01")
	// The caller's order is not the document's order: the canonical document is
	// ordered by model code and by material id.
	input.UsedLines = append(input.UsedLines, purchases.UsedLineInput{Model: "55B24L",
		Quantity: 2, UnitPrice: "10000.00"})
	input.ScrapLines = append(input.ScrapLines, purchases.ScrapLineInput{MaterialID: 2,
		Kg: "0.5", PricePerKg: "4000.00"})
	input.PaidCash, input.PaidTransfer = "66000.00", "80200.00"
	created, err := f.store.Create(f.ctx, f.branch, input)
	if err != nil {
		t.Fatalf("a complete purchase must be admitted: %v", err)
	}
	if created.ID < 1 || created.LocationID != 2 || created.CreatedByAccountID != 2 ||
		created.CreatedAt.IsZero() || created.ReversesPurchaseID != nil ||
		created.ReversedBy != nil || created.Reason != "" {
		t.Fatalf("the persisted header is wrong: %+v", created)
	}
	// 25000.00 + 2 * 10000.00 + 12.400 * 8000.00 + 0.500 * 4000.00 = 146200.00
	if created.Total != "146200.00" || created.PaidCash != "66000.00" || created.PaidTransfer != "80200.00" {
		t.Fatalf("a document must add up: %+v", created)
	}
	if len(created.UsedLines) != 2 || created.UsedLines[0].Model != "55B24L" ||
		created.UsedLines[1].Model != "NS60ZL" {
		t.Fatalf("the used lines are not ordered by model: %+v", created.UsedLines)
	}
	if created.UsedLines[0].Amount != "20000.00" || created.UsedLines[1].Amount != "25000.00" {
		t.Fatalf("the used amounts are not exact: %+v", created.UsedLines)
	}
	if len(created.ScrapLines) != 2 || created.ScrapLines[0].MaterialID != 1 ||
		created.ScrapLines[1].MaterialID != 2 {
		t.Fatalf("the scrap lines are not ordered by material: %+v", created.ScrapLines)
	}
	if created.ScrapLines[0].Name != "Cobre" || created.ScrapLines[0].Kg != "12.400" ||
		created.ScrapLines[0].Amount != "99200.00" || created.ScrapLines[1].Kg != "0.500" ||
		created.ScrapLines[1].Amount != "2000.00" {
		t.Fatalf("the scrap lines are not what the contract publishes: %+v", created.ScrapLines)
	}
	// The detail read answers the same document, and it is not a summary.
	detail, err := f.store.Detail(f.ctx, f.branch, created.ID)
	if err != nil {
		t.Fatalf("the persisted document must be readable: %v", err)
	}
	if detail.Total != created.Total || len(detail.UsedLines) != 2 || len(detail.ScrapLines) != 2 ||
		detail.Note != "" || detail.Reason != "" {
		t.Fatalf("the detail disagrees with the created document: %+v", detail)
	}
}

// TestStoreCommaModelCode proves the catalogue's own comma models end to end: the
// validation canonicalizes them and the database constraint persists them. A character
// still outside the widened set is refused before any document is written.
func TestStoreCommaModelCode(t *testing.T) {
	f := newPurchaseFixture(t)
	created, err := f.store.Create(f.ctx, f.branch, purchases.CreateInput{
		OperationKey: "store-comma-model-01",
		UsedLines: []purchases.UsedLineInput{
			{Model: "12n6,5_3b", Quantity: 1, UnitPrice: "25000.00"},
			{Model: " YB6,5_BS ", Quantity: 2, UnitPrice: "12500.00"},
		},
		PaidCash:     "50000.00",
		PaidTransfer: "0.00",
	})
	if err != nil {
		t.Fatalf("the catalogue's comma models must be admitted: %v", err)
	}
	if len(created.UsedLines) != 2 || created.UsedLines[0].Model != "12N6,5_3B" ||
		created.UsedLines[1].Model != "YB6,5_BS" || created.Total != "50000.00" {
		t.Fatalf("the comma models are not canonical: %+v", created)
	}
	var persisted string
	if err := f.p.QueryRow(f.ctx, `SELECT string_agg(model, ',' ORDER BY model)
 FROM purchase_used_lines WHERE purchase_id=$1`, created.ID).Scan(&persisted); err != nil ||
		persisted != "12N6,5_3B,YB6,5_BS" {
		t.Fatalf("the comma models were not persisted: %q %v", persisted, err)
	}
	// A character outside the set is still refused, and the refusal writes nothing.
	_, err = f.store.Create(f.ctx, f.branch, purchases.CreateInput{
		OperationKey: "store-comma-model-02",
		UsedLines:    []purchases.UsedLineInput{{Model: "NS60ZL!", Quantity: 1, UnitPrice: "25000.00"}},
		PaidCash:     "25000.00",
		PaidTransfer: "0.00",
	})
	if !errors.Is(err, purchases.ErrInvalid) {
		t.Fatalf("a model outside the set must be invalid, got %v", err)
	}
	if f.countDocuments(t, 2) != 1 {
		t.Fatal("a refused model wrote a document")
	}
}

// TestStoreCreateReplayAndConflict proves the idempotency of one operation key: the same
// payload answers the persisted document and never a second one, and a different payload
// under the same key is a conflict.
func TestStoreCreateReplayAndConflict(t *testing.T) {
	f := newPurchaseFixture(t)
	first, err := f.store.Create(f.ctx, f.branch, document("store-replay-key-01"))
	if err != nil {
		t.Fatalf("the first document must be admitted: %v", err)
	}
	replay, err := f.store.Create(f.ctx, f.branch, document("store-replay-key-01"))
	if err != nil {
		t.Fatalf("an identical replay must answer the document: %v", err)
	}
	if replay.ID != first.ID || replay.Total != first.Total || f.countDocuments(t, 2) != 1 {
		t.Fatalf("a replay must never write a second document: %+v %+v", first, replay)
	}
	for name, changed := range map[string]func(*purchases.CreateInput){
		"note":     func(in *purchases.CreateInput) { in.Note = "otra nota" },
		"quantity": func(in *purchases.CreateInput) { in.UsedLines[0].Quantity = 2; in.PaidCash = "149200.00" },
		"weight":   func(in *purchases.CreateInput) { in.ScrapLines[0].Kg = "12.500"; in.PaidCash = "125000.00" },
		"paid":     func(in *purchases.CreateInput) { in.PaidCash, in.PaidTransfer = "124000.00", "200.00" },
	} {
		input := document("store-replay-key-01")
		changed(&input)
		if _, err := f.store.Create(f.ctx, f.branch, input); !errors.Is(err, purchases.ErrRetryConflict) {
			t.Fatalf("a different %s under the same key must conflict, got %v", name, err)
		}
	}
	if f.countDocuments(t, 2) != 1 {
		t.Fatal("a conflicting replay wrote a second document")
	}
	// The same key of another branch belongs to that branch's document, never to this
	// one.
	if _, err := f.store.Create(f.ctx, f.other, document("store-replay-key-01")); !errors.Is(err, purchases.ErrRetryConflict) {
		t.Fatalf("an operation key of another branch must conflict, got %v", err)
	}
}

// TestStoreReverseDocument proves the counter-document: its lines are derived from the
// persisted original, the header negates the amounts, both stay visible, and a second
// counter-document is refused.
func TestStoreReverseDocument(t *testing.T) {
	f := newPurchaseFixture(t)
	original, err := f.store.Create(f.ctx, f.branch, document("store-reverse-01"))
	if err != nil {
		t.Fatalf("the original must be admitted: %v", err)
	}
	counter, err := f.store.Reverse(f.ctx, f.branch, original.ID, "store-reverse-key-02", "  pesaje mal tipeado ")
	if err != nil {
		t.Fatalf("an original purchase must be reversible: %v", err)
	}
	if counter.ID <= original.ID || counter.ReversesPurchaseID == nil ||
		*counter.ReversesPurchaseID != original.ID || counter.Reason != "pesaje mal tipeado" ||
		counter.Note != "" || counter.ReversedBy != nil {
		t.Fatalf("the counter-document header is wrong: %+v", counter)
	}
	// The amounts and the quantities are the exact negation of the original's.
	if counter.Total != "-124200.00" || counter.PaidCash != "-124200.00" ||
		counter.PaidTransfer != "0.00" {
		t.Fatalf("the counter-document amounts are wrong: %+v", counter)
	}
	if len(counter.UsedLines) != 1 || counter.UsedLines[0].Model != "NS60ZL" ||
		counter.UsedLines[0].Quantity != -1 || counter.UsedLines[0].UnitPrice != "25000.00" ||
		counter.UsedLines[0].Amount != "-25000.00" {
		t.Fatalf("the counter used line does not mirror: %+v", counter.UsedLines)
	}
	if len(counter.ScrapLines) != 1 || counter.ScrapLines[0].Kg != "-12.400" ||
		counter.ScrapLines[0].PricePerKg != "8000.00" ||
		counter.ScrapLines[0].Amount != "-99200.00" {
		t.Fatalf("the counter scrap line does not mirror: %+v", counter.ScrapLines)
	}
	// Both documents stay visible forever and point at each other.
	detail, err := f.store.Detail(f.ctx, f.branch, original.ID)
	if err != nil {
		t.Fatalf("the original must stay readable: %v", err)
	}
	if detail.ReversedBy == nil || *detail.ReversedBy != counter.ID {
		t.Fatalf("the original must name its counter-document: %+v", detail)
	}
	if detail.Total != "124200.00" || len(detail.UsedLines) != 1 {
		t.Fatalf("the original must stay as it was persisted: %+v", detail)
	}
	// A replay of the same key, target and reason answers the persisted counter-document.
	replay, err := f.store.Reverse(f.ctx, f.branch, original.ID, "store-reverse-key-02", "pesaje mal tipeado")
	if err != nil || replay.ID != counter.ID {
		t.Fatalf("an identical reversal must replay: %+v %v", replay, err)
	}
	// The same key with another reason is a conflict, never a second counter-document.
	if _, err := f.store.Reverse(f.ctx, f.branch, original.ID, "store-reverse-key-02", "otro motivo"); !errors.Is(err, purchases.ErrRetryConflict) {
		t.Fatalf("another reason under the same key must conflict, got %v", err)
	}
	// One original, one counter-document; and a counter-document is never reversed.
	if _, err := f.store.Reverse(f.ctx, f.branch, original.ID, "store-reverse-key-03", "otra vez"); !errors.Is(err, purchases.ErrAlreadyReversed) {
		t.Fatalf("a reversed purchase must refuse a second counter-document, got %v", err)
	}
	if _, err := f.store.Reverse(f.ctx, f.branch, counter.ID, "store-reverse-key-04", "revertir la reversa"); !errors.Is(err, purchases.ErrAlreadyReversed) {
		t.Fatalf("a counter-document must never be reversed, got %v", err)
	}
	// An unknown target and a foreign one are not found, and the reason is mandatory.
	for name, tc := range map[string]struct {
		target int64
		actor  auth.Identity
		reason string
		key    string
	}{
		"unknown":   {999_999, f.branch, "motivo", "store-reverse-key-05"},
		"zero":      {0, f.branch, "motivo", "store-reverse-key-06"},
		"foreign":   {original.ID, f.other, "motivo", "store-reverse-key-07"},
		"no_reason": {original.ID, f.branch, "   ", "store-reverse-key-08"},
	} {
		_, err := f.store.Reverse(f.ctx, tc.actor, tc.target, tc.key, tc.reason)
		want := purchases.ErrNotFound
		if tc.reason == "   " {
			want = purchases.ErrInvalid
		}
		if !errors.Is(err, want) {
			t.Fatalf("a %s target must be %v, got %v", name, want, err)
		}
	}
}

// TestStoreIsolation proves the branch authority: the warehouse is forbidden everywhere
// and another branch never sees or reverses this branch's documents.
func TestStoreIsolation(t *testing.T) {
	f := newPurchaseFixture(t)
	original, err := f.store.Create(f.ctx, f.branch, document("store-isolation-01"))
	if err != nil {
		t.Fatalf("the document must be admitted: %v", err)
	}
	warehouseCalls := map[string]func() error{
		"create": func() error { _, err := f.store.Create(f.ctx, f.warehouse, document("store-isolation-02")); return err },
		"reverse": func() error {
			_, err := f.store.Reverse(f.ctx, f.warehouse, original.ID, "store-isolation-03", "motivo")
			return err
		},
		"list":      func() error { _, err := f.store.List(f.ctx, f.warehouse, 1, 25); return err },
		"detail":    func() error { _, err := f.store.Detail(f.ctx, f.warehouse, original.ID); return err },
		"models":    func() error { _, err := f.store.Models(f.ctx, f.warehouse); return err },
		"materials": func() error { _, err := f.store.Materials(f.ctx, f.warehouse); return err },
		"last":      func() error { _, err := f.store.LastPrices(f.ctx, f.warehouse); return err },
		"received":  func() error { _, err := f.store.Received(f.ctx, f.warehouse); return err },
	}
	for name, call := range warehouseCalls {
		if err := call(); !errors.Is(err, purchases.ErrForbidden) {
			t.Fatalf("the warehouse must be forbidden on %s, got %v", name, err)
		}
	}
	// A session that still must change its password operates nothing.
	pending := auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}, MustChangePassword: true}
	if _, err := f.store.Create(f.ctx, pending, document("store-isolation-04")); !errors.Is(err, purchases.ErrForbidden) {
		t.Fatalf("a pending password session must be forbidden, got %v", err)
	}
	// Another branch never sees this document, neither in the page nor in the detail.
	page, err := f.store.List(f.ctx, f.other, 1, 25)
	if err != nil || page.TotalPurchases != 0 || len(page.Purchases) != 0 {
		t.Fatalf("a foreign branch must see no document: %+v %v", page, err)
	}
	if _, err := f.store.Detail(f.ctx, f.other, original.ID); !errors.Is(err, purchases.ErrNotFound) {
		t.Fatalf("a foreign document must be not found, got %v", err)
	}
	// The branch's own reads keep working.
	page, err = f.store.List(f.ctx, f.branch, 1, 25)
	if err != nil || page.TotalPurchases != 1 || len(page.Purchases) != 1 {
		t.Fatalf("the branch must see its own document: %+v %v", page, err)
	}
}

// TestStoreList proves the page: newest first, the document header per row, the exact
// unit total and the scrap line count, and the reversal cross-references.
func TestStoreList(t *testing.T) {
	f := newPurchaseFixture(t)
	first, err := f.store.Create(f.ctx, f.branch, document("store-page-key-01"))
	if err != nil {
		t.Fatalf("the first document must be admitted: %v", err)
	}
	second := document("store-page-key-02")
	second.ScrapLines = nil
	second.UsedLines = []purchases.UsedLineInput{{Model: "55B24L", Quantity: 3, UnitPrice: "9000.00"}}
	second.PaidCash, second.PaidTransfer = "27000.00", "0.00"
	created, err := f.store.Create(f.ctx, f.branch, second)
	if err != nil {
		t.Fatalf("the second document must be admitted: %v", err)
	}
	counter, err := f.store.Reverse(f.ctx, f.branch, first.ID, "store-page-key-03", "motivo del pesaje")
	if err != nil {
		t.Fatalf("the first document must be reversible: %v", err)
	}
	page, err := f.store.List(f.ctx, f.branch, 1, 10)
	if err != nil {
		t.Fatalf("the page must be readable: %v", err)
	}
	if page.Page != 1 || page.PageSize != 10 || page.TotalPurchases != 3 || len(page.Purchases) != 3 {
		t.Fatalf("the page is wrong: %+v", page)
	}
	// The page is newest first, so the counter-document leads.
	if page.Purchases[0].ID != counter.ID || page.Purchases[1].ID != created.ID ||
		page.Purchases[2].ID != first.ID {
		t.Fatalf("the page is not newest first: %+v", page.Purchases)
	}
	lead := page.Purchases[0]
	if lead.Total != "-124200.00" || lead.ReversesPurchaseID == nil ||
		*lead.ReversesPurchaseID != first.ID || lead.ReversedBy != nil ||
		lead.UsedUnits != -1 || lead.ScrapLines != 1 || lead.CreatedAt.IsZero() {
		t.Fatalf("the counter-document row is wrong: %+v", lead)
	}
	if page.Purchases[1].UsedUnits != 3 || page.Purchases[1].ScrapLines != 0 ||
		page.Purchases[1].Total != "27000.00" || page.Purchases[1].ReversedBy != nil {
		t.Fatalf("the used-only row is wrong: %+v", page.Purchases[1])
	}
	row := page.Purchases[2]
	if row.UsedUnits != 1 || row.ScrapLines != 1 || row.Total != "124200.00" ||
		row.ReversedBy == nil || *row.ReversedBy != counter.ID {
		t.Fatalf("the reversed original row is wrong: %+v", row)
	}
	// A page beyond the last one is legitimately empty, and the total still counts.
	beyond, err := f.store.List(f.ctx, f.branch, 2, 10)
	if err != nil || beyond.TotalPurchases != 3 || len(beyond.Purchases) != 0 {
		t.Fatalf("a page beyond the last one must be empty: %+v %v", beyond, err)
	}
	// The frozen page contract refuses anything else before the database is touched.
	for _, tc := range [][2]int{{0, 25}, {1, 20}, {1, 100}, {1_000_001, 25}} {
		if _, err := f.store.List(f.ctx, f.branch, tc[0], tc[1]); !errors.Is(err, purchases.ErrInvalid) {
			t.Fatalf("page %d/%d must be refused, got %v", tc[0], tc[1], err)
		}
	}
}

// TestStoreModelsMaterialsAndLastPrices proves the counter's three reads: the catalogue's
// own deduplicated model list, the reference materials and the last price paid in this
// branch.
func TestStoreModelsMaterialsAndLastPrices(t *testing.T) {
	f := newPurchaseFixture(t)
	models, err := f.store.Models(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the model list must be readable: %v", err)
	}
	// The contract orders the list by model code, so the expectation is read in the same
	// byte order the store publishes, never in the database's locale collation.
	rows, err := f.p.Query(f.ctx, `SELECT DISTINCT model COLLATE "C" AS model FROM catalog_entries
 WHERE deleted_at IS NULL ORDER BY model`)
	if err != nil {
		t.Fatalf("the catalogue models could not be read: %v", err)
	}
	want := make([]string, 0)
	for rows.Next() {
		var model string
		if rows.Scan(&model) != nil {
			t.Fatal("the catalogue model could not be read")
		}
		want = append(want, model)
	}
	rows.Close()
	if len(models) != len(want) {
		t.Fatalf("the model list has %d models, want %d", len(models), len(want))
	}
	for i := range want {
		if models[i] != want[i] {
			t.Fatalf("model %d is %q, want %q", i, models[i], want[i])
		}
	}
	// A model created in the catalogue appears here by itself: there is no mirror list
	// to maintain.
	if _, err := f.p.Exec(f.ctx, `INSERT INTO catalog_entries(brand,model,capacity_ah)
 VALUES('Nueva','ZZ-NUEVO',50)`); err != nil {
		t.Fatalf("the new battery could not be created: %v", err)
	}
	models, err = f.store.Models(f.ctx, f.branch)
	if err != nil || len(models) != len(want)+1 {
		t.Fatalf("a new catalogue model must appear by itself: %d models, want %d: %v",
			len(models), len(want)+1, err)
	}
	var appeared bool
	for _, model := range models {
		if model == "ZZ-NUEVO" {
			appeared = true
		}
	}
	if !appeared {
		t.Fatalf("the new catalogue model is missing from the list: %v", models)
	}
	materials, err := f.store.Materials(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the material list must be readable: %v", err)
	}
	if len(materials) != 4 || materials[0] != (purchases.Material{ID: 1, Name: "Cobre"}) ||
		materials[1].Name != "Aluminio" || materials[2].Name != "Plomo" ||
		materials[3] != (purchases.Material{ID: 4, Name: "Bronce"}) {
		t.Fatalf("the reference materials are wrong: %+v", materials)
	}
	// A branch that never bought anything reports no last price at all.
	if prices, err := f.store.LastPrices(f.ctx, f.branch); err != nil || len(prices.Models) != 0 || len(prices.Materials) != 0 {
		t.Fatalf("an empty branch reports no last price: %+v %v", prices, err)
	}
	first, err := f.store.Create(f.ctx, f.branch, document("store-prices-key-01"))
	if err != nil {
		t.Fatalf("the first purchase must be admitted: %v", err)
	}
	prices, err := f.store.LastPrices(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the last prices must be readable: %v", err)
	}
	if len(prices.Models) != 1 || prices.Models[0].Model != "NS60ZL" ||
		prices.Models[0].UnitPrice != "25000.00" || !prices.Models[0].PurchasedAt.Equal(first.CreatedAt) {
		t.Fatalf("the last model price is wrong: %+v", prices.Models)
	}
	if len(prices.Materials) != 1 || prices.Materials[0].MaterialID != 1 ||
		prices.Materials[0].PricePerKg != "8000.00" || !prices.Materials[0].PurchasedAt.Equal(first.CreatedAt) {
		t.Fatalf("the last material price is wrong: %+v", prices.Materials)
	}
	// A newer typed price replaces the anchor; the older one is not lost, it is simply
	// not the last.
	newer := document("store-prices-key-02")
	newer.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "26000.00"}}
	newer.ScrapLines = nil
	newer.PaidCash, newer.PaidTransfer = "52000.00", "0.00"
	second, err := f.store.Create(f.ctx, f.branch, newer)
	if err != nil {
		t.Fatalf("the newer purchase must be admitted: %v", err)
	}
	prices, err = f.store.LastPrices(f.ctx, f.branch)
	if err != nil || len(prices.Models) != 1 || prices.Models[0].UnitPrice != "26000.00" ||
		!prices.Models[0].PurchasedAt.Equal(second.CreatedAt) {
		t.Fatalf("the latest typed price must win: %+v %v", prices.Models, err)
	}
	// A counter-document is not a purchase price: the anchor stays on the latest
	// document that is not one.
	if _, err := f.store.Reverse(f.ctx, f.branch, second.ID, "store-prices-key-03", "motivo"); err != nil {
		t.Fatalf("the newer purchase must be reversible: %v", err)
	}
	prices, err = f.store.LastPrices(f.ctx, f.branch)
	if err != nil || len(prices.Models) != 1 || prices.Models[0].UnitPrice != "26000.00" ||
		!prices.Models[0].PurchasedAt.Equal(second.CreatedAt) {
		t.Fatalf("a counter-document must not become the last price: %+v %v", prices.Models, err)
	}
	// A purchase of another branch never becomes this branch's anchor, and a model
	// never bought here is absent.
	foreign := document("store-prices-key-04")
	foreign.UsedLines = []purchases.UsedLineInput{{Model: "ZZ-NUEVO", Quantity: 1, UnitPrice: "1234.00"}}
	foreign.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 4, Kg: "1.000", PricePerKg: "500.00"}}
	foreign.PaidCash, foreign.PaidTransfer = "1734.00", "0.00"
	if _, err := f.store.Create(f.ctx, f.other, foreign); err != nil {
		t.Fatalf("the foreign purchase must be admitted in its own branch: %v", err)
	}
	prices, err = f.store.LastPrices(f.ctx, f.branch)
	if err != nil || len(prices.Models) != 1 || prices.Models[0].Model != "NS60ZL" ||
		len(prices.Materials) != 1 || prices.Materials[0].MaterialID != 1 {
		t.Fatalf("a foreign purchase must not be this branch's anchor: %+v %v", prices, err)
	}
}

// TestStoreReceived proves the month-end read: what the branch received, per model and
// per material, with its valuation, derived from every persisted document so a
// counter-document nets out and a zero row is omitted.
func TestStoreReceived(t *testing.T) {
	f := newPurchaseFixture(t)
	first, err := f.store.Create(f.ctx, f.branch, document("store-received-01"))
	if err != nil {
		t.Fatalf("the first purchase must be admitted: %v", err)
	}
	newer := document("store-received-02")
	newer.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 1, UnitPrice: "26000.00"}}
	newer.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 1, Kg: "1.000", PricePerKg: "8000.00"}}
	newer.PaidCash, newer.PaidTransfer = "34000.00", "0.00"
	second, err := f.store.Create(f.ctx, f.branch, newer)
	if err != nil {
		t.Fatalf("the newer purchase must be admitted: %v", err)
	}
	// A model that is not in the catalogue is still typed freely, and it shows up here.
	free := document("store-received-03")
	free.UsedLines = []purchases.UsedLineInput{{Model: "no-catalogo-9", Quantity: 2, UnitPrice: "5000.00"}}
	free.ScrapLines = nil
	free.PaidCash, free.PaidTransfer = "10000.00", "0.00"
	if _, err := f.store.Create(f.ctx, f.branch, free); err != nil {
		t.Fatalf("a freely typed model must be admitted: %v", err)
	}
	received, err := f.store.Received(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the received totals must be readable: %v", err)
	}
	// The rows are ordered by model code, byte by byte: "NO-CATALOGO-9" precedes "NS60ZL" of
	// this branch's own typing.
	if len(received.Used) != 2 || received.Used[0].Model != "NO-CATALOGO-9" ||
		received.Used[0].Quantity != 2 || received.Used[0].Value != "10000.00" ||
		received.Used[1].Model != "NS60ZL" || received.Used[1].Quantity != 2 ||
		received.Used[1].Value != "51000.00" {
		t.Fatalf("the received used rows are wrong: %+v", received.Used)
	}
	if len(received.Scrap) != 1 || received.Scrap[0].MaterialID != 1 ||
		received.Scrap[0].Name != "Cobre" || received.Scrap[0].Kg != "13.400" ||
		received.Scrap[0].Value != "107200.00" {
		t.Fatalf("the received scrap rows are wrong: %+v", received.Scrap)
	}
	// A counter-document nets out: the reversed purchase leaves no copper behind, so its
	// row is omitted instead of being reported as a zero.
	if _, err := f.store.Reverse(f.ctx, f.branch, first.ID, "store-received-key-04", "pesaje mal tipeado"); err != nil {
		t.Fatalf("the first purchase must be reversible: %v", err)
	}
	received, err = f.store.Received(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the received totals must stay readable: %v", err)
	}
	if len(received.Used) != 2 || received.Used[0].Value != "10000.00" ||
		received.Used[1].Quantity != 1 || received.Used[1].Value != "26000.00" {
		t.Fatalf("a counter-document must net the used rows: %+v", received.Used)
	}
	if len(received.Scrap) != 1 || received.Scrap[0].Kg != "1.000" ||
		received.Scrap[0].Value != "8000.00" {
		t.Fatalf("a counter-document must net the scrap rows: %+v", received.Scrap)
	}
	// Netting every receipt of one material to zero omits the row entirely.
	if _, err := f.store.Reverse(f.ctx, f.branch, second.ID, "store-received-key-05", "otro pesaje"); err != nil {
		t.Fatalf("the second purchase must be reversible: %v", err)
	}
	received, err = f.store.Received(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the received totals must stay readable: %v", err)
	}
	if len(received.Scrap) != 0 {
		t.Fatalf("a material netted to zero must be omitted: %+v", received.Scrap)
	}
	// Another branch's receipts are never part of this branch's month.
	foreign := document("store-received-06")
	foreign.UsedLines = []purchases.UsedLineInput{{Model: "AJENO", Quantity: 1, UnitPrice: "1.00"}}
	foreign.ScrapLines = nil
	foreign.PaidCash, foreign.PaidTransfer = "1.00", "0.00"
	if _, err := f.store.Create(f.ctx, f.other, foreign); err != nil {
		t.Fatalf("the foreign purchase must be admitted in its own branch: %v", err)
	}
	received, err = f.store.Received(f.ctx, f.branch)
	// Every NS60ZL receipt of this branch was reversed, so only the freely typed model is
	// left: a model netted to zero is omitted, exactly like a material.
	if err != nil || len(received.Used) != 1 || received.Used[0].Model != "NO-CATALOGO-9" {
		t.Fatalf("a foreign receipt must not be part of this branch: %+v %v", received, err)
	}
	for _, row := range received.Used {
		if row.Model == "AJENO" || strings.EqualFold(row.Model, "ajeno") {
			t.Fatalf("a foreign receipt leaked into this branch: %+v", received.Used)
		}
	}
}

// TestStoreRefusesUnknownMaterial proves that a scrap line naming a material the reference
// table does not hold is refused before any document is written: existence is the
// database's own property, so it is proven against the seeded table and not against a Go
// constant.
func TestStoreRefusesUnknownMaterial(t *testing.T) {
	f := newPurchaseFixture(t)
	input := document("store-material-key-01")
	input.UsedLines = nil
	input.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 5, Kg: "1.000", PricePerKg: "1000.00"}}
	input.PaidCash, input.PaidTransfer = "1000.00", "0.00"
	if _, err := f.store.Create(f.ctx, f.branch, input); !errors.Is(err, purchases.ErrInvalid) {
		t.Fatalf("a material that does not exist must be refused, got %v", err)
	}
	if f.countDocuments(t, 2) != 0 {
		t.Fatal("a refused document wrote a header")
	}
	// The reference data is the contract's own list: the four materials exist and are
	// admissible, and a fifth id is not.
	for material := int64(1); material <= 5; material++ {
		key := fmt.Sprintf("store-material-key-%02d", material)
		input = document(key)
		input.UsedLines = nil
		input.ScrapLines = []purchases.ScrapLineInput{{MaterialID: material, Kg: "1.000",
			PricePerKg: "1000.00"}}
		input.PaidCash, input.PaidTransfer = "1000.00", "0.00"
		_, err := f.store.Create(f.ctx, f.branch, input)
		if admitted := err == nil; admitted != (material <= 4) {
			t.Fatalf("material %d: admitted %v, want %v (%v)", material, admitted, material <= 4, err)
		}
	}
}

// TestStoreUnavailable proves the store fails closed without a pool and that an unknown
// document is not found instead of described.
func TestStoreUnavailable(t *testing.T) {
	var store *purchases.Store
	if _, err := store.Create(context.Background(), auth.Identity{}, document("store-empty-key-01")); !errors.Is(err, purchases.ErrUnavailable) {
		t.Fatalf("a nil store must fail closed, got %v", err)
	}
	store = purchases.New(nil)
	if _, err := store.Detail(context.Background(), auth.Identity{}, 1); !errors.Is(err, purchases.ErrUnavailable) {
		t.Fatalf("a store without a pool must fail closed, got %v", err)
	}
}
