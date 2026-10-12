package transfers_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestC01CancellationStore(t *testing.T) {
	for _, approved := range []bool{false, true} {
		for _, flow := range []struct {
			name         string
			kind         transfers.Kind
			counterparty int
		}{
			{"warehouse_request", transfers.RequestStock, 1},
			{"branch_request", transfers.RequestStock, 3},
			{"warehouse_proposal", transfers.SendToWarehouse, 1},
		} {
			name := "pending/"
			if approved {
				name = "approved/"
			}
			t.Run(name+flow.name, func(t *testing.T) {
				ctx, p, s := fixture(t)
				in := input()
				in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
				original := create(t, ctx, s, 2, in).Request
				if approved {
					var err error
					original, err = s.Approve(ctx, actor(original.Approver.ID), original.ID)
					if err != nil {
						t.Fatal("approval setup failed")
					}
				}
				before := stocks(t, ctx, p)
				got, err := s.Cancel(ctx, actor(2), original.ID)
				if err != nil || got.Status != "cancelled" || got.CancellationLocationID == nil || *got.CancellationLocationID != 2 ||
					got.CancelledAt == nil || got.CancelledAt.Before(got.CreatedAt) || (got.DecidedAt != nil && got.CancelledAt.Before(*got.DecidedAt)) {
					t.Fatal("creator did not receive complete persisted server cancellation")
				}
				restored := got
				restored.Status, restored.CancellationLocationID, restored.CancelledAt = original.Status, nil, nil
				if !reflect.DeepEqual(restored, original) {
					t.Fatal("cancellation changed immutable payload or original approval history")
				}
				for i := range before {
					for _, item := range got.Items {
						if approved && before[i].Location == got.Origin.ID && int64(before[i].Variant) == item.VariantID {
							before[i].Reserved -= item.Quantity
							before[i].Available += item.Quantity
						}
					}
				}
				if !reflect.DeepEqual(stocks(t, ctx, p), before) {
					t.Fatal("cancellation changed unexpected inventory")
				}
				settled := outcomeSnapshot(t, ctx, p)
				for participant := 1; participant <= 3; participant++ {
					visible := participant == got.Origin.ID || participant == got.Destination.ID
					read, err := s.Get(ctx, actor(participant), got.ID)
					if visible {
						if err != nil || !reflect.DeepEqual(read, got) {
							t.Fatal("participant recovery lost cancellation")
						}
					} else if !errors.Is(err, transfers.ErrNotFound) {
						t.Fatal("nonparticipant learned cancellation")
					}
					page, err := s.List(ctx, actor(participant), transfers.Query{Status: "cancelled"})
					want := int64(0)
					if visible {
						want = 1
					}
					if err != nil || page.Total != want || int64(len(page.Records)) != want || (visible && !reflect.DeepEqual(page.Records[0], got)) {
						t.Fatal("cancelled filter lost participant-scoped history")
					}
					counts, err := s.Counts(ctx, actor(participant))
					if err != nil || counts.PendingTotal != 0 || counts.ActionCount != 0 {
						t.Fatal("Cancelled remains an action obligation")
					}
					_, err = s.Cancel(ctx, actor(participant), got.ID)
					if participant == 2 {
						if err != nil {
							t.Fatal("duplicate cancellation refused")
						}
					} else if (visible && !errors.Is(err, transfers.ErrForbidden)) || (!visible && !errors.Is(err, transfers.ErrNotFound)) {
						t.Fatal("retry authorization leaked cancellation")
					}
				}
				if outcomeSnapshot(t, ctx, p) != settled {
					t.Fatal("participant reads and guarded retries changed state")
				}
				// Exhaust stock after release: neither cancellation retry nor
				// original creation replay may revalidate current availability.
				a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=existing WHERE location_id=$1 AND variant_id IN(1,2)", got.Origin.ID)
				settled = outcomeSnapshot(t, ctx, p)
				retry, err := s.Cancel(ctx, actor(2), got.ID)
				if err != nil || !reflect.DeepEqual(retry, got) {
					t.Fatal("duplicate changed persisted cancellation")
				}
				replay, err := s.Create(ctx, actor(2), in)
				if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, got) {
					t.Fatal("creation replay lost current Cancelled truth")
				}
				for _, decision := range []func(context.Context) error{
					func(c context.Context) error { _, e := s.Approve(c, actor(got.Approver.ID), got.ID); return e },
					func(c context.Context) error { _, e := s.Reject(c, actor(got.Approver.ID), got.ID); return e },
					func(c context.Context) error { _, e := s.Dispatch(c, actor(got.Origin.ID), got.ID); return e },
				} {
					if !errors.Is(decision(ctx), transfers.ErrDecisionConflict) {
						t.Fatal("Cancelled did not deliberately conflict with prior capabilities")
					}
				}
				if outcomeSnapshot(t, ctx, p) != settled {
					t.Fatal("recovery/retry/conflict changed persisted state")
				}
			})
		}
	}
}

func TestC01CancellationTerminalGuards(t *testing.T) {
	for _, status := range []string{"rejected", "in_transit", "received"} {
		t.Run(status, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input()).Request
			if status == "rejected" {
				if _, err := s.Reject(ctx, actor(1), r.ID); err != nil {
					t.Fatal("rejection setup failed")
				}
			} else {
				if _, err := s.Approve(ctx, actor(1), r.ID); err != nil {
					t.Fatal("approval setup failed")
				}
				if _, err := s.Dispatch(ctx, actor(1), r.ID); err != nil {
					t.Fatal("dispatch setup failed")
				}
				if status == "received" {
					if _, err := s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 1}}}); err != nil {
						t.Fatal("receipt setup failed")
					}
				}
			}
			before := outcomeSnapshot(t, ctx, p)
			if _, err := s.Cancel(ctx, actor(2), r.ID); !errors.Is(err, transfers.ErrDecisionConflict) {
				t.Fatal("terminal cancellation admitted")
			}
			if _, err := s.Cancel(ctx, actor(1), r.ID); !errors.Is(err, transfers.ErrForbidden) {
				t.Fatal("authorization did not precede terminal conflict")
			}
			if outcomeSnapshot(t, ctx, p) != before {
				t.Fatal("terminal refusal changed state")
			}
		})
	}
}
