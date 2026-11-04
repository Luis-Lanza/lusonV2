package stockadjustments_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/stockadjustments"
)

// These probes drive migration 022 through the database itself, never through the
// store's validation: every guard is proven on the object it protects, with the
// database's own SQLSTATE as the only accepted evidence.

// sqlState is the refusal the database itself published, so a probe never depends
// on the text of a message.
func sqlState(t *testing.T, err error) string {
	t.Helper()
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		t.Fatalf("expected a database refusal, got %v", err)
	}
	return pg.Code
}

// commitScript runs one script inside a single transaction and returns the error
// of its commit, which is where a deferred constraint trigger decides.
func commitScript(ctx context.Context, p *pgxpool.Pool, script func(pgx.Tx) error) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := script(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// rawDocument persists one header through the database's own admission, so the
// probes below reach the guards instead of the store's request validation.
func rawDocument(ctx context.Context, tx pgx.Tx, key string, location int, reverses *int64) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO stock_adjustments(operation_key,location_id,reason,reverses_adjustment_id,created_by_account_id)
 VALUES($1,$2,'conteo físico',$3,1) RETURNING id`, key, location, reverses).Scan(&id)
	return id, err
}

// rawLine persists one counted line under the database's application trigger,
// which owns the expected snapshot and the applied difference.
func rawLine(ctx context.Context, tx pgx.Tx, adjustment, variant, expected, counted int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO stock_adjustment_lines(adjustment_id,variant_id,expected_quantity,counted_quantity)
 VALUES($1,$2,$3,$4)`, adjustment, int32(variant), expected, counted)
	return err
}

// inventoryRevision is the internal realtime counter migration 004 owns.
func inventoryRevision(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	return scalar(t, ctx, p, "SELECT revision FROM realtime_revisions WHERE scope='inventory'")
}

// TestSchemaRefusesNonWarehouseLocation pins S2 at the database layer: only
// location 1 adjusts, and every other location is refused by admission.
func TestSchemaRefusesNonWarehouseLocation(t *testing.T) {
	ctx, p, _ := fixture(t)
	before := snapshot(t, ctx, p)
	for name, location := range map[string]int{"branch_2": 2, "branch_3": 3} {
		err := commitScript(ctx, p, func(tx pgx.Tx) error {
			_, err := rawDocument(ctx, tx, "schema-location-key-0001", location, nil)
			return err
		})
		if code := sqlState(t, err); code != "LS005" {
			t.Fatalf("%s must be refused with LS005, got %s", name, code)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused location must not persist a document")
	}
}

// TestSchemaOverwritesCallerExpected pins the blind-count contract: the expected
// snapshot is the locked balance, never what the caller wrote.
func TestSchemaOverwritesCallerExpected(t *testing.T) {
	ctx, p, _ := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	var id int64
	if err := commitScript(ctx, p, func(tx pgx.Tx) error {
		var err error
		if id, err = rawDocument(ctx, tx, "schema-expected-key-0001", 1, nil); err != nil {
			return err
		}
		return rawLine(ctx, tx, id, 1, 999, 12)
	}); err != nil {
		t.Fatalf("a covered counted line was refused: %v", err)
	}
	expected, counted := persistedLine(t, ctx, p, id, 1)
	if expected != 10 || counted != 12 {
		t.Fatalf("the locked balance must overwrite the caller's expected snapshot, got %d/%d", expected, counted)
	}
	if existing, reserved := balances(t, ctx, p, 1, 1); existing != 12 || reserved != 0 {
		t.Fatalf("the counted difference was not applied or reserved moved: %d/%d", existing, reserved)
	}
}

// TestSchemaRefusesEveryMutation pins S6: a persisted document and its lines are
// append-only, including TRUNCATE.
func TestSchemaRefusesEveryMutation(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	document, _, err := s.Create(ctx, warehouse(), input("schema-immutable-key-01", stockadjustments.Line{VariantID: 1, Counted: 8}))
	if err != nil {
		t.Fatal("document for the immutability probes was not created")
	}
	before := snapshot(t, ctx, p)
	for _, probe := range []struct {
		name  string
		query string
		args  []any
	}{
		{"header_update", "UPDATE stock_adjustments SET reason='otro' WHERE id=$1", []any{document.ID}},
		{"header_delete", "DELETE FROM stock_adjustments WHERE id=$1", []any{document.ID}},
		{"line_update", "UPDATE stock_adjustment_lines SET counted_quantity=counted_quantity+1 WHERE adjustment_id=$1", []any{document.ID}},
		{"line_delete", "DELETE FROM stock_adjustment_lines WHERE adjustment_id=$1", []any{document.ID}},
		// Both tables are named so the probe proves the immutability trigger and not
		// the foreign key that would refuse a single-table truncate.
		{"header_truncate", "TRUNCATE stock_adjustments, stock_adjustment_lines", nil},
	} {
		_, err := p.Exec(ctx, probe.query, probe.args...)
		if code := sqlState(t, err); code != "P0001" {
			t.Fatalf("%s must be refused by the immutability guard, got %s", probe.name, code)
		}
		var pg *pgconn.PgError
		if errors.As(err, &pg) && !strings.Contains(pg.Message, "immutable") {
			t.Fatalf("%s was refused by something other than the immutability guard: %s", probe.name, pg.Message)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused mutation must leave the document untouched")
	}
}

// TestSchemaRefusesPartialCounterEntry pins S6 at commit: a counter-entry that
// does not mirror every counted line never reaches the ledger.
func TestSchemaRefusesPartialCounterEntry(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	setBalance(t, ctx, p, 2, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("schema-partial-key-0001",
		stockadjustments.Line{VariantID: 1, Counted: 12}, stockadjustments.Line{VariantID: 2, Counted: 7}))
	if err != nil {
		t.Fatal("original document was not created")
	}
	before := snapshot(t, ctx, p)
	err = commitScript(ctx, p, func(tx pgx.Tx) error {
		id, err := rawDocument(ctx, tx, "schema-partial-counter1", 1, &original.ID)
		if err != nil {
			return err
		}
		return rawLine(ctx, tx, id, 1, 0, 0)
	})
	if code := sqlState(t, err); code != "LS003" {
		t.Fatalf("a partial counter-entry must be refused with LS003 at commit, got %s", code)
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a partial counter-entry must leave nothing behind")
	}
	// The line it did carry was applied inside the transaction and rolled back.
	if existing, _ := balances(t, ctx, p, 1, 1); existing != 12 {
		t.Fatalf("the rolled back counter-entry must not move stock, got %d", existing)
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 1 {
		t.Fatal("a partial counter-entry must not persist a document")
	}
}

// TestSchemaSingleCompleteCounterEntry pins S6: one complete counter-entry
// restores the balance and the single-reversal index refuses a second one.
func TestSchemaSingleCompleteCounterEntry(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	setBalance(t, ctx, p, 2, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("schema-counter-key-000001",
		stockadjustments.Line{VariantID: 1, Counted: 12}, stockadjustments.Line{VariantID: 2, Counted: 7}))
	if err != nil {
		t.Fatal("original document was not created")
	}
	var counter int64
	if err := commitScript(ctx, p, func(tx pgx.Tx) error {
		var err error
		if counter, err = rawDocument(ctx, tx, "schema-counter-complete1", 1, &original.ID); err != nil {
			return err
		}
		if err := rawLine(ctx, tx, counter, 1, 0, 0); err != nil {
			return err
		}
		return rawLine(ctx, tx, counter, 2, 0, 0)
	}); err != nil {
		t.Fatalf("a complete counter-entry was refused: %v", err)
	}
	if existing, _ := balances(t, ctx, p, 1, 1); existing != 10 {
		t.Fatalf("the counter-entry must restore the first line, got %d", existing)
	}
	if existing, _ := balances(t, ctx, p, 1, 2); existing != 10 {
		t.Fatalf("the counter-entry must restore the second line, got %d", existing)
	}
	// Every mirrored line persists the swapped pair, never the caller's numbers.
	for variant, want := range map[int64][2]int64{1: {12, 10}, 2: {7, 10}} {
		expected, counted := persistedLine(t, ctx, p, counter, variant)
		if expected != want[0] || counted != want[1] {
			t.Fatalf("counter-entry line %d is not the swapped pair: %d/%d", variant, expected, counted)
		}
	}
	// The single-reversal slot is the database's own, not the store's check.
	_, err = p.Exec(ctx, `INSERT INTO stock_adjustments(operation_key,location_id,reason,reverses_adjustment_id,created_by_account_id)
 VALUES('schema-counter-second1',1,'error de conteo',$1,1)`, original.ID)
	if code := sqlState(t, err); code != "23505" {
		t.Fatalf("a second counter-entry must violate the single-reversal index, got %s", code)
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments WHERE reverses_adjustment_id=$1", original.ID); n != 1 {
		t.Fatal("a document keeps exactly one counter-entry")
	}
}

// TestSchemaRefusesUncoveredCount pins S7: a refused count writes nothing and
// moves no counter, not even the realtime revision.
func TestSchemaRefusesUncoveredCount(t *testing.T) {
	ctx, p, _ := fixture(t)
	setBalance(t, ctx, p, 1, 5, 4)
	revision := inventoryRevision(t, ctx, p)
	before := snapshot(t, ctx, p)
	err := commitScript(ctx, p, func(tx pgx.Tx) error {
		id, err := rawDocument(ctx, tx, "schema-uncovered-key-001", 1, nil)
		if err != nil {
			return err
		}
		return rawLine(ctx, tx, id, 1, 0, 2)
	})
	if code := sqlState(t, err); code != "LS001" {
		t.Fatalf("a count below reserved stock must be refused with LS001, got %s", code)
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an uncovered count must not write anything")
	}
	if existing, reserved := balances(t, ctx, p, 1, 1); existing != 5 || reserved != 4 {
		t.Fatalf("an uncovered count must not move existing or reserved: %d/%d", existing, reserved)
	}
	if after := inventoryRevision(t, ctx, p); after != revision {
		t.Fatalf("an uncovered count must not move the inventory revision: %d → %d", revision, after)
	}
}

// TestSchemaCommittedAdjustmentInvalidatesInventory pins S7's realtime half: a
// committed adjustment invalidates the 'inventory' scope inside its transaction.
func TestSchemaCommittedAdjustmentInvalidatesInventory(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	before := inventoryRevision(t, ctx, p)
	transfersBefore := scalar(t, ctx, p, "SELECT revision FROM realtime_revisions WHERE scope='transfers:1'")
	if _, _, err := s.Create(ctx, warehouse(), input("schema-revision-key-0001", stockadjustments.Line{VariantID: 1, Counted: 13})); err != nil {
		t.Fatalf("the adjustment was not applied: %v", err)
	}
	if after := inventoryRevision(t, ctx, p); after != before+1 {
		t.Fatalf("a committed adjustment must invalidate the inventory scope once: %d → %d", before, after)
	}
	if after := scalar(t, ctx, p, "SELECT revision FROM realtime_revisions WHERE scope='transfers:1'"); after != transfersBefore {
		t.Fatal("an adjustment must not invalidate a transfer scope")
	}
}

// TestSchemaCataloguePayloadCarriesNoStock pins S4 on the real payload: the
// capture catalogue answers the identity of a variant and nothing else, so the
// expected stock can never be read from the screen that must stay blind.
func TestSchemaCataloguePayloadCarriesNoStock(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 42, 3)
	page, err := s.Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	if len(page.Items) == 0 || page.Items[0].VariantID != 1 {
		t.Fatalf("the capture catalogue must answer its first admitted page: %+v", page)
	}
	payload, err := json.Marshal(page.Items)
	if err != nil {
		t.Fatal("the catalogue payload is not encodable")
	}
	var items []map[string]any
	if err := json.Unmarshal(payload, &items); err != nil {
		t.Fatal("the catalogue payload is not decodable")
	}
	want := []string{"brand", "capacity_ah", "catalog_entry_id", "model", "polarity", "variant_id"}
	for i, item := range items {
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("catalogue item %d carries unexpected fields: %v", i, keys)
		}
	}
	for _, forbidden := range []string{"existing", "reserved", "expected_quantity", "counted_quantity", "difference", "balance"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("the catalogue payload leaks %q", forbidden)
		}
	}
}

// TestSchemaRefusesDocumentWithoutLines is the completeness of the header: a
// document that restores nothing must never be committed, and an empty
// counter-entry must never occupy the single-reversal slot of a document whose
// balance then stays uncorrected.
func TestSchemaRefusesDocumentWithoutLines(t *testing.T) {
	ctx, p, s := fixture(t)
	// An empty document: the header commits with no line at all.
	before := snapshot(t, ctx, p)
	err := commitScript(ctx, p, func(tx pgx.Tx) error {
		_, err := rawDocument(ctx, tx, "schema-empty-key-000001", 1, nil)
		return err
	})
	if code := sqlState(t, err); code != "LS008" {
		t.Fatalf("a document without lines must be refused at commit with LS008, got %s", code)
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused empty document must leave nothing behind")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 0 {
		t.Fatal("a refused empty document must not be persisted")
	}
	// An empty counter-entry: it restores no stock, so it must not reverse anything.
	setBalance(t, ctx, p, 1, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("schema-empty-original-01", stockadjustments.Line{VariantID: 1, Counted: 6}))
	if err != nil {
		t.Fatal("document for the empty counter-entry probe was not created")
	}
	before = snapshot(t, ctx, p)
	err = commitScript(ctx, p, func(tx pgx.Tx) error {
		_, err := rawDocument(ctx, tx, "schema-empty-counter-01", 1, &original.ID)
		return err
	})
	if code := sqlState(t, err); code != "LS008" {
		t.Fatalf("an empty counter-entry must be refused at commit with LS008, got %s", code)
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused empty counter-entry must leave nothing behind")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments WHERE reverses_adjustment_id=$1", original.ID); n != 0 {
		t.Fatal("an empty counter-entry must not take the single-reversal slot")
	}
	if existing, _ := balances(t, ctx, p, 1, 1); existing != 6 {
		t.Fatalf("a refused empty counter-entry must not move stock, got %d", existing)
	}
}
