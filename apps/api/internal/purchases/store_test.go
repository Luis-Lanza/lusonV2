package purchases_test

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
	"luson/api/internal/testpg"
)

// purchaseFixture is one isolated installation: the seeded catalogue, the three
// provisioned accounts and the store of this domain. The three identities are the ones
// bootstrap.Provision creates: the warehouse (account 1, location 1) and one account
// per branch.
type purchaseFixture struct {
	ctx         context.Context
	p           *pgxpool.Pool
	store       *purchases.Store
	settlements *closings.Store
	branch      auth.Identity
	other       auth.Identity
	warehouse   auth.Identity
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
		ctx:         ctx,
		p:           p,
		store:       purchases.New(p),
		settlements: closings.New(p),
		// Provision assigns account i+1 to location i+1.
		branch:    auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}},
		other:     auth.Identity{AccountID: 3, Location: auth.Location{ID: 3}},
		warehouse: auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
	}
}

// allHistory is the period a client that does not choose one reads.
var allHistory = purchases.PeriodSelection{Kind: purchases.PeriodAll}

// openSettlement walks one settlement of a branch to the moment the warehouse holds it: the
// commission the proposal needs is configured, the count sheet is counted as the system expects
// it and the material sheet is counted exactly as the test states, so a test only names the
// lines it is interested in. The purchase fund is left unstated, which is the honest state of an
// envelope nobody counted, so a later purchase is not measured against it.
func (f *purchaseFixture) openSettlement(t *testing.T, branch int64, counted []closings.MaterialCounted) closings.Closing {
	t.Helper()
	if _, err := f.settlements.ConfigureCommission(f.ctx, f.warehouse, branch, "10.00"); err != nil {
		t.Fatalf("the branch commission could not be configured: %v", err)
	}
	opened, err := f.settlements.Open(f.ctx, f.warehouse, branch)
	if err != nil {
		t.Fatalf("the settlement of branch %d could not be opened: %v", branch, err)
	}
	read, err := f.settlements.Read(f.ctx, f.warehouse, opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	stock := make([]closings.Counted, 0, len(read.CountLines))
	for _, line := range read.CountLines {
		stock = append(stock, closings.Counted{VariantID: line.VariantID, Quantity: line.ExpectedQuantity})
	}
	if len(stock) > 0 {
		if _, err := f.settlements.Count(f.ctx, f.warehouse, opened.ID, stock); err != nil {
			t.Fatalf("the count sheet could not be counted: %v", err)
		}
	}
	if len(counted) > 0 {
		if _, err := f.settlements.CountMaterials(f.ctx, f.warehouse, opened.ID, counted); err != nil {
			t.Fatalf("the material sheet could not be counted: %v", err)
		}
	}
	zero, contribution := closings.Money("0.00"), closings.Money("500.00")
	if _, err := f.settlements.SaveCash(f.ctx, f.warehouse, opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
	}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	return opened
}

// proposeSettlement records the offer of a settlement the warehouse holds, which is the state
// the branch decides against.
func (f *purchaseFixture) proposeSettlement(t *testing.T, id int64) {
	t.Helper()
	if _, err := f.settlements.Propose(f.ctx, f.warehouse, id); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
}

// decideSettlement is the branch's acceptance, so a closed period exists only through the
// database's own state machine.
func (f *purchaseFixture) decideSettlement(t *testing.T, id int64, decider auth.Identity) {
	t.Helper()
	closed, err := f.settlements.Decide(f.ctx, decider, id, closings.DecisionAccepted, "")
	if err != nil || closed.Status != closings.StatusClosed {
		t.Fatalf("the branch must accept the settlement: %+v %v", closed, err)
	}
}

// closeSettlement opens a settlement, counts the material sheet as the test states and closes
// it, so the period is a closed fact of the branch.
func (f *purchaseFixture) closeSettlement(t *testing.T, branch int64, decider auth.Identity, counted []closings.MaterialCounted) int64 {
	t.Helper()
	opened := f.openSettlement(t, branch, counted)
	f.proposeSettlement(t, opened.ID)
	f.decideSettlement(t, opened.ID, decider)
	return opened.ID
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
	input.PaidCash, input.PaidTransfer = "146200.00", "0.00"
	created, err := f.store.Create(f.ctx, f.branch, input)
	if err != nil {
		t.Fatalf("a complete purchase must be admitted: %v", err)
	}
	if created.ID < 1 || created.LocationID != 2 || created.CreatedByAccountID != 2 ||
		created.CreatedAt.IsZero() || created.ReversesPurchaseID != nil ||
		created.ReversedBy != nil || created.Reason != "" {
		t.Fatalf("the persisted header is wrong: %+v", created)
	}
	// 25000.00 + 2 * 10000.00 + 12.400 * 8000.00 + 0.500 * 4000.00 = 146200.00, paid whole
	// in cash from the purchase fund: the fund is cash, so no part of a purchase is paid by
	// transfer.
	if created.Total != "146200.00" || created.PaidCash != "146200.00" || created.PaidTransfer != "0.00" {
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
		// A different settlement under the same key is a conflict before anything is inserted:
		// the key is already the persisted document's, so the fund rule is never reached
		// with this payload.
		"paid": func(in *purchases.CreateInput) { in.PaidCash, in.PaidTransfer = "124000.00", "200.00" },
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
		"list":      func() error { _, err := f.store.List(f.ctx, f.warehouse, 1, 25, allHistory); return err },
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
	page, err := f.store.List(f.ctx, f.other, 1, 25, allHistory)
	if err != nil || page.Page.TotalPurchases != 0 || len(page.Page.Purchases) != 0 {
		t.Fatalf("a foreign branch must see no document: %+v %v", page, err)
	}
	if _, err := f.store.Detail(f.ctx, f.other, original.ID); !errors.Is(err, purchases.ErrNotFound) {
		t.Fatalf("a foreign document must be not found, got %v", err)
	}
	// The branch's own reads keep working.
	page, err = f.store.List(f.ctx, f.branch, 1, 25, allHistory)
	if err != nil || page.Page.TotalPurchases != 1 || len(page.Page.Purchases) != 1 {
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
	page, err := f.store.List(f.ctx, f.branch, 1, 10, allHistory)
	if err != nil {
		t.Fatalf("the page must be readable: %v", err)
	}
	if page.Page.Page != 1 || page.Page.PageSize != 10 || page.Page.TotalPurchases != 3 || len(page.Page.Purchases) != 3 {
		t.Fatalf("the page is wrong: %+v", page)
	}
	// The page is newest first, so the counter-document leads.
	if page.Page.Purchases[0].ID != counter.ID || page.Page.Purchases[1].ID != created.ID ||
		page.Page.Purchases[2].ID != first.ID {
		t.Fatalf("the page is not newest first: %+v", page.Page.Purchases)
	}
	lead := page.Page.Purchases[0]
	if lead.Total != "-124200.00" || lead.ReversesPurchaseID == nil ||
		*lead.ReversesPurchaseID != first.ID || lead.ReversedBy != nil ||
		lead.UsedUnits != -1 || lead.ScrapLines != 1 || lead.CreatedAt.IsZero() {
		t.Fatalf("the counter-document row is wrong: %+v", lead)
	}
	if page.Page.Purchases[1].UsedUnits != 3 || page.Page.Purchases[1].ScrapLines != 0 ||
		page.Page.Purchases[1].Total != "27000.00" || page.Page.Purchases[1].ReversedBy != nil {
		t.Fatalf("the used-only row is wrong: %+v", page.Page.Purchases[1])
	}
	row := page.Page.Purchases[2]
	if row.UsedUnits != 1 || row.ScrapLines != 1 || row.Total != "124200.00" ||
		row.ReversedBy == nil || *row.ReversedBy != counter.ID {
		t.Fatalf("the reversed original row is wrong: %+v", row)
	}
	// A page beyond the last one is legitimately empty, and the total still counts.
	beyond, err := f.store.List(f.ctx, f.branch, 2, 10, allHistory)
	if err != nil || beyond.Page.TotalPurchases != 3 || len(beyond.Page.Purchases) != 0 {
		t.Fatalf("a page beyond the last one must be empty: %+v %v", beyond, err)
	}
	// The frozen page contract refuses anything else before the database is touched.
	for _, tc := range [][2]int{{0, 25}, {1, 20}, {1, 100}, {1_000_001, 25}} {
		if _, err := f.store.List(f.ctx, f.branch, tc[0], tc[1], allHistory); !errors.Is(err, purchases.ErrInvalid) {
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
	rows, err := f.p.Query(f.ctx, `SELECT canonical.model FROM (
 SELECT DISTINCT upper(btrim(model)) AS model FROM catalog_entries WHERE deleted_at IS NULL
) canonical ORDER BY canonical.model COLLATE "C"`)
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
	// The published list is canonical, because the contract trims and upper-cases a model
	// code and the client refuses a list that is not already canonical: the same code under
	// two brands, typed in mixed case, is one entry in upper case, not two and not "zz-nuevo".
	if _, err := f.p.Exec(f.ctx, `INSERT INTO catalog_entries(brand,model,capacity_ah)
 VALUES('Otra','zz-nuevo',50),('Tercera','SolarN9',50)`); err != nil {
		t.Fatalf("the repeated battery could not be created: %v", err)
	}
	models, err = f.store.Models(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the model list must stay readable: %v", err)
	}
	seen := map[string]int{}
	for _, model := range models {
		if model != strings.ToUpper(model) {
			t.Fatalf("the model list must be canonical, got %q", model)
		}
		seen[model]++
	}
	if seen["ZZ-NUEVO"] != 1 || seen["SOLARN9"] != 1 {
		t.Fatalf("a code repeated across brands and case must be one canonical entry: %v", seen)
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

// TestStoreRefusesTransferPayment proves S2: a branch purchase is paid in cash from the
// purchase fund, so a document that pays any part of it by transfer is refused with the
// fund's own refusal and neither a header nor a line is written.
func TestStoreRefusesTransferPayment(t *testing.T) {
	f := newPurchaseFixture(t)
	for name, paid := range map[string][2]string{
		"whole": {"0.00", "124200.00"},
		"part":  {"124000.00", "200.00"},
		"cent":  {"124199.99", "0.01"},
	} {
		input := document(fmt.Sprintf("store-fund-%s-payment", name))
		input.PaidCash, input.PaidTransfer = purchases.Money(paid[0]), purchases.Money(paid[1])
		_, err := f.store.Create(f.ctx, f.branch, input)
		var refusal *purchases.FundRefusal
		if !errors.As(err, &refusal) {
			t.Fatalf("a %s transfer payment must be the fund's own refusal, got %v", name, err)
		}
		// The boundary publishes only its own token for a document that cannot be admitted
		// as it stands, so the refusal stays an invalid request.
		if !errors.Is(err, purchases.ErrInvalid) {
			t.Fatalf("a %s fund refusal must stay an invalid request, got %v", name, err)
		}
		// The refusal speaks of the fund, never of a SQLSTATE or of the database's text.
		if message := err.Error(); strings.Contains(message, "LP006") ||
			!strings.Contains(message, "cash") || !strings.Contains(message, "purchase fund") ||
			!strings.Contains(message, "envelope") {
			t.Fatalf("the %s refusal must speak in the domain's words, got %q", name, message)
		}
	}
	if count := f.countDocuments(t, 2); count != 0 {
		t.Fatalf("a refused fund payment wrote %d documents", count)
	}
	var lines int64
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchase_used_lines").Scan(&lines); err != nil || lines != 0 {
		t.Fatalf("a refused fund payment wrote %d lines: %v", lines, err)
	}
	// The same document paid in cash is admitted: what the fund refuses is the method, not
	// the purchase.
	if _, err := f.store.Create(f.ctx, f.branch, document("store-fund-cash-only")); err != nil {
		t.Fatalf("the same purchase paid in cash must be admitted: %v", err)
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

// TestStorePurchasePeriods pins S2, S5 and S4's happy consequence at the store: the listing
// publishes the selector of the branch in its frozen order, the period it was asked for, and,
// for the pending period, the balance derived from the whole history. A settlement that counted
// everything the period bought leaves a zero balance: that is the reset the human asked for,
// and it happens without deleting a single document.
func TestStorePurchasePeriods(t *testing.T) {
	f := newPurchaseFixture(t)
	// The first settlement of a branch opens with a window of its own: it takes nothing, and the
	// purchases of the period that follows are the ones the next settlement counts (S5).
	firstClosed := f.closeSettlement(t, 2, f.branch, nil)
	first := document("store-periods-key-01")
	first.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10000.00"}}
	first.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 1, Kg: "12.400", PricePerKg: "1000.00"}}
	first.PaidCash, first.PaidTransfer = "32400.00", "0.00"
	created, err := f.store.Create(f.ctx, f.branch, first)
	if err != nil {
		t.Fatalf("the purchase must be admitted: %v", err)
	}
	closedID := f.closeSettlement(t, 2, f.branch, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "2"},
		{Kind: closings.MaterialKindScrap, MaterialID: 1, Quantity: "12.400"},
	})

	// Pending: the default reading of the screen. The documents are the whole history (S6) and
	// the header numbers are the balance, which is zero because the settlement took everything.
	pending, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodPending})
	if err != nil {
		t.Fatalf("the pending period must be readable: %v", err)
	}
	if len(pending.Periods) != 4 {
		t.Fatalf("the selector is pending, the two closed settlements and all: %+v", pending.Periods)
	}
	pendingEntry, settlement, earlier, all := pending.Periods[0], pending.Periods[1],
		pending.Periods[2], pending.Periods[3]
	if pendingEntry.Kind != purchases.PeriodPending || pendingEntry.Label != "Pendiente" ||
		pendingEntry.ClosingID != nil || pendingEntry.From != nil || pendingEntry.To != nil {
		t.Fatalf("the first period must be the pending balance with no window: %+v", pendingEntry)
	}
	if settlement.Kind != purchases.PeriodSettlement || settlement.ClosingID == nil ||
		*settlement.ClosingID != closedID || settlement.From == nil || settlement.To == nil ||
		settlement.Label != "Rendición #"+strconv.FormatInt(closedID, 10) {
		t.Fatalf("the closed settlement must be its own period: %+v", settlement)
	}
	if earlier.Kind != purchases.PeriodSettlement || earlier.ClosingID == nil ||
		*earlier.ClosingID != firstClosed {
		t.Fatalf("the closed settlements must be newest first: %+v", pending.Periods)
	}
	if all.Kind != purchases.PeriodAll || all.Label != "Todo el historial" ||
		all.ClosingID != nil || all.From != nil || all.To != nil {
		t.Fatalf("the last period must be the whole history with no window: %+v", all)
	}
	if pending.Period.Kind != purchases.PeriodPending || pending.Period.Label != "Pendiente" {
		t.Fatalf("the chosen period must repeat the selector's entry: %+v", pending.Period)
	}
	if pending.Page.TotalPurchases != 1 || len(pending.Page.Purchases) != 1 || pending.Page.Purchases[0].ID != created.ID {
		t.Fatalf("the pending period lists the whole history: %+v", pending.Page)
	}
	if pending.Balance == nil {
		t.Fatal("the pending period must publish the balance of the branch")
	}
	if len(pending.Balance.Used) != 1 ||
		pending.Balance.Used[0] != (purchases.BalanceUsed{Model: "NS60ZL", Bought: 2, Delivered: 2}) {
		t.Fatalf("a settlement that counted everything leaves a zero balance: %+v", pending.Balance.Used)
	}
	if len(pending.Balance.Scrap) != 1 || pending.Balance.Scrap[0] != (purchases.BalanceScrap{
		MaterialID: 1, Bought: "12.400", Delivered: "12.400", Balance: "0.000"}) {
		t.Fatalf("the copper balance is not zero: %+v", pending.Balance.Scrap)
	}
	// The header of the pending period reads zero in its three numbers: nothing it bought is still here.
	if pending.Totals != (purchases.Totals{UsedUnits: 0, ScrapKg: "0.000"}) || pending.Totals.Money != "" {
		t.Fatalf("a settlement that counted everything must read zero: %+v", pending.Totals)
	}

	// The whole history is exactly what the screen showed before periods existed, and it carries
	// no balance: a window has nothing to say about what the branch holds now.
	history, err := f.store.List(f.ctx, f.branch, 1, 25, allHistory)
	if err != nil || history.Balance != nil || history.Period.Kind != purchases.PeriodAll ||
		history.Page.TotalPurchases != 1 || len(history.Page.Purchases) != 1 {
		t.Fatalf("the whole history must be published without a balance: %+v %v", history, err)
	}

	// One closed settlement lists its own window and never a balance.
	period, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: closedID})
	if err != nil {
		t.Fatalf("a closed settlement must be readable as a period: %v", err)
	}
	if period.Period.Kind != purchases.PeriodSettlement || period.Balance != nil ||
		period.Page.TotalPurchases != 1 || len(period.Page.Purchases) != 1 || period.Page.Purchases[0].ID != created.ID {
		t.Fatalf("the closed period must list its own documents: %+v", period)
	}
	// The window is the settlement's own: the purchase was made before it and is inside it.
	if period.Period.From == nil || period.Period.To == nil || period.Period.From.After(*period.Period.To) {
		t.Fatalf("the closed period must state its window: %+v", period.Period)
	}
	// Its three numbers are its own window's and never the pending or the whole history's.
	if period.Totals != (purchases.Totals{Money: "32400.00", UsedUnits: 2, ScrapKg: "12.400"}) {
		t.Fatalf("the closed period must state its own totals: %+v", period.Totals)
	}
}

// TestStorePurchaseBalanceKeepsTheRemainder pins the defect the human reported: a settlement
// that counts less than the period bought must leave the rest visible as balance instead of
// making it disappear, and a later purchase must raise the balance again (S4, S1).
func TestStorePurchaseBalanceKeepsTheRemainder(t *testing.T) {
	f := newPurchaseFixture(t)
	f.closeSettlement(t, 2, f.branch, nil)
	first := document("store-remainder-key-01")
	first.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 3, UnitPrice: "10000.00"}}
	first.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 1, Kg: "10.000", PricePerKg: "1000.00"}}
	first.PaidCash, first.PaidTransfer = "40000.00", "0.00"
	if _, err := f.store.Create(f.ctx, f.branch, first); err != nil {
		t.Fatalf("the purchase must be admitted: %v", err)
	}
	// The warehouse counted one battery less and six kilograms less than the period bought.
	f.closeSettlement(t, 2, f.branch, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "2"},
		{Kind: closings.MaterialKindScrap, MaterialID: 1, Quantity: "4.000"},
	})
	pending := func() purchases.Listing {
		t.Helper()
		listing, err := f.store.List(f.ctx, f.branch, 1, 25,
			purchases.PeriodSelection{Kind: purchases.PeriodPending})
		if err != nil {
			t.Fatalf("the pending period must be readable: %v", err)
		}
		if listing.Balance == nil {
			t.Fatal("the pending period must publish the balance of the branch")
		}
		return listing
	}
	listing := pending()
	if len(listing.Balance.Used) != 1 ||
		listing.Balance.Used[0] != (purchases.BalanceUsed{Model: "NS60ZL", Bought: 3, Delivered: 2, Balance: 1}) {
		t.Fatalf("what was counted short must stay in the balance: %+v", listing.Balance.Used)
	}
	if len(listing.Balance.Scrap) != 1 || listing.Balance.Scrap[0] != (purchases.BalanceScrap{
		MaterialID: 1, Bought: "10.000", Delivered: "4.000", Balance: "6.000"}) {
		t.Fatalf("the copper that was counted short must stay in the balance: %+v", listing.Balance.Scrap)
	}
	// The header numbers are that same remainder, never the history: one battery and six kilos.
	if listing.Totals != (purchases.Totals{UsedUnits: 1, ScrapKg: "6.000"}) {
		t.Fatalf("what was counted short must stay in the totals: %+v", listing.Totals)
	}

	// Buying again after the closure raises the balance from where it was, and a model the
	// settlement never saw starts from zero.
	second := document("store-remainder-key-02")
	second.UsedLines = []purchases.UsedLineInput{
		{Model: "55B24L", Quantity: 1, UnitPrice: "1000.00"},
		{Model: "NS60ZL", Quantity: 2, UnitPrice: "1000.00"},
	}
	second.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 1, Kg: "3.000", PricePerKg: "1000.00"}}
	second.PaidCash, second.PaidTransfer = "6000.00", "0.00"
	created, err := f.store.Create(f.ctx, f.branch, second)
	if err != nil {
		t.Fatalf("a purchase after the closure must be admitted: %v", err)
	}
	listing = pending()
	if len(listing.Balance.Used) != 2 ||
		listing.Balance.Used[0] != (purchases.BalanceUsed{Model: "55B24L", Bought: 1, Delivered: 0, Balance: 1}) ||
		listing.Balance.Used[1] != (purchases.BalanceUsed{Model: "NS60ZL", Bought: 5, Delivered: 2, Balance: 3}) {
		t.Fatalf("a purchase after the closure must raise the balance: %+v", listing.Balance.Used)
	}
	if listing.Balance.Scrap[0].Bought != "13.000" || listing.Balance.Scrap[0].Balance != "9.000" {
		t.Fatalf("the copper balance must rise again: %+v", listing.Balance.Scrap)
	}
	if listing.Totals != (purchases.Totals{UsedUnits: 4, ScrapKg: "9.000"}) {
		t.Fatalf("a purchase after the closure must raise the totals: %+v", listing.Totals)
	}

	// A counter-document subtracts like every other document (S7): the model it reversed nets
	// back to nothing and is not a row of this answer, and the quantities return to where they
	// were before the second purchase.
	if _, err := f.store.Reverse(f.ctx, f.branch, created.ID, "store-remainder-key-03", "pesaje mal tipeado"); err != nil {
		t.Fatalf("the purchase must be reversible: %v", err)
	}
	listing = pending()
	if len(listing.Balance.Used) != 1 ||
		listing.Balance.Used[0] != (purchases.BalanceUsed{Model: "NS60ZL", Bought: 3, Delivered: 2, Balance: 1}) {
		t.Fatalf("a counter-document must subtract from the balance: %+v", listing.Balance.Used)
	}
	if len(listing.Balance.Scrap) != 1 || listing.Balance.Scrap[0].Bought != "10.000" ||
		listing.Balance.Scrap[0].Balance != "6.000" {
		t.Fatalf("a counter-document must subtract from the copper balance: %+v", listing.Balance.Scrap)
	}
	if listing.Totals != (purchases.Totals{UsedUnits: 1, ScrapKg: "6.000"}) {
		t.Fatalf("a counter-document must subtract from the totals: %+v", listing.Totals)
	}
}

// TestStorePurchaseBalanceCountsClosedSettlementsOnly pins S4's third consequence and the rule
// that delivered means counted in a closed settlement: while the settlement is only open or
// proposed it has taken nothing, and the period it belongs to is the live one, published as
// "En curso".
func TestStorePurchaseBalanceCountsClosedSettlementsOnly(t *testing.T) {
	f := newPurchaseFixture(t)
	f.closeSettlement(t, 2, f.branch, nil)
	first := document("store-closed-only-key-01")
	first.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10000.00"}}
	first.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 2, Kg: "5.000", PricePerKg: "1000.00"}}
	first.PaidCash, first.PaidTransfer = "25000.00", "0.00"
	if _, err := f.store.Create(f.ctx, f.branch, first); err != nil {
		t.Fatalf("the purchase must be admitted: %v", err)
	}
	opened := f.openSettlement(t, 2, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "2"},
		{Kind: closings.MaterialKindScrap, MaterialID: 2, Quantity: "5.000"},
	})
	f.proposeSettlement(t, opened.ID)

	// A proposed settlement has taken nothing yet: the whole purchase is still the balance.
	pending, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodPending})
	if err != nil || pending.Balance == nil {
		t.Fatalf("the pending period must be readable: %+v %v", pending, err)
	}
	if len(pending.Balance.Used) != 1 ||
		pending.Balance.Used[0] != (purchases.BalanceUsed{Model: "NS60ZL", Bought: 2, Delivered: 0, Balance: 2}) {
		t.Fatalf("a proposed settlement has taken nothing: %+v", pending.Balance.Used)
	}
	if len(pending.Balance.Scrap) != 1 || pending.Balance.Scrap[0] != (purchases.BalanceScrap{
		MaterialID: 2, Bought: "5.000", Delivered: "0.000", Balance: "5.000"}) {
		t.Fatalf("a proposed settlement has taken no material: %+v", pending.Balance.Scrap)
	}
	// The selector offers the live settlement after the closed ones and before the whole
	// history, named by its kind because it is the period the branch is still inside.
	if len(pending.Periods) != 4 || pending.Periods[0].Kind != purchases.PeriodPending ||
		pending.Periods[1].Kind != purchases.PeriodSettlement ||
		pending.Periods[2].Kind != purchases.PeriodOpen || pending.Periods[2].ClosingID == nil ||
		*pending.Periods[2].ClosingID != opened.ID || pending.Periods[2].Label != "En curso" ||
		pending.Periods[3].Kind != purchases.PeriodAll {
		t.Fatalf("the live settlement must be the period in progress: %+v", pending.Periods)
	}
	// Its own period lists the documents of its window and never a balance.
	inProgress, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodOpen})
	if err != nil || inProgress.Period.Kind != purchases.PeriodOpen || inProgress.Balance != nil ||
		inProgress.Page.TotalPurchases != 1 || len(inProgress.Page.Purchases) != 1 {
		t.Fatalf("the period in progress must list its own documents: %+v %v", inProgress, err)
	}

	// The closure is what takes the material to the warehouse: from then on the balance is zero
	// and the live period is gone from the selector.
	f.decideSettlement(t, opened.ID, f.branch)
	closed, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodPending})
	if err != nil || closed.Balance == nil {
		t.Fatalf("the pending period must stay readable: %+v %v", closed, err)
	}
	if len(closed.Balance.Used) != 1 || closed.Balance.Used[0].Delivered != 2 ||
		closed.Balance.Used[0].Balance != 0 || closed.Balance.Scrap[0].Balance != "0.000" {
		t.Fatalf("a closed settlement must take the counted material: %+v", closed.Balance)
	}
	if len(closed.Periods) != 4 || closed.Periods[1].Kind != purchases.PeriodSettlement ||
		closed.Periods[1].ClosingID == nil || *closed.Periods[1].ClosingID != opened.ID {
		t.Fatalf("the closed settlement must replace the live period: %+v", closed.Periods)
	}
	if _, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodOpen}); !errors.Is(err, purchases.ErrInvalid) {
		t.Fatalf("the period in progress must not exist once the settlement closed: %v", err)
	}
}

// TestStorePurchaseSelectionRefusals pins the selector's own refusals: a period the branch does
// not have is an invalid request, never an empty list, and a period shape this contract does not
// admit never reaches the database.
func TestStorePurchaseSelectionRefusals(t *testing.T) {
	f := newPurchaseFixture(t)
	// An empty branch still offers its two periods, and its balance is an empty reading instead
	// of an absent one.
	empty, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodPending})
	if err != nil || empty.Balance == nil || empty.Balance.Used == nil || empty.Balance.Scrap == nil ||
		len(empty.Periods) != 2 || empty.Page.TotalPurchases != 0 || len(empty.Page.Purchases) != 0 {
		t.Fatalf("an empty branch must publish its two periods and an empty balance: %+v %v", empty, err)
	}
	first := document("store-selection-key-01")
	if _, err := f.store.Create(f.ctx, f.branch, first); err != nil {
		t.Fatalf("the purchase must be admitted: %v", err)
	}
	// One closed settlement of another branch exists, and it is not a period of this branch.
	foreign := f.closeSettlement(t, 3, f.other, nil)
	own := f.closeSettlement(t, 2, f.branch, nil)
	// The live settlement of this branch exists too, and its id is not a closed period.
	live := f.openSettlement(t, 2, nil)
	for name, selection := range map[string]purchases.PeriodSelection{
		"unknown settlement":     {Kind: purchases.PeriodSettlement, ClosingID: 999_999},
		"foreign settlement":     {Kind: purchases.PeriodSettlement, ClosingID: foreign},
		"no closing id":          {Kind: purchases.PeriodSettlement},
		"negative closing id":    {Kind: purchases.PeriodSettlement, ClosingID: -1},
		"unknown kind":           {Kind: purchases.PeriodKind("month")},
		"kind with a closing id": {Kind: purchases.PeriodAll, ClosingID: own},
	} {
		if _, err := f.store.List(f.ctx, f.branch, 1, 25, selection); !errors.Is(err, purchases.ErrInvalid) {
			t.Fatalf("a %s selection must be refused as an invalid request, got %v", name, err)
		}
	}
	// The periods the branch does have keep being readable, and the foreign settlement is not
	// one of them.
	for _, selection := range []purchases.PeriodSelection{
		{Kind: purchases.PeriodPending}, {Kind: purchases.PeriodAll}, {Kind: purchases.PeriodOpen},
		{Kind: purchases.PeriodSettlement, ClosingID: own},
	} {
		if _, err := f.store.List(f.ctx, f.branch, 1, 25, selection); err != nil {
			t.Fatalf("the selection %+v must be readable: %v", selection, err)
		}
	}
	// A closing id names the live settlement too, because the selector publishes it as the
	// period in progress: an entry nobody could choose would be a period the screen shows and
	// never opens.
	inProgress, err := f.store.List(f.ctx, f.branch, 1, 25,
		purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: live.ID})
	if err != nil || inProgress.Period.Kind != purchases.PeriodOpen ||
		inProgress.Period.ClosingID == nil || *inProgress.Period.ClosingID != live.ID ||
		inProgress.Balance != nil {
		t.Fatalf("the live settlement must be selectable by its closing id: %+v %v", inProgress, err)
	}
}

// listingOf reads one period of this branch, so a test states the selection and nothing else.
func (f *purchaseFixture) listingOf(t *testing.T, selection purchases.PeriodSelection) purchases.Listing {
	t.Helper()
	listing, err := f.store.List(f.ctx, f.branch, 1, 25, selection)
	if err != nil {
		t.Fatalf("the listing of %+v must be readable: %v", selection, err)
	}
	return listing
}

// TestStorePurchaseTotalsFollowThePeriod pins S3 at the store: the three header numbers of the
// listing are the totals of the chosen period, so a closed settlement states its own money, units
// and kilos instead of the accumulated history, and the whole history states exactly what the
// received route already published for that same history.
func TestStorePurchaseTotalsFollowThePeriod(t *testing.T) {
	f := newPurchaseFixture(t)
	pending := purchases.PeriodSelection{Kind: purchases.PeriodPending}
	// The first settlement of a branch is an empty period of its own: it states three zeros, never
	// the history.
	firstClosed := f.closeSettlement(t, 2, f.branch, nil)
	first := document("store-totals-key-01")
	first.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 2, UnitPrice: "10000.00"}}
	first.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 1, Kg: "12.400", PricePerKg: "1000.00"}}
	first.PaidCash, first.PaidTransfer = "32400.00", "0.00"
	created, err := f.store.Create(f.ctx, f.branch, first)
	if err != nil {
		t.Fatalf("the purchase must be admitted: %v", err)
	}
	closedID := f.closeSettlement(t, 2, f.branch, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "2"},
		{Kind: closings.MaterialKindScrap, MaterialID: 1, Quantity: "12.400"},
	})
	// A purchase after the closure belongs to no closed period: only the pending balance and the whole
	// history know about it.
	after := document("store-totals-key-02")
	after.UsedLines = []purchases.UsedLineInput{{Model: "NS60ZL", Quantity: 1, UnitPrice: "1000.00"}}
	after.ScrapLines = []purchases.ScrapLineInput{{MaterialID: 1, Kg: "3.000", PricePerKg: "1000.00"}}
	after.PaidCash, after.PaidTransfer = "4000.00", "0.00"
	latest, err := f.store.Create(f.ctx, f.branch, after)
	if err != nil {
		t.Fatalf("the purchase after the closure must be admitted: %v", err)
	}

	// The closed settlement states its own window: the purchase that happened inside it, with its
	// money (32400.00), its two batteries and its 12.400 kilos of copper.
	period := f.listingOf(t, purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: closedID})
	if period.Page.TotalPurchases != 1 || len(period.Page.Purchases) != 1 ||
		period.Page.Purchases[0].ID != created.ID {
		t.Fatalf("the closed period must list its own document: %+v", period.Page)
	}
	if period.Totals != (purchases.Totals{Money: "32400.00", UsedUnits: 2, ScrapKg: "12.400"}) {
		t.Fatalf("a closed period must state its own totals: %+v", period.Totals)
	}
	// The settlement that bought nothing states three zeros instead of the history.
	empty := f.listingOf(t, purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: firstClosed})
	if empty.Totals != (purchases.Totals{Money: "0.00", UsedUnits: 0, ScrapKg: "0.000"}) {
		t.Fatalf("an empty period must state three zeros: %+v", empty.Totals)
	}
	// The whole history states every document of the branch.
	history := f.listingOf(t, allHistory)
	if history.Totals != (purchases.Totals{Money: "36400.00", UsedUnits: 3, ScrapKg: "15.400"}) {
		t.Fatalf("the whole history must state every document: %+v", history.Totals)
	}
	if history.Page.TotalPurchases != 2 || len(history.Page.Purchases) != 2 {
		t.Fatalf("the whole history must list every document: %+v", history.Page)
	}
	// The received route reads the same whole history, and the two answers agree row by row: the money
	// of the used rows plus the money of the scrap rows, their units and their kilos.
	received, err := f.store.Received(f.ctx, f.branch)
	if err != nil {
		t.Fatalf("the received totals must be readable: %v", err)
	}
	var cents, units, milli int64
	for _, row := range received.Used {
		if row.Model != "NS60ZL" {
			t.Fatalf("the received used row is not what the history states: %+v", row)
		}
		cents += moneyCentsOf(t, row.Value)
		units += row.Quantity
	}
	for _, row := range received.Scrap {
		if row.MaterialID != 1 {
			t.Fatalf("the received scrap row is not what the history states: %+v", row)
		}
		cents += moneyCentsOf(t, row.Value)
		milli += weightKgMilli(t, row.Kg)
	}
	if units != 3 || cents != 3_640_000 || milli != 15_400 {
		t.Fatalf("the received route disagrees with the history: %d units, %d cents, %d milli",
			units, cents, milli)
	}
	// And the listing of the same whole history states exactly those numbers, in its own formats.
	if history.Totals.Money != "36400.00" || history.Totals.UsedUnits != units ||
		weightKgMilli(t, history.Totals.ScrapKg) != milli {
		t.Fatalf("the listing must state the same history the received route reads: %+v", history.Totals)
	}

	// The pending period is not a window: it states what the branch still holds — one battery and three
	// kilos — and no money at all, because the money of a purchase already left the cash box (S4).
	balance := f.listingOf(t, pending)
	if balance.Balance == nil {
		t.Fatal("the pending period must publish the balance of the branch")
	}
	if balance.Totals != (purchases.Totals{UsedUnits: 1, ScrapKg: "3.000"}) || balance.Totals.Money != "" {
		t.Fatalf("the pending period must state the balance and no money: %+v", balance.Totals)
	}

	// A counter-document subtracts from both readings (S7): the whole history falls back to the closed
	// period and the balance returns to zero, while every document stays listed.
	if _, err := f.store.Reverse(f.ctx, f.branch, latest.ID, "store-totals-key-03", "pesaje mal tipeado"); err != nil {
		t.Fatalf("the purchase after the closure must be reversible: %v", err)
	}
	if history = f.listingOf(t, allHistory); history.Totals !=
		(purchases.Totals{Money: "32400.00", UsedUnits: 2, ScrapKg: "12.400"}) {
		t.Fatalf("a counter-document must subtract from the totals: %+v", history.Totals)
	}
	if history.Page.TotalPurchases != 3 || len(history.Page.Purchases) != 3 {
		t.Fatalf("a counter-document must stay listed: %+v", history.Page)
	}
	balance = f.listingOf(t, pending)
	if balance.Totals != (purchases.Totals{UsedUnits: 0, ScrapKg: "0.000"}) {
		t.Fatalf("a delivered branch must read zero: %+v", balance.Totals)
	}
}

// moneyCentsOf reads one canonical amount of the contract as integer cents.
func moneyCentsOf(t *testing.T, amount purchases.Money) int64 {
	t.Helper()
	whole, fraction, ok := strings.Cut(string(amount), ".")
	if !ok || len(fraction) != 2 {
		t.Fatalf("a published amount is not canonical: %q", amount)
	}
	value, err := strconv.ParseInt(whole+fraction, 10, 64)
	if err != nil {
		t.Fatalf("a published amount is not a number: %q", amount)
	}
	return value
}

// weightKgMilli reads one canonical weight of the contract as integer thousandths.
func weightKgMilli(t *testing.T, weight purchases.Weight) int64 {
	t.Helper()
	text := string(weight)
	whole, fraction, ok := strings.Cut(text, ".")
	if !ok || len(fraction) != 3 {
		t.Fatalf("a published weight is not canonical: %q", text)
	}
	value, err := strconv.ParseInt(whole+fraction, 10, 64)
	if err != nil {
		t.Fatalf("a published weight is not a number: %q", text)
	}
	return value
}
