package transfers_test

import (
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestUR1PublicProjectionsRetainProvenance(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 7)
	s := transfers.New(p)
	original, e := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if e != nil {
		t.Fatal(e)
	}
	unowned := urRead(t, ctx, s, r)
	if unowned.Schema != "luson.transfer-reconciliation/v2" || unowned.OriginLocationID != r.Origin.ID || unowned.DestinationLocationID != r.Destination.ID || unowned.ReceivedAt.IsZero() || len(unowned.Current) != 2 || urCurrent(t, unowned).Source != "legacy" || urCurrent(t, unowned).Owner != "legacy" {
		t.Fatal(unowned)
	}
	for _, who := range []int{r.Origin.ID, r.Destination.ID} {
		counts, e := s.GetCountCorrections(ctx, actor(who), r.ID)
		if e != nil || !reflect.DeepEqual(counts, unowned.Legacy.Count) {
			t.Fatal("unowned count projection changed", e)
		}
		rest, e := s.GetRestitutions(ctx, actor(who), r.ID)
		if e != nil || !reflect.DeepEqual(rest, unowned.Legacy.Restitution) {
			t.Fatal("unowned restitution changed", e)
		}
		dispatch, e := s.GetDispatchReconciliations(ctx, actor(who), r.ID)
		if e != nil || !reflect.DeepEqual(dispatch, unowned.Legacy.Dispatch) {
			t.Fatal("unowned dispatch changed", e)
		}
	}
	stock := dr1Inventory(t, ctx, p)
	if _, e = s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, urProposal("ur1-projection-proposal")); e != nil {
		t.Fatal(e)
	}
	pending := urRead(t, ctx, s, r)
	current := urCurrent(t, pending)
	if current.Owner != "unified" || current.Source != "legacy" || current.RetainedQuantity != nil || current.AppliedRevision != 0 || current.EffectiveDispatch != 10 || current.EffectiveActual != 7 || !reflect.DeepEqual(unowned.Legacy, pending.Legacy) {
		t.Fatal("ownership is not an application", pending)
	}
	for _, who := range []int{r.Origin.ID, r.Destination.ID} {
		counts, e := s.GetCountCorrections(ctx, actor(who), r.ID)
		if e != transfers.ErrUnifiedReconciliationRequired || !errors.Is(e, transfers.ErrDecisionConflict) || !reflect.DeepEqual(counts, transfers.CountCorrections{}) {
			t.Fatal("old count getter must explicitly fail closed", counts, e)
		}
		rest, e := s.GetRestitutions(ctx, actor(who), r.ID)
		if e != transfers.ErrUnifiedReconciliationRequired || !reflect.DeepEqual(rest, transfers.Restitutions{}) {
			t.Fatal("old restitution getter must explicitly fail closed", rest, e)
		}
		dispatch, e := s.GetDispatchReconciliations(ctx, actor(who), r.ID)
		if e != transfers.ErrUnifiedReconciliationRequired || !reflect.DeepEqual(dispatch, transfers.DispatchReconciliations{}) {
			t.Fatal("old dispatch getter must explicitly fail closed", dispatch, e)
		}
	}
	if _, e = s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur1-projection-accept")); e != nil {
		t.Fatal(e)
	}
	stock[0].Items[0].Existing++
	stock[0].Items[0].Available++
	stock[4].Items[0].Existing++
	stock[4].Items[0].Available++
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("expected +1/+1 joint effects")
	}
	applied := urRead(t, ctx, s, r)
	if !reflect.DeepEqual(unowned.Legacy, applied.Legacy) || !reflect.DeepEqual(unowned.Original, applied.Original) {
		t.Fatal("legacy/original provenance changed")
	}
	current = urCurrent(t, applied)
	if current.Source != "unified" || current.AppliedRevision != 1 || current.ApplicationOperationKey == nil || *current.ApplicationOperationKey != "ur1-projection-accept" || current.EffectiveActual != 8 || current.EffectiveDispatch != 9 || current.EffectiveCredit != 8 || current.SourceDebit != 9 || urUnknown(current.TransitUnknown) != 1 {
		t.Fatal(current)
	}
	// A later pending/rejected proposal must not become current or relinquish ownership.
	next := urProposal("ur1-projection-next-proposal")
	next.ExpectedRevision = 1
	next.ArrivalQuantity = 0
	if _, e = s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, next); e != nil {
		t.Fatal(e)
	}
	newer := urRead(t, ctx, s, r)
	if got := urCurrent(t, newer); got.Source != "unified" || got.AppliedRevision != 1 || got.EffectiveActual != 8 || got.EffectiveCredit != 8 {
		t.Fatal("pending became current", got)
	}
	reject := urDecision("ur1-projection-next-reject")
	reject.ExpectedRevision = 2
	reject.Accept = false
	if _, e = s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, reject); e != nil {
		t.Fatal(e)
	}
	settled := urRead(t, ctx, s, r)
	current = urCurrent(t, settled)
	if current.Owner != "unified" || current.Source != "unified" || current.AppliedRevision != 1 || current.EffectiveActual != 8 || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
		t.Fatal("rejection reverted ownership/current", settled)
	}
	if _, e = s.GetCountCorrections(ctx, actor(r.Origin.ID), r.ID); e != transfers.ErrUnifiedReconciliationRequired {
		t.Fatal(e)
	}
	for _, who := range []int{r.Origin.ID, r.Destination.ID} {
		got, e := s.GetUnifiedReconciliations(ctx, actor(who), r.ID)
		if e != nil || !reflect.DeepEqual(settled, got) {
			t.Fatal("participants see different coordinated evidence", e)
		}
		detail, e := s.Get(ctx, actor(who), r.ID)
		if e != nil || !urOriginalEqual(original, detail) {
			t.Fatal("original detail changed", e)
		}
	}
	if got, e := s.GetUnifiedReconciliations(ctx, actor(3), r.ID); e != transfers.ErrNotFound || !reflect.DeepEqual(got, transfers.UnifiedReconciliations{}) {
		t.Fatal("private coordinated evidence leaked", e)
	}
}
