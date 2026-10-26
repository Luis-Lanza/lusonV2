package transfers_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

func dr2Fixture(t *testing.T) (context.Context, *pgxpool.Pool, *transfers.Store, transfers.Request) {
	t.Helper()
	ctx, p, s := fixture(t)
	a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=CASE location_id WHEN 1 THEN 20 ELSE 10 END WHERE variant_id=1 AND location_id IN (1,2)`)
	dr1Balances(t, ctx, p, 20, 10)
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 5}}
	r := receiptDispatch(t, ctx, s, in)
	r, err := s.Receive(ctx, actor(r.Destination.ID), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 7}, {VariantID: 2, Quantity: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	dr1Balances(t, ctx, p, 15, 15)
	return ctx, p, s, r
}

func dr2Read(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request) transfers.DispatchReconciliations {
	t.Helper()
	got, err := s.GetDispatchReconciliations(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// Observe participant-visible counters, not internal ledger tables.
func dr2Counts(t *testing.T, ctx context.Context, s *transfers.Store) [3]transfers.Totals {
	t.Helper()
	var totals [3]transfers.Totals
	for i := range totals {
		got, err := s.Counts(ctx, actor(i+1))
		if err != nil {
			t.Fatal("public transfer counters", err)
		}
		totals[i] = got
	}
	return totals
}

func dr2Propose(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request, who int, rev, q int64, key string) transfers.DispatchReconciliationOperation {
	t.Helper()
	got, err := s.ProposeDispatchReconciliation(ctx, actor(who), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: 1, OperationKey: "dispatch-store-" + key, ExpectedRevision: rev, DispatchQuantity: q, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func dr2Decide(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request, who int, rev int64, key string) transfers.DispatchReconciliationOperation {
	t.Helper()
	got, err := s.DecideDispatchReconciliation(ctx, actor(who), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "dispatch-store-" + key, ExpectedRevision: rev, Accept: true, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestDR2StoreReadSnapshot(t *testing.T) {
	ctx, p, s, r := dr2Fixture(t)
	got := dr2Read(t, ctx, s, r)
	if len(got.Lines) != 1 || got.Operations == nil {
		t.Fatal(got)
	}
	l := got.Lines[0]
	if l.ExpectedQuantity != 5 || l.OriginalActual != 7 || l.OriginalCredit != 5 || l.EffectiveDispatch != 5 || l.EffectiveActual != 7 || l.EffectiveCredit != 5 || l.Proposals == nil {
		t.Fatal(l)
	}
	before := dr1Inventory(t, ctx, p)
	dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "dr2-p")
	if !reflect.DeepEqual(before, dr1Inventory(t, ctx, p)) {
		t.Fatal("pending stock changed")
	}
	got = dr2Read(t, ctx, s, r)
	if got.Lines[0].WorkflowRevision != 1 || got.Lines[0].ReconciliationGeneration != 1 || got.Lines[0].Proposals[0].State != "pending" {
		t.Fatal(got)
	}
	if err := s.CheckDispatchReconciliationAccess(ctx, actor(r.Destination.ID), r.ID); err != nil {
		t.Fatal(err)
	}
}

func TestDR2StoreMutationGuards(t *testing.T) {
	ctx, p, s, r := dr2Fixture(t)
	dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "dr2-p")
	before := dr2Read(t, ctx, s, r)
	stock := dr1Inventory(t, ctx, p)
	counters := dr2Counts(t, ctx, s)
	for _, tc := range []struct {
		name string
		who  int
		in   transfers.DispatchReconciliationDecisionInput
		want error
	}{
		{"private malformed", 3, transfers.DispatchReconciliationDecisionInput{}, transfers.ErrNotFound},
		{"invalid", r.Destination.ID, transfers.DispatchReconciliationDecisionInput{}, transfers.ErrInvalid},
		{"wrong role", r.Origin.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "dispatch-store-wrong", ExpectedRevision: 1, Accept: true, Reason: "verified"}, transfers.ErrForbidden},
		{"stale", r.Destination.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "dispatch-store-stale", ExpectedRevision: 0, Accept: true, Reason: "verified"}, transfers.ErrDecisionConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.DecideDispatchReconciliation(ctx, actor(tc.who), r.ID, tc.in); err != tc.want {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
	if _, err := s.ProposeDispatchReconciliation(ctx, actor(r.Origin.ID), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: 2, OperationKey: "dispatch-store-unexpected", DispatchQuantity: 7, Reason: "verified"}); err != transfers.ErrInvalid {
		t.Fatal(err)
	}
	if _, err := s.ProposeDispatchReconciliation(ctx, actor(r.Origin.ID), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: 1, OperationKey: "dispatch-store-not-equal", ExpectedRevision: 1, DispatchQuantity: 8, Reason: "verified"}); err != transfers.ErrInvalid {
		t.Fatal(err)
	}
	if _, err := s.ProposeDispatchReconciliation(ctx, actor(r.Origin.ID), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: 1, OperationKey: "dispatch-store-dr2-p", DispatchQuantity: 6, Reason: "verified"}); err != transfers.ErrRetryConflict {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, dr2Read(t, ctx, s, r)) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counters != dr2Counts(t, ctx, s) {
		t.Fatal("rejection changed evidence/stock/counters")
	}
	if _, err := s.GetDispatchReconciliations(ctx, actor(3), r.ID); err != transfers.ErrNotFound {
		t.Fatal(err)
	}
	if err := s.CheckDispatchReconciliationAccess(ctx, actor(3), r.ID); err != transfers.ErrNotFound {
		t.Fatal(err)
	}
	op, err := s.DecideDispatchReconciliation(ctx, actor(r.Destination.ID), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "dispatch-store-reject", ExpectedRevision: 1, Reason: "declined"})
	if err != nil || op.Action != "reject" || dr2Read(t, ctx, s, r).Lines[0].Proposals[0].State != "rejected" || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal(op, err)
	}
}

func TestDR2StoreMutationRestitutionExcluded(t *testing.T) {
	ctx, p, s, r := dr2Fixture(t)
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 4, "dispatch-store-count-four")
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "dispatch-store-count-four-accept")
	if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, transfers.RestitutionProposalInput{VariantID: 1, OperationKey: "dispatch-store-restitution", RetainedQuantity: 1, RetainedAtOrigin: true, Reason: "verified"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: "dispatch-store-restitution-accept", ExpectedRevision: 1, Accept: true, Reason: "verified"}); err != nil {
		t.Fatal(err)
	}
	before := dr2Read(t, ctx, s, r)
	stock := dr1Inventory(t, ctx, p)
	counters := dr2Counts(t, ctx, s)
	if before.Lines[0].AppliedRetainedQuantity != 1 || before.Lines[0].RestitutionGeneration != 2 {
		t.Fatal(before)
	}
	if _, err := s.ProposeDispatchReconciliation(ctx, actor(r.Origin.ID), r.ID, transfers.DispatchReconciliationProposalInput{VariantID: 1, OperationKey: "dispatch-store-excluded", DispatchQuantity: 4, Reason: "verified"}); err != transfers.ErrDecisionConflict {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, dr2Read(t, ctx, s, r)) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counters != dr2Counts(t, ctx, s) {
		t.Fatal("excluded attempt changed state")
	}
}

func TestDR2StoreEvidenceSuccessive(t *testing.T) {
	ctx, p, s, r := dr2Fixture(t)
	first := dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "dr2-first")
	accepted := dr2Decide(t, ctx, s, r, r.Destination.ID, 1, "dr2-accept")
	dr1Balances(t, ctx, p, 13, 17)
	if accepted.RecordedAt.Location() != time.UTC || accepted.SourceExistingBefore == nil || *accepted.SourceExistingBefore != 15 || *accepted.SourceExistingAfter != 13 || *accepted.DestinationExistingBefore != 15 || *accepted.DestinationExistingAfter != 17 {
		t.Fatal(accepted)
	}
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 6, "dispatch-store-count")
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "dispatch-store-count-accept")
	dr1Balances(t, ctx, p, 13, 16)
	dr2Propose(t, ctx, s, r, r.Destination.ID, 1, 6, "dr2-second")
	dr2Decide(t, ctx, s, r, r.Origin.ID, 2, "dr2-second-accept")
	dr1Balances(t, ctx, p, 14, 16)
	got := dr2Read(t, ctx, s, r)
	l := got.Lines[0]
	if l.ExpectedQuantity != 5 || l.OriginalActual != 7 || l.OriginalCredit != 5 || l.EffectiveDispatch != 6 || l.EffectiveActual != 6 || l.EffectiveCredit != 6 || l.CountGeneration != 2 || l.CountAppliedRevision != 1 || l.AppliedRevision != 2 || len(l.Proposals) != 2 || len(got.Operations) != 4 || l.Proposals[0].BaseCredit != 5 || l.Proposals[1].BaseCredit != 6 || l.Proposals[1].Application.DestinationDelta != 0 {
		t.Fatal(got)
	}
	counters := dr2Counts(t, ctx, s)
	stock := dr1Inventory(t, ctx, p)
	if !reflect.DeepEqual(first, dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "dr2-first")) || !reflect.DeepEqual(accepted, dr2Decide(t, ctx, s, r, r.Destination.ID, 1, "dr2-accept")) {
		t.Fatal("historical operation changed")
	}
	if !reflect.DeepEqual(got, dr2Read(t, ctx, s, r)) || counters != dr2Counts(t, ctx, s) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("retry changed state")
	}
	if detail, err := s.Get(ctx, actor(r.Origin.ID), r.ID); err != nil || !reflect.DeepEqual(detail, r) {
		t.Fatal("original receipt changed", err)
	}
}
