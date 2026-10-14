package transfers_test

import (
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestD01DispatchConcurrency(t *testing.T) {
	for _, competing := range []string{"dispatch", "approve", "overlapping_dispatch"} {
		t.Run(competing, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			first := create(t, ctx, s, 2, in).Request
			if _, err := s.Approve(ctx, actor(1), first.ID); err != nil {
				t.Fatal(err)
			}
			second := first
			if competing == "overlapping_dispatch" {
				in.RetryKey = "d01-overlapping-key-0002"
				second = create(t, ctx, s, 2, in).Request
				if _, err := s.Approve(ctx, actor(1), second.ID); err != nil {
					t.Fatal(err)
				}
			}
			before := stocks(t, ctx, p)
			winner, gate, release := a02Gated(t, ctx, p, "UPDATE transfer_requests SET status='in_transit'", true)
			loser, waiting, _ := a02Gated(t, ctx, p, "pg_advisory_xact_lock(714025,1)", false)
			one, two := make(chan a02Reply, 1), make(chan a02Reply, 1)
			go func() { r, err := winner.Dispatch(ctx, actor(1), first.ID); one <- a02Reply{r, err} }()
			a02Arrived(t, ctx, gate)
			go func() {
				var r transfers.Request
				var err error
				if competing == "approve" {
					r, err = loser.Approve(ctx, actor(1), second.ID)
				} else {
					r, err = loser.Dispatch(ctx, actor(1), second.ID)
				}
				two <- a02Reply{r, err}
			}()
			pid := a02Arrived(t, ctx, waiting)
			a01Wait(t, ctx, p, pid, "advisory")
			release()
			a, b := a02Receive(t, ctx, one), a02Receive(t, ctx, two)
			if a.err != nil || b.err != nil || a.request.Status != "in_transit" || b.request.Status != "in_transit" {
				t.Fatal("serialized dispatch failed", a.err, b.err)
			}
			if competing != "overlapping_dispatch" && !reflect.DeepEqual(a.request, b.request) {
				t.Fatal("concurrent retry changed persisted result")
			}
			for i := range before {
				for _, item := range first.Items {
					if before[i].Location == first.Origin.ID && int64(before[i].Variant) == item.VariantID {
						quantity := item.Quantity
						if competing == "overlapping_dispatch" {
							quantity *= 2
						}
						before[i].Existing -= quantity
						before[i].Reserved -= quantity
					}
				}
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), before) {
				t.Fatal("concurrent dispatch deducted wrong ownership")
			}
		})
	}
}
