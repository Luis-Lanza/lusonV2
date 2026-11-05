package transfers_test

import (
	"fmt"
	"math"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestURActionsCounterpartyAndTerminal(t *testing.T) {
	for _, proposer := range []int{1, 2} {
		t.Run(fmt.Sprint(proposer), func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 10, 8)
			s := transfers.New(p)
			check := func(pending bool) {
				t.Helper()
				for _, who := range []int{1, 2, 3} {
					want := int64(0)
					if pending && who == 3-proposer {
						want = 1
					}
					counts, e := s.Counts(ctx, actor(who))
					if e != nil {
						t.Fatal(e)
					}
					// Reflect permits a behavioral RED before adding the new exported field.
					field := reflect.ValueOf(counts.Actions).FieldByName("ReviewUnifiedReconciliation")
					if !field.IsValid() || field.Int() != want || counts.ActionCount != want || counts.PendingTotal != 0 {
						t.Errorf("actor %d counts=%+v want %d", who, counts, want)
					}
					page, e := s.List(ctx, actor(who), transfers.Query{Status: "all", RequiresAction: true})
					if e != nil {
						t.Fatal(e)
					}
					if page.Total != want || int64(len(page.Records)) != want {
						t.Errorf("actor %d page=%+v want %d", who, page, want)
					}
					if want == 1 && !reflect.DeepEqual(page.RequiredActions[r.ID], []string{"review_unified_reconciliation"}) {
						t.Errorf("reasons=%v", page.RequiredActions)
					}
				}
			}
			in := urProposal("ur-actions-proposal")
			in.RetainedQuantity, in.RetainedAtOrigin = 0, false
			in.DispatchQuantity = math.MaxInt64
			if _, e := s.ProposeUnifiedReconciliation(ctx, actor(proposer), r.ID, in); e != nil {
				t.Fatal(e)
			}
			check(true)
			before := urObserve(t, ctx, p, s, r)
			decision := urDecision("ur-actions-stock-accept")
			if _, e := s.DecideUnifiedReconciliation(ctx, actor(3-proposer), r.ID, decision); e != transfers.ErrInsufficientStock {
				t.Fatal(e)
			}
			if before != urObserve(t, ctx, p, s, r) {
				t.Fatal("failed acceptance changed state")
			}
			check(true)
			in.OperationKey, in.ExpectedRevision = "ur-actions-replacement", 1
			if _, e := s.ProposeUnifiedReconciliation(ctx, actor(proposer), r.ID, in); e != nil {
				t.Fatal(e)
			}
			check(true)
			decision.OperationKey, decision.ExpectedRevision, decision.Accept = "ur-actions-reject", 2, false
			if _, e := s.DecideUnifiedReconciliation(ctx, actor(3-proposer), r.ID, decision); e != nil {
				t.Fatal(e)
			}
			check(false)
		})
	}
}

func TestURActionsStaleGeneration(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 9, "ur-actions-legacy-count")
	in := urProposal("ur-actions-stale-proposal")
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, in); e != nil {
		t.Fatal(e)
	}
	// Legacy rejection changes the predecessor, not the unified obligation.
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, false, "ur-actions-legacy-reject")
	counts, e := s.Counts(ctx, actor(r.Destination.ID))
	if e != nil {
		t.Fatal(e)
	}
	page, e := s.List(ctx, actor(r.Destination.ID), transfers.Query{Status: "all", RequiresAction: true})
	if e != nil || counts.ActionCount != 1 || page.Total != 1 || !reflect.DeepEqual(page.RequiredActions[r.ID], []string{"review_unified_reconciliation"}) {
		t.Fatal(counts, page, e)
	}
	before := urObserve(t, ctx, p, s, r)
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur-actions-stale-accept")); e != transfers.ErrDecisionConflict || before != urObserve(t, ctx, p, s, r) {
		t.Fatal("stale acceptance effects", e)
	}
	reject := urDecision("ur-actions-stale-reject")
	reject.Accept = false
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, reject); e != nil {
		t.Fatal(e)
	}
	counts, e = s.Counts(ctx, actor(r.Destination.ID))
	if e != nil || counts.ActionCount != 0 {
		t.Fatal(counts, e)
	}
}
