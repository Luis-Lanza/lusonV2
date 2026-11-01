package transfers_test

import (
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestUnifiedReconciliationReaderUnowned(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	before := stocks(t, ctx, p)
	original := r2Original(t, ctx, p)
	count, err := s.GetCountCorrections(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	rest, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	dispatch, err := s.GetDispatchReconciliations(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetUnifiedReconciliations(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Schema != "luson.transfer-reconciliation/v2" || got.RequestID != r.ID || got.OriginLocationID != r.Origin.ID || got.DestinationLocationID != r.Destination.ID || got.ReceivedAt.IsZero() {
		t.Fatal("coordinated header", got)
	}
	if !reflect.DeepEqual(got.Legacy.Count, count) || !reflect.DeepEqual(got.Legacy.Restitution, rest) || !reflect.DeepEqual(got.Legacy.Dispatch, dispatch) {
		t.Fatal("legacy evidence differs from public readers")
	}
	if len(got.Original) != 2 || got.Original[0].VariantID != 1 || got.Original[0].ExpectedQuantity != 10 || got.Original[0].ActualQuantity != 8 || got.Original[0].AvailableQuantity != 8 || got.Original[1].VariantID != 3 || got.Original[1].ExpectedQuantity != 0 || got.Original[1].ActualQuantity != 1 || got.Original[1].AvailableQuantity != 0 {
		t.Fatal("immutable receipt including unexpected line", got.Original)
	}
	if len(got.Current) != 2 || len(got.Lines) != 1 || got.Lines[0].VariantID != 1 || got.Lines[0].Proposals == nil || len(got.Lines[0].Proposals) != 0 || got.Operations == nil || len(got.Operations) != 0 {
		t.Fatal("unowned workflow", got)
	}
	for i, c := range got.Current {
		expected := got.Original[i]
		if c.VariantID != expected.VariantID || c.Owner != "legacy" || c.Source != "legacy" || c.AppliedRevision != 0 || c.Version != (transfers.UnifiedGenerations{}) || c.EffectiveDispatch != expected.ExpectedQuantity || c.EffectiveActual != expected.ActualQuantity || c.EffectiveCredit != expected.AvailableQuantity || c.SourceDebit != expected.ExpectedQuantity || c.ApplicationOperationKey != nil || c.RetainedQuantity != nil || c.OriginUnknown != nil || c.TransitUnknown != nil || c.Excess != nil {
			t.Fatal("legacy current cannot invent physical agreement", c)
		}
	}
	other, err := s.GetUnifiedReconciliations(ctx, actor(r.Destination.ID), r.ID)
	if err != nil || !reflect.DeepEqual(got, other) {
		t.Fatal("endpoint snapshot mismatch", err)
	}
	for _, who := range []int{3, 4} {
		denied, err := s.GetUnifiedReconciliations(ctx, actor(who), r.ID)
		want := transfers.ErrNotFound
		if who == 4 {
			want = transfers.ErrForbidden
		}
		if !errors.Is(err, want) || !reflect.DeepEqual(denied, transfers.UnifiedReconciliations{}) {
			t.Fatal("private actor fence", who, err)
		}
	}
	again, err := s.GetUnifiedReconciliations(ctx, actor(r.Origin.ID), r.ID)
	if err != nil || !reflect.DeepEqual(got, again) || !reflect.DeepEqual(before, stocks(t, ctx, p)) || original != r2Original(t, ctx, p) {
		t.Fatal("reads changed stock or immutable evidence", err)
	}
}
