package transfers_test

import (
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestUR3PriorRestorationThenOverdispatch(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	if _, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("ur3-rest-before-overdispatch", 0, 1)); e != nil {
		t.Fatal(e)
	}
	if _, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("ur3-rest-before-overdispatch-accept", 1, true)); e != nil {
		t.Fatal(e)
	}
	before := urRead(t, ctx, s, r)
	stock := dr1Inventory(t, ctx, p)
	if urCurrent(t, before).SourceDebit != 9 {
		t.Fatal("actual source baseline must include restoration", before)
	}
	in := urProposal("ur3-overdispatch-proposal")
	in.DispatchQuantity = 12
	in.ArrivalQuantity = 12
	in.RetainedQuantity = 0
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, in); e != nil {
		t.Fatal(e)
	}
	op, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur3-overdispatch-accept"))
	if e != nil {
		t.Fatal(e)
	}
	if op.SourceExistingBefore == nil || op.SourceExistingAfter == nil || op.DestinationExistingBefore == nil || op.DestinationExistingAfter == nil || *op.SourceExistingAfter-*op.SourceExistingBefore != -3 || *op.DestinationExistingAfter-*op.DestinationExistingBefore != 4 {
		t.Fatal("must debit3 against baseline9, not erase restitution", op)
	}
	stock[0].Items[0].Existing -= 3
	stock[0].Items[0].Available -= 3
	stock[4].Items[0].Existing += 4
	stock[4].Items[0].Available += 4
	after := urRead(t, ctx, s, r)
	current := urCurrent(t, after)
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || !reflect.DeepEqual(before.Legacy, after.Legacy) || current.SourceDebit != 12 || current.EffectiveCredit != 12 || current.EffectiveDispatch != 12 || urUnknown(current.RetainedQuantity) != 0 || after.Legacy.Restitution.Lines[0].AppliedRetainedQuantity != 1 {
		t.Fatal("current and historical restoration were co-mingled", after)
	}
}

func TestUR3LegacyGenerationZeroConsent(t *testing.T) {
	// Existing upgrade fixture convention: install actual historical operation
	// bodies without companion recording, never fabricate proposal/ledger rows.
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	a01Exec(t, ctx, p, `ALTER TABLE transfer_count_proposals DISABLE TRIGGER record_count_reconciliation_pin`)
	dr1InstallOperation(t, ctx, p, "011_transfer_count_corrections.sql", "apply_transfer_count_operation")
	legacy := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 9, "ur3-generation-zero-proposal")
	dr1InstallOperation(t, ctx, p, "013_transfer_dispatch_reconciliation.sql", "apply_transfer_count_operation")
	a01Exec(t, ctx, p, `ALTER TABLE transfer_count_proposals ENABLE TRIGGER record_count_reconciliation_pin`)
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, urProposal("ur3-generation-zero-unified")); e != nil {
		t.Fatal(e)
	}
	stock, counters, before := dr1Inventory(t, ctx, p), dr2Counts(t, ctx, s), urRead(t, ctx, s, r)
	if _, e := s.DecideCount(ctx, actor(r.Origin.ID), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "ur3-generation-zero-old-accept", ExpectedRevision: 1, Accept: true, Reason: "verified"}); e != transfers.ErrDecisionConflict {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counters != dr2Counts(t, ctx, s) || !reflect.DeepEqual(before, urRead(t, ctx, s, r)) {
		t.Fatal("generation-zero acceptance changed state")
	}
	if got := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 9, "ur3-generation-zero-proposal"); !reflect.DeepEqual(got, legacy) {
		t.Fatal("old exact retry changed")
	}
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, false, "ur3-generation-zero-old-reject")
	if urRead(t, ctx, s, r).Legacy.Count.Lines[0].Proposals[0].State != "rejected" {
		t.Fatal("historical reject unavailable")
	}
}

func TestUR3LegacyRestitutionPendingFence(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	legacyInput := r3Proposal("ur3-legacy-pending-rest", 0, 1)
	legacy, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, legacyInput)
	if e != nil {
		t.Fatal(e)
	}
	in := urProposal("ur3-unified-destination")
	in.RetainedAtOrigin = false
	if _, e = s.ProposeUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, in); e != nil {
		t.Fatal(e)
	}
	decision := urDecision("ur3-unified-origin-accept")
	decision.RetainedAtOrigin = true
	if _, e = s.DecideUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, decision); e != nil {
		t.Fatal(e)
	}
	stock, counts, history := dr1Inventory(t, ctx, p), dr2Counts(t, ctx, s), urRead(t, ctx, s, r)
	before := urRead(t, ctx, s, r).Legacy.Restitution
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("ur3-old-consent-accept", 1, true)); e != transfers.ErrDecisionConflict {
		t.Fatal("legacy consent reused", e)
	}
	after := urRead(t, ctx, s, r).Legacy.Restitution
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counts != dr2Counts(t, ctx, s) || !reflect.DeepEqual(history, urRead(t, ctx, s, r)) {
		t.Fatal("stale legacy acceptance changed public state")
	}
	if got, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, legacyInput); e != nil || !reflect.DeepEqual(got, legacy) {
		t.Fatal("old proposal retry", e)
	}
	reject := r3Decision("ur3-old-consent-reject", 1, false)
	rejected, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, reject)
	if e != nil {
		t.Fatal("legacy stale rejection", e)
	}
	counts = dr2Counts(t, ctx, s)
	if got, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, reject); e != nil || !reflect.DeepEqual(got, rejected) {
		t.Fatal("legacy reject retry", e)
	}
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counts != dr2Counts(t, ctx, s) {
		t.Fatal("legacy rejection/retry inventory or retry counter effect")
	}
}

func TestUR3LegacyDispatchAndCountBaselines(t *testing.T) {
	ctx, p, s, r := dr2Fixture(t)
	legacyProposal := dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "ur3-prior-dispatch")
	legacyAccept := dr2Decide(t, ctx, s, r, r.Destination.ID, 1, "ur3-prior-dispatch-accept")
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 6, "ur3-prior-count-proposal")
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "ur3-prior-count-accept")
	stock := dr1Inventory(t, ctx, p)
	in := urProposal("ur3-ledger-based-proposal")
	in.DispatchQuantity, in.ArrivalQuantity, in.RetainedQuantity = 6, 6, 0
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, in); e != nil {
		t.Fatal(e)
	}
	op, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur3-ledger-based-accept"))
	if e != nil || op.SourceExistingBefore == nil || op.SourceExistingAfter == nil || op.DestinationExistingBefore == nil || op.DestinationExistingAfter == nil {
		t.Fatal(op, e)
	}
	if *op.SourceExistingAfter-*op.SourceExistingBefore != 1 || *op.DestinationExistingAfter != *op.DestinationExistingBefore {
		t.Fatal("legacy dispatch debit7/count credit6 were not used as actual baselines", op)
	}
	stock[0].Items[0].Existing++
	stock[0].Items[0].Available++
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("legacy ledger double effect")
	}
	snapshot := urRead(t, ctx, s, r)
	line := urCurrent(t, snapshot)
	if snapshot.Original[0].ExpectedQuantity != 5 || snapshot.Original[0].ActualQuantity != 7 || snapshot.Original[0].AvailableQuantity != 5 || line.SourceDebit != 6 || line.EffectiveCredit != 6 {
		t.Fatal(line)
	}
	counts := dr2Counts(t, ctx, s)
	if got := dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "ur3-prior-dispatch"); !reflect.DeepEqual(got, legacyProposal) {
		t.Fatal("legacy dispatch proposal retry changed")
	}
	if got := dr2Decide(t, ctx, s, r, r.Destination.ID, 1, "ur3-prior-dispatch-accept"); !reflect.DeepEqual(got, legacyAccept) {
		t.Fatal("legacy dispatch acceptance retry changed")
	}
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counts != dr2Counts(t, ctx, s) {
		t.Fatal("legacy exact retry changed stock/counters")
	}
}
