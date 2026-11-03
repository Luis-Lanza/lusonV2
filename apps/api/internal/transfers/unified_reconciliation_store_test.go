package transfers_test

import (
	"context"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

// These helpers deliberately exercise the planned public Store contract. RED
// initially fails compilation: no production placeholders are supplied.
// Activity may gain new immutable entries; all original receipt/cart/dispatch
// metadata must remain identical. Never erase either caller's slice in place.
func urOriginalEqual(before, after transfers.Request) bool {
	if len(after.Activity) < len(before.Activity) || (len(before.Activity) > 0 && !reflect.DeepEqual(before.Activity, after.Activity[:len(before.Activity)])) {
		return false
	}
	before.Activity, after.Activity = nil, nil
	return reflect.DeepEqual(before, after)
}

func urProposal(key string) transfers.UnifiedReconciliationProposalInput {
	return transfers.UnifiedReconciliationProposalInput{
		VariantID: 1, OperationKey: key, DispatchQuantity: 9,
		ArrivalQuantity: 8, RetainedQuantity: 1, RetainedAtOrigin: true,
		Reason: " origin physically verified retention ",
	}
}

func urDecision(key string) transfers.UnifiedReconciliationDecisionInput {
	return transfers.UnifiedReconciliationDecisionInput{
		VariantID: 1, OperationKey: key, ExpectedRevision: 1,
		Accept: true, Reason: " destination verified arrival ",
	}
}

func urRead(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request) transfers.UnifiedReconciliations {
	t.Helper()
	got, err := s.GetUnifiedReconciliations(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal("public unified snapshot", err)
	}
	return got
}

func urCurrent(t *testing.T, snapshot transfers.UnifiedReconciliations) transfers.UnifiedCurrentLine {
	t.Helper()
	for _, line := range snapshot.Current {
		if line.VariantID == 1 {
			return line
		}
	}
	t.Fatal("expected current line missing")
	return transfers.UnifiedCurrentLine{}
}

func urUnknown(value *int64) int64 {
	if value == nil {
		return -1
	}
	return *value
}

func TestUR1AtomicSample(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	stock := dr1Inventory(t, ctx, p)
	original, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	proposal := urProposal("ur1-sample-proposal")
	proposed, err := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, proposal)
	if err != nil || proposed.Action != "propose" || proposed.Revision != 1 {
		t.Fatal("proposal", proposed, err)
	}
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("pending agreement changed inventory")
	}
	pending := urRead(t, ctx, s, r)
	if len(pending.Lines) != 1 || len(pending.Lines[0].Proposals) != 1 || pending.Lines[0].Proposals[0].State != "pending" {
		t.Fatal("pending expected-variant snapshot", pending)
	}
	decision := urDecision("ur1-sample-accept")
	accepted, err := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, decision)
	if err != nil || accepted.Action != "accept" || accepted.SourceExistingBefore == nil || accepted.SourceExistingAfter == nil || accepted.DestinationExistingBefore == nil || accepted.DestinationExistingAfter == nil {
		t.Fatal("atomic acceptance result", accepted, err)
	}
	if *accepted.SourceExistingAfter-*accepted.SourceExistingBefore != 1 || *accepted.DestinationExistingAfter != *accepted.DestinationExistingBefore {
		t.Fatal("sample must restore exactly one at origin only", accepted)
	}
	stock[0].Items[0].Existing++
	stock[0].Items[0].Available++
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("unexpected endpoint, reservation or unrelated inventory effect")
	}
	settled := urRead(t, ctx, s, r)
	line := urCurrent(t, settled)
	if settled.Original[0].ExpectedQuantity != 10 || settled.Original[0].ActualQuantity != 8 || settled.Original[0].AvailableQuantity != 8 || line.Owner != "unified" || line.Source != "unified" || line.EffectiveDispatch != 9 || line.EffectiveActual != 8 || line.EffectiveCredit != 8 || line.SourceDebit != 9 || urUnknown(line.OriginUnknown) != 0 || urUnknown(line.TransitUnknown) != 1 || settled.Lines[0].Proposals[0].State != "applied" || len(settled.Operations) != 2 {
		t.Fatal("agreed accounting and retained original evidence", settled)
	}
	counters := dr2Counts(t, ctx, s)
	if again, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, proposal); e != nil || !reflect.DeepEqual(again, proposed) {
		t.Fatal("exact proposal retry", again, e)
	}
	if again, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, decision); e != nil || !reflect.DeepEqual(again, accepted) {
		t.Fatal("exact acceptance retry", again, e)
	}
	if !reflect.DeepEqual(settled, urRead(t, ctx, s, r)) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counters != dr2Counts(t, ctx, s) {
		t.Fatal("retry changed snapshot, inventory or counters")
	}
	if got, e := s.Get(ctx, actor(r.Destination.ID), r.ID); e != nil || !urOriginalEqual(original, got) {
		t.Fatal("original transfer detail changed", e)
	}
	changed := decision
	changed.Reason += " "
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, changed); e != transfers.ErrRetryConflict {
		t.Fatal("changed acceptance identity", e)
	}
	if !reflect.DeepEqual(settled, urRead(t, ctx, s, r)) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counters != dr2Counts(t, ctx, s) {
		t.Fatal("changed retry changed public state")
	}
	// A fresh bilateral agreement on identical targets is allowed but must
	// account against the actual unified effects, not restore retention twice.
	next := urProposal("ur1-sample-next-proposal")
	next.ExpectedRevision = 1
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, next); e != nil {
		t.Fatal(e)
	}
	nextDecision := urDecision("ur1-sample-next-accept")
	nextDecision.ExpectedRevision = 2
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, nextDecision); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("repeated agreement double-restored retention")
	}
	if got := urRead(t, ctx, s, r); len(got.Operations) != 4 || got.Lines[0].AppliedRevision != 2 || urCurrent(t, got).SourceDebit != 9 || urUnknown(urCurrent(t, got).TransitUnknown) != 1 {
		t.Fatal(got)
	}
}

func TestUR1PriorRestorationNoDoubleCredit(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	legacyProposal := r3Proposal("ur1-prior-restoration", 0, 1)
	legacyDecision := r3Decision("ur1-prior-restoration-accept", 1, true)
	proposed, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, legacyProposal)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, legacyDecision)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	stock := dr1Inventory(t, ctx, p)
	if _, err := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, urProposal("ur1-after-restoration")); err != nil {
		t.Fatal(err)
	}
	op, err := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur1-after-restoration-accept"))
	if err != nil || op.SourceExistingBefore == nil || op.SourceExistingAfter == nil || op.DestinationExistingBefore == nil || op.DestinationExistingAfter == nil {
		t.Fatal(op, err)
	}
	if *op.SourceExistingBefore != *op.SourceExistingAfter || *op.DestinationExistingBefore != *op.DestinationExistingAfter || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("prior actual restoration must yield zero/zero deltas")
	}
	snapshot := urRead(t, ctx, s, r)
	line := urCurrent(t, snapshot)
	if line.SourceDebit != 9 || line.EffectiveCredit != 8 || urUnknown(line.OriginUnknown) != 0 || urUnknown(line.TransitUnknown) != 1 {
		t.Fatal("restoration baseline or unresolved quantity", line)
	}
	if !reflect.DeepEqual(snapshot.Legacy.Restitution, legacy) {
		t.Fatal("nested legacy evidence was rewritten", snapshot.Legacy.Restitution)
	}
	if _, e := s.GetRestitutions(ctx, actor(r.Destination.ID), r.ID); e != transfers.ErrUnifiedReconciliationRequired {
		t.Fatal("old current getter must fail closed", e)
	}
	counters := dr2Counts(t, ctx, s)
	if got, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, legacyProposal); e != nil || !reflect.DeepEqual(proposed, got) {
		t.Fatal("historical legacy proposal retry", e)
	}
	if got, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, legacyDecision); e != nil || !reflect.DeepEqual(accepted, got) {
		t.Fatal("historical legacy acceptance retry", e)
	}
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || counters != dr2Counts(t, ctx, s) {
		t.Fatal("historical retries changed inventory or counters")
	}
}
