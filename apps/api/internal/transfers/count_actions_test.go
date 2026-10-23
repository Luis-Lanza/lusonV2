package transfers_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

// Observe all public evidence before and after the aggregate, including inventory
// pages at every location. Reads must not rewrite original receipts or histories.
func requiredActionsCheck(t *testing.T, ctx context.Context, p *pgxpool.Pool, s *transfers.Store, r transfers.Request, want [3]transfers.ActionBreakdown) {
	t.Helper()
	observe := func() []any {
		t.Helper()
		var out []any
		for who := 1; who <= 3; who++ {
			page, err := s.List(ctx, actor(who), transfers.Query{Status: "all"})
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, page)
			for pageNumber := 1; pageNumber <= 4; pageNumber++ {
				stock, err := inventory.New(p).List(ctx, actor(who), inventory.Query{LocationID: who, Page: pageNumber, PageSize: 50})
				if err != nil {
					t.Fatal(err)
				}
				out = append(out, stock)
			}
		}
		for _, who := range []int{r.Origin.ID, r.Destination.ID} {
			detail, err := s.Get(ctx, actor(who), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			counts, err := s.GetCountCorrections(ctx, actor(who), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			restitutions, err := s.GetRestitutions(ctx, actor(who), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, detail, counts, restitutions)
		}
		return out
	}
	before := observe()
	for who, expected := range want {
		// These fixtures contain one received transfer: overlapping reviews
		// must still count one header, not the sum of category totals.
		actions := int64(0)
		if expected != (transfers.ActionBreakdown{}) {
			actions = 1
		}
		wantTotals := transfers.Totals{ActionCount: actions, Actions: expected}
		got, err := s.Counts(ctx, actor(who+1))
		if err != nil || got != wantTotals {
			t.Errorf("actor %d totals=%+v want=%+v error=%v", who+1, got, wantTotals, err)
		}
	}
	if !reflect.DeepEqual(before, observe()) {
		t.Fatal("counts changed public list/detail/receipt/history/inventory")
	}
}

func TestRequiredActionsCountReviews(t *testing.T) {
	ctx, p, r := c2BranchReceipt(t)
	s := transfers.New(p)
	check := func(want [3]transfers.ActionBreakdown) {
		t.Helper()
		requiredActionsCheck(t, ctx, p, s, r, want)
	}
	check([3]transfers.ActionBreakdown{}) // discrepancies and voluntary proposals are not work
	for _, variant := range []int64{1, 2, 3} {
		c2StorePropose(t, ctx, s, r, r.Origin.ID, variant, 0, 1, fmt.Sprintf("actions-count-propose-%d", variant))
	}
	check([3]transfers.ActionBreakdown{{}, {ReviewCount: 1}, {}}) // three lines count once
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 1, 0, "actions-count-replacement")
	check([3]transfers.ActionBreakdown{{}, {ReviewCount: 1}, {}})
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 2, false, "actions-count-reject-head")
	for _, variant := range []int64{2, 3} {
		c2StoreDecide(t, ctx, s, r, r.Destination.ID, variant, 1, true, fmt.Sprintf("actions-count-accept-%d", variant))
	}
	check([3]transfers.ActionBreakdown{}) // superseded undecided revision must not resurface
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 2, 1, "actions-count-reverse-propose")
	check([3]transfers.ActionBreakdown{{}, {}, {ReviewCount: 1}})
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 3, true, "actions-count-reverse-accept")
	check([3]transfers.ActionBreakdown{})
}

func TestRequiredActionsRestitutionReviews(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 2)
	s := transfers.New(p)
	check := func(want [3]transfers.ActionBreakdown) {
		t.Helper()
		requiredActionsCheck(t, ctx, p, s, r, want)
	}
	propose := func(key string, revision int64) {
		t.Helper()
		if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal(key, revision, 1)); err != nil {
			t.Fatal(err)
		}
	}
	decide := func(key string, revision int64, accept bool) {
		t.Helper()
		if _, err := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision(key, revision, accept)); err != nil {
			t.Fatal(err)
		}
	}
	check([3]transfers.ActionBreakdown{})
	propose("actions-restitution-first", 0)
	check([3]transfers.ActionBreakdown{{}, {ReviewRestitution: 1}, {}})
	propose("actions-restitution-replace", 1)
	check([3]transfers.ActionBreakdown{{}, {ReviewRestitution: 1}, {}})
	// Pending count blocks acceptance, not restitution rejection/review.
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 3, "actions-overlapping-count")
	check([3]transfers.ActionBreakdown{{}, {ReviewCount: 1, ReviewRestitution: 1}, {}})
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 1, true, "actions-overlapping-accept")
	check([3]transfers.ActionBreakdown{{}, {ReviewRestitution: 1}, {}}) // stale pin
	decide("actions-stale-restitution-reject", 2, false)
	check([3]transfers.ActionBreakdown{})
	propose("actions-restitution-fresh", 2)
	check([3]transfers.ActionBreakdown{{}, {ReviewRestitution: 1}, {}})
	decide("actions-restitution-accept", 3, true)
	check([3]transfers.ActionBreakdown{})
}
