package stockadjustments_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/testpg"
)

// fixture provisions the isolated database exactly like the stock ingress store
// does. Without an admitted LUSON_TEST_PG_MANIFEST every database test below
// fails closed at testpg.Open and that is the expected local outcome.
func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *stockadjustments.Store) {
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
	return ctx, p, stockadjustments.New(p)
}

func warehouse() auth.Identity {
	return auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
}

func branch() auth.Identity {
	return auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}
}

// input is one physical count document. The caller only ever supplies counted
// quantities: the expected snapshot is the database's own value.
func input(key string, lines ...stockadjustments.Line) stockadjustments.CreateInput {
	return stockadjustments.CreateInput{OperationKey: key, Reason: "conteo físico", Lines: lines}
}

// snapshot captures every table this domain owns, so a rejected document is
// proven to leave nothing behind: no document, no line, no balance movement.
func snapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var data string
	err := p.QueryRow(ctx, `SELECT jsonb_build_object(
  'adjustments',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM stock_adjustments a),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.adjustment_id,l.variant_id),'[]'::jsonb) FROM stock_adjustment_lines l),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("stock adjustment snapshot failed")
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

// setBalance is test-owned ledger state: the stock a counter is supposed to find.
func setBalance(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant, existing, reserved int64) {
	t.Helper()
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=$2,reserved=$3 WHERE location_id=1 AND variant_id=$1", variant, existing, reserved); err != nil {
		t.Fatal("balance fixture setup failed")
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

// persistedLine is the durable evidence of one line, read straight from the
// database and never from the store's own answer.
func persistedLine(t *testing.T, ctx context.Context, p *pgxpool.Pool, adjustment, variant int64) (expected, counted int64) {
	t.Helper()
	if p.QueryRow(ctx, `SELECT expected_quantity,counted_quantity FROM stock_adjustment_lines
 WHERE adjustment_id=$1 AND variant_id=$2`, adjustment, variant).Scan(&expected, &counted) != nil {
		t.Fatal("persisted line read failed")
	}
	return expected, counted
}

func documentRows(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) string {
	t.Helper()
	var data string
	err := p.QueryRow(ctx, `SELECT jsonb_build_object(
  'header',(SELECT to_jsonb(a) FROM stock_adjustments a WHERE a.id=$1),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.variant_id),'[]'::jsonb) FROM stock_adjustment_lines l WHERE l.adjustment_id=$1))::text`, id).Scan(&data)
	if err != nil {
		t.Fatal("document read failed")
	}
	return data
}

func TestStoreGuards(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input("guard-key-0000000001", stockadjustments.Line{VariantID: 1, Counted: 1})
	catalogQuery := stockadjustments.CatalogQuery{Page: 1, PageSize: 25}
	nilPool := stockadjustments.New(nil)
	var nilStore *stockadjustments.Store
	// Every entry point fails closed on a missing context, pool or store.
	for name, call := range map[string]func() error{
		"create_nil_pool":  func() error { _, _, err := nilPool.Create(ctx, warehouse(), in); return err },
		"create_nil_ctx":   func() error { _, _, err := nilPool.Create(nil, warehouse(), in); return err },
		"create_nil_store": func() error { _, _, err := nilStore.Create(ctx, warehouse(), in); return err },
		"list_nil_pool":    func() error { _, err := nilPool.List(ctx, warehouse(), 1, 25); return err },
		"list_nil_ctx":     func() error { _, err := nilPool.List(nil, warehouse(), 1, 25); return err },
		"list_nil_store":   func() error { _, err := nilStore.List(ctx, warehouse(), 1, 25); return err },
		"read_nil_pool":    func() error { _, err := nilPool.Read(ctx, warehouse(), 1); return err },
		"read_nil_ctx":     func() error { _, err := nilPool.Read(nil, warehouse(), 1); return err },
		"read_nil_store":   func() error { _, err := nilStore.Read(ctx, warehouse(), 1); return err },
		"reverse_nil_pool": func() error {
			_, _, err := nilPool.Reverse(ctx, warehouse(), 1, "guard-reverse-key-0001", "motivo")
			return err
		},
		"reverse_nil_ctx": func() error {
			_, _, err := nilPool.Reverse(nil, warehouse(), 1, "guard-reverse-key-0002", "motivo")
			return err
		},
		"reverse_nil_store": func() error {
			_, _, err := nilStore.Reverse(ctx, warehouse(), 1, "guard-reverse-key-0003", "motivo")
			return err
		},
		"catalog_nil_pool":  func() error { _, err := nilPool.Catalog(ctx, warehouse(), catalogQuery); return err },
		"catalog_nil_ctx":   func() error { _, err := nilPool.Catalog(nil, warehouse(), catalogQuery); return err },
		"catalog_nil_store": func() error { _, err := nilStore.Catalog(ctx, warehouse(), catalogQuery); return err },
	} {
		if err := call(); !errors.Is(err, stockadjustments.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
	if snapshot(t, ctx, p) == "" {
		t.Fatal("empty snapshot")
	}
	// The warehouse account is the only admitted actor, exactly like ingress.
	pending := warehouse()
	pending.MustChangePassword = true
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"warehouse_label": {AccountID: 1, Location: auth.Location{ID: 2}},
		"clerk":           {AccountID: 2, Location: auth.Location{ID: 1}},
		"unassigned":      {},
		"password_change": pending,
	} {
		before := snapshot(t, ctx, p)
		if _, _, err := s.Create(ctx, actor, in); !errors.Is(err, stockadjustments.ErrForbidden) {
			t.Fatalf("%s create must be forbidden", name)
		}
		if _, err := s.List(ctx, actor, 1, 25); !errors.Is(err, stockadjustments.ErrForbidden) {
			t.Fatalf("%s list must be forbidden", name)
		}
		if _, err := s.Read(ctx, actor, 1); !errors.Is(err, stockadjustments.ErrForbidden) {
			t.Fatalf("%s read must be forbidden", name)
		}
		if _, _, err := s.Reverse(ctx, actor, 1, "guard-reverse-key-0004", "motivo"); !errors.Is(err, stockadjustments.ErrForbidden) {
			t.Fatalf("%s reverse must be forbidden", name)
		}
		if _, err := s.Catalog(ctx, actor, catalogQuery); !errors.Is(err, stockadjustments.ErrForbidden) {
			t.Fatalf("%s catalogue must be forbidden", name)
		}
		if snapshot(t, ctx, p) != before {
			t.Fatalf("%s must not change any stored value", name)
		}
	}
}

func TestValidateRejectsInvalidInput(t *testing.T) {
	// 191 distinct variants exceed the one-hundred-and-ninety line document.
	tooMany := make([]stockadjustments.Line, 0, 191)
	for i := 1; i <= 191; i++ {
		tooMany = append(tooMany, stockadjustments.Line{VariantID: int64(i), Counted: 1})
	}
	for name, in := range map[string]stockadjustments.CreateInput{
		"empty_lines":      input("validate-key-000000001"),
		"too_many_lines":   input("validate-key-000000002", tooMany...),
		"duplicate":        input("validate-key-000000003", stockadjustments.Line{VariantID: 1, Counted: 1}, stockadjustments.Line{VariantID: 1, Counted: 2}),
		"counted_below":    input("validate-key-000000004", stockadjustments.Line{VariantID: 1, Counted: -1}),
		"counted_above":    input("validate-key-000000005", stockadjustments.Line{VariantID: 1, Counted: 1_000_001}),
		"zero_variant":     input("validate-key-000000006", stockadjustments.Line{VariantID: 0, Counted: 1}),
		"negative_variant": input("validate-key-000000007", stockadjustments.Line{VariantID: -3, Counted: 1}),
		"short_key":        {OperationKey: "short", Reason: "conteo físico", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"key_with_space":   {OperationKey: "invalid adjustment key", Reason: "conteo físico", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"key_over_128":     {OperationKey: strings.Repeat("a", 129), Reason: "conteo físico", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"blank_reason":     {OperationKey: "validate-key-000000008", Reason: "   \t\n", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"empty_reason":     {OperationKey: "validate-key-000000009", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"long_reason":      {OperationKey: "validate-key-000000010", Reason: strings.Repeat("ñ", 501), Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"long_detail":      {OperationKey: "validate-key-000000011", Reason: "conteo físico", Detail: strings.Repeat("ñ", 501), Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
	} {
		if _, err := stockadjustments.Validate(in); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
	}
	ctx, p, s := fixture(t)
	before := snapshot(t, ctx, p)
	for name, in := range map[string]stockadjustments.CreateInput{
		"empty_lines":    input("refuse-key-00000000001"),
		"too_many_lines": input("refuse-key-00000000002", tooMany...),
		"duplicate":      input("refuse-key-00000000003", stockadjustments.Line{VariantID: 1, Counted: 1}, stockadjustments.Line{VariantID: 1, Counted: 2}),
		"counted_below":  input("refuse-key-00000000004", stockadjustments.Line{VariantID: 1, Counted: -1}),
		"counted_above":  input("refuse-key-00000000005", stockadjustments.Line{VariantID: 1, Counted: 1_000_001}),
		"zero_variant":   input("refuse-key-00000000006", stockadjustments.Line{VariantID: 0, Counted: 1}),
		"short_key":      {OperationKey: "short", Reason: "conteo físico", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"blank_reason":   {OperationKey: "refuse-key-00000000007", Reason: "   \t\n", Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"long_reason":    {OperationKey: "refuse-key-00000000008", Reason: strings.Repeat("ñ", 501), Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
		"long_detail":    {OperationKey: "refuse-key-00000000009", Reason: "conteo físico", Detail: strings.Repeat("ñ", 501), Lines: []stockadjustments.Line{{VariantID: 1, Counted: 1}}},
	} {
		if _, _, err := s.Create(ctx, warehouse(), in); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be invalid before any database work", name)
		}
	}
	// A closed pool proves the rejection above never reached the database.
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	closed := stockadjustments.New(dead)
	if _, _, err := closed.Create(ctx, warehouse(), input("refuse-key-00000000010", stockadjustments.Line{VariantID: 1, Counted: -1})); !errors.Is(err, stockadjustments.ErrInvalid) {
		t.Fatal("a negative count must be refused before the database")
	}
	if _, _, err := closed.Create(ctx, warehouse(), input("refuse-key-00000000011", stockadjustments.Line{VariantID: 1, Counted: 1})); !errors.Is(err, stockadjustments.ErrUnavailable) {
		t.Fatal("a valid document must reach the database and fail closed")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an invalid document must not change any stored value")
	}
}

func TestValidateCanonicalizes(t *testing.T) {
	canonical, err := stockadjustments.Validate(stockadjustments.CreateInput{
		OperationKey: "canonical-key-0000001",
		Reason:       "  conteo físico  ",
		Detail:       " góndola 4 ",
		Lines: []stockadjustments.Line{
			{VariantID: 9, Counted: 15},
			{VariantID: 4, Counted: 0},
		},
	})
	if err != nil {
		t.Fatal("a valid document must be admitted")
	}
	if canonical.Reason != "conteo físico" || canonical.Detail != " góndola 4 " {
		t.Fatal("the reason is trimmed and the detail is kept verbatim")
	}
	if len(canonical.Lines) != 2 || canonical.Lines[0].VariantID != 4 || canonical.Lines[0].Counted != 0 ||
		canonical.Lines[1].VariantID != 9 || canonical.Lines[1].Counted != 15 {
		t.Fatal("lines are ordered by variant id and keep a zero count")
	}
	// The admitted bounds stay admitted.
	for _, valid := range [][2]int{{1, 10}, {1, 25}, {1, 50}, {1_000_000, 25}} {
		if !stockadjustments.ValidPage(valid[0], valid[1]) {
			t.Fatal("an admitted page was refused")
		}
	}
	for _, invalid := range [][2]int{{0, 25}, {-1, 10}, {1_000_001, 25}, {1, 0}, {1, 15}, {1, 100}, {1, -25}} {
		if stockadjustments.ValidPage(invalid[0], invalid[1]) {
			t.Fatal("a page outside the frozen contract was admitted")
		}
	}
	for _, key := range []string{"abcdefghijklmnop", "A-b_c-0123456789", strings.Repeat("a", 128)} {
		if !stockadjustments.ValidOperationKey(key) {
			t.Fatal("an admitted operation key was refused")
		}
	}
	for _, key := range []string{"", "short", strings.Repeat("a", 129), "space in key 000000", "ñandú-key-00000001"} {
		if stockadjustments.ValidOperationKey(key) {
			t.Fatal("an operation key outside the database regex was admitted")
		}
	}
	for name, tc := range map[string]struct {
		reason string
		want   string
		ok     bool
	}{
		"exact":        {"conteo físico", "conteo físico", true},
		"padded":       {"  conteo físico \n", "conteo físico", true},
		"bound":        {strings.Repeat("ñ", 500), strings.Repeat("ñ", 500), true},
		"empty":        {"", "", false},
		"spaces":       {"   \t\n", "", false},
		"too_long":     {strings.Repeat("ñ", 501), "", false},
		"nul":          {"conteo\x00físico", "", false},
		"invalid_utf8": {"conteo-\xff", "", false},
	} {
		got, ok := stockadjustments.CanonicalReason(tc.reason)
		if ok != tc.ok || got != tc.want {
			t.Fatalf("%s canonical reason mismatch: %q %v", name, got, ok)
		}
	}
}

func TestCreateAppliesCountedDifference(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	setBalance(t, ctx, p, 2, 4, 0)
	setBalance(t, ctx, p, 3, 6, 0)
	adjustment, replayed, err := s.Create(ctx, warehouse(), stockadjustments.CreateInput{
		OperationKey: "apply-key-00000000001",
		Reason:       "  conteo físico  ",
		Detail:       "góndola 4",
		Lines: []stockadjustments.Line{
			{VariantID: 3, Counted: 6},
			{VariantID: 2, Counted: 9},
			{VariantID: 1, Counted: 7},
		},
	})
	if err != nil || replayed {
		t.Fatalf("physical count was not applied: %v", err)
	}
	if adjustment.ID <= 0 || adjustment.LocationID != 1 || adjustment.CreatedByAccountID != 1 ||
		adjustment.Reason != "conteo físico" || adjustment.Detail != "góndola 4" ||
		adjustment.CreatedAt.IsZero() || adjustment.ReversesAdjustmentID != nil {
		t.Fatal("persisted document does not match the frozen contract")
	}
	if len(adjustment.Lines) != 3 {
		t.Fatal("every counted line must be applied")
	}
	// The difference is revealed only after applying, in ascending variant order.
	want := []stockadjustments.AdjustmentLine{
		{VariantID: 1, Expected: 10, Counted: 7, Difference: -3},
		{VariantID: 2, Expected: 4, Counted: 9, Difference: 5},
		{VariantID: 3, Expected: 6, Counted: 6, Difference: 0},
	}
	for i, line := range adjustment.Lines {
		if line != want[i] {
			t.Fatalf("line %d is not the expected/counted/difference triple: %+v", i, line)
		}
	}
	if adjustment.TotalDifference != 2 {
		t.Fatalf("total difference must be the exact sum, got %d", adjustment.TotalDifference)
	}
	for variant, existing := range map[int64]int64{1: 7, 2: 9, 3: 6} {
		got, reserved := balances(t, ctx, p, 1, int(variant))
		if got != existing || reserved != 0 {
			t.Fatalf("variant %d balance does not match the counted quantity or reserved moved", variant)
		}
	}
	// The expected snapshot is the database's own value, never the caller's.
	for variant, expected := range map[int64][2]int64{1: {10, 7}, 2: {4, 9}, 3: {6, 6}} {
		gotExpected, gotCounted := persistedLine(t, ctx, p, adjustment.ID, variant)
		if gotExpected != expected[0] || gotCounted != expected[1] {
			t.Fatalf("variant %d persisted evidence mismatch: %d/%d", variant, gotExpected, gotCounted)
		}
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 1 {
		t.Fatal("exactly one document must be persisted")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustment_lines WHERE adjustment_id=$1", adjustment.ID); n != 3 {
		t.Fatal("every counted line must be persisted")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM inventory_balances WHERE location_id=1 AND reserved<>0"); n != 0 {
		t.Fatal("an adjustment must never move reserved stock")
	}
}

func TestCreateRefusesDecreaseBelowReserved(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 5, 4)
	before := snapshot(t, ctx, p)
	if _, _, err := s.Create(ctx, warehouse(), input("reserved-key-0000000001", stockadjustments.Line{VariantID: 1, Counted: 2})); !errors.Is(err, stockadjustments.ErrInsufficientStock) {
		t.Fatal("a count below reserved stock must be insufficient stock")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused adjustment must not write anything")
	}
	if existing, reserved := balances(t, ctx, p, 1, 1); existing != 5 || reserved != 4 {
		t.Fatal("a refused adjustment must not move existing or reserved")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 0 {
		t.Fatal("a refused adjustment must not persist a document")
	}
	// The exact boundary is admitted: counted equal to reserved is still covered.
	adjustment, _, err := s.Create(ctx, warehouse(), input("reserved-key-0000000002", stockadjustments.Line{VariantID: 1, Counted: 4}))
	if err != nil {
		t.Fatalf("a count equal to reserved stock is covered: %v", err)
	}
	if existing, reserved := balances(t, ctx, p, 1, 1); existing != 4 || reserved != 4 {
		t.Fatal("the covered decrease must apply and never move reserved")
	}
	if adjustment.Lines[0].Difference != -1 {
		t.Fatal("the covered decrease must be revealed as a negative difference")
	}
}

func TestCreateReplayIsIdempotent(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	setBalance(t, ctx, p, 3, 10, 0)
	in := stockadjustments.CreateInput{
		OperationKey: "replay-key-0000000001", Reason: "conteo físico",
		Lines: []stockadjustments.Line{{VariantID: 3, Counted: 8}, {VariantID: 1, Counted: 12}},
	}
	first, replayed, err := s.Create(ctx, warehouse(), in)
	if err != nil || replayed {
		t.Fatal("first adjustment failed")
	}
	before := snapshot(t, ctx, p)
	// The same payload with the lines in another order is the same document.
	second, replayed, err := s.Create(ctx, warehouse(), stockadjustments.CreateInput{
		OperationKey: in.OperationKey, Reason: " conteo físico ", Lines: []stockadjustments.Line{in.Lines[1], in.Lines[0]},
	})
	if err != nil || !replayed {
		t.Fatalf("an identical replay must be a replay: %v", err)
	}
	if second.ID != first.ID || second.TotalDifference != first.TotalDifference || len(second.Lines) != len(first.Lines) {
		t.Fatal("a replay must return the persisted document")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a replay must not change any stored value")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 1 {
		t.Fatal("a replay must not create a second document")
	}
	if got, _ := balances(t, ctx, p, 1, 1); got != 12 {
		t.Fatal("a replay must not apply the difference twice")
	}
}

func TestCreateReplayConflict(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input("conflict-key-0000000001", stockadjustments.Line{VariantID: 1, Counted: 2})
	if _, _, err := s.Create(ctx, warehouse(), in); err != nil {
		t.Fatal("first adjustment failed")
	}
	before := snapshot(t, ctx, p)
	for name, changed := range map[string]stockadjustments.CreateInput{
		"reason":  {OperationKey: in.OperationKey, Reason: "otro motivo", Lines: in.Lines},
		"detail":  {OperationKey: in.OperationKey, Reason: in.Reason, Detail: "otra góndola", Lines: in.Lines},
		"counted": input(in.OperationKey, stockadjustments.Line{VariantID: 1, Counted: 3}),
		"variant": input(in.OperationKey, stockadjustments.Line{VariantID: 2, Counted: 2}),
		"extra":   input(in.OperationKey, stockadjustments.Line{VariantID: 1, Counted: 2}, stockadjustments.Line{VariantID: 2, Counted: 1}),
	} {
		if _, _, err := s.Create(ctx, warehouse(), changed); !errors.Is(err, stockadjustments.ErrRetryConflict) {
			t.Fatalf("%s conflict was not reported as a retry conflict", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a conflicting replay must not change any stored value")
	}
}

func TestCreateUnknownVariantIsInvalid(t *testing.T) {
	ctx, p, s := fixture(t)
	before := snapshot(t, ctx, p)
	for name, variant := range map[string]int64{"above_catalog": 300, "far_above_catalog": math.MaxInt32} {
		if _, _, err := s.Create(ctx, warehouse(), input("unknown-key-0000000001", stockadjustments.Line{VariantID: variant, Counted: 1})); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an unknown variant must not write anything")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 0 {
		t.Fatal("an unknown variant must not persist a document")
	}
}

func listWarehouse(t *testing.T, ctx context.Context, s *stockadjustments.Store, page, pageSize int) stockadjustments.Page {
	t.Helper()
	result, err := s.List(ctx, warehouse(), page, pageSize)
	if err != nil {
		t.Fatalf("warehouse adjustment history read failed: %v", err)
	}
	return result
}

func TestListNewestFirst(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 20, 0)
	setBalance(t, ctx, p, 2, 20, 0)
	setBalance(t, ctx, p, 3, 20, 0)
	empty := listWarehouse(t, ctx, s, 1, 25)
	if empty.Page != 1 || empty.PageSize != 25 || empty.TotalAdjustments != 0 || len(empty.Adjustments) != 0 || empty.Adjustments == nil {
		t.Fatal("an empty history must report one empty page")
	}
	ids := make([]int64, 0, 3)
	for i, in := range []stockadjustments.CreateInput{
		input("history-key-0000000001", stockadjustments.Line{VariantID: 1, Counted: 18}),
		{OperationKey: "history-key-0000000002", Reason: "conteo físico", Detail: "góndola 4", Lines: []stockadjustments.Line{{VariantID: 2, Counted: 25}, {VariantID: 1, Counted: 20}}},
		{OperationKey: "history-key-0000000003", Reason: "conteo físico", Lines: []stockadjustments.Line{{VariantID: 3, Counted: 14}}},
	} {
		adjustment, _, err := s.Create(ctx, warehouse(), in)
		if err != nil {
			t.Fatalf("document %d was not created: %v", i, err)
		}
		ids = append(ids, adjustment.ID)
	}
	page := listWarehouse(t, ctx, s, 1, 25)
	if page.TotalAdjustments != 3 || len(page.Adjustments) != 3 {
		t.Fatal("every persisted document must be listed once")
	}
	if page.Adjustments[0].ID != ids[2] || page.Adjustments[1].ID != ids[1] || page.Adjustments[2].ID != ids[0] {
		t.Fatal("history must be ordered newest first")
	}
	second := page.Adjustments[1]
	if second.Detail != "góndola 4" || second.Reason != "conteo físico" || second.Lines != 2 ||
		second.TotalDifference != 7 || second.ReversedBy != nil || second.ReversesAdjustmentID != nil || second.CreatedAt.IsZero() {
		t.Fatalf("summary does not match the persisted document: %+v", second)
	}
	if first := page.Adjustments[2]; first.Lines != 1 || first.TotalDifference != -2 || first.Detail != "" {
		t.Fatal("a single-line decrease must be summarized exactly")
	}
	if last := page.Adjustments[0]; last.Lines != 1 || last.TotalDifference != -6 {
		t.Fatal("a single-line decrease must be summarized exactly")
	}
	// A reversal is listed as its own document and cross-references its original.
	counter, _, err := s.Reverse(ctx, warehouse(), ids[1], "history-counter-00000001", "  error de conteo ")
	if err != nil {
		t.Fatalf("reversal was not created: %v", err)
	}
	page = listWarehouse(t, ctx, s, 1, 25)
	if page.TotalAdjustments != 4 || len(page.Adjustments) != 4 {
		t.Fatal("the original and its reversal must both be listed")
	}
	if page.Adjustments[0].ID != counter.ID || page.Adjustments[0].TotalDifference != -7 ||
		page.Adjustments[0].Lines != 2 || page.Adjustments[0].ReversesAdjustmentID == nil ||
		*page.Adjustments[0].ReversesAdjustmentID != ids[1] {
		t.Fatal("the reversal must be listed with the negated total and its target")
	}
	reversed := page.Adjustments[2]
	if reversed.ID != ids[1] || reversed.TotalDifference != 7 || reversed.ReversedBy == nil || *reversed.ReversedBy != counter.ID {
		t.Fatal("a reversed document must expose its reversal and keep its own total")
	}
}

func TestListPagination(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 1000, 0)
	ids := make([]int64, 0, 12)
	for i := 1; i <= 12; i++ {
		adjustment, _, err := s.Create(ctx, warehouse(), input(fmt.Sprintf("page-key-%016d", i), stockadjustments.Line{VariantID: 1, Counted: int64(1000 - i)}))
		if err != nil {
			t.Fatalf("document %d was not created: %v", i, err)
		}
		ids = append(ids, adjustment.ID)
	}
	first := listWarehouse(t, ctx, s, 1, 10)
	if first.Page != 1 || first.PageSize != 10 || first.TotalAdjustments != 12 || len(first.Adjustments) != 10 {
		t.Fatal("the first page must hold ten of twelve documents")
	}
	if first.Adjustments[0].ID != ids[11] || first.Adjustments[9].ID != ids[2] {
		t.Fatal("the first page must hold the ten newest documents")
	}
	second := listWarehouse(t, ctx, s, 2, 10)
	if second.Page != 2 || second.TotalAdjustments != 12 || len(second.Adjustments) != 2 {
		t.Fatal("the second page must hold the two oldest documents")
	}
	if second.Adjustments[0].ID != ids[1] || second.Adjustments[1].ID != ids[0] {
		t.Fatal("the last page must continue the newest-first order")
	}
	beyond := listWarehouse(t, ctx, s, 3, 10)
	if len(beyond.Adjustments) != 0 || beyond.TotalAdjustments != 12 || beyond.Page != 3 {
		t.Fatal("a page beyond the last one must be empty and keep the total")
	}
	all := listWarehouse(t, ctx, s, 1, 25)
	if len(all.Adjustments) != 12 || all.PageSize != 25 || all.TotalAdjustments != 12 {
		t.Fatal("every document must fit on one page of twenty-five")
	}
	fifty := listWarehouse(t, ctx, s, 1, 50)
	if len(fifty.Adjustments) != 12 || fifty.PageSize != 50 || fifty.TotalAdjustments != 12 {
		t.Fatal("every document must fit on one page of fifty")
	}
}

func TestListRejectsInvalidPageBeforeSQL(t *testing.T) {
	ctx, p, _ := fixture(t)
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	closed := stockadjustments.New(dead)
	for name, query := range map[string][2]int{
		"zero_page":         {0, 25},
		"negative_page":     {-1, 10},
		"page_above_bound":  {1_000_001, 25},
		"zero_size":         {1, 0},
		"size_not_admitted": {1, 15},
		"size_above_bound":  {1, 100},
		"negative_size":     {1, -25},
	} {
		if _, err := closed.List(ctx, warehouse(), query[0], query[1]); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be refused before the database", name)
		}
	}
	// The same closed pool proves an admitted page does reach the database.
	if _, err := closed.List(ctx, warehouse(), 1, 25); !errors.Is(err, stockadjustments.ErrUnavailable) {
		t.Fatal("an admitted page must reach the database and fail closed")
	}
}

func readDetail(t *testing.T, ctx context.Context, s *stockadjustments.Store, id int64) stockadjustments.Detail {
	t.Helper()
	detail, err := s.Read(ctx, warehouse(), id)
	if err != nil {
		t.Fatalf("document detail read failed: %v", err)
	}
	return detail
}

// catalogueOf is the catalogue identity of one variant as the database holds it.
func catalogueOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant int64) (entry int64, brand, model string, capacity catalog.Decimal, polarity string) {
	t.Helper()
	var raw string
	err := p.QueryRow(ctx, `SELECT e.id,e.brand,e.model,e.capacity_ah::text,v.polarity
 FROM catalog_variants v JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE v.id=$1`, int32(variant)).Scan(&entry, &brand, &model, &raw, &polarity)
	if err != nil {
		t.Fatal("catalogue identity read failed")
	}
	capacity, err = catalog.ParseDecimal(raw)
	if err != nil {
		t.Fatal("catalogue capacity is not a canonical decimal")
	}
	return entry, brand, model, capacity, polarity
}

func TestReadDetail(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 4, 15, 0)
	setBalance(t, ctx, p, 9, 15, 0)
	adjustment, _, err := s.Create(ctx, warehouse(), stockadjustments.CreateInput{
		OperationKey: "detail-key-000000000001", Reason: "  conteo físico  ", Detail: "góndola 9",
		Lines: []stockadjustments.Line{{VariantID: 9, Counted: 11}, {VariantID: 4, Counted: 18}},
	})
	if err != nil {
		t.Fatal("document for the detail read was not created")
	}
	detail := readDetail(t, ctx, s, adjustment.ID)
	if detail.ID != adjustment.ID || detail.LocationID != 1 || detail.CreatedByAccountID != 1 ||
		detail.Reason != "conteo físico" || detail.Detail != "góndola 9" ||
		detail.CreatedAt.IsZero() || detail.ReversesAdjustmentID != nil || detail.ReversedBy != nil {
		t.Fatalf("detail header does not match the persisted document: %+v", detail)
	}
	if len(detail.Lines) != 2 || detail.TotalDifference != -1 {
		t.Fatal("detail must carry every line and the exact total difference")
	}
	// Lines are ordered by variant id, never by insertion order, and the
	// difference is derived from the two persisted facts.
	want := []stockadjustments.DetailLine{
		{VariantID: 4, Expected: 15, Counted: 18, Difference: 3},
		{VariantID: 9, Expected: 15, Counted: 11, Difference: -4},
	}
	for i, line := range detail.Lines {
		if line.VariantID != want[i].VariantID || line.Expected != want[i].Expected ||
			line.Counted != want[i].Counted || line.Difference != want[i].Difference {
			t.Fatalf("line %d is not the persisted expected/counted/difference triple: %+v", i, line)
		}
		entry, brand, model, capacity, polarity := catalogueOf(t, ctx, p, line.VariantID)
		if line.CatalogEntryID != entry || line.Brand != brand || line.Model != model ||
			line.Capacity != capacity || line.Polarity != polarity {
			t.Fatalf("line %d does not carry its catalogue identity: %+v", line.VariantID, line)
		}
		if line.Brand == "" || line.Model == "" || line.Capacity == "" || (line.Polarity != "L" && line.Polarity != "R") {
			t.Fatalf("line %d has an incomplete catalogue identity", line.VariantID)
		}
	}
	// The detail stays readable the way it was applied even though stock moved.
	if got, _ := balances(t, ctx, p, 1, 4); got != 18 {
		t.Fatal("the detail read must not be a second application of the document")
	}
}

func TestReadDetailReversalCrossReferences(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 12, 0)
	setBalance(t, ctx, p, 2, 12, 0)
	original, _, err := s.Create(ctx, warehouse(), input("detail-counter-key-0001",
		stockadjustments.Line{VariantID: 1, Counted: 10}, stockadjustments.Line{VariantID: 2, Counted: 15}))
	if err != nil {
		t.Fatal("original document was not created")
	}
	counter, _, err := s.Reverse(ctx, warehouse(), original.ID, "detail-counter-key-0002", "error de conteo")
	if err != nil {
		t.Fatal("reversal was not created")
	}
	reversed := readDetail(t, ctx, s, original.ID)
	if reversed.ReversesAdjustmentID != nil || reversed.ReversedBy == nil || *reversed.ReversedBy != counter.ID ||
		reversed.Reason != "conteo físico" || reversed.TotalDifference != 1 {
		t.Fatalf("a reversed document must expose its reversal and keep its own header: %+v", reversed)
	}
	if len(reversed.Lines) != 2 || reversed.Lines[0].Counted != 10 || reversed.Lines[1].Counted != 15 {
		t.Fatal("a reversed document keeps its own counted lines")
	}
	detail := readDetail(t, ctx, s, counter.ID)
	if detail.ReversesAdjustmentID == nil || *detail.ReversesAdjustmentID != original.ID || detail.ReversedBy != nil ||
		detail.Reason != "error de conteo" || detail.TotalDifference != -1 {
		t.Fatalf("a reversal detail must expose its target and its motive: %+v", detail)
	}
	if len(detail.Lines) != 2 {
		t.Fatal("a reversal mirrors every line of its original")
	}
	want := []stockadjustments.DetailLine{
		{VariantID: 1, Expected: 10, Counted: 12, Difference: 2},
		{VariantID: 2, Expected: 15, Counted: 12, Difference: -3},
	}
	for i, line := range detail.Lines {
		if line.VariantID != want[i].VariantID || line.Expected != want[i].Expected ||
			line.Counted != want[i].Counted || line.Difference != want[i].Difference {
			t.Fatalf("reversal line %d is not the swapped original line: %+v", i, line)
		}
		if line.Brand == "" || line.Model == "" || line.Capacity == "" || (line.Polarity != "L" && line.Polarity != "R") {
			t.Fatalf("reversal line %d has no catalogue identity", line.VariantID)
		}
	}
}

// TestReadDetailCounterEntryMotive pins the counter-entry's own motive on the
// reversed document: one detail read renders it beside the cross-reference, and
// the original keeps its own header, lines and arithmetic.
func TestReadDetailCounterEntryMotive(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 4, 15, 0)
	setBalance(t, ctx, p, 9, 15, 0)
	original, _, err := s.Create(ctx, warehouse(), stockadjustments.CreateInput{
		OperationKey: "motive-key-000000000001", Reason: "conteo físico", Detail: "góndola 9",
		Lines: []stockadjustments.Line{{VariantID: 9, Counted: 11}, {VariantID: 4, Counted: 18}},
	})
	if err != nil {
		t.Fatal("original document was not created")
	}
	// A document that is not reversed has no counter-entry motive to report.
	plain := readDetail(t, ctx, s, original.ID)
	if plain.ReversedBy != nil || plain.ReversedByReason != "" {
		t.Fatalf("a document that is not reversed carries no counter motive: %+v", plain)
	}
	counter, _, err := s.Reverse(ctx, warehouse(), original.ID, "motive-key-000000000002", "  error de conteo  ")
	if err != nil {
		t.Fatal("reversal was not created")
	}
	reversed := readDetail(t, ctx, s, original.ID)
	if reversed.ReversedBy == nil || *reversed.ReversedBy != counter.ID ||
		reversed.ReversedByReason != "error de conteo" {
		t.Fatalf("a reversed document must carry the counter-entry motive: %+v", reversed)
	}
	// The motive is a cross-reference, never a rewrite of the original document.
	if reversed.Reason != "conteo físico" || reversed.Detail != "góndola 9" || reversed.TotalDifference != -1 ||
		len(reversed.Lines) != 2 ||
		reversed.Lines[0].VariantID != 4 || reversed.Lines[0].Expected != 15 ||
		reversed.Lines[0].Counted != 18 || reversed.Lines[0].Difference != 3 ||
		reversed.Lines[1].VariantID != 9 || reversed.Lines[1].Expected != 15 ||
		reversed.Lines[1].Counted != 11 || reversed.Lines[1].Difference != -4 {
		t.Fatalf("the reversed document must keep its own lines and arithmetic: %+v", reversed)
	}
	// A counter-entry is not itself reversed, so it reports no counter motive.
	detail := readDetail(t, ctx, s, counter.ID)
	if detail.ReversedBy != nil || detail.ReversedByReason != "" || detail.Reason != "error de conteo" {
		t.Fatalf("a counter-entry must not report a counter-entry motive: %+v", detail)
	}
}

// foreignDocument persists an adjustment of another location. Only the database
// may refuse one in normal operation, so the isolated fixture writes it with the
// admission and application triggers disabled, then re-enables them immediately.
func foreignDocument(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	disable := func() {
		for _, statement := range []string{
			"ALTER TABLE stock_adjustment_lines DISABLE TRIGGER USER",
			"ALTER TABLE stock_adjustments DISABLE TRIGGER USER",
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
			"ALTER TABLE stock_adjustment_lines ENABLE TRIGGER USER",
			"ALTER TABLE stock_adjustments ENABLE TRIGGER USER",
		} {
			_, _ = p.Exec(cleanup, statement)
		}
	}
	disable()
	defer enable()
	t.Cleanup(enable)
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO stock_adjustments(operation_key,location_id,reason,created_by_account_id)
 VALUES('foreign-detail-key-0001',2,'sucursal',1) RETURNING id`).Scan(&id); err != nil {
		t.Fatal("foreign document insert failed")
	}
	if _, err := p.Exec(ctx, "INSERT INTO stock_adjustment_lines(adjustment_id,variant_id,expected_quantity,counted_quantity) VALUES($1,$2,$3,$4)", id, int32(1), int64(5), int64(4)); err != nil {
		t.Fatal("foreign document line insert failed")
	}
	return id
}

func TestReadDetailNotFound(t *testing.T) {
	ctx, p, s := fixture(t)
	adjustment, _, err := s.Create(ctx, warehouse(), input("detail-missing-key-0001", stockadjustments.Line{VariantID: 1, Counted: 1}))
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
		if _, err := s.Read(ctx, warehouse(), id); !errors.Is(err, stockadjustments.ErrNotFound) {
			t.Fatalf("%s id must not be found", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a document outside this warehouse must not change any stored value")
	}
	// The warehouse document stays readable: only other locations are hidden.
	if detail := readDetail(t, ctx, s, adjustment.ID); detail.ID != adjustment.ID {
		t.Fatal("the warehouse detail read must keep answering its own documents")
	}
}

func TestReverseMirrorsAndRestores(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	setBalance(t, ctx, p, 2, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("mirror-key-0000000001",
		stockadjustments.Line{VariantID: 2, Counted: 16}, stockadjustments.Line{VariantID: 1, Counted: 6}))
	if err != nil {
		t.Fatalf("count before the reversal failed: %v", err)
	}
	if got, _ := balances(t, ctx, p, 1, 1); got != 6 {
		t.Fatal("the count was not applied")
	}
	if got, _ := balances(t, ctx, p, 1, 2); got != 16 {
		t.Fatal("the count was not applied")
	}
	before := documentRows(t, ctx, p, original.ID)
	counter, replayed, err := s.Reverse(ctx, warehouse(), original.ID, "mirror-counter-key-0001", "  error de conteo  ")
	if err != nil || replayed {
		t.Fatalf("reversal was not created: %v", err)
	}
	if counter.ID <= original.ID || counter.LocationID != 1 || counter.CreatedByAccountID != 1 ||
		counter.CreatedAt.IsZero() || counter.ReversesAdjustmentID == nil || *counter.ReversesAdjustmentID != original.ID ||
		counter.Reason != "error de conteo" || counter.TotalDifference != -original.TotalDifference {
		t.Fatalf("reversal header does not match the frozen contract: %+v", counter)
	}
	// Every line is mirrored with counted and expected swapped.
	if len(counter.Lines) != len(original.Lines) {
		t.Fatal("a reversal must mirror every line of its original")
	}
	for i, line := range original.Lines {
		got := counter.Lines[i]
		if got.VariantID != line.VariantID || got.Expected != line.Counted || got.Counted != line.Expected ||
			got.Difference != -line.Difference {
			t.Fatalf("reversal line %d is not the swapped original line: %+v", i, got)
		}
	}
	// The whole pre-adjustment stock is restored.
	if got, reserved := balances(t, ctx, p, 1, 1); got != 10 || reserved != 0 {
		t.Fatal("the reversal must restore the first line and never move reserved")
	}
	if got, reserved := balances(t, ctx, p, 1, 2); got != 10 || reserved != 0 {
		t.Fatal("the reversal must restore the second line and never move reserved")
	}
	var storedReason string
	if p.QueryRow(ctx, "SELECT reason FROM stock_adjustments WHERE id=$1", counter.ID).Scan(&storedReason) != nil || storedReason != "error de conteo" {
		t.Fatal("the trimmed reversal reason must be persisted verbatim")
	}
	if documentRows(t, ctx, p, original.ID) != before {
		t.Fatal("the original document must not change")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 2 {
		t.Fatal("the original and its reversal must both stay visible")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustment_lines WHERE adjustment_id=$1", counter.ID); n != 2 {
		t.Fatal("the reversal must persist every mirrored line")
	}
}

func TestReverseReplayIsIdempotent(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("reverse-replay-key-0001", stockadjustments.Line{VariantID: 1, Counted: 7}))
	if err != nil {
		t.Fatal("count before the reversal failed")
	}
	first, replayed, err := s.Reverse(ctx, warehouse(), original.ID, "reverse-replay-counter-1", "error de conteo")
	if err != nil || replayed {
		t.Fatal("first reversal failed")
	}
	before := snapshot(t, ctx, p)
	second, replayed, err := s.Reverse(ctx, warehouse(), original.ID, "reverse-replay-counter-1", " error de conteo ")
	if err != nil || !replayed {
		t.Fatalf("an identical reversal replay must be a replay: %v", err)
	}
	if second.ID != first.ID || second.TotalDifference != first.TotalDifference || len(second.Lines) != len(first.Lines) {
		t.Fatal("a replay must return the persisted reversal")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a reversal replay must not change any stored value")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 2 {
		t.Fatal("a reversal replay must not create a second reversal")
	}
	if got, _ := balances(t, ctx, p, 1, 1); got != 10 {
		t.Fatal("a reversal replay must not restore the stock twice")
	}
}

func TestReverseReplayConflict(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	first, _, err := s.Create(ctx, warehouse(), input("reverse-conflict-key-01", stockadjustments.Line{VariantID: 1, Counted: 7}))
	if err != nil {
		t.Fatal("first count failed")
	}
	second, _, err := s.Create(ctx, warehouse(), input("reverse-conflict-key-02", stockadjustments.Line{VariantID: 1, Counted: 5}))
	if err != nil {
		t.Fatal("second count failed")
	}
	if _, _, err := s.Reverse(ctx, warehouse(), first.ID, "reverse-conflict-counter1", "error de conteo"); err != nil {
		t.Fatal("first reversal failed")
	}
	before := snapshot(t, ctx, p)
	for name, call := range map[string]struct {
		target int64
		key    string
		reason string
	}{
		"another_reason": {first.ID, "reverse-conflict-counter1", "otro motivo"},
		"another_target": {second.ID, "reverse-conflict-counter1", "error de conteo"},
		// A creation key is not a reversal key, even for the same document.
		"creation_key": {second.ID, "reverse-conflict-key-02", "error de conteo"},
	} {
		if _, _, err := s.Reverse(ctx, warehouse(), call.target, call.key, call.reason); !errors.Is(err, stockadjustments.ErrRetryConflict) {
			t.Fatalf("%s conflict was not reported as a retry conflict", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a conflicting reversal must not change any stored value")
	}
}

func TestReverseRejectsInvalidInputWithoutWriting(t *testing.T) {
	ctx, p, s := fixture(t)
	original, _, err := s.Create(ctx, warehouse(), input("reverse-invalid-key-001", stockadjustments.Line{VariantID: 1, Counted: 1}))
	if err != nil {
		t.Fatal("count before the reversal failed")
	}
	before := snapshot(t, ctx, p)
	for name, call := range map[string]struct {
		key    string
		reason string
	}{
		"empty_reason":   {"reverse-invalid-counter1", ""},
		"blank_reason":   {"reverse-invalid-counter2", "   \t\n"},
		"long_reason":    {"reverse-invalid-counter3", strings.Repeat("ñ", 501)},
		"nul_reason":     {"reverse-invalid-counter4", "error\x00de conteo"},
		"invalid_utf8":   {"reverse-invalid-counter5", "error-\xff"},
		"short_key":      {"short", "error de conteo"},
		"key_with_space": {"reverse invalid counter", "error de conteo"},
		"key_over_128":   {strings.Repeat("a", 129), "error de conteo"},
	} {
		if _, _, err := s.Reverse(ctx, warehouse(), original.ID, call.key, call.reason); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be invalid", name)
		}
	}
	for name, target := range map[string]int64{"zero": 0, "negative": -1, "missing": math.MaxInt64} {
		if _, _, err := s.Reverse(ctx, warehouse(), target, "reverse-invalid-counter6", "error de conteo"); !errors.Is(err, stockadjustments.ErrNotFound) {
			t.Fatalf("%s target must not be found", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("an invalid reversal must not change any stored value")
	}
}

func TestReverseRefusesSecondReversal(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("target-key-0000000001", stockadjustments.Line{VariantID: 1, Counted: 4}))
	if err != nil {
		t.Fatal("count before the reversal failed")
	}
	counter, _, err := s.Reverse(ctx, warehouse(), original.ID, "target-counter-key-0001", "error de conteo")
	if err != nil {
		t.Fatal("reversal failed")
	}
	before := snapshot(t, ctx, p)
	if _, _, err := s.Reverse(ctx, warehouse(), original.ID, "target-counter-key-0002", "error de conteo"); !errors.Is(err, stockadjustments.ErrDecisionConflict) {
		t.Fatal("an already reversed document must be a decision conflict")
	}
	if _, _, err := s.Reverse(ctx, warehouse(), counter.ID, "target-counter-key-0003", "error de conteo"); !errors.Is(err, stockadjustments.ErrDecisionConflict) {
		t.Fatal("a reversal of a reversal must be a decision conflict")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused reversal must not change any stored value")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments WHERE reverses_adjustment_id=$1", original.ID); n != 1 {
		t.Fatal("a document keeps exactly one reversal")
	}
}

func TestReverseRefusesUncoveredStock(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	setBalance(t, ctx, p, 2, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("uncovered-key-00000001",
		stockadjustments.Line{VariantID: 1, Counted: 8}, stockadjustments.Line{VariantID: 2, Counted: 14}))
	if err != nil {
		t.Fatal("count before the reversal failed")
	}
	// The stock raised by the second line was consumed after the adjustment, so
	// reversing that counted surplus would leave existing below reserved.
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=reserved WHERE location_id=1 AND variant_id=2"); err != nil {
		t.Fatal("consumption setup failed")
	}
	before := snapshot(t, ctx, p)
	beforeOriginal := documentRows(t, ctx, p, original.ID)
	if _, _, err := s.Reverse(ctx, warehouse(), original.ID, "uncovered-counter-key-01", "error de conteo"); !errors.Is(err, stockadjustments.ErrInsufficientStock) {
		t.Fatal("a reversal that would leave existing below reserved must be insufficient stock")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("the whole reversal must be rejected without a partial write")
	}
	if documentRows(t, ctx, p, original.ID) != beforeOriginal {
		t.Fatal("a rejected reversal must not change the original document")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments WHERE reverses_adjustment_id=$1", original.ID); n != 0 {
		t.Fatal("a rejected reversal must not persist a reversal")
	}
}

func TestReverseConcurrentIdenticalReplay(t *testing.T) {
	ctx, p, s := fixture(t)
	setBalance(t, ctx, p, 1, 10, 0)
	original, _, err := s.Create(ctx, warehouse(), input("concurrent-key-0000001", stockadjustments.Line{VariantID: 1, Counted: 6}))
	if err != nil {
		t.Fatal("count before the reversal failed")
	}
	type result struct {
		adjustment stockadjustments.Adjustment
		replayed   bool
		err        error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			adjustment, replayed, err := s.Reverse(ctx, warehouse(), original.ID, "concurrent-counter-0001", "error de conteo")
			results <- result{adjustment, replayed, err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var created, replayed int
	ids := map[int64]bool{}
	for r := range results {
		if r.err != nil {
			t.Fatalf("a concurrent identical reversal failed: %v", r.err)
		}
		if r.replayed {
			replayed++
		} else {
			created++
		}
		ids[r.adjustment.ID] = true
	}
	if created != 1 || replayed != 1 || len(ids) != 1 {
		t.Fatalf("a concurrent identical reversal must resolve to one document and one replay, got %d/%d", created, replayed)
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments"); n != 2 {
		t.Fatal("a concurrent identical reversal must not create a second document")
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM stock_adjustments WHERE reverses_adjustment_id=$1", original.ID); n != 1 {
		t.Fatal("a concurrent identical reversal must not create a second reversal")
	}
	if got, _ := balances(t, ctx, p, 1, 1); got != 10 {
		t.Fatal("a concurrent identical reversal must restore the stock exactly once")
	}
}

func TestCatalogCarriesNoStockQuantities(t *testing.T) {
	// The blind capture catalogue cannot leak a quantity through any struct.
	forbidden := []string{"existing", "reserved", "available", "stock", "quantity", "counted", "expected", "difference", "balance"}
	for _, typ := range []reflect.Type{
		reflect.TypeOf(stockadjustments.CatalogItem{}),
		reflect.TypeOf(stockadjustments.CatalogQuery{}),
		reflect.TypeOf(stockadjustments.CatalogPage{}),
	} {
		for i := 0; i < typ.NumField(); i++ {
			name := strings.ToLower(typ.Field(i).Name)
			for _, word := range forbidden {
				if strings.Contains(name, word) {
					t.Fatalf("%s.%s exposes a stock quantity", typ.Name(), typ.Field(i).Name)
				}
			}
		}
	}
}

func TestCatalogIdentityOnly(t *testing.T) {
	ctx, p, s := fixture(t)
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("catalogue source load failed")
	}
	page, err := s.Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Page: 1, PageSize: 25})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	if page.Page != 1 || page.PageSize != 25 || page.TotalVariants != 190 || len(page.Items) != 25 {
		t.Fatalf("the catalogue must expose one admitted page of the whole catalogue: %+v", page)
	}
	for i, item := range page.Items {
		wantID := int64(i + 1)
		entry, brand, model, capacity, polarity := catalogueOf(t, ctx, p, wantID)
		if item.VariantID != wantID || item.CatalogEntryID != entry || item.Brand != brand ||
			item.Model != model || item.Capacity != capacity || item.Polarity != polarity {
			t.Fatalf("catalogue item %d does not carry its identity: %+v", i, item)
		}
		sourceEntry := source.Entries[(wantID-1)/2]
		wantPolarity := "L"
		if wantID%2 == 0 {
			wantPolarity = "R"
		}
		if item.CatalogEntryID != int64(sourceEntry.ID) || item.Brand != sourceEntry.Brand ||
			item.Model != sourceEntry.Model || item.Capacity != sourceEntry.Capacity || item.Polarity != wantPolarity {
			t.Fatalf("catalogue item %d does not match the preloaded source catalogue", i)
		}
	}
	// Pagination of every admitted size walks the whole catalogue exactly once.
	for _, size := range []int{10, 25, 50} {
		seen := map[int64]bool{}
		for index := 1; (index-1)*size < 190; index++ {
			result, err := s.Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Page: index, PageSize: size})
			if err != nil || result.TotalVariants != 190 || result.Page != index || result.PageSize != size {
				t.Fatalf("catalogue pagination contract failed for size %d", size)
			}
			want := size
			if 190-(index-1)*size < size {
				want = 190 - (index-1)*size
			}
			if len(result.Items) != want {
				t.Fatalf("catalogue page %d of size %d has the wrong length", index, size)
			}
			for i, item := range result.Items {
				id := int64((index-1)*size + i + 1)
				if seen[id] || item.VariantID != id {
					t.Fatalf("catalogue page %d of size %d is not the stable variant order", index, size)
				}
				seen[id] = true
			}
		}
		if len(seen) != 190 {
			t.Fatalf("catalogue pagination of size %d lost a variant", size)
		}
	}
	// A page beyond the last one is an empty page that keeps the total.
	empty, err := s.Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Page: 1_000_000, PageSize: 50})
	if err != nil || len(empty.Items) != 0 || empty.Items == nil || empty.TotalVariants != 190 {
		t.Fatal("an empty catalogue page must be non-null and keep the total")
	}
	noMatch, err := s.Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Search: "no matching model", Page: 1, PageSize: 10})
	if err != nil || len(noMatch.Items) != 0 || noMatch.TotalVariants != 0 {
		t.Fatal("an unmatched search must be an empty page")
	}
}

func TestCatalogFilters(t *testing.T) {
	ctx, _, s := fixture(t)
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("catalogue source load failed")
	}
	for name, q := range map[string]stockadjustments.CatalogQuery{
		"model_search":         {Search: "moto"},
		"capacity_comma":       {Search: "6,5"},
		"capacity_dot":         {Search: "6.5"},
		"literal_percent":      {Search: "%"},
		"literal_underscore":   {Search: "_"},
		"literal_backslash":    {Search: `\`},
		"injection_attempt":    {Search: "' OR 1=1 --"},
		"brand":                {Brand: source.Entries[0].Brand},
		"polarity":             {Polarity: "R"},
		"brand_polarity_model": {Search: strings.ToLower(source.Entries[0].Model), Brand: source.Entries[0].Brand, Polarity: "L"},
		"case_insensitive":     {Search: strings.ToUpper(source.Entries[0].Brand), Polarity: "R"},
	} {
		q.Page, q.PageSize = 1, 50
		want := []int64{}
		for _, entry := range source.Entries {
			if q.Brand != "" && q.Brand != entry.Brand {
				continue
			}
			if q.Search != "" && !strings.Contains(strings.ToLower(entry.Brand), strings.ToLower(q.Search)) &&
				!strings.Contains(strings.ToLower(entry.Model), strings.ToLower(q.Search)) {
				continue
			}
			for _, variant := range []struct {
				id       int64
				polarity string
			}{
				{int64(entry.ID)*2 - 1, "L"},
				{int64(entry.ID) * 2, "R"},
			} {
				if q.Polarity == "" || q.Polarity == variant.polarity {
					want = append(want, variant.id)
				}
			}
		}
		result, err := s.Catalog(ctx, warehouse(), q)
		if err != nil || result.TotalVariants != int64(len(want)) {
			t.Fatalf("%s filter did not count the matching variants", name)
		}
		limit := len(want)
		if limit > 50 {
			limit = 50
		}
		if len(result.Items) != limit {
			t.Fatalf("%s filter returned %d items, want %d", name, len(result.Items), limit)
		}
		for i, item := range result.Items {
			if item.VariantID != want[i] {
				t.Fatalf("%s filter is not the stable variant order", name)
			}
		}
	}
}

func TestCatalogRejectsInvalidQueryAndActor(t *testing.T) {
	ctx, p, s := fixture(t)
	before := snapshot(t, ctx, p)
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"warehouse_label": {AccountID: 1, Location: auth.Location{ID: 2}},
		"clerk":           {AccountID: 2, Location: auth.Location{ID: 1}},
		"unassigned":      {},
	} {
		if _, err := s.Catalog(ctx, actor, stockadjustments.CatalogQuery{Page: 1, PageSize: 25}); !errors.Is(err, stockadjustments.ErrForbidden) {
			t.Fatalf("%s must be forbidden", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a forbidden catalogue read must not change any stored value")
	}
	dead, err := pgxpool.NewWithConfig(ctx, p.Config())
	if err != nil {
		t.Fatal("closed-pool fixture failed")
	}
	dead.Close()
	closed := stockadjustments.New(dead)
	for name, query := range map[string]stockadjustments.CatalogQuery{
		"zero_page":         {Page: 0, PageSize: 25},
		"page_above_bound":  {Page: 1_000_001, PageSize: 25},
		"size_not_admitted": {Page: 1, PageSize: 15},
		"negative_size":     {Page: 1, PageSize: -25},
		"bad_polarity":      {Page: 1, PageSize: 25, Polarity: "X"},
		"long_search":       {Page: 1, PageSize: 25, Search: strings.Repeat("a", 129)},
		"long_brand":        {Page: 1, PageSize: 25, Brand: strings.Repeat("a", 129)},
		"nul_search":        {Page: 1, PageSize: 25, Search: "moto\x00"},
	} {
		if _, err := closed.Catalog(ctx, warehouse(), query); !errors.Is(err, stockadjustments.ErrInvalid) {
			t.Fatalf("%s must be refused before the database", name)
		}
	}
	if _, err := closed.Catalog(ctx, warehouse(), stockadjustments.CatalogQuery{Page: 1, PageSize: 25}); !errors.Is(err, stockadjustments.ErrUnavailable) {
		t.Fatal("an admitted catalogue query must reach the database and fail closed")
	}
}
