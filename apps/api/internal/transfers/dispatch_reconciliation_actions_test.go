package transfers_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

const discoveryReason = "review_dispatch_reconciliation"

// Observe only public reads, including immutable receipt and reconciliation history.
func discoveryUnchanged(t *testing.T, ctx context.Context, p *pgxpool.Pool, s *transfers.Store, r transfers.Request) func() {
	t.Helper()
	observe := func() []any {
		t.Helper()
		detail, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
		if err != nil {
			t.Fatal(err)
		}
		counts, err := s.GetCountCorrections(ctx, actor(r.Origin.ID), r.ID)
		if err != nil {
			t.Fatal(err)
		}
		restitution, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
		if err != nil {
			t.Fatal(err)
		}
		return []any{detail, counts, restitution, dr2Read(t, ctx, s, r), dr2Counts(t, ctx, s), dr1Inventory(t, ctx, p)}
	}
	before := observe()
	return func() {
		t.Helper()
		if !reflect.DeepEqual(before, observe()) {
			t.Error("discovery/rejected input changed public receipt, histories, inventory or counters")
		}
	}
}

func discoveryCheck(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request, who int, reasons []string) {
	t.Helper()
	want := int64(0)
	if len(reasons) != 0 {
		want = 1
	}
	page, err := s.List(ctx, actor(who), transfers.Query{Status: "all", RequiresAction: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != want || int64(len(page.Records)) != want || int64(len(page.RequiredActions)) != want || !page.RequiresAction {
		t.Errorf("actor %d filtered page=%+v, want %d header", who, page, want)
	}
	if want == 1 && (!reflect.DeepEqual(page.RequiredActions[r.ID], reasons) || len(page.Records) != 1 || !t10ListEqual(t, page.Records, []transfers.Request{r})) {
		t.Errorf("actor %d reasons=%v want=%v; canonical receipt must be retained", who, page.RequiredActions[r.ID], reasons)
	}
	counts, err := s.Counts(ctx, actor(who))
	if err != nil {
		t.Fatal(err)
	}
	if counts.PendingTotal != 0 || counts.ActionCount != want {
		t.Errorf("actor %d counts=%+v, want pending=0 union=%d", who, counts, want)
	}
	// JSON over the exported public value avoids referring to a not-yet-added field.
	raw, err := json.Marshal(counts.Actions)
	if err != nil {
		t.Fatal(err)
	}
	var categories map[string]int64
	if err := json.Unmarshal(raw, &categories); err != nil {
		t.Fatal(err)
	}
	wantCategories := map[string]int64{"Approve": 0, "Dispatch": 0, "Receive": 0, "ReviewCount": 0, "ReviewRestitution": 0, "ReviewDispatchReconciliation": 0}
	for _, reason := range reasons {
		field := map[string]string{"review_count": "ReviewCount", "review_restitution": "ReviewRestitution", discoveryReason: "ReviewDispatchReconciliation"}[reason]
		wantCategories[field] = 1
	}
	if !reflect.DeepEqual(categories, wantCategories) {
		t.Errorf("actor %d categories=%v want=%v", who, categories, wantCategories)
	}
}

func TestDRDiscoveryStoreCounterpart(t *testing.T) {
	for _, proposer := range []int{1, 2} {
		t.Run(fmt.Sprintf("proposer_%d_counterpart_%d", proposer, 3-proposer), func(t *testing.T) {
			ctx, p, s, r := dr2Fixture(t)
			dr2Propose(t, ctx, s, r, proposer, 0, 7, "discovery-counterpart")
			defer discoveryUnchanged(t, ctx, p, s, r)()
			discoveryCheck(t, ctx, s, r, 3-proposer, []string{discoveryReason})
			discoveryCheck(t, ctx, s, r, proposer, nil)
			discoveryCheck(t, ctx, s, r, 3, nil)
			for _, who := range []int{0, 4} {
				if _, err := s.List(ctx, actor(who), transfers.Query{Status: "all", RequiresAction: true}); err != transfers.ErrForbidden {
					t.Errorf("unassigned list: %v", err)
				}
				if _, err := s.Counts(ctx, actor(who)); err != transfers.ErrForbidden {
					t.Errorf("unassigned counts: %v", err)
				}
			}
			if _, err := s.GetDispatchReconciliations(ctx, actor(3), r.ID); err != transfers.ErrNotFound {
				t.Errorf("private history: %v", err)
			}
			if _, err := s.ProposeDispatchReconciliation(ctx, actor(proposer), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: 2, OperationKey: "discovery-unexpected-line", DispatchQuantity: 1, Reason: "unexpected"}); err != transfers.ErrInvalid {
				t.Errorf("unexpected receipt line admitted: %v", err)
			}
		})
	}
}

func TestDRDiscoveryStoreStaleOverlap(t *testing.T) {
	t.Run("stale_count_and_applied_restitution_remain_rejectable", func(t *testing.T) {
		ctx, p, s, r := dr2Fixture(t)
		dr2Propose(t, ctx, s, r, 1, 0, 7, "discovery-stale")
		c2StorePropose(t, ctx, s, r, 2, 1, 0, 4, "discovery-count-four")
		c2StoreDecide(t, ctx, s, r, 1, 1, 1, true, "discovery-count-accept")
		if _, err := s.ProposeRestitution(ctx, actor(1), r.ID, r3Proposal("discovery-retain-propose", 0, 1)); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("discovery-retain-accept", 1, true)); err != nil {
			t.Fatal(err)
		}
		unchanged := discoveryUnchanged(t, ctx, p, s, r)
		discoveryCheck(t, ctx, s, r, 2, []string{discoveryReason})
		if _, err := s.DecideDispatchReconciliation(ctx, actor(2), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "discovery-stale-accept", ExpectedRevision: 1, Accept: true, Reason: "stale"}); err != transfers.ErrDecisionConflict {
			t.Errorf("stale accept: %v", err)
		}
		unchanged()
		if _, err := s.DecideDispatchReconciliation(ctx, actor(2), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "discovery-stale-reject", ExpectedRevision: 1, Reason: "declined"}); err != nil {
			t.Fatal(err)
		}
		discoveryCheck(t, ctx, s, r, 2, nil)
	})
	t.Run("reserved_stock_does_not_hide_rejectable_work", func(t *testing.T) {
		ctx, p, s, r := dr2Fixture(t)
		dr2Propose(t, ctx, s, r, 1, 0, 7, "discovery-stock")
		in := input()
		in.RetryKey = "discovery-reserve-stock"
		in.Items = []transfers.Line{{VariantID: 1, Quantity: 14}}
		reserved := create(t, ctx, s, 2, in).Request
		if _, err := s.Approve(ctx, actor(1), reserved.ID); err != nil {
			t.Fatal(err)
		}
		unchanged := discoveryUnchanged(t, ctx, p, s, r)
		discoveryCheck(t, ctx, s, r, 2, []string{discoveryReason})
		if _, err := s.DecideDispatchReconciliation(ctx, actor(2), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "discovery-stock-accept", ExpectedRevision: 1, Accept: true, Reason: "reserved"}); err != transfers.ErrInsufficientStock {
			t.Errorf("reserved stock accept: %v", err)
		}
		unchanged()
		if _, err := s.DecideDispatchReconciliation(ctx, actor(2), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "discovery-stock-reject", ExpectedRevision: 1, Reason: "declined"}); err != nil {
			t.Fatal(err)
		}
		discoveryCheck(t, ctx, s, r, 2, nil)
	})
	t.Run("multiple_lines_and_overlapping_categories_count_one_header", func(t *testing.T) {
		ctx, p, s := fixture(t)
		in := input()
		in.Items = []transfers.Line{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 2}}
		r := receiptDispatch(t, ctx, s, in)
		r, err := s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}, {VariantID: 2, Quantity: 1}}})
		if err != nil {
			t.Fatal(err)
		}
		for _, variant := range []int64{1, 2} {
			if _, err := s.ProposeDispatchReconciliation(ctx, actor(1), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: variant, OperationKey: fmt.Sprintf("discovery-multiline-%d", variant), DispatchQuantity: 1, Reason: "verified"}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.ProposeRestitution(ctx, actor(1), r.ID, r3Proposal("discovery-overlap-retain", 0, 1)); err != nil {
			t.Fatal(err)
		}
		c2StorePropose(t, ctx, s, r, 1, 1, 0, 0, "discovery-overlap-count")
		defer discoveryUnchanged(t, ctx, p, s, r)()
		discoveryCheck(t, ctx, s, r, 2, []string{"review_count", "review_restitution", discoveryReason})
		discoveryCheck(t, ctx, s, r, 1, nil)
	})
}

func TestDRDiscoveryStoreLatestPagination(t *testing.T) {
	for _, decided := range []bool{false, true} {
		t.Run(fmt.Sprintf("latest_decided_%t", decided), func(t *testing.T) {
			ctx, p, s, r := dr2Fixture(t)
			dr2Propose(t, ctx, s, r, 1, 0, 7, "discovery-old")
			dr2Propose(t, ctx, s, r, 1, 1, 7, "discovery-latest")
			if decided {
				if _, err := s.DecideDispatchReconciliation(ctx, actor(2), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "discovery-latest-reject", ExpectedRevision: 2, Reason: "declined"}); err != nil {
					t.Fatal(err)
				}
			}
			// Latest ownership, not any historical undecided proposal, controls membership.
			want := []string{discoveryReason}
			if decided {
				want = nil
			}
			discoveryCheck(t, ctx, s, r, 2, want)
			discoveryCheck(t, ctx, s, r, 1, nil)
			for i := 0; i < 11; i++ {
				in := input()
				in.RetryKey = fmt.Sprintf("discovery-newer-%03d", i)
				create(t, ctx, s, 2, in)
			}
			defer discoveryUnchanged(t, ctx, p, s, r)()
			for _, pageNumber := range []int64{1, 2} {
				page, err := s.List(ctx, actor(2), transfers.Query{Status: "all", RequiresAction: true, Page: pageNumber, PageSize: 10})
				total, rows := int64(1), 1
				if decided {
					total = 0
				}
				if decided || pageNumber == 2 {
					rows = 0
				}
				if err != nil || page.Total != total || len(page.Records) != rows || len(page.RequiredActions) != rows {
					t.Errorf("filtered pagination: %+v error=%v want total=%d rows=%d", page, err, total, rows)
				}
			}
		})
	}
}
