package stockentries_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
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
