package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestD01DispatchDependencies(t *testing.T) {
	var absent *transfers.Store
	for _, s := range []*transfers.Store{absent, transfers.New(nil)} {
		for _, ctx := range []context.Context{nil, context.Background()} {
			got, err := s.Dispatch(ctx, actor(1), 1)
			a02Error(t, got, err, transfers.ErrUnavailable)
		}
	}
}

func TestD01DispatchStore(t *testing.T) {
	for _, flow := range []struct {
		name         string
		kind         transfers.Kind
		counterparty int
	}{
		{"warehouse_request", transfers.RequestStock, 1},
		{"branch_request", transfers.RequestStock, 3},
		{"warehouse_proposal", transfers.SendToWarehouse, 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			r := create(t, ctx, s, 2, in).Request
			got, err := s.Dispatch(ctx, actor(r.Origin.ID), r.ID)
			a02Error(t, got, err, transfers.ErrDecisionConflict)
			// Keep independent holds alongside this request's ownership.
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=1 WHERE location_id=$1 AND variant_id IN (1,2)", r.Origin.ID)
			approved, err := s.Approve(ctx, actor(r.Approver.ID), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			before := stocks(t, ctx, p)
			got, err = s.Dispatch(ctx, actor(r.Destination.ID), r.ID)
			a02Error(t, got, err, transfers.ErrForbidden)
			got, err = s.Dispatch(ctx, actor(6-r.Origin.ID-r.Destination.ID), r.ID)
			a02Error(t, got, err, transfers.ErrNotFound)
			got, err = s.Dispatch(ctx, actor(r.Origin.ID), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != "in_transit" || got.DispatchLocationID == nil || *got.DispatchLocationID != r.Origin.ID || got.DispatchedAt == nil || got.DispatchedAt.Before(*approved.DecidedAt) {
				t.Fatal("dispatch did not return server-derived outcome")
			}
			want := approved
			want.Status, want.DispatchLocationID, want.DispatchedAt = "in_transit", got.DispatchLocationID, got.DispatchedAt
			t10ActionAppend(t, approved, got, "dispatch", approved.Origin.ID)
			if !reflect.DeepEqual(t10BusinessRequest(got), t10BusinessRequest(want)) {
				t.Fatal("immutable payload changed")
			}
			wantStock := append([]stockRow(nil), before...)
			for i := range wantStock {
				for _, item := range r.Items {
					if wantStock[i].Location == r.Origin.ID && int64(wantStock[i].Variant) == item.VariantID {
						wantStock[i].Existing -= item.Quantity
						wantStock[i].Reserved -= item.Quantity
					}
				}
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) {
				t.Fatal("dispatch changed availability, destination or other holds")
			}
			if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations WHERE consumed_at IS NOT NULL") != int64(len(r.Items)) {
				t.Fatal("allocation history not consumed")
			}
			terminal := outcomeSnapshot(t, ctx, p)
			retry, err := s.Dispatch(ctx, actor(r.Origin.ID), r.ID)
			if err != nil || !reflect.DeepEqual(retry, got) {
				t.Fatal("dispatch retry changed outcome", err)
			}
			retry, err = s.Approve(ctx, actor(r.Approver.ID), r.ID)
			if err != nil || !reflect.DeepEqual(retry, got) {
				t.Fatal("approval retry re-reserved or refused transit", err)
			}
			retry, err = s.Reject(ctx, actor(r.Approver.ID), r.ID)
			a02Error(t, retry, err, transfers.ErrDecisionConflict)
			for _, participant := range []int{r.Origin.ID, r.Destination.ID} {
				recovered, err := s.Get(ctx, actor(participant), r.ID)
				if err != nil || !reflect.DeepEqual(recovered, got) {
					t.Fatal("detail recovery failed", err)
				}
				page, err := s.List(ctx, actor(participant), transfers.Query{Status: "in_transit"})
				if err != nil || page.Total != 1 || len(page.Records) != 1 || !t10ListEqual(t, page.Records, []transfers.Request{got}) {
					t.Fatal("transit list failed", err)
				}
			}
			replay, err := s.Create(ctx, actor(2), in)
			if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, got) {
				t.Fatal("creation replay failed", err)
			}
			counts, err := s.Counts(ctx, actor(r.Approver.ID))
			wantAction := int64(0)
			if r.Approver.ID == r.Destination.ID {
				wantAction = 1
			}
			if err != nil || counts.PendingTotal != 0 || counts.ActionCount != wantAction {
				t.Fatal("workflow counts changed", err)
			}
			if terminal != outcomeSnapshot(t, ctx, p) {
				t.Fatal("retry/read mutated stock or lifecycle")
			}
		})
	}
}

func TestD01DispatchRejected(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	if _, err := s.Reject(ctx, actor(r.Approver.ID), r.ID); err != nil {
		t.Fatal(err)
	}
	before := outcomeSnapshot(t, ctx, p)
	if _, err := s.Dispatch(ctx, actor(r.Origin.ID), r.ID); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal(err)
	}
	if before != outcomeSnapshot(t, ctx, p) {
		t.Fatal("rejected dispatch mutated state")
	}
}
