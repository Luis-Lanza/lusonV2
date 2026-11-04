package stockentries_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
)

// fixture provisions the isolated database exactly like the transfer stores do.
// Without an admitted LUSON_TEST_PG_MANIFEST every database test below fails
// closed at testpg.Open and that is the expected local outcome.
func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *stockentries.Store) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	return ctx, p, stockentries.New(p)
}

func warehouse() auth.Identity {
	return auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
}

func branch() auth.Identity {
	return auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}
}

func input(key string, lines ...stockentries.Line) stockentries.CreateInput {
	return stockentries.CreateInput{OperationKey: key, Note: "compra de proveedor", Lines: lines}
}

// snapshot captures every table this domain owns, so a rejected document is
// proven to leave nothing behind.
func snapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var data string
	err := p.QueryRow(ctx, `SELECT jsonb_build_object(
  'entries',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM stock_entries e),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.entry_id,l.variant_id),'[]'::jsonb) FROM stock_entry_lines l),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("stock snapshot failed")
	}
	return data
}

func balances(t *testing.T, ctx context.Context, p *pgxpool.Pool, location, variant int) (int64, int64) {
	t.Helper()
	var existing, reserved int64
	if p.QueryRow(ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=$1 AND variant_id=$2", location, variant).Scan(&existing, &reserved) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

func scalar(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if p.QueryRow(ctx, query, args...).Scan(&n) != nil {
		t.Fatal("scalar query failed")
	}
	return n
}

// reverse persists a counter-entry exactly like a later correction screen would,
// inside one transaction because its completeness check runs at commit.
func reverse(t *testing.T, ctx context.Context, p *pgxpool.Pool, original int64, key, reason string, lines ...stockentries.Line) error {
	t.Helper()
	tx, err := p.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal("reversal transaction failed")
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO stock_entries(operation_key,location_id,note,reverses_entry_id,reason,created_by_account_id)
 VALUES($1,1,'',$2,$3,1) RETURNING id`, key, original, reason).Scan(&id); err != nil {
		return err
	}
	for _, line := range lines {
		if _, err := tx.Exec(ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func sqlState(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}

func TestStoreGuards(t *testing.T) {
	if _, _, err := stockentries.New(nil).CreateEntry(context.Background(), warehouse(), input("guard-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 1})); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("unavailable pool must fail closed")
	}
	if _, _, err := stockentries.New(nil).CreateEntry(nil, warehouse(), input("guard-key-0000000002", stockentries.Line{VariantID: 1, Quantity: 1})); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("missing context must fail closed")
	}
	var nilStore *stockentries.Store
	if _, _, err := nilStore.CreateEntry(context.Background(), warehouse(), input("guard-key-0000000003", stockentries.Line{VariantID: 1, Quantity: 1})); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("nil store must fail closed")
	}
	if _, err := stockentries.New(nil).ListEntries(context.Background(), warehouse(), 1, 25); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("unavailable pool must fail the history read closed")
	}
	if _, err := stockentries.New(nil).ListEntries(nil, warehouse(), 1, 25); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("missing context must fail the history read closed")
	}
	if _, err := nilStore.ListEntries(context.Background(), warehouse(), 1, 25); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("nil store must fail the history read closed")
	}
}

func listWarehouse(t *testing.T, ctx context.Context, s *stockentries.Store, page, pageSize int) stockentries.EntryPage {
	t.Helper()
	result, err := s.ListEntries(ctx, warehouse(), page, pageSize)
	if err != nil {
		t.Fatal("warehouse history read failed")
	}
	return result
}

func TestListEntriesNewestFirst(t *testing.T) {
	ctx, _, s := fixture(t)
	empty := listWarehouse(t, ctx, s, 1, 25)
	if empty.Page != 1 || empty.PageSize != 25 || empty.TotalEntries != 0 || len(empty.Entries) != 0 {
		t.Fatal("an empty history must report one empty page")
	}
	ids := make([]int64, 0, 3)
	for i, in := range []stockentries.CreateInput{
		input("history-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 3}),
		{OperationKey: "history-key-0000000002", Note: "Remito 0002-00045871", Lines: []stockentries.Line{{VariantID: 2, Quantity: 14}, {VariantID: 1, Quantity: 4}}},
		{OperationKey: "history-key-0000000003", Lines: []stockentries.Line{{VariantID: 3, Quantity: 1}}},
	} {
		entry, _, err := s.CreateEntry(ctx, warehouse(), in)
		if err != nil {
			t.Fatalf("document %d was not created", i)
		}
		ids = append(ids, entry.ID)
	}
	page := listWarehouse(t, ctx, s, 1, 25)
	if page.TotalEntries != 3 || len(page.Entries) != 3 {
		t.Fatal("every persisted document must be listed once")
	}
	if page.Entries[0].ID != ids[2] || page.Entries[1].ID != ids[1] || page.Entries[2].ID != ids[0] {
		t.Fatal("history must be ordered newest first")
	}
	second := page.Entries[1]
	if second.Note != "Remito 0002-00045871" || second.Lines != 2 || second.TotalUnits != 18 ||
		second.ReversedBy != nil || second.CreatedAt.IsZero() {
		t.Fatal("summary does not match the persisted document")
	}
	if page.Entries[0].Note != "" || page.Entries[0].Lines != 1 || page.Entries[0].TotalUnits != 1 {
		t.Fatal("an empty note and a single line must be summarized exactly")
	}
}

func TestListEntriesPagination(t *testing.T) {
	ctx, _, s := fixture(t)
	ids := make([]int64, 0, 12)
	for i := 1; i <= 12; i++ {
		entry, _, err := s.CreateEntry(ctx, warehouse(), input(fmt.Sprintf("page-key-%016d", i), stockentries.Line{VariantID: 1, Quantity: 1}))
		if err != nil {
			t.Fatalf("document %d was not created", i)
		}
		ids = append(ids, entry.ID)
	}
	first := listWarehouse(t, ctx, s, 1, 10)
	if first.Page != 1 || first.PageSize != 10 || first.TotalEntries != 12 || len(first.Entries) != 10 {
		t.Fatal("the first page must hold ten of twelve documents")
	}
	if first.Entries[0].ID != ids[11] || first.Entries[9].ID != ids[2] {
		t.Fatal("the first page must hold the ten newest documents")
	}
	second := listWarehouse(t, ctx, s, 2, 10)
	if second.Page != 2 || second.TotalEntries != 12 || len(second.Entries) != 2 {
		t.Fatal("the second page must hold the two oldest documents")
	}
	if second.Entries[0].ID != ids[1] || second.Entries[1].ID != ids[0] {
		t.Fatal("the last page must continue the newest-first order")
	}
	beyond := listWarehouse(t, ctx, s, 3, 10)
	if len(beyond.Entries) != 0 || beyond.TotalEntries != 12 || beyond.Page != 3 {
		t.Fatal("a page beyond the last one must be empty and keep the total")
	}
	all := listWarehouse(t, ctx, s, 1, 25)
	if len(all.Entries) != 12 || all.PageSize != 25 || all.TotalEntries != 12 {
		t.Fatal("every document must fit on one page of twenty-five")
	}
}

func TestListEntriesReversedBy(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("history-reversal-key-01",
		stockentries.Line{VariantID: 1, Quantity: 2}, stockentries.Line{VariantID: 2, Quantity: 3}))
	if err != nil {
		t.Fatal("original document was not created")
	}
	if err := reverse(t, ctx, p, entry.ID, "history-counter-00000001", "error de carga",
		stockentries.Line{VariantID: 1, Quantity: -2}, stockentries.Line{VariantID: 2, Quantity: -3}); err != nil {
		t.Fatalf("counter-entry was not created: %v", sqlState(err))
	}
	var counterID int64
	if p.QueryRow(ctx, "SELECT id FROM stock_entries WHERE reverses_entry_id=$1", entry.ID).Scan(&counterID) != nil {
		t.Fatal("counter-entry read failed")
	}
	page := listWarehouse(t, ctx, s, 1, 25)
	if page.TotalEntries != 2 || len(page.Entries) != 2 {
		t.Fatal("the original document and its counter-entry must both be listed")
	}
	counter := page.Entries[0]
	if counter.ID != counterID || counter.Lines != 2 || counter.TotalUnits != -5 || counter.ReversedBy != nil {
		t.Fatal("the counter-entry must be listed with its own negative total")
	}
	original := page.Entries[1]
	if original.ID != entry.ID || original.TotalUnits != 5 || original.ReversedBy == nil || *original.ReversedBy != counterID {
		t.Fatal("a reversed document must expose its counter-entry and keep its total")
	}
}

func TestListEntriesRejectsInvalidQueryBeforeSQL(t *testing.T) {
	ctx, p, _ := fixture(t)
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	s := stockentries.New(dead)
	for name, query := range map[string][2]int{
		"zero_page":         {0, 25},
		"negative_page":     {-1, 10},
		"page_above_bound":  {1000001, 25},
		"zero_size":         {1, 0},
		"size_not_admitted": {1, 15},
		"size_above_bound":  {1, 100},
		"negative_size":     {1, -25},
	} {
		if _, err := s.ListEntries(ctx, warehouse(), query[0], query[1]); !errors.Is(err, stockentries.ErrInvalid) {
			t.Fatalf("%s must be refused before the database", name)
		}
	}
	// The same closed pool proves a valid query does reach the database.
	if _, err := s.ListEntries(ctx, warehouse(), 1, 25); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("a valid query must reach the database and fail closed")
	}
	for _, valid := range [][2]int{{1, 10}, {1, 25}, {1, 50}, {1000000, 25}} {
		if !stockentries.ValidPage(valid[0], valid[1]) {
			t.Fatal("an admitted page was refused")
		}
	}
	for _, invalid := range [][2]int{{1000001, 25}, {1, 20}, {0, 25}} {
		if stockentries.ValidPage(invalid[0], invalid[1]) {
			t.Fatal("a page outside the contract was admitted")
		}
	}
}

func TestListEntriesActorBoundary(t *testing.T) {
	ctx, p, s := fixture(t)
	before := snapshot(t, ctx, p)
	pending := warehouse()
	pending.MustChangePassword = true
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"warehouse_label": {AccountID: 1, Location: auth.Location{ID: 2}},
		"clerk":           {AccountID: 2, Location: auth.Location{ID: 1}},
		"unassigned":      {},
		"password_change": pending,
	} {
		if _, err := s.ListEntries(ctx, actor, 1, 25); !errors.Is(err, stockentries.ErrForbidden) {
			t.Fatalf("%s must be forbidden", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a forbidden history read must not change any stored value")
	}
}

func TestCreateEntryAppliesBalance(t *testing.T) {
	ctx, p, s := fixture(t)
	existingOne, reservedOne := balances(t, ctx, p, 1, 1)
	existingTwo, reservedTwo := balances(t, ctx, p, 1, 2)
	entry, replayed, err := s.CreateEntry(ctx, warehouse(), input("ingress-key-0000000001",
		stockentries.Line{VariantID: 2, Quantity: 2}, stockentries.Line{VariantID: 1, Quantity: 3}))
	if err != nil || replayed {
		t.Fatal("warehouse ingress was not created")
	}
	if entry.ID <= 0 || entry.LocationID != 1 || entry.CreatedByAccountID != 1 ||
		entry.Note != "compra de proveedor" || entry.TotalUnits != 5 || len(entry.Lines) != 2 ||
		entry.Lines[0].VariantID != 1 || entry.Lines[0].Quantity != 3 ||
		entry.Lines[1].VariantID != 2 || entry.Lines[1].Quantity != 2 || entry.CreatedAt.IsZero() {
		t.Fatal("persisted document does not match the frozen contract")
	}
	if got, reserved := balances(t, ctx, p, 1, 1); got != existingOne+3 || reserved != reservedOne {
		t.Fatal("ingress must add to existing and never touch reserved")
	}
	if got, reserved := balances(t, ctx, p, 1, 2); got != existingTwo+2 || reserved != reservedTwo {
		t.Fatal("second line was not applied")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries"); n != 1 {
		t.Fatal("exactly one document must be persisted")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entry_lines WHERE entry_id=$1", entry.ID); n != 2 {
		t.Fatal("both lines must be persisted")
	}
}

func TestCreateEntryReplayIsIdempotent(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input("replay-key-0000000001", stockentries.Line{VariantID: 3, Quantity: 4}, stockentries.Line{VariantID: 1, Quantity: 2})
	first, replayed, err := s.CreateEntry(ctx, warehouse(), in)
	if err != nil || replayed {
		t.Fatal("first ingress failed")
	}
	before := snapshot(t, ctx, p)
	reordered := input(in.OperationKey, in.Lines[1], in.Lines[0])
	second, replayed, err := s.CreateEntry(ctx, warehouse(), reordered)
	if err != nil || !replayed {
		t.Fatal("identical replay must be a replay")
	}
	if second.ID != first.ID || second.TotalUnits != first.TotalUnits || len(second.Lines) != len(first.Lines) {
		t.Fatal("replay must return the persisted document")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("replay must not change any stored value")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries"); n != 1 {
		t.Fatal("replay must not create a second document")
	}
}

func TestCreateEntryReplayConflict(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input("conflict-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 2})
	if _, _, err := s.CreateEntry(ctx, warehouse(), in); err != nil {
		t.Fatal("first ingress failed")
	}
	before := snapshot(t, ctx, p)
	for name, changed := range map[string]stockentries.CreateInput{
		"note":     {OperationKey: in.OperationKey, Note: "otra nota", Lines: in.Lines},
		"quantity": input(in.OperationKey, stockentries.Line{VariantID: 1, Quantity: 3}),
		"variant":  input(in.OperationKey, stockentries.Line{VariantID: 2, Quantity: 2}),
		"extra":    input(in.OperationKey, stockentries.Line{VariantID: 1, Quantity: 2}, stockentries.Line{VariantID: 2, Quantity: 1}),
	} {
		if _, _, err := s.CreateEntry(ctx, warehouse(), changed); !errors.Is(err, stockentries.ErrRetryConflict) {
			t.Fatalf("%s conflict was not reported as a retry conflict", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a conflicting replay must not change any stored value")
	}
}

func TestCreateEntryActorBoundary(t *testing.T) {
	ctx, p, s := fixture(t)
	before := snapshot(t, ctx, p)
	pending := warehouse()
	pending.MustChangePassword = true
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"warehouse_label": {AccountID: 1, Location: auth.Location{ID: 2}},
		"clerk":           {AccountID: 2, Location: auth.Location{ID: 1}},
		"unassigned":      {},
		"password_change": pending,
	} {
		if _, _, err := s.CreateEntry(ctx, actor, input("forbidden-key-00000001", stockentries.Line{VariantID: 1, Quantity: 1})); !errors.Is(err, stockentries.ErrForbidden) {
			t.Fatalf("%s must be forbidden", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a forbidden actor must not change any stored value")
	}
}

func TestCreateEntryRejectsInvalidWithoutWriting(t *testing.T) {
	ctx, p, s := fixture(t)
	before := snapshot(t, ctx, p)
	for name, in := range map[string]stockentries.CreateInput{
		"empty_lines":  input("invalid-key-0000000001"),
		"short_key":    {OperationKey: "short", Lines: []stockentries.Line{{VariantID: 1, Quantity: 1}}},
		"zero_qty":     input("invalid-key-0000000002", stockentries.Line{VariantID: 1, Quantity: 0}),
		"negative_qty": input("invalid-key-0000000003", stockentries.Line{VariantID: 1, Quantity: -1}),
		"duplicate":    input("invalid-key-0000000004", stockentries.Line{VariantID: 1, Quantity: 1}, stockentries.Line{VariantID: 1, Quantity: 2}),
		"long_note":    {OperationKey: "invalid-key-0000000005", Note: strings.Repeat("a", 501), Lines: []stockentries.Line{{VariantID: 1, Quantity: 1}}},
	} {
		if _, _, err := s.CreateEntry(ctx, warehouse(), in); !errors.Is(err, stockentries.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an invalid document must not change any stored value")
	}
}

func TestReversalRestoresBalances(t *testing.T) {
	ctx, p, s := fixture(t)
	existingOne, _ := balances(t, ctx, p, 1, 1)
	existingTwo, _ := balances(t, ctx, p, 1, 2)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("reversal-key-000000001",
		stockentries.Line{VariantID: 1, Quantity: 3}, stockentries.Line{VariantID: 2, Quantity: 2}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	err = reverse(t, ctx, p, entry.ID, "reversal-counter-000001", "error de carga",
		stockentries.Line{VariantID: 1, Quantity: -3}, stockentries.Line{VariantID: 2, Quantity: -2})
	if err != nil {
		t.Fatalf("reversal of a normal document failed: %v", sqlState(err))
	}
	if got, _ := balances(t, ctx, p, 1, 1); got != existingOne {
		t.Fatal("reversal must restore the original quantity")
	}
	if got, _ := balances(t, ctx, p, 1, 2); got != existingTwo {
		t.Fatal("reversal must restore every line")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries"); n != 2 {
		t.Fatal("the original document and its counter-entry must both stay visible")
	}
	// The original document is unchanged by its counter-entry.
	var note string
	if p.QueryRow(ctx, "SELECT note FROM stock_entries WHERE id=$1", entry.ID).Scan(&note) != nil || note != entry.Note {
		t.Fatal("the original document must not change")
	}
}

func TestReversalRejectedBelowReserved(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("reserved-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 3}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET reserved=existing WHERE location_id=1 AND variant_id=1"); err != nil {
		t.Fatal("hold setup failed")
	}
	before := snapshot(t, ctx, p)
	err = reverse(t, ctx, p, entry.ID, "reserved-counter-000001", "devolucion",
		stockentries.Line{VariantID: 1, Quantity: -3})
	if sqlState(err) != "LS001" {
		t.Fatalf("reversal below reserved must be rejected by the database: %v", sqlState(err))
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a rejected reversal must not change any stored value")
	}
}

func TestReversalOfReversalRejected(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("double-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 2}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	if err := reverse(t, ctx, p, entry.ID, "double-counter-0000001", "error de carga",
		stockentries.Line{VariantID: 1, Quantity: -2}); err != nil {
		t.Fatal("first reversal failed")
	}
	var reversalID int64
	if p.QueryRow(ctx, "SELECT id FROM stock_entries WHERE reverses_entry_id=$1", entry.ID).Scan(&reversalID) != nil {
		t.Fatal("reversal document was not persisted")
	}
	before := snapshot(t, ctx, p)
	err = reverse(t, ctx, p, reversalID, "double-counter-0000002", "error sobre error",
		stockentries.Line{VariantID: 1, Quantity: 2})
	if sqlState(err) != "LS006" {
		t.Fatalf("a reversal of a reversal must be rejected: %v", sqlState(err))
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a rejected reversal of a reversal must not change any stored value")
	}
}

func TestReversalMustMirrorOriginal(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("mirror-key-0000000001",
		stockentries.Line{VariantID: 1, Quantity: 3}, stockentries.Line{VariantID: 2, Quantity: 2}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	before := snapshot(t, ctx, p)
	cases := []struct {
		name  string
		state string
		lines []stockentries.Line
	}{
		{"wrong_sign", "LS002", []stockentries.Line{{VariantID: 1, Quantity: 3}}},
		{"wrong_quantity", "LS002", []stockentries.Line{{VariantID: 1, Quantity: -2}, {VariantID: 2, Quantity: -2}}},
		{"absent_line", "LS002", []stockentries.Line{{VariantID: 1, Quantity: -3}, {VariantID: 3, Quantity: -1}}},
		{"partial", "LS003", []stockentries.Line{{VariantID: 1, Quantity: -3}}},
	}
	for i, tc := range cases {
		err := reverse(t, ctx, p, entry.ID, fmt.Sprintf("mirror-counter-%d-000001", i), "correccion", tc.lines...)
		if sqlState(err) != tc.state {
			t.Fatalf("%s must be rejected with %s, got %v", tc.name, tc.state, sqlState(err))
		}
		if snapshot(t, ctx, p) != before {
			t.Fatalf("%s must not change any stored value", tc.name)
		}
	}
}

func TestIngressOverflowRejected(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=1 AND variant_id=1"); err != nil {
		t.Fatal("overflow setup failed")
	}
	before := snapshot(t, ctx, p)
	_, _, err := s.CreateEntry(ctx, warehouse(), input("overflow-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 1}))
	if !errors.Is(err, stockentries.ErrInvalid) {
		t.Fatal("an overflowing document must be invalid")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an overflowing document must not change any stored value")
	}
}

func TestStockEntriesAreAppendOnly(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("append-only-key-000001", stockentries.Line{VariantID: 1, Quantity: 1}))
	if err != nil {
		t.Fatal("ingress for the append-only check failed")
	}
	before := snapshot(t, ctx, p)
	for name, statement := range map[string]string{
		"update_entry": "UPDATE stock_entries SET note='reescrito' WHERE id=$1",
		"delete_entry": "DELETE FROM stock_entries WHERE id=$1",
		"update_line":  "UPDATE stock_entry_lines SET quantity=5 WHERE entry_id=$1",
		"delete_line":  "DELETE FROM stock_entry_lines WHERE entry_id=$1",
	} {
		if _, err := p.Exec(ctx, statement, entry.ID); err == nil {
			t.Fatalf("%s must be rejected by the append-only guard", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("append-only documents must not change")
	}
}

// originalRows returns the persisted bytes of one document, so a counter-entry
// can be proven to leave the original untouched.
func originalRows(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) string {
	t.Helper()
	var data string
	err := p.QueryRow(ctx, `SELECT jsonb_build_object(
  'header',(SELECT to_jsonb(e) FROM stock_entries e WHERE e.id=$1),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.variant_id),'[]'::jsonb) FROM stock_entry_lines l WHERE l.entry_id=$1))::text`, id).Scan(&data)
	if err != nil {
		t.Fatal("original document read failed")
	}
	return data
}

// counterOf is the persisted counter-entry of one original document.
func counterOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, original int64) (id int64, reason string) {
	t.Helper()
	if p.QueryRow(ctx, "SELECT id,reason FROM stock_entries WHERE reverses_entry_id=$1", original).Scan(&id, &reason) != nil {
		t.Fatal("counter-entry read failed")
	}
	return id, reason
}

func TestCanonicalReason(t *testing.T) {
	for name, tc := range map[string]struct {
		reason string
		want   string
		ok     bool
	}{
		"exact":         {"error de carga", "error de carga", true},
		"padded":        {"  error de carga \n", "error de carga", true},
		"unicode":       {"ñandú descargado dos veces", "ñandú descargado dos veces", true},
		"bound":         {strings.Repeat("ñ", 500), strings.Repeat("ñ", 500), true},
		"empty":         {"", "", false},
		"spaces":        {"   \t\n", "", false},
		"too_long":      {strings.Repeat("ñ", 501), "", false},
		"nul":           {"error\x00de carga", "", false},
		"invalid_utf8":  {"error-\xff", "", false},
		"kept_inner":    {"cuenta   mal", "cuenta   mal", true},
		"no_trim_ascii": {"\u00a0motivo\u00a0", "motivo", true},
	} {
		t.Run(name, func(t *testing.T) {
			got, ok := stockentries.CanonicalReason(tc.reason)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("canonical reason mismatch: %q %v", got, ok)
			}
		})
	}
}

func TestReverseEntryGuards(t *testing.T) {
	if _, _, err := stockentries.New(nil).ReverseEntry(context.Background(), warehouse(), 1, "guard-reverse-key-0001", "motivo"); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("unavailable pool must fail the reversal closed")
	}
	if _, _, err := stockentries.New(nil).ReverseEntry(nil, warehouse(), 1, "guard-reverse-key-0002", "motivo"); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("missing context must fail the reversal closed")
	}
	var nilStore *stockentries.Store
	if _, _, err := nilStore.ReverseEntry(context.Background(), warehouse(), 1, "guard-reverse-key-0003", "motivo"); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("nil store must fail the reversal closed")
	}
}

func TestReverseEntryDerivesAndRestores(t *testing.T) {
	ctx, p, s := fixture(t)
	existingOne, reservedOne := balances(t, ctx, p, 1, 1)
	existingTwo, reservedTwo := balances(t, ctx, p, 1, 2)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("derive-key-0000000001",
		stockentries.Line{VariantID: 2, Quantity: 4}, stockentries.Line{VariantID: 1, Quantity: 3}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	before := originalRows(t, ctx, p, original.ID)
	counter, replayed, err := s.ReverseEntry(ctx, warehouse(), original.ID, "derive-counter-key-0001", "  error de carga  ")
	if err != nil || replayed {
		t.Fatalf("reversal was not created: %v", err)
	}
	if counter.ID <= original.ID || counter.LocationID != 1 || counter.CreatedByAccountID != 1 ||
		counter.Note != "" || counter.CreatedAt.IsZero() || counter.ReversesEntryID == nil ||
		*counter.ReversesEntryID != original.ID {
		t.Fatal("counter-entry header does not match the frozen contract")
	}
	// The derived lines are exactly the negation of the original ones.
	if len(counter.Lines) != len(original.Lines) || counter.TotalUnits != -original.TotalUnits {
		t.Fatal("counter-entry does not mirror the original document")
	}
	for i, line := range original.Lines {
		if counter.Lines[i].VariantID != line.VariantID || counter.Lines[i].Quantity != -line.Quantity {
			t.Fatal("counter-entry line is not the exact negation of the original line")
		}
	}
	if got, reserved := balances(t, ctx, p, 1, 1); got != existingOne || reserved != reservedOne {
		t.Fatal("reversal must restore the first line")
	}
	if got, reserved := balances(t, ctx, p, 1, 2); got != existingTwo || reserved != reservedTwo {
		t.Fatal("reversal must restore the second line")
	}
	storedID, reason := counterOf(t, ctx, p, original.ID)
	if storedID != counter.ID || reason != "error de carga" {
		t.Fatal("the trimmed reason must be persisted verbatim")
	}
	if originalRows(t, ctx, p, original.ID) != before {
		t.Fatal("the original document must not change")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries"); n != 2 {
		t.Fatal("the original and its counter-entry must both stay visible")
	}
}

func TestReverseEntryReplayIsIdempotent(t *testing.T) {
	ctx, p, s := fixture(t)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("reverse-replay-key-0001", stockentries.Line{VariantID: 1, Quantity: 2}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	first, replayed, err := s.ReverseEntry(ctx, warehouse(), original.ID, "reverse-replay-counter-1", "error de carga")
	if err != nil || replayed {
		t.Fatal("first reversal failed")
	}
	before := snapshot(t, ctx, p)
	second, replayed, err := s.ReverseEntry(ctx, warehouse(), original.ID, "reverse-replay-counter-1", " error de carga ")
	if err != nil || !replayed {
		t.Fatal("an identical reversal replay must be a replay")
	}
	if second.ID != first.ID || second.TotalUnits != first.TotalUnits || len(second.Lines) != len(first.Lines) {
		t.Fatal("replay must return the persisted counter-entry")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a reversal replay must not change any stored value")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries"); n != 2 {
		t.Fatal("a reversal replay must not create a second counter-entry")
	}
}

func TestReverseEntryReplayConflict(t *testing.T) {
	ctx, p, s := fixture(t)
	first, _, err := s.CreateEntry(ctx, warehouse(), input("reverse-conflict-key-01", stockentries.Line{VariantID: 1, Quantity: 2}))
	if err != nil {
		t.Fatal("first ingress failed")
	}
	second, _, err := s.CreateEntry(ctx, warehouse(), input("reverse-conflict-key-02", stockentries.Line{VariantID: 1, Quantity: 5}))
	if err != nil {
		t.Fatal("second ingress failed")
	}
	if _, _, err := s.ReverseEntry(ctx, warehouse(), first.ID, "reverse-conflict-counter1", "error de carga"); err != nil {
		t.Fatal("first reversal failed")
	}
	before := snapshot(t, ctx, p)
	for name, call := range map[string]struct {
		target int64
		key    string
		reason string
	}{
		"another_reason": {first.ID, "reverse-conflict-counter1", "otro motivo"},
		"another_target": {second.ID, "reverse-conflict-counter1", "error de carga"},
		// A creation key is not a reversal key, even for the same document.
		"creation_key": {second.ID, "reverse-conflict-key-02", "error de carga"},
	} {
		if _, _, err := s.ReverseEntry(ctx, warehouse(), call.target, call.key, call.reason); !errors.Is(err, stockentries.ErrRetryConflict) {
			t.Fatalf("%s conflict was not reported as a retry conflict", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a conflicting reversal must not change any stored value")
	}
}

func TestReverseEntryRefusesInadmissibleTarget(t *testing.T) {
	ctx, p, s := fixture(t)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("target-key-0000000001", stockentries.Line{VariantID: 1, Quantity: 2}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	for name, target := range map[string]int64{"zero": 0, "negative": -1, "missing": math.MaxInt64} {
		if _, _, err := s.ReverseEntry(ctx, warehouse(), target, "target-counter-key-0001", "error de carga"); !errors.Is(err, stockentries.ErrNotFound) {
			t.Fatalf("%s target must be not found", name)
		}
	}
	counter, _, err := s.ReverseEntry(ctx, warehouse(), original.ID, "target-counter-key-0002", "error de carga")
	if err != nil {
		t.Fatal("reversal failed")
	}
	before := snapshot(t, ctx, p)
	// The original already has a counter-entry and the counter-entry is itself a
	// reversal: neither can be reversed again.
	if _, _, err := s.ReverseEntry(ctx, warehouse(), original.ID, "target-counter-key-0003", "error de carga"); !errors.Is(err, stockentries.ErrDecisionConflict) {
		t.Fatal("an already reversed document must be a decision conflict")
	}
	if _, _, err := s.ReverseEntry(ctx, warehouse(), counter.ID, "target-counter-key-0004", "error de carga"); !errors.Is(err, stockentries.ErrDecisionConflict) {
		t.Fatal("a reversal of a reversal must be a decision conflict")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused target must not change any stored value")
	}
}

func TestReverseEntryRejectsUncoveredStock(t *testing.T) {
	ctx, p, s := fixture(t)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("uncovered-key-00000001",
		stockentries.Line{VariantID: 1, Quantity: 3}, stockentries.Line{VariantID: 2, Quantity: 2}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	// The stock of the second line was consumed after the ingress.
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=reserved WHERE location_id=1 AND variant_id=2"); err != nil {
		t.Fatal("consumption setup failed")
	}
	before := snapshot(t, ctx, p)
	beforeOriginal := originalRows(t, ctx, p, original.ID)
	if _, _, err := s.ReverseEntry(ctx, warehouse(), original.ID, "uncovered-counter-key-01", "devolucion"); !errors.Is(err, stockentries.ErrInsufficientStock) {
		t.Fatal("a reversal that would leave existing below reserved must be insufficient stock")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("the whole reversal must be rejected without a partial write")
	}
	if originalRows(t, ctx, p, original.ID) != beforeOriginal {
		t.Fatal("a rejected reversal must not change the original document")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_entries WHERE reverses_entry_id=$1", original.ID); n != 0 {
		t.Fatal("a rejected reversal must not persist a counter-entry")
	}
}

func TestReverseEntryActorBoundary(t *testing.T) {
	ctx, p, s := fixture(t)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("reverse-actor-key-0001", stockentries.Line{VariantID: 1, Quantity: 1}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	before := snapshot(t, ctx, p)
	pending := warehouse()
	pending.MustChangePassword = true
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"warehouse_label": {AccountID: 1, Location: auth.Location{ID: 2}},
		"clerk":           {AccountID: 2, Location: auth.Location{ID: 1}},
		"unassigned":      {},
		"password_change": pending,
	} {
		if _, _, err := s.ReverseEntry(ctx, actor, original.ID, "reverse-actor-counter-1", "error de carga"); !errors.Is(err, stockentries.ErrForbidden) {
			t.Fatalf("%s must be forbidden", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a forbidden actor must not change any stored value")
	}
}

func TestReverseEntryRejectsInvalidInputWithoutWriting(t *testing.T) {
	ctx, p, s := fixture(t)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("reverse-invalid-key-001", stockentries.Line{VariantID: 1, Quantity: 1}))
	if err != nil {
		t.Fatal("ingress before reversal failed")
	}
	before := snapshot(t, ctx, p)
	for name, call := range map[string]struct {
		key    string
		reason string
	}{
		"empty_reason":   {"reverse-invalid-counter1", ""},
		"blank_reason":   {"reverse-invalid-counter2", "   \t\n"},
		"long_reason":    {"reverse-invalid-counter3", strings.Repeat("ñ", 501)},
		"nul_reason":     {"reverse-invalid-counter4", "error\x00de carga"},
		"invalid_utf8":   {"reverse-invalid-counter5", "error-\xff"},
		"short_key":      {"short", "error de carga"},
		"key_with_space": {"reverse invalid counter", "error de carga"},
		"key_over_128":   {strings.Repeat("a", 129), "error de carga"},
	} {
		if _, _, err := s.ReverseEntry(ctx, warehouse(), original.ID, call.key, call.reason); !errors.Is(err, stockentries.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an invalid reversal must not change any stored value")
	}
}

// readDetail is the warehouse detail read of one persisted document.
func readDetail(t *testing.T, ctx context.Context, s *stockentries.Store, id int64) stockentries.EntryDetail {
	t.Helper()
	detail, err := s.ReadEntry(ctx, warehouse(), id)
	if err != nil {
		t.Fatalf("document detail read failed: %v", err)
	}
	return detail
}

// catalogueOf is the catalogue identity of one variant as the inventory read
// exposes it: brand, model, capacity normalized from the numeric column and the
// polarity of the variant itself.
func catalogueOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant int64) (brand, model string, capacity catalog.Decimal, polarity string) {
	t.Helper()
	var raw string
	err := p.QueryRow(ctx, `SELECT e.brand,e.model,e.capacity_ah::text,v.polarity
 FROM catalog_variants v JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE v.id=$1`, int32(variant)).Scan(&brand, &model, &raw, &polarity)
	if err != nil {
		t.Fatal("catalogue identity read failed")
	}
	capacity, err = catalog.ParseDecimal(raw)
	if err != nil {
		t.Fatal("catalogue capacity is not a canonical decimal")
	}
	return brand, model, capacity, polarity
}

func TestReadEntryDetail(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), stockentries.CreateInput{
		OperationKey: "detail-key-000000000001", Note: "Remito 0002-00045871",
		Lines: []stockentries.Line{{VariantID: 9, Quantity: 15}, {VariantID: 4, Quantity: 3}},
	})
	if err != nil {
		t.Fatal("document for the detail read was not created")
	}
	detail := readDetail(t, ctx, s, entry.ID)
	if detail.ID != entry.ID || detail.LocationID != 1 || detail.CreatedByAccountID != 1 ||
		detail.Note != "Remito 0002-00045871" || detail.CreatedAt.IsZero() ||
		detail.ReversesEntryID != nil || detail.ReversedBy != nil || detail.Reason != "" {
		t.Fatal("detail header does not match the persisted document")
	}
	if len(detail.Lines) != 2 || detail.TotalUnits != 18 {
		t.Fatal("detail must carry every line and the exact signed total")
	}
	// Lines are ordered by variant id, never by insertion order.
	if detail.Lines[0].VariantID != 4 || detail.Lines[0].Quantity != 3 ||
		detail.Lines[1].VariantID != 9 || detail.Lines[1].Quantity != 15 {
		t.Fatal("detail lines are not the persisted variant-ordered lines")
	}
	for _, line := range detail.Lines {
		brand, model, capacity, polarity := catalogueOf(t, ctx, p, line.VariantID)
		if line.Brand != brand || line.Model != model || line.Capacity != capacity || line.Polarity != polarity {
			t.Fatalf("line %d does not carry its catalogue identity", line.VariantID)
		}
		if line.Brand == "" || line.Model == "" || (line.Polarity != "L" && line.Polarity != "R") {
			t.Fatalf("line %d has an incomplete catalogue identity", line.VariantID)
		}
	}
}

func TestReadEntryDetailCounterEntry(t *testing.T) {
	ctx, _, s := fixture(t)
	original, _, err := s.CreateEntry(ctx, warehouse(), input("detail-counter-key-0001",
		stockentries.Line{VariantID: 1, Quantity: 2}, stockentries.Line{VariantID: 2, Quantity: 3}))
	if err != nil {
		t.Fatal("original document was not created")
	}
	counter, _, err := s.ReverseEntry(ctx, warehouse(), original.ID, "detail-counter-key-0002", "error de carga")
	if err != nil {
		t.Fatal("counter-entry was not created")
	}
	reversed := readDetail(t, ctx, s, original.ID)
	if reversed.ReversesEntryID != nil || reversed.ReversedBy == nil || *reversed.ReversedBy != counter.ID ||
		reversed.Reason != "" || reversed.TotalUnits != 5 {
		t.Fatal("a reversed document must expose its counter-entry and keep its own header")
	}
	if len(reversed.Lines) != 2 || reversed.Lines[0].Quantity != 2 || reversed.Lines[1].Quantity != 3 {
		t.Fatal("a reversed document keeps its positive lines")
	}
	detail := readDetail(t, ctx, s, counter.ID)
	if detail.ReversesEntryID == nil || *detail.ReversesEntryID != original.ID || detail.ReversedBy != nil ||
		detail.Reason != "error de carga" || detail.Note != "" || detail.TotalUnits != -5 {
		t.Fatal("a counter-entry detail must expose its target and its motive")
	}
	if len(detail.Lines) != 2 || detail.Lines[0].VariantID != 1 || detail.Lines[0].Quantity != -2 ||
		detail.Lines[1].VariantID != 2 || detail.Lines[1].Quantity != -3 {
		t.Fatal("a counter-entry detail must carry the exact negative lines")
	}
	for _, line := range detail.Lines {
		if line.Brand == "" || line.Model == "" || line.Capacity == "" || (line.Polarity != "L" && line.Polarity != "R") {
			t.Fatalf("counter-entry line %d has no catalogue identity", line.VariantID)
		}
	}
}

// foreignDocument persists a document of another location. Only the database may
// refuse one in normal operation, so the isolated fixture writes it with the
// admission and balance triggers disabled, then re-enables them immediately.
func foreignDocument(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	disable := func() {
		for _, statement := range []string{
			"ALTER TABLE stock_entry_lines DISABLE TRIGGER USER",
			"ALTER TABLE stock_entries DISABLE TRIGGER USER",
		} {
			if _, err := p.Exec(ctx, statement); err != nil {
				t.Fatal("foreign document fixture setup failed")
			}
		}
	}
	enable := func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		for _, statement := range []string{
			"ALTER TABLE stock_entry_lines ENABLE TRIGGER USER",
			"ALTER TABLE stock_entries ENABLE TRIGGER USER",
		} {
			_, _ = p.Exec(cleanup, statement)
		}
	}
	disable()
	defer enable()
	t.Cleanup(enable)
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO stock_entries(operation_key,location_id,note,created_by_account_id)
 VALUES('foreign-detail-key-0001',2,'sucursal',1) RETURNING id`).Scan(&id); err != nil {
		t.Fatal("foreign document insert failed")
	}
	if _, err := p.Exec(ctx, "INSERT INTO stock_entry_lines(entry_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(1), int64(1)); err != nil {
		t.Fatal("foreign document line insert failed")
	}
	return id
}

func TestReadEntryDetailNotFound(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("detail-missing-key-0001", stockentries.Line{VariantID: 1, Quantity: 1}))
	if err != nil {
		t.Fatal("document for the detail read was not created")
	}
	foreign := foreignDocument(t, ctx, p)
	before := snapshot(t, ctx, p)
	for name, id := range map[string]int64{
		"unknown":  math.MaxInt64,
		"zero":     0,
		"negative": -1,
		"foreign":  foreign,
	} {
		if _, err := s.ReadEntry(ctx, warehouse(), id); !errors.Is(err, stockentries.ErrNotFound) {
			t.Fatalf("%s id must not be found", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a document outside this warehouse must not change any stored value")
	}
	// The warehouse document is still readable: only other locations are hidden.
	if detail := readDetail(t, ctx, s, entry.ID); detail.ID != entry.ID {
		t.Fatal("the warehouse detail read must keep answering its own documents")
	}
}

func TestReadEntryDetailActorBoundary(t *testing.T) {
	ctx, p, s := fixture(t)
	entry, _, err := s.CreateEntry(ctx, warehouse(), input("detail-actor-key-000001", stockentries.Line{VariantID: 1, Quantity: 1}))
	if err != nil {
		t.Fatal("document for the detail read was not created")
	}
	before := snapshot(t, ctx, p)
	pending := warehouse()
	pending.MustChangePassword = true
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"warehouse_label": {AccountID: 1, Location: auth.Location{ID: 2}},
		"clerk":           {AccountID: 2, Location: auth.Location{ID: 1}},
		"unassigned":      {},
		"password_change": pending,
	} {
		if _, err := s.ReadEntry(ctx, actor, entry.ID); !errors.Is(err, stockentries.ErrForbidden) {
			t.Fatalf("%s must be forbidden", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a forbidden detail read must not change any stored value")
	}
}

func TestReadEntryDetailGuards(t *testing.T) {
	ctx, p, _ := fixture(t)
	if _, err := stockentries.New(nil).ReadEntry(context.Background(), warehouse(), 1); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("unavailable pool must fail the detail read closed")
	}
	if _, err := stockentries.New(nil).ReadEntry(nil, warehouse(), 1); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("missing context must fail the detail read closed")
	}
	var nilStore *stockentries.Store
	if _, err := nilStore.ReadEntry(context.Background(), warehouse(), 1); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("nil store must fail the detail read closed")
	}
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	closed := stockentries.New(dead)
	// An inadmissible id is refused before the database, exactly like the reversal route.
	for _, id := range []int64{0, -1} {
		if _, err := closed.ReadEntry(ctx, warehouse(), id); !errors.Is(err, stockentries.ErrNotFound) {
			t.Fatal("an inadmissible id must not reach the database")
		}
	}
	// The same closed pool proves an admitted id does reach it and fails closed.
	if _, err := closed.ReadEntry(ctx, warehouse(), 1); !errors.Is(err, stockentries.ErrUnavailable) {
		t.Fatal("an admitted id must reach the database and fail closed")
	}
}
