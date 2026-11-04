package pricing_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
	"luson/api/internal/testpg"
)

// fixture provisions the isolated database exactly like the stock adjustment store
// does. Without an admitted LUSON_TEST_PG_MANIFEST every database test below fails
// closed at testpg.Open and that is the expected local outcome.
func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *pricing.Store) {
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
	return ctx, p, pricing.New(p)
}

func warehouse() auth.Identity {
	return auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
}

func branch() auth.Identity {
	return auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}
}

// snapshot captures every table this domain owns, so a rejected or replayed write is
// proven to leave nothing behind.
func snapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var data string
	err := p.QueryRow(ctx, `SELECT jsonb_build_object(
  'prices',(SELECT coalesce(jsonb_agg(to_jsonb(bp) ORDER BY bp.branch_location_id,bp.variant_id),'[]'::jsonb) FROM branch_prices bp),
  'warranties',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.variant_id),'[]'::jsonb) FROM variant_warranties w))::text`).Scan(&data)
	if err != nil {
		t.Fatal("branch price snapshot failed")
	}
	return data
}

// storedPrice is the durable evidence of one pair, read straight from the database
// and never from the store's own answer.
func storedPrice(t *testing.T, ctx context.Context, p *pgxpool.Pool, branchID, variantID int64) (min, suggested string, account int64) {
	t.Helper()
	if p.QueryRow(ctx, `SELECT min_price::text,suggested_price::text,updated_by_account_id
 FROM branch_prices WHERE branch_location_id=$1 AND variant_id=$2`, int16(branchID), int32(variantID)).Scan(&min, &suggested, &account) != nil {
		t.Fatal("persisted price read failed")
	}
	return min, suggested, account
}

func storedWarranty(t *testing.T, ctx context.Context, p *pgxpool.Pool, variantID int64) *int {
	t.Helper()
	var months *int
	if p.QueryRow(ctx, "SELECT warranty_months FROM variant_warranties WHERE variant_id=$1", int32(variantID)).Scan(&months) != nil {
		t.Fatal("persisted warranty read failed")
	}
	return months
}

func scalar(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if p.QueryRow(ctx, query, args...).Scan(&n) != nil {
		t.Fatal("scalar query failed")
	}
	return n
}

// createBranch reuses the branch allocation entrypoint, so a fixture branch carries
// the same zero-stock matrix and realtime audience a created branch has.
func createBranch(t *testing.T, ctx context.Context, p *pgxpool.Pool, name string) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, "SELECT create_branch($1)", name).Scan(&id); err != nil {
		t.Fatal("branch fixture creation failed")
	}
	return id
}

func retireBranch(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) {
	t.Helper()
	if _, err := p.Exec(ctx, "UPDATE locations SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", int16(id)); err != nil {
		t.Fatal("branch fixture retirement failed")
	}
}

func intPtr(value int) *int { return &value }

// TestBranchPriceParseMoney pins the money contract: a positive amount canonicalized
// to exactly two decimals, never a float and never an approximation.
func TestBranchPriceParseMoney(t *testing.T) {
	for text, want := range map[string]string{
		"85000":      "85000.00",
		"85000.5":    "85000.50",
		"85000.05":   "85000.05",
		"85000.00":   "85000.00",
		"0.01":       "0.01",
		"0.5":        "0.50",
		"0.10":       "0.10",
		"9999999999": "9999999999.00",
	} {
		got, err := pricing.ParseMoney(text)
		if err != nil || string(got) != want || got.String() != want {
			t.Fatalf("%q must canonicalize to %q, got %q", text, want, got)
		}
	}
	for name, text := range map[string]string{
		"empty":        "",
		"zero":         "0",
		"zero_decimal": "0.00",
		"zero_padded":  "0.0",
		"negative":     "-1",
		"negative_dec": "-0.01",
		"signed":       "+1",
		"space":        " 1",
		"trailing":     "1 ",
		"over":         "1.234",
		"exponent":     "1e3",
		"text":         "abc",
		"padded":       "085000",
		"grouped":      "1,5",
		"nan":          "NaN",
		"infinity":     "Infinity",
		"bare_dot":     "1.",
		"dotted":       "1.2.3",
		"wide":         "１",
		"nul":          "80\x001",
		"precision":    "99999999999.00",
	} {
		if _, err := pricing.ParseMoney(text); !errors.Is(err, pricing.ErrInvalid) {
			t.Fatalf("%s must be an invalid amount", name)
		}
	}
	// A canonical amount that was never admitted renders as nothing, so no record
	// validator can publish it.
	if got := pricing.Money("8500").String(); got != "" {
		t.Fatalf("a non-canonical amount must not render, got %q", got)
	}
}

// TestBranchPriceValidateWrite covers the pure write contract: the suggested price is
// never below the minimum, the branches are unique active ids and the warranty term
// stays inside its bound.
func TestBranchPriceValidateWrite(t *testing.T) {
	canonical, err := pricing.ValidateWrite(pricing.WriteInput{
		VariantID:      7,
		MinPrice:       "85000",
		SuggestedPrice: "96000.5",
		WarrantyMonths: intPtr(6),
		BranchIDs:      []int64{3, 2},
	})
	if err != nil {
		t.Fatalf("a valid assignment must be admitted: %v", err)
	}
	if canonical.MinPrice != "85000.00" || canonical.SuggestedPrice != "96000.50" ||
		len(canonical.BranchIDs) != 2 || canonical.BranchIDs[0] != 2 || canonical.BranchIDs[1] != 3 {
		t.Fatalf("the assignment must be canonical and branch-ordered: %+v", canonical)
	}
	// The same amount on both sides is admitted: the minimum is a floor, not a
	// strictly lower price.
	equal, err := pricing.ValidateWrite(pricing.WriteInput{VariantID: 1, MinPrice: "96000", SuggestedPrice: "96000.00", BranchIDs: []int64{2}})
	if err != nil || equal.MinPrice != equal.SuggestedPrice {
		t.Fatal("the suggested price may equal the minimum")
	}
	// An absent term is preserved, never defaulted by the domain.
	preserved, err := pricing.ValidateWrite(pricing.WriteInput{VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{2}})
	if err != nil || preserved.WarrantyMonths != nil {
		t.Fatal("an absent warranty term must stay absent")
	}
	fifty := make([]int64, 0, pricing.MaxBranches)
	for i := 0; i < pricing.MaxBranches; i++ {
		fifty = append(fifty, int64(i+2))
	}
	if _, err := pricing.ValidateWrite(pricing.WriteInput{VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: fifty}); err != nil {
		t.Fatalf("fifty branches must be admitted: %v", err)
	}
	overFifty := append(append([]int64{}, fifty...), 99)
	for name, in := range map[string]pricing.WriteInput{
		"zero_variant":         {VariantID: 0, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{2}},
		"negative_variant":     {VariantID: -1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{2}},
		"variant_above_int32":  {VariantID: 2147483648, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{2}},
		"suggested_below_min":  {VariantID: 1, MinPrice: "96000", SuggestedPrice: "85000", BranchIDs: []int64{2}},
		"suggested_zero":       {VariantID: 1, MinPrice: "85000", SuggestedPrice: "0", BranchIDs: []int64{2}},
		"min_negative":         {VariantID: 1, MinPrice: "-85000", SuggestedPrice: "85000", BranchIDs: []int64{2}},
		"min_precision":        {VariantID: 1, MinPrice: "85000.001", SuggestedPrice: "96000", BranchIDs: []int64{2}},
		"suggested_precision":  {VariantID: 1, MinPrice: "85000", SuggestedPrice: "96000.999", BranchIDs: []int64{2}},
		"min_empty":            {VariantID: 1, MinPrice: "", SuggestedPrice: "96000", BranchIDs: []int64{2}},
		"empty_branches":       {VariantID: 1, MinPrice: "1", SuggestedPrice: "1"},
		"too_many_branches":    {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: overFifty},
		"duplicate_branch":     {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{2, 2}},
		"warehouse_branch":     {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{1}},
		"zero_branch":          {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{0}},
		"negative_branch":      {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{-2}},
		"branch_above_small":   {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: []int64{32768}},
		"warranty_zero":        {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", WarrantyMonths: intPtr(0), BranchIDs: []int64{2}},
		"warranty_negative":    {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", WarrantyMonths: intPtr(-1), BranchIDs: []int64{2}},
		"warranty_above_bound": {VariantID: 1, MinPrice: "1", SuggestedPrice: "1", WarrantyMonths: intPtr(121), BranchIDs: []int64{2}},
	} {
		if _, err := pricing.ValidateWrite(in); !errors.Is(err, pricing.ErrInvalid) {
			t.Fatalf("%s must be refused by validation", name)
		}
	}
	// The caller's slice is never modified by validation.
	input := []int64{3, 2}
	if _, err := pricing.ValidateWrite(pricing.WriteInput{VariantID: 1, MinPrice: "1", SuggestedPrice: "1", BranchIDs: input}); err != nil {
		t.Fatal("a valid assignment must be admitted")
	}
	if input[0] != 3 || input[1] != 2 {
		t.Fatal("validation must not reorder the caller's branches")
	}
}

// TestBranchPriceValidQuery pins the read filter bounds before any SQL is sent.
func TestBranchPriceValidQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		query pricing.BranchQuery
		ok    bool
	}{
		"defaults":     {pricing.BranchQuery{Page: 1, PageSize: 10}, true},
		"all_filters":  {pricing.BranchQuery{Search: "ns60", Brand: "TOYO", Capacity: "45", Polarity: "L", Page: 2, PageSize: 25}, true},
		"capacity_dec": {pricing.BranchQuery{Capacity: "6.5", Page: 1, PageSize: 50}, true},
		"bound_page":   {pricing.BranchQuery{Page: 1_000_000, PageSize: 10}, true},
		"zero_page":    {pricing.BranchQuery{Page: 0, PageSize: 10}, false},
		"page_bound":   {pricing.BranchQuery{Page: 1_000_001, PageSize: 10}, false},
		"size":         {pricing.BranchQuery{Page: 1, PageSize: 15}, false},
		"zero_size":    {pricing.BranchQuery{Page: 1, PageSize: 0}, false},
		"polarity":     {pricing.BranchQuery{Polarity: "X", Page: 1, PageSize: 10}, false},
		"lowercase":    {pricing.BranchQuery{Polarity: "l", Page: 1, PageSize: 10}, false},
		"long_search":  {pricing.BranchQuery{Search: strings.Repeat("a", 129), Page: 1, PageSize: 10}, false},
		"nul_search":   {pricing.BranchQuery{Search: "a\x00b", Page: 1, PageSize: 10}, false},
		"bad_capacity": {pricing.BranchQuery{Capacity: "6,5", Page: 1, PageSize: 10}, false},
		"long_brand":   {pricing.BranchQuery{Brand: strings.Repeat("ñ", 129), Page: 1, PageSize: 10}, false},
	} {
		if got := pricing.ValidQuery(tc.query); got != tc.ok {
			t.Fatalf("%s must be %v", name, tc.ok)
		}
	}
}

func TestBranchPriceStoreGuards(t *testing.T) {
	ctx, p, s := fixture(t)
	in := pricing.WriteInput{VariantID: 1, MinPrice: "85000", SuggestedPrice: "96000", BranchIDs: []int64{2}}
	query := pricing.BranchQuery{Page: 1, PageSize: 10}
	nilPool := pricing.New(nil)
	var nilStore *pricing.Store
	// Every entry point fails closed on a missing context, pool or store.
	for name, call := range map[string]func() error{
		"matrix_nil_pool":  func() error { _, err := nilPool.Matrix(ctx, warehouse(), query); return err },
		"matrix_nil_ctx":   func() error { _, err := nilPool.Matrix(nil, warehouse(), query); return err },
		"matrix_nil_store": func() error { _, err := nilStore.Matrix(ctx, warehouse(), query); return err },
		"write_nil_pool":   func() error { _, err := nilPool.Write(ctx, warehouse(), in); return err },
		"write_nil_ctx":    func() error { _, err := nilPool.Write(nil, warehouse(), in); return err },
		"write_nil_store":  func() error { _, err := nilStore.Write(ctx, warehouse(), in); return err },
	} {
		if err := call(); !errors.Is(err, pricing.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
	pending := warehouse()
	pending.MustChangePassword = true
	for name, actor := range map[string]auth.Identity{
		"branch":          branch(),
		"branch_third":    {AccountID: 3, Location: auth.Location{ID: 3}},
		"warehouse_label": {AccountID: 2, Location: auth.Location{ID: 1}},
		"clerk":           {AccountID: 1, Location: auth.Location{ID: 2}},
		"unassigned":      {},
		"password_change": pending,
	} {
		before := snapshot(t, ctx, p)
		if _, err := s.Matrix(ctx, actor, query); !errors.Is(err, pricing.ErrForbidden) {
			t.Fatalf("%s matrix must be forbidden", name)
		}
		if _, err := s.Write(ctx, actor, in); !errors.Is(err, pricing.ErrForbidden) {
			t.Fatalf("%s write must be forbidden", name)
		}
		if snapshot(t, ctx, p) != before {
			t.Fatalf("%s must not change any stored value", name)
		}
	}
}

// TestBranchPriceWriteSingleBranch is the individual assignment: one branch receives
// the canonical pair and the warranty term is untouched while no term exists.
func TestBranchPriceWriteSingleBranch(t *testing.T) {
	ctx, p, s := fixture(t)
	result, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 3, MinPrice: "85000", SuggestedPrice: "96000", BranchIDs: []int64{2},
	})
	if err != nil {
		t.Fatalf("a single-branch assignment was not applied: %v", err)
	}
	if result.VariantID != 3 || len(result.BranchIDs) != 1 || result.BranchIDs[0] != 2 ||
		result.MinPrice != "85000.00" || result.SuggestedPrice != "96000.00" || result.WarrantyMonths != nil {
		t.Fatalf("applied assignment does not match the frozen contract: %+v", result)
	}
	min, suggested, account := storedPrice(t, ctx, p, 2, 3)
	if min != "85000.00" || suggested != "96000.00" || account != 1 {
		t.Fatalf("persisted pair mismatch: %s/%s by %d", min, suggested, account)
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM branch_prices"); n != 1 {
		t.Fatal("exactly one pair must be persisted")
	}
	// The second write replaces the pair in place: prices are never deleted.
	if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 3, MinPrice: "90000", SuggestedPrice: "90000", BranchIDs: []int64{2},
	}); err != nil {
		t.Fatalf("a replacement was not applied: %v", err)
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM branch_prices"); n != 1 {
		t.Fatal("a replacement must not append a second pair")
	}
	if min, suggested, _ := storedPrice(t, ctx, p, 2, 3); min != "90000.00" || suggested != "90000.00" {
		t.Fatalf("the pair was not replaced: %s/%s", min, suggested)
	}
}

// TestBranchPriceWriteBlockAtomicity proves the block assignment is one transaction:
// a bad branch anywhere in the list writes nothing and the existing pairs of a good
// branch stay exactly as they were.
func TestBranchPriceWriteBlockAtomicity(t *testing.T) {
	ctx, p, s := fixture(t)
	first, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 1, MinPrice: "1000", SuggestedPrice: "1200", BranchIDs: []int64{2},
	})
	if err != nil {
		t.Fatalf("the first assignment failed: %v", err)
	}
	if len(first.BranchIDs) != 1 {
		t.Fatal("the first assignment is a single branch")
	}
	before := snapshot(t, ctx, p)
	for name, in := range map[string]pricing.WriteInput{
		"unknown_branch":  {VariantID: 1, MinPrice: "2000", SuggestedPrice: "2500", BranchIDs: []int64{2, 99}},
		"warehouse_first": {VariantID: 1, MinPrice: "2000", SuggestedPrice: "2500", BranchIDs: []int64{1, 2}},
		"duplicate":       {VariantID: 1, MinPrice: "2000", SuggestedPrice: "2500", BranchIDs: []int64{2, 2}},
		"unknown_variant": {VariantID: 300, MinPrice: "2000", SuggestedPrice: "2500", BranchIDs: []int64{2}},
	} {
		if _, err := s.Write(ctx, warehouse(), in); !errors.Is(err, pricing.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
		if snapshot(t, ctx, p) != before {
			t.Fatalf("%s must not write anything", name)
		}
	}
	// The good pair of branch 2 keeps the first assignment.
	if min, suggested, _ := storedPrice(t, ctx, p, 2, 1); min != "1000.00" || suggested != "1200.00" {
		t.Fatalf("a refused block write changed an existing pair: %s/%s", min, suggested)
	}
	// The same variant, two branches, in one transaction and in branch order.
	block, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 1, MinPrice: "2000", SuggestedPrice: "2500", BranchIDs: []int64{3, 2},
	})
	if err != nil {
		t.Fatalf("a two-branch assignment was not applied: %v", err)
	}
	if len(block.BranchIDs) != 2 || block.BranchIDs[0] != 2 || block.BranchIDs[1] != 3 {
		t.Fatalf("the applied branches must be ordered and complete: %+v", block)
	}
	for _, id := range []int64{2, 3} {
		if min, suggested, account := storedPrice(t, ctx, p, id, 1); min != "2000.00" ||
			suggested != "2500.00" || account != 1 {
			t.Fatalf("branch %d did not receive the block pair: %s/%s", id, min, suggested)
		}
	}
	// Two branches of the same variant may hold different amounts.
	if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 1, MinPrice: "3000", SuggestedPrice: "3300", BranchIDs: []int64{3},
	}); err != nil {
		t.Fatalf("a divergent branch assignment failed: %v", err)
	}
	if min, _, _ := storedPrice(t, ctx, p, 2, 1); min != "2000.00" {
		t.Fatalf("writing one branch must not touch another: %s", min)
	}
	if min, suggested, _ := storedPrice(t, ctx, p, 3, 1); min != "3000.00" || suggested != "3300.00" {
		t.Fatalf("the divergent branch was not written: %s/%s", min, suggested)
	}
}

// TestBranchPriceWriteRetiredBranch names the offending branch: the whole block is
// refused and no pair of the still-valid branch is touched.
func TestBranchPriceWriteRetiredBranch(t *testing.T) {
	ctx, p, s := fixture(t)
	retired := createBranch(t, ctx, p, "Sucursal C")
	if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 2, MinPrice: "5000", SuggestedPrice: "6000", BranchIDs: []int64{2, retired},
	}); err != nil {
		t.Fatalf("the active assignment failed: %v", err)
	}
	retireBranch(t, ctx, p, retired)
	before := snapshot(t, ctx, p)
	_, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 2, MinPrice: "7000", SuggestedPrice: "8000", BranchIDs: []int64{2, retired},
	})
	var refused *pricing.RetiredBranch
	if !errors.As(err, &refused) || refused.BranchID != retired {
		t.Fatalf("a retired branch must be named by its id: %v", err)
	}
	if !errors.Is(err, pricing.ErrInvalid) {
		t.Fatal("a retired branch is an invalid request")
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a retired branch must refuse the whole block without writing anything")
	}
	if min, _, _ := storedPrice(t, ctx, p, 2, 2); min != "5000.00" {
		t.Fatalf("a refused block changed the valid branch: %s", min)
	}
	// The retired branch can still be read as an active branch id? No: it is gone
	// from the branch list of the matrix.
	matrix, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("matrix read failed: %v", err)
	}
	for _, item := range matrix.Branches {
		if item.ID == retired {
			t.Fatal("a retired branch must not be listed")
		}
	}
}

// TestBranchPriceWriteWarranty pins the product datum: a term is written with the
// prices, an omitted term preserves the stored one, and the response always reports
// the term in force.
func TestBranchPriceWriteWarranty(t *testing.T) {
	ctx, p, s := fixture(t)
	written, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 4, MinPrice: "10000", SuggestedPrice: "12000", WarrantyMonths: intPtr(6), BranchIDs: []int64{2},
	})
	if err != nil {
		t.Fatalf("a term with prices was not applied: %v", err)
	}
	if written.WarrantyMonths == nil || *written.WarrantyMonths != 6 {
		t.Fatalf("the written term must be reported: %+v", written)
	}
	if got := storedWarranty(t, ctx, p, 4); got == nil || *got != 6 {
		t.Fatal("the warranty term must be persisted")
	}
	// Omitted: the stored term is preserved, not erased and not defaulted.
	preserved, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 4, MinPrice: "11000", SuggestedPrice: "13000", BranchIDs: []int64{2},
	})
	if err != nil {
		t.Fatalf("an assignment without a term was not applied: %v", err)
	}
	if preserved.WarrantyMonths == nil || *preserved.WarrantyMonths != 6 {
		t.Fatalf("an omitted term must preserve the stored one: %+v", preserved)
	}
	// Present: replaced, still one row per variant.
	replaced, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 4, MinPrice: "11000", SuggestedPrice: "13000", WarrantyMonths: intPtr(12), BranchIDs: []int64{2},
	})
	if err != nil || replaced.WarrantyMonths == nil || *replaced.WarrantyMonths != 12 {
		t.Fatalf("a replacement term was not applied: %+v %v", replaced, err)
	}
	if n := scalar(t, ctx, p, "SELECT count(*) FROM variant_warranties WHERE variant_id=$1", 4); n != 1 {
		t.Fatal("a variant keeps exactly one warranty term")
	}
	before := snapshot(t, ctx, p)
	for name, months := range map[string]int{"zero": 0, "above_bound": 121, "negative": -1} {
		if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
			VariantID: 4, MinPrice: "11000", SuggestedPrice: "13000", WarrantyMonths: &months, BranchIDs: []int64{2},
		}); !errors.Is(err, pricing.ErrInvalid) {
			t.Fatalf("%s term must be refused", name)
		}
	}
	if snapshot(t, ctx, p) != before {
		t.Fatal("a refused term must not change any stored value")
	}
}

// TestBranchPriceMatrixShape pins the read contract: the catalogue identity of every
// variant, its null term when it has none and the canonical prices of each branch.
func TestBranchPriceMatrixShape(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := s.Write(ctx, warehouse(), pricing.WriteInput{
		VariantID: 1, MinPrice: "85000", SuggestedPrice: "96000.5", WarrantyMonths: intPtr(6), BranchIDs: []int64{3, 2},
	}); err != nil {
		t.Fatalf("matrix fixture assignment failed: %v", err)
	}
	matrix, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("matrix read failed: %v", err)
	}
	if matrix.Page != 1 || matrix.PageSize != 10 || matrix.TotalVariants != 190 || len(matrix.Variants) != 10 {
		t.Fatalf("matrix page does not match the frozen contract: %+v", matrix)
	}
	if len(matrix.Branches) != 2 || matrix.Branches[0].ID != 2 || matrix.Branches[0].Name != "Sucursal A" ||
		matrix.Branches[1].ID != 3 || matrix.Branches[1].Name != "Sucursal B" {
		t.Fatalf("branches must be the active branches in id order: %+v", matrix.Branches)
	}
	var displayName string
	if p.QueryRow(ctx, "SELECT display_name FROM auth_accounts WHERE id=1").Scan(&displayName) != nil {
		t.Fatal("display name read failed")
	}
	first := matrix.Variants[0]
	if first.VariantID != 1 || first.CatalogEntryID != 1 || first.Brand == "" || first.Model == "" ||
		first.Capacity == "" || (first.Polarity != "L" && first.Polarity != "R") || len(first.Cells) != 3 {
		t.Fatalf("matrix row does not carry the catalogue identity: %+v", first)
	}
	if first.WarrantyMonths == nil || *first.WarrantyMonths != 6 || first.WarrantyAt == nil || first.WarrantyAt.IsZero() {
		t.Fatalf("matrix row does not carry the warranty term in force: %+v", first)
	}
	if len(first.Prices) != 2 {
		t.Fatalf("both branches must carry the pair: %+v", first.Prices)
	}
	for i, price := range first.Prices {
		branchID := []int64{2, 3}[i]
		if price.BranchLocationID != branchID || price.MinPrice != "85000.00" || price.SuggestedPrice != "96000.50" ||
			price.UpdatedAt.IsZero() || price.UpdatedByAccountID != 1 || price.UpdatedByDisplayName != displayName {
			t.Fatalf("matrix price %d does not match the persisted pair: %+v", i, price)
		}
	}
	// A variant without a term and without prices reports nulls and an empty list,
	// never an invented default.
	second := matrix.Variants[1]
	if second.WarrantyMonths != nil || second.WarrantyAt != nil {
		t.Fatalf("a variant without a term must report null: %+v", second)
	}
	if second.Prices == nil || len(second.Prices) != 0 {
		t.Fatalf("a variant without prices must report an empty list: %+v", second.Prices)
	}
	// Cells come from the preloaded source catalogue of this entry.
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("catalogue source load failed")
	}
	if strings.Join(first.Cells, ",") != strings.Join(source.Entries[0].Cells, ",") {
		t.Fatalf("matrix cells do not match the source entry: %+v", first.Cells)
	}
}

// TestBranchPriceMatrixFiltersAndPagination walks every admitted page size and pins
// the literal filters of the read contract.
func TestBranchPriceMatrixFiltersAndPagination(t *testing.T) {
	ctx, _, s := fixture(t)
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("catalogue source load failed")
	}
	for _, size := range []int{10, 25, 50} {
		seen := map[int64]bool{}
		for index := 1; (index-1)*size < 190; index++ {
			page, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{Page: index, PageSize: size})
			if err != nil || page.TotalVariants != 190 || page.Page != index || page.PageSize != size {
				t.Fatalf("matrix pagination contract failed for size %d", size)
			}
			want := size
			if 190-(index-1)*size < size {
				want = 190 - (index-1)*size
			}
			if len(page.Variants) != want {
				t.Fatalf("matrix page %d of size %d has the wrong length", index, size)
			}
			for i, item := range page.Variants {
				id := int64((index-1)*size + i + 1)
				if seen[id] || item.VariantID != id {
					t.Fatalf("matrix page %d of size %d is not the stable variant order", index, size)
				}
				seen[id] = true
			}
		}
		if len(seen) != 190 {
			t.Fatalf("matrix pagination of size %d lost a variant", size)
		}
	}
	empty, err := s.Matrix(ctx, warehouse(), pricing.BranchQuery{Page: 1_000_000, PageSize: 50})
	if err != nil || len(empty.Variants) != 0 || empty.Variants == nil || empty.TotalVariants != 190 {
		t.Fatal("an empty matrix page must be non-null and keep the total")
	}
	for name, q := range map[string]pricing.BranchQuery{
		"model_search":       {Search: "moto"},
		"capacity_comma":     {Search: "6,5"},
		"capacity_dot":       {Search: "6.5"},
		"literal_percent":    {Search: "%"},
		"literal_underscore": {Search: "_"},
		"literal_backslash":  {Search: `\`},
		"injection_attempt":  {Search: "' OR 1=1 --"},
		"brand":              {Brand: source.Entries[0].Brand},
		"polarity":           {Polarity: "R"},
		"capacity":           {Capacity: catalog.Decimal(source.Entries[0].Capacity)},
		"brand_capacity":     {Brand: source.Entries[0].Brand, Capacity: catalog.Decimal(source.Entries[0].Capacity)},
		"case_insensitive":   {Search: strings.ToUpper(source.Entries[0].Brand), Polarity: "R"},
	} {
		q.Page, q.PageSize = 1, 50
		want := []int64{}
		for _, entry := range source.Entries {
			if q.Brand != "" && q.Brand != entry.Brand {
				continue
			}
			if q.Capacity != "" && q.Capacity != entry.Capacity {
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
		result, err := s.Matrix(ctx, warehouse(), q)
		if err != nil || result.TotalVariants != int64(len(want)) {
			t.Fatalf("%s filter did not count the matching variants", name)
		}
		limit := len(want)
		if limit > 50 {
			limit = 50
		}
		if len(result.Variants) != limit {
			t.Fatalf("%s filter returned %d variants, want %d", name, len(result.Variants), limit)
		}
		for i, item := range result.Variants {
			if item.VariantID != want[i] {
				t.Fatalf("%s filter is not the stable variant order", name)
			}
		}
	}
}
